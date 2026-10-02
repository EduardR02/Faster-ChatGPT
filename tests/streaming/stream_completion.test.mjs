import { describe, test, expect } from 'bun:test';
import { ApiManager } from '../../src/js/api_manager.js';
import { OpenAIProvider, KimiProvider, DeepSeekProvider, LlamaCppProvider } from '../../src/js/LLMProviders.js';
import { TokenCounter } from '../../src/js/TokenCounter.js';
import { createMockWriter } from '../setup.mjs';

const sse = events => new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), {
    headers: { 'Content-Type': 'text/event-stream' }
});
const user = { role: 'user', parts: [{ type: 'text', content: 'Question' }] };
const completion = { choices: [{ delta: {}, finish_reason: 'stop' }] };

async function capture(provider, model) {
    const reasoningScope = await provider.getReasoningScope({ apiKey: 'test-key', options: {} });
    const [, requestOptions] = provider.createRequest({ model, messages: [user], stream: true,
        apiKey: 'test-key', settings: { max_tokens: 16000, temperature: 1 }, options: {} });
    return provider.prepareRequest({ model, requestOptions, reasoningScope });
}

const stream = (provider, response, writer, state = null, signal = null) =>
    ApiManager.prototype.handleStreamResponse.call({}, response, 'test-model', new TokenCounter(),
        writer, state, signal, provider);

describe('Provider stream completion boundaries', () => {
    test('OpenAI explicit failure rejects partial output and cannot produce replayable history', async () => {
        const provider = new OpenAIProvider();
        for (const failure of [
            { type: 'response.failed', response: { status: 'failed', error: { message: 'Generation failed' } } },
            { type: 'error', message: 'Generation failed' }
        ]) {
            const state = await capture(provider, 'gpt-6-sol');
            const writer = createMockWriter();
            await expect(stream(provider, sse([
                { type: 'response.output_text.delta', delta: 'Partial answer' }, failure
            ]), writer, state)).rejects.toThrow('Generation failed');
            expect(writer._processedContent.map(part => part.content)).toEqual(['Partial answer']);
            expect(writer.parts.some(part => part.providerState)).toBe(false);
        }
    });

    test('Responses EOF and explicit incomplete events do not report success', async () => {
        const provider = new OpenAIProvider();
        const text = { type: 'response.output_text.delta', delta: 'Partial answer' };
        await expect(stream(provider, sse([text]), createMockWriter())).rejects.toThrow('stream ended before completion');
        await expect(stream(provider, sse([text, {
            type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' } }
        }]), createMockWriter())).rejects.toThrow('max_output_tokens');
    });

    test('Kimi requires DONE after stop before native reasoning becomes replayable', async () => {
        const provider = new KimiProvider();
        const events = [
            { choices: [{ delta: { role: 'assistant', reasoning_content: 'Complete trace' }, finish_reason: null }] },
            { choices: [{ delta: { content: 'Answer' }, finish_reason: null }] }, completion
        ];
        const incompleteState = await capture(provider, 'kimi-k3');
        const incompleteWriter = createMockWriter();
        await expect(stream(provider, sse(events), incompleteWriter, incompleteState))
            .rejects.toThrow('stream ended before completion');
        expect(incompleteWriter.parts.some(part => part.providerState)).toBe(false);

        const state = await capture(provider, 'kimi-k3');
        const data = await sse(events).text();
        const parts = await stream(provider, new Response(data + 'data: [DONE]'), null, state);
        expect(parts.filter(part => part.type === 'text').map(part => part.content)).toEqual(['Answer']);
        expect(parts[0].providerState.message.reasoning_content).toBe('Complete trace');
    });

    test('DeepSeek rejects missing finish or missing DONE and preserves complete terminal usage', async () => {
        const provider = new DeepSeekProvider();
        const text = { choices: [{ delta: { content: 'Answer' }, finish_reason: null }] };
        for (const events of [[text], [text, completion]]) {
            await expect(stream(provider, sse(events), createMockWriter()))
                .rejects.toThrow('stream ended before completion');
        }
        const counter = new TokenCounter();
        const data = await sse([text, { choices: [{ delta: {}, finish_reason: 'stop' }], usage: {
            prompt_tokens: 20, completion_tokens: 7, prompt_cache_hit_tokens: 14, prompt_cache_miss_tokens: 6
        } }]).text();
        const parts = await ApiManager.prototype.handleStreamResponse.call({}, new Response(data + 'data: [DONE]'),
            'deepseek-flash', counter, null, null, null, provider);
        expect(parts).toEqual([{ type: 'text', content: 'Answer' }]);
        expect([counter.inputTokens, counter.cachedInputTokens, counter.outputTokens]).toEqual([6, 14, 7]);
    });

    test('token-limit termination remains visible but cannot be mistaken for a complete answer', async () => {
        const writer = createMockWriter();
        await expect(stream(new LlamaCppProvider(), sse([
            { choices: [{ delta: { content: 'Truncated answer' }, finish_reason: 'length' }] }
        ]), writer)).rejects.toThrow('length');
        expect(writer._processedContent.map(part => part.content)).toEqual(['Truncated answer']);
    });

    test('failure cancels a live response body and releases its reader lock', async () => {
        let cancelled = false;
        const encoder = new TextEncoder();
        const body = new ReadableStream({
            start(controller) {
                controller.enqueue(encoder.encode('data: {"type":"error","message":"Failure"}\n\n'));
            },
            cancel() { cancelled = true; }
        });
        await expect(stream(new OpenAIProvider(), new Response(body), createMockWriter())).rejects.toThrow('Failure');
        expect(cancelled).toBe(true);
        expect(body.locked).toBe(false);
    });
});
