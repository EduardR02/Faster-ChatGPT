import { describe, test, expect } from 'bun:test';
import { GeminiProvider, KimiProvider, MistralProvider, GrokProvider, LlamaCppProvider } from '../../src/js/LLMProviders.js';
import { createMockWriter, createMockTokenCounter } from '../setup.mjs';
import { StreamWriterSimple } from '../../src/js/StreamWriter.js';

// Native fixtures follow generateContent Parts, Kimi assistant messages, Mistral ThinkChunks,
// xAI Responses output, and llama.cpp reasoning_content; these are not interchangeable.
// https://ai.google.dev/gemini-api/docs/generate-content/thought-signatures.md.txt
// https://ai.google.dev/gemini-api/docs/generate-content/image-generation#thinking-process
// https://platform.kimi.ai/docs/guide/use-thinking-models
// https://docs.mistral.ai/studio/conversations/reasoning
// https://docs.x.ai/developers/rest-api-reference/inference/responses
// https://docs.x.ai/developers/tools/web-search
// https://docs.x.ai/developers/tools/tool-usage-details
// https://docs.x.ai/developers/tools/citations#accessing-structured-inline-citation-data
// https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md
const restore = value => JSON.parse(JSON.stringify(value));
const user = content => ({ role: 'user', parts: [{ type: 'text', content }] });
const initial = () => [{ role: 'system', parts: [{ type: 'text', content: 'Stable instructions' }] }, user('First question')];
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
const local = (identity = 'localhost:8080|/models/loaded.gguf|template-one', supported = true) => ({
    raw: 'loaded-model', display: 'Loaded model', port: 8080, reasoning: { supported, identity }
});

async function prepare(provider, history, overrides = {}) {
    const model = overrides.model ?? providerCases.find(entry => provider instanceof entry.Provider).model;
    const apiKey = overrides.apiKey ?? 'account-one-key';
    const options = { shouldThink: true, reasoningEffort: 'high', ...overrides.options };
    const reasoningScope = await provider.getReasoningScope({ apiKey, options });
    const params = { model, messages: history, apiKey, stream: !!overrides.stream,
        settings: { max_tokens: 16000, temperature: 0.4 }, options: { ...options, reasoningScope } };
    const [url, requestOptions] = overrides.image
        ? provider.createImageRequest(params) : provider.createRequest(params);
    const responseState = await provider.prepareRequest({ model, requestOptions, reasoningScope });
    return { url, requestOptions, responseState, body: JSON.parse(requestOptions.body), model };
}

function attach(provider, responseState, parts, model) {
    const state = provider.finalizeResponseState(responseState);
    if (state) {
        if (!parts.length) parts.push({ type: 'thought', content: '' });
        parts[0].providerState = state;
    }
    // Stored histories contain origin bookkeeping even when a response was truncated.
    return restore({ role: 'assistant', parts: parts.map(part => ({ ...part, model })) });
}
function finish(provider, request, data, counter = createMockTokenCounter()) {
    const parts = provider.handleResponse({ data, responseState: request.responseState, tokenCounter: counter });
    return attach(provider, request.responseState, parts, request.model);
}
function streaming(provider, request) {
    const writer = createMockWriter();
    const tokenCounter = createMockTokenCounter();
    return { writer, tokenCounter,
        send: parsed => provider.handleStream({ parsed, writer, tokenCounter, responseState: request.responseState }),
        finish: () => attach(provider, request.responseState, writer.getFinalContent(), request.model) };
}
const geminiParts = () => [
    { text: 'Native summary', thought: true, thoughtSignature: 'signed-thought' },
    { text: 'First ', thoughtSignature: 'signed-first' },
    { text: 'answer', thoughtSignature: 'signed-second' },
    { text: '.', thoughtSignature: 'signed-final' },
    { text: '', thoughtSignature: 'signature-only-terminal' }
];
const geminiData = (parts, finishReason = 'STOP') => ({ candidates: [{ index: 0,
    content: { role: 'model', parts }, ...(finishReason && { finishReason }) }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 12, thoughtsTokenCount: 8 } });
const plainMessage = () => ({ role: 'assistant', content: 'First answer.', reasoning_content: 'Full returned native reasoning\nnot a summary' });
const chatData = (message, finishReason = 'stop') => ({ choices: [{ index: 0, message,
    ...(finishReason && { finish_reason: finishReason }) }], usage: { prompt_tokens: 10, completion_tokens: 20 } });
