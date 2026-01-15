import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { IDBFactory } from 'fake-indexeddb';
import 'fake-indexeddb/auto';
import { ChatStorage } from '../../src/js/chat_storage.js';

// Mock chrome.runtime for announce()
globalThis.chrome = {
    runtime: { sendMessage: () => Promise.resolve() }
};

describe('Data Integrity', () => {
    let storage;

    beforeEach(() => {
        // Reset IndexedDB
        indexedDB = new IDBFactory();
        storage = new ChatStorage();
        // Disable background migration for tests to avoid console warnings
        storage.runPendingMigration = () => Promise.resolve();
    });

    /**
     * Scenario 1: Partial save failures
     * Start saving a chat with 5 messages
     * Simulate IndexedDB failure after 3 messages
     * Verify: what state is the database left in?
     */
    test('partial save failure leaves database consistent (all or nothing)', async () => {
        const messages = Array.from({ length: 5 }, (_, i) => ({
            role: 'user',
            contents: [[{ type: 'text', content: `Message ${i}` }]]
        }));

        const db = await storage.getDB();
        const originalAdd = IDBObjectStore.prototype.add;
        let count = 0;

        // Mock add to fail after 3 calls in the 'messages' store
        IDBObjectStore.prototype.add = function (...args) {
            if (this.name === 'messages') {
                count++;
                if (count > 3) {
                    // This throw happens inside the dbOp callback
                    throw new Error('IndexedDB simulated failure');
                }
            }
            return originalAdd.apply(this, args);
        };

        try {
            await storage.createChatWithMessages('Failing Chat', messages);
        } catch (e) {
            expect(e.message).toBe('IndexedDB simulated failure');
        } finally {
            IDBObjectStore.prototype.add = originalAdd;
        }

        // Verify state: because it's a single transaction, nothing should be saved.
        const metaCount = await storage.dbOp(['chatMeta'], 'readonly', tx => storage.req(tx.objectStore('chatMeta').count()));
        const msgCount = await storage.dbOp(['messages'], 'readonly', tx => storage.req(tx.objectStore('messages').count()));
        const blobCount = await storage.dbOp(['blobs'], 'readonly', tx => storage.req(tx.objectStore('blobs').count()));

        expect(metaCount).toBe(0);
        expect(msgCount).toBe(0);
        expect(blobCount).toBe(0);
    });

    /**
     * Scenario 2: Blob reference counting
     * Create chat with image
     * Delete chat -> Verify blob is removed
     * Create two chats with same image
     * Delete one chat -> Verify blob still exists
     * Delete second chat -> Verify blob is removed
     */
    test('blob reference counting handles multi-chat sharing and deletion', async () => {
        const imageData = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwIB/AL+X1EAAAAASUVORK5CYII=';
        
        // 1. Create chat with image
        const chat1 = await storage.createChatWithMessages('Chat 1', [
            { role: 'user', contents: [[{ type: 'text', content: 'Img 1' }]], images: [imageData] }
        ]);
        
        const getBlobCount = async () => {
            return storage.dbOp(['blobs'], 'readonly', tx => storage.req(tx.objectStore('blobs').count()));
        };

        expect(await getBlobCount()).toBe(1);

        // 2. Delete chat -> Verify blob is removed
        await storage.deleteChat(chat1.chatId);
        expect(await getBlobCount()).toBe(0);

        // 3. Create two chats with same image
        const chat2 = await storage.createChatWithMessages('Chat 2', [
            { role: 'user', contents: [[{ type: 'text', content: 'Img A' }]], images: [imageData] }
        ]);
        const chat3 = await storage.createChatWithMessages('Chat 3', [
            { role: 'user', contents: [[{ type: 'text', content: 'Img B' }]], images: [imageData] }
        ]);
        
        expect(await getBlobCount()).toBe(1);

        // 4. Delete one chat -> Verify blob still exists
        await storage.deleteChat(chat2.chatId);
        expect(await getBlobCount()).toBe(1);

        // 5. Delete second chat -> Verify blob is removed
        await storage.deleteChat(chat3.chatId);
        expect(await getBlobCount()).toBe(0);
    });

    /**
     * Scenario 3: Message update race
     * Load a chat
     * Start updating message at index 2
     * Simultaneously try to add a new message
     * Verify final state is consistent
     */
    test('message update and add message concurrently maintain consistency', async () => {
        const initialMessages = [
            { role: 'user', contents: [[{ type: 'text', content: 'Msg 0' }]] },
            { role: 'assistant', contents: [[{ type: 'text', content: 'Msg 1' }]] },
            { role: 'user', contents: [[{ type: 'text', content: 'Msg 2' }]] }
        ];
        const { chatId } = await storage.createChatWithMessages('Race Test', initialMessages);

        // We trigger two operations "simultaneously". 
        // IndexedDB transactions are serialized by the browser/fake-indexeddb.
        // The first one to start its transaction will finish first if they are readwrite on same stores.
        const p1 = storage.updateMessage(chatId, 2, {
            role: 'user',
            contents: [[{ type: 'text', content: 'Updated Msg 2' }]]
        });
        const p2 = storage.addMessages(chatId, [{
            role: 'assistant',
            contents: [[{ type: 'text', content: 'New Msg 3' }]]
        }], 3);

        await Promise.all([p1, p2]);

        const loaded = await storage.loadChat(chatId);
        expect(loaded.messages).toHaveLength(4);
        expect(loaded.messages[2].contents[0][0].content).toBe('Updated Msg 2');
        expect(loaded.messages[3].contents[0][0].content).toBe('New Msg 3');
        // Ensure role integrity
        expect(loaded.messages[2].role).toBe('user');
        expect(loaded.messages[3].role).toBe('assistant');
    });

    /**
     * Scenario 4: Regeneration overwrites
     * Chat has 3 messages
     * Regenerate message 2 
     * Add a 4th message
     * Regenerate message 2 again
     * Verify messages 3 and 4 are intact
     */
    test('regeneration (updateMessage) does not accidentally truncate or corrupt adjacent messages', async () => {
        const initialMessages = [
            { role: 'user', contents: [[{ type: 'text', content: 'M1' }]] },
            { role: 'assistant', contents: [[{ type: 'text', content: 'M2' }]] },
            { role: 'user', contents: [[{ type: 'text', content: 'M3' }]] }
        ];
        const { chatId } = await storage.createChatWithMessages('Regen Test', initialMessages);

        // Regenerate message 2 (index 1)
        await storage.updateMessage(chatId, 1, {
            role: 'assistant',
            contents: [[{ type: 'text', content: 'M2 V2' }]]
        });

        // Add 4th message
        await storage.addMessages(chatId, [{
            role: 'assistant',
            contents: [[{ type: 'text', content: 'M4' }]]
        }], 3);

        // Regenerate message 2 again
        await storage.updateMessage(chatId, 1, {
            role: 'assistant',
            contents: [[{ type: 'text', content: 'M2 V3' }]]
        });

        const loaded = await storage.loadChat(chatId);
        expect(loaded.messages.map(m => m.contents[0][0].content)).toEqual([
            'M1',
            'M2 V3',
            'M3',
            'M4'
        ]);
    });

    /**
     * Scenario 5: Arena mode partial responses
     * Arena mode with model A and B
     * Model A responds
     * Model B fails
     * Verify chat state is recoverable
     */
    test('arena mode partial response is saved correctly and allows recovery', async () => {
        // Initial state: user asks question
        const { chatId } = await storage.createChatWithMessages('Arena Partial', [
            { role: 'user', contents: [[{ type: 'text', content: 'Question' }]] }
        ]);

        // Model A responds, Model B hasn't responded yet (or failed)
        const partialArenaMessage = {
            role: 'assistant',
            responses: {
                model_a: { name: 'gpt-4', messages: [[{ type: 'text', content: 'Response A' }]] },
                // model_b is missing or empty
            }
        };

        await storage.addMessages(chatId, [partialArenaMessage], 1);

        const loaded = await storage.loadChat(chatId);
        expect(loaded.messages[1].responses.model_a.name).toBe('gpt-4');
        expect(loaded.messages[1].responses.model_b).toBeUndefined();

        // Simulate "recovery" by updating the message with Model B's response
        const recoveredArenaMessage = {
            role: 'assistant',
            responses: {
                model_a: { name: 'gpt-4', messages: [[{ type: 'text', content: 'Response A' }]] },
                model_b: { name: 'claude', messages: [[{ type: 'text', content: 'Response B' }]] }
            }
        };

        await storage.updateMessage(chatId, 1, recoveredArenaMessage);

        const reloaded = await storage.loadChat(chatId);
        expect(reloaded.messages[1].responses.model_a.content).toBe(recoveredArenaMessage.responses.model_a.content);
        expect(reloaded.messages[1].responses.model_b.name).toBe('claude');
    });

    /**
     * ADDITIONAL TEST: Hash collision / Shared blob deletion edge case
     * If two different images had the same hash (unlikely with SHA-256 but for logic verification)
     * OR if we add the same image twice to the same chat.
     */
    test('shared blobs in same chat are handled correctly during deletion', async () => {
        const imageData = 'data:image/png;base64,shared';
        
        // Chat with two messages using same image
        const { chatId } = await storage.createChatWithMessages('Shared Image Chat', [
            { role: 'user', contents: [[{ type: 'text', content: 'M1' }]], images: [imageData] },
            { role: 'user', contents: [[{ type: 'text', content: 'M2' }]], images: [imageData] }
        ]);

        const getBlob = async () => {
            const hash = await ChatStorage.computeHash(imageData);
            return storage.dbOp(['blobs'], 'readonly', tx => storage.req(tx.objectStore('blobs').get(hash)));
        };

        const blob = await getBlob();
        expect(blob.chatIds).toHaveLength(1); // Only contains the chatId once because it's a Set during persist
        expect(blob.chatIds).toContain(chatId);

        await storage.deleteChat(chatId);
        expect(await getBlob()).toBeUndefined();
    });
});
