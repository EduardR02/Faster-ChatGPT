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
        // Thought content should be empty in API messages
        expect(messages.find(m => m.role === 'assistant').parts).toEqual([{ type: 'thought', content: '', model: 'model-1' }]);
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
                { type: 'image', content: 'data:image/png;base64,abc' }
            ]],
            images: ['data:image/png;base64,abc']
        };
        
        core.currentChat = {
            messages: [multiPartMessage]
        };

        const messages = core.getMessagesForAPI();
        // getMessagesForAPI uses first text part and message.images
        expect(messages[0].parts[0].content).toBe('Expected text');
        expect(messages[0].parts).toHaveLength(1);
        expect(messages[0].images).toEqual(['data:image/png;base64,abc']);
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
        // Empty contents should yield parts array length 1 with empty text content
        expect(messages[0].parts).toHaveLength(1);
        expect(messages[0].parts[0]).toEqual({ type: 'text', content: '' });
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

    describe('Cross-Mode Regeneration', () => {
        test('Normal -> Normal: appends to same message contents', async () => {
            await core.addUserMessage('Test');
            await core.addAssistantMessage([{ type: 'text', content: 'V1' }], 'm1');
            await core.appendRegenerated([{ type: 'text', content: 'V2' }], 'm1');
            
            const chat = core.getChat();
            expect(chat.messages).toHaveLength(2);
            expect(chat.messages[1].role).toBe('assistant');
            expect(chat.messages[1].contents).toHaveLength(2);
            expect(chat.messages[1].contents[0][0].content).toBe('V1');
            expect(chat.messages[1].contents[1][0].content).toBe('V2');
        });

        test('Arena -> Normal: creates NEW message', async () => {
            await core.addUserMessage('Test');
            core.initArena('Model A', 'Model B');
            await core.updateArena([{ type: 'text', content: 'Arena response' }], 'm_a', 'model_a');
            
            // Switch to normal mode and regenerate
            await core.appendRegenerated([{ type: 'text', content: 'Normal response' }], 'm1');
            
            const chat = core.getChat();
            // User + Arena + Normal = 3 messages
            expect(chat.messages).toHaveLength(3);
            expect(chat.messages[1].responses).toBeDefined(); // Still an arena message
            expect(chat.messages[2].role).toBe('assistant');
            expect(chat.messages[2].contents).toHaveLength(1); // New normal message
            expect(chat.messages[2].contents[0][0].content).toBe('Normal response');
        });

        test('Council -> Normal: creates NEW message', async () => {
            await core.addUserMessage('Test');
            core.initCouncil(['m_a'], 'collector');
            await core.updateCouncil([{ type: 'text', content: 'Council response' }], 'm_a');
            await core.updateCouncilCollector([{ type: 'text', content: 'Collected' }], 'collector');

            // Switch to normal mode and regenerate
            await core.appendRegenerated([{ type: 'text', content: 'Normal response' }], 'm1');

            const chat = core.getChat();
            // User + Council + Normal = 3 messages
            expect(chat.messages).toHaveLength(3);
            expect(chat.messages[1].council).toBeDefined(); // Still a council message
            expect(chat.messages[2].role).toBe('assistant');
            expect(chat.messages[2].contents).toHaveLength(1);
            expect(chat.messages[2].contents[0][0].content).toBe('Normal response');
        });

        test('Normal -> Arena: creates NEW arena message', async () => {
            await core.addUserMessage('Test');
            await core.addAssistantMessage([{ type: 'text', content: 'Normal' }], 'm1');
            
            // Switch to arena mode - UI calls initArena
            core.initArena('Model A', 'Model B');
            await core.updateArena([{ type: 'text', content: 'Arena' }], 'm_a', 'model_a');

            const chat = core.getChat();
            // User + Normal + Arena = 3 messages
            expect(chat.messages).toHaveLength(3);
            expect(chat.messages[1].contents).toBeDefined();
            expect(chat.messages[2].responses).toBeDefined();
        });

        test('Arena -> Arena: appends to same arena message', async () => {
            await core.addUserMessage('Test');
            core.initArena('Model A', 'Model B');
            await core.updateArena([{ type: 'text', content: 'A1' }], 'm_a', 'model_a');
            
            // Regenerating in arena mode doesn't call initArena again, just updateArena
            await core.updateArena([{ type: 'text', content: 'A2' }], 'm_a', 'model_a');

            const chat = core.getChat();
            expect(chat.messages).toHaveLength(2);
            expect(chat.messages[1].responses.model_a.messages).toHaveLength(2);
            expect(chat.messages[1].responses.model_a.messages[0][0].content).toBe('A1');
            expect(chat.messages[1].responses.model_a.messages[1][0].content).toBe('A2');
        });

        test('Council -> Council: creates NEW council message', async () => {
            await core.addUserMessage('Test');
            core.initCouncil(['m_a'], 'collector');
            await core.updateCouncil([{ type: 'text', content: 'C1' }], 'm_a');
            await core.updateCouncilCollector([{ type: 'text', content: 'Col1' }], 'collector');

            // Regenerating council creates a NEW message (new design)
            core.initCouncil(['m_a'], 'collector');
            await core.updateCouncil([{ type: 'text', content: 'C2' }], 'm_a');
            await core.updateCouncilCollector([{ type: 'text', content: 'Col2' }], 'collector');

            const chat = core.getChat();
            expect(chat.messages).toHaveLength(3); // User + Council1 + Council2
            expect(chat.messages[1].council.responses.m_a.parts[0].content).toBe('C1');
            expect(chat.messages[2].council.responses.m_a.parts[0].content).toBe('C2');
        });

        test('getMessagesForAPI with mixed history', async () => {
            await core.addUserMessage('User 1');
            await core.addAssistantMessage([{ type: 'text', content: 'Normal' }], 'm1');
            
            await core.addUserMessage('User 2');
            core.initArena('Model A', 'Model B');
            await core.updateArena([{ type: 'text', content: 'Arena A' }], 'm_a', 'model_a');
            await core.updateArenaMisc('model_a', 'model_a'); // Pick A and set continued_with

            await core.addUserMessage('User 3');
            core.initCouncil(['m_a'], 'collector');
            await core.updateCouncil([{ type: 'text', content: 'Council' }], 'm_a');
            await core.updateCouncilCollector([{ type: 'text', content: 'Collected' }], 'collector');

            // Add a final user message so council isn't the latest (which gets popped)
            await core.addUserMessage('User 4');

            const apiMessages = core.getMessagesForAPI();
            
            // Expected:
            // 0: User 1
            // 1: Normal
            // 2: User 2
            // 3: Arena A (because model_a was chosen)
            // 4: User 3
            // 5: Council response (Collected)
            // 6: User 4
            
            expect(apiMessages).toHaveLength(7);
            expect(apiMessages[0].parts[0].content).toBe('User 1');
            expect(apiMessages[1].parts[0].content).toBe('Normal');
            expect(apiMessages[2].parts[0].content).toBe('User 2');
            expect(apiMessages[3].parts[0].content).toBe('Arena A');
            expect(apiMessages[4].parts[0].content).toBe('User 3');
            expect(apiMessages[5].parts[0].content).toBe('Collected');
            expect(apiMessages[6].parts[0].content).toBe('User 4');
        });

        test('getMessagesForAPI handles consecutive assistant messages correctly', async () => {
            // This happens during cross-mode regeneration like Arena -> Normal
            await core.addUserMessage('User 1');
            core.initArena('Model A', 'Model B');
            await core.updateArena([{ type: 'text', content: 'Arena response' }], 'm_a', 'model_a');
            await core.updateArenaMisc('model_a', 'model_a');

            // Switch to normal and regenerate - this creates a second assistant message
            await core.appendRegenerated([{ type: 'text', content: 'Normal response' }], 'm1');

            // Add follow-up user message so the regenerated normal message isn't popped
            await core.addUserMessage('User 2');

            const apiMessages = core.getMessagesForAPI();
            // Should have: User 1, then Arena (as choice), then Normal, then User 2.
            expect(apiMessages).toHaveLength(4);
            expect(apiMessages[0].role).toBe('user');
            expect(apiMessages[1].parts[0].content).toBe('Arena response');
            expect(apiMessages[2].parts[0].content).toBe('Normal response');
            expect(apiMessages[3].role).toBe('user');
        });

        test('getMessagesForAPI should sanitize thought content', async () => {
            await core.addUserMessage('User');
            await core.addAssistantMessage([
                { type: 'thought', content: 'Secret thoughts' },
                { type: 'text', content: 'Public answer' }
            ], 'm1');
            await core.addUserMessage('Next');

            const messages = core.getMessagesForAPI();
            const assistantMessage = messages.find(m => m.role === 'assistant');
            expect(assistantMessage.parts).toEqual([
                { type: 'thought', content: '', model: 'm1' },
                { type: 'text', content: 'Public answer', model: 'm1' }
            ]);
        });

        test('getMessagesForAPI should preserve thoughtSignature but clear content', async () => {
            await core.addUserMessage('User');
            await core.addAssistantMessage([
                { type: 'thought', content: 'Gemini thought', thoughtSignature: 'sig123' },
                { type: 'text', content: 'Hello' }
            ], 'gemini-model');
            await core.addUserMessage('Next');

            const messages = core.getMessagesForAPI();
            const assistantMessage = messages.find(m => m.role === 'assistant');
            expect(assistantMessage.parts).toEqual([
                { type: 'thought', content: '', thoughtSignature: 'sig123', model: 'gemini-model' },
                { type: 'text', content: 'Hello', model: 'gemini-model' }
            ]);
        });

        test('getMessagesForAPI should tolerate null parts in assistant messages', async () => {
            core.currentChat = {
                messages: [
                    { role: 'user', contents: [[{ type: 'text', content: 'User' }]] },
                    {
                        role: 'assistant',
                        contents: [[
                            null,
                            { type: 'thought', content: 'Hidden thought' },
                            { type: 'text', content: 'Visible answer' }
                        ]]
                    },
                    { role: 'user', contents: [[{ type: 'text', content: 'Next' }]] }
                ]
            };

            const messages = core.getMessagesForAPI();
            const assistantMessage = messages.find(m => m.role === 'assistant');

            expect(assistantMessage.parts[0]).toBeNull();
            expect(assistantMessage.parts[1]).toEqual({ type: 'thought', content: '' });
            expect(assistantMessage.parts[2]).toEqual({ type: 'text', content: 'Visible answer' });
        });

        test('ThinkingChat.getLatestParts should tolerate null parts', () => {
            state.toggleThinkingMode();
            state.updateThinkingMode();
            core.initThinkingChat();
            core.thinkingChat.message = {
                role: 'assistant',
                contents: [[null, { type: 'thought', content: 'Hidden thought' }, { type: 'text', content: 'Visible answer' }]]
            };

            const latestParts = core.thinkingChat.getLatestParts('model-1');

            expect(latestParts.parts[0]).toBeNull();
            expect(latestParts.parts[1]).toEqual({ type: 'thought', content: '' });
            expect(latestParts.parts[2]).toEqual({ type: 'text', content: 'Visible answer' });
        });

        test('Council message in mid-conversation for getMessagesForAPI', async () => {
            await core.addUserMessage('user 1');
            
            // Council message
            core.initCouncil(['model-a'], 'collector');
            await core.updateCouncil([{ type: 'text', content: 'council response' }], 'model-a');
            await core.updateCouncilCollector([{ type: 'text', content: 'collector synthesis' }], 'collector');
            
            await core.addUserMessage('user 2');
            await core.addAssistantMessage([{ type: 'text', content: 'normal assistant' }], 'model-b');
            await core.addUserMessage('user 3');

            const apiMessages = core.getMessagesForAPI();
            // Expected: user 1 -> collector synthesis -> user 2 -> normal assistant -> user 3
            expect(apiMessages).toHaveLength(5);
            expect(apiMessages[0].parts[0].content).toBe('user 1');
            expect(apiMessages[1].role).toBe('assistant');
            expect(apiMessages[1].parts[0].content).toBe('collector synthesis');
            expect(apiMessages[2].parts[0].content).toBe('user 2');
            expect(apiMessages[3].parts[0].content).toBe('normal assistant');
            expect(apiMessages[4].parts[0].content).toBe('user 3');
        });

        test('getMessagesForAPI strips trailing council message for regeneration', async () => {
            await core.addUserMessage('user 1');
            
            // Trailing council message
            core.initCouncil(['model-a'], 'collector');
            await core.updateCouncil([{ type: 'text', content: 'council response' }], 'model-a');
            await core.updateCouncilCollector([{ type: 'text', content: 'collector synthesis' }], 'collector');

            const apiMessages = core.getMessagesForAPI();
            // Should pop the trailing assistant (council) and return only user 1
            expect(apiMessages).toHaveLength(1);
            expect(apiMessages[0].role).toBe('user');
            expect(apiMessages[0].parts[0].content).toBe('user 1');
        });

        test('Council thought sanitization in getMessagesForAPI', async () => {
            await core.addUserMessage('user 1');
            
            core.initCouncil(['model-a'], 'collector');
            // Council response with thought
            await core.updateCouncil([
                { type: 'thought', content: 'council thought' },
                { type: 'text', content: 'council text' }
            ], 'model-a');
            // Collector output with thought
            await core.updateCouncilCollector([
                { type: 'thought', content: 'collector thought' },
                { type: 'text', content: 'collector synthesis' }
            ], 'collector');
            
            await core.addUserMessage('user 2');

            const apiMessages = core.getMessagesForAPI();
            const councilAssistant = apiMessages.find(m => m.role === 'assistant');
            
            // Collector synthesis thoughts should be sanitized
            expect(councilAssistant.parts).toEqual([
                { type: 'thought', content: '', model: 'collector' },
                { type: 'text', content: 'collector synthesis', model: 'collector' }
            ]);

            // verify internal council responses are NOT touched (they are not in apiMessages anyway, 
            // but let's check the chat core state)
            const chat = core.getChat();
            expect(chat.messages[1].council.responses['model-a'].parts[0].content).toBe('council thought');
        });
    });

    describe('Regeneration Edge Cases', () => {
        test('Regenerate when no previous assistant message', async () => {
            await core.addUserMessage('Test');
            await core.appendRegenerated([{ type: 'text', content: 'New' }], 'm1');
            
            const chat = core.getChat();
            expect(chat.messages).toHaveLength(2);
            expect(chat.messages[1].role).toBe('assistant');
            expect(chat.messages[1].contents[0][0].content).toBe('New');
        });

        test('Regenerate arena message when model key doesn\'t exist', async () => {
            core.initArena('Model A', 'Model B');
            // Trying to update a non-existent model key should probably fail gracefully or be handled
            // In current code: this.getLatestMessage().responses[modelKey].messages.push(parts);
            // So it will throw if modelKey is wrong.
            
            expect(core.updateArena([{type: 'text', content: 'Fail'}], 'm_c', 'model_c')).rejects.toThrow();
        });
    });
});
