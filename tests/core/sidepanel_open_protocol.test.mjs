import { afterAll, beforeEach, describe, expect, test } from 'bun:test';

class MockChromeEvent {
    constructor() {
        this.listeners = new Set();
    }

    addListener(listener) {
        this.listeners.add(listener);
    }

    removeListener(listener) {
        this.listeners.delete(listener);
    }

    emit(message, sender = {}, sendResponse = () => {}) {
        for (const listener of [...this.listeners]) listener(message, sender, sendResponse);
    }
}

const deferred = () => {
    let resolve;
    let reject;
    const promise = new Promise((onResolve, onReject) => {
        resolve = onResolve;
        reject = onReject;
    });
    return { promise, resolve, reject };
};

const flush = async () => {
    await Promise.resolve();
    await Promise.resolve();
};

const originalChrome = globalThis.chrome;
const runtimeMessages = new MockChromeEvent();
const commandEvents = new MockChromeEvent();
const panelUrl = 'chrome-extension://test/src/html/sidepanel.html';
const token = label => `${label}:${'x'.repeat(32)}`;
const realSidepanelContext = {
    contextType: 'SIDE_PANEL',
    documentUrl: panelUrl,
    windowId: -1
};
let getContextsCalls = 0;
let sentMessages = [];
let openedWindowIds = [];
let probeHandler = null;
let messageHandler = null;

const chromeMock = {
    runtime: {
        OnInstalledReason: { INSTALL: 'install', UPDATE: 'update' },
        getURL: path => `chrome-extension://test/${path}`,
        getContexts: async () => {
            getContextsCalls++;
            return [realSidepanelContext];
        },
        onInstalled: new MockChromeEvent(),
        onMessage: runtimeMessages,
        openOptionsPage() {},
        sendMessage: async message => {
            sentMessages.push(message);
            probeHandler?.(message);
            return messageHandler?.(message);
        }
    },
    commands: { onCommand: commandEvents },
    sidePanel: {
        setOptions: async () => {},
        open: async ({ windowId }) => { openedWindowIds.push(windowId); }
    },
    windows: {
        onRemoved: new MockChromeEvent(),
        getLastFocused: async () => ({ id: 91 })
    },
    tabs: { create: async () => {} },
    storage: {
        local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
        session: { get: async () => ({}), set: async () => {}, remove: async () => {} }
    }
};

globalThis.chrome = chromeMock;
const { openPanel } = await import('../../src/js/background.js');
const permanentRuntimeListeners = new Set(runtimeMessages.listeners);
const backgroundMessageListener = [...permanentRuntimeListeners][0];

const announceReady = (windowId, receiverToken, tab = null) => {
    const sender = { url: panelUrl };
    if (tab) sender.tab = tab;
    runtimeMessages.emit({ type: 'sidepanel_ready', windowId, receiverToken }, sender);
};

beforeEach(() => {
    runtimeMessages.listeners = new Set(permanentRuntimeListeners);
    getContextsCalls = 0;
    sentMessages = [];
    openedWindowIds = [];
    probeHandler = null;
    messageHandler = null;
    chromeMock.sidePanel.setOptions = async () => {};
    chromeMock.sidePanel.open = async ({ windowId }) => { openedWindowIds.push(windowId); };
    chromeMock.windows.getLastFocused = async () => ({ id: 91 });
});

