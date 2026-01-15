import { describe, test, expect } from 'bun:test';
import { KimiProvider } from '../../src/js/LLMProviders.js';

describe('KimiProvider.formatMessages', () => {
  const provider = new KimiProvider();

  test('basic conversation', () => {
    const messages = [
      { role: 'system', parts: [{ type: 'text', content: 'Sys' }] },
      { role: 'user', parts: [{ type: 'text', content: 'Hi' }] }
    ];
    
    const formatted = provider.formatMessages(messages);
    expect(formatted).toHaveLength(2);
    expect(formatted[0].content).toBe('Sys');
    expect(formatted[1].content).toBe('Hi');
  });
});

describe('KimiProvider.createRequest', () => {
  const provider = new KimiProvider();
  const baseOptions = {
    model: 'kimi-k2-turbo-preview',
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
    
    expect(url).toBe('https://api.moonshot.ai/v1/chat/completions');
    expect(fetchOptions.headers['Authorization']).toBe('Bearer test-key');
    
    const body = JSON.parse(fetchOptions.body);
    expect(body.model).toBe('kimi-k2-turbo-preview');
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(body.temperature).toBe(0.7);
  });

  test('max tokens clamping', () => {
    const [_, fetchOptions] = provider.createRequest({
      ...baseOptions,
      settings: { max_tokens: 300000 }
    });
    
    const body = JSON.parse(fetchOptions.body);
    expect(body.max_tokens).toBe(262144); // MaxTokens.kimi
  });
});
