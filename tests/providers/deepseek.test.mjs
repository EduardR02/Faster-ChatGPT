import { describe, test, expect } from 'bun:test';
import { DeepSeekProvider } from '../../src/js/LLMProviders.js';

describe('DeepSeekProvider.formatMessages', () => {
  const provider = new DeepSeekProvider();

  test('basic conversation', () => {
    const messages = [
      { role: 'system', parts: [{ type: 'text', content: 'Sys' }] },
      { role: 'user', parts: [{ type: 'text', content: 'Hi' }] }
    ];
    
    const formatted = provider.formatMessages(messages);
    
    expect(formatted).toHaveLength(2);
    expect(formatted[0].role).toBe('system');
    expect(formatted[0].content).toBe('Sys');
    expect(formatted[1].role).toBe('user');
    expect(formatted[1].content).toBe('Hi');
  });

  test('extracts text content correctly', () => {
    const messages = [
      { role: 'user', parts: [
        { type: 'text', content: 'Part 1' },
        { type: 'thought', content: 'Ignoring thought' },
        { type: 'text', content: 'Part 2' }
      ]}
    ];
    
    const formatted = provider.formatMessages(messages);
    expect(formatted[0].content).toBe('Part 1\nPart 2');
  });
});

describe('DeepSeekProvider.createRequest', () => {
  const provider = new DeepSeekProvider();
  const baseOptions = {
    model: 'deepseek-chat',
    messages: [
      { role: 'user', parts: [{ type: 'text', content: 'Hello' }] }
    ],
    stream: true,
    apiKey: 'test-key',
    settings: { max_tokens: 4096, temperature: 0.7 },
    options: {}
  };

  test('default request structure', () => {
    const [url, fetchOptions] = provider.createRequest(baseOptions);
    
    expect(url).toBe('https://api.deepseek.com/v1/chat/completions');
    expect(fetchOptions.headers['Authorization']).toBe('Bearer test-key');
    
    const body = JSON.parse(fetchOptions.body);
    expect(body.model).toBe('deepseek-chat');
    expect(body.temperature).toBe(0.7);
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
  });

  test('with reasoner model', () => {
    const mockWriter = { setThinkingModel: () => {} };
    const [url, fetchOptions] = provider.createRequest({
      ...baseOptions,
      model: 'deepseek-reasoner',
      options: { streamWriter: mockWriter }
    });
    
    const body = JSON.parse(fetchOptions.body);
    expect(body.temperature).toBeUndefined(); // No temperature for reasoner
  });

  test('max tokens clamping', () => {
    const [_, fetchOptions] = provider.createRequest({
      ...baseOptions,
      settings: { max_tokens: 100000 }
    });
    
    const body = JSON.parse(fetchOptions.body);
    expect(body.max_tokens).toBe(8000); // MaxTokens.deepseek
  });
});