const mistralContent = () => [
    { type: 'thinking', thinking: [{ type: 'text', text: 'First trace.' }, { type: 'text', text: 'Second trace.' }] },
    { type: 'text', text: 'First ' },
    { type: 'thinking', thinking: [{ type: 'text', text: 'Check again.' }] },
    { type: 'text', text: 'answer.' }
];
const citation = () => ({ type: 'url_citation', url: 'https://example.com/source', title: 'Source', start_index: 0, end_index: 13 });
const grokOutput = () => [
    { type: 'reasoning', id: 'r-one', summary: [{ type: 'summary_text', text: 'Searching.' }], encrypted_content: 'grok-cipher-one' },
    { type: 'web_search_call', id: 'search-one', status: 'completed' },
    { type: 'reasoning', id: 'r-two', summary: [], encrypted_content: 'grok-cipher-two' },
    { type: 'message', id: 'answer-one', role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text: 'First answer.', annotations: [citation()] }] }
];
const grokData = (output, status = 'completed') => ({ id: 'response-one', status, output,
    usage: { input_tokens: 10, output_tokens: 20, output_tokens_details: { reasoning_tokens: 8 }, total_tokens: 30 } });
const providerCases = [
    { name: 'Gemini', Provider: GeminiProvider, model: 'gemini-3.5-flash', otherModel: 'gemini-3.8-flash',
        data: () => geminiData(geminiParts()), native: body => body.contents[1]?.parts.some(part => part.thoughtSignature),
        replay: body => body.contents[1].parts, expected: geminiParts, options: {} },
    { name: 'Kimi K3', Provider: KimiProvider, model: 'kimi-k3', otherModel: 'kimi-k2.6',
        data: () => chatData(plainMessage()), native: body => !!body.messages[2]?.reasoning_content,
        replay: body => body.messages[2], expected: plainMessage, options: {} },
    { name: 'Mistral', Provider: MistralProvider, model: 'mistral-small-latest', otherModel: 'mistral-medium-3-5',
        data: () => chatData({ role: 'assistant', content: mistralContent() }),
        native: body => Array.isArray(body.messages[2]?.content), replay: body => body.messages[2].content,
        expected: mistralContent, options: {} },
    { name: 'Grok', Provider: GrokProvider, model: 'grok-4', otherModel: 'grok-4.1-fast-reasoning',
        data: () => grokData(grokOutput()), native: body => body.input.some(item => item.type === 'reasoning'),
        replay: body => body.input.slice(1, -1), expected: grokOutput, options: { webSearch: true } },
    { name: 'llama.cpp', Provider: LlamaCppProvider, model: 'local-model', otherModel: 'different-selected-model',
        data: () => chatData(plainMessage()), native: body => !!body.messages[2]?.reasoning_content,
        replay: body => body.messages[2], expected: plainMessage, options: { localModelOverride: local() } }
];

for (const entry of providerCases) {
    describe(`${entry.name} native compatibility boundaries`, () => {
        test('JSON-restored complete response replays native state without exposing credentials or display metadata', async () => {
            const provider = new entry.Provider();
            const request = await prepare(provider, initial(), { options: entry.options });
            const answer = finish(provider, request, entry.data());
            const persisted = restore([...initial(), answer, user('Next days later')]);
            const next = await prepare(new entry.Provider(), persisted, { options: entry.options });
            expect(entry.replay(next.body)).toEqual(entry.expected());
            expect(JSON.stringify(answer)).not.toContain('account-one-key');
            expect(JSON.stringify(next.body)).not.toContain('providerState');
        });

        test('foreign model/provider, changed credential or loaded identity, edited prefix and merged turns omit state but retain originals', async () => {
            const provider = new entry.Provider();
            const request = await prepare(provider, initial(), { options: entry.options });
            const answer = finish(provider, request, entry.data());
            const original = restore(answer);
            const foreign = restore(answer);
            foreign.parts[0].providerState.provider = 'anthropic';
            const merged = restore(answer);
            merged.parts[0].providerState.replayable = false;
            const edited = restore(answer);
            edited.parts.find(part => part.type === 'text').content = 'Edited answer';
            const alternateScope = entry.name === 'llama.cpp'
                ? { options: { localModelOverride: local('localhost:8080|/models/swapped.gguf|template-one') } }
                : { apiKey: 'account-two-key' };
            const cases = [
                { history: [...initial(), answer, user('Next')], overrides: { model: entry.otherModel } },
                { history: [...initial(), answer, user('Next')], overrides: alternateScope },
                { history: [...initial(), foreign, user('Next')] },
                { history: [...initial(), merged, user('Next')] },
                { history: [initial()[0], user('Edited first question'), answer, user('Next')] },
                { history: [{ role: 'system', parts: [{ type: 'text', content: 'Edited instructions' }] }, initial()[1], answer, user('Next')] },
                { history: [...initial(), edited, user('Next')] }
            ];
            for (const scenario of cases) {
                const snapshot = restore(scenario.history);
                const next = await prepare(provider, scenario.history, { options: entry.options, ...scenario.overrides });
                expect(!!entry.native(next.body)).toBe(false);
                expect(JSON.stringify(next.body)).toContain(scenario.history.includes(edited) ? 'Edited answer' : 'First');
                expect(scenario.history).toEqual(snapshot);
            }
            expect(answer).toEqual(original);
            // Rejecting state for one request must not destroy compatible future replay.
            const compatible = await prepare(provider, [...initial(), answer, user('Next')], { options: entry.options });
            expect(entry.replay(compatible.body)).toEqual(entry.expected());
        });
    });
}

