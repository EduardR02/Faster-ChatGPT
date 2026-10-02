import { describe, test, expect } from 'bun:test';
import {
    OpenAIProvider, AnthropicProvider, GeminiProvider, GrokProvider,
    KimiProvider, DeepSeekProvider, MistralProvider, LlamaCppProvider
} from '../../src/js/LLMProviders.js';
import { TokenCounter } from '../../src/js/TokenCounter.js';
import { createMockWriter } from '../setup.mjs';

const user = content => ({ role: 'user', parts: [{ type: 'text', content }] });
const restore = value => JSON.parse(JSON.stringify(value));
const visible = parts => parts.filter(part => part.type === 'text').map(part => part.content).join('');
const totals = counter => [counter.inputTokens, counter.outputTokens, counter.cachedInputTokens, counter.cacheWriteInputTokens];
const settings = { temperature: 0.4, max_tokens: 16000 };

async function prepare(provider, model, messages = [user('Question')], options = {}) {
    const reasoningScope = await provider.getReasoningScope({ apiKey: 'same-key', options });
    const [, requestOptions] = provider.createRequest({ model, messages, options, settings, apiKey: 'same-key', stream: true });
    const responseState = await provider.prepareRequest({ model, requestOptions, reasoningScope });
    return { responseState, body: JSON.parse(requestOptions.body) };
}
function attach(provider, state, parts) {
    parts[0].providerState = provider.finalizeResponseState(state);
    return restore({ role: 'assistant', parts });
}
const responseUsage = { input_tokens: 100, output_tokens: 30,
    input_tokens_details: { cached_tokens: 40, cache_write_tokens: 20 } };
const chatUsage = { prompt_tokens: 100, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 40 } };
const chatResponse = usage => ({ choices: [{ message: { role: 'assistant', content: 'Answer' }, finish_reason: 'stop' }], usage });
const chatStream = usage => ({ choices: [], usage });
const responsesJSON = usage => ({ status: 'completed', output: [], usage });
const responsesStream = usage => ({ type: 'response.completed', response: responsesJSON(usage) });

// Cache fields are endpoint-specific, not inferred from other providers' lookalike schemas.
// OpenAI: https://developers.openai.com/api/docs/guides/prompt-caching
// xAI: https://docs.x.ai/developers/advanced-api-usage/prompt-caching/usage-and-pricing
// Anthropic: https://platform.claude.com/docs/en/build-with-claude/prompt-caching
// Gemini: https://ai.google.dev/api/generate-content#UsageMetadata
// Kimi: https://platform.kimi.ai/docs/guide/context-caching
// DeepSeek: https://api-docs.deepseek.com/guides/kv_cache
// Mistral: https://docs.mistral.ai/studio/conversations/advanced/prompt-caching
// llama.cpp: https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md
const usageCases = [
    { name: 'OpenAI', Provider: OpenAIProvider, usage: responseUsage, expected: [60, 30, 40, 20],
        plain: { input_tokens: 12, output_tokens: 0 }, json: responsesJSON, stream: responsesStream },
    { name: 'Grok', Provider: GrokProvider, usage: { ...responseUsage, input_tokens_details: { cached_tokens: 40 } },
        expected: [60, 30, 40, 0], plain: { input_tokens: 12, output_tokens: 0 }, json: responsesJSON, stream: responsesStream },
    { name: 'Anthropic', Provider: AnthropicProvider,
        usage: { input_tokens: 40, output_tokens: 30, cache_read_input_tokens: 40, cache_creation_input_tokens: 20 },
        expected: [60, 30, 40, 20], plain: { input_tokens: 12, output_tokens: 0 },
        json: usage => ({ content: [], stop_reason: 'end_turn', usage }),
        stream: usage => ({ type: 'message_start', message: { usage } }) },
    { name: 'Gemini', Provider: GeminiProvider,
        usage: { promptTokenCount: 100, cachedContentTokenCount: 40, candidatesTokenCount: 22, thoughtsTokenCount: 8 },
        expected: [60, 30, 40, 0], plain: { promptTokenCount: 12, candidatesTokenCount: 0 },
        json: usageMetadata => ({ candidates: [], usageMetadata }), stream: usageMetadata => ({ usageMetadata }) },
    { name: 'Kimi', Provider: KimiProvider,
        usage: { ...chatUsage, cached_tokens: 99, prompt_tokens_details: { cached_tokens: 40, cache_write_tokens: 20 } },
        expected: [60, 30, 40, 20], plain: { prompt_tokens: 12, completion_tokens: 0 }, json: chatResponse, stream: chatStream },
    { name: 'DeepSeek', Provider: DeepSeekProvider,
        usage: { prompt_tokens: 100, completion_tokens: 30, prompt_cache_hit_tokens: 40, prompt_cache_miss_tokens: 60 },
        expected: [60, 30, 40, 0], plain: { prompt_tokens: 12, completion_tokens: 0 }, json: chatResponse, stream: chatStream },
    { name: 'Mistral', Provider: MistralProvider, usage: chatUsage, expected: [60, 30, 40, 0],
        plain: { prompt_tokens: 12, completion_tokens: 0 }, json: chatResponse, stream: chatStream },
    { name: 'llama.cpp', Provider: LlamaCppProvider, usage: chatUsage, expected: [60, 30, 40, 0],
        plain: { prompt_tokens: 12, completion_tokens: 0 }, json: chatResponse, stream: chatStream }
];

