import { describe, test, expect } from 'bun:test';
import { LlamaCppProvider, GrokProvider } from '../../src/js/LLMProviders.js';

describe('LlamaCppProvider', () => {
  const provider = new LlamaCppProvider();

  test('uses GrokProvider formatting internally', () => {
    const messages = [
      { role: 'user', parts: [{ type: 'text', content: 'Hello' }], images: ['url1'] }
    ];
    
    // We can verify it matches GrokProvider output
    const grokFormatted = new GrokProvider().formatMessages(messages);
    
    // createRequest uses this internally
    const [url, options] = provider.createRequest({
        model: 'local-model',
        messages,
        settings: { temperature: 0.7 },
        options: { localModelOverride: { raw: 'my-model', port: 1234 } }
    });

    const body = JSON.parse(options.body);
    expect(body.messages).toEqual(grokFormatted);
    expect(url).toBe('http://localhost:1234/v1/chat/completions');
  });

  test('default port when no override provided', () => {
    const [url, options] = provider.createRequest({
        model: 'local-model',
        messages: [{ role: 'user', parts: [{ type: 'text', content: 'Hi' }] }],
        settings: { temperature: 0.7 },
        options: {}
    });

    expect(url).toBe('http://localhost:8080/v1/chat/completions');
    const body = JSON.parse(options.body);
    expect(body.model).toBe('local-model');
  });
});
