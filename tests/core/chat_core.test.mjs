import { describe, test, beforeEach } from "bun:test";
import { SidepanelChatCore } from '../../src/js/chat_core.js';
import { assertDeepEqual, createChromeMock } from '../setup.mjs';

// Setup chrome mock globally for dependencies that might use it
globalThis.chrome = createChromeMock();

// Mock dependencies
const createChatStorageMock = () => ({
    createNewChatTracking: (title) => ({
        title,
        messages: [],
        chatId: null
    }),
    createChatWithMessages: async (title, messages, options) => ({
        chatId: 'new-chat-id',
        title,
        messages
    }),
    addMessages: async (chatId, messages, startIndex) => {},
    updateMessage: async (chatId, index, message, options) => {},
    initArenaMessage: (modelA, modelB) => ({
        role: 'assistant',
        responses: {
            model_a: { name: modelA, messages: [] },
            model_b: { name: modelB, messages: [] }
        },
        choice: null,
        continued_with: null
    }),
    loadChat: async (chatId) => ({
        chatId,
        title: 'Loaded Chat',
        messages: []
    })
});

const createStateManagerMock = (overrides = {}) => ({
    shouldSave: true,
    thinkingMode: false,
    isThinking: () => false,
    isSolving: () => false,
    isInactive: () => true,
    getPrompt: (type) => `System prompt for ${type}`,
    getSetting: (name) => {
        if (name === 'loop_threshold') return 2;
        return null;
    },
    getArenaModelKey: (id) => 'model_a',
    getArenaModels: () => ['model-a-id', 'model-b-id'],
    nextThinkingState: () => {},
    ...overrides
});

const createChatHeaderMock = () => ({
    // Mock header if needed
});

