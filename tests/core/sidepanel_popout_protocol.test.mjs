import { afterAll, beforeEach, describe, expect, test } from 'bun:test';

class MockChromeEvent {
    constructor() {
        this.listeners = new Set();
    }
    addListener(listener) { this.listeners.add(listener); }
    removeListener(listener) { this.listeners.delete(listener); }
    emit(message, sender = {}, sendResponse = () => {}) {
        for (const listener of [...this.listeners]) listener(message, sender, sendResponse);
    }
    send(message) {
        return new Promise(resolve => {
            let awaitingResponse = false;
            let responded = false;
            const sendResponse = response => {
                if (responded) return;
                responded = true;
                resolve(response);
            };
            for (const listener of [...this.listeners]) {
                if (listener(message, {}, sendResponse) === true) awaitingResponse = true;
            }
            if (!responded && !awaitingResponse) resolve(undefined);
        });
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
let removedTabs = [];
const chromeMock = {
    runtime: {
        onMessage: runtimeMessages,
        sendMessage: message => runtimeMessages.send(message)
    },
    tabs: { remove: async tabId => { removedTabs.push(tabId); } },
    windows: {}
};
globalThis.chrome = chromeMock;

const { SidepanelApp, waitForCreatedTabReceiver } = await import('../../src/js/sidepanel.js');
const sidepanelUrl = 'chrome-extension://test/src/html/sidepanel.html';
const token = label => `${label}:${'x'.repeat(32)}`;

beforeEach(() => {
    globalThis.chrome = chromeMock;
    runtimeMessages.listeners.clear();
    removedTabs = [];
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
                { type: 'sidepanel_ready', windowId: 8, receiverToken: token('tab-64') },
                { tab: { id: 64 }, url: sidepanelUrl }
            );
            return created.promise;
        }, sidepanelUrl, 100);

        runtimeMessages.emit(
            { type: 'sidepanel_ready', windowId: 8, receiverToken: token('tab-999') },
            { tab: { id: 999 }, url: sidepanelUrl }
        );
        created.resolve({ id: 64 });

        expect(await waiting).toEqual({ tab: { id: 64 }, receiverToken: token('tab-64') });
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
        expect(removedTabs).toEqual([65]);
    });
});

