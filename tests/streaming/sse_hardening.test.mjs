import { describe, test, expect, beforeEach } from 'bun:test';
import { ApiManager } from '../../src/js/api_manager.js';
import { Providers } from '../../src/js/LLMProviders.js';
import { createChromeMock, createMockWriter, createMockTokenCounter } from '../setup.mjs';

const parseSSEChunk = ApiManager.parseSSEChunk;
const flushSSEBuffer = ApiManager.flushSSEBuffer;

// Feeds chunks through the incremental parser and flushes at end of stream,
// mirroring how handleStreamResponse drives the parser.
function parseStream(chunks) {
  const state = { buffer: '' };
  const events = [];
  for (const chunk of chunks) {
    events.push(...parseSSEChunk(state, chunk));
  }
  events.push(...flushSSEBuffer(state));
  return events;
}

function createStreamResponse(chunks) {
  const encoder = new TextEncoder();
  const encoded = chunks.map(chunk => typeof chunk === 'string' ? encoder.encode(chunk) : chunk);
  return {
    body: {
      getReader() {
        let index = 0;
        return {
          read: async () => index >= encoded.length
            ? { done: true, value: undefined }
            : { done: false, value: encoded[index++] }
        };
      }
    }
  };
}

describe('SSE hardening - parser', () => {
  test('flushes a final event that has no trailing newline', () => {
    const events = parseStream(['data: {"text":"a"}\n', 'data: {"text":"b"}']);
    expect(events).toEqual([{ text: 'a' }, { text: 'b' }]);
  });

  test('flush on empty state is a no-op', () => {
    const state = { buffer: '' };
    expect(flushSSEBuffer(state)).toEqual([]);
  });

  test('parses CRLF-framed events', () => {
    const events = parseStream(['data: {"a":1}\r\n\r\ndata: {"b":2}\r\n']);
    expect(events).toEqual([{ a: 1 }, { b: 2 }]);
  });

  test('handles a chunk boundary between CR and LF', () => {
    const events = parseStream(['data: {"a":1}\r', '\ndata: {"b":2}\r\n']);
    expect(events).toEqual([{ a: 1 }, { b: 2 }]);
  });

  test('handles stream ending after a bare CR', () => {
    const events = parseStream(['data: {"a":1}\r']);
    expect(events).toEqual([{ a: 1 }]);
  });

  test('accepts bare CR event framing', () => {
    const events = parseStream(['data: {"a":1}\r\rdata: {"b":2}\r']);
    expect(events).toEqual([{ a: 1 }, { b: 2 }]);
  });

  test('joins data fields split across multiple lines of one event', () => {
    const events = parseStream(['data: {"text":\ndata: "hello",\ndata: "n": 2}\n\n']);
    expect(events).toEqual([{ text: 'hello', n: 2 }]);
  });

  test('joins a multi-line event split across chunks', () => {
    const events = parseStream(['data: {"text":\n', 'data: "hello"}\n\n']);
    expect(events).toEqual([{ text: 'hello' }]);
  });

  test('does not mistake complete values inside pretty-printed JSON for separate events', () => {
    const events = parseStream(['data: [\n', 'data: 1,\n', 'data: 2\n', 'data: ]\n\n']);
    expect(events).toEqual([[1, 2]]);
  });

  test('recovers adjacent events after malformed object or array data', () => {
    for (const malformed of ['{bad}', '[bad]']) {
      const events = parseStream([
        `data: ${malformed}\n`,
        'data: {"choices":[{"delta":{"content":"Hi"}}]}\n',
        'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":1}}\n',
        'data: [DONE]\n'
      ]);

      expect(events).toEqual([
        { choices: [{ delta: { content: 'Hi' } }] },
        { choices: [], usage: { prompt_tokens: 3, completion_tokens: 1 } }
      ]);
    }
  });

  test('ignores comment and keepalive lines', () => {
    const events = parseStream([': keep-alive\n', ':\n', ':{"not":"data"}\n', 'data: {"a":1}\n']);
    expect(events).toEqual([{ a: 1 }]);
  });

  test('recognizes DONE framing variants without emitting events', () => {
    const variants = ['data: [DONE]\n', 'data:[DONE]\n', 'data:  [DONE]\n', 'data: [DONE] \n', 'data: [DONE]\r\n'];
    for (const done of variants) {
      const events = parseStream(['data: {"a":1}\n', done]);
      expect(events).toEqual([{ a: 1 }]);
    }
  });

  test('recognizes a DONE marker that has no trailing newline', () => {
    expect(parseStream(['data: [DONE]'])).toEqual([]);
  });

  test('accepts a data field without a space after the colon', () => {
    expect(parseStream(['data:{"a":1}\n'])).toEqual([{ a: 1 }]);
  });

  test('parses events fragmented across arbitrary chunk boundaries', () => {
    const payload = 'data: {"a":1}\n\ndata: {"b":2}\n\ndata: [DONE]\n';
    const chunks = payload.match(/.{1,3}/gs);
    expect(parseStream(chunks)).toEqual([{ a: 1 }, { b: 2 }]);
  });

  test('parses a normal OpenAI-style stream with blank lines and DONE', () => {
    const events = parseStream([
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\n',
      'data: [DONE]\n\n'
    ]);
    expect(events).toHaveLength(3);
    expect(events[2].usage).toEqual({ prompt_tokens: 3, completion_tokens: 2 });
  });

  test('parses an Anthropic-style stream with event lines and pings', () => {
    const events = parseStream([
      'event: message_start\ndata: {"type":"message_start"}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}\n\n',
      'event: ping\ndata: {"type":"ping"}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n'
    ]);
    expect(events.map(e => e.type)).toEqual(['message_start', 'content_block_delta', 'ping', 'message_stop']);
    expect(events[1].delta.text).toBe('Hi');
  });

  test('dispatches an event at a blank line and still flushes a later unterminated one', () => {
    const events = parseStream(['data: {"a":1}\n\ndata: {"b":2}']);
    expect(events).toEqual([{ a: 1 }, { b: 2 }]);
  });
});

