import { describe, test } from 'bun:test';
import { createMockWriter, createMockTokenCounter, assertDeepEqual, assertThrows } from '../setup.mjs';
import { Providers } from '../../src/js/LLMProviders.js';

/**
 * Tests for provider response handling (handleResponse and handleStream).
 * All tests use mocked data and do not make network calls.
 */

describe('Provider Response Handling', () => {
  // --- OpenAI Tests ---
  describe('OpenAI', () => {
    test('handleResponse extracts text correctly', () => {
      const provider = Providers.openai;
      const tokenCounter = createMockTokenCounter();

      // Successful text response
      const mockData = {
        output: [
          { type: 'message', content: [{ type: 'output_text', text: 'Hello world' }] }
        ],
        usage: { input_tokens: 10, output_tokens: 5 }
      };

      const result = provider.handleResponse({ data: mockData, tokenCounter });
      assertDeepEqual(result, [{ type: 'text', content: 'Hello world' }]);
      assertDeepEqual(tokenCounter.inputTokens, 10);
      assertDeepEqual(tokenCounter.outputTokens, 5);

      // Reasoning response
      const reasoningData = {
        output: [
          { type: 'reasoning', summary: 'Thinking hard...' },
          { type: 'message', content: [{ type: 'output_text', text: 'Result' }] }
        ]
      };
      const reasoningResult = provider.handleResponse({ data: reasoningData, tokenCounter });
      assertDeepEqual(reasoningResult, [
        { type: 'thought', content: 'Thinking hard...' },
        { type: 'text', content: 'Result' }
      ]);
    });

    test('handleStream processes deltas', () => {
      const provider = Providers.openai;
      const writer = createMockWriter();
      const tokenCounter = createMockTokenCounter();

      // SSE chunk
      provider.handleStream({
        parsed: { type: 'response.output_text.delta', delta: 'Hello' },
        writer,
        tokenCounter
      });
      
      // Usage completion chunk
      provider.handleStream({
        parsed: { 
          type: 'response.completed', 
          response: { usage: { input_tokens: 15, output_tokens: 10 } } 
        },
        writer,
        tokenCounter
      });

      assertDeepEqual(writer._processedContent, [{ content: 'Hello', isThought: false }]);
      assertDeepEqual(tokenCounter.inputTokens, 15);
      assertDeepEqual(tokenCounter.outputTokens, 10);
    });
  });

  // --- Anthropic Tests ---
  describe('Anthropic', () => {
    test('handleResponse extracts thinking and text', () => {
      const provider = Providers.anthropic;
      const tokenCounter = createMockTokenCounter();

      const mockData = {
        content: [
          { type: 'thinking', thinking: 'I should say hello.' },
          { type: 'text', text: 'Hello!' }
        ],
        usage: { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 5 }
      };

      const result = provider.handleResponse({ data: mockData, tokenCounter });
      assertDeepEqual(result, [
        { type: 'thought', content: 'I should say hello.' },
        { type: 'text', content: 'Hello!' }
      ]);
      // input_tokens (10) + cache_creation (5) = 15
      assertDeepEqual(tokenCounter.inputTokens, 15);
    });

    test('handleStream processes thinking and text deltas', () => {
      const provider = Providers.anthropic;
      const writer = createMockWriter();
      const tokenCounter = createMockTokenCounter();

      // Thinking delta
      provider.handleStream({
        parsed: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'Thought' } },
        writer,
        tokenCounter
      });

      // Text delta
      provider.handleStream({
        parsed: { type: 'content_block_delta', delta: { type: 'text_delta', text: ' Text' } },
        writer,
        tokenCounter
      });

      // Message start (usage)
      provider.handleStream({
        parsed: { type: 'message_start', message: { usage: { input_tokens: 100 } } },
        writer,
        tokenCounter
      });

      assertDeepEqual(writer._processedContent, [
        { content: 'Thought', isThought: true },
        { content: ' Text', isThought: false }
      ]);
      assertDeepEqual(tokenCounter.inputTokens, 100);
    });
  });

  // --- Gemini Tests ---
  describe('Gemini', () => {
    test('handleResponse extracts thought and text', () => {
      const provider = Providers.gemini;
      const tokenCounter = createMockTokenCounter();

      const mockData = {
        candidates: [{
          content: {
            parts: [
              { text: 'Initial thought', thought: true },
              { text: 'Final answer' }
            ]
          }
        }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, thoughtsTokenCount: 5 }
      };

      const result = provider.handleResponse({ data: mockData, tokenCounter });
      assertDeepEqual(result, [
        { type: 'thought', content: 'Initial thought' },
        { type: 'text', content: 'Final answer' }
      ]);
      assertDeepEqual(tokenCounter.inputTokens, 10);
      assertDeepEqual(tokenCounter.outputTokens, 10); // 5 + 5
    });

    test('handleStream processes thought and text parts', () => {
      const provider = Providers.gemini;
      const writer = createMockWriter();
      const tokenCounter = createMockTokenCounter();

      provider.handleStream({
        parsed: {
          candidates: [{
            content: { parts: [{ text: 'Thinking...', thought: true }] }
          }]
        },
        writer,
        tokenCounter
      });

      provider.handleStream({
        parsed: {
          candidates: [{
            content: { parts: [{ text: 'Answer' }] }
          }],
          usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 10 }
        },
        writer,
        tokenCounter
      });

      assertDeepEqual(writer._processedContent, [
        { content: 'Thinking...', isThought: true },
        { content: 'Answer', isThought: false }
      ]);
      assertDeepEqual(tokenCounter.inputTokens, 20);
    });
  });

  // --- DeepSeek Tests ---
  describe('DeepSeek', () => {
    test('handleResponse extracts reasoning content', () => {
      const provider = Providers.deepseek;
      const tokenCounter = createMockTokenCounter();

      const mockData = {
        choices: [{
          message: {
            content: 'DeepSeek content',
            reasoning_content: 'DeepSeek thinking'
          }
        }],
        usage: { prompt_tokens: 50, completion_tokens: 30 }
      };

      const result = provider.handleResponse({ data: mockData, tokenCounter });
      assertDeepEqual(result, [
        { type: 'thought', content: 'DeepSeek thinking' },
        { type: 'text', content: 'DeepSeek content' }
      ]);
    });

    test('handleStream processes reasoning and text deltas', () => {
      const provider = Providers.deepseek;
      const writer = createMockWriter();
      const tokenCounter = createMockTokenCounter();

      provider.handleStream({
        parsed: { choices: [{ delta: { reasoning_content: 'thinking' } }] },
        writer,
        tokenCounter
      });

      provider.handleStream({
        parsed: { choices: [{ delta: { content: ' content' } }] },
        writer,
        tokenCounter
      });

      assertDeepEqual(writer._processedContent, [
        { content: 'thinking', isThought: true },
        { content: ' content', isThought: false }
      ]);
    });
  });

  // --- Grok Tests ---
  describe('Grok', () => {
    test('handleResponse extracts reasoning and appends citations', () => {
      const provider = Providers.grok;
      const tokenCounter = createMockTokenCounter();

      const mockData = {
        choices: [{
          message: { content: 'Grok content', reasoning_content: 'Grok reasoning' }
        }],
        citations: ['https://example.com/info'],
        usage: { prompt_tokens: 10, completion_tokens: 5 }
      };

      const result = provider.handleResponse({ data: mockData, tokenCounter });
      // Grok appends citations to content
      assertDeepEqual(result, [
        { type: 'thought', content: 'Grok reasoning' },
        { type: 'text', content: 'Grok content\n\n[example.com](https://example.com/info)\n' }
      ]);
    });

    test('handleStream processes content and citations', () => {
      const provider = Providers.grok;
      const writer = createMockWriter();
      const tokenCounter = createMockTokenCounter();

      provider.handleStream({
        parsed: { choices: [{ delta: { content: 'Grokking' } }] },
        writer,
        tokenCounter
      });

      provider.handleStream({
        parsed: {
          usage: { prompt_tokens: 10, completion_tokens: 5 },
          citations: ['https://source.com']
        },
        writer,
        tokenCounter
      });

      assertDeepEqual(writer._processedContent, [
        { content: 'Grokking', isThought: false },
        { content: '\n\n[source.com](https://source.com)\n', isThought: false }
      ]);
    });
  });

  // --- Kimi Tests ---
  describe('Kimi', () => {
    test('handleResponse extracts reasoning content', () => {
      const provider = Providers.kimi;
      const tokenCounter = createMockTokenCounter();

      const mockData = {
        choices: [{ message: { content: 'Kimi content', reasoning_content: 'Kimi thinking' } }],
        usage: { prompt_tokens: 100, completion_tokens: 50 }
      };

      const result = provider.handleResponse({ data: mockData, tokenCounter });
      assertDeepEqual(result, [
        { type: 'thought', content: 'Kimi thinking' },
        { type: 'text', content: 'Kimi content' }
      ]);
    });

    test('handleStream processes reasoning and text deltas', () => {
      const provider = Providers.kimi;
      const writer = createMockWriter();
      const tokenCounter = createMockTokenCounter();

      provider.handleStream({
        parsed: { choices: [{ delta: { reasoning_content: 'Hmm' } }] },
        writer,
        tokenCounter
      });

      provider.handleStream({
        parsed: { choices: [{ delta: { content: ' ok' } }] },
        writer,
        tokenCounter
      });

      assertDeepEqual(writer._processedContent, [
        { content: 'Hmm', isThought: true },
        { content: ' ok', isThought: false }
      ]);
    });
  });

  // --- Mistral Tests ---
  describe('Mistral', () => {
    test('handleResponse handles both string and array content', () => {
      const provider = Providers.mistral;
      const tokenCounter = createMockTokenCounter();

      // Simple string content
      const simpleData = {
        choices: [{ message: { content: 'Mistral simple' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 }
      };
      const result1 = provider.handleResponse({ data: simpleData, tokenCounter });
      assertDeepEqual(result1, [{ type: 'text', content: 'Mistral simple' }]);

      // Complex array content (new Mistral models)
      const complexData = {
        choices: [{
          message: {
            content: [
              { type: 'thinking', thinking: [{ text: 'Mistral thinking' }] },
              { type: 'text', text: 'Mistral final' }
            ]
          }
        }]
      };
      const result2 = provider.handleResponse({ data: complexData, tokenCounter });
      assertDeepEqual(result2, [
        { type: 'thought', content: 'Mistral thinking' },
        { type: 'text', content: 'Mistral final' }
      ]);
    });

    test('handleStream handles both string and array deltas', () => {
      const provider = Providers.mistral;
      const writer = createMockWriter();
      const tokenCounter = createMockTokenCounter();

      // String delta
      provider.handleStream({
        parsed: { choices: [{ delta: { content: 'Hello' } }] },
        writer,
        tokenCounter
      });

      // Array delta
      provider.handleStream({
        parsed: {
          choices: [{
            delta: {
              content: [{ type: 'thinking', thinking: [{ text: 'Thought' }] }]
            }
          }]
        },
        writer,
        tokenCounter
      });

      assertDeepEqual(writer._processedContent, [
        { content: 'Hello', isThought: false },
        { content: 'Thought', isThought: true }
      ]);
    });
  });

  // --- LlamaCpp Tests ---
  describe('LlamaCpp', () => {
    test('handleResponse extracts reasoning content', () => {
      const provider = Providers.llamacpp;
      const tokenCounter = createMockTokenCounter();

      const mockData = {
        choices: [{ message: { content: 'Local content', reasoning_content: 'Local reasoning' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 }
      };

      const result = provider.handleResponse({ data: mockData, tokenCounter });
      assertDeepEqual(result, [
        { type: 'thought', content: 'Local reasoning' },
        { type: 'text', content: 'Local content' }
      ]);
    });

    test('handleStream processes reasoning and text deltas', () => {
      const provider = Providers.llamacpp;
      const writer = createMockWriter();
      const tokenCounter = createMockTokenCounter();

      provider.handleStream({
        parsed: { choices: [{ delta: { reasoning_content: 'local think' } }] },
        writer,
        tokenCounter
      });

      provider.handleStream({
        parsed: { choices: [{ delta: { content: 'local text' } }] },
        writer,
        tokenCounter
      });

      assertDeepEqual(writer._processedContent, [
        { content: 'local think', isThought: true },
        { content: 'local text', isThought: false }
      ]);
    });
  });

  // --- Robustness Tests ---
  describe('Robustness and Error Handling', () => {
    test('handles malformed responses gracefully', () => {
      const tokenCounter = createMockTokenCounter();
      
      // OpenAI missing output - current impl might throw or return empty
      assertThrows(() => Providers.openai.handleResponse({ data: {}, tokenCounter }));
      
      // Gemini missing candidates
      assertDeepEqual(Providers.gemini.handleResponse({ data: {}, tokenCounter }), []);

      // Anthropic missing content
      assertDeepEqual(Providers.anthropic.handleResponse({ data: {}, tokenCounter }), []);

      // Mistral empty content
      assertDeepEqual(Providers.mistral.handleResponse({ data: { choices: [{ message: {} }] }, tokenCounter }), []);
    });

    test('handles API errors in stream and empty outputs', () => {
      const tokenCounter = createMockTokenCounter();
      const writer = createMockWriter();

      // Anthropic API error in stream
      assertThrows(() => {
        Providers.anthropic.handleStream({
          parsed: { type: 'error', error: { message: 'Rate limit exceeded' } },
          writer,
          tokenCounter
        });
      }, 'Rate limit exceeded');

      // OpenAI missing fields often just return empty string rather than crashing in current impl
      const result = Providers.openai.handleResponse({ 
        data: { output: [] }, 
        tokenCounter 
      });
      assertDeepEqual(result, []);
    });
  });
});
