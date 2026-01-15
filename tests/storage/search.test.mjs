import { describe, test, expect } from 'bun:test';
import { ChatStorage } from '../../src/js/chat_storage.js';

describe('ChatStorage.normaliseForSearch', () => {
  test('lowercases text', () => {
    expect(ChatStorage.normaliseForSearch('HELLO World')).toBe('hello world');
  });
  
  test('strips accents via NFKD normalization', () => {
    expect(ChatStorage.normaliseForSearch('café résumé naïve')).toBe('cafe resume naive');
  });
  
  test('collapses multiple spaces', () => {
    expect(ChatStorage.normaliseForSearch('hello    world')).toBe('hello world');
  });
  
  test('trims whitespace', () => {
    expect(ChatStorage.normaliseForSearch('  hello  ')).toBe('hello');
  });
  
  test('handles empty/null input', () => {
    expect(ChatStorage.normaliseForSearch('')).toBe('');
    expect(ChatStorage.normaliseForSearch(null)).toBe('');
    expect(ChatStorage.normaliseForSearch(undefined)).toBe('');
  });
  
  test('handles unicode characters', () => {
    expect(ChatStorage.normaliseForSearch('日本語')).toBe('日本語'); // Non-latin preserved
    expect(ChatStorage.normaliseForSearch('Ñoño')).toBe('nono'); // Spanish ñ
  });
});

describe('ChatStorage.extractTextFromMessage', () => {
  test('extracts from standard message', () => {
    const message = {
      role: 'user',
      contents: [[{ type: 'text', content: 'Hello world' }]]
    };
    expect(ChatStorage.extractTextFromMessage(message)).toBe('Hello world');
  });
  
  test('extracts text AND thought from regular messages', () => {
    const message = {
      role: 'assistant',
      contents: [[
        { type: 'thought', content: 'Let me think...' },
        { type: 'text', content: 'Here is my answer' }
      ]]
    };
    const text = ChatStorage.extractTextFromMessage(message);
    expect(text).toBe('Let me think... Here is my answer');
  });
  
  test('ignores image type parts', () => {
    const message = {
      role: 'assistant',
      contents: [[
        { type: 'image', content: 'data:image/png;base64,...' },
        { type: 'text', content: 'Here is the image' }
      ]]
    };
    const text = ChatStorage.extractTextFromMessage(message);
    expect(text).not.toContain('data:image');
    expect(text).toContain('Here is the image');
  });
  
  test('handles multiple regenerations (contents array)', () => {
    const message = {
      role: 'assistant',
      contents: [
        [{ type: 'text', content: 'First response' }],
        [{ type: 'text', content: 'Second response' }]
      ]
    };
    const text = ChatStorage.extractTextFromMessage(message);
    expect(text).toBe('First response Second response');
  });
  
  test('extracts from arena message - text only, no thoughts', () => {
    const message = {
      role: 'assistant',
      responses: {
        model_a: { 
          name: 'gpt-4',
          messages: [[
            { type: 'thought', content: 'GPT thinking' },
            { type: 'text', content: 'GPT answer' }
          ]]
        },
        model_b: {
          name: 'claude',
          messages: [[{ type: 'text', content: 'Claude answer' }]]
        }
      }
    };
    const text = ChatStorage.extractTextFromMessage(message);
    expect(text).toBe('GPT answer Claude answer');
    expect(text).not.toContain('GPT thinking'); // Arena excludes thoughts
  });
  
  test('handles empty message', () => {
    expect(ChatStorage.extractTextFromMessage(null)).toBe('');
    expect(ChatStorage.extractTextFromMessage({})).toBe('');
    expect(ChatStorage.extractTextFromMessage({ contents: [] })).toBe('');
  });

  test('handles mixed message types and edge cases', () => {
    const message = {
      role: 'system',
      contents: [[{ type: 'text', content: 'System prompt' }]]
    };
    expect(ChatStorage.extractTextFromMessage(message)).toBe('System prompt');

    const imageOnly = {
      role: 'user',
      contents: [[{ type: 'image', content: 'data:...' }]]
    };
    expect(ChatStorage.extractTextFromMessage(imageOnly)).toBe('');

    const nestedArena = {
      responses: {
        model_a: {
          messages: [
            [{ type: 'text', content: 'Model A V1' }],
            [{ type: 'text', content: 'Model A V2' }]
          ]
        }
      }
    };
    expect(ChatStorage.extractTextFromMessage(nestedArena)).toContain('Model A V1');
    expect(ChatStorage.extractTextFromMessage(nestedArena)).toContain('Model A V2');
    const text = ChatStorage.extractTextFromMessage(nestedArena);
    expect(text).not.toContain('undefined');
    expect(text).not.toContain('null');
  });

  test('handles very long text content', () => {
    const longText = 'a'.repeat(10000);
    const message = {
      contents: [[{ type: 'text', content: longText }]]
    };
    expect(ChatStorage.extractTextFromMessage(message)).toBe(longText);
  });

  test('handles special characters and code blocks', () => {
    const code = '```javascript\nconsole.log("hello");\n```';
    const message = {
      contents: [[{ type: 'text', content: code }]]
    };
    expect(ChatStorage.extractTextFromMessage(message)).toBe(code);
  });
});

