import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'bun:test';
import { OpenAIProvider, AnthropicProvider, GeminiProvider, DeepSeekProvider, GrokProvider, KimiProvider, MistralProvider, LlamaCppProvider, RoleEnum } from '../../src/js/LLMProviders.js';
import { ChatStorage } from '../../src/js/chat_storage.js';
import { StreamWriter, StreamWriterSimple } from '../../src/js/StreamWriter.js';
import { SidepanelStateManager, CHAT_STATE, THINKING_STATE, advanceThinkingState } from '../../src/js/state_manager.js';
import { SidepanelChatCore } from '../../src/js/chat_core.js';

describe('Adversarial Tests', () => {
    let originalChrome, originalCrypto, originalIndexedDB, originalIDBKeyRange;

    beforeAll(() => {
        originalChrome = global.chrome;
        originalCrypto = global.crypto;
        originalIndexedDB = global.indexedDB;
        originalIDBKeyRange = global.IDBKeyRange;

        // --- Mocks ---
        global.chrome = {
            runtime: {
                sendMessage: () => Promise.resolve({}),
            },
            storage: {
                local: {
                    get: (keys, cb) => {
                        const res = {};
                        if (Array.isArray(keys)) keys.forEach(k => res[k] = undefined);
                        else res[keys] = undefined;
                        if (cb) cb(res);
                        return Promise.resolve(res);
                    },
                    set: () => Promise.resolve({}),
                },
                onChanged: {
                    addListener: () => { },
                }
            }
        };

        global.crypto = {
            subtle: {
                digest: async (algo, data) => {
                    return new Uint8Array(32).buffer; // Dummy hash
                }
            }
        };

        global.indexedDB = require('fake-indexeddb').indexedDB;
        global.IDBKeyRange = require('fake-indexeddb/lib/FDBKeyRange');
    });

    afterAll(() => {
        global.chrome = originalChrome;
        global.crypto = originalCrypto;
        global.indexedDB = originalIndexedDB;
        global.IDBKeyRange = originalIDBKeyRange;
    });

    describe('LLMProviders Message Formatting', () => {
        const openai = new OpenAIProvider();
        const anthropic = new AnthropicProvider();

        it('OpenAI: handles message with null parts', () => {
            const messages = [{ role: RoleEnum.user, parts: null }];
            // BUG: extractTextContent (line 70) returns '' if !msg.parts. 
            // formatMessages (line 164) calls it. 
            // If parts is null, text is '', content remains empty array [].
            // OpenAI createRequest (line 196) calls formatMessages.
            const formatted = openai.formatMessages(messages, false);
            expect(formatted[0].content).toEqual([]);
        });

        it('Anthropic: system message extraction bug', () => {
            // Line 337: system: [formatted[0].content[0]]
            // This assumes messages[0] is the system message and it has content.
            const messages = [
                { role: RoleEnum.system, parts: [] }, // Empty system parts
                { role: RoleEnum.user, parts: [{ type: 'text', content: 'hi' }] }
            ];
            const settings = { max_tokens: 1000, temperature: 0.7 };
            const options = { getWebSearch: () => false };

            // BUG: If system message has no parts, formatted[0].content will be empty if extractTextContent returns ''.
            // Actually Anthropic formatMessages (line 294) always puts at least one text part: content = [{ type: 'text', text }].
            // If text is '', it's still [{ type: 'text', text: '' }].
            // BUT if messages is empty?
            expect(() => anthropic.createRequest({
                model: 'claude-3-opus',
                messages: [],
                stream: false,
                options,
                apiKey: 'key',
                settings
            })).toThrow(); // BUG: formatted[0] will be undefined
        });

        it('Gemini: handles empty parts array', () => {
            const gemini = new GeminiProvider();
            const messages = [{ role: RoleEnum.user, parts: [] }];
            const formatted = gemini.formatMessages(messages);
            // Line 484: if (!parts.length) parts.push({ text: '' });
            expect(formatted[0].parts).toEqual([{ text: '' }]);
        });
    });

    describe('ChatStorage', () => {
        let storage;
        beforeEach(() => {
            storage = new ChatStorage();
        });

        it('loadChat returns null for non-existent ID', async () => {
            const chat = await storage.loadChat(999);
            expect(chat).toBeNull();
        });

        it('updateMessage with non-existent ID', async () => {
            const message = { role: 'user', contents: [[{ type: 'text', content: 'hi' }]] };
            await expect(storage.updateMessage(999, 0, message)).rejects.toThrow();
        });
    });

    describe('StreamWriter', () => {
        let originalDocument, originalRequestAnimationFrame;

        beforeAll(() => {
            originalDocument = global.document;
            originalRequestAnimationFrame = global.requestAnimationFrame;

            // Mocking DOM for StreamWriter
            global.document = {
                createElement: (tag) => ({
                    classList: { add: () => { }, remove: () => { } },
                    appendChild: () => { },
                    closest: () => ({ querySelector: () => ({ textContent: 'Assistant' }) }),
                    append: () => { },
                    style: {}
                }),
            };
            global.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
        });

        afterAll(() => {
            global.document = originalDocument;
            global.requestAnimationFrame = originalRequestAnimationFrame;
        });

        it('StreamWriter handles rapid transitions', async () => {
            const contentDiv = {
                classList: { add: () => { }, remove: () => { } },
                append: () => { },
                closest: () => ({ querySelector: () => ({ textContent: 'Assistant' }) }),
                parentElement: { appendChild: () => { } }
            };
            const produceNextDiv = () => contentDiv;
            const writer = new StreamWriter(contentDiv, produceNextDiv, () => { });

            writer.setThinkingModel();
            writer.processContent('Thought', true);
            writer.processContent('Result', false); // Transition

            // Wait for animation loop
            await new Promise(r => setTimeout(r, 100));
            expect(writer.isThoughtEnd).toBe(true);
        });
    });

    describe('State Manager', () => {
        it('advanceThinkingState invariant', () => {
            const state = {
                thinkingStates: { default: THINKING_STATE.INACTIVE },
                isArenaModeActive: false
            };
            // Transition from INACTIVE
            // Line 50: const next = current === THINKING_STATE.THINKING ? THINKING_STATE.SOLVING : THINKING_STATE.INACTIVE;
            // If current is INACTIVE, next is INACTIVE. It's a no-op loop.
            advanceThinkingState(state);
            expect(state.thinkingStates.default).toBe(THINKING_STATE.INACTIVE);
        });
    });

    describe('ChatCore', () => {
        it('getMessagesForAPI on empty message chat', () => {
            const mockStorage = { createNewChatTracking: () => ({ title: '', messages: [] }) };
            const core = new SidepanelChatCore(mockStorage, { thinkingMode: false });
            // BUG: Line 354 assumes messages.contents.at(-1).at(-1).content exists.
            // For an empty chat, it might crash if called incorrectly.
            // However, getMessagesForAPI is usually called with at least a system message.
            expect(() => core.getMessagesForAPI()).not.toThrow(); // Should return []
        });
    });
});
