import { afterEach, describe, expect, test } from 'bun:test';
import {
    DEFAULT_MODELS,
    MaxTokens,
    OpenAIProvider,
    RoleEnum
} from '../../src/js/LLMProviders.js';
import { ApiManager } from '../../src/js/api_manager.js';
import { createChromeMock, createMockTokenCounter } from '../setup.mjs';

const CODEX_ENDPOINT = 'https://chatgpt.com/backend-api/codex/responses';

const originalChrome = globalThis.chrome;
const originalFetch = globalThis.fetch;

const messages = [
    { role: RoleEnum.system, parts: [{ type: 'text', content: 'Be precise.' }] },
    { role: RoleEnum.user, parts: [{ type: 'text', content: 'Hello' }] }
];

const credentials = () => ({
    access: 'access-token',
    refresh: 'refresh-token',
    expires: Date.now() + 3_600_000,
    accountId: 'account-123',
    email: 'person@example.com',
    planType: 'plus'
});

const createRequest = (provider, model, options = {}, overrides = {}) => {
    const { settings, ...rest } = overrides;
    return provider.createRequest({
        model,
        messages,
        stream: false,
        options,
        apiKey: 'paid-api-key',
        settings: { temperature: 0.7, max_tokens: 500_000, ...settings },
        ...rest
    });
};

const createBody = (provider, model, options = {}, settings = {}) =>
    JSON.parse(createRequest(provider, model, options, { settings })[1].body);

// Codex gates models by client version; gpt-6-astra requires 0.153.0 (models-manager/models.json).
const expectAstraClientVersion = version => {
    const [major, minor] = String(version).split('.').map(Number);
    expect(major).toBe(0);
    expect(minor).toBeGreaterThanOrEqual(153);
};

afterEach(() => {
    globalThis.chrome = originalChrome;
    globalThis.fetch = originalFetch;
});

describe('GPT-6 Astra catalog registration', () => {
    test('ships Astra in the default catalog', () => {
        expect(DEFAULT_MODELS.openai['gpt-6-astra']).toBe('GPT-6 Astra');
        expect(MaxTokens.openai_astra).toBe(128000);
    });
});

describe('GPT-6 Astra capabilities', () => {
    const provider = new OpenAIProvider();

    test('exposes the documented effort range without none or minimal', () => {
        expect(provider.supports('reasoning', 'gpt-6-astra')).toBe(true);
        expect(provider.supports('reasoning_mode', 'gpt-6-astra')).toBe(true);
        expect(provider.supports('web_search', 'gpt-6-astra')).toBe(true);
        expect(provider.getReasoningEfforts('gpt-6-astra')).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    });

    test('moves unsupported efforts into the supported range', () => {
        expect(provider.normalizeReasoningEffort('gpt-6-astra', 'none')).toBe('low');
        expect(provider.normalizeReasoningEffort('gpt-6-astra', 'minimal')).toBe('low');
        expect(provider.normalizeReasoningEffort('gpt-6-astra', 'xhigh')).toBe('xhigh');
        expect(provider.normalizeReasoningEffort('gpt-6-astra', 'max')).toBe('max');
        expect(provider.normalizeReasoningEffort('gpt-6-astra', 'turbo')).toBe('medium');
    });

    test('leaves the GPT-5.6 effort mapping untouched', () => {
        expect(provider.normalizeReasoningEffort('gpt-5.6-sol', 'none')).toBe('none');
        expect(provider.normalizeReasoningEffort('gpt-5.6-sol', 'minimal')).toBe('none');
        expect(provider.getReasoningEfforts('gpt-5.2')).toEqual(['minimal', 'low', 'medium', 'high', 'xhigh']);
        expect(provider.supports('reasoning_mode', 'gpt-5.2')).toBe(false);
    });
});

describe('GPT-6 Astra request serialization', () => {
    const provider = new OpenAIProvider();

    test('sends the 128k output cap with pro mode and no sampling parameters', () => {
        const body = createBody(provider, 'gpt-6-astra', {
            reasoningEffort: 'max',
            reasoningMode: 'pro'
        });

        expect(body.model).toBe('gpt-6-astra');
        expect(body.instructions).toBe('Be precise.');
        expect(body.max_output_tokens).toBe(MaxTokens.openai_astra);
        expect(body.reasoning).toEqual({ effort: 'max', summary: 'auto', mode: 'pro' });
        expect(body.temperature).toBeUndefined();
        expect(body.top_p).toBeUndefined();
        expect(body.logprobs).toBeUndefined();
    });

    test('honors the configured output limit and defaults the mode to standard', () => {
        const body = createBody(provider, 'gpt-6-astra', { reasoningEffort: 'low' }, { max_tokens: 32000 });

        expect(body.max_output_tokens).toBe(32000);
        expect(body.reasoning).toEqual({ effort: 'low', summary: 'auto', mode: 'standard' });
    });

    test('requests the current web search tool for Astra and keeps the legacy type for GPT-5.6', () => {
        expect(createBody(provider, 'gpt-6-astra', { webSearch: true }).tools).toEqual([{ type: 'web_search' }]);
        expect(createBody(provider, 'gpt-5.6-sol', { webSearch: true }).tools).toEqual([{ type: 'web_search_preview' }]);
        expect(createBody(provider, 'gpt-6-astra').tools).toBeUndefined();
    });
});