describe('Gemini full generateContent Parts', () => {
    test('stream preserves signed boundaries, unsigned text and the empty terminal signature', async () => {
        const provider = new GeminiProvider();
        const parts = [...geminiParts().slice(0, 3), { text: ' unsigned' }, ...geminiParts().slice(3)];
        const request = await prepare(provider, initial(), { stream: true });
        const stream = streaming(provider, request);
        for (const part of parts.slice(0, -1)) stream.send(geminiData([part], null));
        expect(provider.finalizeResponseState(request.responseState)).toBeNull();
        stream.send(geminiData([parts.at(-1)]));
        const answer = stream.finish();
        const next = await prepare(new GeminiProvider(), restore([...initial(), answer, user('Next')]));
        expect(next.body.contents[1].parts).toEqual(parts);
        expect(answer.parts.filter(part => part.type === 'text').map(part => part.content).join('')).toBe('First answer unsigned.');
        expect(answer.parts.map(part => part.content).join('')).not.toContain('signature-only-terminal');
    });

    test('image requests replay signed text/images in order and refuse edited image or text', async () => {
        const provider = new GeminiProvider();
        const options = { image: true, model: 'gemini-3-pro-image-preview' };
        const parts = [
            { text: 'Image summary', thought: true },
            { text: 'Here is the image.', thoughtSignature: 'image-text-signature' },
            { inlineData: { mimeType: 'image/png', data: png }, thoughtSignature: 'image-signature' },
            { text: '', thoughtSignature: 'image-terminal-signature' }
        ];
        const request = await prepare(provider, initial(), options);
        const answer = finish(provider, request, geminiData(parts));
        const next = await prepare(new GeminiProvider(), restore([...initial(), answer, user('Edit image')]), options);
        expect(next.body.contents[1].parts).toEqual(parts);
        for (const type of ['image', 'text']) {
            const edited = restore(answer);
            edited.parts.find(part => part.type === type).content = type === 'image' ? 'data:image/png;base64,Y2hhbmdlZA==' : 'Changed image caption';
            const changed = await prepare(provider, [...initial(), edited, user('Edit')], options);
            expect(changed.body.contents[1].parts.some(part => part.thoughtSignature)).toBe(false);
            expect(JSON.stringify(changed.body)).toContain(type === 'image' ? 'Y2hhbmdlZA==' : 'Changed image caption');
        }
    });

    test('streamed signed images retain the same native Parts after real writer image/text boundaries', async () => {
        // Rendering itself is parent-owned smoke coverage; retain the production writer state machine.
        const div = () => ({
            textContent: '', classList: { add() {}, remove() {} }, append() {},
            closest() { return null; }, parentElement: { appendChild() {} }
        });
        class ImageWriter extends StreamWriterSimple {
            scheduleRender() { this.flushBufferedContent(); }
            updateTextContent() {}
            updateImageContent() {}
        }
        const writer = new ImageWriter(div(), div);
        const provider = new GeminiProvider();
        const options = { image: true, model: 'gemini-3-pro-image-preview' };
        const request = await prepare(provider, initial(), options);
        const parts = [
            { text: 'Image summary', thought: true },
            { text: 'Here is the image.', thoughtSignature: 'image-text-signature' },
            { inlineData: { mimeType: 'image/png', data: png }, thoughtSignature: 'stream-image-signature' },
            { text: 'Image caption.' },
            { text: '', thoughtSignature: 'terminal-image-signature' }
        ];
        for (const [index, part] of parts.entries()) {
            provider.handleStream({ parsed: geminiData([part], index === parts.length - 1 ? 'STOP' : null),
                responseState: request.responseState, writer, tokenCounter: createMockTokenCounter() });
        }
        writer.finalizeCurrentPart();
        const answer = attach(provider, request.responseState, writer.parts, request.model);
        expect(answer.parts.filter(part => part.type === 'image').map(part => part.content)).toEqual([`data:image/png;base64,${png}`]);
        expect(answer.parts.filter(part => part.type === 'text').map(part => part.content)).toEqual(['Here is the image.', 'Image caption.']);
        const next = await prepare(provider, restore([...initial(), answer, user('Edit the image')]), options);
        expect(next.body.contents[1].parts).toEqual(parts);
    });

    test('legacy assistant signatures are not provenance, but original user media signatures survive', async () => {
        const provider = new GeminiProvider();
        const history = [user('First'), { role: 'assistant', parts: [
            { type: 'thought', content: 'Legacy summary', thoughtSignature: 'unvalidated-thought' },
            { type: 'text', content: 'Visible answer', thoughtSignature: 'unvalidated-answer' }
        ] }, { role: 'user', parts: [{ type: 'image', content: `data:image/png;base64,${png}`, thoughtSignature: 'user-media-signature' }] }];
        const original = restore(history);
        const request = await prepare(provider, history);
        expect(request.body.contents[1].parts).toEqual([{ text: 'Visible answer' }]);
        expect(request.body.contents[2].parts[0].thoughtSignature).toBe('user-media-signature');
        expect(history).toEqual(original);
    });

    test('MAX_TOKENS, missing finishReason, blocked response and unfinished stream cannot replay signatures', async () => {
        const provider = new GeminiProvider();
        for (const data of [geminiData(geminiParts(), 'MAX_TOKENS'), geminiData(geminiParts(), null),
            { candidates: [], promptFeedback: { blockReason: 'SAFETY' } }]) {
            const request = await prepare(provider, initial());
            const answer = finish(provider, request, data);
            const next = await prepare(provider, [...initial(), answer, user('Next')]);
            expect(next.body.contents[1].parts.some(part => part.thoughtSignature)).toBe(false);
        }
        const request = await prepare(provider, initial(), { stream: true });
        const stream = streaming(provider, request);
        stream.send(geminiData(geminiParts(), null));
        const next = await prepare(provider, [...initial(), stream.finish(), user('Next')]);
        expect(next.body.contents[1].parts.some(part => part.thoughtSignature)).toBe(false);
    });

    test('explicit Gemini JSON errors are surfaced without replayable signatures', async () => {
        const provider = new GeminiProvider();
        const request = await prepare(provider, initial());
        expect(() => finish(provider, request, {
            ...geminiData(geminiParts()), error: { message: 'Generation failed' }
        })).toThrow('Generation failed');
        expect(provider.finalizeResponseState(request.responseState)).toBeNull();
    });
});

