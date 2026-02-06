import { describe, test, expect, mock } from 'bun:test';
import { Providers, RoleEnum } from '../../src/js/LLMProviders.js';

// Helper to create a standard conversation
const createConversation = () => [
    { role: RoleEnum.system, parts: [{ type: 'text', content: 'You are helpful' }] },
    { role: RoleEnum.user, parts: [{ type: 'text', content: 'Hello' }] },
    { role: RoleEnum.assistant, parts: [{ type: 'text', content: 'Hi!' }] },
    { role: RoleEnum.user, parts: [{ type: 'text', content: 'How are you?' }] }
];

const PROVIDER_CONFIGS = [
    {
        name: 'OpenAI',
        provider: Providers.openai,
        model: 'gpt-5.2',
        getSystemFromBody: (body) => body.instructions,
        getUserMessages: (body) => body.input,
        assistantRole: 'assistant',
        supportsImages: true,
        imageModel: 'gpt-5.2',
        getImageFromBody: (body) => body.input[0].content.find(p => p.type === 'input_image'),
        getUsageFromChunk: (chunk) => chunk.response?.usage,
        supportsThinking: true,
        getThinkingConfigFromBody: (body) => body.reasoning,
        getThinkingFromChunk: (chunk) => null, // OpenAI doesn't stream thoughts in unified yet? Check handleStream
    },
    {
        name: 'Anthropic',
        provider: Providers.anthropic,
        model: 'claude-sonnet-4-20250514',
        getSystemFromBody: (body) => body.system?.[0]?.text,
        getUserMessages: (body) => body.messages,
        assistantRole: 'assistant',
        supportsImages: true,
        imageModel: 'claude-sonnet-4-20250514',
        getImageFromBody: (body) => body.messages[0].content.find(p => p.type === 'image'),
        getUsageFromChunk: (chunk) => chunk.message?.usage || chunk.usage,
        supportsThinking: true,
        getThinkingConfigFromBody: (body) => body.thinking,
        getThinkingFromChunk: (chunk) => chunk.delta?.thinking,
    },
    {
        name: 'Gemini',
        provider: Providers.gemini,
        model: 'gemini-3.0-pro',
        getSystemFromBody: (body) => body.systemInstruction?.parts?.[0]?.text,
        getUserMessages: (body) => body.contents,
        assistantRole: 'model',
        supportsImages: true,
        imageModel: 'gemini-3.0-flash-image-preview',
        getImageFromBody: (body) => body.contents[0].parts.find(p => p.inline_data),
        getUsageFromChunk: (chunk) => chunk.usageMetadata ? { input_tokens: chunk.usageMetadata.promptTokenCount, output_tokens: chunk.usageMetadata.candidatesTokenCount + (chunk.usageMetadata.thoughtsTokenCount || 0) } : null,
        supportsThinking: true,
        getThinkingConfigFromBody: (body) => body.generationConfig?.thinking_config,
        getThinkingFromChunk: (chunk) => chunk.candidates?.[0]?.content?.parts?.find(p => p.thought)?.text,
    },
    {
        name: 'DeepSeek',
        provider: Providers.deepseek,
        model: 'deepseek-chat',
        getSystemFromBody: (body) => body.messages?.find(m => m.role === 'system')?.content,
        getUserMessages: (body) => body.messages?.filter(m => m.role !== 'system'),
        assistantRole: 'assistant',
        supportsImages: false,
        getUsageFromChunk: (chunk) => chunk.usage,
        supportsThinking: true,
        thinkingModel: 'deepseek-reasoner',
        getThinkingConfigFromBody: (body) => null, // DeepSeek uses model name for thinking
        getThinkingFromChunk: (chunk) => chunk.choices?.[0]?.delta?.reasoning_content,
    },
    {
        name: 'Grok',
        provider: Providers.grok,
        model: 'grok-4',
        getSystemFromBody: (body) => body.messages?.find(m => m.role === 'system')?.content,
        getUserMessages: (body) => body.messages?.filter(m => m.role !== 'system'),
        assistantRole: 'assistant',
        supportsImages: true,
        imageModel: 'grok-4',
        getImageFromBody: (body) => body.messages[0].content.find(p => p.type === 'image_url'),
        getUsageFromChunk: (chunk) => chunk.usage,
        supportsThinking: true,
        getThinkingConfigFromBody: (body) => null, // Grok uses model name
        getThinkingFromChunk: (chunk) => chunk.choices?.[0]?.delta?.reasoning_content,
    },
    {
        name: 'Kimi',
        provider: Providers.kimi,
        model: 'kimi-k2-turbo-preview',
        getSystemFromBody: (body) => body.messages?.find(m => m.role === 'system')?.content,
        getUserMessages: (body) => body.messages?.filter(m => m.role !== 'system'),
        assistantRole: 'assistant',
        supportsImages: false,
        getUsageFromChunk: (chunk) => chunk.usage,
        supportsThinking: true,
        thinkingModel: 'kimi-k2-thinking-turbo',
        getThinkingConfigFromBody: (body) => null,
        getThinkingFromChunk: (chunk) => chunk.choices?.[0]?.delta?.reasoning_content,
    },
    {
        name: 'Mistral',
        provider: Providers.mistral,
        model: 'mistral-large-latest',
        getSystemFromBody: (body) => body.messages?.find(m => m.role === 'system')?.content,
        getUserMessages: (body) => body.messages?.filter(m => m.role !== 'system'),
        assistantRole: 'assistant',
        supportsImages: false,
        getUsageFromChunk: (chunk) => chunk.usage,
        supportsThinking: false,
    },
    {
        name: 'LlamaCpp',
        provider: Providers.llamacpp,
        model: 'local-model',
        getSystemFromBody: (body) => body.messages?.find(m => m.role === 'system')?.content,
        getUserMessages: (body) => body.messages?.filter(m => m.role !== 'system'),
        assistantRole: 'assistant',
        supportsImages: true,
        imageModel: 'local-model',
        getImageFromBody: (body) => body.messages[0].content.find(p => p.type === 'image_url'),
        getUsageFromChunk: (chunk) => chunk.usage,
        supportsThinking: true,
        getThinkingConfigFromBody: (body) => null,
        getThinkingFromChunk: (chunk) => chunk.choices?.[0]?.delta?.reasoning_content,
    },
];

