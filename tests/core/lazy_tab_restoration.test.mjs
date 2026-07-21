import { describe, test, expect } from 'bun:test';
import { SidepanelChatCore } from '../../src/js/chat_core.js';
import { SidepanelApp } from '../../src/js/sidepanel.js';
import { TabManager } from '../../src/js/tab_manager.js';

const deferred = () => {
    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
};

const userMessage = (text, extra = {}) => ({
    role: 'user',
    contents: [[{ type: 'text', content: text }]],
    ...extra
});

const assistantMessage = (text) => ({
    role: 'assistant',
    contents: [[{ type: 'text', content: text }]]
});

const createCore = () => new SidepanelChatCore({
    createNewChatTracking: title => ({ title, chatId: null, messages: [] })
}, {}, {}, null, null, {});

const createTab = (id, reconstruction = null) => {
    const core = createCore();
    const calls = { errors: [], media: [], builds: [], clears: [], actions: 0, titles: [] };
    const chatUI = {
        addErrorMessage: message => calls.errors.push(message),
        buildChat: (chat, options) => calls.builds.push({ chat, options }),
        clearConversation: options => calls.clears.push(options),
        updateIncognito: () => {}
    };
    const controller = {
        chatCore: core,
        initStates: title => core.reset(title),
        syncWebpageContextUI: () => {},
        restoreLatestAssistantActions: () => { calls.actions++; },
        appendPendingMedia: (media, type) => {
            calls.media.push({ media, type });
            media.forEach(item => core.appendMedia(item, type));
        }
    };
    return {
        tab: { id, reconstruction, controller, chatUI, tabState: { chatId: null, isSidePanel: true } },
        calls
    };
};

const createApp = ({ tabs, activeId, chatStorage = {} }) => {
    const app = Object.create(SidepanelApp.prototype);
    const tabMap = new Map(tabs.map(tab => [tab.id, tab]));
    let currentActiveId = activeId;

    app.chatStorage = chatStorage;
    app.tabTextareaContent = new Map();
    app.textInput = { value: '', disabled: false, style: {}, scrollHeight: 0 };
    app.startupAt = 0;
    app.startupNewTabId = null;
    app.openedForReconstruct = false;
    app.restoredTabLoadTimers = new Map();
    app.tabManager = {
        tabs: tabMap,
        getTab: id => tabMap.get(id),
        getAllTabs: () => Array.from(tabMap.values()),
        getActiveTab: () => tabMap.get(currentActiveId),
        getActiveController: () => tabMap.get(currentActiveId)?.controller,
        getActiveChatUI: () => tabMap.get(currentActiveId)?.chatUI,
        getActiveTabState: () => tabMap.get(currentActiveId)?.tabState,
        getTabChatId: tab => tab?.controller.chatCore.getChatId()
            ?? tab?.tabState.chatId
            ?? tab?.reconstruction?.options?.chatId,
        switchTab: id => { if (tabMap.has(id)) currentActiveId = id; },
        updateTabTitle: (id, title) => {
            const tab = tabMap.get(id);
            if (tab) tab.title = title;
        },
        schedulePersist: () => {},
        getTabCount: () => tabMap.size
    };
    app.ensureActiveTab = () => {};
    app.getTestActiveId = () => currentActiveId;
    app.setTestActiveId = id => { currentActiveId = id; };
    return app;
};

const createRestoreManager = (chatIds, getMetadata) => {
    const manager = Object.create(TabManager.prototype);
    manager.globalState = { isReady: true, getSetting: () => true };
    manager.tabs = new Map();
    manager.tabOrder = [];
    manager.isRestoring = false;
    manager.isDirty = false;
    manager.chatStorage = { getChatMetadataById: getMetadata };
    manager.createTab = options => {
        const id = `tab-${manager.tabOrder.length}`;
        const tab = {
            id,
            title: options.initialTitle,
            reconstruction: options.reconstruction ?? null,
            tabState: { chatId: null },
            controller: { chatCore: { getChatId: () => null } }
        };
        manager.tabs.set(id, tab);
        manager.tabOrder.push(id);
        return tab;
    };
    manager.persistTabsNow = async () => { manager.cleanupCalls = (manager.cleanupCalls || 0) + 1; };
    manager.storageGet = async () => ({ sidekick_open_tabs: { chatIds } });
    return manager;
};

