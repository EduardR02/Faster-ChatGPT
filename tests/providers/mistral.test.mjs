import { describe, test, expect } from 'bun:test';
import { MistralProvider } from '../../src/js/LLMProviders.js';

describe('MistralProvider.formatMessages', () => {
  const provider = new MistralProvider();

  test('basic conversation', () => {
    const messages = [
      { role: 'user', parts: [{ type: 'text', content: 'Hello' }] }
    ];
    
    const formatted = provider.formatMessages(messages);
    expect(formatted[0].role).toBe('user');
    expect(formatted[0].content).toBe('Hello');
  });

  test('multi-part text extraction', () => {
    const messages = [
      { role: 'user', parts: [
        { type: 'text', content: 'A' },
        { type: 'text', content: 'B' }
      ]}
    ];
    
    const formatted = provider.formatMessages(messages);
    expect(formatted[0].content).toBe('A\nB');
  });
});

describe('MistralProvider.createRequest', () => {
  const provider = new MistralProvider();
  const baseOptions = {
    model: 'mistral-large-latest',
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
    
    expect(url).toBe('https://api.mistral.ai/v1/chat/completions');
    expect(fetchOptions.headers['Authorization']).toBe('Bearer test-key');
    
    const body = JSON.parse(fetchOptions.body);
    expect(body.model).toBe('mistral-large-latest');
    expect(body.stream).toBe(true);
    expect(body.temperature).toBe(0.7);
  });

  test('max tokens clamping', () => {
    const [_, fetchOptions] = provider.createRequest({
      ...baseOptions,
      settings: { max_tokens: 50000 }
    });
    
    const body = JSON.parse(fetchOptions.body);
    expect(body.max_tokens).toBe(32768); // MaxTokens.mistral
  });
});
