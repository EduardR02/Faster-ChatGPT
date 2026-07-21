import { beforeEach, describe, expect, test } from 'bun:test';
import { parseHTML } from 'linkedom';
import { HistoryChatUI, SidepanelChatUI, runAfterSuccessfulBuild } from '../../src/js/chat_ui.js';
import { SidepanelApp } from '../../src/js/sidepanel.js';
import { TabManager } from '../../src/js/tab_manager.js';

const deferred = () => {
    let resolve;
    const promise = new Promise(resolvePromise => { resolve = resolvePromise; });
    return { promise, resolve };
};

const textParts = content => [[{ type: 'text', content }]];

const createStateManager = () => ({
    getSetting: key => key === 'models' ? {} : false,
    getArenaModel: index => `arena-${index}`,
    getCouncilCollectorModel: () => 'collector',
    isThinking: () => false,
    isSolving: () => false,
    subscribeToSetting: () => {},
    unsubscribeFromSetting: () => {}
});

const topLevelBlocks = () => Array.from(document.getElementById('conversation').children)
    .filter(element => !element.classList.contains('title-wrapper'));

const blockMarker = element => {
    if (element.classList.contains('council-message')) return 'council';
    if (element.querySelector('.arena-full-container')) return 'arena';
    return element.querySelector('.message-content')?.textContent;
};