const withChromeStorage = async (manager, callback) => {
    const previousChrome = globalThis.chrome;
    globalThis.chrome = {
        storage: {
            local: {
                get: manager.storageGet,
                set: async () => {},
                remove: async () => {}
            }
        }
    };
    try {
        return await callback();
    } finally {
        if (previousChrome === undefined) delete globalThis.chrome;
        else globalThis.chrome = previousChrome;
    }
};

describe('persisted tab shell restoration', () => {
    test('normalizes IDs and preserves persisted order when metadata resolves in reverse', async () => {
        const reads = new Map([[1, deferred()], [2, deferred()], [3, deferred()]]);
        const manager = createRestoreManager(['1', 2, 1, 'bad', 3], id => reads.get(id).promise);

        const restoration = withChromeStorage(manager, () => manager.restorePersistedTabs());
        await Promise.resolve();
        reads.get(3).resolve({ title: 'Third' });
        reads.get(2).resolve({ title: 'Second' });
        reads.get(1).resolve({ title: 'First' });
        await restoration;

        expect(manager.getAllTabs().map(tab => tab.tabState.chatId)).toEqual([1, 2, 3]);
        expect(manager.getAllTabs().map(tab => tab.title)).toEqual(['First', 'Second', 'Third']);
        expect(manager.getAllTabs().map(tab => tab.reconstruction)).toEqual([
            { status: 'pending', options: { chatId: 1 } },
            { status: 'pending', options: { chatId: 2 } },
            { status: 'pending', options: { chatId: 3 } }
        ]);
        expect(manager.cleanupCalls).toBe(1);
    });

    test('skips only failed metadata entries and requests persisted cleanup', async () => {
        const manager = createRestoreManager([1, 2, 3], async id => {
            if (id === 2) throw new Error('metadata failed');
            return { title: `Chat ${id}` };
        });

        await withChromeStorage(manager, () => manager.restorePersistedTabs());

        expect(manager.getAllTabs().map(tab => tab.tabState.chatId)).toEqual([1, 3]);
        expect(manager.cleanupCalls).toBe(1);
    });

    test('recovers from persisted storage read failures without leaving restoration active', async () => {
        const manager = createRestoreManager([], async () => null);
        manager.storageGet = async () => { throw new Error('storage unavailable'); };

        await withChromeStorage(manager, () => manager.restorePersistedTabs());

        expect(manager.getAllTabs()).toEqual([]);
        expect(manager.isRestoring).toBe(false);
    });

    test('does not duplicate a chat opened while metadata is loading', async () => {
        const metadata = deferred();
        const manager = createRestoreManager([1], () => metadata.promise);

        const restoration = withChromeStorage(manager, () => manager.restorePersistedTabs());
        await Promise.resolve();
        const opened = manager.createTab({ initialTitle: 'Opened from history', reconstruction: null });
        opened.tabState.chatId = 1;
        metadata.resolve({ title: 'Restored title' });
        await restoration;

        expect(manager.getAllTabs().map(tab => tab.tabState.chatId)).toEqual([1]);
        expect(manager.getAllTabs()[0].title).toBe('Opened from history');
    });
});

