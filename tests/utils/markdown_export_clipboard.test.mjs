import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { copyChatMarkdownToClipboard } from '../../src/js/markdown_export.js';

describe('copyChatMarkdownToClipboard', () => {
    let originalNavigator;
    let clipboardWrites;
    let clipboardError;

    beforeEach(() => {
        originalNavigator = globalThis.navigator;
        clipboardWrites = [];
        clipboardError = null;
        Object.defineProperty(globalThis, 'navigator', {
            value: {
                clipboard: {
                    writeText: async (text) => {
                        if (clipboardError) throw clipboardError;
                        clipboardWrites.push(text);
                    }
                }
            },
            configurable: true
        });
    });

    afterEach(() => {
        Object.defineProperty(globalThis, 'navigator', { value: originalNavigator, configurable: true });
    });

    test('loads chat without blob resolution and writes serialized markdown', async () => {
        const loadCalls = [];
        const chatStorage = {
            loadChat: async (...args) => {
                loadCalls.push(args);
                return {
                    title: 'Stored chat',
                    messages: [
                        { role: 'user', contents: [[{ type: 'text', content: 'Hi' }]], images: ['unresolved-blob-hash'] },
                        { role: 'assistant', contents: [[{ type: 'text', content: 'Hello!', model: 'gpt-5.2' }]] }
                    ]
                };
            }
        };

        await copyChatMarkdownToClipboard(chatStorage, 42);

        expect(loadCalls).toEqual([[42, null, { resolveBlobs: false }]]);
        expect(clipboardWrites).toEqual([
            '# Stored chat\n' +
            '\n' +
            '**You:**\n' +
            '\n' +
            '*[Image]*\n' +
            '\n' +
            'Hi\n' +
            '\n' +
            '**Assistant (gpt-5.2):**\n' +
            '\n' +
            'Hello!\n'
        ]);
    });

    test('throws when the chat no longer exists and leaves clipboard untouched', async () => {
        const chatStorage = { loadChat: async () => null };

        await expect(copyChatMarkdownToClipboard(chatStorage, 7)).rejects.toThrow('Chat not found: 7');
        expect(clipboardWrites).toEqual([]);
    });

    test('propagates clipboard write failures', async () => {
        clipboardError = new Error('Document is not focused');
        const chatStorage = { loadChat: async () => ({ title: 'T', messages: [] }) };

        await expect(copyChatMarkdownToClipboard(chatStorage, 1)).rejects.toThrow('Document is not focused');
    });

    test('does not let an older overlapping request write after a newer request starts', async () => {
        let resolveFirstLoad;
        let currentRequest = 1;
        const firstLoad = new Promise(resolve => { resolveFirstLoad = resolve; });
        const chatStorage = {
            loadChat: async (chatId) => chatId === 1
                ? firstLoad
                : { title: 'New request', messages: [] }
        };

        const firstCopy = copyChatMarkdownToClipboard(chatStorage, 1, () => currentRequest === 1);
        currentRequest = 2;
        const secondCopy = copyChatMarkdownToClipboard(chatStorage, 2, () => currentRequest === 2);
        resolveFirstLoad({ title: 'Stale request', messages: [] });

        expect(await secondCopy).toBe(true);
        expect(await firstCopy).toBe(false);
        expect(clipboardWrites).toEqual(['# New request\n']);
    });
});

describe('Markdown copy history action', () => {
    test('uses a native button so keyboard activation works without custom handlers', () => {
        const historyHtml = readFileSync(new URL('../../src/html/history.html', import.meta.url), 'utf8');

        expect(historyHtml).toMatch(
            /<button[^>]*type="button"[^>]*data-action="copy-markdown"[^>]*>Copy Markdown<\/button>/
        );
    });
});
