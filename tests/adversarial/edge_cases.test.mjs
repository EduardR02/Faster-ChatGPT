import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'bun:test';
import { OpenAIProvider, AnthropicProvider, GeminiProvider, DeepSeekProvider, GrokProvider, KimiProvider, MistralProvider, LlamaCppProvider, RoleEnum } from '../../src/js/LLMProviders.js';
import { ChatStorage } from '../../src/js/chat_storage.js';
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
            // If parts is null, extractTextContent returns ''.
            // Current production behavior: content becomes empty array [].
            // This test documents the current behavior.
            const formatted = openai.formatMessages(messages, false);
            expect(formatted[0].content).toEqual([]);
        });

        it('Anthropic: handles system message extraction gracefully', () => {
            // Line 337: system: [formatted[0].content[0]]
            // This assumes messages[0] is the system message and it has content.
            const messages = [
                { role: RoleEnum.system, parts: [] }, // Empty system parts
                { role: RoleEnum.user, parts: [{ type: 'text', content: 'hi' }] }
            ];
            const settings = { max_tokens: 1000, temperature: 0.7 };
            const options = { getWebSearch: () => false };

            // Verifies it doesn't throw if messages is empty
            expect(() => anthropic.createRequest({
                model: 'claude-3-opus',
                messages: [],
                stream: false,
                options,
                apiKey: 'key',
                settings
            })).not.toThrow();
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
            // Verify DB is still empty
            const count = await storage.dbOp(['chatMeta'], 'readonly', tx => storage.req(tx.objectStore('chatMeta').count()));
            expect(count).toBe(0);
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

    describe('Bug Verification (Fixed)', () => {
        it('1. ChatCore.getSystemPrompt correctly returns undefined if no system message', () => {
            const mockStorage = { createNewChatTracking: () => ({ title: '', messages: [] }) };
            const core = new SidepanelChatCore(mockStorage, {});

            // First message is user, not system
            core.currentChat.messages.push({
                role: RoleEnum.user,
                contents: [[{ type: 'text', content: 'Hello, world!' }]]
            });

            const prompt = core.getSystemPrompt();
            
            // EXPECTED BEHAVIOR: It should return undefined if no system message is present.
            expect(prompt).toBeUndefined();
        });

        it('2. OpenAIProvider: All system message text parts are used', () => {
            const openai = new OpenAIProvider();
            const messages = [
                {
                    role: RoleEnum.system,
                    parts: [
                        { type: 'text', content: 'Part 1' },
                        { type: 'text', content: 'Part 2' }
                    ]
                },
                { role: RoleEnum.user, parts: [{ type: 'text', content: 'hi' }] }
            ];
            
            const settings = { max_tokens: 1000, temperature: 0.7 };
            const options = { webSearch: false };

            const [url, request] = openai.createRequest({
                model: 'gpt-5.2',
                messages,
                stream: false,
                options,
                apiKey: 'key',
                settings
            });

            const body = JSON.parse(request.body);

            // EXPECTED BEHAVIOR: System prompt should include all text parts joined by newlines.
            expect(body.instructions).toBe('Part 1\nPart 2');
            expect(body.model).toBe('gpt-5.2');
        });

        it('3. AnthropicProvider: Empty messages array to createRequest does not crash', () => {
            const anthropic = new AnthropicProvider();
            const settings = { max_tokens: 1000, temperature: 0.7 };
            const options = { getWebSearch: () => false };

            // Verifies it handles empty messages array without crashing.
            expect(() => anthropic.createRequest({
                model: 'claude-3-7-sonnet',
                messages: [],
                stream: false,
                options,
                apiKey: 'key',
                settings
            })).not.toThrow();
        });
    });
});
