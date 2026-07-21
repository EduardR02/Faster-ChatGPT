import { afterAll, describe, expect, test } from 'bun:test';

const originalChrome = globalThis.chrome;
const originalDocument = globalThis.document;
const originalWindow = globalThis.window;
const documentListeners = new Map();
const messages = [];
let openResponse = { ok: false, error: 'blocked' };
let selection = 'selected text';

globalThis.document = {
    title: 'Example',
    visibilityState: 'visible',
    addEventListener(type, listener) { documentListeners.set(type, listener); },
    removeEventListener(type) { documentListeners.delete(type); }
};
globalThis.window = {
    location: { href: 'https://example.com/page' },
    getSelection: () => ({ toString: () => selection })
};
globalThis.chrome = {
    runtime: {
        getURL: path => `chrome-extension://test/${path}`,
        sendMessage(message, callback) {
            if (message.type === 'is_mode_on') {
                callback({ is_mode_on: true });
                return;
            }
            messages.push(message);
            if (message.type === 'open_side_panel') return Promise.resolve(openResponse);
            return Promise.resolve();
        }
    },
    storage: {
        local: {
            get(_key, callback) { callback({ auto_page_context: false }); }
        },
        onChanged: { addListener() {} }
    }
};

await import('../../src/js/content.js');

afterAll(() => {
    if (originalChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = originalChrome;
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
});

describe('content selection side panel gating', () => {
    test('suppresses selection delivery on failure and permits a later retry', async () => {
        const mouseup = documentListeners.get('mouseup');
        expect(mouseup).toBeFunction();

        await mouseup({ ctrlKey: true, metaKey: false });
        expect(messages).toEqual([{ type: 'open_side_panel' }]);

        messages.length = 0;
        openResponse = { ok: true, windowId: 14 };
        await mouseup({ ctrlKey: true, metaKey: false });
        expect(messages).toEqual([
            { type: 'open_side_panel' },
            {
                type: 'new_selection',
                text: 'selected text',
                url: 'https://example.com/page',
                targetWindowId: 14
            }
        ]);

        selection = '';
    });
});