describe('ChatStorage.extractTextFromMessages', () => {
  test('combines text from multiple messages', () => {
    const messages = [
      { role: 'user', contents: [[{ type: 'text', content: 'Question' }]] },
      { role: 'assistant', contents: [[{ type: 'text', content: 'Answer' }]] }
    ];
    const text = ChatStorage.extractTextFromMessages(messages);
    expect(text).toBe('Question Answer');
  });
  
  test('handles empty array', () => {
    expect(ChatStorage.extractTextFromMessages([])).toBe('');
  });
  
  test('handles null/undefined', () => {
    expect(ChatStorage.extractTextFromMessages(null)).toBe('');
    expect(ChatStorage.extractTextFromMessages(undefined)).toBe('');
  });
  
  test('filters out empty content', () => {
    const messages = [
      { role: 'user', contents: [[{ type: 'text', content: '' }]] },
      { role: 'assistant', contents: [[{ type: 'text', content: 'Real content' }]] }
    ];
    const text = ChatStorage.extractTextFromMessages(messages);
    expect(text.trim()).toBe('Real content');
  });
});

// History.js tokenization tests
describe('ChatStorage.tokenizeForMiniSearch', () => {
  test('tokenizes simple text', () => {
    expect(ChatStorage.tokenizeForMiniSearch('Hello world')).toEqual(['hello', 'world']);
  });

  test('normalizes unicode', () => {
    expect(ChatStorage.tokenizeForMiniSearch('café')).toEqual(['cafe']);
  });

  test('removes punctuation from edges but keeps internal', () => {
    expect(ChatStorage.tokenizeForMiniSearch('hello, world! (test)')).toEqual(['hello', 'world', 'test']);
    expect(ChatStorage.tokenizeForMiniSearch('example.com/path')).toEqual(['example.com/path']);
    expect(ChatStorage.tokenizeForMiniSearch('#hashtag')).toEqual(['#hashtag']);
    expect(ChatStorage.tokenizeForMiniSearch('user@example.com')).toEqual(['user@example.com']);
  });

  test('handles multiple spaces and control characters', () => {
    expect(ChatStorage.tokenizeForMiniSearch('hello \n\t world')).toEqual(['hello', 'world']);
  });

  test('handles empty input', () => {
    expect(ChatStorage.tokenizeForMiniSearch('')).toEqual([]);
    expect(ChatStorage.tokenizeForMiniSearch(null)).toEqual([]);
  });

  test('preserves allowed internal characters', () => {
    expect(ChatStorage.tokenizeForMiniSearch('my-cool_variable')).toEqual(['my-cool_variable']);
    expect(ChatStorage.tokenizeForMiniSearch('v1.0.0')).toEqual(['v1.0.0']);
  });
});