describe('Kimi K3 native reasoning origin', () => {
    test('same-model known legacy reasoning is accepted, DeepSeek/unknown/foreign native thoughts are excluded', async () => {
        const history = [...initial(), { role: 'assistant', parts: [
            { type: 'thought', content: 'Same K3 trace', model: 'kimi-k3' },
            { type: 'thought', content: 'DeepSeek trace', model: 'deepseek-flash' },
            { type: 'thought', content: 'Unknown trace' },
            { type: 'thought', content: 'Foreign summary', model: 'kimi-k3', providerState: { provider: 'openai' } },
            { type: 'text', content: 'Visible answer' }
        ] }, user('Next')];
        const original = restore(history);
        const request = await prepare(new KimiProvider(), history);
        // A capsule anywhere marks the whole turn as native-origin, never eligible for legacy promotion.
        expect(request.body.messages[2]).toEqual({ role: 'assistant', content: 'Visible answer' });
        const legacy = restore(history);
        legacy[2].parts = legacy[2].parts.filter(part => !part.providerState);
        const accepted = await prepare(new KimiProvider(), legacy);
        expect(accepted.body.messages[2]).toEqual({ role: 'assistant', content: 'Visible answer', reasoning_content: 'Same K3 trace' });
        expect(history).toEqual(original);
    });

    test('stream reconstructs full reasoning_content, not visible answer or a foreign summary', async () => {
        const provider = new KimiProvider();
        const request = await prepare(provider, initial(), { stream: true });
        const stream = streaming(provider, request);
        stream.send({ choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: 'Full returned ' }, finish_reason: null }] });
        stream.send({ choices: [{ index: 0, delta: { reasoning_content: 'native reasoning\nnot a summary' }, finish_reason: null }] });
        stream.send({ choices: [{ index: 0, delta: { content: 'First answer.' }, finish_reason: null }] });
        const pending = await prepare(provider, [...initial(), stream.finish(), user('Next')]);
        expect(pending.body.messages[2]).toEqual({ role: 'assistant', content: 'First answer.' });
        stream.send({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
        const next = await prepare(provider, restore([...initial(), stream.finish(), user('Next')]));
        expect(next.body.messages[2]).toEqual(plainMessage());
    });

    test('truncated and missing-stop new responses never become replayable legacy thoughts', async () => {
        const provider = new KimiProvider();
        for (const reason of ['length', null]) {
            const request = await prepare(provider, initial());
            const answer = finish(provider, request, chatData(plainMessage(), reason));
            const next = await prepare(provider, [...initial(), answer, user('Next')]);
            expect(next.body.messages[2]).toEqual({ role: 'assistant', content: 'First answer.' });
        }
        const request = await prepare(provider, initial(), { stream: true });
        const stream = streaming(provider, request);
        stream.send({ choices: [{ index: 0, delta: plainMessage(), finish_reason: null }] });
        const next = await prepare(provider, [...initial(), stream.finish(), user('Next')]);
        expect(next.body.messages[2]).toEqual({ role: 'assistant', content: 'First answer.' });
    });
});