describe('SidepanelChatCore', () => {
    describe('testContextBuilding', () => {
        test('Testing context building...', async () => {
            const storage = createChatStorageMock();
            const state = createStateManagerMock();
            const core = new SidepanelChatCore(storage, state, {});
            
            // Mock renameManager.autoRename to avoid real API/DOM calls
            core.renameManager = {
                autoRename: async () => ({ newName: 'Auto Renamed' })
            };

            // Empty conversation
            assertDeepEqual(core.getMessagesForAPI(), [], 'Empty conversation should return empty array');

            // System prompt + User message
            core.insertSystemMessage('System prompt');
            await core.addUserMessage('Hello');
            
            let messages = core.getMessagesForAPI();
            assertDeepEqual(messages, [
                { role: 'system', parts: [{ type: 'text', content: 'System prompt' }] },
                { role: 'user', parts: [{ type: 'text', content: 'Hello' }] }
            ], 'Correct order: system then user');

            // Add assistant response and check removal for regeneration
            await core.addAssistantMessage([{ type: 'text', content: 'Hi there' }], 'model-1');
            messages = core.getMessagesForAPI();
            assertDeepEqual(messages, [
                { role: 'system', parts: [{ type: 'text', content: 'System prompt' }] },
                { role: 'user', parts: [{ type: 'text', content: 'Hello' }] }
            ], 'Should remove trailing assistant message for regeneration');
        });
    });

    describe('testImageHandling', () => {
        test('Testing image handling...', async () => {
            const storage = createChatStorageMock();
            const state = createStateManagerMock();
            const core = new SidepanelChatCore(storage, state, {});
            
            // Mock renameManager.autoRename to avoid real API/DOM calls
            core.renameManager = {
                autoRename: async () => ({ newName: 'Auto Renamed' })
            };

            // Single image
            core.appendMedia('data:image/png;base64,abc', 'image');
            await core.addUserMessage('Check this');
            let messages = core.getMessagesForAPI();
            assertDeepEqual(messages[0], {
                role: 'user',
                parts: [{ type: 'text', content: 'Check this' }],
                images: ['data:image/png;base64,abc']
            }, 'User message should include single image');

            // Multiple images
            core.reset();
            core.appendMedia('img1', 'image');
            core.appendMedia('img2', 'image');
            await core.addUserMessage('Two images');
            messages = core.getMessagesForAPI();
            assertDeepEqual(messages[0].images, ['img1', 'img2'], 'User message should include multiple images');

            // Image-only message
            core.reset();
            core.appendMedia('img-only', 'image');
            await core.addUserMessage('');
            messages = core.getMessagesForAPI();
            assertDeepEqual(messages[0], {
                role: 'user',
                parts: [{ type: 'text', content: '' }],
                images: ['img-only']
            }, 'Should handle image-only message');
        });
    });

    describe('testThinkingMode', () => {
        test('Testing thinking mode...', async () => {
            const storage = createChatStorageMock();
            
            // Test Thinking injection
            let isThinkingVal = true;
            const state = createStateManagerMock({
                thinkingMode: true,
                isThinking: () => isThinkingVal,
                isSolving: () => !isThinkingVal,
                getPrompt: (type) => `PROMPT:${type}`
            });
            
            const core = new SidepanelChatCore(storage, state, {});
            
            // Mock renameManager.autoRename to avoid real API/DOM calls
            core.renameManager = {
                autoRename: async () => ({ newName: 'Auto Renamed' })
            };
            core.initThinkingChat();
            core.thinkingChat.message = { contents: [] }; // Set dummy message to trigger promptText
            core.insertSystemMessage('Original System');
            await core.addUserMessage('Request');

            // Initial thinking prompt
            let messages = core.getMessagesForAPI('model-1');
            assertDeepEqual(messages[0].role, 'system');
            assertDeepEqual(messages[0].parts[0].content, 'Original System\n\nPROMPT:thinking');
            assertDeepEqual(messages[messages.length-1].parts[0].content, 'Please reflect and improve your thoughts.');

            // Solver prompt
            isThinkingVal = false;
            // Simulate a message was added to thinking chat
            core.thinkingChat.message = { contents: [[{ type: 'thought', content: 'thinking...' }]] };
            
            messages = core.getMessagesForAPI('model-1');
            assertDeepEqual(messages[0].parts[0].content, 'Original System\n\nPROMPT:solver');
            // Check that thinking parts are included
            const assistantMsg = messages.find(m => m.role === 'assistant');
            assertDeepEqual(assistantMsg.parts, [{ type: 'thought', content: 'thinking...' }]);
            // Check solver prompt
            assertDeepEqual(messages[messages.length-1].parts[0].content, 'Using the detailed thoughts given to you, please solve now.');
        });
    });

    describe('testMessageStructure', () => {
        test('Testing message structure...', async () => {
            const storage = createChatStorageMock();
            const state = createStateManagerMock();
            const core = new SidepanelChatCore(storage, state, {});
            
            // Mock renameManager.autoRename to avoid real API/DOM calls
            core.renameManager = {
                autoRename: async () => ({ newName: 'Auto Renamed' })
            };

            await core.addUserMessage('User says hi');
            await core.addAssistantMessage([{ type: 'text', content: 'Assistant says hi' }], 'model-x');

            const internalChat = core.getChat();
            assertDeepEqual(internalChat.messages[0].role, 'user');
            assertDeepEqual(internalChat.messages[0].contents[0][0], { type: 'text', content: 'User says hi' });
            
            assertDeepEqual(internalChat.messages[1].role, 'assistant');
            assertDeepEqual(internalChat.messages[1].contents[0][0], { type: 'text', content: 'Assistant says hi', model: 'model-x' });
        });
    });

    describe('testEdgeCases', () => {
        test('Testing edge cases...', async () => {
            const storage = createChatStorageMock();
            const state = createStateManagerMock();
            const core = new SidepanelChatCore(storage, state, {});
            
            // Mock renameManager.autoRename to avoid real API/DOM calls
            core.renameManager = {
                autoRename: async () => ({ newName: 'Auto Renamed' })
            };

            // Special characters
            const specialStr = 'Hello! @#$%^&*()_+ \n \t "quotes" \'single\'';
            await core.addUserMessage(specialStr);
            let messages = core.getMessagesForAPI();
            assertDeepEqual(messages[0].parts[0].content, specialStr);

            // Empty message
            core.reset();
            await core.addUserMessage('');
            messages = core.getMessagesForAPI();
            assertDeepEqual(messages[0].parts[0].content, '');

            // Regenerated messages - ensure getMessagesForAPI handles them
            core.reset();
            await core.addUserMessage('Input');
            await core.addAssistantMessage([{ type: 'text', content: 'V1' }], 'm1');
            await core.appendRegenerated([{ type: 'text', content: 'V2' }], 'm1');
            
            const chat = core.getChat();
            assertDeepEqual(chat.messages[1].contents.length, 2, 'Assistant message should have 2 versions');
            
            messages = core.getMessagesForAPI();
            // getMessagesForAPI takes the last part of the last message (excluding assistant message if it's the very last)
            // Actually, in the current implementation, it pops the last assistant message.
            // Let's check what happens if we have another user message after
            await core.addUserMessage('Input 2');
            messages = core.getMessagesForAPI();
            
            // message[1] is the assistant message with 2 versions.
            // getMessagesForAPI: return { role: message.role, parts: message.contents.at(-1) };
            assertDeepEqual(messages[1].parts, [{ type: 'text', content: 'V2', model: 'm1' }], 'Should use latest version of assistant message');
        });
    });

    describe('testArenaMode', () => {
        test('Testing Arena mode...', async () => {
            const storage = createChatStorageMock();
            const state = createStateManagerMock({
                getArenaModelKey: (id) => (id === 'model-a-id' ? 'model_a' : 'model_b')
            });
            const core = new SidepanelChatCore(storage, state, {});
            
            // Mock renameManager.autoRename to avoid real API/DOM calls
            core.renameManager = {
                autoRename: async () => ({ newName: 'Auto Renamed' })
            };

            await core.addUserMessage('Arena start');
            core.initArena('Model A Name', 'Model B Name');
            
            const arenaMsg = core.getLatestMessage();
            assertDeepEqual(arenaMsg.responses.model_a.name, 'Model A Name');
            assertDeepEqual(arenaMsg.responses.model_b.name, 'Model B Name');

            // Update arena responses
            await core.updateArena([{ type: 'text', content: 'Response A' }], 'model-a-id', 'model_a');
            await core.updateArena([{ type: 'text', content: 'Response B' }], 'model-b-id', 'model_b');

            assertDeepEqual(arenaMsg.responses.model_a.messages[0], [{ type: 'text', content: 'Response A' }]);
            assertDeepEqual(arenaMsg.responses.model_b.messages[0], [{ type: 'text', content: 'Response B' }]);

            // Test getMessagesForAPI for a specific model in arena
            arenaMsg.continued_with = 'model_a';
            const messagesA = core.getMessagesForAPI('model-a-id');
            // Note: getMessagesForAPI pops the last assistant message.
            assertDeepEqual(messagesA.length, 1); // Only the user message 'Arena start'
            
            // If we add another user message, the arena message should stay if continued_with is set
            await core.addUserMessage('Next user message');
            const messagesA2 = core.getMessagesForAPI('model-a-id');
            const arenaPart = messagesA2.find(m => m.role === 'assistant');
            assertDeepEqual(arenaPart.parts, [{ type: 'text', content: 'Response A' }]);
        });
    });

    describe('getSystemPrompt', () => {
        test('should return system prompt content if first message is system', () => {
            const storage = createChatStorageMock();
            const state = createStateManagerMock();
            const core = new SidepanelChatCore(storage, state, {});
            
            core.insertSystemMessage('System prompt');
            const prompt = core.getSystemPrompt();
            assertDeepEqual(prompt, 'System prompt');
        });

        test('should return undefined if first message is user', async () => {
            const storage = createChatStorageMock();
            const state = createStateManagerMock();
            const core = new SidepanelChatCore(storage, state, {});
            
            // Mock renameManager.autoRename to avoid real API/DOM calls
            core.renameManager = {
                autoRename: async () => ({ newName: 'Auto Renamed' })
            };

            await core.addUserMessage('User prompt');
            const prompt = core.getSystemPrompt();
            assertDeepEqual(prompt, undefined);
        });

        test('should return undefined if there are no messages', () => {
            const storage = createChatStorageMock();
            const state = createStateManagerMock();
            const core = new SidepanelChatCore(storage, state, {});
            
            const prompt = core.getSystemPrompt();
            assertDeepEqual(prompt, undefined);
        });
    });
});
