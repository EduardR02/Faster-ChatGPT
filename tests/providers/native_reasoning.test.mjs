import { describe, test, expect } from 'bun:test';
import { OpenAIProvider, AnthropicProvider, DeepSeekProvider } from '../../src/js/LLMProviders.js';
import { createMockWriter, createMockTokenCounter } from '../setup.mjs';

const user = text => ({ role: 'user', parts: [{ type: 'text', content: text }] });
const system = text => ({ role: 'system', parts: [{ type: 'text', content: text }] });
const restore = value => JSON.parse(JSON.stringify(value));
const initial = () => [system('Stable instructions'), user('First question')];
const defaults = provider => provider instanceof OpenAIProvider ? 'gpt-6-sol' : 'claude-opus-5-5';

async function prepare(provider, messages, overrides = {}) {
    const model = overrides.model || defaults(provider);
    const apiKey = overrides.apiKey ?? 'account-one-key';
    const chatGPTAuth = overrides.chatGPTAuth;
    const reasoningScope = await provider.getReasoningScope({ apiKey, chatGPTAuth });
    const [, requestOptions] = provider.createRequest({
        model, messages, apiKey, chatGPTAuth, stream: !!overrides.stream,
        settings: { max_tokens: 16000, temperature: 0.4 },
        options: { reasoningScope, shouldThink: true, ...overrides.options }
    });
    if (overrides.transform) overrides.transform(requestOptions);
    const responseState = await provider.prepareRequest({ model, requestOptions, reasoningScope });
    return { responseState, requestOptions, body: JSON.parse(requestOptions.body) };
}

function finish(provider, responseState, data) {
    const parts = provider.handleResponse({ data, responseState, tokenCounter: createMockTokenCounter() });
    const state = provider.finalizeResponseState(responseState);
    if (state) {
        if (!parts.length) parts.push({ type: 'thought', content: '' });
        parts[0].providerState = state;
    }
    return restore({ role: 'assistant', parts });
}

const openAIOutput = () => [
    { id: 'm1', type: 'message', status: 'completed', role: 'assistant', phase: 'commentary',
        content: [{ type: 'output_text', text: 'Checking.', annotations: [] }] },
    { id: 'r1', type: 'reasoning', summary: [{ type: 'summary_text', text: 'First summary.' }], encrypted_content: 'cipher-one' },
    { id: 's1', type: 'web_search_call', status: 'completed', action: { type: 'search', query: 'source', sources: [{ type: 'url', url: 'https://example.com' }] } },
    { id: 'r2', type: 'reasoning', summary: [], encrypted_content: 'cipher-two' },
    { id: 'm2', type: 'message', status: 'completed', role: 'assistant', phase: 'final_answer',
        content: [{ type: 'output_text', text: 'Answer.', annotations: [{ type: 'url_citation', url: 'https://example.com', title: 'Source', start_index: 0, end_index: 6 }] }] }
];
const openAIData = output => ({ status: 'completed', output, usage: { input_tokens: 10, output_tokens: 20 } });
const anthropicContent = () => [
    { type: 'thinking', thinking: '', signature: 'omitted-signature' },
    { type: 'text', text: 'Checking.' },
    { type: 'server_tool_use', id: 'srvtool_1', name: 'web_search', input: { query: 'source' } },
    { type: 'web_search_tool_result', tool_use_id: 'srvtool_1', content: [
        { type: 'web_search_result', url: 'https://example.com', title: 'Source', encrypted_content: 'search-cipher', page_age: null }
    ] },
    { type: 'thinking', thinking: 'Second summary.', signature: 'second-signature' },
    { type: 'redacted_thinking', data: 'redacted-cipher' },
    { type: 'text', text: 'Answer.', citations: [{ type: 'web_search_result_location', url: 'https://example.com', title: 'Source', encrypted_index: 'citation-cipher', cited_text: 'fact' }] }
];
const anthropicData = content => ({ type: 'message', role: 'assistant', stop_reason: 'end_turn', content,
    usage: { input_tokens: 10, output_tokens: 20 } });
