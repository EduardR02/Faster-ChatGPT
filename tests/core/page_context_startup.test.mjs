import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { SidepanelApp } from '../../src/js/sidepanel.js';
import { SidepanelController } from '../../src/js/sidepanel_controller.js';

const deferred = () => {
    let resolve;
    const promise = new Promise(onResolve => { resolve = onResolve; });
    return { promise, resolve };
};

const originalChrome = globalThis.chrome;
const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
let runtimeMessages;

const createTab = (requestPageContext, events = []) => {
    let webpageContext = null;
    const chatCore = {
        pendingMedia: {},
        hasChatStarted: () => false,
        hasWebpageContext: () => webpageContext !== null,
        isWebpageContextDismissed: () => false,
        setWebpageContext: context => {
            if (!context) return false;
            webpageContext = context;
            return true;
        },
        getWebpageContext: () => webpageContext,
        getChatId: () => null
    };
    const chatUI = {
        clearConversation: () => events.push('shell-ready'),
        setWebpageContext: context => {
            if (context) events.push('context-attached');
        }
    };
    const controller = Object.create(SidepanelController.prototype);
    Object.assign(controller, {
        state: { getSetting: setting => setting === 'auto_page_context' },
        chatCore,
        chatUI,
        initStates: () => {},
        initPrompt: async () => {},
        requestCurrentPageContext: requestPageContext
    });

    return {
        id: 'fresh-tab',
        reconstruction: null,
        controller,
        chatUI,
        tabState: { chatId: null }
    };
};

const createApp = tab => {
    const app = Object.create(SidepanelApp.prototype);
    const tabs = new Map();
    let activeTabId = null;
    Object.assign(app, {
        pageContextRequests: new Map(),
        tabTextareaContent: new Map(),
        restoredTabLoadTimers: new Map(),
        textInput: { value: '' },
        openedForReconstruct: false,
        startupAt: Date.now(),
        startupNewTabId: null,
        receiverToken: `page-context:${'x'.repeat(32)}`,
        receiverReady: false,
        hostWindowId: 9,
        hostTabId: null,
        hostContextReady: true,
        ensureSharedUIInitialized: () => {},
        ensureActiveTab: () => {},
        tabManager: {
            restorePersistedTabs: async () => {},
            getAllTabs: () => [...tabs.values()],
            getTab: id => tabs.get(id),
            getActiveTab: () => tabs.get(activeTabId),
            getActiveController: () => tabs.get(activeTabId)?.controller,
            getActiveChatUI: () => tabs.get(activeTabId)?.chatUI,
            getTabChatId: target => target.controller.chatCore.getChatId(),
            createTab: () => {
                tabs.set(tab.id, tab);
                activeTabId = tab.id;
                return tab;
            },
            updateTabTitle: () => {},
            switchTab: id => { activeTabId = id; }
        }
    });
    app.addExistingTab = () => {
        tabs.set(tab.id, tab);
        activeTabId = tab.id;
    };
    return app;
};

beforeEach(() => {
    runtimeMessages = [];
    globalThis.requestAnimationFrame = callback => callback();
    globalThis.chrome = {
        runtime: {
            sendMessage: async message => {
                runtimeMessages.push(message);
                if (message.type === 'register_sidepanel_receiver') {
                    return { ok: true, receiverToken: message.receiverToken };
                }
            }
        }
    };
});

afterAll(() => {
    if (originalChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = originalChrome;
    if (originalRequestAnimationFrame === undefined) delete globalThis.requestAnimationFrame;
    else globalThis.requestAnimationFrame = originalRequestAnimationFrame;
});

describe('non-blocking page context startup', () => {
    test('announces receiver readiness while fresh-tab context extraction is unresolved', async () => {
        const extraction = deferred();
        const events = [];
        const tab = createTab(() => {
            events.push('context-requested');
            return extraction.promise;
        }, events);
        const app = createApp(tab);

        await app.bootstrapTabs();
        await app.markReceiverReady();

        expect(events).toEqual(['shell-ready', 'context-requested']);
        expect(app.receiverReady).toBe(true);
        expect(runtimeMessages.map(message => message.type)).toEqual([
            'register_sidepanel_receiver',
            'sidepanel_ready'
        ]);
        expect(tab.controller.chatCore.getWebpageContext()).toBeNull();

        extraction.resolve(null);
        await Promise.resolve();
    });

    test('attaches asynchronously returned context to an unchanged normal chat tab', async () => {
        const context = { url: 'https://example.com/article', title: 'Article', content: 'Page text' };
        const tab = createTab(async () => context);
        const app = createApp(tab);
        app.addExistingTab();

        await app.attachPageContextToTab(tab.id);

        expect(tab.controller.chatCore.getWebpageContext()).toEqual(context);
    });

    test('does not attach a delayed response after reconstruction takes ownership of the tab', async () => {
        const extraction = deferred();
        const context = { url: 'https://example.com/old', title: 'Old page', content: 'Old text' };
        const tab = createTab(() => extraction.promise);
        const app = createApp(tab);
        app.addExistingTab();
        app.ensureTabReady = async () => {
            tab.reconstruction = null;
            return true;
        };

        const attaching = app.attachPageContextToTab(tab.id);
        await Promise.resolve();
        await app.handleReconstructChat({ chatId: 42 });
        extraction.resolve(context);
        await attaching;

        expect(tab.controller.chatCore.getWebpageContext()).toBeNull();
        expect(app.pageContextRequests.size).toBe(0);
    });
});
