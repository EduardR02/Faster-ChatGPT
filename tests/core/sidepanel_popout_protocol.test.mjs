import { afterAll, beforeEach, describe, expect, test } from 'bun:test';

class MockChromeEvent {
    constructor() {
        this.listeners = new Set();
    }
    addListener(listener) { this.listeners.add(listener); }
    removeListener(listener) { this.listeners.delete(listener); }
    emit(message, sender = {}) {
        for (const listener of [...this.listeners]) listener(message, sender);
    }
}

const deferred = () => {
    let resolve;
    const promise = new Promise(onResolve => { resolve = onResolve; });
    return { promise, resolve };
};

const originalChrome = globalThis.chrome;
const originalWindow = globalThis.window;
const runtimeMessages = new MockChromeEvent();
globalThis.chrome = {
    runtime: { onMessage: runtimeMessages },
    tabs: {},
    windows: {}
};

const { SidepanelApp, waitForCreatedTabReceiver } = await import('../../src/js/sidepanel.js');
const sidepanelUrl = 'chrome-extension://test/src/html/sidepanel.html';

beforeEach(() => {
    runtimeMessages.listeners.clear();
});

afterAll(() => {
    if (originalChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = originalChrome;
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
});

describe('pop-out receiver readiness', () => {
    test('subscribes before tab creation and correlates ready to the created tab', async () => {
        const created = deferred();
        const waiting = waitForCreatedTabReceiver(() => {
            runtimeMessages.emit(
                { type: 'sidepanel_ready', windowId: 8 },
                { tab: { id: 64 }, url: sidepanelUrl }
            );
            return created.promise;
        }, sidepanelUrl, 100);

        runtimeMessages.emit(
            { type: 'sidepanel_ready', windowId: 8 },
            { tab: { id: 999 }, url: sidepanelUrl }
        );
        created.resolve({ id: 64 });

        expect(await waiting).toEqual({ id: 64 });
        expect(runtimeMessages.listeners.size).toBe(0);
    });

    test('rejects readiness failure and cleans up instead of treating timeout as delivery', async () => {
        expect(waitForCreatedTabReceiver(
            () => Promise.resolve({ id: 65 }),
            sidepanelUrl,
            5
        )).rejects.toThrow('did not become ready');
        await new Promise(resolve => setTimeout(resolve, 10));
        expect(runtimeMessages.listeners.size).toBe(0);
    });
});

describe('handoff receiver targeting', () => {
    test('side panels and popped-out tabs accept only their concrete target', () => {
        const panel = Object.create(SidepanelApp.prototype);
        panel.setHostContext(12, null);
        const poppedOut = Object.create(SidepanelApp.prototype);
        poppedOut.setHostContext(12, 88);

        expect(panel.isHandoffTarget({ targetWindowId: 12 })).toBe(true);
        expect(panel.isHandoffTarget({ targetWindowId: 13 })).toBe(false);
        expect(poppedOut.isHandoffTarget({ targetWindowId: 12 })).toBe(false);
        expect(poppedOut.isHandoffTarget({ targetTabId: 88 })).toBe(true);
        expect(poppedOut.isHandoffTarget({ targetTabId: 89 })).toBe(false);
    });

    test('tab-to-panel transfer keeps the source intact when open_side_panel fails', async () => {
        const sent = [];
        const errors = [];
        let closed = false;
        globalThis.window = { close: () => { closed = true; } };
        globalThis.chrome = {
            ...globalThis.chrome,
            runtime: {
                ...globalThis.chrome.runtime,
                sendMessage: async message => {
                    sent.push(message);
                    return { ok: false, error: 'open failed' };
                },
                getURL: path => `chrome-extension://test/${path}`
            },
            tabs: {
                query: async () => [{ id: 88 }],
                create: async () => { throw new Error('must not create fallback'); }
            },
            windows: { WINDOW_ID_CURRENT: -2 }
        };

        const app = Object.create(SidepanelApp.prototype);
        const chatCore = {
            getChatId: () => 4,
            getLength: () => 2,
            getWebpageContext: () => null,
            isWebpageContextDismissed: () => false,
            getLatestMessage: () => ({ role: 'assistant', contents: [['answer']] }),
            getSystemPrompt: () => 'system'
        };
        app.getReadyActiveTab = async () => ({
            controller: {
                chatCore,
                collectPendingUserMessage: () => null
            },
            tabState: { isSidePanel: false },
            chatUI: { addErrorMessage: message => errors.push(message) }
        });
        app.tabManager = { getTabCount: () => 1 };

        expect(await app.handlePopoutToggle()).toBe(false);
        expect(sent).toEqual([{ type: 'open_side_panel' }]);
        expect(errors).toEqual(['open failed']);
        expect(closed).toBe(false);
    });
});
