import { describe, test, expect, beforeEach } from "bun:test";
import { SidepanelChatCore } from '../../src/js/chat_core.js';
import { ChatStorage } from '../../src/js/chat_storage.js';
import { SidepanelStateManager, THINKING_STATE } from '../../src/js/state_manager.js';
import { IDBFactory } from 'fake-indexeddb';
import 'fake-indexeddb/auto';

// Mock chrome APIs
const createChromeMock = () => {
    const storage = new Map();
    const listeners = new Set();
    return {
        storage: {
            local: {
                get: (keys, callback) => {
                    const result = {};
                    const keyList = Array.isArray(keys) ? keys : [keys];
                    keyList.forEach(k => {
                        if (storage.has(k)) result[k] = storage.get(k);
                    });
                    if (callback) callback(result);
                    return Promise.resolve(result);
                },
                set: (items, callback) => {
                    Object.entries(items).forEach(([k, v]) => storage.set(k, v));
                    if (callback) callback();
                    return Promise.resolve();
                }
            },
            onChanged: {
                addListener: (cb) => listeners.add(cb),
                removeListener: (cb) => listeners.delete(cb)
            }
        },
        runtime: {
            sendMessage: () => Promise.resolve()
        }
    };
};

describe('SidepanelChatCore Integration', () => {
    let storage;
    let state;
    let core;

    beforeEach(async () => {
        // Reset IndexedDB
        globalThis.indexedDB = new IDBFactory();
        globalThis.chrome = createChromeMock();
        
        // Setup state with some defaults
        await chrome.storage.local.set({
            loop_threshold: 2,
            thinking_prompt: 'THINK_PROMPT',
            solver_prompt: 'SOLVE_PROMPT',
            active_prompt: 'SYSTEM_PROMPT'
        });

        storage = new ChatStorage();
        // Disable background migration for tests
        storage.runPendingMigration = () => Promise.resolve();
        
        state = new SidepanelStateManager('active_prompt');
        // Wait for state to initialize from chrome.storage.local
        await new Promise(resolve => state.runOnReady(resolve));
        
        core = new SidepanelChatCore(storage, state, {});
        
        // Mock renameManager to avoid real API calls in tests
        core.renameManager = {
            autoRename: async () => ({ newName: 'Auto Renamed' })
        };
    });

    test('message persistence round-trip', async () => {
        await core.addUserMessage('Hello world');
        const chatId = core.getChatId();
        expect(chatId).toBeGreaterThan(0);

        await core.addAssistantMessage([{ type: 'text', content: 'Hi there' }], 'model-1');
        
        // Verify in-memory state
        expect(core.getLength()).toBe(2);
        
        // Load from real storage
        const loaded = await storage.loadChat(chatId);
        expect(loaded.messages).toHaveLength(2);
        expect(loaded.messages[0].role).toBe('user');
        expect(loaded.messages[0].contents[0][0].content).toBe('Hello world');
        expect(loaded.messages[1].role).toBe('assistant');
        expect(loaded.messages[1].contents[0][0].content).toBe('Hi there');
    });

    test('context building for API', async () => {
        core.insertSystemMessage('System prompt');
        await core.addUserMessage('Hello');
        
        let messages = core.getMessagesForAPI();
        expect(messages).toEqual([
            { role: 'system', parts: [{ type: 'text', content: 'System prompt' }] },
            { role: 'user', parts: [{ type: 'text', content: 'Hello' }] }
        ]);
    });

    test('image handling and persistence', async () => {
        const imageData = 'data:image/png;base64,abc';
        core.appendMedia(imageData, 'image');
        await core.addUserMessage('Look at this');
        
        const chatId = core.getChatId();
        const loaded = await storage.loadChat(chatId);
        
        expect(loaded.messages[0].images).toEqual([imageData]);
        
        const apiMessages = core.getMessagesForAPI();
        expect(apiMessages[0].images).toEqual([imageData]);
    });

    test('thinking mode state transitions and prompt injection', async () => {
        // Toggle thinking mode on
        state.toggleThinkingMode();
        state.updateThinkingMode();
        expect(state.thinkingMode).toBe(true);

        // setup prompts
        state.state.prompts.thinking = 'THINK_PROMPT';
        state.state.prompts.solver = 'SOLVE_PROMPT';

        core.initThinkingChat();
        state.initThinkingState('model-1');
        
        if (core.thinkingChat) {
            core.thinkingChat.loopThreshold = 2;
        }
        core.insertSystemMessage('Base system');
        await core.addUserMessage('Think about this');

        // 1. Thinking phase
        let messages = core.getMessagesForAPI('model-1');
        expect(messages[0].parts[0].content).toContain('Base system');
        expect(messages[0].parts[0].content).toContain('THINK_PROMPT');
        // Initial call doesn't have reflecting prompt yet because this.message is null in ThinkingChat
        expect(messages.at(-1).parts[0].content).toBe('Think about this');

        // Add thinking response
        await core.addAssistantMessage([{ type: 'thought', content: 'I am thinking' }], 'model-1');
        
        // 2. Second thinking loop
        messages = core.getMessagesForAPI('model-1');
        expect(messages.find(m => m.role === 'assistant').parts).toEqual([{ type: 'thought', content: 'I am thinking', model: 'model-1' }]);
        expect(messages.at(-1).parts[0].content).toBe('Please reflect and improve your thoughts.');
        expect(state.getThinkingState('model-1')).toBe(THINKING_STATE.THINKING);

        await core.addAssistantMessage([{ type: 'thought', content: 'Still thinking' }], 'model-1');
        
        // 3. Solving phase
        expect(state.getThinkingState('model-1')).toBe(THINKING_STATE.SOLVING);
        messages = core.getMessagesForAPI('model-1');
        expect(messages[0].parts[0].content).toContain('SOLVE_PROMPT');
        expect(messages.at(-1).parts[0].content).toBe('Using the detailed thoughts given to you, please solve now.');
        
        await core.addAssistantMessage([{ type: 'text', content: 'Here is the solution' }], 'model-1');
        
        // 4. Finalized
        expect(state.getThinkingState('model-1')).toBe(THINKING_STATE.INACTIVE);
        const chat = core.getChat();
        expect(chat.messages).toHaveLength(3); 
        // All parts are merged into a single version's contents because of how ThinkingChat.addMessage works
        expect(chat.messages[2].contents).toHaveLength(1);
        expect(chat.messages[2].contents[0]).toHaveLength(3);
        expect(chat.messages[2].contents[0][0].content).toBe('I am thinking');
        expect(chat.messages[2].contents[0][1].content).toBe('Still thinking');
        expect(chat.messages[2].contents[0][2].content).toBe('Here is the solution');
    });

    test('arena mode integration', async () => {
        state.initArenaResponse('model-a', 'model-b');
        await core.addUserMessage('Arena start');
        
        core.initArena('Model A Name', 'Model B Name');
        const chatId = core.getChatId();
        
        await core.updateArena([{ type: 'text', content: 'Response A' }], 'model-a', 'model_a');
        await core.updateArena([{ type: 'text', content: 'Response B' }], 'model-b', 'model_b');
        
        const loaded = await storage.loadChat(chatId);
        const arenaMsg = loaded.messages[1];
        expect(arenaMsg.responses.model_a.name).toBe('Model A Name');
        expect(arenaMsg.responses.model_a.messages[0][0].content).toBe('Response A');
        expect(arenaMsg.responses.model_b.messages[0][0].content).toBe('Response B');

        // Test model-specific API context
        await core.updateArenaMisc('model_a', 'model_a');
        const apiMessages = core.getMessagesForAPI('model-a');
        // last assistant message (the arena one) is popped for regeneration
        expect(apiMessages).toHaveLength(1); 
        
        // If we add another message, the arena choice should be reflected
        await core.addUserMessage('Follow up');
        const apiMessages2 = core.getMessagesForAPI('model-a');
        const assistantPart = apiMessages2.find(m => m.role === 'assistant');
        expect(assistantPart.parts).toEqual([{ type: 'text', content: 'Response A' }]);
    });

    test('regeneration versions are persisted', async () => {
        await core.addUserMessage('Test');
        await core.addAssistantMessage([{ type: 'text', content: 'V1' }], 'm1');
        await core.appendRegenerated([{ type: 'text', content: 'V2' }], 'm1');
        
        const chatId = core.getChatId();
        const loaded = await storage.loadChat(chatId);
        expect(loaded.messages[1].contents).toHaveLength(2);
        expect(loaded.messages[1].contents[0][0].content).toBe('V1');
        expect(loaded.messages[1].contents[1][0].content).toBe('V2');
    });

    test('system prompt retrieval', () => {
        core.insertSystemMessage('Custom System');
        expect(core.getSystemPrompt()).toBe('Custom System');
        
        core.reset();
        expect(core.getSystemPrompt()).toBeUndefined();
    });

    describe('isUserMessageEqual file comparison', () => {
        test('compares messages with different files', () => {
            const msgA = {
                role: 'user',
                contents: [[{ content: 'Hello' }]],
                files: [{ name: 'a.txt', content: 'aaa' }]
            };
            const msgB = {
                role: 'user',
                contents: [[{ content: 'Hello' }]],
                files: [{ name: 'b.txt', content: 'bbb' }]
            };
            expect(core.isUserMessageEqual(msgA, msgB)).toBe(false);
        });

        test('compares messages with same files', () => {
            const msgA = {
                role: 'user',
                contents: [[{ content: 'Hello' }]],
                files: [{ name: 'a.txt', content: 'aaa' }]
            };
            const msgB = {
                role: 'user',
                contents: [[{ content: 'Hello' }]],
                files: [{ name: 'a.txt', content: 'aaa' }]
            };
            expect(core.isUserMessageEqual(msgA, msgB)).toBe(true);
        });

        test('handles different number of files', () => {
            const msgA = {
                role: 'user',
                contents: [[{ content: 'Hello' }]],
                files: [{ name: 'a.txt', content: 'aaa' }]
            };
            const msgB = {
                role: 'user',
                contents: [[{ content: 'Hello' }]],
                files: []
            };
            expect(core.isUserMessageEqual(msgA, msgB)).toBe(false);
        });

        test('handles missing file list on one message', () => {
            const msgA = {
                role: 'user',
                contents: [[{ content: 'Hello' }]],
                files: [{ name: 'a.txt', content: 'aaa' }]
            };
            const msgB = {
                role: 'user',
                contents: [[{ content: 'Hello' }]]
                // files missing
            };
            expect(core.isUserMessageEqual(msgA, msgB)).toBe(false);
        });
    });

    test('getMessagesForAPI should handle multi-part messages correctly', async () => {
        const multiPartMessage = {
            role: 'user',
            contents: [[
                { type: 'text', content: 'Expected text' },
                { type: 'image', content: 'base64-data' }
            ]]
        };
        
        core.currentChat = {
            messages: [multiPartMessage]
        };

        const messages = core.getMessagesForAPI();
        expect(messages[0].parts[0].content).toBe('Expected text');
    });

    test('getMessagesForAPI should handle empty contents gracefully', async () => {
        const emptyMessage = {
            role: 'user',
            contents: [[]]
        };
        
        core.currentChat = {
            messages: [emptyMessage]
        };

        const messages = core.getMessagesForAPI();
        expect(messages[0].parts[0].content).toBe('');
    });

    test('getMessagesForAPI should return the LATEST version when multiple versions exist', async () => {
        const multiVersionMessage = {
            role: 'user',
            contents: [
                [{ type: 'text', content: 'Version 1' }],
                [{ type: 'text', content: 'Version 2' }]
            ]
        };

        core.currentChat = {
            messages: [multiVersionMessage]
        };

        const messages = core.getMessagesForAPI();
        expect(messages).toHaveLength(1);
        expect(messages[0].parts[0].content).toBe('Version 2');
    });
});