describe('Mistral typed native thinking', () => {
    test('documented list-thinking to mixed-list to string transition replays complete typed content', async () => {
        const provider = new MistralProvider();
        const request = await prepare(provider, initial(), { stream: true });
        const stream = streaming(provider, request);
        stream.send({ data: { choices: [{ index: 0, delta: { role: 'assistant', content: [
            { type: 'thinking', thinking: [{ type: 'text', text: 'First trace.' }] }
        ] }, finish_reason: null }] } });
        stream.send({ data: { choices: [{ index: 0, delta: { content: [
            { type: 'thinking', thinking: [{ type: 'text', text: 'Second trace.' }] },
            { type: 'text', text: 'First ' }
        ] }, finish_reason: null }] } });
        stream.send({ data: { choices: [{ index: 0, delta: { content: 'answer.' }, finish_reason: null }] } });
        expect(provider.finalizeResponseState(request.responseState)).toBeNull();
        stream.send({ data: { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 20 } } });
        const answer = stream.finish();
        expect(answer.parts.map(part => [part.type, part.content])).toEqual([
            ['thought', 'First trace.Second trace.'], ['text', 'First answer.']
        ]);
        const next = await prepare(provider, restore([...initial(), answer, user('Next')]));
        expect(next.body.messages[2].content).toEqual([
            { type: 'thinking', thinking: [{ type: 'text', text: 'First trace.Second trace.' }] },
            { type: 'text', text: 'First answer.' }
        ]);
    });

    test('current reasoning models accept high/none; Large is not promoted to a reasoning model', async () => {
        const provider = new MistralProvider();
        for (const model of ['mistral-small-latest', 'mistral-medium-3-5']) {
            expect(provider.supports('reasoning', model)).toBe(true);
            expect(new Set(provider.getReasoningEfforts(model))).toEqual(new Set(['none', 'high']));
            for (const reasoningEffort of ['high', 'none']) {
                const request = await prepare(provider, initial(), { model, options: { reasoningEffort } });
                expect(request.body.reasoning_effort).toBe(reasoningEffort);
            }
        }
        expect(provider.supports('reasoning', 'mistral-large-latest')).toBe(false);
        const large = await prepare(provider, initial(), { model: 'mistral-large-latest' });
        expect(large.body.reasoning_effort).toBeUndefined();
    });

    test('length-limited or unfinished typed chunks fall back to visible answer only', async () => {
        const provider = new MistralProvider();
        for (const reason of ['length', null]) {
            const request = await prepare(provider, initial());
            const answer = finish(provider, request, chatData({ role: 'assistant', content: mistralContent() }, reason));
            const next = await prepare(provider, [...initial(), answer, user('Next')]);
            expect(next.body.messages[2]).toEqual({ role: 'assistant', content: 'First \nanswer.' });
        }
        const request = await prepare(provider, initial(), { stream: true });
        const stream = streaming(provider, request);
        stream.send({ data: { choices: [{ index: 0, delta: {
            role: 'assistant', content: [
                { type: 'thinking', thinking: [{ type: 'text', text: 'Incomplete trace' }] },
                { type: 'text', text: 'Partial answer' }
            ]
        }, finish_reason: null }] } });
        const next = await prepare(provider, [...initial(), stream.finish(), user('Next')]);
        expect(next.body.messages[2]).toEqual({ role: 'assistant', content: 'Partial answer' });
    });
});