const thoughtTypes = body => body.messages.flatMap(message => message.content).filter(block => ['thinking', 'redacted_thinking'].includes(block.type));

async function captureAnthropicTurn(provider, history, signature, text, overrides = {}) {
    const request = await prepare(provider, history, overrides);
    const content = [{ type: 'thinking', thinking: '', signature }, { type: 'text', text }];
    return finish(provider, request.responseState, anthropicData(content));
}

describe('Native OpenAI reasoning persistence', () => {
    test('restored history replays every encrypted output item and assistant phase exactly', async () => {
        const provider = new OpenAIProvider();
        const request = await prepare(provider, initial());
        expect(request.body.store).toBe(false);
        expect(request.body.reasoning.context).toBeUndefined();
        const output = openAIOutput();
        const answer = finish(provider, request.responseState, openAIData(output));
        const persisted = restore([...initial(), answer, user('Follow up days later')]);
        const next = await prepare(new OpenAIProvider(), persisted);
        expect(next.body.input.slice(1, -1)).toEqual(output);
        expect(next.body.previous_response_id).toBeUndefined();
        expect(JSON.stringify(next.body)).not.toContain('providerState');
        expect(answer.parts[0].providerState.output).toEqual(output);
    });

    test('stream item completion and nonstream output produce identical native replay state', async () => {
        const provider = new OpenAIProvider();
        const output = openAIOutput();
        const nonstream = await prepare(provider, initial());
        const answer = finish(provider, nonstream.responseState, openAIData(output));
        const stream = await prepare(provider, initial(), { stream: true });
        const writer = createMockWriter();
        const tokenCounter = createMockTokenCounter();
        const send = parsed => provider.handleStream({ parsed, responseState: stream.responseState, writer, tokenCounter });
        send({ type: 'response.output_text.delta', delta: 'Checking.' });
        send({ type: 'response.reasoning_summary_text.delta', delta: 'First summary.' });
        send({ type: 'response.output_text.delta', delta: 'Answer.' });
        // Completion can be observed out of index order; output order must not follow event arrival.
        for (const index of [4, 0, 3, 1, 2]) send({ type: 'response.output_item.done', output_index: index, item: output[index] });
        expect(provider.finalizeResponseState(stream.responseState)).toBeNull();
        send({ type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 10, output_tokens: 20 } } });
        const state = provider.finalizeResponseState(stream.responseState);
        expect(state).toEqual(answer.parts[0].providerState);
        const parts = writer.getFinalContent();
        parts[0].providerState = restore(state);
        const next = await prepare(provider, [...initial(), { role: 'assistant', parts }, user('Next')]);
        expect(next.body.input.slice(1, -1)).toEqual(output);
    });

    test('authoritative completed response captures opaque-only output without display cipher', async () => {
        const provider = new OpenAIProvider();
        const request = await prepare(provider, initial(), { stream: true });
        const output = [{ type: 'reasoning', id: 'opaque', summary: [], encrypted_content: 'opaque-only-cipher' }];
        const writer = createMockWriter();
        provider.handleStream({ parsed: { type: 'response.completed', response: openAIData(output) },
            responseState: request.responseState, writer, tokenCounter: createMockTokenCounter() });
        const state = provider.finalizeResponseState(request.responseState);
        expect(state.output).toEqual(output);
        expect(writer.getFinalContent()).toEqual([{ type: 'text', content: '' }]);
        const answer = { role: 'assistant', parts: [{ type: 'thought', content: '', providerState: restore(state) }] };
        const next = await prepare(provider, [...initial(), answer, user('Next')]);
        expect(next.body.input[1]).toEqual(output[0]);
    });

    test('different source, model, credential, edited prefix and edited answer exclude encrypted replay without deleting originals', async () => {
        const provider = new OpenAIProvider();
        const request = await prepare(provider, initial());
        const answer = finish(provider, request.responseState, openAIData(openAIOutput()));
        const original = restore(answer);
        for (const overrides of [{ model: 'gpt-6-luna' }, { apiKey: 'another-account-key' }]) {
            const next = await prepare(provider, [...initial(), answer, user('Next')], overrides);
            expect(next.body.input.some(item => item.type === 'reasoning')).toBe(false);
            expect(next.body.input[1].content[0].text).toBe(answer.parts.filter(part => part.type === 'text').map(part => part.content).join('\n'));
        }
        const changedPrefix = await prepare(provider, [system('Edited instructions'), user('First question'), answer, user('Next')]);
        expect(changedPrefix.body.input.some(item => item.type === 'reasoning')).toBe(false);
        const edited = restore(answer);
        edited.parts.find(part => part.type === 'text').content = 'Edited answer';
        const changedAnswer = await prepare(provider, [...initial(), edited, user('Next')]);
        expect(changedAnswer.body.input[1].content[0].text).toBe(edited.parts.filter(part => part.type === 'text').map(part => part.content).join('\n'));
        const foreign = restore(answer);
        foreign.parts[0].providerState.provider = 'anthropic';
        const foreignRequest = await prepare(provider, [...initial(), foreign, user('Next')]);
        expect(foreignRequest.body.input.some(item => item.type === 'reasoning')).toBe(false);
        const aggregate = restore(answer);
        aggregate.parts[0].providerState.replayable = false;
        expect((await prepare(provider, [...initial(), aggregate, user('Next')])).body.input.some(item => item.type === 'reasoning')).toBe(false);
        expect(answer).toEqual(original);
    });

    test('ChatGPT account gate survives token rotation but excludes different accounts and API-key auth', async () => {
        const provider = new OpenAIProvider();
        const auth = { accountId: 'account-one', access: 'short-lived-one' };
        const request = await prepare(provider, initial(), { chatGPTAuth: auth });
        const answer = finish(provider, request.responseState, openAIData(openAIOutput()));
        const next = await prepare(provider, [...initial(), answer, user('Next')], { chatGPTAuth: { ...auth, access: 'rotated-token' } });
        expect(next.body.input.slice(1, -1)).toEqual(openAIOutput());
        expect(answer.parts[0].providerState.scope).toBe('chatgpt:account-one');
        for (const overrides of [{ chatGPTAuth: { accountId: 'account-two', access: 'same-token' } }, {}]) {
            expect((await prepare(provider, [...initial(), answer, user('Next')], overrides)).body.input.some(item => item.type === 'reasoning')).toBe(false);
        }
    });

    test('truncated, missing-item, incomplete-item and summary-only responses are not native replay candidates', async () => {
        const provider = new OpenAIProvider();
        for (const data of [
            { ...openAIData(openAIOutput()), status: 'incomplete' },
            openAIData([{ type: 'reasoning', encrypted_content: 'partial', summary: [], status: 'in_progress' }]),
            openAIData([{ type: 'reasoning', summary: [{ type: 'summary_text', text: 'Display summary' }] }])
        ]) {
            const request = await prepare(provider, initial());
            finish(provider, request.responseState, data);
            expect(provider.finalizeResponseState(request.responseState)).toBeNull();
        }
        const missing = await prepare(provider, initial(), { stream: true });
        const writer = createMockWriter();
        const tokenCounter = createMockTokenCounter();
        provider.handleStream({ parsed: { type: 'response.output_item.done', output_index: 1, item: openAIOutput()[1] }, responseState: missing.responseState, writer, tokenCounter });
        provider.handleStream({ parsed: { type: 'response.completed', response: { status: 'completed' } }, responseState: missing.responseState, writer, tokenCounter });
        expect(provider.finalizeResponseState(missing.responseState)).toBeNull();
    });
});

