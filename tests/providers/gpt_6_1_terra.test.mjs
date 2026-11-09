import { describe, expect, test } from 'bun:test';
import { OpenAIProvider } from '../../src/js/LLMProviders.js';

const provider = new OpenAIProvider();
const model = 'gpt-6.1-terra';
const efforts = ['none', 'low', 'medium', 'high', 'xhigh', 'max'];
const createRequest = (options = {}, overrides = {}) => provider.createRequest({
    model,
    messages: [
        { role: 'system', parts: [{ type: 'text', content: 'Be precise.' }] },
        { role: 'user', parts: [{ type: 'text', content: 'Describe this image.' }], images: ['data:image/png;base64,aGVsbG8='] }
    ],
    stream: false,
    apiKey: 'api-key',
    settings: { temperature: 0.7, max_tokens: 500_000 },
    options,
    ...overrides
});

describe('GPT-6.1 Terra requests', () => {
    test('sends every supported effort with pro mode and modern search without sampling parameters', () => {
        expect(provider.getReasoningEfforts(model)).toEqual(efforts);
        for (const effort of efforts) {
            const [url, request] = createRequest({ reasoningEffort: effort, reasoningMode: 'pro', webSearch: true });
            const body = JSON.parse(request.body);
            expect(url).toBe('https://api.openai.com/v1/responses');
            expect(body).toMatchObject({
                model,
                reasoning: { effort, summary: 'auto', mode: 'pro' },
                tools: [{ type: 'web_search' }],
                max_output_tokens: 128_000
            });
            expect(body.temperature).toBeUndefined();
            expect(body.top_p).toBeUndefined();
            expect(body.input[0].content).toEqual([
                { type: 'input_text', text: 'Describe this image.' },
                { type: 'input_image', image_url: 'data:image/png;base64,aGVsbG8=' }
            ]);
        }
    });

    test('defaults to standard medium reasoning and honors a lower user output cap', () => {
        const [, request] = createRequest({}, { settings: { temperature: 0.7, max_tokens: 24_000 } });
        const body = JSON.parse(request.body);
        expect(body.reasoning).toEqual({ effort: 'medium', summary: 'auto', mode: 'standard' });
        expect(body.max_output_tokens).toBe(24_000);
        expect(body.tools).toBeUndefined();
    });

    test('uses subscription transport with reasoning and search but without API-key-only parameters', () => {
        const [url, request] = createRequest({ reasoningEffort: 'none', webSearch: true }, {
            chatGPTAuth: { access: 'access-token', accountId: 'account-123' }
        });
        const body = JSON.parse(request.body);
        expect(url).toBe('https://chatgpt.com/backend-api/codex/responses');
        expect(request.headers.Authorization).toBe('Bearer access-token');
        expect(request.headers['chatgpt-account-id']).toBe('account-123');
        expect(body).toMatchObject({
            model,
            stream: true,
            store: false,
            instructions: 'Be precise.',
            reasoning: { effort: 'none', summary: 'auto' },
            tools: [{ type: 'web_search' }]
        });
        expect(body.reasoning.mode).toBeUndefined();
        expect(body.max_output_tokens).toBeUndefined();
        expect(body.temperature).toBeUndefined();
    });
});
