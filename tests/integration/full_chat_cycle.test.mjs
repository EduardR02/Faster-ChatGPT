import { describe, test, expect, beforeEach } from 'bun:test';
import 'fake-indexeddb/auto';
import { ChatStorage } from '../../src/js/chat_storage.js';

// Mock chrome.runtime
globalThis.chrome = {
  runtime: { sendMessage: () => Promise.resolve() }
};

describe('Full chat lifecycle', () => {
  let storage;
  
  beforeEach(() => {
    // Reset IndexedDB
    indexedDB = new IDBFactory();
    storage = new ChatStorage();
  });
  
  test('create -> add messages -> update -> load -> verify', async () => {
    // 1. Create chat with initial messages
    const result = await storage.createChatWithMessages('Test Chat', [
      { role: 'system', contents: [[{ type: 'text', content: 'You are helpful' }]] },
      { role: 'user', contents: [[{ type: 'text', content: 'Hello' }]] }
    ]);
    
    expect(result.chatId).toBeGreaterThan(0);
    expect(result.title).toBe('Test Chat');
    
    // 2. Add more messages
    await storage.addMessages(result.chatId, [
      { role: 'assistant', contents: [[{ type: 'text', content: 'Hi there!' }]] },
      { role: 'user', contents: [[{ type: 'text', content: 'How are you?' }]] }
    ], 2);
    
    // 3. Update assistant message with regeneration
    await storage.updateMessage(result.chatId, 2, {
      role: 'assistant',
      contents: [
        [{ type: 'text', content: 'Hi there!' }],
        [{ type: 'text', content: 'Hello! How can I help?' }]
      ]
    });
    
    // 4. Load and verify
    const loaded = await storage.loadChat(result.chatId);
    
    expect(loaded.messages).toHaveLength(4);
    expect(loaded.messages[0].role).toBe('system');
    expect(loaded.messages[1].role).toBe('user');
    expect(loaded.messages[2].role).toBe('assistant');
    expect(loaded.messages[2].contents).toHaveLength(2); // Has regeneration
    expect(loaded.messages[3].role).toBe('user');
  });
  
  test('chat with images preserves them through cycle', async () => {
    const imageData = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwIB/AL+X1EAAAAASUVORK5CYII=';
    
    const result = await storage.createChatWithMessages('Image Chat', [
      { role: 'user', contents: [[{ type: 'text', content: 'What is this?' }]], images: [imageData] },
      { role: 'assistant', contents: [[
        { type: 'text', content: 'This is a pixel' },
        { type: 'image', content: imageData }
      ]]}
    ]);
    
    const loaded = await storage.loadChat(result.chatId);
    
    expect(loaded.messages[0].images[0]).toBe(imageData);
    expect(loaded.messages[1].contents[0][1].content).toBe(imageData);
  });
  
  test('arena chat preserves structure', async () => {
    const result = await storage.createChatWithMessages('Arena Chat', [
      { role: 'user', contents: [[{ type: 'text', content: 'Compare these' }]] },
      {
        role: 'assistant',
        responses: {
          model_a: { name: 'gpt-4', messages: [[{ type: 'text', content: 'GPT response' }]] },
          model_b: { name: 'claude', messages: [[{ type: 'text', content: 'Claude response' }]] }
        },
        choice: 'model_a',
        continued_with: 'model_a'
      }
    ]);
    
    const loaded = await storage.loadChat(result.chatId);
    
    expect(loaded.messages[1].responses.model_a.name).toBe('gpt-4');
    expect(loaded.messages[1].responses.model_b.name).toBe('claude');
    expect(loaded.messages[1].choice).toBe('model_a');
  });
  
  test('delete chat removes all data', async () => {
    const result = await storage.createChatWithMessages('To Delete', [
      { role: 'user', contents: [[{ type: 'text', content: 'Hello' }]] }
    ]);
    
    await storage.deleteChat(result.chatId);
    
    const loaded = await storage.loadChat(result.chatId);
    expect(loaded).toBeNull();
  });
  
  test('rename chat updates title and search', async () => {
    const result = await storage.createChatWithMessages('Original Title', [
      { role: 'user', contents: [[{ type: 'text', content: 'Hello' }]] }
    ]);
    
    await storage.renameChat(result.chatId, 'New Title');
    
    const loaded = await storage.loadChat(result.chatId);
    expect(loaded.title).toBe('New Title');
  });
  
  test('getChatMetadata returns chats in reverse chronological order', async () => {
    await storage.createChatWithMessages('Chat 1', [
      { role: 'user', contents: [[{ type: 'text', content: 'First' }]] }
    ]);
    
    // Small delay to ensure different timestamps
    await new Promise(r => setTimeout(r, 10));
    
    await storage.createChatWithMessages('Chat 2', [
      { role: 'user', contents: [[{ type: 'text', content: 'Second' }]] }
    ]);
    
    const metadata = await storage.getChatMetadata(10, 0);
    
    expect(metadata).toHaveLength(2);
    expect(metadata[0].title).toBe('Chat 2'); // Most recent first
    expect(metadata[1].title).toBe('Chat 1');
  });
});