describe('handoff receiver targeting', () => {
    test('initialized sidepanel registers and announces its in-memory receiver token', async () => {
        const messages = [];
        globalThis.chrome = {
            ...chromeMock,
            runtime: {
                ...chromeMock.runtime,
                sendMessage: async message => {
                    messages.push(message);
                    if (message.type === 'register_sidepanel_receiver') {
                        return { ok: true, receiverToken: message.receiverToken };
                    }
                }
            }
        };
        const panel = Object.create(SidepanelApp.prototype);
        panel.setHostContext(11, null);
        panel.receiverToken = token('panel-11');
        panel.receiverReady = false;

        await panel.markReceiverReady();
        await Promise.resolve();

        expect(panel.receiverReady).toBe(true);
        expect(messages).toEqual([
            {
                type: 'register_sidepanel_receiver',
                windowId: 11,
                receiverToken: token('panel-11')
            },
            {
                type: 'sidepanel_ready',
                windowId: 11,
                receiverToken: token('panel-11')
            }
        ]);
    });

    test('side panels and popped-out tabs accept only their concrete target', () => {
        const panel = Object.create(SidepanelApp.prototype);
        panel.setHostContext(12, null);
        panel.receiverToken = token('panel-12');
        panel.receiverReady = true;
        const poppedOut = Object.create(SidepanelApp.prototype);
        poppedOut.setHostContext(12, 88);
        poppedOut.receiverToken = token('tab-88');
        poppedOut.receiverReady = true;

        expect(panel.isHandoffTarget({ targetWindowId: 12, targetReceiverToken: token('panel-12') })).toBe(true);
        expect(panel.isHandoffTarget({ targetWindowId: 12, targetReceiverToken: token('closed-panel') })).toBe(false);
        expect(panel.isHandoffTarget({ targetWindowId: 13 })).toBe(false);
        expect(poppedOut.isHandoffTarget({ targetWindowId: 12 })).toBe(false);
        expect(poppedOut.isHandoffTarget({ targetTabId: 88, targetReceiverToken: token('tab-88') })).toBe(true);
        expect(poppedOut.isHandoffTarget({ targetTabId: 89, targetReceiverToken: token('tab-88') })).toBe(false);
    });

    test('only the targeted receiver responds after asynchronous processing completes', async () => {
        const processing = deferred();
        const calls = [];
        const panel = Object.create(SidepanelApp.prototype);
        panel.setHostContext(12, null);
        panel.receiverToken = token('panel-12');
        panel.receiverReady = true;
        panel.stateManager = { isOn: () => true };
        panel.handleReconstructChat = options => {
            calls.push(['panel', options.chatId]);
            return processing.promise;
        };
        panel.setupMessageListeners();

        const poppedOut = Object.create(SidepanelApp.prototype);
        poppedOut.setHostContext(12, 88);
        poppedOut.receiverToken = token('tab-88');
        poppedOut.receiverReady = true;
        poppedOut.stateManager = { isOn: () => true };
        poppedOut.handleReconstructChat = () => { calls.push(['popped-out']); };
        poppedOut.setupMessageListeners();

        const otherWindow = Object.create(SidepanelApp.prototype);
        otherWindow.setHostContext(13, null);
        otherWindow.receiverToken = token('panel-13');
        otherWindow.receiverReady = true;
        otherWindow.stateManager = { isOn: () => true };
        otherWindow.handleReconstructChat = () => { calls.push(['other-window']); };
        otherWindow.setupMessageListeners();

        let acknowledged = false;
        const delivery = runtimeMessages.send({
            type: 'reconstruct_chat',
            options: { chatId: 7 },
            targetWindowId: 12,
            targetReceiverToken: token('panel-12')
        }).then(response => {
            acknowledged = true;
            return response;
        });
        await Promise.resolve();

        expect(calls).toEqual([['panel', 7]]);
        expect(acknowledged).toBe(false);
        processing.resolve(true);
        expect(await delivery).toEqual({ ok: true });
    });

    test('target receiver errors are returned as explicit rejection acknowledgements', async () => {
        const panel = Object.create(SidepanelApp.prototype);
        panel.setHostContext(13, null);
        panel.receiverToken = token('panel-13');
        panel.receiverReady = true;
        panel.stateManager = { isOn: () => true };
        panel.handleNewChat = async () => { throw new Error('reconstruction failed'); };
        panel.setupMessageListeners();

        expect(await runtimeMessages.send({
            type: 'new_chat',
            targetWindowId: 13,
            targetReceiverToken: token('panel-13')
        })).toEqual({ ok: false, error: 'reconstruction failed' });
    });

    test('panel-to-tab transfer removes the ready tab when reconstruction is rejected', async () => {
        const errors = [];
        let sourceClosed = false;
        globalThis.window = { close: () => { sourceClosed = true; } };
        globalThis.chrome = {
            ...chromeMock,
            runtime: {
                ...chromeMock.runtime,
                getURL: path => `chrome-extension://test/${path}`,
                sendMessage: async () => ({ ok: false, error: 'target rejected reconstruction' })
            },
            tabs: {
                ...chromeMock.tabs,
                create: async () => {
                    runtimeMessages.emit(
                        { type: 'sidepanel_ready', windowId: 12, receiverToken: token('tab-70') },
                        { tab: { id: 70, windowId: 12 }, url: sidepanelUrl }
                    );
                    return { id: 70 };
                }
            }
        };

        const app = Object.create(SidepanelApp.prototype);
        const chatCore = {
            getChatId: () => 6,
            getLength: () => 2,
            getWebpageContext: () => null,
            isWebpageContextDismissed: () => false,
            getLatestMessage: () => ({ role: 'assistant', contents: [['answer']] }),
            getSystemPrompt: () => 'system'
        };
        app.getReadyActiveTab = async () => ({
            id: 'source',
            controller: { chatCore, collectPendingUserMessage: () => null },
            tabState: { isSidePanel: true },
            chatUI: { addErrorMessage: message => errors.push(message) }
        });
        app.tabManager = { getTabCount: () => 1 };

        expect(await app.handlePopoutToggle()).toBe(false);
        expect(removedTabs).toEqual([70]);
        expect(errors).toEqual(['target rejected reconstruction']);
        expect(sourceClosed).toBe(false);
    });

    test('tab-to-panel transfer keeps the source intact if the ready target closes before handoff', async () => {
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
                    if (message.type === 'open_side_panel') {
                        return { ok: true, windowId: 20, receiverToken: token('closed-panel') };
                    }
                    return undefined;
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
        expect(sent).toEqual([
            { type: 'open_side_panel' },
            {
                type: 'reconstruct_chat',
                options: expect.any(Object),
                targetWindowId: 20,
                targetReceiverToken: token('closed-panel')
            }
        ]);
        expect(errors).toEqual(['Side panel did not acknowledge the handoff']);
        expect(closed).toBe(false);
    });

    test('tab-to-panel transfer closes once only after target processing acknowledgement', async () => {
        const delivery = deferred();
        const events = [];
        globalThis.window = { close: () => events.push('close-source') };
        globalThis.chrome = {
            ...chromeMock,
            runtime: {
                ...chromeMock.runtime,
                sendMessage: message => {
                    events.push(message.type);
                    if (message.type === 'open_side_panel') {
                        return Promise.resolve({ ok: true, windowId: 21, receiverToken: token('panel-21') });
                    }
                    return delivery.promise;
                },
                getURL: path => `chrome-extension://test/${path}`
            },
            tabs: {
                ...chromeMock.tabs,
                query: async () => [{ id: 88 }, { id: 89 }],
                create: async () => { throw new Error('must not create fallback'); }
            },
            windows: { WINDOW_ID_CURRENT: -2 }
        };

        const app = Object.create(SidepanelApp.prototype);
        const chatCore = {
            getChatId: () => 5,
            getLength: () => 2,
            getWebpageContext: () => null,
            isWebpageContextDismissed: () => false,
            getLatestMessage: () => ({ role: 'assistant', contents: [['answer']] }),
            getSystemPrompt: () => 'system'
        };
        app.getReadyActiveTab = async () => ({
            controller: { chatCore, collectPendingUserMessage: () => null },
            tabState: { isSidePanel: false },
            chatUI: { addErrorMessage: message => events.push(`error:${message}`) }
        });
        app.tabManager = { getTabCount: () => 1 };

        const first = app.handlePopoutToggle();
        const duplicate = app.handlePopoutToggle();
        expect(duplicate).toBe(first);
        await Promise.resolve();
        await Promise.resolve();
        expect(events).toEqual(['open_side_panel', 'reconstruct_chat']);

        delivery.resolve({ ok: true });
        expect(await first).toBe(true);
        expect(await duplicate).toBe(true);
        expect(events).toEqual(['open_side_panel', 'reconstruct_chat', 'close-source']);
    });
});
