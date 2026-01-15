import { describe, test, expect } from 'bun:test';
import { OpenAIProvider } from '../../src/js/LLMProviders.js';

describe('OpenAIProvider.formatMessages', () => {
  const provider = new OpenAIProvider();

  test('basic conversation (no system message)', () => {
    const messages = [
      { role: 'system', parts: [{ type: 'text', content: 'You are a helpful assistant' }] },
      { role: 'user', parts: [{ type: 'text', content: 'Hello' }] },
      { role: 'assistant', parts: [{ type: 'text', content: 'Hi! How can I help?' }] }
    ];
    
    // formatMessages filters out system messages (they go to instructions in createRequest)
    const formatted = provider.formatMessages(messages, true);
    
    expect(formatted).toHaveLength(2);
    expect(formatted[0].role).toBe('user');
    expect(formatted[0].content[0].type).toBe('input_text');
    expect(formatted[0].content[0].text).toBe('Hello');
    
    expect(formatted[1].role).toBe('assistant');
    expect(formatted[1].content[0].type).toBe('output_text');
    expect(formatted[1].content[0].text).toBe('Hi! How can I help?');
  });

  test('multi-part messages and thought filtering', () => {
    const messages = [
      { role: 'user', parts: [
        { type: 'text', content: 'Tell me a secret.' },
        { type: 'thought', content: 'Thinking about secrets...' }
      ]}
    ];
    
    const formatted = provider.formatMessages(messages, true);
    
    expect(formatted[0].content).toHaveLength(1);
    expect(formatted[0].content[0].text).toBe('Tell me a secret.');
    expect(formatted[0].content[0].type).toBe('input_text');
  });

  test('with images', () => {
    const messages = [
      { role: 'user', parts: [{ type: 'text', content: 'What is this?' }], images: ['data:image/png;base64,iVBORw0KGgo='] }
    ];
    
    const formatted = provider.formatMessages(messages, true);
    
    expect(formatted[0].content).toHaveLength(2);
    expect(formatted[0].content[1].type).toBe('input_image');
    expect(formatted[0].content[1].image_url).toBe('data:image/png;base64,iVBORw0KGgo=');
  });

  test('empty messages', () => {
    const messages = [
      { role: 'user', parts: [] }
    ];
    const formatted = provider.formatMessages(messages, true);
    expect(formatted[0].content).toEqual([]);
  });
});

describe('OpenAIProvider.createRequest', () => {
  const provider = new OpenAIProvider();
  const baseOptions = {
    model: 'gpt-4.1',
    messages: [
      { role: 'system', parts: [{ type: 'text', content: 'You are helpful' }] },
      { role: 'user', parts: [{ type: 'text', content: 'Hello' }] }
    ],
    stream: true,
    apiKey: 'test-api-key',
    settings: { max_tokens: 4096, temperature: 0.7 },
    options: {}
  };

  test('default request structure', () => {
    const [url, fetchOptions] = provider.createRequest(baseOptions);
    
    expect(url).toBe('https://api.openai.com/v1/responses');
    expect(fetchOptions.headers['Authorization']).toBe('Bearer test-api-key');
    
    const body = JSON.parse(fetchOptions.body);
    expect(body.model).toBe('gpt-4.1');
    expect(body.stream).toBe(true);
    expect(body.instructions).toBe('You are helpful');
    expect(body.temperature).toBe(0.7);
    expect(body.max_output_tokens).toBe(4096);
  });

  test('with reasoning model', () => {
    const mockWriter = { addThinkingCounter: () => {} };
    const [url, fetchOptions] = provider.createRequest({
      ...baseOptions,
      model: 'o1-preview',
      options: { streamWriter: mockWriter }
    });
    
    const body = JSON.parse(fetchOptions.body);
    expect(body.reasoning).toEqual({ effort: 'medium' });
    expect(body.temperature).toBeUndefined();
    expect(body.max_output_tokens).toBe(4096);
  });

  test('with web_search enabled', () => {
    const [url, fetchOptions] = provider.createRequest({
      ...baseOptions,
      options: { webSearch: true }
    });
    
    const body = JSON.parse(fetchOptions.body);
    expect(body.tools).toEqual([{ type: "web_search_preview" }]);
  });

  test('max tokens clamping', () => {
    // Standard model
    const [_, opt1] = provider.createRequest({
      ...baseOptions,
      settings: { max_tokens: 20000 }
    });
    expect(JSON.parse(opt1.body).max_output_tokens).toBe(16384);

    // Reasoner model
    const [__, opt2] = provider.createRequest({
      ...baseOptions,
      model: 'o1-preview',
      settings: { max_tokens: 150000 }
    });
    expect(JSON.parse(opt2.body).max_output_tokens).toBe(100000);
  });
});
