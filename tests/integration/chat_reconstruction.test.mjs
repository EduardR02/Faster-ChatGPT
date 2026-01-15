import { describe, test, expect, beforeAll } from 'bun:test';
import { SidepanelChatCore } from '../../src/js/chat_core.js';

beforeAll(() => {
  global.chrome = {
    storage: {
      local: {
        get: (keys, callback) => callback({})
      },
      onChanged: {
        addListener: () => {}
      }
    }
  };
});

describe('SidepanelChatCore.stripEphemeral', () => {
  test('removes thoughtSignature from regular message', () => {
    const message = {
      role: 'assistant',
      contents: [[
        { type: 'text', content: 'Hello', thoughtSignature: 'abc123' },
        { type: 'thought', content: 'Thinking', thoughtSignature: 'def456' }
      ]]
    };
    
    const stripped = SidepanelChatCore.stripEphemeral(message);
    
    expect(stripped.contents[0][0].thoughtSignature).toBeUndefined();
    expect(stripped.contents[0][1].thoughtSignature).toBeUndefined();
    expect(stripped.contents[0][0].content).toBe('Hello');
  });
  
  test('removes thoughtSignature from arena message', () => {
    const message = {
      role: 'assistant',
      responses: {
        model_a: {
          name: 'gpt-4',
          messages: [[{ type: 'text', content: 'A', thoughtSignature: 'sig1' }]]
        },
        model_b: {
          name: 'claude',
          messages: [[{ type: 'text', content: 'B', thoughtSignature: 'sig2' }]]
        }
      }
    };
    
    const stripped = SidepanelChatCore.stripEphemeral(message);
    
    expect(stripped.responses.model_a.messages[0][0].thoughtSignature).toBeUndefined();
    expect(stripped.responses.model_b.messages[0][0].thoughtSignature).toBeUndefined();
    expect(stripped.responses.model_a.messages[0][0].content).toBe('A');
  });
  
  test('handles null/undefined message', () => {
    expect(SidepanelChatCore.stripEphemeral(null)).toBeNull();
    expect(SidepanelChatCore.stripEphemeral(undefined)).toBeUndefined();
  });
  
  test('preserves other message properties', () => {
    const message = {
      role: 'assistant',
      contents: [[{ type: 'text', content: 'Hi' }]],
      someOtherProp: 'value'
    };
    
    const stripped = SidepanelChatCore.stripEphemeral(message);
    expect(stripped.someOtherProp).toBe('value');
  });
});

describe('buildFromDB message transformation', () => {
  const mockStorage = {
    createNewChatTracking: (title) => ({ title, messages: [] })
  };

  test('strips DB metadata from messages', () => {
    const core = new SidepanelChatCore(mockStorage, {}, {});
    const dbChat = {
      chatId: 1,
      title: 'Test',
      messages: [
        { chatId: 1, messageId: 0, timestamp: 123, role: 'user', contents: [[{type: 'text', content: 'Hi'}]] }
      ]
    };
    
    core.buildFromDB(dbChat);
    const result = core.getChat();
    
    expect(result.messages[0].messageId).toBeUndefined();
    expect(result.messages[0].chatId).toBeUndefined();
    expect(result.messages[0].timestamp).toBeUndefined();
    expect(result.messages[0].role).toBe('user');
    expect(result.messages[0].contents[0][0].content).toBe('Hi');
  });
  
  test('truncates to index', () => {
    const core = new SidepanelChatCore(mockStorage, {}, {});
    const dbChat = {
      chatId: 1,
      messages: [
        { messageId: 0, role: 'user', contents: [[{type: 'text', content: 'Q1'}]] },
        { messageId: 1, role: 'assistant', contents: [[{type: 'text', content: 'A1'}]] },
        { messageId: 2, role: 'user', contents: [[{type: 'text', content: 'Q2'}]] },
        { messageId: 3, role: 'assistant', contents: [[{type: 'text', content: 'A2'}]] }
      ]
    };
    
    core.buildFromDB(dbChat, 1);
    const result = core.getChat();
    
    expect(result.messages).toHaveLength(2);
    expect(result.messages[1].contents[0][0].content).toBe('A1');
  });
  
  test('truncates assistant regenerations to subIdx', () => {
    const core = new SidepanelChatCore(mockStorage, {}, {});
    const dbChat = {
      chatId: 1,
      messages: [
        { messageId: 0, role: 'user', contents: [[{type: 'text', content: 'Q'}]] },
        { messageId: 1, role: 'assistant', contents: [
          [{type: 'text', content: 'Regen 0'}],
          [{type: 'text', content: 'Regen 1'}],
          [{type: 'text', content: 'Regen 2'}]
        ]}
      ]
    };
    
    core.buildFromDB(dbChat, 1, 1);
    const result = core.getChat();
    
    expect(result.messages[1].contents).toHaveLength(2);
    expect(result.messages[1].contents[1][0].content).toBe('Regen 1');
  });
  
  test('truncates arena to specific model and subIdx', () => {
    const core = new SidepanelChatCore(mockStorage, {}, {});
    const dbChat = {
      chatId: 1,
      messages: [
        { messageId: 0, role: 'user', contents: [[{type: 'text', content: 'Q'}]] },
        { 
          messageId: 1, 
          role: 'assistant', 
          responses: {
            model_a: { name: 'gpt', messages: [
              [{type: 'text', content: 'A0'}],
              [{type: 'text', content: 'A1'}]
            ]},
            model_b: { name: 'claude', messages: [
              [{type: 'text', content: 'B0'}]
            ]}
          }
        }
      ]
    };
    
    core.buildFromDB(dbChat, 1, 0, 'model_a');
    const result = core.getChat();
    
    expect(result.messages[1].responses.model_a.messages).toHaveLength(1);
    expect(result.messages[1].continued_with).toBe('model_a');
  });
  
  test('pops user message when subIdx specified', () => {
    const core = new SidepanelChatCore(mockStorage, {}, {});
    const dbChat = {
      chatId: 1,
      messages: [
        { messageId: 0, role: 'user', contents: [[{type: 'text', content: 'Q1'}]] },
        { messageId: 1, role: 'assistant', contents: [[{type: 'text', content: 'A1'}]] },
        { messageId: 2, role: 'user', contents: [[{type: 'text', content: 'Q2'}]] }
      ]
    };
    
    core.buildFromDB(dbChat, 2, 0);
    const result = core.getChat();
    
    // User message at end with subIdx should be popped
    expect(result.messages).toHaveLength(2);
    expect(result.messages[1].role).toBe('assistant');
  });
});