describe('Native Anthropic reasoning persistence', () => {
    test('JSON restoration replays omitted signed thinking, redactions, server results and citations in exact order', async () => {
        const provider = new AnthropicProvider();
        const request = await prepare(provider, initial(), { options: { webSearch: true } });
        const content = anthropicContent();
        const answer = finish(provider, request.responseState, anthropicData(content));
        const next = await prepare(new AnthropicProvider(), restore([...initial(), answer, user('Next days later')]), { options: { webSearch: true } });
        expect(next.body.messages[1].content).toEqual(content);
        expect(JSON.stringify(next.body)).not.toContain('providerState');
    });

    test('indexed signature, tool JSON and citation deltas match nonstream blocks and exact restored replay', async () => {
        const provider = new AnthropicProvider();
        const content = anthropicContent();
        const request = await prepare(provider, initial(), { stream: true, options: { webSearch: true } });
        const writer = createMockWriter();
        const tokenCounter = createMockTokenCounter();
        const send = parsed => provider.handleStream({ parsed, responseState: request.responseState, writer, tokenCounter });
        send({ type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 0 } } });
        for (let index = 0; index < content.length; index++) {
            const block = content[index];
            let start = restore(block);
            if (block.type === 'thinking') start = { type: 'thinking', thinking: '' };
            if (block.type === 'text') start = { type: 'text', text: '' };
            if (block.type === 'server_tool_use') start.input = {};
            send({ type: 'content_block_start', index, content_block: start });
            if (block.type === 'thinking') {
                if (block.thinking) send({ type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: block.thinking } });
                send({ type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: block.signature.slice(0, 4) } });
                send({ type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: block.signature.slice(4) } });
            } else if (block.type === 'text') {
                send({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } });
                for (const citation of block.citations || []) send({ type: 'content_block_delta', index, delta: { type: 'citations_delta', citation } });
            } else if (block.type === 'server_tool_use') {
                send({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: '{"query":' } });
                send({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: '"source"}' } });
            }
            send({ type: 'content_block_stop', index });
        }
        expect(provider.finalizeResponseState(request.responseState)).toBeNull();
        send({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 20 } });
        send({ type: 'message_stop' });
        const state = provider.finalizeResponseState(request.responseState);
        expect(state.content).toEqual(content);
        const nonstream = await prepare(provider, initial(), { options: { webSearch: true } });
        const answer = finish(provider, nonstream.responseState, anthropicData(content));
        expect(state).toEqual(answer.parts[0].providerState);
        const parts = writer.getFinalContent();
        parts[0].providerState = restore(state);
        const next = await prepare(provider, [...initial(), { role: 'assistant', parts }, user('Next')], { options: { webSearch: true } });
        expect(next.body.messages[1].content).toEqual(content);
    });

    test('source, model and credential gates retain saved cipher while excluding incompatible reasoning', async () => {
        const provider = new AnthropicProvider();
        const request = await prepare(provider, initial(), { options: { webSearch: true } });
        const content = anthropicContent();
        const answer = finish(provider, request.responseState, anthropicData(content));
        const original = restore(answer);
        const switched = await prepare(provider, [...initial(), answer, user('Next')], { model: 'claude-sonnet-5-5', options: { webSearch: true } });
        expect(thoughtTypes(switched.body)).toEqual([]);
        expect(switched.body.messages[1].content).toEqual(content.filter(block => !['thinking', 'redacted_thinking'].includes(block.type)));
        for (const overrides of [{ apiKey: 'account-two-key' }, {}]) {
            const candidate = restore(answer);
            if (!overrides.apiKey) candidate.parts[0].providerState.provider = 'openai';
            const next = await prepare(provider, [...initial(), candidate, user('Next')], { ...overrides, options: { webSearch: true } });
            expect(thoughtTypes(next.body)).toEqual([]);
            expect(next.body.messages[1].content[0].text).toBe(answer.parts.filter(part => part.type === 'text').map(part => part.content).join('\n'));
        }
        expect(answer).toEqual(original);
    });

    test('prefix edits exclude signed blocks, but harmless effort and cache-marker changes preserve them', async () => {
        const provider = new AnthropicProvider();
        const request = await prepare(provider, initial(), { options: { webSearch: true } });
        const answer = finish(provider, request.responseState, anthropicData(anthropicContent()));
        for (const messages of [
            [system('Edited system'), user('First question'), answer, user('Next')],
            [system('Stable instructions'), user('Edited webpage/context'), answer, user('Next')]
        ]) expect(thoughtTypes((await prepare(provider, messages, { options: { webSearch: true } })).body)).toEqual([]);
        expect(thoughtTypes((await prepare(provider, [...initial(), answer, user('Next')], { options: { webSearch: false } })).body)).toEqual([]);
        const harmless = await prepare(provider, [...initial(), answer, user('Next')], {
            options: { webSearch: true, reasoningEffort: 'low' },
            transform: options => {
                const body = JSON.parse(options.body);
                body.system[0].cache_control = { type: 'ephemeral' };
                body.messages[0].content[0].cache_control = { type: 'ephemeral' };
                options.body = JSON.stringify(body);
            }
        });
        expect(harmless.body.messages[1].content).toEqual(anthropicContent());
        const edited = restore(answer);
        edited.parts.find(part => part.type === 'text').content = 'Edited assistant';
        expect(thoughtTypes((await prepare(provider, [...initial(), edited, user('Next')], { options: { webSearch: true } })).body)).toEqual([]);
    });

    test('removing an oldest thinking run is safe, but a middle gap excludes successors', async () => {
        const provider = new AnthropicProvider();
        const history = initial();
        const first = await captureAnthropicTurn(provider, history, 'sig-first', 'First answer');
        history.push(first, user('Second question'));
        const second = await captureAnthropicTurn(provider, history, 'sig-second', 'Second answer');
        history.push(second, user('Third question'));
        const third = await captureAnthropicTurn(provider, history, 'sig-third', 'Third answer');
        history.push(third, user('Fourth question'));
        const oldestRemoved = restore(history);
        oldestRemoved[2].parts[0].providerState.replayable = false;
        expect(thoughtTypes((await prepare(provider, oldestRemoved)).body).map(block => block.signature)).toEqual(['sig-second', 'sig-third']);
        const middleRemoved = restore(history);
        middleRemoved[4].parts[0].providerState.replayable = false;
        expect(thoughtTypes((await prepare(provider, middleRemoved)).body).map(block => block.signature)).toEqual(['sig-first']);
        expect(thoughtTypes((await prepare(provider, history)).body).map(block => block.signature)).toEqual(['sig-first', 'sig-second', 'sig-third']);
    });

    test('switching away and back restores older original blocks but excludes blocks generated under a different predecessor', async () => {
        const provider = new AnthropicProvider();
        const history = initial();
        const first = await captureAnthropicTurn(provider, history, 'original-opus', 'First answer');
        history.push(first, user('Second question'));
        const switched = await captureAnthropicTurn(provider, history, 'sonnet-new', 'Second answer', { model: 'claude-sonnet-5-5' });
        history.push(switched, user('Third question'));
        const back = await captureAnthropicTurn(provider, history, 'opus-after-switch', 'Third answer');
        history.push(back, user('Fourth question'));
        expect(thoughtTypes((await prepare(provider, history)).body).map(block => block.signature)).toEqual(['original-opus', 'opus-after-switch']);
        expect(thoughtTypes((await prepare(provider, history, { model: 'claude-sonnet-5-5' })).body).map(block => block.signature)).toEqual(['sonnet-new']);
        // A newly generated same-model block while an original was locally omitted binds to null.
        const omitted = restore(initial());
        const hidden = restore(first);
        hidden.parts[0].providerState.replayable = false;
        omitted.push(hidden, user('Second question'));
        const bornWithoutOriginal = await captureAnthropicTurn(provider, omitted, 'born-without-original', 'Second answer');
        const restoredOriginal = [...initial(), first, user('Second question'), bornWithoutOriginal, user('Next')];
        expect(thoughtTypes((await prepare(provider, restoredOriginal)).body).map(block => block.signature)).toEqual(['original-opus']);
    });

    test('opaque-only omitted thinking remains replayable; incompatible empty carriers are omitted from API messages', async () => {
        const provider = new AnthropicProvider();
        const request = await prepare(provider, initial());
        const content = [{ type: 'thinking', thinking: '', signature: 'only-signature' }];
        const answer = finish(provider, request.responseState, anthropicData(content));
        expect(answer.parts[0].content).toBe('');
        const next = await prepare(provider, [...initial(), answer, user('Next')]);
        expect(next.body.messages[1].content).toEqual(content);
        const incompatible = await prepare(provider, [...initial(), answer, user('Next')], { model: 'claude-sonnet-5-5' });
        expect(incompatible.body.messages.map(message => message.role)).toEqual(['user', 'user']);
    });

    test('unclosed blocks, unsigned thoughts, invalid tool JSON and max-token truncation never finalize', async () => {
        const provider = new AnthropicProvider();
        for (const data of [
            anthropicData([{ type: 'thinking', thinking: 'Unsigned' }]),
            { ...anthropicData(anthropicContent()), stop_reason: 'max_tokens' }
        ]) {
            const request = await prepare(provider, initial());
            finish(provider, request.responseState, data);
            expect(provider.finalizeResponseState(request.responseState)).toBeNull();
        }
        for (const invalidJSON of [false, true]) {
            const request = await prepare(provider, initial(), { stream: true });
            const writer = createMockWriter();
            const tokenCounter = createMockTokenCounter();
            const send = parsed => provider.handleStream({ parsed, responseState: request.responseState, writer, tokenCounter });
            send({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: 'complete-signature' } });
            if (invalidJSON) {
                send({ type: 'content_block_stop', index: 0 });
                send({ type: 'content_block_start', index: 1, content_block: { type: 'server_tool_use', id: 'srvtool', name: 'web_search', input: {} } });
                send({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{invalid' } });
                send({ type: 'content_block_stop', index: 1 });
            }
            send({ type: 'message_delta', delta: { stop_reason: 'end_turn' } });
            send({ type: 'message_stop' });
            expect(provider.finalizeResponseState(request.responseState)).toBeNull();
        }
    });
});

