import { describe, test, expect } from 'bun:test';
import { OpenAICompatibleProvider, RoleEnum } from '../../src/js/LLMProviders.js';
import { createMockWriter, createMockTokenCounter } from '../setup.mjs';

class MockOpenAICompatibleProvider extends OpenAICompatibleProvider {
    getApiEndpoint() {
        return 'https://example.com/v1/chat/completions';
    }
}

class VisionMockProvider extends MockOpenAICompatibleProvider {
    supportsImageMessages() {
        return true;
    }
}

class OptionalUsageProvider extends MockOpenAICompatibleProvider {
    requiresResponseUsage() {
        return false;
    }
}

describe('OpenAICompatibleProvider', () => {
    test('createRequest builds shared OpenAI-compatible payload', () => {
        const provider = new MockOpenAICompatibleProvider();
        const messages = [
            { role: RoleEnum.user, parts: [{ type: 'text', content: 'Hello' }] },
            { role: RoleEnum.assistant, parts: [{ type: 'text', content: 'Hi there' }] }
        ];

        const [url, request] = provider.createRequest({
            model: 'test-model',
            messages,
            stream: true,
            settings: { temperature: 9, max_tokens: 99999 },
            apiKey: 'secret',
            options: {}
        });

        const body = JSON.parse(request.body);
        expect(url).toBe('https://example.com/v1/chat/completions');
        expect(request.headers.Authorization).toBe('Bearer secret');
        expect(body).toEqual({
            model: 'test-model',
            messages: [
                { role: 'user', content: 'Hello' },
                { role: 'assistant', content: 'Hi there' }
            ],
            stream: true,
            max_tokens: 8192,
            temperature: 1,
            stream_options: { include_usage: true }
        });
    });

    test('formatMessages includes image_url content when enabled', () => {
        const provider = new VisionMockProvider();
        const formatted = provider.formatMessages([
            {
                role: RoleEnum.user,
                parts: [{ type: 'text', content: 'What is this?' }],
                images: ['data:image/png;base64,abc']
            }
        ]);

        expect(formatted[0]).toEqual({
            role: 'user',
            content: [
                { type: 'text', text: 'What is this?' },
                { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } }
            ]
        });
    });

    test('handleStream merges reasoning and content, then counts usage', () => {
        const provider = new MockOpenAICompatibleProvider();
        const writer = createMockWriter();
        const tokenCounter = createMockTokenCounter();

        provider.handleStream({ parsed: { choices: [{ delta: { reasoning_content: 'Think ' } }] }, writer, tokenCounter });
        provider.handleStream({ parsed: { choices: [{ delta: { content: 'Answer' } }] }, writer, tokenCounter });
        provider.handleStream({ parsed: { usage: { prompt_tokens: 11, completion_tokens: 7 }, choices: [] }, writer, tokenCounter });

        expect(writer.getFinalContent()).toEqual([
            { type: 'thought', content: 'Think ' },
            { type: 'text', content: 'Answer' }
        ]);
        expect(tokenCounter.inputTokens).toBe(11);
        expect(tokenCounter.outputTokens).toBe(7);
    });

    test('handleResponse supports optional usage via hook', () => {
        const provider = new OptionalUsageProvider();
        const tokenCounter = createMockTokenCounter();

        const result = provider.handleResponse({
            data: { choices: [{ message: { content: 'done', reasoning_content: 'plan' } }] },
            tokenCounter
        });

        expect(result).toEqual([
            { type: 'thought', content: 'plan' },
            { type: 'text', content: 'done' }
        ]);
        expect(tokenCounter.inputTokens).toBe(0);
        expect(tokenCounter.outputTokens).toBe(0);
    });
});