describe('Provider cumulative cache accounting', () => {
    for (const entry of usageCases) {
        test(`${entry.name} JSON separates cached reads and writes without double counting`, () => {
            const provider = new entry.Provider();
            const counter = new TokenCounter();
            provider.handleResponse({ data: entry.json(entry.usage), tokenCounter: counter });
            expect(totals(counter)).toEqual(entry.expected);
            provider.handleResponse({ data: entry.json(entry.plain), tokenCounter: counter });
            expect(totals(counter)).toEqual([12, 0, 0, 0]);
        });
        test(`${entry.name} repeated streaming usage snapshots replace rather than add`, () => {
            const provider = new entry.Provider();
            const tokenCounter = new TokenCounter();
            const writer = createMockWriter();
            const parsed = entry.stream(entry.usage);
            provider.handleStream({ parsed, tokenCounter, writer });
            provider.handleStream({ parsed, tokenCounter, writer });
            expect(totals(tokenCounter)).toEqual(entry.expected);
        });
    }

    test('Anthropic hosted-search totals replace start usage and partial deltas retain absent categories', () => {
        const provider = new AnthropicProvider();
        const tokenCounter = new TokenCounter();
        const writer = createMockWriter();
        const send = parsed => provider.handleStream({ parsed, tokenCounter, writer });
        send({ type: 'message_start', message: { usage: { input_tokens: 2679, output_tokens: 3,
            cache_creation_input_tokens: 100, cache_read_input_tokens: 200 } } });
        send({ type: 'message_delta', usage: { input_tokens: 10682, output_tokens: 510,
            cache_creation_input_tokens: 150, cache_read_input_tokens: 300 } });
        expect(totals(tokenCounter)).toEqual([10832, 510, 300, 150]);
        send({ type: 'message_delta', usage: { output_tokens: 510 } });
        expect(totals(tokenCounter)).toEqual([10832, 510, 300, 150]);
        send({ type: 'message_delta', usage: { cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 } });
        expect(totals(tokenCounter)).toEqual([10682, 0, 0, 0]);
    });

    test('Mistral increasing usage snapshots keep full prompt totals across text chunks', () => {
        const provider = new MistralProvider();
        const tokenCounter = new TokenCounter();
        const writer = createMockWriter();
        for (const [text, output] of [['First ', 5], ['answer', 12]]) {
            provider.handleStream({ parsed: { data: { choices: [{ delta: { content: text } }],
                usage: { prompt_tokens: 100, completion_tokens: output, prompt_tokens_details: { cached_tokens: 64 } } } }, tokenCounter, writer });
        }
        expect(visible(writer.getFinalContent())).toBe('First answer');
        expect(totals(tokenCounter)).toEqual([36, 12, 64, 0]);
    });

    test('Kimi documented legacy cached_tokens is read only when detailed reads are absent', () => {
        const provider = new KimiProvider();
        const tokenCounter = new TokenCounter();
        provider.handleResponse({ data: chatResponse({ prompt_tokens: 100, completion_tokens: 30, cached_tokens: 40 }), tokenCounter });
        expect(totals(tokenCounter)).toEqual([60, 30, 40, 0]);
        provider.handleResponse({ data: chatResponse({ prompt_tokens: 100, completion_tokens: 30,
            cached_tokens: 40, prompt_tokens_details: { cached_tokens: 0 } }), tokenCounter });
        expect(totals(tokenCounter)).toEqual([100, 30, 0, 0]);
    });
});

