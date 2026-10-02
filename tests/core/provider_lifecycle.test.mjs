import { afterEach, describe, expect, test } from 'bun:test';
import { parseHTML } from 'linkedom';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { ApiManager } from '../../src/js/api_manager.js';
import { SidepanelChatCore } from '../../src/js/chat_core.js';
import { SidepanelController } from '../../src/js/sidepanel_controller.js';
import { SidepanelChatUI } from '../../src/js/chat_ui.js';
import { ChatStorage } from '../../src/js/chat_storage.js';
import { createChromeMock } from '../setup.mjs';

const globalKeys = ['document', 'chrome', 'indexedDB', 'IDBKeyRange', 'requestAnimationFrame', 'fetch'];
const originalGlobals = Object.fromEntries(globalKeys.map(key => [key, globalThis[key]]));
const databases = [];

afterEach(async () => {
    for (const storage of databases.splice(0)) (await storage.getDB()).close();
    for (const key of globalKeys) {
        if (originalGlobals[key] === undefined) delete globalThis[key];
        else globalThis[key] = originalGlobals[key];
    }
});

const json = (body, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json' }
});
const completion = (content, usage = { prompt_tokens: 10, completion_tokens: 2 }) => json({
    choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }], usage
});
const sse = events => events.map(event => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`).join('');
const streamResponse = events => new Response(sse(events), { headers: { 'Content-Type': 'text/event-stream' } });
const deferred = () => {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
};

function createHarness({ models, currentModel, council = false, autoRename = false } = {}) {
    const { document } = parseHTML('<html><body><div id="conversation-wrapper"><h1 class="conversation-title">Original title</h1></div></body></html>');
    Object.assign(globalThis, {
        document, chrome: createChromeMock(), indexedDB: new IDBFactory(), IDBKeyRange,
        requestAnimationFrame: callback => { callback(0); return 0; }
    });
    const values = {
        models, api_keys: { deepseek: 'fixture-key', anthropic: 'fixture-key' },
        current_model: currentModel, auto_rename_model: currentModel, auto_rename: autoRename,
        max_tokens: 1000, temperature: 1, stream_response: false, show_model_name: true, loop_threshold: 2
    };
    const settingsManager = { getSetting: key => values[key], subscribeToSetting() {} };
    const api = new ApiManager({ settingsManager });
    const state = {
        shouldSave: true, thinkingMode: false, isArenaModeActive: false, isCouncilModeActive: council,
        getSetting: settingsManager.getSetting, initCouncilResponse() {}, initThinkingState() {},
        getShouldThink: () => false, getShouldWebSearch: () => false, getReasoningEffort: () => 'high',
        getImageAspectRatio: () => 'auto', getImageResolution: () => '2K', isInactive: () => true,
        isThinking: () => false, isSolving: () => false, getPrompt: () => 'Synthesize the experts',
        getCouncilCollectorModel: () => currentModel
    };
    const storage = new ChatStorage();
    storage.migrationRun = true;
    databases.push(storage);
    const titles = [];
    const ui = new SidepanelChatUI({ stateManager: state, continueFunc() {} });
    const core = new SidepanelChatCore(storage, state, ui.getChatHeader(), title => titles.push(title), null, api);
    core.reset('Original title');
    core.insertSystemMessage('Answer the user');
    const controller = Object.create(SidepanelController.prototype);
    Object.assign(controller, { api, state, chatCore: core, storage, chatUI: ui });
    return { document, values, api, storage, core, controller, ui, titles };
}

async function prepareNormal(harness, prompt = 'Question') {
    await harness.core.addUserMessage(prompt);
    harness.ui.addMessage('assistant', [], { model: harness.values.current_model, allowContinue: false });
}

const localModels = { llamacpp: { 'model-A': 'A', 'model-B': 'B', 'local-model': 'Local Model' } };
function installLocalRouter({ fallback = false } = {}) {
    const requests = [], probes = [], discoveries = [];
    globalThis.fetch = async (url, request) => {
        if (url.includes('/v1/models')) {
            discoveries.push(url);
            if (fallback && new URL(url).port === '8080') return json({ error: 'Not running' }, 503);
            return json({ data: [{ id: 'model-A', status: { value: 'loaded' } }, { id: 'model-B', status: { value: 'loaded' } }] });
        }
        if (url.includes('/props')) {
            probes.push(url);
            const selected = new URL(url).searchParams.get('model');
            return json({ model_path: `/models/${selected}.gguf`, model_alias: selected, chat_template: 'template',
                chat_template_caps: { supports_preserve_reasoning: true }, default_generation_settings: { params: {} } });
        }
        const body = JSON.parse(request.body);
        requests.push(body);
        return json({ choices: [{ message: { role: 'assistant', content: `Answer from ${body.model}`,
            reasoning_content: `Reasoning from ${body.model}` }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 9, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 4 } } });
    };
    return { requests, probes, discoveries };
}

describe('local selected-model lifecycle', () => {
    test('named selection B executes B and persists matching local replay identity', async () => {
        const harness = createHarness({ models: localModels, currentModel: 'model-B' });
        await prepareNormal(harness);
        const { requests, probes, discoveries } = installLocalRouter();
        const result = await harness.controller.makeApiCall('model-B');
        expect(result).toEqual({ success: true, inputTokens: 5, outputTokens: 2, cachedInputTokens: 4, cacheWriteInputTokens: 0 });
        expect(requests.map(request => request.model)).toEqual(['model-B']);
        expect(discoveries).toHaveLength(1);
        expect(probes.map(url => new URL(url).searchParams.get('model'))).toEqual(['model-B']);
        const parts = (await harness.storage.loadChat(harness.core.getChatId())).messages.at(-1).contents[0];
        expect(parts.at(-1).model).toBe('model-B');
        expect(parts.at(-1).apiModel).toBe('model-B');
        expect(parts[0].providerState.model).toBe('model-B');
        expect(harness.document.querySelector('.message-footer').textContent.toLowerCase()).toContain('cached');
    });

    test('named model selection retains B when the server is discovered on a fallback port', async () => {
        const harness = createHarness({ models: localModels, currentModel: 'model-B' });
        await prepareNormal(harness);
        const { requests, probes, discoveries } = installLocalRouter({ fallback: true });
        expect((await harness.controller.makeApiCall('model-B')).success).toBe(true);
        expect(requests.map(request => request.model)).toEqual(['model-B']);
        expect(discoveries.map(url => new URL(url).port)).toEqual(['8080', '8000']);
        expect(probes.map(url => [new URL(url).port, new URL(url).searchParams.get('model')])).toEqual([['8000', 'model-B']]);
        const parts = (await harness.storage.loadChat(harness.core.getChatId())).messages.at(-1).contents[0];
        expect(parts.at(-1).apiModel).toBe('model-B');
    });

    test('generic local-model discovers the first available model', async () => {
        const harness = createHarness({ models: localModels, currentModel: 'local-model' });
        await prepareNormal(harness);
        const { requests, probes, discoveries } = installLocalRouter();
        const result = await harness.controller.makeApiCall('local-model');
        expect(result.success).toBe(true);
        expect(requests.map(request => request.model)).toEqual(['model-A']);
        expect(discoveries).toHaveLength(1);
        expect(probes.map(url => new URL(url).searchParams.get('model'))).toEqual(['model-A']);
        const parts = (await harness.storage.loadChat(harness.core.getChatId())).messages.at(-1).contents[0];
        expect(parts.at(-1).model).toBe('local-model');
        expect(parts.at(-1).apiModel).toBe('model-A');
    });

    test('discovery errors report failure, clean up abort controls and do not persist an answer', async () => {
        const harness = createHarness({ models: localModels, currentModel: 'local-model' });
        await prepareNormal(harness);
        harness.api.getLocalModelConfig = async () => { throw new Error('Discovery unavailable'); };
        const result = await harness.controller.makeApiCall('local-model');
        expect(result.success).toBe(false);
        expect(harness.document.querySelector('.manual-abort-button')).toBeNull();
        expect(harness.document.querySelector('.message-footer')).not.toBeNull();
        expect(harness.document.body.textContent).toContain('Discovery unavailable');
        expect((await harness.storage.loadChat(harness.core.getChatId())).messages.at(-1).role).toBe('user');
    });

    test('abort during discovery cleans up without issuing a completion or error UI', async () => {
        const harness = createHarness({ models: localModels, currentModel: 'local-model' });
        await prepareNormal(harness);
        const started = deferred(), release = deferred();
        globalThis.fetch = async url => {
            expect(url).toContain('/v1/models');
            started.resolve();
            await release.promise;
            return json({ data: [{ id: 'model-A' }] });
        };
        const pending = harness.controller.makeApiCall('local-model');
        await started.promise;
        harness.document.querySelector('.manual-abort-button').onclick();
        release.resolve();
        expect((await pending).success).toBe(false);
        expect(harness.document.querySelector('.manual-abort-button')).toBeNull();
        expect(harness.document.querySelector('.message-footer')).not.toBeNull();
        expect(harness.document.querySelector('.system-message')).toBeNull();
        expect((await harness.storage.loadChat(harness.core.getChatId())).messages.at(-1).role).toBe('user');
    });
});

const experts = ['deepseek-flash', 'deepseek-v4-pro'];
const collector = 'deepseek-chat';
async function prepareCouncil(failedModels) {
    const harness = createHarness({
        models: { deepseek: Object.fromEntries([...experts, collector].map(id => [id, id])) },
        currentModel: collector, council: true
    });
    await harness.core.addUserMessage('Question');
    const requests = [];
    globalThis.fetch = async (_url, request) => {
        const body = JSON.parse(request.body);
        requests.push(body);
        return failedModels.includes(body.model)
            ? json({ error: { message: `${body.model} unavailable` } }, 503)
            : completion(`Answer from ${body.model}`, { prompt_tokens: 10, completion_tokens: 2, prompt_cache_hit_tokens: 6 });
    };
    await harness.controller.runCouncilFlow(experts, collector);
    return { ...harness, requests };
}

describe('Council successful-response gating', () => {
    test('all failed experts skip the collector and expose no continuation or regeneration', async () => {
        const harness = await prepareCouncil(experts);
        expect(harness.requests.map(request => request.model).sort()).toEqual([...experts].sort());
        expect(harness.core.getLatestMessage().contents).toEqual([]);
        expect(harness.document.querySelector('.council-collector [data-status="error"]')).not.toBeNull();
        expect(harness.document.querySelector('.council-continue-button')).toBeNull();
        expect(harness.document.querySelector('.regenerate-button')).toBeNull();
        harness.controller.restoreLatestAssistantActions();
        expect(harness.document.querySelector('.council-continue-button')).toBeNull();
        expect(harness.document.querySelector('.regenerate-button')).toBeNull();
        expect((await harness.storage.loadChat(harness.core.getChatId())).messages.at(-1).role).toBe('user');
    });

    test('one successful expert enables collector synthesis and persists only successful responses', async () => {
        const harness = await prepareCouncil([experts[0]]);
        const request = harness.requests.find(request => request.model === collector);
        expect(request.messages.at(-1).content).toContain(`Answer from ${experts[1]}`);
        expect(request.messages.at(-1).content).toContain(`<response model="${experts[0]}">[no response]</response>`);
        const message = (await harness.storage.loadChat(harness.core.getChatId())).messages.at(-1);
        expect(message.council.responses[experts[0]].parts).toEqual([]);
        expect(message.council.responses[experts[1]].parts.at(-1).content).toBe(`Answer from ${experts[1]}`);
        expect(message.contents[0].at(-1).content).toBe(`Answer from ${collector}`);
        expect(harness.document.querySelector('.council-continue-button')).not.toBeNull();
        expect(harness.document.querySelector('.council-collector .regenerate-button')).not.toBeNull();
        expect(harness.document.querySelector('.council-collector .message-footer').textContent.toLowerCase()).toContain('cached');
    });

    test('failed collector preserves expert answers but never enables success controls, including restoration', async () => {
        const harness = await prepareCouncil([collector]);
        expect(harness.requests.map(request => request.model)).toContain(collector);
        const message = (await harness.storage.loadChat(harness.core.getChatId())).messages.at(-1);
        expect(message.council.responses[experts[0]].parts.at(-1).content).toBe(`Answer from ${experts[0]}`);
        expect(message.council.responses[experts[1]].parts.at(-1).content).toBe(`Answer from ${experts[1]}`);
        expect(message.contents).toEqual([]);
        expect(harness.document.querySelector('.council-collector [data-status="error"]')).not.toBeNull();
        expect(harness.document.querySelector('.council-continue-button')).toBeNull();
        expect(harness.document.querySelector('.regenerate-button')).toBeNull();
        harness.controller.restoreLatestAssistantActions();
        expect(harness.document.querySelector('.council-continue-button')).toBeNull();
        expect(harness.document.querySelector('.regenerate-button')).toBeNull();
    });
});

function trackAutoRename(core) {
    const started = deferred();
    let result;
    const rename = core.renameManager.autoRename.bind(core.renameManager);
    core.renameManager.autoRename = (...args) => {
        result = rename(...args);
        started.resolve();
        return result;
    };
    return { started: started.promise, done: () => result };
}

async function beginDelayedRename(failure = false) {
    const harness = createHarness({ models: { deepseek: { 'deepseek-flash': 'Flash' } }, currentModel: 'deepseek-flash', autoRename: true });
    const started = deferred(), release = deferred();
    globalThis.fetch = async () => {
        started.resolve();
        await release.promise;
        if (failure) return json({ error: { message: 'Rename unavailable' } }, 503);
        return streamResponse([
            { choices: [{ delta: { content: 'Generated old title' }, finish_reason: null }] },
            { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } },
            '[DONE]'
        ]);
    };
    const rename = trackAutoRename(harness.core);
    await harness.core.addUserMessage('Explain the old conversation');
    await started.promise;
    return { ...harness, rename, release };
}

describe('automatic rename ownership', () => {
    test('delayed old rename updates old storage and tracking title without overwriting the new header', async () => {
        const harness = await beginDelayedRename();
        const oldChat = harness.core.getChat();
        harness.core.reset('New conversation title');
        harness.ui.updateChatHeader('New conversation title');
        harness.release.resolve();
        await harness.rename.done();
        await Promise.resolve();
        expect(harness.core.getTitle()).toBe('New conversation title');
        expect(harness.ui.getChatHeader().textContent).toBe('New conversation title');
        expect(oldChat.title).toBe('Generated old title');
        expect((await harness.storage.loadChat(oldChat.chatId)).title).toBe('Generated old title');
        expect(harness.titles).toEqual([]);
    });

    test('failed old auto-rename leaves both the new visible title and old stored title untouched', async () => {
        const harness = await beginDelayedRename(true);
        const oldChat = harness.core.getChat();
        harness.core.reset('New conversation title');
        harness.ui.updateChatHeader('New conversation title');
        harness.release.resolve();
        await expect(harness.rename.done()).rejects.toThrow('Rename unavailable');
        await Promise.resolve();
        expect(harness.core.getTitle()).toBe('New conversation title');
        expect(harness.ui.getChatHeader().textContent).toBe('New conversation title');
        expect((await harness.storage.loadChat(oldChat.chatId)).title).toBe('Original title');
        expect(harness.titles).toEqual([]);
    });

    test('rename still commits the visible title and callback when the captured chat remains current', async () => {
        const harness = await beginDelayedRename();
        expect(harness.ui.getChatHeader().textContent).toBe('Original title');
        harness.release.resolve();
        await harness.rename.done();
        await Promise.resolve();
        expect(harness.ui.getChatHeader().textContent).toBe('Generated old title');
        expect(harness.core.getTitle()).toBe('Generated old title');
        expect(harness.titles).toEqual(['Generated old title']);
        expect((await harness.storage.loadChat(harness.core.getChatId())).title).toBe('Generated old title');
    });

    test('explicit manual history rename still streams into its selected title element', async () => {
        const harness = createHarness({ models: { deepseek: { 'deepseek-flash': 'Flash' } }, currentModel: 'deepseek-flash' });
        await harness.core.addUserMessage('Question');
        const title = harness.document.createElement('span');
        title.textContent = 'History title';
        const firstChunk = deferred(), finish = deferred();
        const observer = new harness.document.defaultView.MutationObserver(() => {
            if (title.textContent === 'Live') {
                observer.disconnect();
                firstChunk.resolve();
            }
        });
        observer.observe(title, { childList: true, characterData: true, subtree: true });
        globalThis.fetch = async () => new Response(new ReadableStream({ async start(controller) {
            controller.enqueue(new TextEncoder().encode(sse([{ choices: [{ delta: { content: 'Live' }, finish_reason: null }] }])));
            await finish.promise;
            controller.enqueue(new TextEncoder().encode(sse([
                { choices: [{ delta: { content: ' title' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }, '[DONE]'
            ])));
            controller.close();
        } }), { headers: { 'Content-Type': 'text/event-stream' } });
        const pending = harness.core.renameManager.renameSingleChat(harness.core.getChatId(), title);
        await firstChunk.promise;
        expect(title.textContent).toBe('Live');
        finish.resolve();
        await pending;
        expect(title.textContent).toBe('Live title');
        expect((await harness.storage.loadChat(harness.core.getChatId())).title).toBe('Live title');
        expect(harness.ui.getChatHeader().textContent).toBe('Original title');
    });

    test('rename-all totals include cache reads and cache-write input from every renamed chat', async () => {
        const harness = createHarness({ models: { anthropic: { 'claude-test': 'Claude' } }, currentModel: 'claude-test' });
        await harness.core.addUserMessage('First question');
        const firstId = harness.core.getChatId();
        harness.core.reset('Second title');
        harness.core.insertSystemMessage('Instructions');
        await harness.core.addUserMessage('Second question');
        const secondId = harness.core.getChatId();
        globalThis.fetch = async (_url, request) => {
            const body = JSON.parse(request.body);
            const first = body.messages[0].content[0].text.includes('First question');
            const usage = first
                ? { input_tokens: 3, output_tokens: 2, cache_read_input_tokens: 11, cache_creation_input_tokens: 5 }
                : { input_tokens: 7, output_tokens: 4, cache_read_input_tokens: 13, cache_creation_input_tokens: 6 };
            return streamResponse([
                { type: 'message_start', message: { id: first ? 'rename-1' : 'rename-2', type: 'message', role: 'assistant', model: 'claude-test', content: [], usage } },
                { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
                { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: first ? 'First generated' : 'Second generated' } },
                { type: 'content_block_stop', index: 0 },
                { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: usage.output_tokens } },
                { type: 'message_stop' }
            ]);
        };
        const { tokenCounter, successCount } = await harness.core.renameManager.renameAllUnmodified();
        expect(successCount).toBe(2);
        expect(tokenCounter.inputTokens).toBe(21);
        expect(tokenCounter.outputTokens).toBe(6);
        expect(tokenCounter.cachedInputTokens).toBe(24);
        expect(tokenCounter.cacheWriteInputTokens).toBe(11);
        expect((await harness.storage.loadChat(firstId)).title).toBe('First generated');
        expect((await harness.storage.loadChat(secondId)).title).toBe('Second generated');
    });
});
