import { afterEach, describe, expect, test } from 'bun:test';
import {
    CHATGPT_AUTH_CONFIG,
    ensureFreshChatGPTCredentials,
    loginWithChatGPT
} from '../../src/js/chatgpt_auth.js';
import { OpenAIProvider } from '../../src/js/LLMProviders.js';
import { ApiManager } from '../../src/js/api_manager.js';
import { createChromeMock, createMockTokenCounter } from '../setup.mjs';

const originalChrome = globalThis.chrome;
const originalFetch = globalThis.fetch;

const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
});

const jwt = payload => {
    const encode = value => btoa(JSON.stringify(value))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/g, '');
    return `${encode({ alg: 'none' })}.${encode(payload)}.signature`;
};

const accessToken = (accountId = 'account-123', email = 'person@example.com') => jwt({
    'https://api.openai.com/auth': { chatgpt_account_id: accountId },
    'https://api.openai.com/profile': { email }
});

const idToken = planType => jwt({
    'https://api.openai.com/auth': { chatgpt_plan_type: planType }
});

const validCredentials = (overrides = {}) => ({
    access: accessToken(),
    refresh: 'refresh-token',
    expires: Date.now() + 3_600_000,
    accountId: 'account-123',
    email: 'person@example.com',
    planType: 'plus',
    ...overrides
});

afterEach(() => {
    globalThis.chrome = originalChrome;
    globalThis.fetch = originalFetch;
});

