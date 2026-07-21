import { describe, expect, mock, test } from 'bun:test';
import {
    AnthropicProvider,
    DEFAULT_MODELS,
    GeminiProvider,
    KimiProvider,
    MaxTokens,
    OpenAIProvider,
    RoleEnum
} from '../../src/js/LLMProviders.js';
import { ApiManager } from '../../src/js/api_manager.js';

const messages = [
    { role: RoleEnum.user, parts: [{ type: 'text', content: 'Hello' }] }
];

const createBody = (provider, model, options = {}, settings = {}) => {
    const [, request] = provider.createRequest({
        model,
        messages,
        stream: false,
        options,
        apiKey: 'key',
        settings: { temperature: 0.7, max_tokens: 2_000_000, ...settings }
    });
    return JSON.parse(request.body);
};

describe('new default model registry', () => {
    test('includes the new models without removing existing defaults', () => {
        expect(DEFAULT_MODELS.openai).toEqual(expect.objectContaining({
            'gpt-5.6-sol': 'GPT-5.6 Sol',
            'gpt-5.6-terra': 'GPT-5.6 Terra',
            'gpt-5.6-luna': 'GPT-5.6 Luna',
            'gpt-5.2': 'GPT-5.2'
        }));
        expect(DEFAULT_MODELS.anthropic['claude-opus-4-8']).toBe('Claude Opus 4.8');
        expect(DEFAULT_MODELS.anthropic['claude-fable-5']).toBe('Claude Fable 5');
        expect(DEFAULT_MODELS.kimi['kimi-k3']).toBe('Kimi K3');
        expect(DEFAULT_MODELS.kimi['kimi-k2.6']).toBe('Kimi 2.6');
        expect(DEFAULT_MODELS.gemini['gemini-3.5-flash']).toBe('Gemini 3.5 Flash');
        expect(DEFAULT_MODELS.gemini['gemini-3-flash-preview']).toBe('Gemini 3 Flash');
    });
});

describe('OpenAI GPT-5.6 compatibility', () => {
    const provider = new OpenAIProvider();
    const efforts = ['none', 'low', 'medium', 'high', 'xhigh', 'max'];

    test('exposes exact efforts and mode capability only for GPT-5.6', () => {
        for (const model of ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']) {
            expect(provider.getReasoningEfforts(model)).toEqual(efforts);
            expect(provider.supports('reasoning_mode', model)).toBe(true);
        }
        expect(provider.supports('reasoning_mode', 'gpt-5.2')).toBe(false);
    });

    test('uses Responses API fields, pro mode, and the 128k output cap', () => {
        const body = createBody(provider, 'gpt-5.6-sol', {
            reasoningEffort: 'max',
            reasoningMode: 'pro'
        });

        expect(body.max_output_tokens).toBe(MaxTokens.openai_56);
        expect(body.reasoning).toEqual({ effort: 'max', summary: 'auto', mode: 'pro' });
        expect(body.temperature).toBeUndefined();
    });

    test('normalizes stale effort and mode values and omits mode for older models', () => {
        const stale = createBody(provider, 'gpt-5.6-terra', {
            reasoningEffort: 'minimal',
            reasoningMode: 'invalid'
        });
        const invalid = createBody(provider, 'gpt-5.6-luna', { reasoningEffort: 'invalid' });
        const older = createBody(provider, 'gpt-5.2', { reasoningEffort: 'high', reasoningMode: 'pro' });

        expect(stale.reasoning.effort).toBe('none');
        expect(stale.reasoning.mode).toBe('standard');
        expect(invalid.reasoning.effort).toBe('medium');
        expect(older.reasoning.mode).toBeUndefined();
    });

    test('normalizes GPT-5.6-only efforts before sending older GPT-5 requests', () => {
        expect(createBody(provider, 'gpt-5.2', { reasoningEffort: 'max' }).reasoning.effort).toBe('medium');
        expect(createBody(provider, 'gpt-5.2', { reasoningEffort: 'none' }).reasoning.effort).toBe('medium');
    });
});