describe('single reconstruction ownership', () => {
    test('deduplicates concurrent readiness calls with one loading operation', async () => {
        const preparation = deferred();
        const { tab } = createTab('target', { status: 'pending', options: { chatId: 7 } });
        const app = createApp({ tabs: [tab], activeId: tab.id });
        let commits = 0;
        app.prepareReconstruction = () => preparation.promise;
        app.commitReconstruction = () => { commits++; };

        const first = app.ensureTabReady(tab.id);
        const duplicate = app.ensureTabReady(tab.id);

        expect(duplicate).toBe(first);
        expect(tab.reconstruction).toMatchObject({ status: 'loading', options: { chatId: 7 } });
        expect(app.textInput.disabled).toBe(true);

        preparation.resolve({ options: { chatId: 7 } });
        expect(await first).toBe(true);
        expect(commits).toBe(1);
        expect(tab.reconstruction).toBeNull();
        expect(app.textInput.disabled).toBe(false);
    });

    test('returns failures to pending, stays idle, and retries only when explicitly requested', async () => {
        const options = { chatId: 9 };
        const { tab, calls } = createTab('target', { status: 'pending', options });
        const app = createApp({ tabs: [tab], activeId: tab.id });
        let attempts = 0;
        app.prepareReconstruction = async () => {
            attempts++;
            if (attempts === 1) throw new Error('temporary failure');
            return { options };
        };
        app.commitReconstruction = () => {};

        expect(await app.ensureTabReady(tab.id)).toBe(false);
        expect(tab.reconstruction).toEqual({ status: 'pending', options });
        expect(calls.errors).toEqual(['Failed to load chat']);
        expect(app.textInput.disabled).toBe(false);
        await Promise.resolve();
        expect(attempts).toBe(1);

        expect(await app.ensureTabReady(tab.id)).toBe(true);
        expect(attempts).toBe(2);
        expect(tab.reconstruction).toBeNull();
    });

    test('ignores superseded and closed operation completions without committing or reporting errors', async () => {
        const firstPreparation = deferred();
        const firstData = createTab('first', { status: 'pending', options: { chatId: 1 } });
        const first = firstData.tab;
        const secondPreparation = deferred();
        const secondData = createTab('second', { status: 'pending', options: { chatId: 2 } });
        const second = secondData.tab;
        const app = createApp({ tabs: [first, second], activeId: first.id });
        let commits = 0;
        app.prepareReconstruction = options => options.chatId === 1 ? firstPreparation.promise : secondPreparation.promise;
        app.commitReconstruction = () => { commits++; };

        const superseded = app.ensureTabReady(first.id);
        first.reconstruction = { status: 'pending', options: { chatId: 10 } };
        firstPreparation.resolve({ options: { chatId: 1 } });
        expect(await superseded).toBe(false);

        const closed = app.ensureTabReady(second.id);
        app.tabManager.tabs.delete(second.id);
        secondPreparation.reject(new Error('closed read'));
        expect(await closed).toBe(false);

        expect(commits).toBe(0);
        expect(firstData.calls.errors).toEqual([]);
        expect(secondData.calls.errors).toEqual([]);
    });

    test('background completion stores its draft without changing the shared textarea', async () => {
        const preparation = deferred();
        const target = createTab('target', { status: 'pending', options: { chatId: 1 } }).tab;
        const other = createTab('other').tab;
        const app = createApp({ tabs: [target, other], activeId: target.id });
        app.textInput.value = 'other draft';
        app.prepareReconstruction = () => preparation.promise;
        app.commitReconstruction = tab => app.setTabDraft(tab.id, 'target draft');

        const loading = app.ensureTabReady(target.id);
        app.setTestActiveId(other.id);
        preparation.resolve({ options: { chatId: 1 } });

        expect(await loading).toBe(true);
        expect(app.tabTextareaContent.get(target.id)).toBe('target draft');
        expect(app.textInput.value).toBe('other draft');
    });

    test('cancels a scheduled idle load before an explicit attempt', async () => {
        const previousWindow = globalThis.window;
        const callbacks = new Map();
        let nextId = 1;
        globalThis.window = {
            requestIdleCallback: callback => {
                const id = nextId++;
                callbacks.set(id, callback);
                return id;
            },
            cancelIdleCallback: id => callbacks.delete(id)
        };

        try {
            const { tab } = createTab('target', { status: 'pending', options: { chatId: 1 } });
            const app = createApp({ tabs: [tab], activeId: tab.id });
            let attempts = 0;
            app.prepareReconstruction = async () => {
                attempts++;
                throw new Error('temporary failure');
            };

            app.scheduleRestoredTabLoad(tab.id);
            expect(callbacks.size).toBe(1);
            expect(await app.ensureTabReady(tab.id)).toBe(false);

            expect(callbacks.size).toBe(0);
            expect(attempts).toBe(1);
        } finally {
            if (previousWindow === undefined) delete globalThis.window;
            else globalThis.window = previousWindow;
        }
    });
});