describe('Grok Responses encrypted output and search', () => {
    test('request and JSON response use xAI Responses with hosted search, citations and inclusive usage totals', async () => {
        const provider = new GrokProvider();
        const request = await prepare(provider, initial(), { options: { webSearch: true } });
        expect(request.url).toBe('https://api.x.ai/v1/responses');
        expect(request.body.store).toBe(false);
        expect(request.body.include).toContain('reasoning.encrypted_content');
        expect(request.body.tools).toEqual([{ type: 'web_search' }]);
        expect(request.body.search_parameters).toBeUndefined();
        expect(request.body.messages).toBeUndefined();
        const counter = createMockTokenCounter();
        const answer = finish(provider, request, grokData(grokOutput()), counter);
        const text = answer.parts.filter(part => part.type === 'text').map(part => part.content).join('');
        expect(text).toContain('First answer.');
        expect(text).toContain('https://example.com/source');
        expect(text).not.toContain('grok-cipher');
        expect([counter.inputTokens, counter.outputTokens]).toEqual([10, 20]);
        const next = await prepare(provider, restore([...initial(), answer, user('Next')]), { options: { webSearch: true } });
        expect(next.body.input.slice(1, -1)).toEqual(grokOutput());
    });

    test('indexed completion, reasoning/text deltas and annotations stream without ciphertext leakage or token double counting', async () => {
        const provider = new GrokProvider();
        const request = await prepare(provider, initial(), { stream: true, options: { webSearch: true } });
        const stream = streaming(provider, request);
        const output = grokOutput();
        stream.send({ type: 'response.reasoning_summary_text.delta', delta: 'Searching.' });
        stream.send({ type: 'response.output_text.delta', output_index: 3, content_index: 0, delta: 'First ' });
        stream.send({ type: 'response.output_text.delta', output_index: 3, content_index: 0, delta: 'answer.' });
        stream.send({ type: 'response.output_text.annotation.added', output_index: 3, content_index: 0, annotation_index: 0, annotation: citation() });
        for (const index of [3, 1, 0, 2]) stream.send({ type: 'response.output_item.done', output_index: index, item: output[index] });
        expect(provider.finalizeResponseState(request.responseState)).toBeNull();
        stream.send({ type: 'response.completed', response: { status: 'completed', usage: grokData(output).usage } });
        const answer = stream.finish();
        const text = answer.parts.filter(part => part.type === 'text').map(part => part.content).join('');
        expect(text).toContain('First answer.');
        expect(text).toContain('https://example.com/source');
        expect(text).not.toContain('grok-cipher');
        expect([stream.tokenCounter.inputTokens, stream.tokenCounter.outputTokens]).toEqual([10, 20]);
        const next = await prepare(provider, restore([...initial(), answer, user('Next')]), { options: { webSearch: true } });
        expect(next.body.input.slice(1, -1)).toEqual(output);
    });

    test('failed/incomplete, missing indexed items and readable-summary-only output cannot replay native state', async () => {
        const provider = new GrokProvider();
        for (const data of [grokData(grokOutput(), 'incomplete'),
            grokData([{ type: 'reasoning', summary: [{ type: 'summary_text', text: 'Readable only' }] }, grokOutput()[3]]),
            grokData([{ ...grokOutput()[0], status: 'in_progress' }, grokOutput()[3]])]) {
            const request = await prepare(provider, initial(), { options: { webSearch: true } });
            const answer = finish(provider, request, data);
            const next = await prepare(provider, [...initial(), answer, user('Next')], { options: { webSearch: true } });
            expect(next.body.input.some(item => item.type === 'reasoning')).toBe(false);
        }
        const request = await prepare(provider, initial(), { stream: true });
        const stream = streaming(provider, request);
        stream.send({ type: 'response.output_item.done', output_index: 1, item: grokOutput()[0] });
        stream.send({ type: 'response.completed', response: { status: 'completed' } });
        const next = await prepare(provider, [...initial(), stream.finish(), user('Next')]);
        expect(next.body.input.some(item => item.type === 'reasoning')).toBe(false);
    });

    test('explicit Responses errors are surfaced and never finalize native output', async () => {
        const provider = new GrokProvider();
        const json = await prepare(provider, initial());
        expect(() => provider.handleResponse({
            data: { ...grokData(grokOutput()), error: { message: 'Generation failed' } },
            responseState: json.responseState, tokenCounter: createMockTokenCounter()
        })).toThrow('Generation failed');
        expect(provider.finalizeResponseState(json.responseState)).toBeNull();
        const request = await prepare(provider, initial(), { stream: true });
        const stream = streaming(provider, request);
        stream.send({ type: 'response.output_item.done', output_index: 0, item: grokOutput()[0] });
        expect(() => stream.send({ type: 'response.failed', response: { error: { message: 'Stream failed' } } })).toThrow('Stream failed');
        expect(provider.finalizeResponseState(request.responseState)).toBeNull();
    });
});

