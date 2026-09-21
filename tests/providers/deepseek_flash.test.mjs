import { describe, expect, test } from 'bun:test';
import { DeepSeekProvider, MaxTokens, RoleEnum } from '../../src/js/LLMProviders.js';

const provider = new DeepSeekProvider();
const messages = [
    { role: RoleEnum.system, parts: [{ type: 'text', content: 'Be precise.' }] },
    { role: RoleEnum.user, parts: [{ type: 'text', content: 'Hello' }] }
];

const createBody = (model, options = {}, settings = {}) => {
    const [, request] = provider.createRequest({
        model,
        messages,
        stream: true,
        options,
        apiKey: 'key',
        settings: { temperature: 0.7, max_tokens: 500_000, ...settings }
    });
    return JSON.parse(request.body);
};

describe('DeepSeek V4.1 Flash compatibility', () => {
    test('exposes the documented thinking and effort capabilities', () => {
        expect(provider.supports('reasoning', 'deepseek-flash')).toBe(true);
        expect(provider.supports('thinking', 'deepseek-flash')).toBe(true);
        expect(provider.supports('thinking_toggle', 'deepseek-flash')).toBe(false);
        expect(provider.isThinkingDefaultOn('deepseek-flash')).toBe(true);
        expect(provider.getReasoningEfforts('deepseek-flash')).toEqual(['low', 'high', 'max']);
    });

    test('sends thinking enabled with the selected effort and no temperature', () => {
        for (const effort of ['low', 'high', 'max']) {
            const body = createBody('deepseek-flash', { reasoningEffort: effort });
            expect(body.thinking).toEqual({ type: 'enabled' });
            expect(body.reasoning_effort).toBe(effort);
            expect(body.temperature).toBeUndefined();
        }
    });

    test('defaults to high and normalizes stale stored efforts', () => {
        expect(createBody('deepseek-flash').reasoning_effort).toBe('high');
        for (const stale of ['minimal', 'medium', 'xhigh', 'invalid']) {
            expect(createBody('deepseek-flash', { reasoningEffort: stale }).reasoning_effort).toBe('high');
        }
    });

    test('uses the 384k output limit for the V4 family', () => {
        expect(MaxTokens.deepseek_v4).toBe(384000);
        expect(createBody('deepseek-flash').max_tokens).toBe(384000);
        expect(createBody('deepseek-flash', {}, { max_tokens: 32000 }).max_tokens).toBe(32000);
    });

    test('keeps manually configured V4 ids and older models working', () => {
        for (const model of ['deepseek-v4-flash', 'deepseek-v4-pro']) {
            const body = createBody(model, { reasoningEffort: 'low' });
            expect(body.thinking).toEqual({ type: 'enabled' });
            expect(body.reasoning_effort).toBe('low');
            expect(body.max_tokens).toBe(MaxTokens.deepseek_v4);
        }

        const legacy = createBody('deepseek-chat', { shouldThink: true });
        expect(legacy.thinking).toEqual({ type: 'enabled' });
        expect(legacy.max_tokens).toBe(MaxTokens.deepseek);
        expect(legacy.temperature).toBe(0.7);
    });
});
