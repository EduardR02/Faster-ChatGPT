import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { IDBFactory } from 'fake-indexeddb';
import 'fake-indexeddb/auto';
import { ChatStorage } from '../../src/js/chat_storage.js';

// Mock chrome.runtime for announce()
globalThis.chrome = {
  runtime: { sendMessage: () => Promise.resolve() }
};

describe('ChatStorage', () => {
  let storage;

  beforeEach(() => {
    // Reset IndexedDB
    indexedDB = new IDBFactory();
    storage = new ChatStorage();
    // Disable background migration for tests to avoid console warnings
    storage.runPendingMigration = () => Promise.resolve();
  });

  test('message round-trip preserves all content', async () => {
    const originalMessages = [
      { role: 'system', contents: [[{ type: 'text', content: 'You are helpful' }]] },
      { role: 'user', contents: [[{ type: 'text', content: 'Hello with émojis 🎉' }]] },
      { role: 'assistant', contents: [[{ type: 'text', content: 'Hi!' }, { type: 'thought', content: 'Thinking...' }]] }
    ];
    
    const result = await storage.createChatWithMessages('Test Chat', originalMessages);
    const loaded = await storage.loadChat(result.chatId);
    
    expect(loaded.title).toBe('Test Chat');
    expect(loaded.messages).toHaveLength(3);
    expect(loaded.messages[0].role).toBe('system');
    expect(loaded.messages[1].role).toBe('user');
    expect(loaded.messages[2].role).toBe('assistant');
    expect(loaded.messages[0].contents).toEqual(originalMessages[0].contents);
    expect(loaded.messages[1].contents).toEqual(originalMessages[1].contents);
    expect(loaded.messages[2].contents).toEqual(originalMessages[2].contents);
  });

  test('same image in two chats creates one blob', async () => {
    const imageData = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwIB/AL+X1EAAAAASUVORK5CYII=';
    
    const chat1 = await storage.createChatWithMessages('Chat 1', [
      { role: 'user', contents: [[{ type: 'text', content: 'A' }]], images: [imageData] }
    ]);
    const chat2 = await storage.createChatWithMessages('Chat 2', [
      { role: 'user', contents: [[{ type: 'text', content: 'B' }]], images: [imageData] }
    ]);
    
    const loaded1 = await storage.loadChat(chat1.chatId);
    const loaded2 = await storage.loadChat(chat2.chatId);
    
    expect(loaded1.messages[0].images[0]).toBe(imageData);
    expect(loaded2.messages[0].images[0]).toBe(imageData);

    // Verify DB state
    const db = await storage.getDB();
    const tx = db.transaction('blobs', 'readonly');
    const store = tx.objectStore('blobs');
    const allBlobs = await new Promise(resolve => {
        const req = store.getAll();
        req.onsuccess = () => resolve(req.result);
    });
    expect(allBlobs).toHaveLength(1);
    expect(allBlobs[0].chatIds).toContain(chat1.chatId);
    expect(allBlobs[0].chatIds).toContain(chat2.chatId);
  });

  test('deleting chat cleans up orphaned blobs', async () => {
    const imageData = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwIB/AL+X1EAAAAASUVORK5CYII=';
    
    const result = await storage.createChatWithMessages('Chat', [
      { role: 'user', contents: [[{ type: 'text', content: 'Hi' }]], images: [imageData] }
    ]);
    
    await storage.deleteChat(result.chatId);
    
    const loaded = await storage.loadChat(result.chatId);
    expect(loaded).toBeNull();

    // Verify blob is gone
    const db = await storage.getDB();
    const tx = db.transaction('blobs', 'readonly');
    const store = tx.objectStore('blobs');
    const count = await new Promise(resolve => {
        const req = store.count();
        req.onsuccess = () => resolve(req.result);
    });
    expect(count).toBe(0);
  });

  test('arena message round-trip', async () => {
    const arenaMessage = {
      role: 'assistant',
      responses: {
        model_a: { name: 'gpt-4', messages: [[{ type: 'text', content: 'Response A' }]] },
        model_b: { name: 'claude', messages: [[{ type: 'text', content: 'Response B' }]] }
      },
      choice: 'model_a',
      continued_with: 'model_a'
    };
    
    const result = await storage.createChatWithMessages('Arena Test', [
      { role: 'user', contents: [[{ type: 'text', content: 'Question' }]] },
      arenaMessage
    ]);
    
    const loaded = await storage.loadChat(result.chatId);
    expect(loaded.messages[1].responses.model_a.name).toBe('gpt-4');
    expect(loaded.messages[1].responses.model_b.name).toBe('claude');
    expect(loaded.messages[1].responses.model_a.messages[0][0].content).toBe('Response A');
    expect(loaded.messages[1].responses.model_b.messages[0][0].content).toBe('Response B');
    expect(loaded.messages[1].choice).toBe('model_a');
    expect(loaded.messages[1].continued_with).toBe('model_a');
  });

  test('updateMessage preserves other messages', async () => {
    const result = await storage.createChatWithMessages('Test', [
      { role: 'user', contents: [[{ type: 'text', content: 'Original' }]] },
      { role: 'assistant', contents: [[{ type: 'text', content: 'Response' }]] }
    ]);
    
    await storage.updateMessage(result.chatId, 1, {
      role: 'assistant',
      contents: [[{ type: 'text', content: 'Updated response' }]]
    });
    
    const loaded = await storage.loadChat(result.chatId);
    expect(loaded.messages[0].contents[0][0].content).toBe('Original');
    expect(loaded.messages[1].contents[0][0].content).toBe('Updated response');
  });

  test('council message round-trip', async () => {
    const councilMessage = {
      role: 'assistant',
      council: {
        collector_model: 'gpt-4o',
        collector_status: 'complete',
        responses: {
          'gpt-4o': { name: 'gpt-4o', messages: [[{ type: 'text', content: 'Council A' }]] },
          'claude-3-5-sonnet': { name: 'claude-3-5-sonnet', messages: [[{ type: 'text', content: 'Council B' }]] }
        },
        status: { 'gpt-4o': 'complete', 'claude-3-5-sonnet': 'complete' }
      },
      contents: [[{ type: 'text', content: 'Final Summary' }]]
    };
    
    const result = await storage.createChatWithMessages('Council Test', [
      { role: 'user', contents: [[{ type: 'text', content: 'Question' }]] },
      councilMessage
    ]);
    
    const loaded = await storage.loadChat(result.chatId);
    expect(loaded.messages[1].council.collector_model).toBe('gpt-4o');
    expect(loaded.messages[1].council.responses['gpt-4o'].messages[0][0].content).toBe('Council A');
    expect(loaded.messages[1].contents[0][0].content).toBe('Final Summary');
  });

  describe('ChatStorage static methods', () => {
    test('isDataUrl identifies data URLs', () => {
      expect(ChatStorage.isDataUrl('data:image/png;base64,abc')).toBe(true);
      expect(ChatStorage.isDataUrl('abc123hash')).toBe(false);
      expect(ChatStorage.isDataUrl(null)).toBe(false);
    });
    
    test('normaliseForSearch handles unicode', () => {
      expect(ChatStorage.normaliseForSearch('Café Résumé')).toBe('cafe resume');
      expect(ChatStorage.normaliseForSearch('  Multiple   Spaces  ')).toBe('multiple spaces');
    });
    
    test('extractTextFromMessages extracts all text types', () => {
      const messages = [
        { role: 'user', contents: [[{ type: 'text', content: 'Question' }]] },
        { role: 'assistant', contents: [[
          { type: 'thought', content: 'Thinking...' },
          { type: 'text', content: 'Answer' }
        ]]}
      ];
      
      const text = ChatStorage.extractTextFromMessages(messages);
      expect(text).toContain('Question');
      expect(text).toContain('Thinking...');
      expect(text).toContain('Answer');
    });
    
    test('extractTextFromMessages arena excludes thoughts', () => {
      const messages = [{
        role: 'assistant',
        responses: {
          model_a: { messages: [[{ type: 'thought', content: 'Thinking' }, { type: 'text', content: 'Answer A' }]] },
          model_b: { messages: [[{ type: 'text', content: 'Answer B' }]] }
        }
      }];
      
    const text = ChatStorage.extractTextFromMessages(messages);
    expect(text).toContain('Answer A');
    expect(text).toContain('Answer B');
    expect(text).not.toContain('Thinking');
  });

  test('loadChat handles empty chats', async () => {
    const result = await storage.createChatWithMessages('Empty', []);
    const loaded = await storage.loadChat(result.chatId);
    expect(loaded.messages).toEqual([]);
  });

  test('loadChat returns null for non-existent chat', async () => {
    const loaded = await storage.loadChat(999999);
    expect(loaded).toBeNull();
  });

  test('getChatMetadata respect limit and offset', async () => {
    // Create 5 chats
    for (let i = 1; i <= 5; i++) {
        await storage.createChatWithMessages(`Chat ${i}`, []);
    }

    const metadata = await storage.getChatMetadata(3, 1);
    expect(metadata).toHaveLength(3);
    // Ordered by timestamp desc, so 5, 4, 3, 2, 1
    // Offset 1 means skip 5, so 4, 3, 2
    expect(metadata[0].title).toBe('Chat 4');
    expect(metadata[1].title).toBe('Chat 3');
    expect(metadata[2].title).toBe('Chat 2');
  });

  test('dbOp aborts transaction on error', async () => {
    const db = await storage.getDB();
    const storeName = 'chatMeta';
    
    // Create a chat first
    const { chatId } = await storage.createChatWithMessages('Test', []);
    
    try {
      await storage.dbOp([storeName], 'readwrite', async (tx) => {
        const store = tx.objectStore(storeName);
        // Operation 1: Delete the chat
        store.delete(chatId);
        // Operation 2: Fail
        throw new Error('Forced failure');
      });
    } catch (e) {
      expect(e.message).toBe('Forced failure');
    }

    // Verify chat still exists because transaction should have been aborted
    const chat = await storage.loadChat(chatId);
    expect(chat).not.toBeNull();
    expect(chat.title).toBe('Test');
  });
});
});
