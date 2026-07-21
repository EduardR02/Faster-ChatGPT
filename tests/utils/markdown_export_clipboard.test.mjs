import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
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
});
