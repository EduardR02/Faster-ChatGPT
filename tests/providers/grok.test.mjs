import { describe, test, expect } from 'bun:test';
import { GrokProvider } from '../../src/js/LLMProviders.js';

describe('GrokProvider.formatMessages', () => {
  const provider = new GrokProvider();

  test('basic conversation (no images)', () => {
    const messages = [
      { role: 'user', parts: [{ type: 'text', content: 'Hello' }] }
    ];
    
    const formatted = provider.formatMessages(messages);
    expect(formatted[0].role).toBe('user');
    expect(formatted[0].content).toBe('Hello');
  });

  test('with images becomes content array', () => {
    const messages = [
      { role: 'user', parts: [{ type: 'text', content: 'What is this?' }], images: ['url1', 'url2'] }
    ];
    
    const formatted = provider.formatMessages(messages);
    
    expect(Array.isArray(formatted[0].content)).toBe(true);
    expect(formatted[0].content).toHaveLength(3); // text + 2 images
    expect(formatted[0].content[0]).toEqual({ type: 'text', text: 'What is this?' });
    expect(formatted[0].content[1]).toEqual({ type: 'image_url', image_url: { url: 'url1' } });
  });

  test('multi-part text content', () => {
    const messages = [
      { role: 'user', parts: [
        { type: 'text', content: 'Line 1' },
        { type: 'text', content: 'Line 2' }
      ]}
    ];
    
    const formatted = provider.formatMessages(messages);
    expect(formatted[0].content).toBe('Line 1\nLine 2');
  });
});

describe('GrokProvider.createRequest', () => {
  const provider = new GrokProvider();
  const baseOptions = {
    model: 'grok-2',
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
    
    expect(url).toBe('https://api.x.ai/v1/chat/completions');
    expect(fetchOptions.headers['Authorization']).toBe('Bearer test-key');
    
    const body = JSON.parse(fetchOptions.body);
    expect(body.model).toBe('grok-2');
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(body.temperature).toBe(0.7);
  });

  test('with grok-4 and web_search', () => {
    const [url, fetchOptions] = provider.createRequest({
      ...baseOptions,
      model: 'grok-4',
      options: { webSearch: true }
    });
    
    const body = JSON.parse(fetchOptions.body);
    expect(body.search_parameters).toEqual({ mode: "auto" });
  });

  test('max tokens clamping', () => {
    const [_, fetchOptions] = provider.createRequest({
      ...baseOptions,
      settings: { max_tokens: 200000 }
    });
    
    const body = JSON.parse(fetchOptions.body);
    expect(body.max_tokens).toBe(131072); // MaxTokens.grok
  });
});
