import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
    downloadMarkdownFile,
    markdownFilenameFromTitle,
    saveChatMarkdownToFile,
    serializeChatToMarkdown
} from '../../src/js/markdown_export.js';

const waitForUrlCleanup = () => new Promise(resolve => setTimeout(resolve, 5));

describe('Markdown file save', () => {
    let documentDescriptor;
    let navigatorDescriptor;
    let originalCreateObjectURL;
    let originalRevokeObjectURL;
    let anchors;
    let blobs;
    let revokedUrls;
    let clickError;
    let clipboardWrites;

    beforeEach(() => {
        documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
        navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
        originalCreateObjectURL = URL.createObjectURL;
        originalRevokeObjectURL = URL.revokeObjectURL;
        anchors = [];
        blobs = [];
        revokedUrls = [];
        clickError = null;
        clipboardWrites = [];

        Object.defineProperty(globalThis, 'document', {
            configurable: true,
            value: {
                createElement: tagName => {
                    expect(tagName).toBe('a');
                    const anchor = {
                        click: () => {
                            if (clickError) throw clickError;
                        }
                    };
                    anchors.push(anchor);
                    return anchor;
                }
            }
        });
        Object.defineProperty(globalThis, 'navigator', {
            configurable: true,
            value: { clipboard: { writeText: text => clipboardWrites.push(text) } }
        });
        Object.defineProperty(URL, 'createObjectURL', {
            configurable: true,
            writable: true,
            value: blob => {
                blobs.push(blob);
                return `blob:markdown-test-${blobs.length}`;
            }
        });
        Object.defineProperty(URL, 'revokeObjectURL', {
            configurable: true,
            writable: true,
            value: url => revokedUrls.push(url)
        });
    });

    afterEach(() => {
        if (documentDescriptor) Object.defineProperty(globalThis, 'document', documentDescriptor);
        else delete globalThis.document;
        if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor);
        else delete globalThis.navigator;
        Object.defineProperty(URL, 'createObjectURL', {
            configurable: true,
            writable: true,
            value: originalCreateObjectURL
        });
        Object.defineProperty(URL, 'revokeObjectURL', {
            configurable: true,
            writable: true,
            value: originalRevokeObjectURL
        });
    });

    test('builds useful cross-platform filenames from chat titles', () => {
        expect(markdownFilenameFromTitle(' Project: alpha/beta?  ')).toBe('Project- alpha-beta.md');
        expect(markdownFilenameFromTitle('Notes.MD')).toBe('Notes.md');
        expect(markdownFilenameFromTitle('CON')).toBe('_CON.md');
        expect(markdownFilenameFromTitle('lpt9.notes')).toBe('_lpt9.notes.md');
        expect(markdownFilenameFromTitle('. <>::  ')).toBe('Untitled chat.md');
        expect(markdownFilenameFromTitle(null)).toBe('Untitled chat.md');

        const longFilename = markdownFilenameFromTitle('🚀'.repeat(80));
        expect(Array.from(longFilename.slice(0, -3))).toHaveLength(60);
        expect(longFilename.endsWith('.md')).toBe(true);
    });

    test('uses one detached anchor and revokes its UTF-8 Markdown object URL', async () => {
        downloadMarkdownFile('Zażółć gęślą jaźń 🚀', 'Résumé.md');

        expect(anchors).toHaveLength(1);
        expect(anchors[0]).toMatchObject({
            href: 'blob:markdown-test-1',
            download: 'Résumé.md'
        });
        expect(blobs).toHaveLength(1);
        expect(blobs[0].type).toBe('text/markdown;charset=utf-8');
        expect(await blobs[0].text()).toBe('Zażółć gęślą jaźń 🚀');
        expect(revokedUrls).toEqual([]);

        await waitForUrlCleanup();
        expect(revokedUrls).toEqual(['blob:markdown-test-1']);
    });

    test('loads without blobs and saves the exact serializer output, including large text', async () => {
        const largeText = `start\n${'large markdown content\n'.repeat(100_000)}end`;
        const chat = {
            title: 'Large / media chat',
            messages: [
                {
                    role: 'user',
                    contents: [[{ type: 'text', content: largeText }]],
                    images: ['blob:https://example.test/private-image'],
                    audio: [{ name: 'voice.mp3', data: 'data:audio/mp3;base64,PRIVATE' }]
                },
                {
                    role: 'assistant',
                    contents: [[
                        { type: 'text', content: 'Generated:', model: 'model-x' },
                        { type: 'image', content: 'blob:https://example.test/private-output' }
                    ]]
                }
            ]
        };
        const loadCalls = [];
        const chatStorage = {
            loadChat: async (...args) => {
                loadCalls.push(args);
                return chat;
            }
        };

        expect(await saveChatMarkdownToFile(chatStorage, 42)).toBe(true);

        const savedMarkdown = await blobs[0].text();
        expect(loadCalls).toEqual([[42, null, { resolveBlobs: false }]]);
        expect(anchors[0].download).toBe('Large - media chat.md');
        expect(savedMarkdown).toBe(serializeChatToMarkdown(chat));
        expect(savedMarkdown).toContain('*[Image]*');
        expect(savedMarkdown).toContain('*[Audio: voice.mp3]*');
        expect(savedMarkdown).not.toContain('blob:');
        expect(savedMarkdown).not.toContain('base64,PRIVATE');
        expect(clipboardWrites).toEqual([]);

        await waitForUrlCleanup();
        expect(revokedUrls).toEqual(['blob:markdown-test-1']);
    });

    test('does not start a stale download after loading the chat', async () => {
        const chatStorage = { loadChat: async () => ({ title: 'Stale', messages: [] }) };

        expect(await saveChatMarkdownToFile(chatStorage, 3, () => false)).toBe(false);
        expect(blobs).toEqual([]);
        expect(anchors).toEqual([]);
    });

    test('revokes the object URL immediately and propagates a download click error', async () => {
        clickError = new Error('Download blocked');
        const chatStorage = { loadChat: async () => ({ title: 'Failure', messages: [] }) };

        await expect(saveChatMarkdownToFile(chatStorage, 9)).rejects.toThrow('Download blocked');

        expect(blobs).toHaveLength(1);
        expect(revokedUrls).toEqual(['blob:markdown-test-1']);
        expect(clipboardWrites).toEqual([]);
    });
});