describe('chunked chat rendering', () => {
    beforeEach(() => {
        const { document, window } = parseHTML(`
            <div id="scroll-container">
                <div id="conversation">
                    <div class="title-wrapper"><span class="conversation-title">conversation</span></div>
                </div>
            </div>
            <div id="title-wrapper"><span id="history-chat-header">conversation</span></div>
            <div id="history-conversation"></div>
            <div id="history-chat-footer"></div>
            <div id="history-list"></div>
            <div class="textarea-wrapper"><textarea></textarea></div>
        `);
        globalThis.document = document;
        globalThis.window = window;
    });

    test('yields between deterministic chunks without changing order, council, regenerations, or absolute indices', async () => {
        const scheduled = [];
        const continued = [];
        const messages = Array.from({ length: 45 }, (_, index) => ({
            role: index % 2 === 0 ? 'user' : 'assistant',
            contents: textParts(`message-${index}`)
        }));
        messages[19].contents = [
            [{ type: 'text', content: 'message-19-a' }],
            [{ type: 'text', content: 'message-19-b' }]
        ];
        messages[20] = { role: 'assistant', contents: textParts('message-20') };
        messages[30] = {
            role: 'assistant',
            contents: textParts('council-collector'),
            council: {
                collector_model: 'collector',
                responses: {
                    critic: { name: 'Critic', parts: [{ type: 'text', content: 'council-row' }], status: 'complete' }
                }
            }
        };

        const chatUI = new SidepanelChatUI({
            conversationWrapperId: 'conversation',
            scrollElementId: 'scroll-container',
            stateManager: createStateManager(),
            continueFunc: (...args) => continued.push(args),
            renderScheduler: () => {
                const task = deferred();
                scheduled.push(task);
                return task.promise;
            }
        });

        const rendering = chatUI.buildChat({ title: 'Large chat', messages }, { indexOffset: 100 });

        expect(rendering).toBeInstanceOf(Promise);
        expect(scheduled).toHaveLength(1);
        expect(topLevelBlocks()).toHaveLength(21);

        scheduled.shift().resolve();
        await Promise.resolve();
        expect(scheduled).toHaveLength(1);
        expect(topLevelBlocks()).toHaveLength(41);

        scheduled.shift().resolve();
        expect(await rendering).toBe(true);
        expect(scheduled).toHaveLength(0);
        expect(topLevelBlocks()).toHaveLength(46);

        const expectedOrder = messages.flatMap((message, index) => {
            if (message.council) return ['council'];
            if (index === 19) return ['message-19-a', 'message-19-b'];
            return [`message-${index}`];
        });
        expect(topLevelBlocks().map(blockMarker)).toEqual(expectedOrder);

        const regenerationBlocks = topLevelBlocks().filter(element =>
            ['message-19-b', 'message-20'].includes(blockMarker(element))
        );
        expect(regenerationBlocks.map(element => element.querySelector('.message-prefix').textContent)).toEqual([
            'Assistant ⟳',
            'Assistant ⟳'
        ]);

        topLevelBlocks().find(element => blockMarker(element) === 'message-19-b')
            .querySelector('.continue-conversation-button').click();
        topLevelBlocks().find(element => blockMarker(element) === 'message-20')
            .querySelector('.continue-conversation-button').click();
        document.querySelector('.council-continue-button').click();
        expect(continued).toEqual([
            [119, 1],
            [120, 0],
            [130, 0]
        ]);
    });

    test('HistoryChatUI resumes arena rendering in the next chunk before applying history metadata', async () => {
        const scheduled = [];
        const continued = [];
        const messages = Array.from({ length: 25 }, (_, index) => ({
            role: index % 2 === 0 ? 'user' : 'assistant',
            contents: textParts(`history-${index}`)
        }));
        messages[20] = {
            role: 'assistant',
            responses: {
                model_a: { name: 'Arena A', messages: textParts('arena-a') },
                model_b: { name: 'Arena B', messages: textParts('arena-b') }
            },
            choice: 'draw',
            continued_with: 'model_a'
        };
        const stateManager = {
            ...createStateManager(),
            historyList: document.getElementById('history-list'),
            limit: 20,
            offset: 0,
            shouldLoadMore: () => false
        };
        const chatUI = new HistoryChatUI({
            conversationWrapperId: 'history-conversation',
            stateManager,
            continueFunc: (...args) => continued.push(args),
            addPopupActions: () => {},
            loadHistoryItems: async () => [],
            loadChat: async () => ({
                chatId: 7,
                title: 'History arena',
                timestamp: 123,
                continued_from_chat_id: null,
                messages
            }),
            getChatMeta: async () => null,
            renderScheduler: () => {
                const task = deferred();
                scheduled.push(task);
                return task.promise;
            }
        });

        const rendering = chatUI.buildChat(7);
        await Promise.resolve();
        expect(scheduled).toHaveLength(1);
        expect(document.getElementById('history-conversation').children).toHaveLength(20);
        expect(document.getElementById('history-chat-header').textContent).toBe('conversation');

        scheduled.shift().resolve();
        expect(await rendering).toBe(true);
        const blocks = Array.from(document.getElementById('history-conversation').children);
        expect(blocks).toHaveLength(25);
        expect(blockMarker(blocks[20])).toBe('arena');
        expect(document.getElementById('history-chat-header').textContent).toBe('History arena');

        blocks[20].querySelector('.arena-wrapper[data-model-key="model_b"] .continue-conversation-button').click();
        expect(continued).toEqual([[20, 0, 'model_b']]);
    });

    test('HistoryChatUI activates only the latest out-of-order load', async () => {
        const loads = new Map([[1, deferred()], [2, deferred()]]);
        let currentChat = null;
        const stateManager = {
            ...createStateManager(),
            historyList: document.getElementById('history-list'),
            limit: 20,
            offset: 0,
            shouldLoadMore: () => false
        };
        const chatUI = new HistoryChatUI({
            conversationWrapperId: 'history-conversation',
            stateManager,
            addPopupActions: () => {},
            loadHistoryItems: async () => [],
            loadChat: id => loads.get(id).promise,
            activateChat: chat => { currentChat = chat; },
            getChatMeta: async () => null
        });

        const first = chatUI.buildChat(1);
        const second = chatUI.buildChat(2);
        const secondChat = {
            chatId: 2,
            title: 'Second',
            timestamp: 2,
            messages: [{ role: 'user', contents: textParts('second-message') }]
        };
        loads.get(2).resolve(secondChat);
        expect(await second).toBe(true);

        loads.get(1).resolve({
            chatId: 1,
            title: 'First',
            timestamp: 1,
            messages: [{ role: 'user', contents: textParts('first-message') }]
        });
        expect(await first).toBe(false);
        expect(currentChat).toBe(secondChat);
        expect(Array.from(document.getElementById('history-conversation').children).map(blockMarker)).toEqual(['second-message']);
        expect(document.getElementById('history-chat-header').textContent).toBe('Second');
    });

    test('queues live appends during a yielded history build and renders each message once in order', async () => {
        const scheduled = [];
        const messages = Array.from({ length: 25 }, (_, index) => ({
            role: index % 2 === 0 ? 'user' : 'assistant',
            contents: textParts(`stored-${index}`)
        }));
        const stateManager = {
            ...createStateManager(),
            historyList: document.getElementById('history-list'),
            limit: 20,
            offset: 0,
            shouldLoadMore: () => false
        };
        const chatUI = new HistoryChatUI({
            conversationWrapperId: 'history-conversation',
            stateManager,
            addPopupActions: () => {},
            loadHistoryItems: async () => [],
            loadChat: async () => ({ chatId: 7, title: 'Live', timestamp: 7, messages }),
            activateChat: () => {},
            getChatMeta: async () => null,
            renderScheduler: () => {
                const task = deferred();
                scheduled.push(task);
                return task.promise;
            }
        });

        const rendering = chatUI.buildChat(7);
        await Promise.resolve();
        expect(scheduled).toHaveLength(1);
        const liveMessage = { role: 'assistant', contents: textParts('live-25') };
        messages.push(liveMessage);
        chatUI.appendMessages([liveMessage], 25, 7);
        expect(document.getElementById('history-conversation').children).toHaveLength(20);

        scheduled.shift().resolve();
        expect(await rendering).toBe(true);
        const markers = Array.from(document.getElementById('history-conversation').children).map(blockMarker);
        expect(markers).toEqual([
            ...Array.from({ length: 25 }, (_, index) => `stored-${index}`),
            'live-25'
        ]);
        expect(markers.filter(marker => marker === 'live-25')).toHaveLength(1);
    });

    test('a newer build cancels queued chunks from the previous conversation', async () => {
        const scheduled = [];
        const chatUI = new SidepanelChatUI({
            conversationWrapperId: 'conversation',
            scrollElementId: 'scroll-container',
            stateManager: createStateManager(),
            renderScheduler: () => {
                const task = deferred();
                scheduled.push(task);
                return task.promise;
            }
        });
        const oldMessages = Array.from({ length: 25 }, (_, index) => ({
            role: 'user',
            contents: textParts(`old-${index}`)
        }));

        const oldRendering = chatUI.buildChat({ title: 'Old', messages: oldMessages });
        expect(scheduled).toHaveLength(1);

        expect(chatUI.buildChat({
            title: 'New',
            messages: [{ role: 'user', contents: textParts('new-message') }]
        })).toBeUndefined();
        expect(topLevelBlocks().map(blockMarker)).toEqual(['new-message']);

        scheduled.shift().resolve();
        expect(await oldRendering).toBe(false);
        expect(topLevelBlocks().map(blockMarker)).toEqual(['new-message']);
        expect(document.querySelector('.conversation-title').textContent).toBe('New');
    });

    test('destroy cancels a queued render and closeTab clears reconstruction ownership first', async () => {
        const scheduled = [];
        const chatUI = new SidepanelChatUI({
            conversationWrapperId: 'conversation',
            scrollElementId: 'scroll-container',
            stateManager: createStateManager(),
            renderScheduler: () => {
                const task = deferred();
                scheduled.push(task);
                return task.promise;
            }
        });
        const rendering = chatUI.buildChat({
            title: 'Closing',
            messages: Array.from({ length: 25 }, (_, index) => ({ role: 'user', contents: textParts(`closing-${index}`) }))
        });
        chatUI.destroy();
        scheduled.shift().resolve();
        expect(await rendering).toBe(false);
        expect(topLevelBlocks()).toHaveLength(20);

        const manager = Object.create(TabManager.prototype);
        let reconstructionAtDestroy = 'not destroyed';
        const tab = {
            id: 'closing-tab',
            reconstruction: { status: 'loading' },
            chatUI: { destroy: () => { reconstructionAtDestroy = tab.reconstruction; } },
            container: { remove: () => {} }
        };
        manager.tabs = new Map([[tab.id, tab]]);
        manager.tabOrder = [tab.id];
        manager.activeTabId = 'other-tab';
        manager.schedulePersist = () => {};
        manager.closeTab(tab.id);

        expect(reconstructionAtDestroy).toBeNull();
        expect(manager.tabs.has(tab.id)).toBe(false);
    });

    test('lazy reconstruction restores pending media only after chunked rendering completes', async () => {
        const rendering = deferred();
        const events = [];
        const chat = { chatId: 7, title: 'Restored', messages: [] };
        const chatCore = {
            continuedChatOptions: {},
            buildFromDB: restored => { chat.messages = restored.messages; },
            getChat: () => chat,
            hasChatStarted: () => true
        };
        const tab = {
            id: 'tab-7',
            tabState: { chatId: null },
            chatUI: {
                updateIncognito: () => {},
                buildChat: (renderChat, options) => {
                    events.push(['build', renderChat, options]);
                    return rendering.promise;
                }
            },
            controller: {
                chatCore,
                initStates: () => {},
                syncWebpageContextUI: () => events.push(['context']),
                restoreLatestAssistantActions: () => events.push(['actions'])
            }
        };
        const app = Object.create(SidepanelApp.prototype);
        app.getContinuationRenderChat = renderChat => ({ chat: renderChat, indexOffset: 40 });
        app.restorePendingUserMessage = (_tab, message) => events.push(['pending', message]);
        app.tabManager = {
            getTab: id => id === tab.id ? tab : null,
            updateTabTitle: () => events.push(['title']),
            schedulePersist: () => events.push(['persist'])
        };
        const pendingUserMessage = { role: 'user', images: ['pending-image'] };

        const committing = app.commitReconstruction(tab, {
            options: { chatId: 7, index: 44, secondaryIndex: 0, modelChoice: null, pendingUserMessage },
            chat: { ...chat, messages: [{ role: 'user', contents: textParts('stored') }] },
            chatId: 7,
            isContinuation: true,
            selectedMessage: { role: 'assistant' },
            fullChatLength: 45,
            secondaryLength: 1
        });

        expect(events).toEqual([['build', chat, { indexOffset: 40 }]]);
        expect(tab.tabState.chatId).toBeNull();

        rendering.resolve(true);
        expect(await committing).toBe(true);
        expect(events.map(event => event[0])).toEqual(['build', 'context', 'pending', 'title', 'persist', 'actions']);
        expect(events[2]).toEqual(['pending', pendingUserMessage]);
        expect(tab.tabState.chatId).toBe(7);
    });

    test('closed reconstruction cannot restore pending state after rendering resolves', async () => {
        const rendering = deferred();
        const events = [];
        const chat = { chatId: 8, title: 'Closing', messages: [] };
        const tab = {
            id: 'tab-8',
            reconstruction: { status: 'loading' },
            tabState: { chatId: null },
            chatUI: {
                updateIncognito: () => {},
                buildChat: () => {
                    events.push('build');
                    return rendering.promise;
                }
            },
            controller: {
                chatCore: {
                    continuedChatOptions: {},
                    buildFromDB: restored => { chat.messages = restored.messages; },
                    getChat: () => chat,
                    hasChatStarted: () => true
                },
                initStates: () => {},
                syncWebpageContextUI: () => events.push('context'),
                restoreLatestAssistantActions: () => events.push('actions')
            }
        };
        const tabs = new Map([[tab.id, tab]]);
        const app = Object.create(SidepanelApp.prototype);
        app.getContinuationRenderChat = renderChat => ({ chat: renderChat, indexOffset: 0 });
        app.restorePendingUserMessage = () => events.push('pending');
        app.tabManager = {
            getTab: id => tabs.get(id),
            updateTabTitle: () => events.push('title'),
            schedulePersist: () => events.push('persist')
        };
        const operation = tab.reconstruction;
        const committing = app.commitReconstruction(tab, {
            options: { chatId: 8, pendingUserMessage: { role: 'user', images: ['stale'] } },
            chat: { ...chat, messages: [{ role: 'user', contents: textParts('stored') }] },
            chatId: 8,
            isContinuation: true,
            selectedMessage: { role: 'assistant' }
        }, operation);

        tabs.delete(tab.id);
        tab.reconstruction = null;
        rendering.resolve(true);
        expect(await committing).toBe(false);
        expect(events).toEqual(['build']);
        expect(tab.tabState.chatId).toBeNull();
    });

    test('post-build navigation does not run for a canceled media chat build', async () => {
        let navigations = 0;
        expect(await runAfterSuccessfulBuild(Promise.resolve(false), () => { navigations++; })).toBe(false);
        expect(navigations).toBe(0);

        expect(await runAfterSuccessfulBuild(Promise.resolve(true), () => { navigations++; })).toBe(true);
        expect(navigations).toBe(1);
    });
});