describe('GPT-6 Astra on the ChatGPT subscription route', () => {
    const provider = new OpenAIProvider();

    test('uses the Codex endpoint, version gate, and wire contract instead of the API key', () => {
        const [url, request] = createRequest(provider, 'gpt-6-astra', { reasoningEffort: 'xhigh' }, {
            chatGPTAuth: credentials()
        });
        const body = JSON.parse(request.body);

        expect(url).toBe(CODEX_ENDPOINT);
        expect(request.headers.Authorization).toBe('Bearer access-token');
        expect(request.headers['chatgpt-account-id']).toBe('account-123');
        expect(request.headers['OpenAI-Beta']).toBe('responses=experimental');
        expect(request.headers.originator).toBe('pi');
        expectAstraClientVersion(request.headers.version);
        expect(body).toEqual(expect.objectContaining({
            model: 'gpt-6-astra',
            instructions: 'Be precise.',
            store: false,
            stream: true,
            reasoning: { effort: 'xhigh', summary: 'auto' }
        }));
        expect(body.max_output_tokens).toBeUndefined();
        expect(body.temperature).toBeUndefined();
    });

    test('carries pro mode over the subscription route when requested', () => {
        const [, request] = createRequest(provider, 'gpt-6-astra', {
            reasoningEffort: 'high',
            reasoningMode: 'pro'
        }, { chatGPTAuth: credentials() });

        expect(JSON.parse(request.body).reasoning).toEqual({ effort: 'high', summary: 'auto', mode: 'pro' });
    });

    test('ApiManager streams Astra through the Codex endpoint and preserves the thoughts', async () => {
        globalThis.chrome = createChromeMock();
        await chrome.storage.local.set({
            api_keys: {},
            chatgpt_auth: credentials(),
            models: { openai: { 'gpt-6-astra': 'GPT-6 Astra' } },
            max_tokens: 16000,
            temperature: 1
        });

        const calls = [];
        globalThis.fetch = async (url, options) => {
            calls.push({ url, options });
            const events = [
                'data: {"type":"response.reasoning_summary_text.delta","delta":"Think"}\n\n',
                'data: {"type":"response.output_text.delta","delta":"Hello"}\n\n',
                'data: {"type":"response.completed","response":{"usage":{"input_tokens":7,"output_tokens":3}}}\n\n'
            ].join('');
            return new Response(events, { headers: { 'Content-Type': 'text/event-stream' } });
        };

        const api = new ApiManager();
        await new Promise(resolve => api.settingsManager.runOnReady(resolve));
        const counter = createMockTokenCounter();
        const result = await api.callApi('gpt-6-astra', messages, counter);

        expect(calls).toHaveLength(1);
        expect(calls[0].url).toBe(CODEX_ENDPOINT);
        expectAstraClientVersion(calls[0].options.headers.version);
        const body = JSON.parse(calls[0].options.body);
        expect(body.model).toBe('gpt-6-astra');
        expect(body.reasoning).toEqual({ effort: 'medium', summary: 'auto' });
        expect(body.temperature).toBeUndefined();
        expect(result).toEqual([
            { type: 'thought', content: 'Think' },
            { type: 'text', content: 'Hello' }
        ]);
        expect(counter.inputTokens).toBe(7);
        expect(counter.outputTokens).toBe(3);
    });

    test('ApiManager replaces a stored none effort that Astra rejects', async () => {
        globalThis.chrome = createChromeMock();
        await chrome.storage.local.set({
            api_keys: {},
            chatgpt_auth: credentials(),
            models: { openai: { 'gpt-6-astra': 'GPT-6 Astra' } },
            max_tokens: 16000,
            temperature: 1,
            reasoning_effort: 'none'
        });

        const calls = [];
        globalThis.fetch = async (url, options) => {
            calls.push({ url, options });
            return new Response('data: {"type":"response.output_text.delta","delta":"Hi"}\n\n', {
                headers: { 'Content-Type': 'text/event-stream' }
            });
        };

        const api = new ApiManager();
        await new Promise(resolve => api.settingsManager.runOnReady(resolve));
        await api.callApi('gpt-6-astra', messages, createMockTokenCounter());

        expect(JSON.parse(calls[0].options.body).reasoning).toEqual({ effort: 'low', summary: 'auto' });
    });
});
