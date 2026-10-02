import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { IDBFactory } from 'fake-indexeddb';
import 'fake-indexeddb/auto';
import { ApiManager } from '../../src/js/api_manager.js';
import { SidepanelChatCore } from '../../src/js/chat_core.js';
import { ChatStorage } from '../../src/js/chat_storage.js';
import { SidepanelController } from '../../src/js/sidepanel_controller.js';
import { StreamWriterSimple } from '../../src/js/StreamWriter.js';
import { serializeChatToMarkdown } from '../../src/js/markdown_export.js';
import { createChromeMock, createMockTokenCounter } from '../setup.mjs';

const OPENAI = 'gpt-6-sol';
const ANTHROPIC = 'claude-opus-5-5';
const DEEPSEEK = 'deepseek-flash';
const originalFetch = globalThis.fetch;
const originalChrome = globalThis.chrome;
const originalIndexedDB = globalThis.indexedDB;

const jsonResponse = body => new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' }
});
const streamResponse = events => new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), {
    headers: { 'Content-Type': 'text/event-stream' }
});
const openAIOutput = (cipher = 'encrypted-reasoning', answer = 'Final answer') => [
    { id: 'rs_1', type: 'reasoning', summary: [{ type: 'summary_text', text: 'Checked the facts' }], encrypted_content: cipher },
    { id: 'ws_1', type: 'web_search_call', status: 'completed', action: { type: 'search', query: 'facts' } },
    { id: 'msg_1', type: 'message', role: 'assistant', status: 'completed', phase: 'final_answer', content: [{ type: 'output_text', text: answer, annotations: [] }] }
];
const openAIResponse = output => ({ status: 'completed', output, usage: { input_tokens: 12, output_tokens: 8 } });
const openAIEvents = output => [
    { type: 'response.reasoning_summary_text.delta', delta: output.find(item => item.type === 'reasoning')?.summary?.[0]?.text || '' },
    { type: 'response.output_text.delta', delta: output.find(item => item.type === 'message')?.content[0].text || '' },
    ...output.map((item, output_index) => ({ type: 'response.output_item.done', output_index, item })),
    { type: 'response.completed', response: openAIResponse(output) }
];
const anthropicContent = [
    { type: 'thinking', thinking: '', signature: 'omitted-thinking-signature' },
    { type: 'redacted_thinking', data: 'redacted-native-cipher' },
    { type: 'text', text: 'Anthropic answer' }
];
const anthropicEvents = content => [
    { type: 'message_start', message: { id: 'msg_native', role: 'assistant', content: [], usage: { input_tokens: 10, output_tokens: 0 } } },
    ...content.flatMap((block, index) => [
        { type: 'content_block_start', index, content_block: block.type === 'thinking' ? { type: 'thinking', thinking: '', signature: '' } : block.type === 'text' ? { type: 'text', text: '' } : block },
        ...(block.type === 'thinking' ? [
            { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: block.thinking } },
            { type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: block.signature } }
        ] : block.type === 'text' ? [
            { type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } }
        ] : []),
        { type: 'content_block_stop', index }
    ]),
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 8 } },
    { type: 'message_stop' }
];

// Exercise the real writer's part transitions without requiring a browser renderer.
class LifecycleWriter extends StreamWriterSimple {
    constructor() {
        const wrapper = { appendChild() {} };
        const createDiv = () => ({
            textContent: '', innerHTML: '', append() {},
            classList: { add() {}, remove() {} },
            closest: () => wrapper
        });
        super(createDiv(), createDiv);
    }
    scheduleRender() {}
    updateTextContent() {}
}

function harness() {
    const values = {
        api_keys: { openai: 'openai-secret', anthropic: 'anthropic-secret', deepseek: 'deepseek-secret' },
        models: {
            openai: { [OPENAI]: 'OpenAI', 'gpt-6-luna': 'Luna' },
            anthropic: { [ANTHROPIC]: 'Anthropic' },
            deepseek: { [DEEPSEEK]: 'DeepSeek', 'deepseek-reasoner': 'Other DeepSeek' }
        },
        max_tokens: 16000, temperature: 1, reasoning_effort: 'high', loop_threshold: 2
    };
    const settingsManager = {
        getSetting: key => values[key],
        subscribeToSetting() {},
        updateSettingsLocal: update => Object.assign(values, update)
    };
    const api = new ApiManager({ settingsManager });
    const storage = new ChatStorage();
    storage.migrationRun = true;
    const state = { shouldSave: true, thinkingMode: false, getSetting: settingsManager.getSetting };
    const makeCore = () => {
        const core = new SidepanelChatCore(storage, state, {});
        core.renameManager = { autoRename: async () => null };
        core.init('Persisted reasoning');
        return core;
    };
    return { api, storage, state, values, makeCore, core: makeCore() };
}