describe('SSE hardening - stream termination', () => {
  let apiManager;
  let writer;
  let tokenCounter;

  beforeEach(async () => {
    globalThis.chrome = createChromeMock();
    await globalThis.chrome.storage.local.set({
      'api_keys': {},
      'models': {},
      'max_tokens': 1000,
      'temperature': 0.7
    });
    apiManager = new ApiManager();
    await new Promise(resolve => apiManager.settingsManager.runOnReady(resolve));
    writer = createMockWriter();
    tokenCounter = createMockTokenCounter();
  });

  test('processes a final event when the stream ends without a trailing newline', async () => {
    const response = createStreamResponse([
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"lo"}}]}' // no trailing newline, no [DONE]
    ]);

    await apiManager.handleStreamResponse(response, 'local-model', tokenCounter, writer);

    expect(writer._processedContent.map(entry => entry.content)).toEqual(['Hel', 'lo']);
  });

  test('counts token usage from a final unterminated usage event', async () => {
    const response = createStreamResponse([
      'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":7}}'
    ]);

    await apiManager.handleStreamResponse(response, 'local-model', tokenCounter, writer);

    expect(tokenCounter.inputTokens).toBe(11);
    expect(tokenCounter.outputTokens).toBe(7);
  });

  test('streams content and usage after malformed blankless data', async () => {
    const response = createStreamResponse([
      'data: {bad}\n',
      'data: {"choices":[{"delta":{"content":"Hi"}}]}\n',
      'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":1}}\n',
      'data: [DONE]\n'
    ]);

    await apiManager.handleStreamResponse(response, 'local-model', tokenCounter, writer);

    expect(writer._processedContent.map(entry => entry.content)).toEqual(['Hi']);
    expect(tokenCounter.inputTokens).toBe(3);
    expect(tokenCounter.outputTokens).toBe(1);
  });

  test('preserves final usage handling for every provider format', async () => {
    const cases = [
      {
        provider: 'openai',
        event: { type: 'response.completed', response: { usage: { input_tokens: 11, output_tokens: 7 } } },
        expected: [11, 7]
      },
      {
        provider: 'anthropic',
        event: {
          type: 'message_start',
          message: { usage: { input_tokens: 5, output_tokens: 3, cache_creation_input_tokens: 2, cache_read_input_tokens: 1 } }
        },
        expected: [8, 3]
      },
      {
        provider: 'gemini',
        event: { usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, thoughtsTokenCount: 1 } },
        expected: [5, 3]
      },
      {
        provider: 'deepseek',
        event: { choices: [{ delta: { content: '' } }], usage: { prompt_tokens: 6, completion_tokens: 4 } },
        expected: [6, 4]
      },
      {
        provider: 'grok',
        event: {
          choices: [],
          usage: { prompt_tokens: 7, completion_tokens: 4, completion_tokens_details: { reasoning_tokens: 2 } }
        },
        expected: [7, 6]
      },
      {
        provider: 'kimi',
        event: { choices: [], usage: { prompt_tokens: 8, completion_tokens: 5 } },
        expected: [8, 5]
      },
      {
        provider: 'mistral',
        event: { data: { usage: { prompt_tokens: 9, completion_tokens: 6 } } },
        expected: [9, 6]
      },
      {
        provider: 'llamacpp',
        event: { choices: [], usage: { prompt_tokens: 10, completion_tokens: 7 } },
        expected: [10, 7]
      }
    ];

    for (const { provider, event, expected } of cases) {
      const caseWriter = createMockWriter();
      const caseCounter = createMockTokenCounter();
      apiManager.getProvider = () => Providers[provider];

      await apiManager.handleStreamResponse(
        createStreamResponse([`data: ${JSON.stringify(event)}`]),
        'test-model',
        caseCounter,
        caseWriter
      );

      expect([caseCounter.inputTokens, caseCounter.outputTokens]).toEqual(expected);
    }
  });

  test('handles multi-byte UTF-8 characters split across byte chunks', async () => {
    const bytes = new TextEncoder().encode('data: {"choices":[{"delta":{"content":"héllo ✓"}}]}\n');
    const chunks = [];
    for (let i = 0; i < bytes.length; i += 7) {
      chunks.push(bytes.slice(i, i + 7));
    }

    await apiManager.handleStreamResponse(createStreamResponse(chunks), 'local-model', tokenCounter, writer);

    expect(writer._processedContent.map(entry => entry.content).join('')).toBe('héllo ✓');
  });

  test('processes a CRLF stream end to end', async () => {
    const response = createStreamResponse([
      'data: {"choices":[{"delta":{"content":"Hi"}}]}\r\n\r\n',
      'data: {"choices":[],"usage":{"prompt_tokens":2,"completion_tokens":1}}\r\n',
      'data: [DONE]\r\n'
    ]);

    await apiManager.handleStreamResponse(response, 'local-model', tokenCounter, writer);

    expect(writer._processedContent.map(entry => entry.content)).toEqual(['Hi']);
    expect(tokenCounter.inputTokens).toBe(2);
    expect(tokenCounter.outputTokens).toBe(1);
  });

  test('tolerates keepalive comments interleaved in the stream', async () => {
    const response = createStreamResponse([
      ': keep-alive\n\n',
      'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n',
      ': keep-alive\n\n',
      'data: [DONE]\n'
    ]);

    await apiManager.handleStreamResponse(response, 'local-model', tokenCounter, writer);

    expect(writer._processedContent.map(entry => entry.content)).toEqual(['Hi']);
  });
});
