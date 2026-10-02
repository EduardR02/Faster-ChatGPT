import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { IDBFactory } from 'fake-indexeddb';
import 'fake-indexeddb/auto';
import { ApiManager } from '../../src/js/api_manager.js';
import { SidepanelChatCore } from '../../src/js/chat_core.js';
import { ChatStorage } from '../../src/js/chat_storage.js';
import { SidepanelController } from '../../src/js/sidepanel_controller.js';
import { StreamWriterSimple, StreamWriter } from '../../src/js/StreamWriter.js';
import { createChromeMock, createMockTokenCounter } from '../setup.mjs';

const originals = { fetch: globalThis.fetch, chrome: globalThis.chrome, indexedDB: globalThis.indexedDB };
const GEMINI = 'gemini-3.5-flash';
const IMAGE = 'gemini-3-pro-image-preview';
const KIMI = 'kimi-k3';
const DEEPSEEK = 'deepseek-flash';
const MISTRAL = 'mistral-small-latest';
const GROK = 'grok-4';
const IMAGE_URL = 'data:image/png;base64,aGVsbG8=';
const json = data => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
const sse = events => new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), {
    headers: { 'Content-Type': 'text/event-stream' }
});
const completion = (reasoning = 'Native reasoning', answer = 'Visible answer', finish_reason = 'stop') => ({
    choices: [{ message: { role: 'assistant', reasoning_content: reasoning, content: answer }, finish_reason }],
    usage: { prompt_tokens: 4, completion_tokens: 6 }
});
const gemini = parts => ({ candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP' }] });
const signedParts = [
    { thought: true, text: '', thoughtSignature: 'empty-reasoning-signature' },
    { text: 'Visible answer', thoughtSignature: 'answer-signature' },
    { thoughtSignature: 'terminal-signature' }
];

class Writer extends StreamWriterSimple {
    constructor() {
        const wrapper = { appendChild() {} };
        const div = () => ({ textContent: '', innerHTML: '', append() {}, classList: { add() {}, remove() {} }, closest: () => wrapper });
        super(div(), div);
    }
    scheduleRender() {}
    updateTextContent() {}
    updateImageContent() {}
}

function harness() {
    const values = {
        api_keys: { gemini: 'gemini-secret', kimi: 'kimi-secret', deepseek: 'deepseek-secret', mistral: 'mistral-secret', grok: 'grok-secret', openai: 'cloud-secret' },
        models: {
            gemini: { [GEMINI]: 'Gemini', [IMAGE]: 'Image' }, kimi: { [KIMI]: 'Kimi' }, deepseek: { [DEEPSEEK]: 'DeepSeek' },
            mistral: { [MISTRAL]: 'Mistral' }, grok: { [GROK]: 'Grok' }, openai: { 'gpt-6-sol': 'Sol' }, llamacpp: { 'local-model': 'Local Model' }
        },
        max_tokens: 16000, temperature: 1, reasoning_effort: 'high', loop_threshold: 2
    };
    const settingsManager = { getSetting: key => values[key], subscribeToSetting() {}, updateSettingsLocal: update => Object.assign(values, update) };
    const api = new ApiManager({ settingsManager });
    const storage = new ChatStorage();
    storage.migrationRun = true;
    const state = { shouldSave: true, thinkingMode: false, getSetting: settingsManager.getSetting };
    const makeCore = (store = storage) => {
        const core = new SidepanelChatCore(store, state, {});
        core.renameManager = { autoRename: async () => null };
        core.init('Remaining provider reasoning');
        return core;
    };
    return { api, storage, state, values, makeCore, core: makeCore() };
}

beforeEach(() => {
    globalThis.chrome = createChromeMock();
    globalThis.indexedDB = new IDBFactory();
});
afterEach(() => Object.assign(globalThis, originals));

const cases = [
    { model: GEMINI, response: gemini(signedParts), native: saved => saved.parts, expected: signedParts, replay: body => body.contents.find(message => message.role === 'model')?.parts },
    { model: KIMI, response: completion(), native: saved => saved.message, expected: completion().choices[0].message, replay: body => body.messages.find(message => message.role === 'assistant') },
    { model: MISTRAL, response: { choices: [{ message: { role: 'assistant', content: [{ type: 'thinking', thinking: [{ type: 'text', text: 'Native reasoning' }] }, { type: 'text', text: 'Visible answer' }] }, finish_reason: 'stop' }] }, native: saved => saved.message, expected: { role: 'assistant', content: [{ type: 'thinking', thinking: [{ type: 'text', text: 'Native reasoning' }] }, { type: 'text', text: 'Visible answer' }] }, replay: body => body.messages.find(message => message.role === 'assistant') },
    { model: GROK, response: { status: 'completed', output: [{ type: 'reasoning', id: 'reasoning-id', encrypted_content: 'native-cipher', summary: [] }, { type: 'message', id: 'answer-id', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Visible answer', annotations: [] }] }] }, native: saved => saved.output, expected: [{ type: 'reasoning', id: 'reasoning-id', encrypted_content: 'native-cipher', summary: [] }, { type: 'message', id: 'answer-id', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Visible answer', annotations: [] }] }], replay: body => body.input.filter(item => item.type === 'reasoning' || item.id === 'answer-id') }
];

describe('remaining providers preserve owned native history', () => {
    test('disabled automatic renaming allows the actual core to save user and native assistant messages', async () => {
        const { api, storage, state, values } = harness();
        values.auto_rename = false;
        const core = new SidepanelChatCore(storage, state, {}, null, null, api);
        core.init('User chosen title');
        let calls = 0;
        globalThis.fetch = async () => {
            calls++;
            return json(completion());
        };
        core.insertSystemMessage('Instructions');
        await core.addUserMessage('Question');
        const parts = await api.callApi(KIMI, core.getMessagesForAPI(KIMI), createMockTokenCounter());
        await core.addAssistantMessage(parts, KIMI);
        const restored = await storage.loadChat(core.getChatId());
        expect(restored.title).toBe('User chosen title');
        expect(restored.messages[1].contents[0][0].content).toBe('Question');
        expect(restored.messages[2].contents[0].find(part => part.type === 'text').content).toBe('Visible answer');
        expect(restored.messages[2].contents[0][0].providerState.message.reasoning_content).toBe('Native reasoning');
        expect(calls).toBe(1);
    });

    for (const answerBeforeSnapshot of [false, true]) {
        test(`concurrent first user/assistant persistence creates one complete chat when answer ${answerBeforeSnapshot ? 'precedes' : 'follows'} initial snapshot`, async () => {
            const { api, storage, state, values } = harness();
            values.auto_rename = false;
            const chatIds = [];
            const core = new SidepanelChatCore(storage, state, {}, null, chatId => chatIds.push(chatId), api);
            core.init('One conversation');
            core.insertSystemMessage('Instructions');
            const native = { version: 1, provider: 'kimi', model: KIMI, replayable: false, message: { role: 'assistant', reasoning_content: 'Native reasoning', content: 'Visible answer' } };
            const actualCreate = storage.createChatWithMessages.bind(storage);
            let release;
            let started;
            const gate = new Promise(resolve => { release = resolve; });
            const creationStarted = new Promise(resolve => { started = resolve; });
            storage.createChatWithMessages = async (...args) => {
                started();
                await gate;
                return actualCreate(...args);
            };
            const userSave = core.addUserMessage('Question');
            if (!answerBeforeSnapshot) await creationStarted;
            const assistantSave = core.addAssistantMessage([
                { type: 'thought', content: 'Native reasoning', providerState: native },
                { type: 'text', content: 'Visible answer' }
            ], KIMI);
            await creationStarted;
            release();
            await Promise.all([userSave, assistantSave]);
            const metadata = await storage.getChatMetadata(Infinity);
            expect(metadata).toHaveLength(1);
            expect(chatIds).toEqual([metadata[0].chatId]);
            const restored = await storage.loadChat(metadata[0].chatId);
            expect(restored.messages.map(message => message.role)).toEqual(['system', 'user', 'assistant']);
            expect(restored.messages[1].contents[0][0].content).toBe('Question');
            expect(restored.messages[2].contents[0][0].providerState).toEqual(native);
            expect(restored.messages[2].contents[0][1].content).toBe('Visible answer');
        });
    }

    for (const mode of ['arena', 'council']) {
        test(`${mode} response persistence joins pending initial chat creation`, async () => {
            const { api, storage, state, values } = harness();
            values.auto_rename = false;
            const core = new SidepanelChatCore(storage, state, {}, null, null, api);
            core.insertSystemMessage('Instructions');
            const actualCreate = storage.createChatWithMessages.bind(storage);
            let release;
            let started;
            const gate = new Promise(resolve => { release = resolve; });
            const creationStarted = new Promise(resolve => { started = resolve; });
            storage.createChatWithMessages = async (...args) => {
                started();
                await gate;
                return actualCreate(...args);
            };
            const userSave = core.addUserMessage('Question');
            await creationStarted;
            const parts = [{ type: 'thought', content: 'Known reasoning' }, { type: 'text', content: 'Visible expert answer' }];
            let responseSave;
            if (mode === 'arena') {
                core.initArena(KIMI, GEMINI);
                responseSave = core.updateArena(parts, KIMI, 'model_a');
            } else {
                core.initCouncil([KIMI, GEMINI], KIMI);
                responseSave = core.updateCouncil(parts, KIMI);
            }
            release();
            await Promise.all([userSave, responseSave]);
            const metadata = await storage.getChatMetadata(Infinity);
            expect(metadata).toHaveLength(1);
            const restored = await storage.loadChat(metadata[0].chatId);
            expect(restored.messages.map(message => message.role)).toEqual(['system', 'user', 'assistant']);
            const restoredParts = mode === 'arena' ? restored.messages[2].responses.model_a.messages[0] : restored.messages[2].council.responses[KIMI].parts;
            expect(restoredParts[1].content).toBe('Visible expert answer');
            expect(restoredParts[0].model).toBe(KIMI);
        });
    }

    for (const item of cases) {
        for (const mode of ['normal', 'arena', 'council', 'branch']) {
            test(`${item.model} restores exact selected ${mode} reasoning without rewriting the stored source`, async () => {
                const { api, core, storage, makeCore } = harness();
                const bodies = [];
                globalThis.fetch = async (_url, request) => { bodies.push(JSON.parse(request.body)); return json(item.response); };
                core.insertSystemMessage('Stable instructions');
                await core.addUserMessage('Question');
                const parts = await api.callApi(item.model, core.getMessagesForAPI(item.model), createMockTokenCounter());
                expect(item.native(parts[0].providerState)).toEqual(item.expected);
                if (mode === 'arena') {
                    core.initArena(item.model, 'gpt-6-sol');
                    await core.updateArena(parts, item.model, 'model_a');
                    await core.updateArenaMisc(null, 'model_a');
                } else if (mode === 'council') {
                    core.initCouncil([item.model], item.model);
                    await core.updateCouncil(parts, item.model);
                    await core.updateCouncilCollector(parts, item.model);
                } else {
                    await core.addAssistantMessage(parts, item.model);
                    if (mode === 'branch') await core.appendRegenerated([{ type: 'text', content: 'Unselected answer' }], item.model);
                }
                const loaded = await storage.loadChat(core.getChatId());
                const source = JSON.stringify(loaded);
                const restored = makeCore();
                restored.buildFromDB(loaded, mode === 'branch' ? 2 : null, mode === 'branch' ? 0 : null);
                await restored.addUserMessage('Continue');
                await api.callApi(item.model, restored.getMessagesForAPI(item.model), createMockTokenCounter());
                expect(item.replay(bodies[1])).toEqual(item.expected);
                expect(JSON.stringify(loaded)).toBe(source);
            });
        }
    }

    test('Gemini image capsule survives text/image transitions, blob backup and restore', async () => {
        const { api, core, storage, makeCore } = harness();
        const native = [signedParts[0], { text: 'Before image' }, { inlineData: { mimeType: 'image/png', data: 'aGVsbG8=' }, thoughtSignature: 'image-signature' }, { text: 'After image' }, signedParts[2]];
        const bodies = [];
        globalThis.fetch = async (_url, request) => { bodies.push(JSON.parse(request.body)); return json(gemini(native)); };
        await core.addUserMessage('Draw');
        const result = await api.callApi(IMAGE, core.getMessagesForAPI(IMAGE), createMockTokenCounter());
        const writer = new Writer();
        Object.create(SidepanelController.prototype).processNonStreamedResponse(result, writer);
        writer.finalizeCurrentPart();
        expect(writer.parts.filter(part => part.type === 'text').map(part => part.content)).toEqual(['Before image', 'After image']);
        expect(writer.parts.find(part => part.type === 'image').content).toBe(IMAGE_URL);
        expect(writer.parts[0].providerState.parts).toEqual(native);
        await core.addAssistantMessage(writer.parts, IMAGE);
        const archive = await storage.exportChats();
        globalThis.indexedDB = new IDBFactory();
        const restoredStorage = new ChatStorage();
        restoredStorage.migrationRun = true;
        await restoredStorage.importChats(archive);
        const metadata = await restoredStorage.getChatMetadata(Infinity);
        const restored = makeCore(restoredStorage);
        restored.buildFromDB(await restoredStorage.loadChat(metadata[0].chatId));
        await restored.addUserMessage('Edit');
        await api.callApi(IMAGE, restored.getMessagesForAPI(IMAGE), createMockTokenCounter());
        expect(bodies[1].contents.find(message => message.role === 'model').parts).toEqual(native);
    });

    test('Gemini SSE image and terminal signatures remain ordered through real writer and headless capture', async () => {
        const { api, core } = harness();
        const native = [{ text: 'Before' }, { inlineData: { mimeType: 'image/png', data: 'aGVsbG8=' }, thought: true, thoughtSignature: 'image-sig' }, { text: 'After' }, { thoughtSignature: 'terminal-sig' }];
        const events = native.map((part, index) => ({ candidates: [{ content: { role: 'model', parts: [part] }, ...(index === native.length - 1 ? { finishReason: 'STOP' } : {}) }] }));
        await core.addUserMessage('Question');
        globalThis.fetch = async () => sse(events);
        const writer = new Writer();
        await api.callApi(GEMINI, core.getMessagesForAPI(GEMINI), createMockTokenCounter(), writer);
        writer.finalizeCurrentPart();
        expect(writer.parts.map(part => part.type)).toEqual(['text', 'image', 'text']);
        expect(writer.parts.map(part => part.content)).toEqual(['Before', IMAGE_URL, 'After']);
        expect(writer.parts[1].thought).toBe(true);
        expect(writer.parts[0].providerState.parts).toEqual(native);
        const provider = api.getProvider(GEMINI);
        const scope = await provider.getReasoningScope({ apiKey: 'gemini-secret', options: {} });
        const [, request] = provider.createRequest({ model: GEMINI, messages: core.getMessagesForAPI(GEMINI), stream: true, apiKey: 'gemini-secret', settings: {}, options: { reasoningScope: scope } });
        const capture = await provider.prepareRequest({ model: GEMINI, requestOptions: request, reasoningScope: scope });
        const headless = await api.handleStreamResponse(sse(events), GEMINI, createMockTokenCounter(), null, capture);
        expect(headless.map(part => part.type)).toEqual(['text', 'image', 'text']);
        expect(headless[0].providerState.parts).toEqual(native);
    });

    test('Gemini file/media prefixes reject edits and model changes without losing visible answers or native originals', async () => {
        const { api, core, values } = harness();
        values.models.gemini['gemini-3.8-flash'] = 'Other Gemini';
        const bodies = [];
        globalThis.fetch = async (_url, request) => { bodies.push(JSON.parse(request.body)); return json(gemini(signedParts)); };
        core.appendMedia({ name: 'notes.txt', content: 'Original file' }, 'file');
        core.appendMedia(IMAGE_URL, 'image');
        await core.addUserMessage('Question');
        const first = await api.callApi(GEMINI, core.getMessagesForAPI(GEMINI), createMockTokenCounter());
        await core.addAssistantMessage(first, GEMINI);
        await core.addUserMessage('Continue');
        const original = JSON.stringify(core.getChat());
        await api.callApi(GEMINI, core.getMessagesForAPI(GEMINI), createMockTokenCounter());
        expect(bodies[1].contents.find(message => message.role === 'model').parts).toEqual(signedParts);
        expect(JSON.stringify(core.getChat())).toBe(original);
        core.currentChat.messages[0].files[0].content = 'Changed file';
        await api.callApi(GEMINI, core.getMessagesForAPI(GEMINI), createMockTokenCounter());
        expect(bodies[2].contents.find(message => message.role === 'model').parts).toEqual([{ text: 'Visible answer' }]);
        await api.callApi('gemini-3.8-flash', core.getMessagesForAPI('gemini-3.8-flash'), createMockTokenCounter());
        expect(bodies[3].contents.find(message => message.role === 'model').parts).toEqual([{ text: 'Visible answer' }]);
        expect(first[0].providerState.parts).toEqual(signedParts);
    });

    test('animated writer drains accepted text at image boundaries and preserves subsequent text as text', () => {
        class AnimatedWriter extends StreamWriter {
            constructor() {
                const wrapper = { appendChild() {} };
                const div = () => ({ textContent: '', innerHTML: '', append() {}, classList: { add() {}, remove() {} }, closest: () => wrapper });
                super(div(), div, () => {}, 5000);
            }
            runAnimationLoop() {}
            updateTextContent() {}
            updateImageContent() {}
        }
        const writer = new AnimatedWriter();
        writer.processContent('Thought', true);
        writer.processContent('Before', false);
        writer.processImage(IMAGE_URL, { thought: true });
        writer.processContent('After', false);
        writer.processImage(IMAGE_URL);
        expect(writer.parts.map(part => part.type)).toEqual(['thought', 'text', 'image', 'text', 'image']);
        expect(writer.parts.slice(0, -1).map(part => Array.isArray(part.content) ? part.content.join('') : part.content)).toEqual(['Thought', 'Before', IMAGE_URL, 'After']);
        expect(writer.parts[2].thought).toBe(true);
    });
});

describe('plain and native provenance across synthetic contexts', () => {
    for (const target of [KIMI, DEEPSEEK, 'local-model']) {
        for (const mode of ['normal', 'arena', 'council']) {
            test(`${target} never sends foreign plain/native thoughts from ${mode}`, async () => {
                const { api, core } = harness();
                const requests = [];
                globalThis.fetch = async (url, request) => {
                    if (url.includes('/v1/models')) return json({ data: [{ id: 'local-model' }] });
                    if (url.includes('/props')) return json({ model_path: '/models/A.gguf', chat_template: 'template', chat_template_caps: { supports_preserve_reasoning: true } });
                    requests.push(JSON.parse(request.body));
                    return json(completion());
                };
                await core.addUserMessage('Question');
                const parts = [{ type: 'thought', content: 'foreign private thought', model: GEMINI, providerState: { version: 1, provider: 'gemini', model: GEMINI, scope: 'foreign', parts: signedParts, replayable: true } }, { type: 'thought', content: 'unknown private thought' }, { type: 'text', content: 'Visible answer' }];
                if (mode === 'arena') { core.initArena(GEMINI, KIMI); await core.updateArena(parts, GEMINI, 'model_a'); await core.updateArenaMisc(null, 'model_a'); }
                else if (mode === 'council') { core.initCouncil([GEMINI], GEMINI); await core.updateCouncilCollector(parts, GEMINI); }
                else await core.addAssistantMessage(parts, GEMINI);
                await core.addUserMessage('Continue');
                const original = JSON.stringify(core.getChat());
                await api.callApi(target, core.getMessagesForAPI(target), createMockTokenCounter());
                const assistant = requests[0].messages.find(message => message.role === 'assistant');
                expect(assistant.content).toBe('Visible answer');
                expect(assistant.reasoning_content).toBeUndefined();
                expect(JSON.stringify(requests[0])).not.toContain('private thought');
                expect(JSON.stringify(requests[0])).not.toContain('signature');
                expect(JSON.stringify(core.getChat())).toBe(original);
            });
        }
    }

    for (const target of [KIMI, DEEPSEEK, 'local-model']) {
        test(`${target} rejects unknown and foreign plain reasoning without a native capsule`, async () => {
            const { api, core } = harness();
            const bodies = [];
            globalThis.fetch = async (url, request) => {
                if (url.includes('/v1/models')) return json({ data: [{ id: 'local-model' }] });
                if (url.includes('/props')) return json({ model_path: '/models/A.gguf', chat_template: 'template', chat_template_caps: { supports_preserve_reasoning: true } });
                bodies.push(JSON.parse(request.body));
                return json(completion());
            };
            await core.addUserMessage('Question');
            core.currentChat.messages.push({ role: 'assistant', contents: [[
                { type: 'thought', content: 'Unknown private trace' },
                { type: 'thought', content: 'Foreign private trace', model: GEMINI },
                { type: 'text', content: 'Visible plain answer' }
            ]] });
            await core.addUserMessage('Continue');
            await api.callApi(target, core.getMessagesForAPI(target), createMockTokenCounter());
            expect(bodies[0].messages[1].content).toBe('Visible plain answer');
            expect(bodies[0].messages[1].reasoning_content).toBeUndefined();
            expect(JSON.stringify(bodies[0])).not.toContain('private trace');
            expect(core.currentChat.messages[1].contents[0][0].content).toBe('Unknown private trace');
        });
    }

    test('truncated Kimi SSE rejects and never enters saved or subsequent conversation history', async () => {
        const { api, core, storage, makeCore } = harness();
        const requests = [];
        globalThis.fetch = async (_url, request) => {
            requests.push(JSON.parse(request.body));
            return requests.length === 1 ? sse([{ choices: [{ delta: { reasoning_content: 'Incomplete native thought', content: 'Partial visible answer' }, finish_reason: null }] }]) : json(completion());
        };
        await core.addUserMessage('Question');
        const before = await storage.loadChat(core.getChatId());
        const writer = new Writer();
        await expect(api.callApi(KIMI, core.getMessagesForAPI(KIMI), createMockTokenCounter(), writer))
            .rejects.toThrow('stream ended before completion');
        const stored = await storage.loadChat(core.getChatId());
        expect(stored.messages).toEqual(before.messages);
        const restored = makeCore();
        restored.buildFromDB(stored);
        await restored.addUserMessage('Continue');
        await api.callApi(KIMI, restored.getMessagesForAPI(KIMI), createMockTokenCounter());
        expect(requests[1].messages.some(message => message.role === 'assistant')).toBe(false);
        expect(JSON.stringify(requests[1])).not.toContain('Incomplete native thought');
        expect(JSON.stringify(requests[1])).not.toContain('Partial visible answer');
    });

    for (const native of [false, true]) {
        test(`Kimi ${native ? 'native' : 'known plain'} thinking loops keep final answers without unsafe aggregate replay`, async () => {
            const { api, core, state, storage } = harness();
            let solving = false;
            Object.assign(state, { thinkingMode: true, isThinking: () => !solving, isSolving: () => solving, isInactive: () => solving, nextThinkingState() {}, getPrompt: type => `${type} instructions` });
            const requests = [];
            globalThis.fetch = async (_url, request) => { requests.push(JSON.parse(request.body)); return json(completion('Captured reasoning', 'Final')); };
            await core.addUserMessage('Question');
            core.initThinkingChat();
            const first = native ? await api.callApi(KIMI, core.getMessagesForAPI(KIMI), createMockTokenCounter()) : [{ type: 'thought', content: 'Known reasoning' }, { type: 'text', content: 'Intermediate' }];
            await core.addAssistantMessage(first, KIMI);
            if (!native) {
                await api.callApi(KIMI, core.getMessagesForAPI(KIMI), createMockTokenCounter());
                expect(requests[0].messages.find(message => message.role === 'assistant').reasoning_content).toBe('Known reasoning');
            }
            solving = true;
            const second = await api.callApi(KIMI, core.getMessagesForAPI(KIMI), createMockTokenCounter());
            await core.addAssistantMessage(second, KIMI);
            state.thinkingMode = false;
            const saved = await storage.loadChat(core.getChatId());
            const aggregate = saved.messages[1].contents[0];
            for (const part of aggregate.filter(part => part.providerState)) expect(part.providerState.replayable).toBe(false);
            await core.addUserMessage('Continue');
            await api.callApi(KIMI, core.getMessagesForAPI(KIMI), createMockTokenCounter());
            const replay = requests.at(-1).messages.find(message => message.role === 'assistant');
            expect(replay.content).toContain('Final');
            expect(replay.content).toContain(native ? 'Final' : 'Intermediate');
            expect(replay.reasoning_content).toBeUndefined();
        });
    }

    test('arena thinking aggregation invalidates every native run and keeps the winning final answer', async () => {
        const { api, core, state, storage } = harness();
        let solving = false;
        Object.assign(state, {
            thinkingMode: true, isThinking: () => !solving, isSolving: () => solving,
            isInactive: () => solving, nextThinkingState() {}, getPrompt: type => `${type} instructions`,
            getArenaModelKey: () => 'model_a', getArenaModels: () => [KIMI, GEMINI]
        });
        const bodies = [];
        globalThis.fetch = async (_url, request) => {
            bodies.push(JSON.parse(request.body));
            return json(completion(`Native run ${bodies.length}`, bodies.length === 1 ? 'Intermediate answer' : 'Final answer'));
        };
        await core.addUserMessage('Question');
        core.initThinkingChat();
        core.initArena(KIMI, GEMINI);
        const first = await api.callApi(KIMI, core.getMessagesForAPI(KIMI), createMockTokenCounter());
        await core.updateArena(first, KIMI, 'model_a');
        solving = true;
        const second = await api.callApi(KIMI, core.getMessagesForAPI(KIMI), createMockTokenCounter());
        await core.updateArena(second, KIMI, 'model_a');
        state.thinkingMode = false;
        await core.updateArenaMisc(null, 'model_a');
        const saved = await storage.loadChat(core.getChatId());
        const aggregate = saved.messages[1].responses.model_a.messages[0];
        expect(aggregate.filter(part => part.providerState).map(part => part.providerState.message.reasoning_content)).toEqual(['Native run 1', 'Native run 2']);
        expect(aggregate.filter(part => part.providerState).every(part => part.providerState.replayable === false)).toBe(true);
        await core.addUserMessage('Continue');
        await api.callApi(KIMI, core.getMessagesForAPI(KIMI), createMockTokenCounter());
        expect(bodies[2].messages[1].content).toContain('Intermediate answer');
        expect(bodies[2].messages[1].content).toContain('Final answer');
        expect(bodies[2].messages[1].reasoning_content).toBeUndefined();
    });

    test('collector synthesis includes visible council answers, never expert capsules or private traces', async () => {
        const { core, state } = harness();
        state.getPrompt = () => 'Collect';
        await core.addUserMessage('Question');
        core.initCouncil([GEMINI, KIMI], KIMI);
        await core.updateCouncil([{ type: 'thought', content: 'private thought', providerState: { parts: signedParts } }, { type: 'text', content: 'Expert answer' }], GEMINI);
        const controller = Object.create(SidepanelController.prototype);
        Object.assign(controller, { chatCore: core, state });
        const messages = controller.buildCollectorPrompt([GEMINI, KIMI], KIMI);
        expect(messages.at(-1).parts[0].content).toContain('Expert answer');
        expect(JSON.stringify(messages)).not.toContain('private thought');
        expect(JSON.stringify(messages)).not.toContain('signature');
        expect(core.getLatestMessage().council.responses[GEMINI].parts[0].providerState.parts).toEqual(signedParts);
    });
});

describe('local loaded-model reasoning identity and abort boundaries', () => {
    for (const mode of ['normal', 'arena']) {
    test(`controller preserves the selected local key, actual API model and restored display label in ${mode}`, async () => {
        const { api, core, state, storage, makeCore } = harness();
        Object.assign(state, {
            isArenaModeActive: false, isCouncilModeActive: false, isInactive: () => true,
            getShouldThink: () => false, getShouldWebSearch: () => false, getReasoningEffort: () => 'high',
            getImageAspectRatio: () => 'auto', getImageResolution: () => '2K',
            getArenaModelKey: () => 'model_a', getArenaModels: () => ['local-model', 'gpt-6-sol']
        });
        const bodies = [];
        globalThis.fetch = async (url, request) => {
            if (url.includes('/v1/models')) return json({ data: [{ id: '/models/My-Local.gguf' }] });
            if (url.includes('/props')) return json({ model_path: '/models/My-Local.gguf', chat_template: 'template', chat_template_caps: { supports_preserve_reasoning: true } });
            bodies.push(JSON.parse(request.body));
            return json(completion());
        };
        const labels = [];
        const errors = [];
        const controller = Object.create(SidepanelController.prototype);
        Object.assign(controller, {
            api, chatCore: core, state,
            chatUI: {
                addManualAbortButton() {}, removeManualAbortButton() {}, getContentDiv: () => ({}),
                addErrorMessage: error => errors.push(error), updateLastMessageModelName: label => labels.push(label),
                setArenaModelDisplayName: (_model, label) => labels.push(label),
                ensureLatestAssistantRegenerate() {}
            }
        });
        controller.createStreamWriter = () => {
            const writer = new Writer();
            writer.addFooter = async () => writer.finalizeCurrentPart();
            return writer;
        };
        controller.createFooter = () => ({});
        await core.addUserMessage('Question');
        if (mode === 'arena') core.initArena('local-model', 'gpt-6-sol');
        await controller.makeApiCall('local-model', false, { mode });
        expect(errors).toEqual([]);
        const parts = mode === 'arena' ? core.getLatestMessage().responses.model_a.messages[0] : core.getLatestMessage().contents[0];
        expect(parts.at(-1).model).toBe('local-model');
        expect(parts.at(-1).apiModel).toBe('/models/My-Local.gguf');
        expect(parts.at(-1).displayModel).toBe('My Local');
        expect(parts[0].providerState.model).toBe('/models/My-Local.gguf');
        expect(labels).toEqual(['My Local']);
        const restored = makeCore();
        restored.buildFromDB(await storage.loadChat(core.getChatId()));
        if (mode === 'arena') {
            expect(controller.getStoredArenaModels(restored.getLatestMessage())[0]).toBe('local-model');
            await restored.updateArenaMisc(null, 'model_a');
        }
        await restored.addUserMessage('Continue');
        controller.chatCore = restored;
        await controller.makeApiCall('local-model');
        expect(errors).toEqual([]);
        expect(bodies[1].messages[1].reasoning_content).toBe('Native reasoning');
        const restoredParts = mode === 'arena' ? restored.currentChat.messages[1].responses.model_a.messages[0] : restored.currentChat.messages[1].contents[0];
        expect(restoredParts.at(-1).displayModel).toBe('My Local');
    });
    }

    for (const change of ['model', 'template', 'endpoint', 'capability']) {
        test(`local ${change} change omits prior native reasoning while preserving the visible answer`, async () => {
            const { api, core, storage, makeCore } = harness();
            let props = { model_path: '/models/A.gguf', chat_template: 'template A', chat_template_caps: { supports_preserve_reasoning: true } };
            const bodies = [];
            const urls = [];
            const override = { raw: 'local-model', display: 'A', port: 8181 };
            globalThis.fetch = async (url, request) => {
                urls.push(url);
                if (url.includes('/props')) return json(props);
                bodies.push(JSON.parse(request.body));
                return json(completion());
            };
            await core.addUserMessage('Question');
            const first = await api.callApi('local-model', core.getMessagesForAPI('local-model'), createMockTokenCounter(), null, null, { localModelOverride: override });
            expect(first[0].providerState.message.reasoning_content).toBe('Native reasoning');
            await core.addAssistantMessage(first, 'local-model');
            const restored = makeCore();
            restored.buildFromDB(await storage.loadChat(core.getChatId()));
            await restored.addUserMessage('Continue');
            await api.callApi('local-model', restored.getMessagesForAPI('local-model'), createMockTokenCounter(), null, null, { localModelOverride: override });
            expect(bodies[1].messages[1].reasoning_content).toBe('Native reasoning');
            if (change === 'model') props = { ...props, model_path: '/models/B.gguf' };
            if (change === 'template') props = { ...props, chat_template: 'template B' };
            if (change === 'endpoint') override.port = 8282;
            if (change === 'capability') props = { ...props, chat_template_caps: {} };
            const changed = await api.callApi('local-model', restored.getMessagesForAPI('local-model'), createMockTokenCounter(), null, null, { localModelOverride: override });
            expect(bodies[2].messages[1].reasoning_content).toBeUndefined();
            expect(bodies[2].messages[1].content).toBe('Visible answer');
            expect(restored.getChat().messages[1].contents[0][0].providerState).toEqual(first[0].providerState);
            if (change !== 'capability') expect(changed[0].providerState.scope).not.toBe(first[0].providerState.scope);
            expect(urls.filter(url => url.includes('/v1/models'))).toEqual([]);
            expect(bodies.every(body => body.model === 'local-model')).toBe(true);
            expect(override).not.toHaveProperty('reasoning');
        });
    }

    for (const props of [null, {}, { chat_template_caps: { supports_preserve_reasoning: true } }, { model_path: '/models/A.gguf', chat_template: 'template', chat_template_caps: {} }]) {
        test(`missing identity/capability cannot invent local reasoning support: ${JSON.stringify(props)}`, async () => {
            const { api } = harness();
            const bodies = [];
            globalThis.fetch = async (url, request) => {
                if (url.includes('/props')) return props === null ? new Response('', { status: 404 }) : json(props);
                bodies.push(JSON.parse(request.body));
                return json(completion());
            };
            const parts = await api.callApi('local-model', [{ role: 'user', parts: [{ type: 'text', content: 'Question' }] }], createMockTokenCounter(), null, null, { localModelOverride: { raw: 'local-model', port: 8181 } });
            expect(parts.find(part => part.type === 'text').content).toBe('Visible answer');
            expect(parts[0].providerState).toBeUndefined();
            expect(bodies[0].messages).toEqual([{ role: 'user', content: 'Question' }]);
            expect(JSON.stringify(bodies[0])).not.toContain('preserve_reasoning');
        });
    }

    for (const streaming of [false, true]) {
        test(`explicit local model colliding with cloud ID stays local for ${streaming ? 'SSE' : 'JSON'}`, async () => {
            const { api } = harness();
            const requests = [];
            globalThis.fetch = async (url, request) => {
                if (url.includes('/props')) return json({ model_path: '/models/local-sol.gguf', chat_template: 'local template', chat_template_caps: { supports_preserve_reasoning: true } });
                requests.push({ url, request });
                return streaming ? sse([{ choices: [{ delta: { reasoning_content: 'Local reasoning' }, finish_reason: null }] }, { choices: [{ delta: { content: 'Local answer' }, finish_reason: 'stop' }] }]) : json(completion('Local reasoning', 'Local answer'));
            };
            const writer = streaming ? new Writer() : null;
            const result = await api.callApi('gpt-6-sol', [{ role: 'user', parts: [{ type: 'text', content: 'Question' }] }], createMockTokenCounter(), writer, null, { localModelOverride: { raw: 'gpt-6-sol', port: 8181 } });
            const parts = writer ? writer.parts : result;
            expect(requests[0].url).toBe('http://localhost:8181/v1/chat/completions');
            expect(requests[0].request.headers.Authorization).toBeUndefined();
            expect(parts[0].providerState.provider).toBe('llamacpp');
            expect(parts[0].providerState.model).toBe('gpt-6-sol');
            expect(parts[0].providerState.message.reasoning_content).toBe('Local reasoning');
        });
    }

    for (const model of [KIMI, IMAGE]) {
        test(`aborted ${model} JSON response cannot become saved compatible reasoning`, async () => {
            const { api } = harness();
            const abort = new AbortController();
            globalThis.fetch = async () => ({ ok: true, json: async () => { abort.abort(); return model === IMAGE ? gemini(signedParts) : completion(); } });
            await expect(api.callApi(model, [{ role: 'user', parts: [{ type: 'text', content: 'Question' }] }], createMockTokenCounter(), null, abort)).rejects.toThrow();
        });
    }

    test('aborted SSE after visible output never finalizes a replayable capsule', async () => {
        const { api } = harness();
        const abort = new AbortController();
        globalThis.fetch = async () => new Response(new ReadableStream({ start(controller) {
            controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Partial visible answer', reasoning_content: 'Incomplete thoughts' }, finish_reason: null }] })}\n\n`));
            abort.abort();
            controller.close();
        } }));
        const writer = new Writer();
        await expect(api.callApi(KIMI, [{ role: 'user', parts: [{ type: 'text', content: 'Question' }] }], createMockTokenCounter(), writer, abort)).rejects.toThrow();
        expect(writer.parts.some(part => part.providerState?.replayable === true)).toBe(false);
    });

    test('props probing forwards cancellation without routing the explicit override elsewhere', async () => {
        const { api } = harness();
        const abort = new AbortController();
        const urls = [];
        globalThis.fetch = async (url, request) => {
            urls.push(url);
            if (url.includes('/props')) {
                abort.abort();
                request.signal.throwIfAborted();
            }
            request.signal.throwIfAborted();
            return json(completion());
        };
        await expect(api.callApi('local-model', [{ role: 'user', parts: [{ type: 'text', content: 'Question' }] }], createMockTokenCounter(), null, abort, { localModelOverride: { raw: 'Selected.gguf', port: 8181 } })).rejects.toThrow();
        expect(urls.every(url => url.startsWith('http://localhost:8181/'))).toBe(true);
    });
});
