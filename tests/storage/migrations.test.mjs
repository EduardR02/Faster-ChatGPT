import { describe, test, expect } from 'bun:test';
import { Migrations } from '../../src/js/migrations.js';

describe('Migrations.transformMessages', () => {
  test('v1/v2 string content to v3 contents array', () => {
    const v1Messages = [
      { chatId: 1, role: 'user', content: 'Hello' },
      { chatId: 1, role: 'assistant', content: 'Hi there', model: 'gpt-4' }
    ];
    
    const transformed = Migrations.transformMessages(v1Messages);
    
    expect(transformed[0].contents).toEqual([[{ type: 'text', content: 'Hello' }]]);
    expect(transformed[1].contents[0][0].content).toBe('Hi there');
    expect(transformed[1].contents[0][0].model).toBe('gpt-4');
  });
  
  test('assistant regenerations are grouped', () => {
    const v1Messages = [
      { chatId: 1, role: 'user', content: 'Hello' },
      { chatId: 1, role: 'assistant', content: 'Response 1', model: 'gpt-4' },
      { chatId: 1, role: 'assistant', content: 'Response 2', model: 'gpt-4' },
      { chatId: 1, role: 'assistant', content: 'Response 3', model: 'claude' }
    ];
    
    const transformed = Migrations.transformMessages(v1Messages);
    
    expect(transformed).toHaveLength(2); // user + grouped assistant
    expect(transformed[1].contents).toHaveLength(3);
    expect(transformed[1].contents[0][0].content).toBe('Response 1');
    expect(transformed[1].contents[1][0].content).toBe('Response 2');
    expect(transformed[1].contents[2][0].content).toBe('Response 3');
  });
  
  test('arena message transformation', () => {
    const v2Arena = {
      chatId: 1,
      role: 'assistant',
      responses: {
        model_a: { name: 'gpt-4', messages: ['Response A1', 'Response A2'] },
        model_b: { name: 'claude', messages: ['Response B'] }
      },
      choice: 'model_a',
      continued_with: 'model_a',
      timestamp: 12345
    };
    
    const transformed = Migrations.transformArenaMessage(v2Arena);
    
    expect(transformed.responses.model_a.messages).toEqual([
      [{ type: 'text', content: 'Response A1' }],
      [{ type: 'text', content: 'Response A2' }]
    ]);
    expect(transformed.choice).toBe('model_a');
  });
  
  test('preserves images and files', () => {
    const v1Message = {
      chatId: 1,
      role: 'user',
      content: 'Check this',
      images: ['data:image/png;base64,abc'],
      files: [{ name: 'test.txt', content: 'hello' }]
    };
    
    const transformed = Migrations.transformNormalMessage(v1Message);
    
    expect(transformed.images).toEqual(['data:image/png;base64,abc']);
    expect(transformed.files).toEqual([{ name: 'test.txt', content: 'hello' }]);
  });

  test('empty array returns empty array', () => {
    expect(Migrations.transformMessages([])).toEqual([]);
  });

  test('unicode and special characters', () => {
    const messages = [
        { role: 'user', content: 'Hello 🎉 éàç' }
    ];
    const transformed = Migrations.transformMessages(messages);
    expect(transformed[0].contents[0][0].content).toBe('Hello 🎉 éàç');
  });
});