describe('Anthropic adaptive thinking compatibility', () => {
    const provider = new AnthropicProvider();

    test('exposes model-specific adaptive effort lists', () => {
        const extended = ['low', 'medium', 'high', 'xhigh', 'max'];
        expect(provider.getReasoningEfforts('claude-opus-4-8')).toEqual(extended);
        expect(provider.getReasoningEfforts('claude-opus-4-7')).toEqual(extended);
        expect(provider.getReasoningEfforts('claude-fable-5')).toEqual(extended);
        expect(provider.getReasoningEfforts('claude-opus-4-6')).toEqual(['low', 'medium', 'high', 'max']);
    });

    test('Opus 4.8 uses summarized adaptive thinking and 128k output', () => {
        const body = createBody(provider, 'claude-opus-4-8', { reasoningEffort: 'xhigh' });

        expect(body.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
        expect(body.output_config).toEqual({ effort: 'xhigh' });
        expect(body.max_tokens).toBe(MaxTokens.anthropic_fable);
        expect(body.temperature).toBeUndefined();
    });

    test('Fable stays always-on with explicit adaptive thinking and 128k output', () => {
        const body = createBody(provider, 'claude-fable-5', {
            reasoningEffort: 'xhigh',
            shouldThink: false
        });

        expect(body.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
        expect(body.output_config).toEqual({ effort: 'xhigh' });
        expect(body.max_tokens).toBe(MaxTokens.anthropic_fable);
    });

    test('normalizes old values according to each Opus version', () => {
        expect(createBody(provider, 'claude-opus-4-7', { reasoningEffort: 'xhigh' }).output_config.effort).toBe('xhigh');
        expect(createBody(provider, 'claude-opus-4-6', { reasoningEffort: 'xhigh' }).output_config.effort).toBe('max');
        expect(createBody(provider, 'claude-opus-4-8', { reasoningEffort: 'minimal' }).output_config.effort).toBe('low');
    });
});

describe('Gemini 3.5 Flash compatibility', () => {
    const provider = new GeminiProvider();

    test('exposes and sends the exact thinking levels', () => {
        const efforts = ['minimal', 'low', 'medium', 'high'];
        expect(provider.getReasoningEfforts('gemini-3.5-flash')).toEqual(efforts);

        for (const effort of efforts) {
            const body = createBody(provider, 'gemini-3.5-flash', { reasoningEffort: effort });
            expect(body.generationConfig.thinking_config).toEqual({
                thinkingLevel: effort,
                include_thoughts: true
            });
        }
    });

    test('clamps stale xhigh and max values to high', () => {
        for (const effort of ['xhigh', 'max']) {
            const body = createBody(provider, 'gemini-3.5-flash', { reasoningEffort: effort });
            expect(body.generationConfig.thinking_config.thinkingLevel).toBe('high');
        }
    });

    test('normalizes unsupported max on older Gemini reasoning models', () => {
        const body = createBody(provider, 'gemini-3-flash-preview', { reasoningEffort: 'max' });
        expect(body.generationConfig.thinking_config.thinkingLevel).toBe('medium');
    });
});

describe('Kimi K3 compatibility', () => {
    const provider = new KimiProvider();

    test('is always-on thinking with fixed max effort and native vision', () => {
        expect(provider.supports('thinking', 'kimi-k3')).toBe(true);
        expect(provider.supports('reasoning', 'kimi-k3')).toBe(true);
        expect(provider.supports('thinking_toggle', 'kimi-k3')).toBe(false);
        expect(provider.isThinkingDefaultOn('kimi-k3')).toBe(true);
        expect(provider.getReasoningEfforts('kimi-k3')).toEqual(['max']);
        expect(provider.supportsImageMessages()).toBe(true);
    });

    test('uses K3 token and reasoning fields without K2 controls or temperature', () => {
        const streamWriter = { setThinkingModel: mock() };
        const body = createBody(provider, 'kimi-k3', {
            shouldThink: false,
            reasoningEffort: 'low',
            streamWriter
        });

        expect(body.max_completion_tokens).toBe(MaxTokens.kimi_k3);
        expect(body.max_tokens).toBeUndefined();
        expect(body.reasoning_effort).toBe('max');
        expect(body.temperature).toBeUndefined();
        expect(body.thinking).toBeUndefined();
        expect(streamWriter.setThinkingModel).toHaveBeenCalledTimes(1);
    });

    test('replays assistant thought parts as reasoning_content', () => {
        const conversation = [
            { role: RoleEnum.user, parts: [{ type: 'text', content: 'First' }] },
            {
                role: RoleEnum.assistant,
                parts: [
                    { type: 'thought', content: 'reason one' },
                    { type: 'thought', content: 'reason two' },
                    { type: 'text', content: 'Answer' }
                ]
            },
            { role: RoleEnum.user, parts: [{ type: 'text', content: 'Continue' }] }
        ];
        const [, request] = provider.createRequest({
            model: 'kimi-k3',
            messages: conversation,
            stream: false,
            options: {},
            apiKey: 'key',
            settings: { temperature: 0.7, max_tokens: 1000 }
        });
        const body = JSON.parse(request.body);

        expect(body.messages[1]).toEqual({
            role: 'assistant',
            content: 'Answer',
            reasoning_content: 'reason one\nreason two'
        });
    });
});

describe('ApiManager reasoning capability delegation', () => {
    test('delegates effort, normalization, and mode capability to the resolved provider', () => {
        const settings = {
            models: {
                openai: { 'gpt-5.6-sol': 'GPT-5.6 Sol' },
                kimi: { 'kimi-k3': 'Kimi K3' }
            }
        };
        const settingsManager = {
            getSetting: key => settings[key],
            subscribeToSetting: () => {}
        };
        const api = new ApiManager({ settingsManager });

        expect(api.getReasoningEfforts('gpt-5.6-sol')).toEqual(['none', 'low', 'medium', 'high', 'xhigh', 'max']);
        expect(api.normalizeReasoningEffort('gpt-5.6-sol', 'minimal')).toBe('none');
        expect(api.hasReasoningModes('gpt-5.6-sol')).toBe(true);
        expect(api.getReasoningEfforts('kimi-k3')).toEqual(['max']);
        expect(api.hasReasoningModes('kimi-k3')).toBe(false);
    });
});