PROVIDER_CONFIGS.forEach(config => {
    describe(`${config.name}Provider`, () => {
        const { provider, model } = config;

        test('request structure with system prompt', () => {
            const conversation = createConversation();
            const [_, options] = provider.createRequest({
                model,
                messages: conversation,
                stream: true,
                options: {},
                apiKey: 'key',
                settings: { temperature: 0.7, max_tokens: 1000 }
            });
            const body = JSON.parse(options.body);
            expect(config.getSystemFromBody(body)).toBe('You are helpful');
            
            const userMsgs = config.getUserMessages(body);
            // Most providers exclude system from user messages or handle it specially
            // We just check that the last message is a user message
            expect(userMsgs.at(-1).role).toBe('user');
        });

        test('request structure without system prompt', () => {
            const messages = [
                { role: RoleEnum.user, parts: [{ type: 'text', content: 'hello' }] }
            ];
            const [_, options] = provider.createRequest({
                model,
                messages,
                stream: true,
                options: {},
                apiKey: 'key',
                settings: { temperature: 0.7, max_tokens: 1000 }
            });
            const body = JSON.parse(options.body);
            expect(config.getSystemFromBody(body)).toBeUndefined();
            
            const userMsgs = config.getUserMessages(body);
            expect(userMsgs).toHaveLength(1);
            expect(userMsgs[0].role).toBe('user');
        });

        test('role mapping (user -> user, assistant -> assistant/model)', () => {
            const conversation = [
                { role: RoleEnum.user, parts: [{ type: 'text', content: 'u1' }] },
                { role: RoleEnum.assistant, parts: [{ type: 'text', content: 'a1' }] }
            ];
            // Use createRequest to test the final payload role mapping
            const [_, options] = provider.createRequest({
                model,
                messages: conversation,
                stream: false,
                options: {},
                apiKey: 'key',
                settings: { temperature: 0.7, max_tokens: 1000 }
            });
            const body = JSON.parse(options.body);
            const userMsgs = config.getUserMessages(body);
            
            expect(userMsgs[0].role).toBe('user');
            expect(userMsgs[1].role).toBe(config.assistantRole);
        });

        if (config.supportsImages) {
            test('image formatting', () => {
                const base64Data = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
                const messages = [{
                    role: RoleEnum.user,
                    parts: [{ type: 'text', content: 'What is this?' }],
                    images: [`data:image/png;base64,${base64Data}`]
                }];
                const [_, options] = provider.createRequest({
                    model: config.imageModel || model,
                    messages,
                    stream: false,
                    options: {},
                    apiKey: 'key',
                    settings: { temperature: 0.7, max_tokens: 1000 }
                });
                const body = JSON.parse(options.body);
                const imgPart = config.getImageFromBody(body);
                expect(imgPart).toBeDefined();
                // Specific structure checks can be added if needed, but defining it is the main goal
            });
        }

        if (config.getUsageFromChunk) {
            test('stream token counting', () => {
                const tokenCounter = { update: mock() };
                const writer = { processContent: () => {} };
                
                // We need to provide a chunk that matches what the provider expects
                let mockChunk;
                if (config.name === 'OpenAI') {
                    mockChunk = { type: 'response.completed', response: { usage: { input_tokens: 50, output_tokens: 25 } } };
                } else if (config.name === 'Anthropic') {
                    mockChunk = { type: 'message_start', message: { usage: { input_tokens: 50, output_tokens: 0 } } };
                } else if (config.name === 'Gemini') {
                    mockChunk = { usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 20, thoughtsTokenCount: 5 } };
                } else if (['DeepSeek', 'Grok', 'Kimi', 'Mistral', 'LlamaCpp'].includes(config.name)) {
                    mockChunk = { usage: { prompt_tokens: 50, completion_tokens: 25 } };
                    if (config.name === 'DeepSeek') {
                        mockChunk.choices = [{ delta: { content: "" } }];
                    } else if (['Grok', 'Kimi', 'LlamaCpp'].includes(config.name)) {
                        mockChunk.choices = [];
                    }
                }

                provider.handleStream({ parsed: mockChunk, writer, tokenCounter });
                
                if (config.name === 'Anthropic') {
                    expect(tokenCounter.update).toHaveBeenCalledWith(50, 0);
                } else {
                    expect(tokenCounter.update).toHaveBeenCalledWith(50, 25);
                }
            });
        }

        if (config.supportsThinking) {
            test('thinking/reasoning config', () => {
                const [_, options] = provider.createRequest({
                    model: config.thinkingModel || model,
                    messages: createConversation(),
                    stream: true,
                    options: { shouldThink: true },
                    apiKey: 'key',
                    settings: { temperature: 0.7, max_tokens: 10000 }
                });
                const body = JSON.parse(options.body);
                if (config.getThinkingConfigFromBody) {
                    const thinkingConfig = config.getThinkingConfigFromBody(body);
                    expect(thinkingConfig).toBeDefined();
                } else {
                    // For providers like DeepSeek/Grok/Kimi, thinking is enabled by model name
                    expect(body.model).toBe(config.thinkingModel || model);
                }
            });

            if (config.getThinkingFromChunk) {
                test('thinking extraction in streams', () => {
                    const collected = [];
                    const writer = { 
                        processContent: (c, isThought) => collected.push({ c, isThought: !!isThought }),
                        setThinkingModel: mock(),
                        isThinkingModel: false
                    };
                    const tokenCounter = { update: () => {} };
                    
                    let mockChunk;
                    if (config.name === 'Anthropic') {
                        mockChunk = { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'I am thinking' } };
                    } else if (config.name === 'Gemini') {
                        mockChunk = { candidates: [{ content: { parts: [{ text: 'I am thinking', thought: true }] } }] };
                    } else if (['DeepSeek', 'Grok', 'Kimi', 'LlamaCpp'].includes(config.name)) {
                        mockChunk = { choices: [{ delta: { reasoning_content: 'I am thinking' } }] };
                    }

                    if (mockChunk) {
                        provider.handleStream({ parsed: mockChunk, writer, tokenCounter });
                        expect(collected).toContainEqual({ c: 'I am thinking', isThought: true });
                    }
                });
            }
        }

        test('empty/image-only messages', () => {
            const messages = [
                { 
                    role: RoleEnum.user, 
                    parts: [],
                    images: config.supportsImages ? ['data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='] : undefined
                }
            ];
            const [_, options] = provider.createRequest({
                model: config.supportsImages ? (config.imageModel || model) : model,
                messages,
                stream: false,
                options: {},
                apiKey: 'key',
                settings: { temperature: 0.7, max_tokens: 1000 }
            });
            const body = JSON.parse(options.body);
            expect(body).toBeDefined();
            const userMsgs = config.getUserMessages(body);
            expect(userMsgs).toBeDefined();
        });
    });
});