afterAll(() => {
    if (originalChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = originalChrome;
});

describe('targeted side panel readiness', () => {
    test('registers a receiver token without relying on sender document or context window IDs', async () => {
        const responseRequest = deferred();
        expect(backgroundMessageListener(
            { type: 'register_sidepanel_receiver', windowId: 16, receiverToken: token('panel-16') },
            { url: panelUrl },
            responseRequest.resolve
        )).toBe(false);

        expect(await responseRequest.promise).toEqual({ ok: true, receiverToken: token('panel-16') });
        expect(realSidepanelContext.windowId).toBe(-1);
        expect(getContextsCalls).toBe(0);
    });

    test('subscribes before a cold open and waits for restored-shell readiness and open success', async () => {
        const openRequest = deferred();
        const events = [];
        let restored = false;
        chromeMock.sidePanel.open = ({ windowId }) => {
            events.push(`open:${windowId}`);
            expect(runtimeMessages.listeners.size).toBe(permanentRuntimeListeners.size + 1);
            restored = true;
            announceReady(windowId, token('cold-panel'));
            return openRequest.promise;
        };

        let completed = false;
        const opening = openPanel({ windowId: 17 }, null, 100).then(target => {
            completed = true;
            events.push('complete');
            return target;
        });
        await flush();

        expect(restored).toBe(true);
        expect(completed).toBe(false);
        expect(events).toEqual(['open:17']);

        openRequest.resolve();
        expect(await opening).toEqual({ windowId: 17, receiverToken: token('cold-panel') });
        expect(events).toEqual(['open:17', 'complete']);
        expect(runtimeMessages.listeners.size).toBe(permanentRuntimeListeners.size);
    });

    test('probes an already-ready panel for an immediate warm handoff after worker restart', async () => {
        probeHandler = message => {
            if (message.type === 'probe_sidepanel_ready' && message.windowId === 23) {
                announceReady(23, token('warm-panel'));
            }
        };

        expect(await openPanel({ windowId: 23 }, null, 100)).toEqual({
            windowId: 23,
            receiverToken: token('warm-panel')
        });
        expect(openedWindowIds).toEqual([23]);
        expect(realSidepanelContext.windowId).toBe(-1);
        expect(getContextsCalls).toBe(0);
    });

    test('keeps concurrent windows isolated from unrelated and popped-out readiness', async () => {
        let firstComplete = false;
        let secondComplete = false;
        const first = openPanel({ windowId: 31 }, null, 100).then(() => { firstComplete = true; });
        const second = openPanel({ windowId: 32 }, null, 100).then(() => { secondComplete = true; });

        announceReady(99, token('other-window'));
        announceReady(31, token('popped-out'), { id: 300, windowId: 31 });
        announceReady(32, token('panel-32'));
        await new Promise(resolve => setTimeout(resolve, 0));

        expect(firstComplete).toBe(false);
        expect(secondComplete).toBe(true);

        announceReady(31, token('panel-31'));
        await Promise.all([first, second]);
        expect(openedWindowIds).toEqual([31, 32]);
        expect(runtimeMessages.listeners.size).toBe(permanentRuntimeListeners.size);
    });

    test('uses only concrete target IDs, including the focused-window fallback', async () => {
        const completeWhenProbed = message => {
            if (message.type !== 'probe_sidepanel_ready') return;
            announceReady(message.windowId, token(`panel-${message.windowId}`));
        };
        probeHandler = completeWhenProbed;

        await openPanel(null, -2, 100);
        expect(openedWindowIds).toEqual([91]);
        expect(openedWindowIds).not.toContain(-2);
    });

    test('commands target the ready receiver token and await its acknowledgement', async () => {
        probeHandler = message => {
            if (message.type === 'probe_sidepanel_ready') {
                announceReady(message.windowId, token('command-panel'));
            }
        };
        messageHandler = message => message.type === 'new_chat' ? { ok: true } : undefined;

        const commandListener = [...commandEvents.listeners][0];
        await commandListener('new-chat', { windowId: 35 });

        expect(sentMessages.at(-1)).toEqual({
            type: 'new_chat',
            targetWindowId: 35,
            targetReceiverToken: token('command-panel')
        });
    });
});

describe('side panel open failures', () => {
    test('propagates open rejection and removes the readiness listener', async () => {
        chromeMock.sidePanel.open = () => Promise.reject(new Error('user activation expired'));

        expect(openPanel({ windowId: 41 }, null, 100)).rejects.toThrow('user activation expired');
        await flush();
        expect(runtimeMessages.listeners.size).toBe(permanentRuntimeListeners.size);
    });

    test('propagates setOptions rejection', async () => {
        chromeMock.sidePanel.setOptions = () => Promise.reject(new Error('cannot enable panel'));

        expect(openPanel({ windowId: 42 }, null, 100)).rejects.toThrow('cannot enable panel');
        await flush();
        expect(openedWindowIds).toEqual([42]);
    });

    test('rejects terminally when readiness never arrives instead of reporting delivery', async () => {
        expect(openPanel({ windowId: 43 }, null, 5)).rejects.toThrow('did not become ready');
        await new Promise(resolve => setTimeout(resolve, 10));
        expect(runtimeMessages.listeners.size).toBe(permanentRuntimeListeners.size);
    });

    test('returns ok false from messaging and commands suppress new_chat after failure', async () => {
        chromeMock.sidePanel.open = () => Promise.reject(new Error('not allowed'));
        const responseRequest = deferred();

        expect(backgroundMessageListener(
            { type: 'open_side_panel', windowId: 51 },
            {},
            responseRequest.resolve
        )).toBe(true);
        expect(await responseRequest.promise).toEqual({ ok: false, error: 'not allowed' });

        sentMessages = [];
        const commandListener = [...commandEvents.listeners][0];
        const originalError = console.error;
        console.error = () => {};
        await commandListener('new-chat', { windowId: 52 });
        console.error = originalError;
        expect(sentMessages.filter(message => message.type === 'new_chat')).toEqual([]);
    });
});
