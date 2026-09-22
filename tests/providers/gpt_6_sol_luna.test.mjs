import { describe, expect, test } from 'bun:test';
import { OpenAIProvider, RoleEnum } from '../../src/js/LLMProviders.js';

const API_KEY_ENDPOINT = 'https://api.openai.com/v1/responses';
const CODEX_ENDPOINT = 'https://chatgpt.com/backend-api/codex/responses';
const GPT6_MODELS = [
    { id: 'gpt-6-sol', name: 'GPT-6 Sol' },
    { id: 'gpt-6-luna', name: 'GPT-6 Luna' }
];
const REASONING_EFFORTS = ['none', 'low', 'medium', 'high', 'xhigh', 'max'];
const messages = [
    { role: RoleEnum.system, parts: [{ type: 'text', content: 'Be precise.' }] },
    { role: RoleEnum.user, parts: [{ type: 'text', content: 'Hello' }] }
];

const credentials = {
    access: 'access-token',
    refresh: 'refresh-token',
    expires: Date.now() + 3_600_000,
    accountId: 'account-123',
    email: 'person@example.com',
    planType: 'plus'
};

const provider = new OpenAIProvider();
const createRequest = (model, options = {}, { chatGPTAuth, settings } = {}) => provider.createRequest({
    model,
    messages,
    stream: false,
    options,
    apiKey: 'api-key',
    chatGPTAuth,
    settings: { temperature: 0.7, max_tokens: 500_000, ...settings }
});
const createBody = (...args) => JSON.parse(createRequest(...args)[1].body);

for (const { id: model, name } of GPT6_MODELS) {
    describe(`${name} capabilities and API-key requests`, () => {
        test('exposes the documented reasoning efforts, mode, and web search capabilities', () => {
            expect(provider.supports('reasoning', model)).toBe(true);
            expect(provider.supports('reasoning_mode', model)).toBe(true);
            expect(provider.supports('web_search', model)).toBe(true);
            expect(provider.getReasoningEfforts(model)).toEqual(REASONING_EFFORTS);
            expect(provider.normalizeReasoningEffort(model, 'none')).toBe('none');
            expect(provider.normalizeReasoningEffort(model, 'minimal')).toBe('medium');
            expect(provider.normalizeReasoningEffort(model, 'invalid')).toBe('medium');
        });

        test('uses Responses fields, the 128k output cap, pro mode, and web_search', () => {
            const [url, request] = createRequest(model, {
                reasoningEffort: 'max',
                reasoningMode: 'pro',
                webSearch: true
            });
            const body = JSON.parse(request.body);

            expect(url).toBe(API_KEY_ENDPOINT);
            expect(request.headers.Authorization).toBe('Bearer api-key');
            expect(body).toMatchObject({
                model,
                instructions: 'Be precise.',
                max_output_tokens: 128_000,
                reasoning: { effort: 'max', summary: 'auto', mode: 'pro' },
                tools: [{ type: 'web_search' }]
            });
            expect(body.temperature).toBeUndefined();
            expect(body.top_p).toBeUndefined();
        });

        test('honors a lower output limit and sends standard mode by default', () => {
            const body = createBody(model, { reasoningEffort: 'none' }, { settings: { max_tokens: 24_000 } });

            expect(body.max_output_tokens).toBe(24_000);
            expect(body.reasoning).toEqual({ effort: 'none', summary: 'auto', mode: 'standard' });
        });

        test('uses the Codex minimum client version and OAuth Responses wire contract', () => {
            const [url, request] = createRequest(model, {
                reasoningEffort: 'xhigh',
                reasoningMode: 'pro',
                webSearch: true
            }, { chatGPTAuth: credentials });
            const body = JSON.parse(request.body);
            const [major, minor] = request.headers.version.split('.').map(Number);

            expect(url).toBe(CODEX_ENDPOINT);
            expect(request.headers.Authorization).toBe('Bearer access-token');
            expect(request.headers['chatgpt-account-id']).toBe('account-123');
            expect(major).toBe(0);
            expect(minor).toBeGreaterThanOrEqual(155);
            expect(body).toMatchObject({
                model,
                instructions: 'Be precise.',
                store: false,
                stream: true,
                reasoning: { effort: 'xhigh', summary: 'auto', mode: 'pro' },
                tools: [{ type: 'web_search' }]
            });
            expect(body.max_output_tokens).toBeUndefined();
            expect(body.temperature).toBeUndefined();
        });
    });
}

test('keeps GPT-5.6 support available to existing saved model selections', () => {
    for (const model of ['gpt-5.6-sol', 'gpt-5.6-luna']) {
        expect(provider.supports('reasoning', model)).toBe(true);
        expect(provider.getReasoningEfforts(model)).toEqual(REASONING_EFFORTS);
        expect(createBody(model, { webSearch: true }).tools).toEqual([{ type: 'web_search_preview' }]);
    }
});
