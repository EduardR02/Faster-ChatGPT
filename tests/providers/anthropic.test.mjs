import { describe, test, expect } from 'bun:test';
import { AnthropicProvider } from '../../src/js/LLMProviders.js';

describe('AnthropicProvider.formatMessages', () => {
  const provider = new AnthropicProvider();

  test('basic conversation and cache control', () => {
    const messages = [
      { role: 'system', parts: [{ type: 'text', content: 'System prompt' }] },
      { role: 'user', parts: [{ type: 'text', content: 'Hello' }] },
      { role: 'assistant', parts: [{ type: 'text', content: 'Hi there!' }] }
    ];
    
    const formatted = provider.formatMessages(messages);
    
    expect(formatted).toHaveLength(3);
    expect(formatted[0].role).toBe('system');
    expect(formatted[0].content[0].text).toBe('System prompt');
    
    // Last message's last content item gets cache_control
    expect(formatted[2].content.at(-1).cache_control).toEqual({ type: 'ephemeral' });
  });

  test('with images', () => {
    const messages = [
      { role: 'user', parts: [{ type: 'text', content: 'Look at this' }], images: ['data:image/png;base64,iVBORw0KGgo='] }
    ];
    
    const formatted = provider.formatMessages(messages);
    
    expect(formatted[0].content).toHaveLength(2);
    expect(formatted[0].content[1].type).toBe('image');
    expect(formatted[0].content[1].source.type).toBe('base64');
    expect(formatted[0].content[1].source.media_type).toBe('image/png');
    expect(formatted[0].content[1].source.data).toBe('iVBORw0KGgo=');
  });

  test('multi-part text and thought filtering', () => {
    const messages = [
      { role: 'user', parts: [
        { type: 'text', content: 'Part 1' },
        { type: 'thought', content: 'Secret thought' },
        { type: 'text', content: 'Part 2' }
      ]}
    ];
    
    const formatted = provider.formatMessages(messages);
    expect(formatted[0].content[0].text).toBe('Part 1\nPart 2');
  });
});

describe('AnthropicProvider.createRequest', () => {
  const provider = new AnthropicProvider();
  const baseOptions = {
    model: 'claude-3-7-sonnet',
    messages: [
      { role: 'system', parts: [{ type: 'text', content: 'You are helpful' }] },
      { role: 'user', parts: [{ type: 'text', content: 'Hello' }] }
    ],
    stream: true,
    apiKey: 'test-api-key',
    settings: { max_tokens: 8192, temperature: 0.7 },
    options: {}
  };

  test('default request structure', () => {
    const [url, fetchOptions] = provider.createRequest(baseOptions);
    
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(fetchOptions.headers['x-api-key']).toBe('test-api-key');
    expect(fetchOptions.headers['anthropic-version']).toBe('2023-06-01');
    expect(fetchOptions.headers['anthropic-dangerous-direct-browser-access']).toBe('true');
    
    const body = JSON.parse(fetchOptions.body);
    expect(body.model).toBe('claude-3-7-sonnet');
    expect(body.system).toEqual([{ type: 'text', text: 'You are helpful' }]);
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].role).toBe('user');
    expect(body.max_tokens).toBe(8192);
    expect(body.temperature).toBe(0.7);
  });

  test('with thinking enabled', () => {
    const mockWriter = { setThinkingModel: () => {} };
    const [url, fetchOptions] = provider.createRequest({
      ...baseOptions,
      options: { shouldThink: true, streamWriter: mockWriter }
    });
    
    const body = JSON.parse(fetchOptions.body);
    expect(body.thinking).toEqual({ 
      type: 'enabled', 
      budget_tokens: 4192 // 8192 - 4000
    });
    expect(body.temperature).toBeUndefined();
    expect(body.max_tokens).toBe(8192);
  });

  test('with web_search', () => {
    const [url, fetchOptions] = provider.createRequest({
      ...baseOptions,
      options: { webSearch: true }
    });
    
    const body = JSON.parse(fetchOptions.body);
    expect(body.tools).toHaveLength(1);
    expect(body.tools[0].type).toBe('web_search_20250305');
  });

  test('max tokens limits', () => {
    // Default model
    const [_, opt1] = provider.createRequest({
      ...baseOptions,
      model: 'claude-3-5-sonnet-latest',
      settings: { max_tokens: 100000 }
    });
    expect(JSON.parse(opt1.body).max_tokens).toBe(8192); // anthropic_old for non-thinking sonnet

    // Opus model
    const [__, opt2] = provider.createRequest({
      ...baseOptions,
      model: 'claude-3-opus-latest',
      settings: { max_tokens: 100000 }
    });
    expect(JSON.parse(opt2.body).max_tokens).toBe(32000);

    // Thinking enabled
    const mockWriter = { setThinkingModel: () => {} };
    const [___, opt3] = provider.createRequest({
      ...baseOptions,
      options: { shouldThink: true, streamWriter: mockWriter },
      settings: { max_tokens: 100000 }
    });
    expect(JSON.parse(opt3.body).max_tokens).toBe(64000);
  });

  test('empty messages crash fix', () => {
    const [url, fetchOptions] = provider.createRequest({
      ...baseOptions,
      messages: []
    });
    
    const body = JSON.parse(fetchOptions.body);
    expect(body.messages).toEqual([]);
    expect(body.system).toBeUndefined();
  });
});
