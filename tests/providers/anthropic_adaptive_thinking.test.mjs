import { describe, test, expect, mock } from 'bun:test';
import { AnthropicProvider, MaxTokens, RoleEnum } from '../../src/js/LLMProviders.js';

const provider = new AnthropicProvider();
const messages = [{ role: RoleEnum.user, parts: [{ type: 'text', content: 'Hello' }] }];
const extendedEfforts = ['low', 'medium', 'high', 'xhigh', 'max'];

const createBody = (model, options = {}, maxTokens = 200000) => {
    const [, request] = provider.createRequest({
        model,
        messages,
        stream: false,
        options,
        apiKey: 'key',
        settings: { temperature: 0.5, max_tokens: maxTokens }
    });
    return JSON.parse(request.body);
};

describe('AnthropicProvider adaptive thinking', () => {
    test('derives Opus capabilities and efforts from version boundaries', () => {
        const cases = [
            ['claude-opus-3', false, false, false, []],
            ['claude-opus-4-5', false, true, true, []],
            ['claude-opus-4-6', true, true, true, ['low', 'medium', 'high', 'max']],
            ['claude-opus-4-7', true, true, true, extendedEfforts],
            ['claude-opus-4-8', true, true, true, extendedEfforts],
            ['claude-opus-5', true, true, true, extendedEfforts],
            ['claude-opus-6', true, true, true, extendedEfforts],
            ['claude-opus-10', true, true, true, extendedEfforts]
        ];

        for (const [model, reasoning, thinking, webSearch, efforts] of cases) {
            expect(provider.supports('reasoning', model)).toBe(reasoning);
            expect(provider.supports('thinking', model)).toBe(thinking);
            expect(provider.supports('web_search', model)).toBe(webSearch);
            expect(provider.getReasoningEfforts(model)).toEqual(efforts);
        }
    });

    test('uses adaptive thinking and the 128k cap from Opus 4.8 onward', () => {
        for (const model of ['claude-opus-4-8', 'claude-opus-5', 'claude-opus-6', 'claude-opus-10']) {
            const body = createBody(model, { reasoningEffort: 'xhigh' });
            expect(body.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
            expect(body.output_config).toEqual({ effort: 'xhigh' });
            expect(body.max_tokens).toBe(MaxTokens.anthropic_fable);
            expect(body.temperature).toBeUndefined();
        }
    });

    test('keeps the lower cap and effort set at the Opus 4.6 boundary', () => {
        const body = createBody('claude-opus-4-6', { reasoningEffort: 'xhigh' });
        expect(body.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
        expect(body.output_config).toEqual({ effort: 'max' });
        expect(body.max_tokens).toBe(MaxTokens.anthropic_thinking);
    });

    test('normalizes adaptive effort values at their version boundaries', () => {
        const cases = [
            ['claude-opus-4-6', 'minimal', 'low'],
            ['claude-opus-4-6', 'xhigh', 'max'],
            ['claude-opus-4-7', 'xhigh', 'xhigh'],
            ['claude-opus-5', 'invalid', 'high']
        ];
        for (const [model, input, expected] of cases) {
            expect(provider.normalizeReasoningEffort(model, input)).toBe(expected);
        }
    });

    test('keeps Fable 5 adaptive thinking always on with web search and 128k output', () => {
        const streamWriter = { setThinkingModel: mock() };
        const body = createBody('claude-fable-5', {
            reasoningEffort: 'xhigh',
            shouldThink: false,
            webSearch: true,
            streamWriter
        });

        expect(provider.supports('reasoning', 'claude-fable-5')).toBe(true);
        expect(provider.supports('thinking', 'claude-fable-5')).toBe(true);
        expect(provider.supports('web_search', 'claude-fable-5')).toBe(true);
        expect(body.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
        expect(body.output_config).toEqual({ effort: 'xhigh' });
        expect(body.max_tokens).toBe(MaxTokens.anthropic_fable);
        expect(body.tools).toEqual([{ type: 'web_search_20250305', name: 'web_search', max_uses: 2 }]);
        expect(streamWriter.setThinkingModel).toHaveBeenCalledTimes(1);
    });

    test('recognizes future Fable versions without version-specific updates', () => {
        for (const model of ['claude-fable-5-1', 'claude-fable-6']) {
            const body = createBody(model, {
                reasoningEffort: 'xhigh',
                shouldThink: false,
                webSearch: true
            });

            expect(provider.supports('reasoning', model)).toBe(true);
            expect(provider.supports('thinking', model)).toBe(true);
            expect(provider.supports('web_search', model)).toBe(true);
            expect(provider.getReasoningEfforts(model)).toEqual(extendedEfforts);
            expect(body.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
            expect(body.output_config).toEqual({ effort: 'xhigh' });
            expect(body.max_tokens).toBe(MaxTokens.anthropic_fable);
            expect(body.tools).toEqual([{ type: 'web_search_20250305', name: 'web_search', max_uses: 2 }]);
        }
    });

    test('keeps legacy budget-token thinking for Sonnet 4', () => {
        const body = createBody('claude-sonnet-4-5', { shouldThink: true }, 10000);
        expect(provider.supports('reasoning', 'claude-sonnet-4-5')).toBe(false);
        expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 6000 });
        expect(body.temperature).toBeUndefined();
    });
});
