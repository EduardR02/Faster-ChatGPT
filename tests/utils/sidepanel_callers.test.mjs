import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { createChromeMock } from '../setup.mjs';

const deferred = () => {
    let resolve;
    const promise = new Promise(onResolve => { resolve = onResolve; });
    return { promise, resolve };
};

const originalChrome = globalThis.chrome;
const originalDocument = globalThis.document;
const originalWindow = globalThis.window;
const chromeMock = createChromeMock();
const domListeners = new Map();

chromeMock.windows = { getCurrent: async () => ({ id: 77 }) };
chromeMock.runtime.sendMessage = async () => {};
globalThis.chrome = chromeMock;
globalThis.document = {
    addEventListener(type, listener) { domListeners.set(type, listener); }
};
globalThis.window = { close() {} };

await chromeMock.storage.local.set({ mode: 0 });
const { openSidePanel } = await import('../../src/js/popup.js');
const { openSidePanelWithHandoff } = await import('../../src/js/sidepanel_handoff.js');

beforeEach(async () => {
    await chromeMock.storage.local.set({ mode: 0 });
    chromeMock.windows.getCurrent = async () => ({ id: 77 });
    chromeMock.runtime.sendMessage = async () => {};
    globalThis.window = { close() {} };
});

afterAll(() => {
    if (originalChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = originalChrome;
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
});

describe('caller handoff gating', () => {
    test('suppresses the follow-up when open_side_panel returns ok false', async () => {
        const messages = [];
        chromeMock.runtime.sendMessage = async message => {
            messages.push(message);
            return { ok: false, error: 'not allowed' };
        };

        expect(await openSidePanelWithHandoff({ type: 'reconstruct_chat' })).toEqual({
            ok: false,
            error: 'not allowed'
        });
        expect(messages).toEqual([{ type: 'open_side_panel' }]);
    });

    test('targets the follow-up to the concrete window returned by the opener', async () => {
        const messages = [];
        chromeMock.runtime.sendMessage = async message => {
            messages.push(message);
            if (message.type === 'open_side_panel') {
                return { ok: true, windowId: 19, documentId: 'panel-19' };
            }
            return { ok: true };
        };

        expect(await openSidePanelWithHandoff({ type: 'reconstruct_chat', options: { chatId: 3 } })).toEqual({
            ok: true,
            windowId: 19,
            documentId: 'panel-19'
        });
        expect(messages).toEqual([
            { type: 'open_side_panel' },
            {
                type: 'reconstruct_chat',
                options: { chatId: 3 },
                targetWindowId: 19,
                targetDocumentId: 'panel-19'
            }
        ]);
    });

    test('fails when the ready document closes or rejects before acknowledging delivery', async () => {
        const messages = [];
        chromeMock.runtime.sendMessage = async message => {
            messages.push(message);
            if (message.type === 'open_side_panel') {
                return { ok: true, windowId: 20, documentId: 'closed-panel' };
            }
            return undefined;
        };

        expect(await openSidePanelWithHandoff({ type: 'new_chat' })).toEqual({
            ok: false,
            error: 'Side panel did not acknowledge the handoff',
            windowId: 20,
            documentId: 'closed-panel'
        });
        expect(messages[1].targetDocumentId).toBe('closed-panel');
    });
});

describe('popup close ordering', () => {
    test('closes only after target readiness/open success and new_chat delivery', async () => {
        const events = [];
        const openResponse = deferred();
        const deliveryResponse = deferred();
        chromeMock.runtime.sendMessage = message => {
            events.push(message.type);
            if (message.type === 'open_side_panel') return openResponse.promise;
            return deliveryResponse.promise;
        };
        globalThis.window.close = () => events.push('close');

        const opening = openSidePanel();
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(events).toEqual(['open_side_panel']);

        events.push('panel-ready-and-open');
        openResponse.resolve({ ok: true, windowId: 77, documentId: 'popup-panel' });
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(events).toEqual([
            'open_side_panel',
            'panel-ready-and-open',
            'new_chat'
        ]);

        events.push('new-chat-processed');
        deliveryResponse.resolve({ ok: true });
        expect(await opening).toBe(true);
        expect(events).toEqual([
            'open_side_panel',
            'panel-ready-and-open',
            'new_chat',
            'new-chat-processed',
            'close'
        ]);
    });

    test('keeps the popup open and suppresses new_chat when opening fails', async () => {
        const events = [];
        const originalError = console.error;
        console.error = () => {};
        chromeMock.runtime.sendMessage = async message => {
            events.push(message.type);
            return { ok: false, error: 'blocked' };
        };
        globalThis.window.close = () => events.push('close');

        expect(await openSidePanel()).toBe(false);
        console.error = originalError;
        expect(events).toEqual(['open_side_panel']);
    });
});