// --- Provider-Specific Edge Cases ---

describe('OpenAIProvider - Specifics', () => {
    const provider = Providers.openai;
    const model = 'gpt-5.2';

    test('reasoning request enables summary and thinking blocks', () => {
        const streamWriter = {
            setThinkingModel: mock(),
            addThinkingCounter: mock()
        };

        const [_, request] = provider.createRequest({
            model,
            messages: createConversation(),
            stream: true,
            options: { reasoningEffort: 'high', streamWriter },
            apiKey: 'key',
            settings: { temperature: 0.7, max_tokens: 10000 }
        });

        const body = JSON.parse(request.body);
        expect(body.reasoning).toEqual({ effort: 'high', summary: 'auto' });
        expect(streamWriter.setThinkingModel).toHaveBeenCalledTimes(1);
        expect(streamWriter.addThinkingCounter).toHaveBeenCalledTimes(0);
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

    test('stream extracts reasoning summary deltas as thoughts', () => {
        const collected = [];
        const writer = { processContent: (c, isThought) => collected.push({ c, isThought: !!isThought }) };

        provider.handleStream({
            parsed: { type: 'response.reasoning_summary_text.delta', delta: 'I am thinking' },
            writer,
            tokenCounter: { update: () => {} }
        });

        provider.handleStream({
            parsed: { type: 'response.output_text.delta', delta: 'I am answering' },
            writer,
            tokenCounter: { update: () => {} }
        });

        expect(collected).toEqual([
            { c: 'I am thinking', isThought: true },
            { c: 'I am answering', isThought: false }
        ]);
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

describe('AnthropicProvider - Specifics', () => {
    const provider = Providers.anthropic;
    const model = 'claude-3-7-sonnet';

    test('cache control on last message', () => {
        const conversation = createConversation();
        const formatted = provider.formatMessages(conversation);
        expect(formatted.at(-1).content.at(-1).cache_control).toEqual({ type: 'ephemeral' });
    });

    test('image handling - exact structure', () => {
        const messages = [
            { 
                role: RoleEnum.user, 
                parts: [{ type: 'text', content: 'What is this?' }],
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

    test('thoughts excluded from formatted payloads', () => {
        const messages = [
            { 
                role: RoleEnum.user, 
                parts: [
                    { type: 'text', content: 'hello' },
                    { type: 'thought', content: 'thinking' }
                ] 
            }
        ];
        const formatted = provider.formatMessages(messages);
        expect(formatted[0].content).toHaveLength(1);
        expect(formatted[0].content[0].text).toBe('hello');
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

describe('GeminiProvider - Specifics', () => {
    const provider = Providers.gemini;
    const model = 'gemini-1.5-pro';

    test('image handling - inlineData', () => {
        const messages = [
            { 
                role: RoleEnum.user, 
                parts: [{ type: 'text', content: '' }],
                images: ['data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBD...']
            }
        ];
        const formatted = provider.formatMessages(messages);
        expect(formatted[0].parts).toContainEqual({
            inline_data: {
                mime_type: 'image/jpeg',
                data: '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBD...'
            }
        });
    });

    test('thoughts excluded from formatted payloads', () => {
        const messages = [
            { 
                role: RoleEnum.user, 
                parts: [
                    { type: 'text', content: 'hello' },
                    { type: 'thought', content: 'thinking' }
                ] 
            }
        ];
        const formatted = provider.formatMessages(messages);
        expect(formatted[0].parts).toHaveLength(1);
        expect(formatted[0].parts[0].text).toBe('hello');
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

    test('empty system prompt handling', () => {
        const messages = [
            { role: RoleEnum.system, parts: [{ type: 'text', content: '' }] },
            { role: RoleEnum.user, parts: [{ type: 'text', content: 'hello' }] }
        ];
        const [_, options] = provider.createRequest({
            model,
            messages,
            stream: true,
            options: {},
            apiKey: 'key',
            settings: { temperature: 0.7, max_tokens: 1000 }
        });
        const body = JSON.parse(options.body);
        
        expect(body.systemInstruction).toBeDefined();
        expect(body.contents).toHaveLength(1);
        expect(body.contents[0].role).toBe('user');
        expect(body.contents[0].parts[0].text).toBe('hello');
    });
});

describe('DeepSeekProvider - Specifics', () => {
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

describe('GrokProvider - Specifics', () => {
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