describe('llama.cpp loaded-model/template provenance', () => {
    test('same loaded identity survives API key rotation; changed template/server and false/unknown capability disable replay', async () => {
        const provider = new LlamaCppProvider();
        const options = { localModelOverride: local() };
        const request = await prepare(provider, initial(), { options });
        const answer = finish(provider, request, chatData(plainMessage()));
        const same = await prepare(provider, restore([...initial(), answer, user('Next')]), { apiKey: 'rotated-irrelevant-key', options });
        expect(same.body.messages[2]).toEqual(plainMessage());
        const unknownCapability = local();
        delete unknownCapability.reasoning.supported;
        for (const override of [local('localhost:8080|/models/loaded.gguf|template-two'),
            { ...local('localhost:9090|/models/loaded.gguf|template-one'), port: 9090 },
            local(undefined, false), { raw: 'loaded-model', display: 'Loaded model', port: 8080 },
            unknownCapability]) {
            const next = await prepare(provider, [...initial(), answer, user('Next')], { options: { localModelOverride: override } });
            expect(next.body.messages[2]).toEqual({ role: 'assistant', content: 'First answer.' });
        }
    });

    test('local streaming reasoning captures complete native message only after stop', async () => {
        const provider = new LlamaCppProvider();
        const options = { localModelOverride: local() };
        const request = await prepare(provider, initial(), { stream: true, options });
        const stream = streaming(provider, request);
        stream.send({ choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: plainMessage().reasoning_content }, finish_reason: null }] });
        stream.send({ choices: [{ index: 0, delta: { content: 'First answer.' }, finish_reason: null }] });
        const incomplete = stream.finish();
        const fallback = await prepare(provider, [...initial(), incomplete, user('Next')], { options });
        expect(fallback.body.messages[2]).toEqual({ role: 'assistant', content: 'First answer.' });
        stream.send({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 20 } });
        const next = await prepare(provider, restore([...initial(), stream.finish(), user('Next')]), { options });
        expect(next.body.messages[2]).toEqual(plainMessage());
    });

    test('length-limited local JSON and unsupported templates never replay reasoning while ordinary answers remain usable', async () => {
        const provider = new LlamaCppProvider();
        for (const options of [
            { localModelOverride: local() },
            { localModelOverride: local(undefined, false) },
            { localModelOverride: { raw: 'loaded-model', display: 'Loaded model', port: 8080 } }
        ]) {
            const request = await prepare(provider, initial(), { options });
            const data = chatData(plainMessage(), options.localModelOverride.reasoning?.supported ? 'length' : 'stop');
            const answer = finish(provider, request, data);
            expect(answer.parts.filter(part => part.type === 'text').map(part => part.content)).toEqual(['First answer.']);
            const next = await prepare(provider, [...initial(), answer, user('Next')], { options });
            expect(next.body.messages[2]).toEqual({ role: 'assistant', content: 'First answer.' });
        }
    });
});
