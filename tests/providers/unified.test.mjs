import { describe, test, expect, mock } from 'bun:test';
import { Providers, RoleEnum } from '../../src/js/LLMProviders.js';

// Helper to create a standard conversation
const createConversation = () => [
    { role: RoleEnum.system, parts: [{ type: 'text', content: 'You are helpful' }] },
    { role: RoleEnum.user, parts: [{ type: 'text', content: 'Hello' }] },
    { role: RoleEnum.assistant, parts: [{ type: 'text', content: 'Hi!' }] },
    { role: RoleEnum.user, parts: [{ type: 'text', content: 'How are you?' }] }
];

describe('OpenAIProvider - Meaningful Tests', () => {
    const provider = Providers.openai;
    const model = 'gpt-5.2';

    test('message context building - exact structure', () => {
        const conversation = createConversation();
        const formatted = provider.formatMessages(conversation, false);
        
        // OpenAI formatMessages filters out system and returns role/content blocks
        expect(formatted).toHaveLength(3);
        expect(formatted[0]).toEqual({
            role: 'user',
            content: [{ type: 'input_text', text: 'Hello' }]
        });
        expect(formatted[1]).toEqual({
            role: 'assistant',
            content: [{ type: 'output_text', text: 'Hi!' }]
        });
        
        // Verify system prompt placement in createRequest
        const [_, options] = provider.createRequest({
            model,
            messages: conversation,
            stream: true,
            options: {},
            apiKey: 'key',
            settings: { temperature: 0.7, max_tokens: 1000 }
        });
        const body = JSON.parse(options.body);
        expect(body.instructions).toBe('You are helpful');
        expect(body.input).toEqual(formatted);
    });

    test('image handling - exact structure', () => {
        const messages = [
            { 
                role: RoleEnum.user, 
                parts: [{ type: 'text', content: 'What is this?' }],
                images: ['https://example.com/img.png']
            }
        ];
        const formatted = provider.formatMessages(messages, true);
        expect(formatted[0].content).toContainEqual({
            type: 'input_image',
            image_url: 'https://example.com/img.png'
        });
    });

    test('stream reconstruction and token counting', () => {
        const collected = [];
        const writer = { processContent: (c) => collected.push(c) };
        const tokenCounter = { update: mock() };
        
        const chunks = [
            { type: 'response.output_text.delta', delta: 'Hel' },
            { type: 'response.output_text.delta', delta: 'lo' },
            { type: 'response.completed', response: { usage: { input_tokens: 10, output_tokens: 5 } } }
        ];

        for (const chunk of chunks) {
            provider.handleStream({ parsed: chunk, writer, tokenCounter });
        }

        expect(collected.join('')).toBe('Hello');
        expect(tokenCounter.update).toHaveBeenCalledWith(10, 5);
    });

    test('thought extraction from response', () => {
        const data = {
            output: [
                { type: 'reasoning', summary: 'Thinking about hello' },
                { type: 'message', content: [{ type: 'output_text', text: 'Hello!' }] }
            ]
        };
        const tokenCounter = { update: () => {} };
        const result = provider.handleResponse({ data, tokenCounter });
        
        expect(result).toEqual([
            { type: 'thought', content: 'Thinking about hello' },
            { type: 'text', content: 'Hello!' }
        ]);
    });
});

describe('AnthropicProvider - Meaningful Tests', () => {
    const provider = Providers.anthropic;
    const model = 'claude-3-7-sonnet';

    test('message context building - system and cache control', () => {
        const conversation = createConversation();
        const formatted = provider.formatMessages(conversation);
        
        // Anthropic formatMessages includes system in formatted but createRequest slices it
        expect(formatted).toHaveLength(4);
        expect(formatted[0].role).toBe('system');
        
        // Verify cache control on the last message
        expect(formatted[3].content.at(-1).cache_control).toEqual({ type: 'ephemeral' });

        const [_, options] = provider.createRequest({
            model,
            messages: conversation,
            stream: true,
            options: {},
            apiKey: 'key',
            settings: { temperature: 0.7, max_tokens: 1000 }
        });
        const body = JSON.parse(options.body);
        
        // Anthropic puts system in separate field
        expect(body.system).toEqual([{ type: 'text', text: 'You are helpful' }]);
        // Messages should exclude the system message
        expect(body.messages).toHaveLength(3);
        expect(body.messages[0].role).toBe('user');
    });

    test('image handling - exact structure', () => {
        const messages = [
            { 
                role: RoleEnum.user, 
                parts: [{ type: 'text', content: 'img' }],
                images: ['data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==']
            }
        ];
        const formatted = provider.formatMessages(messages);
        const imgPart = formatted[0].content.find(p => p.type === 'image');
        expect(imgPart).toEqual(expect.objectContaining({
            type: 'image',
            source: {
                type: 'base64',
                media_type: 'image/png',
                data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
            }
        }));
    });

    test('stream thought separation', () => {
        const chunks = [
            { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'Thought' } },
            { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Action' } }
        ];
        const collected = [];
        const writer = { processContent: (c, isThought) => collected.push({ c, isThought: !!isThought }) };
        
        for (const chunk of chunks) {
            provider.handleStream({ parsed: chunk, writer, tokenCounter: { update: () => {} } });
        }

        expect(collected).toEqual([
            { c: 'Thought', isThought: true },
            { c: 'Action', isThought: false }
        ]);
    });
});

