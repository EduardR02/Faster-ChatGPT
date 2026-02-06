import { describe, test } from 'bun:test';
import { createMockWriter, createMockTokenCounter, assertDeepEqual, assertThrows } from '../setup.mjs';
import { Providers } from '../../src/js/LLMProviders.js';

/**
 * Tests for provider response handling (handleResponse and handleStream).
 * Rewritten to use realistic SSE stream data and verify correct content extraction.
 */

describe('Provider Response Handling', () => {
  // --- OpenAI Tests ---
  // Verified against OpenAI Responses API documentation
  describe('OpenAI', () => {
    test('handleResponse extracts text and reasoning correctly', () => {
      const provider = Providers.openai;
      const tokenCounter = createMockTokenCounter();

      // Realistic OpenAI response format for new models
      const mockData = {
        output: [
          { type: 'reasoning', summary: 'Thinking about the answer...' },
          { type: 'message', content: [{ type: 'output_text', text: 'Hello!' }] }
        ],
        usage: { input_tokens: 10, output_tokens: 20 }
      };

      const result = provider.handleResponse({ data: mockData, tokenCounter });
      
      // Verify extracted content
      assertDeepEqual(result, [
        { type: 'thought', content: 'Thinking about the answer...' },
        { type: 'text', content: 'Hello!' }
      ]);
      
      // Verify usage tracking
      assertDeepEqual(tokenCounter.inputTokens, 10);
      assertDeepEqual(tokenCounter.outputTokens, 20);
    });

    test('handleStream processes deltas and usage', () => {
      const provider = Providers.openai;
      const writer = createMockWriter();
      const tokenCounter = createMockTokenCounter();

      // Stream of chunks as they would arrive from OpenAI's SSE
      const chunks = [
        { type: 'response.output_text.delta', delta: 'He' },
        { type: 'response.output_text.delta', delta: 'llo' },
        { 
          type: 'response.completed', 
          response: { usage: { input_tokens: 15, output_tokens: 10 } } 
        }
      ];

      for (const chunk of chunks) {
        provider.handleStream({ parsed: chunk, writer, tokenCounter });
      }

      // Verify final combined content in writer
      assertDeepEqual(writer.getFinalContent(), [
        { type: 'text', content: 'Hello' }
      ]);
      
      // Verify usage
      assertDeepEqual(tokenCounter.inputTokens, 15);
      assertDeepEqual(tokenCounter.outputTokens, 10);
    });

    test('handleStream processes reasoning summary deltas as thoughts', () => {
      const provider = Providers.openai;
      const writer = createMockWriter();
      const tokenCounter = createMockTokenCounter();

      const chunks = [
        { type: 'response.reasoning_summary_text.delta', delta: 'Thinking ' },
        { type: 'response.reasoning_summary_text.delta', delta: 'through options' },
        { type: 'response.reasoning_summary_text.done' },
        { type: 'response.output_text.delta', delta: 'Final answer' },
        {
          type: 'response.completed',
          response: { usage: { input_tokens: 21, output_tokens: 13 } }
        }
      ];

      for (const chunk of chunks) {
        provider.handleStream({ parsed: chunk, writer, tokenCounter });
      }

      assertDeepEqual(writer.getFinalContent(), [
        { type: 'thought', content: 'Thinking through options' },
        { type: 'text', content: 'Final answer' }
      ]);

      assertDeepEqual(tokenCounter.inputTokens, 21);
      assertDeepEqual(tokenCounter.outputTokens, 13);
    });

    test('handleResponse extracts reasoning summary text output items', () => {
      const provider = Providers.openai;
      const tokenCounter = createMockTokenCounter();

      const mockData = {
        output: [
          { type: 'reasoning_summary_text', text: 'Checked tradeoffs quickly.' },
          { type: 'message', content: [{ type: 'output_text', text: 'Ship it.' }] }
        ],
        usage: { input_tokens: 7, output_tokens: 4 }
      };

      const result = provider.handleResponse({ data: mockData, tokenCounter });

      assertDeepEqual(result, [
        { type: 'thought', content: 'Checked tradeoffs quickly.' },
        { type: 'text', content: 'Ship it.' }
      ]);
      assertDeepEqual(tokenCounter.inputTokens, 7);
      assertDeepEqual(tokenCounter.outputTokens, 4);
    });
  });

  // --- Anthropic Tests ---
  // Verified against Anthropic Messages API documentation
  describe('Anthropic', () => {
    test('handleResponse extracts thinking and text', () => {
      const provider = Providers.anthropic;
      const tokenCounter = createMockTokenCounter();

      const mockData = {
        content: [
          { type: 'thinking', thinking: 'Analyze request...' },
          { type: 'text', text: 'Confirmed.' }
        ],
        usage: { 
          input_tokens: 10, 
          output_tokens: 20, 
          cache_creation_input_tokens: 5,
          cache_read_input_tokens: 2
        }
      };

      const result = provider.handleResponse({ data: mockData, tokenCounter });
      
      assertDeepEqual(result, [
        { type: 'thought', content: 'Analyze request...' },
        { type: 'text', content: 'Confirmed.' }
      ]);
      
      // Anthropic input tokens = input + cache_creation + cache_read
      assertDeepEqual(tokenCounter.inputTokens, 10 + 5 + 2);
    });

    test('handleStream handles thinking, text, and redacted blocks', () => {
      const provider = Providers.anthropic;
      const writer = createMockWriter();
      const tokenCounter = createMockTokenCounter();

      const chunks = [
        // Usage comes at start in Anthropic
        { type: 'message_start', message: { usage: { input_tokens: 50, cache_read_input_tokens: 10 } } },
        // Thinking deltas
        { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'Thin' } },
        { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'king' } },
        // Text deltas
        { type: 'content_block_delta', delta: { type: 'text_delta', text: ' Re' } },
        { type: 'content_block_delta', delta: { type: 'text_delta', text: 'sult' } },
        // Redacted thinking block
        { type: 'content_block_start', content_block: { type: 'redacted_thinking' } },
        // Final usage
        { type: 'message_delta', usage: { output_tokens: 15 } }
      ];

      for (const chunk of chunks) {
        provider.handleStream({ parsed: chunk, writer, tokenCounter });
      }

      assertDeepEqual(writer.getFinalContent(), [
        { type: 'thought', content: 'Thinking' },
        { type: 'text', content: ' Result' },
        { type: 'thought', content: '\n\n```\n*redacted thinking*\n```\n\n' }
      ]);
      
      assertDeepEqual(tokenCounter.inputTokens, 60);
      assertDeepEqual(tokenCounter.outputTokens, 15);
    });
  });

  // --- Gemini Tests ---
  // Verified against Google Generative Language API (thought field for thinking mode)
  describe('Gemini', () => {
    test('handleResponse extracts thought and text parts', () => {
      const provider = Providers.gemini;
      const tokenCounter = createMockTokenCounter();

      const mockData = {
        candidates: [{
          content: {
            parts: [
              { text: 'I am thinking', thought: true },
              { text: 'I am answering' }
            ]
          }
        }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, thoughtsTokenCount: 3 }
      };

      const result = provider.handleResponse({ data: mockData, tokenCounter });
      assertDeepEqual(result, [
        { type: 'thought', content: 'I am thinking' },
        { type: 'text', content: 'I am answering' }
      ]);
      assertDeepEqual(tokenCounter.inputTokens, 10);
      assertDeepEqual(tokenCounter.outputTokens, 8); // 5 + 3
    });

    test('handleStream handles interleaved thought and text chunks', () => {
      const provider = Providers.gemini;
      const writer = createMockWriter();
      const tokenCounter = createMockTokenCounter();

      const chunks = [
        { candidates: [{ content: { parts: [{ text: 'Step 1', thought: true }] } }] },
        { candidates: [{ content: { parts: [{ text: 'Step 2', thought: true }] } }] },
        { candidates: [{ content: { parts: [{ text: 'Final Answer' }] } }], usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 10 } }
      ];

      for (const chunk of chunks) {
        provider.handleStream({ parsed: chunk, writer, tokenCounter });
      }

      assertDeepEqual(writer.getFinalContent(), [
        { type: 'thought', content: 'Step 1Step 2' },
        { type: 'text', content: 'Final Answer' }
      ]);
    });
  });

  // --- DeepSeek Tests ---
  // Verified against DeepSeek API documentation
  describe('DeepSeek', () => {
    test('handleStream processes reasoning and text deltas', () => {
      const provider = Providers.deepseek;
      const writer = createMockWriter();
      const tokenCounter = createMockTokenCounter();

      const chunks = [
        { choices: [{ delta: { reasoning_content: 'Let me ' } }] },
        { choices: [{ delta: { reasoning_content: 'think' } }] },
        { choices: [{ delta: { content: 'The ' } }] },
        { choices: [{ delta: { content: 'answer' } }] },
        { usage: { prompt_tokens: 5, completion_tokens: 10 }, choices: [{ delta: { content: '' } }] }
      ];

      for (const chunk of chunks) {
        provider.handleStream({ parsed: chunk, writer, tokenCounter });
      }

      assertDeepEqual(writer.getFinalContent(), [
        { type: 'thought', content: 'Let me think' },
        { type: 'text', content: 'The answer' }
      ]);
      assertDeepEqual(tokenCounter.inputTokens, 5);
      assertDeepEqual(tokenCounter.outputTokens, 10);
    });
  });

  // --- Grok Tests ---
  // UNVERIFIED - no official xAI documentation available
  describe('Grok', () => {
    test('handleStream processes reasoning and appends citations', () => {
      const provider = Providers.grok;
      const writer = createMockWriter();
      const tokenCounter = createMockTokenCounter();

      const chunks = [
        { choices: [{ delta: { reasoning_content: 'Searching...' } }] },
        { choices: [{ delta: { content: 'Found it.' } }] },
        { 
          usage: { prompt_tokens: 10, completion_tokens: 5 }, 
          citations: ['https://example.com/info'] 
        }
      ];

      for (const chunk of chunks) {
        provider.handleStream({ parsed: chunk, writer, tokenCounter });
      }

      assertDeepEqual(writer.getFinalContent(), [
        { type: 'thought', content: 'Searching...' },
        { type: 'text', content: 'Found it.\n\n[example.com](https://example.com/info)\n' }
      ]);
    });
  });

  // --- Mistral Tests ---
  // UNVERIFIED - nested thinking format not confirmed in official docs
  describe('Mistral', () => {
    test('handleStream handles complex array content deltas', () => {
      const provider = Providers.mistral;
      const writer = createMockWriter();
      const tokenCounter = createMockTokenCounter();

      const chunks = [
        { 
          choices: [{ 
            delta: { 
              content: [{ type: 'thinking', thinking: [{ text: 'Think' }, { text: 'ing' }] }] 
            } 
          }] 
        },
        { 
          choices: [{ 
            delta: { content: 'Done' } 
          }] 
        },
        { usage: { prompt_tokens: 10, completion_tokens: 5 } }
      ];

      for (const chunk of chunks) {
        provider.handleStream({ parsed: chunk, writer, tokenCounter });
      }

      assertDeepEqual(writer.getFinalContent(), [
        { type: 'thought', content: 'Thinking' },
        { type: 'text', content: 'Done' }
      ]);
      assertDeepEqual(tokenCounter.inputTokens, 10);
      assertDeepEqual(tokenCounter.outputTokens, 5);
    });
  });

  // --- Robustness Tests ---
  describe('Robustness and Error Handling', () => {
    test('handles malformed responses gracefully', () => {
      const tokenCounter = createMockTokenCounter();
      
      // Some providers throw on missing crucial fields, others return empty
      assertThrows(() => Providers.openai.handleResponse({ data: {}, tokenCounter }));
      
      const geminiResult = Providers.gemini.handleResponse({ data: {}, tokenCounter });
      // Current Gemini implementation returns empty array if candidates is missing
      assertDeepEqual(geminiResult, []);
      
      assertDeepEqual(Providers.anthropic.handleResponse({ data: {}, tokenCounter }), []);
    });

    test('handles API errors in stream', () => {
      const tokenCounter = createMockTokenCounter();
      const writer = createMockWriter();

      assertThrows(() => {
        Providers.anthropic.handleStream({
          parsed: { type: 'error', error: { message: 'Overloaded' } },
          writer,
          tokenCounter
        });
      }, 'Overloaded');
    });
    
    test('handles empty deltas', () => {
      const provider = Providers.openai;
      const writer = createMockWriter();
      const tokenCounter = createMockTokenCounter();

      provider.handleStream({
        parsed: { type: 'response.output_text.delta', delta: '' },
        writer,
        tokenCounter
      });

      // getFinalContent returns [{type: 'text', content: ''}] for empty single text part
      assertDeepEqual(writer.getFinalContent(), [{ type: 'text', content: '' }]);
    });
  });
});