describe('ChatGPT browser authentication', () => {
    test('opens the account approval page, captures the loopback callback, and exchanges its code', async () => {
        const fetchCalls = [];
        const openedUrls = [];
        const closedTabs = [];
        const updatedListeners = new Set();
        const removedListeners = new Set();
        const tabs = {
            onUpdated: {
                addListener: listener => updatedListeners.add(listener),
                removeListener: listener => updatedListeners.delete(listener)
            },
            onRemoved: {
                addListener: listener => removedListeners.add(listener),
                removeListener: listener => removedListeners.delete(listener)
            },
            async create({ url, active }) {
                openedUrls.push({ url, active });
                const state = new URL(url).searchParams.get('state');
                setTimeout(() => {
                    const callback = `${CHATGPT_AUTH_CONFIG.redirectUri}?code=authorization-code&state=${state}`;
                    updatedListeners.forEach(listener => listener(17, { url: callback }, { id: 17, url: callback }));
                }, 0);
                return { id: 17 };
            },
            async remove(tabId) {
                closedTabs.push(tabId);
            }
        };
        const fetchImpl = async (url, options) => {
            fetchCalls.push({ url, options });
            return jsonResponse({
                access_token: accessToken(),
                refresh_token: 'refresh-token',
                id_token: idToken('pro'),
                expires_in: 3600
            });
        };

        const credentials = await loginWithChatGPT({ fetchImpl, tabs });

        expect(openedUrls).toHaveLength(1);
        expect(openedUrls[0].active).toBe(true);
        const authorizationUrl = new URL(openedUrls[0].url);
        expect(`${authorizationUrl.origin}${authorizationUrl.pathname}`).toBe(CHATGPT_AUTH_CONFIG.authorizeUrl);
        expect(authorizationUrl.searchParams.get('response_type')).toBe('code');
        expect(authorizationUrl.searchParams.get('client_id')).toBe(CHATGPT_AUTH_CONFIG.clientId);
        expect(authorizationUrl.searchParams.get('redirect_uri')).toBe(CHATGPT_AUTH_CONFIG.redirectUri);
        expect(authorizationUrl.searchParams.get('scope')).toBe(CHATGPT_AUTH_CONFIG.scope);
        expect(authorizationUrl.searchParams.get('code_challenge_method')).toBe('S256');
        expect(authorizationUrl.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(authorizationUrl.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(authorizationUrl.searchParams.get('id_token_add_organizations')).toBe('true');
        expect(authorizationUrl.searchParams.get('codex_cli_simplified_flow')).toBe('true');
        expect(authorizationUrl.searchParams.get('originator')).toBe('pi');
        expect(closedTabs).toEqual([17]);
        expect(updatedListeners.size).toBe(0);
        expect(removedListeners.size).toBe(0);

        expect(credentials).toEqual(expect.objectContaining({
            access: expect.any(String),
            refresh: 'refresh-token',
            accountId: 'account-123',
            email: 'person@example.com',
            planType: 'pro'
        }));
        expect(credentials.expires).toBeGreaterThan(Date.now());

        expect(fetchCalls).toHaveLength(1);
        expect(fetchCalls[0].url).toBe(CHATGPT_AUTH_CONFIG.tokenUrl);
        const exchange = fetchCalls[0];
        expect(exchange.options.body.get('grant_type')).toBe('authorization_code');
        expect(exchange.options.body.get('code')).toBe('authorization-code');
        expect(exchange.options.body.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(exchange.options.body.get('redirect_uri')).toBe(CHATGPT_AUTH_CONFIG.redirectUri);
    });

    test('deduplicates concurrent refreshes and preserves a non-rotated refresh token', async () => {
        const expired = validCredentials({ expires: Date.now() - 1 });
        let fetchCount = 0;
        const fetchImpl = async () => {
            fetchCount += 1;
            await Promise.resolve();
            return jsonResponse({
                access_token: accessToken('account-123', 'new@example.com'),
                expires_in: 1800
            });
        };

        const [first, second] = await Promise.all([
            ensureFreshChatGPTCredentials(expired, { fetchImpl }),
            ensureFreshChatGPTCredentials(expired, { fetchImpl })
        ]);

        expect(fetchCount).toBe(1);
        expect(first).toBe(second);
        expect(first.refresh).toBe('refresh-token');
        expect(first.email).toBe('new@example.com');
        expect(first.expires).toBeGreaterThan(Date.now());
    });
});

describe('ChatGPT Codex requests', () => {
    test('uses the subscription endpoint and Codex wire contract instead of the API key', () => {
        const provider = new OpenAIProvider();
        const [url, request] = provider.createRequest({
            model: 'gpt-5.6-sol',
            messages: [
                { role: 'system', parts: [{ type: 'text', content: 'Be precise.' }] },
                { role: 'user', parts: [{ type: 'text', content: 'Hello' }] }
            ],
            stream: false,
            options: { reasoningEffort: 'high' },
            apiKey: 'paid-api-key',
            chatGPTAuth: validCredentials(),
            settings: { max_tokens: 1234, temperature: 0.7 }
        });
        const body = JSON.parse(request.body);

        expect(url).toBe('https://chatgpt.com/backend-api/codex/responses');
        expect(request.headers.Authorization).toMatch(/^Bearer /);
        expect(request.headers['chatgpt-account-id']).toBe('account-123');
        expect(request.headers['OpenAI-Beta']).toBe('responses=experimental');
        expect(request.headers.originator).toBe('pi');
        expect(body).toEqual(expect.objectContaining({
            model: 'gpt-5.6-sol',
            instructions: 'Be precise.',
            store: false,
            stream: true,
            reasoning: { effort: 'high', summary: 'auto' }
        }));
        expect(body.max_output_tokens).toBeUndefined();
        expect(body.temperature).toBeUndefined();
    });

    test('ApiManager consumes the mandatory Codex stream for non-streaming UI mode', async () => {
        globalThis.chrome = createChromeMock();
        await chrome.storage.local.set({
            api_keys: {},
            chatgpt_auth: validCredentials(),
            models: { openai: { 'gpt-5.6-sol': 'GPT-5.6 Sol' } },
            max_tokens: 16000,
            temperature: 1,
            reasoning_effort: 'medium'
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
        const result = await api.callApi('gpt-5.6-sol', [
            { role: 'system', parts: [{ type: 'text', content: 'Be helpful.' }] },
            { role: 'user', parts: [{ type: 'text', content: 'Hi' }] }
        ], counter);

        expect(calls).toHaveLength(1);
        expect(calls[0].url).toBe('https://chatgpt.com/backend-api/codex/responses');
        expect(result).toEqual([
            { type: 'thought', content: 'Think' },
            { type: 'text', content: 'Hello' }
        ]);
        expect(counter.inputTokens).toBe(7);
        expect(counter.outputTokens).toBe(3);
    });
});