beforeEach(() => {
    globalThis.chrome = createChromeMock();
    globalThis.indexedDB = new IDBFactory();
});
afterEach(() => {
    globalThis.fetch = originalFetch;
    globalThis.chrome = originalChrome;
    globalThis.indexedDB = originalIndexedDB;
});

describe('native reasoning request, persistence and replay lifecycle', () => {
    for (const streaming of [false, true]) {
        test(`OpenAI ${streaming ? 'stream' : 'nonstream'} survives IndexedDB restore and replays original output`, async () => {
            const { api, core, storage, makeCore } = harness();
            const output = openAIOutput();
            const bodies = [];
            globalThis.fetch = async (_url, request) => {
                bodies.push(JSON.parse(request.body));
                return streaming ? streamResponse(openAIEvents(output)) : jsonResponse(openAIResponse(output));
            };
            await core.addUserMessage('First question');
            const writer = streaming ? new LifecycleWriter() : null;
            const result = await api.callApi(OPENAI, core.getMessagesForAPI(OPENAI), createMockTokenCounter(), writer);
            if (writer) writer.finalizeCurrentPart();
            const parts = writer ? writer.parts : result;
            expect(parts[0].content).toBe('Checked the facts');
            expect(parts[0].providerState.output).toEqual(output);
            expect(JSON.stringify(parts[0].providerState)).not.toContain('openai-secret');
            await core.addAssistantMessage(parts, OPENAI);
            const loaded = await storage.loadChat(core.getChatId());
            expect(loaded.messages[1].contents[0][0].providerState).toEqual(parts[0].providerState);
            const restored = makeCore();
            restored.buildFromDB(JSON.parse(JSON.stringify(loaded)));
            await restored.addUserMessage('Next question');
            await api.callApi(OPENAI, restored.getMessagesForAPI(OPENAI), createMockTokenCounter(), streaming ? new LifecycleWriter() : null);
            expect(bodies[1].input.slice(1, -1)).toEqual(output);
            expect(bodies[1].store).toBe(false);
            const markdown = serializeChatToMarkdown(loaded);
            expect(markdown).toContain('Final answer');
            expect(markdown).not.toContain('encrypted-reasoning');
            expect(ChatStorage.extractTextFromMessages(loaded.messages)).not.toContain('encrypted-reasoning');
        });
    }

    for (const streaming of [false, true]) {
        test(`Anthropic ${streaming ? 'stream' : 'nonstream'} restores exact empty signed and redacted blocks`, async () => {
            const { api, core, storage, makeCore } = harness();
            const bodies = [];
            globalThis.fetch = async (_url, request) => {
                bodies.push(JSON.parse(request.body));
                return streaming ? streamResponse(anthropicEvents(anthropicContent)) : jsonResponse({
                    type: 'message', role: 'assistant', content: anthropicContent, stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 8 }
                });
            };
            core.insertSystemMessage('Stable instructions');
            await core.addUserMessage('Question');
            const writer = streaming ? new LifecycleWriter() : null;
            const result = await api.callApi(ANTHROPIC, core.getMessagesForAPI(ANTHROPIC), createMockTokenCounter(), writer);
            if (writer) writer.finalizeCurrentPart();
            const parts = writer ? writer.parts : result;
            expect(parts[0].providerState.content).toEqual(anthropicContent);
            await core.addAssistantMessage(parts, ANTHROPIC);
            const loaded = await storage.loadChat(core.getChatId());
            const restored = makeCore();
            restored.buildFromDB(loaded);
            await restored.addUserMessage('Follow up');
            await api.callApi(ANTHROPIC, restored.getMessagesForAPI(ANTHROPIC), createMockTokenCounter(), streaming ? new LifecycleWriter() : null);
            expect(bodies[1].messages[1].content).toEqual(anthropicContent);
            const markdown = serializeChatToMarkdown(loaded);
            expect(markdown).toContain('Anthropic answer');
            expect(markdown).not.toContain('omitted-thinking-signature');
            expect(markdown).not.toContain('redacted-native-cipher');
        });
    }

    test('mandatory writerless ChatGPT stream retains native state across access-token refresh', async () => {
        const { api, core, values, storage, makeCore } = harness();
        values.chatgpt_auth = { access: 'first-access-token', refresh: 'refresh-token', expires: Date.now() + 3600000, accountId: 'stable-account' };
        const output = openAIOutput('account-bound-cipher');
        const requests = [];
        let refreshCount = 0;
        globalThis.fetch = async (url, request) => {
            if (url.includes('/oauth/token')) {
                refreshCount++;
                return jsonResponse({ access_token: 'rotated-access-token', expires_in: 3600 });
            }
            requests.push({ url, body: JSON.parse(request.body), headers: request.headers });
            return streamResponse(openAIEvents(output));
        };
        await core.addUserMessage('Question');
        const parts = await api.callApi(OPENAI, core.getMessagesForAPI(OPENAI), createMockTokenCounter());
        await core.addAssistantMessage(parts, OPENAI);
        values.chatgpt_auth.expires = 0;
        const restored = makeCore();
        restored.buildFromDB(await storage.loadChat(core.getChatId()));
        await restored.addUserMessage('After refresh');
        const nextParts = await api.callApi(OPENAI, restored.getMessagesForAPI(OPENAI), createMockTokenCounter());
        expect(refreshCount).toBe(1);
        expect(requests[1].headers.Authorization).toBe('Bearer rotated-access-token');
        expect(requests[1].headers['chatgpt-account-id']).toBe('stable-account');
        expect(requests[1].body.input.slice(1, -1)).toEqual(output);
        expect(nextParts[0].providerState.scope).toBe(parts[0].providerState.scope);
    });

    for (const streaming of [false, true]) {
        test(`opaque-only ${streaming ? 'stream' : 'nonstream'} survives UI writer conversion`, async () => {
            const { api, core, storage } = harness();
            const output = [{ type: 'reasoning', id: 'rs_empty', summary: [], encrypted_content: 'opaque-only-cipher' }];
            globalThis.fetch = async () => streaming ? streamResponse(openAIEvents(output)) : jsonResponse(openAIResponse(output));
            await core.addUserMessage('Question');
            const writer = new LifecycleWriter();
            if (streaming) {
                await api.callApi(OPENAI, core.getMessagesForAPI(OPENAI), createMockTokenCounter(), writer);
            } else {
                const parts = await api.callApi(OPENAI, core.getMessagesForAPI(OPENAI), createMockTokenCounter());
                expect(parts[0].type).toBe('thought');
                const controller = Object.create(SidepanelController.prototype);
                controller.processNonStreamedResponse(parts, writer);
            }
            writer.finalizeCurrentPart();
            expect(writer.parts[0].type).toBe('thought');
            expect(writer.parts[0].providerState.output).toEqual(output);
            await core.addAssistantMessage(writer.parts, OPENAI);
            const loaded = await storage.loadChat(core.getChatId());
            expect(loaded.messages[1].contents[0][0].providerState.output).toEqual(output);
            expect(serializeChatToMarkdown(loaded)).not.toContain('opaque-only-cipher');
        });
    }

    test('nonstream conversion attaches metadata to surviving text after empty thought transitions', async () => {
        const { api, core } = harness();
        const output = openAIOutput();
        globalThis.fetch = async () => jsonResponse(openAIResponse(output));
        await core.addUserMessage('Question');
        const parts = await api.callApi(OPENAI, core.getMessagesForAPI(OPENAI), createMockTokenCounter());
        const state = parts[0].providerState;
        parts[0].content = '';
        const writer = new LifecycleWriter();
        writer.setThinkingModel();
        Object.create(SidepanelController.prototype).processNonStreamedResponse(parts, writer);
        writer.finalizeCurrentPart();
        expect(writer.parts).toEqual([{ type: 'text', content: 'Final answer', providerState: state }]);
    });

    test('incomplete JSON and abruptly terminated streams reject without saving an answer', async () => {
        const { api, core, storage } = harness();
        const output = openAIOutput();
        await core.addUserMessage('Question');
        const before = await storage.loadChat(core.getChatId());
        globalThis.fetch = async () => jsonResponse({ ...openAIResponse(output), status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } });
        await expect(api.callApi(OPENAI, core.getMessagesForAPI(OPENAI), createMockTokenCounter()))
            .rejects.toThrow('max_output_tokens');
        globalThis.fetch = async () => streamResponse(openAIEvents(output).slice(0, -1));
        const writer = new LifecycleWriter();
        await expect(api.callApi(OPENAI, core.getMessagesForAPI(OPENAI), createMockTokenCounter(), writer))
            .rejects.toThrow('stream ended before completion');
        expect(writer.parts[0].providerState).toBeUndefined();
        expect((await storage.loadChat(core.getChatId())).messages).toEqual(before.messages);
    });

    test('aborted completed stream cannot attach replayable state', async () => {
        const { api, core } = harness();
        const controller = new AbortController();
        await core.addUserMessage('Question');
        globalThis.fetch = async () => {
            const response = streamResponse(openAIEvents(openAIOutput()));
            controller.abort();
            return response;
        };
        const writer = new LifecycleWriter();
        await expect(api.callApi(OPENAI, core.getMessagesForAPI(OPENAI), createMockTokenCounter(), writer, controller)).rejects.toThrow();
        expect(writer.parts.some(part => part.providerState?.replayable === true)).toBe(false);
        expect(core.getLatestMessage().role).toBe('user');
    });

    test('provider/model/account switches keep visible answers without sending incompatible opaque state', async () => {
        const { api, core, values, storage } = harness();
        const requests = [];
        globalThis.fetch = async (_url, request) => {
            const body = JSON.parse(request.body);
            requests.push(body);
            return body.model === ANTHROPIC ? jsonResponse({ content: [{ type: 'text', text: 'Next' }], stop_reason: 'end_turn', usage: { input_tokens: 2, output_tokens: 1 } }) : jsonResponse(openAIResponse(openAIOutput()));
        };
        await core.addUserMessage('Question');
        const parts = await api.callApi(OPENAI, core.getMessagesForAPI(OPENAI), createMockTokenCounter());
        await core.addAssistantMessage(parts, OPENAI);
        await core.addUserMessage('Next');
        await api.callApi(ANTHROPIC, core.getMessagesForAPI(ANTHROPIC), createMockTokenCounter());
        expect(requests[1].messages[1].content).toEqual([{ type: 'text', text: 'Final answer' }]);
        expect(JSON.stringify(requests[1])).not.toContain('encrypted-reasoning');
        await api.callApi('gpt-6-luna', core.getMessagesForAPI('gpt-6-luna'), createMockTokenCounter());
        expect(JSON.stringify(requests[2])).not.toContain('encrypted-reasoning');
        expect(JSON.stringify(requests[2])).toContain('Final answer');
        values.api_keys.openai = 'different-account-key';
        await api.callApi(OPENAI, core.getMessagesForAPI(OPENAI), createMockTokenCounter());
        expect(JSON.stringify(requests[3])).not.toContain('encrypted-reasoning');
        const loaded = await storage.loadChat(core.getChatId());
        expect(loaded.messages[1].contents[0][0].providerState.output).toEqual(openAIOutput());
    });

    test('edited Anthropic prefix safely omits bound thinking while retaining original local state', async () => {
        const { api, core, storage } = harness();
        const requests = [];
        globalThis.fetch = async (_url, request) => {
            requests.push(JSON.parse(request.body));
            return jsonResponse({ content: anthropicContent, stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 8 } });
        };
        core.insertSystemMessage('Original system');
        await core.addUserMessage('Question');
        const parts = await api.callApi(ANTHROPIC, core.getMessagesForAPI(ANTHROPIC), createMockTokenCounter());
        await core.addAssistantMessage(parts, ANTHROPIC);
        core.insertSystemMessage('Changed solver system');
        await core.addUserMessage('Next');
        await api.callApi(ANTHROPIC, core.getMessagesForAPI(ANTHROPIC), createMockTokenCounter());
        expect(requests[1].messages[1].content).toEqual([{ type: 'text', text: 'Anthropic answer' }]);
        expect(JSON.stringify(requests[1])).not.toContain('omitted-thinking-signature');
        const loaded = await storage.loadChat(core.getChatId());
        expect(loaded.messages[2].contents[0][0].providerState.content).toEqual(anthropicContent);
    });
});