describe('isUserMessageEqual', () => {
  const mockStorage = {
    createNewChatTracking: (title) => ({ title, messages: [] })
  };

  test('equal messages return true', () => {
    const core = new SidepanelChatCore(mockStorage, {}, {});
    const msg = { contents: [[{ content: 'Hello' }]] };
    expect(core.isUserMessageEqual(msg, msg)).toBe(true);
  });
  
  test('different content returns false', () => {
    const core = new SidepanelChatCore(mockStorage, {}, {});
    const a = { contents: [[{ content: 'Hello' }]] };
    const b = { contents: [[{ content: 'World' }]] };
    expect(core.isUserMessageEqual(a, b)).toBe(false);
  });
  
  test('different file count returns false', () => {
    const core = new SidepanelChatCore(mockStorage, {}, {});
    const a = { contents: [[{ content: 'Hi' }]], files: [{ name: 'a.txt', content: 'x' }] };
    const b = { contents: [[{ content: 'Hi' }]], files: [] };
    expect(core.isUserMessageEqual(a, b)).toBe(false);
  });
  
  test('different image count returns false', () => {
    const core = new SidepanelChatCore(mockStorage, {}, {});
    const a = { contents: [[{ content: 'Hi' }]], images: ['img1'] };
    const b = { contents: [[{ content: 'Hi' }]], images: ['img1', 'img2'] };
    expect(core.isUserMessageEqual(a, b)).toBe(false);
  });
  
  test('null messages return false', () => {
    const core = new SidepanelChatCore(mockStorage, {}, {});
    expect(core.isUserMessageEqual(null, { contents: [] })).toBe(false);
    expect(core.isUserMessageEqual({ contents: [] }, null)).toBe(false);
  });
});

describe('getMessagesForAPI simulation', () => {
  const mockStorage = {
    createNewChatTracking: (title) => ({ title, messages: [] })
  };

  test('converts user and assistant messages for API', () => {
    const core = new SidepanelChatCore(mockStorage, {}, {});
    core.getChat().messages = [
      { role: 'user', contents: [[{ type: 'text', content: 'Hello' }]] },
      { role: 'assistant', contents: [[{ type: 'text', content: 'Hi' }]] },
      { role: 'user', contents: [[{ type: 'text', content: 'How are you?' }]] }
    ];
    const apiMessages = core.getMessagesForAPI();
    
    expect(apiMessages).toHaveLength(3);
    expect(apiMessages[0]).toEqual({ role: 'user', parts: [{ type: 'text', content: 'Hello' }] });
    expect(apiMessages[1]).toEqual({ role: 'assistant', parts: [{ type: 'text', content: 'Hi' }] });
  });

  test('removes trailing assistant message', () => {
    const core = new SidepanelChatCore(mockStorage, {}, {});
    core.getChat().messages = [
      { role: 'user', contents: [[{ type: 'text', content: 'Hello' }]] },
      { role: 'assistant', contents: [[{ type: 'text', content: 'Hi' }]] }
    ];
    const apiMessages = core.getMessagesForAPI();
    
    expect(apiMessages).toHaveLength(1);
    expect(apiMessages[0].role).toBe('user');
  });

  test('handles arena messages with continued_with', () => {
    const core = new SidepanelChatCore(mockStorage, {}, {});
    core.getChat().messages = [
      { role: 'user', contents: [[{ type: 'text', content: 'Q' }]] },
      { 
        role: 'assistant', 
        continued_with: 'model_a',
        responses: {
          model_a: { messages: [[{ type: 'text', content: 'A' }]] },
          model_b: { messages: [[{ type: 'text', content: 'B' }]] }
        }
      },
      { role: 'user', contents: [[{ type: 'text', content: 'Next' }]] }
    ];
    const apiMessages = core.getMessagesForAPI();
    
    expect(apiMessages[1]).toEqual({ role: 'assistant', parts: [{ type: 'text', content: 'A' }] });
  });

  test('includes images and files in user messages', () => {
    const core = new SidepanelChatCore(mockStorage, {}, {});
    core.getChat().messages = [
      { 
        role: 'user', 
        contents: [[{ type: 'text', content: 'Look at this' }]],
        images: ['img_data'],
        files: [{ name: 'test.txt', content: 'data' }]
      }
    ];
    const apiMessages = core.getMessagesForAPI();
    
    expect(apiMessages[0].images).toEqual(['img_data']);
    expect(apiMessages[0].files).toEqual([{ name: 'test.txt', content: 'data' }]);
  });
});