const source = url => ({ type: 'url_citation', url, title: '[untrusted](javascript:alert(1))', start_index: 0, end_index: 6 });
const sourceURLs = ['https://example.com/source(one)', 'https://example.net/other'];
const sourcesTail = ' [1](https://example.com/source%28one%29) · [2](https://example.net/other)';
const citedOutput = () => [
    { type: 'reasoning', summary: [], encrypted_content: 'reasoning-cipher' },
    { type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Answer',
        annotations: [...sourceURLs.map(source), source(sourceURLs[0]), source('javascript:alert(1)')] }] }
];
const citedContent = () => [
    { type: 'server_tool_use', id: 'search', name: 'web_search', input: { query: 'Question' } },
    { type: 'web_search_tool_result', tool_use_id: 'search', content: [{ type: 'web_search_result',
        url: sourceURLs[0], title: 'Source', encrypted_content: 'search-cipher' }] },
    { type: 'text', text: 'Answer', citations: sourceURLs.map(url => ({ type: 'web_search_result_location', url,
        title: 'Source', encrypted_index: `citation-${url}`, cited_text: 'Answer' })) }
];

describe('Citation display and native continuation', () => {
    test('OpenAI JSON and SSE share safe clickable sources and replay untouched native payload', async () => {
        const provider = new OpenAIProvider();
        const model = 'gpt-6.1-sol';
        const output = citedOutput();
        const original = restore(output);
        const json = await prepare(provider, model);
        const parts = provider.handleResponse({ data: { status: 'completed', output }, responseState: json.responseState, tokenCounter: new TokenCounter() });
        expect(visible(parts)).toBe(`Answer${sourcesTail}`);
        const saved = attach(provider, json.responseState, parts);
        const next = await prepare(provider, model, [user('Question'), saved, user('Next')]);
        expect(next.body.input.slice(1, -1)).toEqual(original);

        const streaming = await prepare(provider, model);
        const writer = createMockWriter();
        const tokenCounter = new TokenCounter();
        const send = parsed => provider.handleStream({ parsed, writer, tokenCounter, responseState: streaming.responseState });
        send({ type: 'response.output_text.delta', output_index: 1, content_index: 0, delta: 'Answer' });
        // Event arrival order does not change the authoritative final citation order.
        for (const url of [...sourceURLs].reverse()) send({ type: 'response.output_text.annotation.added', annotation: source(url) });
        const completed = { type: 'response.completed', response: { status: 'completed', output } };
        send(completed);
        send(completed);
        expect(visible(writer.getFinalContent())).toBe(visible(parts));
        const streamed = attach(provider, streaming.responseState, writer.getFinalContent());
        expect((await prepare(provider, model, [user('Question'), streamed, user('Next')])).body.input.slice(1, -1)).toEqual(original);
        expect(output).toEqual(original);
    });

    test('Anthropic search results and citations replay without any thinking block in JSON and SSE', async () => {
        const provider = new AnthropicProvider();
        const model = 'claude-sonnet-4-5';
        const content = citedContent();
        const original = restore(content);
        const options = { shouldThink: false, webSearch: true };
        const json = await prepare(provider, model, [user('Question')], options);
        const parts = provider.handleResponse({ data: { stop_reason: 'end_turn', content }, responseState: json.responseState, tokenCounter: new TokenCounter() });
        expect(visible(parts)).toBe(`Answer${sourcesTail}`);
        const saved = attach(provider, json.responseState, parts);
        expect(saved.parts[0].providerState.content).toEqual(original);
        expect((await prepare(provider, model, [user('Question'), saved, user('Next')], options)).body.messages[1].content).toEqual(original);

        const streaming = await prepare(provider, model, [user('Question')], options);
        const writer = createMockWriter();
        const tokenCounter = new TokenCounter();
        const send = parsed => provider.handleStream({ parsed, writer, tokenCounter, responseState: streaming.responseState });
        send({ type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 1 } } });
        content.forEach((block, index) => {
            send({ type: 'content_block_start', index, content_block: block.type === 'text' ? { type: 'text', text: '' } : block });
            if (block.type === 'text') {
                send({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } });
                for (const citation of block.citations) send({ type: 'content_block_delta', index, delta: { type: 'citations_delta', citation } });
            }
            send({ type: 'content_block_stop', index });
        });
        send({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 20 } });
        send({ type: 'message_stop' });
        send({ type: 'message_stop' });
        expect(visible(writer.getFinalContent())).toBe(visible(parts));
        const streamed = attach(provider, streaming.responseState, writer.getFinalContent());
        expect((await prepare(provider, model, [user('Question'), streamed, user('Next')], options)).body.messages[1].content).toEqual(original);
        expect(content).toEqual(original);
    });

    test('citations remain visible even when no replay capsule was prepared', () => {
        for (const provider of [new OpenAIProvider(), new AnthropicProvider()]) {
            const writer = createMockWriter();
            const tokenCounter = new TokenCounter();
            const events = provider instanceof OpenAIProvider ? [
                { type: 'response.output_text.delta', delta: 'Answer' },
                { type: 'response.output_text.annotation.added', annotation: source(sourceURLs[0]) },
                { type: 'response.completed', response: { status: 'completed' } }
            ] : [
                { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Answer' } },
                { type: 'content_block_delta', delta: { type: 'citations_delta', citation: { url: sourceURLs[0] } } },
                { type: 'message_stop' }
            ];
            for (const parsed of events) provider.handleStream({ parsed, writer, tokenCounter });
            expect(visible(writer.getFinalContent())).toBe('Answer [1](https://example.com/source%28one%29)');
        }
    });
});