describe('selected reasoning history and plain reasoning provenance', () => {
    for (const mode of ['regeneration', 'branch', 'arena', 'council']) {
        test(`${mode} replays only the selected stored native response`, async () => {
            const { api, core, storage, makeCore } = harness();
            let count = 0;
            const bodies = [];
            globalThis.fetch = async (_url, request) => {
                bodies.push(JSON.parse(request.body));
                count++;
                return jsonResponse(openAIResponse(openAIOutput(`cipher-${count}`, `Answer ${count}`)));
            };
            await core.addUserMessage('Question');
            const first = await api.callApi(OPENAI, core.getMessagesForAPI(OPENAI), createMockTokenCounter());
            const second = await api.callApi(OPENAI, core.getMessagesForAPI(OPENAI), createMockTokenCounter());
            if (mode === 'arena') {
                core.initArena(OPENAI, 'gpt-6-luna');
                await core.updateArena(first, OPENAI, 'model_a');
                await core.updateArena(second, 'gpt-6-luna', 'model_b');
                await core.updateArenaMisc(null, 'model_a');
            } else if (mode === 'council') {
                core.initCouncil([OPENAI], OPENAI);
                await core.updateCouncil(first, OPENAI);
                await core.updateCouncilCollector(second, OPENAI);
            } else {
                await core.addAssistantMessage(first, OPENAI);
                await core.appendRegenerated(second, OPENAI);
            }
            const loaded = await storage.loadChat(core.getChatId());
            const restored = makeCore();
            restored.buildFromDB(loaded, mode === 'branch' ? 1 : null, mode === 'branch' ? 0 : null);
            await restored.addUserMessage('Follow up');
            await api.callApi(OPENAI, restored.getMessagesForAPI(OPENAI), createMockTokenCounter());
            const selected = mode === 'branch' || mode === 'arena' ? 1 : 2;
            expect(bodies[2].input.slice(1, -1)).toEqual(openAIOutput(`cipher-${selected}`, `Answer ${selected}`));
            expect(JSON.stringify(bodies[2])).not.toContain(`cipher-${selected === 1 ? 2 : 1}`);
        });
    }

    for (const source of [OPENAI, ANTHROPIC]) {
        test(`${source} native summaries never leak into Kimi reasoning_content`, async () => {
            const { api, core, values, storage } = harness();
            values.api_keys.kimi = 'kimi-secret';
            values.models.kimi = { 'kimi-k3': 'Kimi' };
            const bodies = [];
            const content = [
                { type: 'thinking', thinking: 'Private native summary', signature: 'native-signature' },
                { type: 'text', text: 'Native visible answer' }
            ];
            globalThis.fetch = async (_url, request) => {
                const body = JSON.parse(request.body);
                bodies.push(body);
                if (body.model === 'kimi-k3') {
                    return jsonResponse({
                        choices: [{ message: { content: 'Kimi answer', reasoning_content: 'Kimi reasoning' } }],
                        usage: { prompt_tokens: 10, completion_tokens: 8 }
                    });
                }
                return source === OPENAI
                    ? jsonResponse(openAIResponse(openAIOutput('native-cipher', 'Native visible answer')))
                    : jsonResponse({ content, stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 8 } });
            };
            await core.addUserMessage('Question');
            const parts = await api.callApi(source, core.getMessagesForAPI(source), createMockTokenCounter());
            await core.addAssistantMessage(parts, source);
            await core.addUserMessage('Continue with Kimi');
            const history = core.getMessagesForAPI('kimi-k3');
            expect(history[1].parts[0].providerState).toEqual(parts[0].providerState);
            await api.callApi('kimi-k3', history, createMockTokenCounter());
            const assistant = bodies[1].messages.find(message => message.role === 'assistant');
            expect(assistant.content).toBe('Native visible answer');
            expect(assistant.reasoning_content).toBeUndefined();
            expect(JSON.stringify(bodies[1])).not.toContain('Private native summary');
            expect(JSON.stringify(bodies[1])).not.toContain('Checked the facts');
            expect(JSON.stringify(bodies[1])).not.toContain('native-cipher');
            expect(JSON.stringify(bodies[1])).not.toContain('native-signature');
            const loaded = await storage.loadChat(core.getChatId());
            expect(loaded.messages[1].contents[0][0].providerState).toEqual(parts[0].providerState);
        });
    }

    test('DeepSeek replays compatible plain reasoning without tools, but never foreign or different-model thoughts', async () => {
        const { api, core } = harness();
        const bodies = [];
        globalThis.fetch = async (_url, request) => {
            bodies.push(JSON.parse(request.body));
            return jsonResponse({
                choices: [{ message: { reasoning_content: 'DeepSeek reasoning', content: 'DeepSeek answer' } }],
                usage: { prompt_tokens: 10, completion_tokens: 8 }
            });
        };
        await core.addUserMessage('Question');
        const parts = await api.callApi(DEEPSEEK, core.getMessagesForAPI(DEEPSEEK), createMockTokenCounter());
        await core.addAssistantMessage(parts, DEEPSEEK);
        await core.addUserMessage('Follow up');
        await api.callApi(DEEPSEEK, core.getMessagesForAPI(DEEPSEEK), createMockTokenCounter());
        expect(bodies[1].messages[1].reasoning_content).toBe('DeepSeek reasoning');
        expect(bodies[1].tools).toBeUndefined();
        await api.callApi('deepseek-reasoner', core.getMessagesForAPI('deepseek-reasoner'), createMockTokenCounter());
        expect(bodies[2].messages[1].reasoning_content).toBeUndefined();
        await core.addAssistantMessage([
            { type: 'thought', content: 'Foreign thought', providerState: { provider: 'anthropic', model: ANTHROPIC, scope: 'foreign', content: [{ type: 'redacted_thinking', data: 'foreign-cipher' }] } },
            { type: 'text', content: 'Foreign visible answer' }
        ], ANTHROPIC);
        await core.addUserMessage('Another follow up');
        await api.callApi(DEEPSEEK, core.getMessagesForAPI(DEEPSEEK), createMockTokenCounter());
        const foreign = bodies[3].messages.find(message => message.content === 'Foreign visible answer');
        expect(foreign.reasoning_content).toBeUndefined();
        expect(JSON.stringify(bodies[3])).not.toContain('foreign-cipher');
        expect(core.getChat().messages[3].contents[0][0].providerState.content[0].data).toBe('foreign-cipher');
    });

    test('thinking-loop aggregation keeps both native originals locally and sends the complete final answer safely', async () => {
        const { api, core, state, storage } = harness();
        let solving = false;
        let inactive = false;
        Object.assign(state, {
            thinkingMode: true,
            isThinking: () => !solving,
            isSolving: () => solving,
            isInactive: () => inactive,
            getPrompt: type => `${type} instructions`,
            nextThinkingState: () => { inactive = true; }
        });
        const bodies = [];
        globalThis.fetch = async (_url, request) => {
            bodies.push(JSON.parse(request.body));
            const index = bodies.length;
            return jsonResponse(openAIResponse(openAIOutput(`loop-cipher-${index}`, index === 1 ? 'Intermediate answer' : 'Complete final answer')));
        };
        await core.addUserMessage('Question');
        core.initThinkingChat();
        const first = await api.callApi(OPENAI, core.getMessagesForAPI(OPENAI), createMockTokenCounter());
        await core.addAssistantMessage(first, OPENAI);
        solving = true;
        const second = await api.callApi(OPENAI, core.getMessagesForAPI(OPENAI), createMockTokenCounter());
        await core.addAssistantMessage(second, OPENAI);
        const loaded = await storage.loadChat(core.getChatId());
        const aggregate = loaded.messages[1].contents[0];
        expect(aggregate[0].providerState.replayable).toBe(false);
        expect(aggregate[0].providerState.output).toEqual(openAIOutput('loop-cipher-1', 'Intermediate answer'));
        expect(aggregate[2].providerState.output).toEqual(openAIOutput('loop-cipher-2', 'Complete final answer'));
        state.thinkingMode = false;
        await core.addUserMessage('Next question');
        await api.callApi(OPENAI, core.getMessagesForAPI(OPENAI), createMockTokenCounter());
        expect(JSON.stringify(bodies[2])).toContain('Intermediate answer');
        expect(JSON.stringify(bodies[2])).toContain('Complete final answer');
        expect(JSON.stringify(bodies[2])).not.toContain('loop-cipher');
    });
});
