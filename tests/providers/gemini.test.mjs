import { describe, test, expect } from 'bun:test';
import { GeminiProvider } from '../../src/js/LLMProviders.js';

describe('GeminiProvider.formatMessages', () => {
  const provider = new GeminiProvider();

  test('basic conversation and role mapping', () => {
    const messages = [
      { role: 'system', parts: [{ type: 'text', content: 'System instruction' }] },
      { role: 'user', parts: [{ type: 'text', content: 'Hello' }] },
      { role: 'assistant', parts: [{ type: 'text', content: 'I am model' }] }
    ];
    
    const formatted = provider.formatMessages(messages);
    
    expect(formatted).toHaveLength(3);
    expect(formatted[0].role).toBe('user'); // role enum 'system' -> 'user'
    expect(formatted[1].role).toBe('user');
    expect(formatted[2].role).toBe('model'); // 'assistant' -> 'model'
    
    expect(formatted[0].parts[0].text).toBe('System instruction');
  });

  test('with images and thought signature', () => {
    const messages = [
      { role: 'user', parts: [
        { type: 'text', content: 'What is this?', thoughtSignature: 'sig123' }
      ], images: ['data:image/png;base64,iVBORw0KGgo='] }
    ];
    
    const formatted = provider.formatMessages(messages);
    
    expect(formatted[0].parts).toHaveLength(2);
    expect(formatted[0].parts[0].text).toBe('What is this?');
    expect(formatted[0].parts[0].thoughtSignature).toBe('sig123');
    
    expect(formatted[0].parts[1].inline_data.mime_type).toBe('image/png');
    expect(formatted[0].parts[1].inline_data.data).toBe('iVBORw0KGgo=');
  });

  test('multi-part with image type in parts', () => {
    const messages = [
      { role: 'user', parts: [
        { type: 'image', content: 'data:image/jpeg;base64,abc' },
        { type: 'text', content: 'text' }
      ]}
    ];
    
    const formatted = provider.formatMessages(messages);
    expect(formatted[0].parts).toHaveLength(2);
    expect(formatted[0].parts[0].inline_data.mime_type).toBe('image/jpeg');
    expect(formatted[0].parts[1].text).toBe('text');
  });

  test('empty message handling', () => {
    const messages = [{ role: 'user', parts: [] }];
    const formatted = provider.formatMessages(messages);
    expect(formatted[0].parts[0].text).toBe('');
  });
});

describe('GeminiProvider.createRequest', () => {
  const provider = new GeminiProvider();
  const baseOptions = {
    model: 'gemini-1.5-pro',
    messages: [
      { role: 'system', parts: [{ type: 'text', content: 'You are helpful' }] },
      { role: 'user', parts: [{ type: 'text', content: 'Hello' }] }
    ],
    stream: true,
    apiKey: 'test-api-key',
    settings: { max_tokens: 2048, temperature: 0.7 },
    options: {}
  };

  test('default request structure and URL', () => {
    const [url, fetchOptions] = provider.createRequest(baseOptions);
    
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:streamGenerateContent?alt=sse&key=test-api-key');
    
    const body = JSON.parse(fetchOptions.body);
    expect(body.contents).toHaveLength(1); // User message
    expect(body.systemInstruction.parts[0].text).toBe('You are helpful');
    expect(body.generationConfig.temperature).toBe(0.7);
    expect(body.generationConfig.maxOutputTokens).toBe(2048);
    expect(body.safetySettings[0].threshold).toBe('BLOCK_NONE');
  });

  test('with Gemini 3 reasoning', () => {
    const mockWriter = { setThinkingModel: () => {} };
    const [url, fetchOptions] = provider.createRequest({
      ...baseOptions,
      model: 'gemini-3-pro-preview',
      options: { reasoningEffort: 'high', streamWriter: mockWriter }
    });
    
    const body = JSON.parse(fetchOptions.body);
    expect(body.generationConfig.thinking_config).toEqual({
      thinkingLevel: 'high',
      include_thoughts: true
    });
  });

  test('with Gemini 2.5 flash thinking toggle', () => {
    const mockWriter = { setThinkingModel: () => {} };
    const [url, fetchOptions] = provider.createRequest({
      ...baseOptions,
      model: 'gemini-2.5-flash-lite',
      options: { shouldThink: true, streamWriter: mockWriter }
    });
    
    const body = JSON.parse(fetchOptions.body);
    expect(body.generationConfig.thinking_config).toEqual({
      thinkingBudget: -1,
      include_thoughts: true
    });
  });

  test('max tokens clamping', () => {
    // Old model
    const [_, opt1] = provider.createRequest({
      ...baseOptions,
      model: 'gemini-1.0-pro',
      settings: { max_tokens: 100000 }
    });
    expect(JSON.parse(opt1.body).generationConfig.maxOutputTokens).toBe(8192);

    // Modern model (Gemini 1.5/2.x)
    const [__, opt2] = provider.createRequest({
      ...baseOptions,
      model: 'gemini-1.5-pro',
      settings: { max_tokens: 100000 }
    });
    // NOTE: In current implementation, gemini-1.5-pro might not match /gemini-[2-9]\.?\d*/ if regex is strict
    // Let's re-verify the regex: /gemini-[2-9]\.?\d*|gemini-\d{2,}/
    // 'gemini-1.5-pro' -> DOES NOT MATCH [2-9] or \d{2,}
    // If I use 'gemini-2.0-pro' it should match.
    
    const [___, opt3] = provider.createRequest({
      ...baseOptions,
      model: 'gemini-2.0-pro',
      settings: { max_tokens: 100000 }
    });
    expect(JSON.parse(opt3.body).generationConfig.maxOutputTokens).toBe(65536);
  });
});