describe('reconstruction semantics', () => {
    test('full restoration keeps a trailing user message in history and preserves the draft', async () => {
        const trailing = userMessage('saved user', { images: ['saved-image'] });
        const chat = { chatId: 42, title: 'Full chat', messages: [userMessage('first'), trailing] };
        let lengthReads = 0;
        const { tab, calls } = createTab('full', { status: 'pending', options: { chatId: 42 } });
        tab.tabState.chatId = 42;
        const app = createApp({
            tabs: [tab],
            activeId: tab.id,
            chatStorage: {
                loadChat: async () => chat,
                getChatLength: async () => { lengthReads++; return 2; }
            }
        });
        app.tabTextareaContent.set(tab.id, 'current draft');
        app.textInput.value = 'current draft';

        expect(await app.ensureTabReady(tab.id)).toBe(true);

        expect(tab.controller.chatCore.getChat().messages).toHaveLength(2);
        expect(tab.controller.chatCore.getLatestMessage().contents[0][0].content).toBe('saved user');
        expect(tab.controller.chatCore.continuedChatOptions).toEqual({});
        expect(calls.media).toEqual([]);
        expect(app.tabTextareaContent.get(tab.id)).toBe('current draft');
        expect(app.textInput.value).toBe('current draft');
        expect(lengthReads).toBe(0);
    });

    test('indexed user continuation removes and restores the selected message exactly once with coordinates', async () => {
        const selected = {
            role: 'user',
            contents: [
                [{ type: 'text', content: 'old version' }],
                [{ type: 'text', content: 'selected version' }]
            ],
            images: ['image'],
            audio: [{ name: 'clip', data: 'audio' }],
            files: [{ name: 'file.txt', content: 'file' }]
        };
        const chat = {
            chatId: 5,
            title: 'Continuation',
            messages: [userMessage('question'), assistantMessage('answer'), selected]
        };
        const options = { chatId: 5, index: 2, secondaryIndex: 0, modelChoice: null };
        const { tab, calls } = createTab('continuation', { status: 'pending', options });
        const app = createApp({
            tabs: [tab],
            activeId: tab.id,
            chatStorage: { loadChat: async () => chat, getChatLength: async () => 3 }
        });

        expect(await app.ensureTabReady(tab.id)).toBe(true);
        expect(tab.controller.chatCore.getChat().messages).toHaveLength(2);
        expect(calls.media).toEqual([
            { media: ['image'], type: 'image' },
            { media: [{ name: 'clip', data: 'audio' }], type: 'audio' },
            { media: [{ name: 'file.txt', content: 'file' }], type: 'file' }
        ]);
        expect(app.tabTextareaContent.get(tab.id)).toBe('old version');
        expect(tab.controller.chatCore.continuedChatOptions).toEqual({
            fullChatLength: 3,
            lastMessage: selected,
            index: 2,
            modelChoice: null,
            secondaryIndex: 0,
            secondaryLength: 2
        });

        expect(await app.ensureTabReady(tab.id)).toBe(true);
        expect(calls.media).toHaveLength(3);
    });

    test('keeps original arena branch metadata for continuation checks', async () => {
        const arenaMessage = {
            role: 'assistant',
            continued_with: 'model_a',
            responses: {
                model_a: { name: 'A', messages: [[{ type: 'text', content: 'A' }]] },
                model_b: { name: 'B', messages: [[{ type: 'text', content: 'B' }]] }
            }
        };
        const chat = { chatId: 6, title: 'Arena', messages: [userMessage('question'), arenaMessage] };
        const options = { chatId: 6, index: 1, secondaryIndex: 0, modelChoice: 'model_b' };
        const { tab } = createTab('arena', { status: 'pending', options });
        const app = createApp({
            tabs: [tab],
            activeId: tab.id,
            chatStorage: { loadChat: async () => chat, getChatLength: async () => 2 }
        });

        expect(await app.ensureTabReady(tab.id)).toBe(true);
        expect(tab.controller.chatCore.getLatestMessage().continued_with).toBe('model_b');
        expect(tab.controller.chatCore.continuedChatOptions.lastMessage.continued_with).toBe('model_a');
    });

    test('clears a no-chat target without touching the shared textarea', () => {
        const targetData = createTab('target');
        const other = createTab('other').tab;
        const app = createApp({ tabs: [targetData.tab, other], activeId: other.id });
        app.textInput.value = 'other draft';

        app.commitReconstruction(targetData.tab, { options: {}, chat: null });

        expect(targetData.calls.clears).toEqual([{ skipTextarea: true }]);
        expect(app.textInput.value).toBe('other draft');
    });

    test('buildFromDB can explicitly remove a selected user when no secondary index exists', () => {
        const core = createCore();
        core.buildFromDB({ chatId: 1, messages: [userMessage('first'), userMessage('selected')] }, null, null, null, true);
        expect(core.getChat().messages).toEqual([userMessage('first')]);
    });

    test('keeps an assistant regeneration run intact and passes absolute render indices', () => {
        const app = Object.create(SidepanelApp.prototype);
        const messages = Array.from({ length: 85 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', index }));
        messages[2].role = 'user';
        messages[3].role = 'assistant';
        messages[4].role = 'assistant';
        messages[5].role = 'assistant';

        const result = app.getContinuationRenderChat({ title: 'Long chat', messages });

        expect(result.indexOffset).toBe(3);
        expect(result.chat.messages).toHaveLength(82);
        expect(result.chat.messages[0].index).toBe(3);
    });
});

describe('active action readiness gating', () => {
    test('does not send after switching during reconstruction or prompt readiness', async () => {
        const preparation = deferred();
        const first = createTab('first', { status: 'pending', options: { chatId: 1 } }).tab;
        const second = createTab('second').tab;
        let sends = 0;
        first.controller.awaitPromptReady = async () => {};
        first.controller.chatCore.getSystemPrompt = () => 'ready';
        first.controller.sendUserMessage = () => { sends++; };
        const app = createApp({ tabs: [first, second], activeId: first.id });
        app.stateManager = { isOn: () => true };
        app.prepareReconstruction = () => preparation.promise;
        app.commitReconstruction = () => {};

        const duringLoad = app.handleInput();
        app.setTestActiveId(second.id);
        preparation.resolve({ options: { chatId: 1 } });
        await duringLoad;
        expect(sends).toBe(0);

        const prompt = deferred();
        first.reconstruction = null;
        first.controller.awaitPromptReady = () => prompt.promise;
        app.setTestActiveId(first.id);
        const duringPrompt = app.handleInput();
        await Promise.resolve();
        app.setTestActiveId(second.id);
        prompt.resolve();
        await duringPrompt;
        expect(sends).toBe(0);
    });

    test('waits for reconstruction before popout checks and controller/media actions', async () => {
        const preparation = deferred();
        const { tab, calls } = createTab('target', { status: 'pending', options: { chatId: 1 } });
        const app = createApp({ tabs: [tab], activeId: tab.id });
        app.stateManager = { getSetting: () => false };
        app.prepareReconstruction = () => preparation.promise;
        app.commitReconstruction = () => {};
        let popoutChecks = 0;
        app.tabManager.getTabCount = () => { popoutChecks++; return 2; };

        const popout = app.handlePopoutToggle();
        const media = app.withReadyActiveTab(readyTab => readyTab.controller.appendPendingMedia(['drop'], 'image'));
        expect(popoutChecks).toBe(0);
        expect(calls.media).toEqual([]);

        preparation.resolve({ options: { chatId: 1 } });
        await Promise.all([popout, media]);

        expect(popoutChecks).toBe(1);
        expect(calls.errors).toEqual(['Close other tabs before popping out (they would be lost).']);
        expect(calls.media).toEqual([{ media: ['drop'], type: 'image' }]);
    });
});