describe('OpenAI refusal display', () => {
    test('JSON refusal and streamed deltas are visible once and survive native continuation', async () => {
        const provider = new OpenAIProvider();
        const model = 'gpt-6.1-sol';
        const refusal = 'I cannot help with that request.';
        const output = [{ type: 'reasoning', summary: [], encrypted_content: 'cipher' },
            { type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'refusal', refusal }] }];
        const json = await prepare(provider, model);
        const parts = provider.handleResponse({ data: { status: 'completed', output }, tokenCounter: new TokenCounter(), responseState: json.responseState });
        expect(visible(parts)).toBe(refusal);
        const saved = attach(provider, json.responseState, parts);
        expect((await prepare(provider, model, [user('Question'), saved, user('Next')])).body.input.slice(1, -1)).toEqual(output);
        for (const deltas of [true, false]) {
            const state = await prepare(provider, model);
            const writer = createMockWriter();
            const tokenCounter = new TokenCounter();
            const send = parsed => provider.handleStream({ parsed, writer, tokenCounter, responseState: state.responseState });
            if (deltas) for (const delta of ['I cannot help ', 'with that request.']) send({ type: 'response.refusal.delta', output_index: 1, content_index: 0, delta });
            send({ type: 'response.refusal.done', output_index: 1, content_index: 0, refusal });
            send({ type: 'response.completed', response: { status: 'completed', output } });
            expect(visible(writer.getFinalContent())).toBe(refusal);
            const streamed = attach(provider, state.responseState, writer.getFinalContent());
            expect((await prepare(provider, model, [user('Question'), streamed, user('Next')])).body.input.slice(1, -1)).toEqual(output);
        }
    });
});