describe('Native state eligibility', () => {
    test('ordinary answers stay ordinary display parts without opaque persistence metadata', async () => {
        for (const provider of [new OpenAIProvider(), new AnthropicProvider()]) {
            const request = await prepare(provider, initial());
            const data = provider instanceof OpenAIProvider
                ? openAIData([{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Ordinary answer' }] }])
                : anthropicData([{ type: 'text', text: 'Ordinary answer' }]);
            const answer = finish(provider, request.responseState, data);
            expect(answer).toEqual({ role: 'assistant', parts: [{ type: 'text', content: 'Ordinary answer' }] });
        }
    });
});

describe('DeepSeek plain reasoning provenance', () => {
    test('same-model DeepSeek reasoning is replayed without tools while foreign, unknown and cross-model thoughts stay local', () => {
        const provider = new DeepSeekProvider();
        const messages = [user('Question'), { role: 'assistant', parts: [
            { type: 'thought', content: 'Correct reasoning', model: 'deepseek-flash' },
            { type: 'thought', content: 'Earlier DeepSeek model', model: 'deepseek-chat' },
            { type: 'thought', content: 'Unknown provenance' },
            { type: 'thought', content: 'Claude reasoning', model: 'claude-opus-5-5' },
            { type: 'thought', content: 'Kimi reasoning', model: 'kimi-k3' },
            { type: 'text', content: 'Visible answer', model: 'deepseek-flash' }
        ] }, user('Next'), { role: 'assistant', parts: [
            { type: 'thought', content: 'Same-model display must not override native provenance', model: 'deepseek-flash' },
            { type: 'thought', content: 'Foreign native reasoning', model: 'deepseek-flash', providerState: { provider: 'openai' } },
            { type: 'text', content: 'Foreign visible answer', model: 'deepseek-flash' }
        ] }, user('Continue')];
        const original = restore(messages);
        const [, options] = provider.createRequest({ model: 'deepseek-flash', messages, stream: false, apiKey: 'key',
            settings: { max_tokens: 1000, temperature: 0.4 }, options: {} });
        const body = JSON.parse(options.body);
        expect(body.tools).toBeUndefined();
        expect(body.messages[1]).toEqual({ role: 'assistant', content: 'Visible answer', reasoning_content: 'Correct reasoning' });
        expect(body.messages[3]).toEqual({ role: 'assistant', content: 'Foreign visible answer' });
        expect(messages).toEqual(original);
    });
});