describe('GeminiProvider - Meaningful Tests', () => {
    const provider = Providers.gemini;
    const model = 'gemini-1.5-pro';

    test('role mapping and system instruction', () => {
        const conversation = createConversation();
        const formatted = provider.formatMessages(conversation);
        
        // assistant -> model
        expect(formatted[2].role).toBe('model');
        expect(formatted[1].role).toBe('user');

        const [url, options] = provider.createRequest({
            model,
            messages: conversation,
            stream: false,
            options: {},
            apiKey: 'key',
            settings: { temperature: 0.7, max_tokens: 1000 }
        });
        const body = JSON.parse(options.body);
        
        expect(body.systemInstruction).toEqual(formatted[0]);
        expect(body.contents).toEqual(formatted.slice(1));
        expect(url).toContain('key=key');
    });

    test('image handling - inlineData', () => {
        const messages = [
            { 
                role: RoleEnum.user, 
                images: ['data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBD...']
            }
        ];
        const formatted = provider.formatMessages(messages);
        expect(formatted[0].parts[0]).toEqual({
            inline_data: {
                mime_type: 'image/jpeg',
                data: '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBD...'
            }
        });
    });

    test('thought extraction from stream', () => {
        const chunk = {
            candidates: [{
                content: {
                    parts: [
                        { text: 'Thinking...', thought: true },
                        { text: 'Answer' }
                    ]
                }
            }]
        };
        const collected = [];
        const writer = { processContent: (c, isThought) => collected.push({ c, isThought: !!isThought }) };
        
        provider.handleStream({ parsed: chunk, writer, tokenCounter: { update: () => {} } });

        expect(collected).toEqual([
            { c: 'Thinking...', isThought: true },
            { c: 'Answer', isThought: false }
        ]);
    });
});

describe('DeepSeekProvider - Meaningful Tests', () => {
    const provider = Providers.deepseek;

    test('stream reconstruction with reasoning_content', () => {
        const chunk = {
            choices: [{
                delta: {
                    reasoning_content: 'Plan: ',
                    content: 'Hello'
                }
            }]
        };
        const collected = [];
        const writer = { processContent: (c, isThought) => collected.push({ c, isThought: !!isThought }) };
        
        provider.handleStream({ parsed: chunk, writer, tokenCounter: { update: () => {} } });

        expect(collected).toEqual([
            { c: 'Plan: ', isThought: true },
            { c: 'Hello', isThought: false }
        ]);
    });

    test('token counting names', () => {
        const tokenCounter = { update: mock() };
        const data = {
            usage: { prompt_tokens: 15, completion_tokens: 25 },
            choices: [{ message: { content: 'hi' } }]
        };
        
        provider.handleResponse({ data, tokenCounter });
        expect(tokenCounter.update).toHaveBeenCalledWith(15, 25);
    });
});

describe('GrokProvider - Meaningful Tests', () => {
    const provider = Providers.grok;

    test('citations building', () => {
        const data = {
            choices: [{ message: { content: 'According to source' } }],
            citations: ['https://example.com/1', 'https://example.com/2'],
            usage: { prompt_tokens: 1, completion_tokens: 1 }
        };
        const tokenCounter = { update: () => {} };
        const result = provider.handleResponse({ data, tokenCounter });
        
        const content = result[0].content;
        expect(content).toContain('According to source');
        expect(content).toContain('[example.com](https://example.com/1)');
        expect(content).toContain('[example.com](https://example.com/2)');
    });
});