describe('Recoverable tool failures', () => {
    for (const [Provider, model] of [[OpenAIProvider, 'gpt-6.1-sol'], [GrokProvider, 'grok-4']]) {
        test(`${Provider.name} retains failed tool output within a completed answer`, async () => {
            const provider = new Provider();
            const output = [{ type: 'reasoning', summary: [], encrypted_content: 'cipher' },
                { type: 'web_search_call', id: 'search', status: 'failed', action: { type: 'search', query: 'Question' } },
                { type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Answer without search.' }] }];
            for (const stream of [false, true]) {
                const state = await prepare(provider, model);
                let parts;
                if (stream) {
                    const writer = createMockWriter();
                    const tokenCounter = new TokenCounter();
                    provider.handleStream({ parsed: { type: 'response.output_text.delta', output_index: 2, delta: 'Answer without search.' }, writer, tokenCounter, responseState: state.responseState });
                    provider.handleStream({ parsed: { type: 'response.completed', response: { status: 'completed', output } }, writer, tokenCounter, responseState: state.responseState });
                    parts = writer.getFinalContent();
                } else parts = provider.handleResponse({ data: { status: 'completed', output }, tokenCounter: new TokenCounter(), responseState: state.responseState });
                const answer = attach(provider, state.responseState, parts);
                expect((await prepare(provider, model, [user('Question'), answer, user('Next')])).body.input.slice(1, -1)).toEqual(output);
            }
            for (const index of [0, 2]) {
                const incomplete = restore(output);
                incomplete[index].status = 'incomplete';
                const state = await prepare(provider, model);
                provider.handleResponse({ data: { status: 'completed', output: incomplete }, tokenCounter: new TokenCounter(), responseState: state.responseState });
                expect(provider.finalizeResponseState(state.responseState)).toBeNull();
            }
        });
    }
});

describe('Mistral supported inner thinking union', () => {
    test('reference and tool_reference chunks retain order and metadata in JSON and streamed continuation', async () => {
        const provider = new MistralProvider();
        const model = 'mistral-small-latest';
        const content = [{ type: 'thinking', signature: 'signed', closed: true, thinking: [
            { type: 'text', text: 'Read sources.' }, { type: 'reference', reference_ids: [1, 'document'] },
            { type: 'tool_reference', tool: 'web_search', title: 'Source', url: 'https://example.com', description: 'Result' }
        ] }, { type: 'text', text: 'Answer' }];
        const message = { role: 'assistant', content };
        for (const stream of [false, true]) {
            const state = await prepare(provider, model);
            let parts;
            if (stream) {
                const writer = createMockWriter();
                const tokenCounter = new TokenCounter();
                provider.handleStream({ parsed: { choices: [{ delta: { content }, finish_reason: 'stop' }] }, writer, tokenCounter, responseState: state.responseState });
                parts = writer.getFinalContent();
            } else parts = provider.handleResponse({ data: { choices: [{ message, finish_reason: 'stop' }] }, tokenCounter: new TokenCounter(), responseState: state.responseState });
            expect(parts.map(part => [part.type, part.content])).toEqual([['thought', 'Read sources.'], ['text', 'Answer']]);
            const answer = attach(provider, state.responseState, parts);
            expect((await prepare(provider, model, [user('Question'), answer, user('Next')])).body.messages[1]).toEqual(message);
        }
        for (const inner of [{ type: 'reference', reference_ids: [null] }, { type: 'tool_reference', tool: 'web_search' }]) {
            const state = await prepare(provider, model);
            provider.handleResponse({ data: { choices: [{ message: { role: 'assistant', content: [
                { type: 'thinking', thinking: [inner] }, { type: 'text', text: 'Answer' }
            ] }, finish_reason: 'stop' }] }, tokenCounter: new TokenCounter(), responseState: state.responseState });
            expect(provider.finalizeResponseState(state.responseState)).toBeNull();
        }
    });
});

describe('Documented custom model and thinking boundaries', () => {
    test('GPT-6.1 Sol rejects none/minimal through supported low effort without prohibited sampling', () => {
        const provider = new OpenAIProvider();
        for (const requested of ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']) {
            const [, request] = provider.createRequest({ model: 'gpt-6.1-sol', messages: [user('Question')], stream: false,
                apiKey: 'key', settings, options: { reasoningEffort: requested, webSearch: true } });
            const body = JSON.parse(request.body);
            expect(body.model).toBe('gpt-6.1-sol');
            expect(body.reasoning.effort).toBe(['none', 'minimal'].includes(requested) ? 'low' : requested);
            expect(body.temperature).toBeUndefined();
            expect(body.tools).toEqual([{ type: 'web_search' }]);
        }
    });

    test('Sonnet 5.5 and Mythos 5.1 remain adaptive with no sampling even when shouldThink is false', () => {
        const provider = new AnthropicProvider();
        for (const model of ['claude-sonnet-5-5', 'claude-mythos-5-1']) for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) {
            const [, request] = provider.createRequest({ model, messages: [user('Question')], stream: false, apiKey: 'key', settings,
                options: { shouldThink: false, reasoningEffort: effort, webSearch: true } });
            const body = JSON.parse(request.body);
            expect(body.model).toBe(model);
            expect(body.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
            expect(body.output_config.effort).toBe(effort);
            expect(body.temperature).toBeUndefined();
            expect(body.max_tokens).toBe(settings.max_tokens);
            expect(body.tools[0].name).toBe('web_search');
        }
    });

    test('Gemini 2.5 Flash thinking off overrides dynamic default; Lite keeps its documented off default', () => {
        const provider = new GeminiProvider();
        for (const [model, shouldThink, expected] of [
            ['gemini-2.5-flash', false, { thinkingBudget: 0 }],
            ['gemini-2.5-flash', true, { thinkingBudget: -1, include_thoughts: true }],
            ['gemini-2.5-flash-lite', false, undefined]
        ]) {
            const [, request] = provider.createRequest({ model, messages: [user('Question')], stream: false,
                apiKey: 'key', settings, options: { shouldThink } });
            expect(JSON.parse(request.body).generationConfig.thinking_config).toEqual(expected);
        }
    });

    test('manual Anthropic budget cannot exceed user cap or equal max_tokens', () => {
        const provider = new AnthropicProvider();
        const request = max_tokens => provider.createRequest({ model: 'claude-sonnet-4-5', messages: [user('Question')],
            stream: false, apiKey: 'key', settings: { ...settings, max_tokens }, options: { shouldThink: true } });
        for (const cap of [1, 512, 1024]) expect(() => request(cap)).toThrow('requires max_tokens greater than 1024');
        const [, options] = request(1025);
        const body = JSON.parse(options.body);
        expect(body.max_tokens).toBe(1025);
        expect(body.thinking.budget_tokens).toBe(1024);
    });
});
