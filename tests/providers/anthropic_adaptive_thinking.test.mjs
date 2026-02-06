import { describe, test, expect, mock } from 'bun:test';
import { AnthropicProvider, MaxTokens, RoleEnum } from '../../src/js/LLMProviders.js';

describe('AnthropicProvider adaptive thinking', () => {
    const provider = new AnthropicProvider();
    const messages = [
        { role: RoleEnum.user, parts: [{ type: 'text', content: 'Hello' }] }
    ];

    test('supports reasoning for Opus 4.6', () => {
        expect(provider.supports('reasoning', 'claude-opus-4-6')).toBe(true);
    });

    test('keeps thinking support for Opus 4.6', () => {
        expect(provider.supports('thinking', 'claude-opus-4-6')).toBe(true);
    });

    test('does not enable reasoning levels for Sonnet 4.5', () => {
        expect(provider.supports('reasoning', 'claude-sonnet-4-5')).toBe(false);
    });

    test('uses adaptive thinking for Opus 4.6 and thinking counters', () => {
        const streamWriter = {
            setThinkingModel: mock(),
            addThinkingCounter: mock()
        };

        const [_, request] = provider.createRequest({
            model: 'claude-opus-4-6',
            messages,
            stream: true,
            options: {
                reasoningEffort: 'high',
                shouldThink: false,
                streamWriter
            },
            apiKey: 'key',
            settings: { temperature: 0.7, max_tokens: 100000 }
        });

        const body = JSON.parse(request.body);

        expect(body.thinking).toEqual({ type: 'adaptive', effort: 'high' });
        expect(body.max_tokens).toBe(MaxTokens.anthropic_thinking);
        expect(body.temperature).toBeUndefined();
        expect(streamWriter.setThinkingModel).toHaveBeenCalledTimes(1);
        expect(streamWriter.addThinkingCounter).toHaveBeenCalledTimes(1);
    });

    const effortMappings = {
        minimal: 'low',
        low: 'low',
        medium: 'medium',
        high: 'high',
        xhigh: 'max'
    };

    Object.entries(effortMappings).forEach(([inputEffort, expectedEffort]) => {
        test(`maps ${inputEffort} to ${expectedEffort} for adaptive thinking`, () => {
            const [_, request] = provider.createRequest({
                model: 'claude-opus-4-6',
                messages,
                stream: false,
                options: { reasoningEffort: inputEffort },
                apiKey: 'key',
                settings: { temperature: 0.5, max_tokens: 12000 }
            });

            const body = JSON.parse(request.body);
            expect(body.thinking).toEqual({ type: 'adaptive', effort: expectedEffort });
            expect(body.temperature).toBeUndefined();
        });
    });

    test('keeps legacy budget tokens thinking for Sonnet 4', () => {
        const [_, request] = provider.createRequest({
            model: 'claude-sonnet-4-5',
            messages,
            stream: false,
            options: { shouldThink: true },
            apiKey: 'key',
            settings: { temperature: 0.6, max_tokens: 10000 }
        });

        const body = JSON.parse(request.body);

        expect(body.thinking).toEqual({
            type: 'enabled',
            budget_tokens: 6000
        });
        expect(body.temperature).toBeUndefined();
    });
});
