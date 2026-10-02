import { sanitizeBase64Image } from './image_utils.js';
import {
    credentialScope, nativeCandidate, prepareNativeRequest, finalizeNativeState,
    captureOpenAIStream, captureAnthropicStream, citationURLs, buildCitationsTail, buildInlineCitations
} from './reasoning_state.js';
import {
    rememberNativeRequest, prepareProviderNativeRequest, finalizeProviderNativeState,
    captureGemini, captureChatCompletion, captureGrokStream, grokCitations
} from './provider_native_state.js';

export const RoleEnum = { system: "system", user: "user", assistant: "assistant" };

export const MaxTemp = {
    openai: 2.0,
    anthropic: 1.0,
    gemini: 2.0,
    deepseek: 2.0,
    grok: 2.0,
    kimi: 1.0,
    mistral: 1.5
};

export const MaxTokens = {
    openai: 16384,
    openai_thinking: 100000,
    openai_56: 128000,
    openai_astra: 128000,
    anthropic: 32000,
    anthropic_thinking: 64000,
    anthropic_fable: 128000,
    gemini: 8192,
    gemini_modern: 65536,
    gemini_image: 32768,
    gemini_thinking: 65536,
    deepseek: 8000,
    deepseek_v4: 384000,
    anthropic_old: 8192,
    grok: 131072,
    kimi: 262144,
    kimi_k3: 1048576,
    mistral: 32768
};

export const DEFAULT_MODELS = {
    openai: { "gpt-6-astra": "GPT-6 Astra", "gpt-6-sol": "GPT-6 Sol", "gpt-6-luna": "GPT-6 Luna" },
    anthropic: { "claude-fable-5-1": "Claude Fable 5.1", "claude-opus-5-5": "Claude Opus 5.5" },
    gemini: { "gemini-3.5-flash": "Gemini 3.5 Flash", "gemini-3.8-flash": "Gemini 3.8 Flash", "gemini-3-pro-preview": "Gemini 3 Pro", "gemini-3-flash-preview": "Gemini 3 Flash", "gemini-3-pro-image-preview": "Nano Banana Pro", "gemini-2.5-flash-lite": "Gemini 2.5 Flash Lite", "gemini-3.1-flash-image-preview": "Nano Banana 2" },
    deepseek: { "deepseek-flash": "DeepSeek V4.1 Flash" },
    mistral: { "mistral-large-latest": "Mistral Large", "mistral-small-latest": "Mistral Small" },
    grok: { "grok-4": "Grok 4", "grok-4.1-fast-reasoning": "Grok 4.1 Fast Reasoning" },
    kimi: { "kimi-k3": "Kimi K3" },
    llamacpp: { "local-model": "Local Model" }
};

const CHATGPT_CODEX_ENDPOINT = 'https://chatgpt.com/backend-api/codex/responses';
// Codex requires 0.155.0 for GPT-6 Sol/Luna, 0.153.0 for Astra, and 0.144.0 for GPT-5.6.
const CHATGPT_CODEX_CLIENT_VERSION = '0.155.0';

export const isAnthropicOpusAtLeast = (model, major, minor = 0) => {
    const match = model.match(/^claude-opus-(\d+)(?:-(\d+))?(?:-|$)/);
    if (!match) return false;
    const modelMajor = Number(match[1]);
    const modelMinor = Number(match[2] || 0);
    return modelMajor > major || (modelMajor === major && modelMinor >= minor);
};

const isAnthropicFable = model => /^claude-fable-\d+(?:-|$)/.test(model);
const isAnthropicModernCustom = model => /^claude-(?:sonnet-5-5|mythos-5-1)(?:-|$)/.test(model);

const isOpenAIGpt56 = model => /^gpt-5\.6(?:-|$)/.test(model);

const isOpenAIAstra = model => /^gpt-6-astra(?:-|$)/.test(model);
const isOpenAIGpt6SolLuna = model => /^gpt-6-(?:sol|luna)(?:-|$)/.test(model);
const isOpenAISol61 = model => /^gpt-6\.1-sol(?:-|$)/.test(model);
const streamDisplays = new WeakMap();
const streamDisplay = (writer, state) => {
    const key = state || writer;
    if (!streamDisplays.has(key)) streamDisplays.set(key, { citations: new Set(), refusals: new Set(), completed: false });
    return streamDisplays.get(key);
};
const updateResponsesUsage = (usage, counter, includeWrites = false) => {
    const cached = usage.input_tokens_details?.cached_tokens || 0;
    counter.update((usage.input_tokens || 0) - cached, usage.output_tokens || 0, cached,
        includeWrites ? usage.input_tokens_details?.cache_write_tokens || 0 : 0);
};
const updateChatUsage = (usage, counter, cached = usage.prompt_tokens_details?.cached_tokens || 0, write = 0) => {
    counter.update((usage.prompt_tokens || 0) - cached, usage.completion_tokens || 0, cached, write);
};
const updateGeminiUsage = (usage, counter) => {
    const cached = usage.cachedContentTokenCount || 0;
    counter.update((usage.promptTokenCount || 0) - cached,
        (usage.candidatesTokenCount || 0) + (usage.thoughtsTokenCount || 0), cached, 0);
};
const updateAnthropicUsage = (usage, counter, partial = false) => {
    const write = usage.cache_creation_input_tokens ?? (partial ? counter.cacheWriteInputTokens : 0);
    const input = usage.input_tokens ?? (partial ? counter.inputTokens - counter.cacheWriteInputTokens : 0);
    counter.update(input + write, usage.output_tokens,
        usage.cache_read_input_tokens ?? (partial ? undefined : 0), write);
};

export class BaseProvider {
    constructor() {
        this.maxTemp = 1.0;
        this.maxTokens = 8192;
        this.streamCompletion = null;
    }

    async getReasoningScope(_auth) { return null; }

    async prepareRequest(_request) { return null; }

    finalizeResponseState(_responseState) { return null; }

    isThinkingDefaultOn(model) { return false; }

    getReasoningEfforts(model) { return []; }

    normalizeReasoningEffort(model, effort, fallback = 'medium') {
        const efforts = this.getReasoningEfforts(model);
        if (efforts.includes(effort)) return effort;
        return efforts.includes(fallback) ? fallback : efforts[0];
    }

    supports(feature, model) {
        if (feature === 'image') {
            return model?.includes('image') || model?.includes('imagen');
        }
        return false;
    }
    
    createRequest(params) { 
        throw new Error("Not implemented"); 
    }

    handleStream(params) { 
        throw new Error("Not implemented"); 
    }

    handleResponse(params) { 
        throw new Error("Not implemented"); 
    }

    // --- Helpers ---

    extractTextContent(msg) {
        if (!msg?.parts) return '';
        return msg.parts
            .filter(part => part.type === 'text' && part.content != null)
            .map(part => part.content)
            .join('\n');
    }

    parseBase64DataUrl(mediaData) {
        if (typeof mediaData !== 'string') {
            throw new Error('Invalid media data URL: expected a string in data:<mime>;base64,<data> format');
        }

        const match = mediaData.match(/^data:([^;,]+);base64,(.+)$/s);
        if (!match || !match[1] || !match[2]) {
            throw new Error('Invalid media data URL: expected data:<mime>;base64,<data> format');
        }

        return { mimeType: match[1], data: match[2] };
    }

    getBase64MediaType(base64String) { 
        return this.parseBase64DataUrl(base64String).mimeType;
    }

    simpleBase64Splitter(base64String) { 
        return this.parseBase64DataUrl(base64String).data;
    }


    buildCitationsTail(citations) { return buildCitationsTail(citations); }

    buildApiRequest(url, body, headers = {}) {
        return [url, {
            method: 'POST',
            credentials: 'omit',
            headers: { 'Content-Type': 'application/json', ...headers },
            body: JSON.stringify(body)
        }];
    }

    returnMessage(parts, thoughts = []) {
        const message = thoughts
            .filter(t => t)
            .map(t => ({ type: 'thought', content: t }));
            
        parts.forEach(p => {
            if (typeof p === 'string' && p) {
                message.push({ type: 'text', content: p });
            } else if (p && typeof p === 'object') {
                message.push(p);
            }
        });
        
        return message;
    }
}

export class OpenAICompatibleProvider extends BaseProvider {
    supports() { return false; }
    supportsImageMessages(_model) { return false; }
    formatMessages(messages, context) {
        const canSendImages = this.supportsImageMessages(context?.model);
        return messages.map(message => {
            const text = this.extractTextContent(message);
            if (canSendImages && message.images?.length) {
                const content = text ? [{ type: 'text', text }] : [];
                message.images.forEach(imageUrl => content.push({ type: 'image_url', image_url: { url: imageUrl } }));
                return { role: message.role, content };
            }
            return { role: message.role, content: text };
        });
    }
    getApiEndpoint() { throw new Error("Not implemented"); }
    getAuthHeaders({ apiKey }) { return { 'Authorization': `Bearer ${apiKey}` }; }
    getRequestModel({ model }) { return model; }
    beforeCreateRequest(_context) {}
    extendRequestBody(_body, _context) {}
    shouldIncludeMaxTokens() { return true; }
    shouldIncludeTemperature() { return true; }
    shouldIncludeStreamOptions({ stream }) { return stream; }
    getRequestTemperature({ settings }) { return Math.min(settings.temperature, this.maxTemp); }
    getRequestMaxTokens({ settings }) { return Math.min(settings.max_tokens, this.maxTokens); }

    createRequest({ model, messages, stream, settings, apiKey, options = {} }) {
        const context = { model, messages, stream, settings, apiKey, options };
        this.beforeCreateRequest(context);
        const body = {
            model: this.getRequestModel(context),
            messages: this.formatMessages(messages, context),
            stream
        };
        if (this.shouldIncludeMaxTokens(context)) body.max_tokens = this.getRequestMaxTokens(context);
        if (this.shouldIncludeTemperature(context)) body.temperature = this.getRequestTemperature(context);
        if (this.shouldIncludeStreamOptions(context)) body.stream_options = { include_usage: true };
        this.extendRequestBody(body, context);
        return this.buildApiRequest(this.getApiEndpoint(context), body, this.getAuthHeaders(context));
    }
    isUsageChunk(parsed) { return !!(parsed.usage && (!parsed.choices || parsed.choices.length === 0)); }
    updateStreamTokenUsage(parsed, tokenCounter) {
        updateChatUsage(parsed.usage, tokenCounter);
    }
    afterUsageChunk(_parsed, _writer) {}
    getStreamDelta(parsed) { return parsed.choices?.[0]?.delta; }
    processReasoningContent(reasoningContent, writer) { writer.processContent(reasoningContent, true); }
    requiresResponseUsage() { return true; }
    decorateResponseContent(content) { return content; }

    handleStream({ parsed, tokenCounter, writer }) {
        if (parsed.usage) this.updateStreamTokenUsage(parsed, tokenCounter);
        if (this.isUsageChunk(parsed)) {
            this.afterUsageChunk(parsed, writer);
            return;
        }
        const delta = this.getStreamDelta(parsed);
        if (delta?.reasoning_content) this.processReasoningContent(delta.reasoning_content, writer);
        if (delta?.content) writer.processContent(delta.content);
    }

    handleResponse({ data, tokenCounter }) {
        if (this.requiresResponseUsage() || data.usage) {
            this.updateStreamTokenUsage(data, tokenCounter);
        }
        const message = data.choices[0].message;
        const thoughts = message.reasoning_content ? [message.reasoning_content] : [];
        const content = this.decorateResponseContent(message.content, data);
        return this.returnMessage([content], thoughts);
    }
}

export class OpenAIProvider extends BaseProvider {
    constructor() { 
        super(); 
        this.maxTemp = MaxTemp.openai; 
        this.maxTokens = MaxTokens.openai; 
        this.streamCompletion = 'responses';
    }

    async getReasoningScope({ apiKey, chatGPTAuth }) {
        if (chatGPTAuth) return chatGPTAuth.accountId ? `chatgpt:${chatGPTAuth.accountId}` : null;
        return credentialScope(apiKey);
    }

    async prepareRequest(request) {
        const candidates = this.reasoningRequests?.get(request.requestOptions);
        this.reasoningRequests?.delete(request.requestOptions);
        return prepareNativeRequest('openai', request, candidates);
    }

    finalizeResponseState(responseState) { return finalizeNativeState(responseState); }

    supports(feature, model) {
        if (feature === 'reasoning') {
            return /o\d/.test(model) || model.includes('gpt-5') || isOpenAIAstra(model) || isOpenAIGpt6SolLuna(model) || isOpenAISol61(model);
        }
        if (feature === 'web_search') {
            const legacySearch = ['gpt-4.1', 'gpt-5'].some(substring => model.includes(substring)) && !model.includes('nano');
            return legacySearch || isOpenAIAstra(model) || isOpenAIGpt6SolLuna(model) || isOpenAISol61(model);
        }
        if (feature === 'reasoning_mode') return isOpenAIGpt56(model) || isOpenAIAstra(model) || isOpenAIGpt6SolLuna(model) || isOpenAISol61(model);
        return super.supports(feature, model);
    }

    getReasoningEfforts(model) {
        if (!this.supports('reasoning', model)) return [];
        if (isOpenAIAstra(model) || isOpenAISol61(model)) return ['low', 'medium', 'high', 'xhigh', 'max'];
        if (isOpenAIGpt56(model) || isOpenAIGpt6SolLuna(model)) {
            return ['none', 'low', 'medium', 'high', 'xhigh', 'max'];
        }
        return ['minimal', 'low', 'medium', 'high', 'xhigh'];
    }

    normalizeReasoningEffort(model, effort) {
        if (isOpenAIAstra(model) || isOpenAISol61(model)) {
            if (effort === 'none' || effort === 'minimal') return 'low';
        } else if (isOpenAIGpt56(model) && effort === 'minimal') {
            return 'none';
        }
        return super.normalizeReasoningEffort(model, effort, 'medium');
    }

    getOpenAIMaxTokens(model) {
        if (isOpenAIAstra(model) || isOpenAIGpt6SolLuna(model) || isOpenAISol61(model)) return MaxTokens.openai_astra;
        if (isOpenAIGpt56(model)) return MaxTokens.openai_56;
        return this.supports('reasoning', model) ? MaxTokens.openai_thinking : this.maxTokens;
    }

    formatMessages(messages, addImages) {
        return messages
            .filter(message => message.role !== RoleEnum.system)
            .map(message => {
                const content = [];
                const text = this.extractTextContent(message);
                
                if (text) {
                    content.push({ 
                        type: message.role === RoleEnum.assistant ? 'output_text' : 'input_text', 
                        text 
                    });
                }
                
                if (addImages && message.images) {
                    message.images.forEach(imageUrl => {
                        content.push({ type: 'input_image', image_url: imageUrl });
                    });
                }
                
                return { role: message.role, content };
            });
    }

    createRequest({ model, messages, stream, options, apiKey, chatGPTAuth, settings }) {
        const isReasoner = this.supports('reasoning', model);
        const isCurrentGPT6 = isOpenAIAstra(model) || isOpenAIGpt6SolLuna(model) || isOpenAISol61(model);
        const hasReasoningModes = this.supports('reasoning_mode', model);
        const shouldWebSearch = (options.webSearch ?? options.getWebSearch?.() ?? false) &&
                              this.supports('web_search', model);
        const noImage = model.includes('o1-mini') || model.includes('o1-preview') || model.includes('o3-mini');
        const systemMessage = messages.find(message => message.role === RoleEnum.system)?.parts
            ?.map(part => part.content).join('\n');

        if (isReasoner && options.streamWriter) {
            options.streamWriter.setThinkingModel();
        }

        const body = {
            model,
            input: this.formatMessages(messages, !noImage),
            stream: chatGPTAuth ? true : stream,
            store: false
        };

        if (chatGPTAuth) {
            // Account identity, rather than the rotating access token, gates local replay.
            body.instructions = systemMessage || 'You are a helpful assistant.';
        } else {
            body.max_output_tokens = Math.min(settings.max_tokens, this.getOpenAIMaxTokens(model));
            if (systemMessage) body.instructions = systemMessage;
        }

        if (shouldWebSearch) {
            body.tools = [{ type: isCurrentGPT6 ? "web_search" : "web_search_preview" }];
        }

        if (isReasoner) {
            const requestedEffort = options.reasoningEffort ?? options.getOpenAIReasoningEffort?.() ?? 'medium';
            body.reasoning = {
                effort: this.normalizeReasoningEffort(model, requestedEffort),
                summary: 'auto'
            };
            if (hasReasoningModes && options.reasoningMode === 'pro') {
                body.reasoning.mode = 'pro';
            } else if (hasReasoningModes && !chatGPTAuth) {
                body.reasoning.mode = 'standard';
            }
        } else if (!chatGPTAuth) {
            body.temperature = Math.min(settings.temperature, this.maxTemp);
        }

        const request = chatGPTAuth
            ? this.buildApiRequest(CHATGPT_CODEX_ENDPOINT, body, {
                'Authorization': `Bearer ${chatGPTAuth.access}`,
                'chatgpt-account-id': chatGPTAuth.accountId,
                'OpenAI-Beta': 'responses=experimental',
                'originator': 'pi',
                'version': CHATGPT_CODEX_CLIENT_VERSION,
                'Accept': 'text/event-stream'
            })
            : this.buildApiRequest('https://api.openai.com/v1/responses', body, {
                'Authorization': `Bearer ${apiKey}`
            });
        this.reasoningRequests ??= new WeakMap();
        this.reasoningRequests.set(request[1], messages.filter(message => message.role !== RoleEnum.system)
            .map(message => nativeCandidate(message, 'openai')));
        return request;
    }

    createTranscriptionRequest({ model, audioBlob, apiKey, options }) {
        const formData = new FormData();
        formData.append('model', model);
        formData.append('file', audioBlob, options.filename || 'audio.webm');
        
        if (options.language) {
            formData.append('language', options.language);
        }
        
        return ['https://api.openai.com/v1/audio/transcriptions', { 
            method: 'POST', 
            credentials: 'omit', 
            headers: { 'Authorization': `Bearer ${apiKey}` }, 
            body: formData 
        }];
    }

    handleStream({ parsed, tokenCounter, writer, responseState }) {
        captureOpenAIStream(parsed, responseState);
        const display = streamDisplay(writer, responseState);
        if (parsed.type === 'response.reasoning_summary_text.delta' && parsed.delta) {
            writer.processContent(parsed.delta, true);
        } else if (parsed.type === 'response.output_text.delta' && parsed.delta) {
            writer.processContent(parsed.delta);
        } else if (parsed.type === 'response.refusal.delta' && parsed.delta) {
            display.refusals.add(`${parsed.output_index ?? 0}:${parsed.content_index ?? 0}`);
            writer.processContent(parsed.delta);
        } else if (parsed.type === 'response.refusal.done' && parsed.refusal) {
            const key = `${parsed.output_index ?? 0}:${parsed.content_index ?? 0}`;
            if (!display.refusals.has(key)) writer.processContent(parsed.refusal);
            display.refusals.add(key);
        } else if (parsed.type === 'response.output_text.annotation.added') {
            const url = parsed.annotation?.url || parsed.annotation?.url_citation?.url;
            if (url) display.citations.add(url);
        } else if (parsed.type === 'response.completed' && !display.completed) {
            display.completed = true;
            const output = parsed.response?.output || responseState?.payload || [];
            output.forEach((item, index) => (item.content || []).forEach((block, contentIndex) => {
                if (block.type === 'refusal' && !display.refusals.has(`${index}:${contentIndex}`) && block.refusal) {
                    writer.processContent(block.refusal);
                }
            }));
            const citations = citationURLs('openai', output);
            const tail = buildInlineCitations(citations.length ? citations : [...display.citations]);
            if (tail) writer.processContent(tail);
            if (parsed.response?.usage) updateResponsesUsage(parsed.response.usage, tokenCounter, true);
        } else if (['response.failed', 'error'].includes(parsed.type)) {
            throw new Error(parsed.response?.error?.message || parsed.error?.message || parsed.message || 'OpenAI response failed');
        }
    }

    handleResponse({ data, tokenCounter, responseState }) {
        const output = data.output || [];
        if (responseState) {
            responseState.payload = output;
            responseState.completed = data.status === 'completed';
        }
        const parts = [];
        for (const item of output) {
            if (!item || typeof item !== 'object') continue;
            if (item.type === 'reasoning') {
                if (typeof item.summary === 'string' && item.summary) {
                    parts.push({ type: 'thought', content: item.summary });
                } else if (Array.isArray(item.summary)) {
                    for (const summary of item.summary) {
                        if (typeof summary?.text === 'string' && summary.text) {
                            parts.push({ type: 'thought', content: summary.text });
                        }
                    }
                }
            } else if (item.type === 'reasoning_summary_text' && item.text) {
                parts.push({ type: 'thought', content: item.text });
            } else if (item.type === 'message' && Array.isArray(item.content)) {
                let text = '';
                for (const part of item.content) {
                    if (part?.type === 'output_text') text += part.text || '';
                    else if (part?.type === 'refusal') text += part.refusal || '';
                }
                if (text) parts.push({ type: 'text', content: text });
            }
        }
        const tail = buildInlineCitations(citationURLs('openai', output));
        if (tail) parts.push({ type: 'text', content: tail });
        if (data.usage) updateResponsesUsage(data.usage, tokenCounter, true);
        return parts;
    }
}

export class AnthropicProvider extends BaseProvider {
    constructor() { 
        super(); 
        this.maxTemp = MaxTemp.anthropic; 
        this.maxTokens = MaxTokens.anthropic; 
        this.streamCompletion = 'anthropic';
    }

    async getReasoningScope({ apiKey }) { return credentialScope(apiKey); }

    async prepareRequest(request) {
        const candidates = this.reasoningRequests?.get(request.requestOptions);
        this.reasoningRequests?.delete(request.requestOptions);
        return prepareNativeRequest('anthropic', request, candidates);
    }

    finalizeResponseState(responseState) { return finalizeNativeState(responseState); }

    supports(feature, model) {
        if (feature === 'reasoning') {
            return isAnthropicFable(model) || isAnthropicModernCustom(model) || isAnthropicOpusAtLeast(model, 4, 6);
        }
        
        if (feature === 'thinking') {
            return ['3-7-sonnet', 'sonnet-4'].some(name => model.includes(name)) ||
                isAnthropicFable(model) || isAnthropicModernCustom(model) || isAnthropicOpusAtLeast(model, 4);
        }
        
        if (feature === 'web_search') {
            return ['3-7-sonnet', '3-5-sonnet-latest', '3-5-haiku-latest', 'sonnet-4']
                .some(name => model.includes(name)) || isAnthropicFable(model) || isAnthropicModernCustom(model) ||
                isAnthropicOpusAtLeast(model, 4);
        }
        
        return super.supports(feature, model);
    }

    getReasoningEfforts(model) {
        if (isAnthropicFable(model) || isAnthropicModernCustom(model)) return ['low', 'medium', 'high', 'xhigh', 'max'];
        if (isAnthropicOpusAtLeast(model, 4, 7)) return ['low', 'medium', 'high', 'xhigh', 'max'];
        if (isAnthropicOpusAtLeast(model, 4, 6)) return ['low', 'medium', 'high', 'max'];
        return [];
    }

    normalizeReasoningEffort(model, effort) {
        if (effort === 'minimal') return 'low';
        if (model === 'claude-opus-4-6' && effort === 'xhigh') return 'max';
        return super.normalizeReasoningEffort(model, effort, 'high');
    }

    formatMessages(messages) {
        const formattedMessages = messages.map(message => {
            const text = this.extractTextContent(message);
            const content = [{ type: 'text', text }];
            
            if (message.images) {
                message.images.forEach(imageUrl => {
                    content.push({ 
                        type: 'image', 
                        source: { 
                            type: 'base64', 
                            media_type: this.getBase64MediaType(imageUrl), 
                            data: this.simpleBase64Splitter(imageUrl) 
                        } 
                    });
                });
            }
            return { role: message.role, content };
        });
        
        if (formattedMessages.length > 0) {
            formattedMessages.at(-1).content.at(-1).cache_control = { type: "ephemeral" };
        }
        return formattedMessages;
    }

    createRequest({ model, messages, stream, options, apiKey, settings }) {
        const hasReasoningLevels = this.supports('reasoning', model);
        const canThink = this.supports('thinking', model);
        const isThinking = hasReasoningLevels ||
            (canThink && (options.shouldThink ?? options.getShouldThink?.() ?? false));
        const shouldWebSearch = (options.webSearch ?? options.getWebSearch?.() ?? false) && 
                              this.supports('web_search', model);
        
        let maxLimit = this.maxTokens;
        if (isAnthropicFable(model) || isAnthropicModernCustom(model) || isAnthropicOpusAtLeast(model, 4, 8)) {
            maxLimit = MaxTokens.anthropic_fable;
        } else if (isThinking) {
            maxLimit = MaxTokens.anthropic_thinking;
        } else if (model.includes('opus')) {
            maxLimit = MaxTokens.anthropic;
        } else if (!canThink) {
            maxLimit = MaxTokens.anthropic_old;
        }
        
        const maxTokens = Math.min(settings.max_tokens, maxLimit);
        const systemMessage = messages.find(m => m.role === RoleEnum.system);
        const history = messages.filter(message => message.role !== RoleEnum.system);
        const formatted = this.formatMessages(history);
        
        const body = { 
            model, 
            messages: formatted,
            max_tokens: maxTokens, 
            stream 
        };

        if (systemMessage) {
            body.system = [{ type: 'text', text: this.extractTextContent(systemMessage) }];
        }


        if (isThinking) {
            if (hasReasoningLevels) {
                const requestedEffort = options.reasoningEffort ?? options.getOpenAIReasoningEffort?.() ?? 'high';
                const effort = this.normalizeReasoningEffort(model, requestedEffort);
                body.thinking = { type: 'adaptive', display: 'summarized' };
                body.output_config = { effort };
            } else {
                if (maxTokens <= 1024) {
                    throw new Error('Anthropic manual thinking requires max_tokens greater than 1024 (the minimum thinking budget). Increase your token cap or turn thinking off.');
                }
                body.thinking = {
                    type: "enabled",
                    budget_tokens: Math.max(1024, maxTokens - 4000)
                };
            }
            // Anthropic always streams thinking content - use collapsible block, not counter
            if (options.streamWriter) {
                options.streamWriter.setThinkingModel();
            }
        } else {
            body.temperature = Math.min(settings.temperature, this.maxTemp);
        }

        if (shouldWebSearch) {
            body.tools = [{ 
                type: "web_search_20250305", 
                name: "web_search", 
                max_uses: 2 
            }];
        }

        const request = this.buildApiRequest('https://api.anthropic.com/v1/messages', body, {
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'anthropic-dangerous-direct-browser-access': 'true'
        });
        this.reasoningRequests ??= new WeakMap();
        this.reasoningRequests.set(request[1], history.map(message => nativeCandidate(message, 'anthropic')));
        return request;
    }

    handleStream({ parsed, tokenCounter, writer, responseState }) {
        captureAnthropicStream(parsed, responseState);
        const display = streamDisplay(writer, responseState);
        if (parsed.type === 'content_block_start') {
            for (const citation of parsed.content_block?.citations || []) {
                if (citation.url) display.citations.add(citation.url);
            }
        } else if (parsed.type === 'content_block_delta' && parsed.delta?.type === 'citations_delta') {
            if (parsed.delta.citation?.url) display.citations.add(parsed.delta.citation.url);
        }
        if (parsed.type === 'content_block_delta') {
            const delta = parsed.delta || {};
            if (delta.type === 'text_delta') {
                writer.processContent(delta.text);
            } else if (delta.type === 'thinking_delta') {
                writer.processContent(delta.thinking, true);
            } else if (delta.text) {
                writer.processContent(delta.text);
            } else if (delta.thinking) {
                writer.processContent(delta.thinking, true);
            }
        } else if (parsed.type === 'content_block_start') {
            if (parsed.content_block?.type === 'redacted_thinking') {
                if (!writer._lastContentWasRedacted) { 
                    writer.processContent("\n\n```\n*redacted thinking*\n```\n\n", true); 
                    writer._lastContentWasRedacted = true; 
                }
            } else {
                writer._lastContentWasRedacted = false;
                if (parsed.content_block?.type === 'text' && parsed.content_block.text) {
                    writer.processContent(parsed.content_block.text);
                } else if (parsed.content_block?.type === 'thinking' && parsed.content_block.thinking) {
                    writer.processContent(parsed.content_block.thinking, true);
                }
            }
        } else if (parsed.type === 'message_start' && parsed.message?.usage) {
            const usage = parsed.message.usage;
            updateAnthropicUsage(usage, tokenCounter);
        } else if (parsed.type === 'message_delta' && parsed.usage) {
            updateAnthropicUsage(parsed.usage, tokenCounter, true);
        } else if (parsed.type === 'message_stop' && !display.completed) {
            display.completed = true;
            const citations = responseState ? citationURLs('anthropic', responseState.payload) : [...display.citations];
            const tail = buildInlineCitations(citations);
            if (tail) writer.processContent(tail);
        } else if (parsed.type === 'error') {
            throw new Error(parsed.error?.message || 'Anthropic Error');
        }
    }

    handleResponse({ data, tokenCounter, responseState }) {
        const content = data.content || [];
        if (responseState) {
            responseState.payload = content;
            responseState.completed = !!data.stop_reason && data.stop_reason !== 'max_tokens';
        }
        const usage = data.usage;
        if (usage) {
            updateAnthropicUsage(usage, tokenCounter);
        }
        const parts = [];
        for (const block of content) {
            if (block.type === 'thinking' && block.thinking) {
                parts.push({ type: 'thought', content: block.thinking });
            } else if (block.type === 'redacted_thinking') {
                parts.push({ type: 'thought', content: "\n\n```\n*redacted thinking*\n```\n\n" });
            } else if (block.type === 'text' && block.text) {
                parts.push({ type: 'text', content: block.text });
            }
        }
        const tail = buildInlineCitations(citationURLs('anthropic', content));
        if (tail) parts.push({ type: 'text', content: tail });
        return parts;
    }
}

export class GeminiProvider extends BaseProvider {
    constructor() { 
        super(); 
        this.maxTemp = MaxTemp.gemini; 
        this.maxTokens = MaxTokens.gemini; 
        this.streamCompletion = 'gemini';
    }

    async getReasoningScope({ apiKey }) { return credentialScope(apiKey); }

    async prepareRequest(request) { return prepareProviderNativeRequest('gemini', request); }

    finalizeResponseState(state) { return finalizeProviderNativeState(state); }

    supports(feature, model) {
        if (feature === 'reasoning') {
            return /gemini-[3-9]\.?\d*|gemini-\d{2,}/.test(model) && !model.includes('image');
        }
        if (feature === 'thinking_toggle') {
            return model.includes('gemini-2.5') && model.includes('flash') && !model.includes('image');
        }
        if (feature === 'web_search') {
            return /gemini-[2-9]\.?\d*|gemini-\d{2,}/.test(model) && !model.includes('image');
        }
        return super.supports(feature, model);
    }

    getReasoningEfforts(model) {
        if (!this.supports('reasoning', model)) return [];
        if (model === 'gemini-3.8-flash') return ['low', 'medium', 'high'];
        return model === 'gemini-3.5-flash'
            ? ['minimal', 'low', 'medium', 'high']
            : ['minimal', 'low', 'medium', 'high', 'xhigh'];
    }

    normalizeReasoningEffort(model, effort) {
        if (model === 'gemini-3.8-flash') {
            if (effort === 'minimal') return 'low';
            if (effort === 'xhigh' || effort === 'max') return 'high';
        } else if (model === 'gemini-3.5-flash' && (effort === 'xhigh' || effort === 'max')) {
            return 'high';
        }
        return super.normalizeReasoningEffort(model, effort, 'medium');
    }

    getGeminiMaxTokens(model) {
        if (model.includes('image')) return MaxTokens.gemini_image;
        if (/gemini-[2-9]\.?\d*|gemini-\d{2,}/.test(model)) return MaxTokens.gemini_modern;
        return this.maxTokens;
    }

    formatMessages(messages) {
        return messages.map(message => {
            const parts = [];
            (message.parts || []).forEach(part => {
                if (message.role === RoleEnum.assistant && part.thought) return;
                if ((part.type === 'image' || part.type === 'audio') && part.content) {
                    const entry = { 
                        inline_data: { 
                            mime_type: this.getBase64MediaType(part.content), 
                            data: this.simpleBase64Splitter(part.content) 
                        } 
                    };
                    if (message.role !== RoleEnum.assistant && part.thoughtSignature) entry.thoughtSignature = part.thoughtSignature;
                    parts.push(entry);
                } else if (part.type === 'text' || message.role !== RoleEnum.assistant && part.thoughtSignature) {
                    const entry = { text: part.content ?? '' };
                    if (message.role !== RoleEnum.assistant && part.thoughtSignature) entry.thoughtSignature = part.thoughtSignature;
                    parts.push(entry);
                }
            });
            
            if (message.images) {
                message.images.forEach(imageUrl => { 
                    if (imageUrl) {
                        parts.push({ 
                            inline_data: { 
                                mime_type: this.getBase64MediaType(imageUrl), 
                                data: this.simpleBase64Splitter(imageUrl) 
                            } 
                        });
                    }
                });
            }

            if (message.audio) {
                message.audio.forEach(audioItem => {
                    const audioData = typeof audioItem === 'string' ? audioItem : audioItem?.data;
                    if (audioData) {
                        parts.push({
                            inline_data: {
                                mime_type: this.getBase64MediaType(audioData),
                                data: this.simpleBase64Splitter(audioData)
                            }
                        });
                    }
                });
            }
            
            if (!parts.length) parts.push({ text: '' });
            return { role: message.role === RoleEnum.assistant ? "model" : "user", parts };
        });
    }

    createRequest({ model, messages, stream, options, apiKey, settings }) {
        const isGemini3 = this.supports('reasoning', model);
        const isGemini25 = model.includes('gemini-2.5') && !model.includes('image');
        const isGemini25Pro = isGemini25 && model.includes('pro');
        const canToggle = this.supports('thinking_toggle', model);
        const isThinking = isGemini3 || isGemini25Pro || 
            (canToggle && (options.shouldThink ?? options.getShouldThink?.() ?? false));
        const shouldWebSearch = (options.webSearch ?? options.getWebSearch?.() ?? false) &&
            this.supports('web_search', model);
        
        if (isThinking && options.streamWriter) {
            options.streamWriter.setThinkingModel();
        }
        
        const formatted = this.formatMessages(messages);
        const maxTokens = Math.min(
            settings.max_tokens, 
            isThinking ? MaxTokens.gemini_thinking : this.getGeminiMaxTokens(model)
        );

        const generationConfig = {
            maxOutputTokens: maxTokens,
            responseMimeType: "text/plain"
        };
        if (!isGemini3) generationConfig.temperature = Math.min(settings.temperature, this.maxTemp);

        if (isGemini3) {
            const requestedEffort = options.reasoningEffort ?? options.getGeminiThinkingLevel?.() ?? 'medium';
            const effort = this.normalizeReasoningEffort(model, requestedEffort);
            const isFlash = model.includes('flash');
            const level = isFlash 
                ? (effort === 'xhigh' ? 'high' : effort) 
                : ((effort === 'minimal' || effort === 'low') ? 'low' : 'high');
            generationConfig.thinking_config = { thinkingLevel: level, include_thoughts: true };
        } else if (isThinking) {
            generationConfig.thinking_config = { thinkingBudget: -1, include_thoughts: true };
        } else if (canToggle && !model.includes('lite')) {
            generationConfig.thinking_config = { thinkingBudget: 0 };
        }
        
        const baseUrl = 'https://generativelanguage.googleapis.com/v1beta/models/';
        const endpoint = stream ? "streamGenerateContent?alt=sse&" : "generateContent?";
        const url = `${baseUrl}${model}:${endpoint}key=${apiKey}`;
        const hasSystem = messages[0]?.role === RoleEnum.system;

        const body = { 
            contents: hasSystem ? formatted.slice(1) : formatted, 
            safetySettings: [
                { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" }, 
                { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" }, 
                { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" }, 
                { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
            ], 
            generationConfig: generationConfig 
        };

        if (hasSystem) {
            body.systemInstruction = { parts: formatted[0].parts };
        }

        if (shouldWebSearch) {
            body.tools = [{ google_search: {} }];
        }

        return rememberNativeRequest(this, 'gemini', this.buildApiRequest(url, body),
            hasSystem ? messages.slice(1) : messages);
    }

    createImageRequest({ model, messages, apiKey, settings, options }) {
        const formatted = this.formatMessages(messages);
        const isGemini3 = /gemini-[3-9]|gemini-\d{2,}/.test(model);
        
        const aspectRatio = options.imageAspectRatio ?? options.getImageAspectRatio?.();
        const imageResolution = options.imageResolution ?? options.getImageResolution?.();
        const imageConfig = { 
            ...(aspectRatio && aspectRatio !== 'auto' && { aspectRatio }), 
            ...(isGemini3 && imageResolution && { imageSize: imageResolution }) 
        };

        const hasSystem = messages[0]?.role === RoleEnum.system;

        const body = { 
            contents: hasSystem ? formatted.slice(1) : formatted, 
            safetySettings: [
                { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" }, 
                { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" }, 
                { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" }, 
                { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
            ], 
            generationConfig: { 
                temperature: Math.min(settings.temperature, this.maxTemp), 
                maxOutputTokens: Math.min(settings.max_tokens, this.getGeminiMaxTokens(model)), 
                responseModalities: ["IMAGE"],
                ...(Object.keys(imageConfig).length && { imageConfig }) 
            } 
        };

        if (hasSystem) {
            body.systemInstruction = { parts: formatted[0].parts };
        }

        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
        return rememberNativeRequest(this, 'gemini', this.buildApiRequest(url, body),
            hasSystem ? messages.slice(1) : messages);
    }

    handleStream({ parsed, tokenCounter, writer, responseState }) {
        captureGemini(parsed, responseState);
        const parts = parsed.candidates?.[0]?.content?.parts;
        if (parts) {
            parts.forEach(part => {
                if (part.text !== undefined) writer.processContent(part.text, !!part.thought);
                // Native signature placement belongs to the capsule, not merged UI text.
                const data = part.inlineData || part.inline_data;
                if (data?.data) {
                    const mimeType = data.mimeType || data.mime_type || 'image/png';
                    const content = `data:${mimeType};base64,${sanitizeBase64Image(data.data, mimeType)}`;
                    writer.processImage?.(content, { thought: !!part.thought });
                }
            });
        }
        const usage = parsed.usageMetadata;
        if (usage) updateGeminiUsage(usage, tokenCounter);
    }

    handleResponse({ data, tokenCounter, responseState }) {
        captureGemini(data, responseState, false);
        const usage = data.usageMetadata || {};
        updateGeminiUsage(usage, tokenCounter);
        
        const parts = data.candidates?.[0]?.content?.parts || [];
        const messageParts = [];
        
        parts.forEach(part => {
            if (part.text !== undefined) {
                messageParts.push({ type: part.thought ? 'thought' : 'text', content: part.text || '' });
            } else if ((part.inlineData || part.inline_data)?.data) {
                const data = part.inlineData || part.inline_data;
                const mimeType = data.mimeType || data.mime_type || 'image/png';
                const base64 = sanitizeBase64Image(data.data, mimeType);
                messageParts.push({ type: 'image', thought: !!part.thought, content: `data:${mimeType};base64,${base64}` });
            }
        });
        
        return messageParts.length ? messageParts : this.returnMessage(['']);
    }
}

export class DeepSeekProvider extends OpenAICompatibleProvider {
    constructor() { 
        super(); 
        this.maxTemp = MaxTemp.deepseek; 
        this.maxTokens = MaxTokens.deepseek; 
        this.streamCompletion = 'chat-done';
    }

    updateStreamTokenUsage(parsed, tokenCounter) {
        updateChatUsage(parsed.usage, tokenCounter, parsed.usage.prompt_cache_hit_tokens || 0);
    }

    getApiEndpoint() {
        return 'https://api.deepseek.com/v1/chat/completions';
    }

    isDeepSeekV4(model) {
        return !!model && (model.startsWith('deepseek-v4') || model.startsWith('deepseek-flash'));
    }

    getRequestMaxTokens({ model, settings }) {
        return Math.min(settings.max_tokens, this.isDeepSeekV4(model) ? MaxTokens.deepseek_v4 : this.maxTokens);
    }

    // Docs: only the Flash family reads images. The retired deepseek-v4-flash ids are served by
    // DeepSeek-V4.1-Flash, while deepseek-v4-pro and the older chat/reasoner ids stay text-only.
    supportsImageMessages(model) {
        return !!model && (model.startsWith('deepseek-flash') || model.startsWith('deepseek-v4-flash'));
    }

    formatMessages(messages, context) {
        const formatted = super.formatMessages(messages, context);
        if (!context?.model?.startsWith('deepseek-')) return formatted;
        formatted.forEach((message, index) => {
            if (message.role !== RoleEnum.assistant || messages[index].parts?.some(part => part.providerState)) return;
            const reasoning = (messages[index].parts || [])
                .filter(part => part.type === 'thought' && part.model === context.model)
                .map(part => part.content || '').join('\n');
            if (reasoning) message.reasoning_content = reasoning;
        });
        return formatted;
    }

    beforeCreateRequest({ model, options }) {
        const isThinking = this.isDeepSeekV4(model) || model.includes('reasoner') || (options.shouldThink ?? options.getShouldThink?.() ?? false);
        if (isThinking && options.streamWriter) {
            options.streamWriter.setThinkingModel();
        }
    }

    isThinkingDefaultOn(model) { return model.includes('reasoner') || this.isDeepSeekV4(model); }

    supports(feature, model) {
        if (feature === 'thinking_toggle') return !model.includes('reasoner') && !this.isDeepSeekV4(model);
        if (feature === 'thinking') return true;
        if (feature === 'reasoning') return this.isDeepSeekV4(model);
        return super.supports(feature, model);
    }

    getReasoningEfforts(model) {
        return this.isDeepSeekV4(model) ? ['low', 'high', 'max'] : [];
    }

    normalizeReasoningEffort(model, effort) {
        if (!this.isDeepSeekV4(model)) return super.normalizeReasoningEffort(model, effort);
        return this.getReasoningEfforts(model).includes(effort) ? effort : 'high';
    }

    getDeepSeekReasoningEffort({ model, options }) {
        const effort = options.reasoningEffort ?? options.getOpenAIReasoningEffort?.() ?? 'high';
        if (this.isDeepSeekV4(model)) {
            return this.normalizeReasoningEffort(model, effort);
        }
        return effort === 'xhigh' || effort === 'max' ? 'max' : 'high';
    }

    extendRequestBody(body, { model, options }) {
        const isThinking = this.isDeepSeekV4(model) || model.includes('reasoner') || (options.shouldThink ?? options.getShouldThink?.() ?? false);
        body.thinking = { type: isThinking ? 'enabled' : 'disabled' };
        if (isThinking) {
            body.reasoning_effort = this.getDeepSeekReasoningEffort({ model, options });
        }
    }

    shouldIncludeTemperature({ model }) {
        return !model.includes('reasoner') && !this.isDeepSeekV4(model);
    }

    // Docs: with stream_options.include_usage every chunk carries `usage` (null except the last) and no
    // separate usage-only chunk is emitted - the final chunk's single choice carries no new content,
    // just a non-null finish_reason alongside the totals.
    isUsageChunk(parsed) {
        if (!parsed.usage) return false;
        const delta = parsed.choices?.[0]?.delta;
        return !delta?.content && !delta?.reasoning_content;
    }

    requiresResponseUsage() {
        return false;
    }
}

export class GrokProvider extends BaseProvider {
    constructor() {
        super();
        this.maxTemp = MaxTemp.grok;
        this.maxTokens = MaxTokens.grok;
        this.streamCompletion = 'responses';
    }

    async getReasoningScope({ apiKey }) { return credentialScope(apiKey); }

    async prepareRequest(request) { return prepareProviderNativeRequest('grok', request); }

    finalizeResponseState(state) { return finalizeProviderNativeState(state); }

    supports(feature, model) {
        if (feature === 'web_search') return model?.includes('grok-4');
        if (feature === 'reasoning') return this.getReasoningEfforts(model).length > 0;
        return super.supports(feature, model);
    }

    getReasoningEfforts(model) {
        if (/^grok-4\.[67](?:-|$)/.test(model)) return ['low', 'medium', 'high', 'xhigh'];
        if (/^grok-4\.5(?:-|$)/.test(model)) return ['low', 'medium', 'high'];
        if (/^grok-4\.3(?:-|$)/.test(model)) return ['none', 'low', 'medium', 'high', 'xhigh'];
        return [];
    }

    normalizeReasoningEffort(model, effort) {
        if (effort === 'minimal' || effort === 'none' && !this.getReasoningEfforts(model).includes('none')) effort = 'low';
        if (effort === 'max') effort = 'xhigh';
        return super.normalizeReasoningEffort(model, effort, 'high');
    }

    createRequest({ model, messages, stream, settings, apiKey, options = {} }) {
        const history = messages.filter(message => message.role !== RoleEnum.system);
        const isReasoner = model.includes('grok-4') && !model.includes('non-reasoning');
        const body = {
            model, stream, store: false,
            max_output_tokens: Math.min(settings.max_tokens, this.maxTokens),
            input: history.map(message => {
                const content = [];
                const text = this.extractTextContent(message);
                if (text) content.push({ type: message.role === RoleEnum.assistant ? 'output_text' : 'input_text', text });
                for (const url of message.images || []) content.push({ type: 'input_image', image_url: url });
                for (const part of message.parts || []) {
                    if (part.type === 'image' && part.content) content.push({ type: 'input_image', image_url: part.content });
                }
                return { role: message.role, content };
            })
        };
        const system = messages.find(message => message.role === RoleEnum.system);
        if (system) body.instructions = this.extractTextContent(system);
        if (isReasoner) {
            body.include = ['reasoning.encrypted_content'];
            options.streamWriter?.addThinkingCounter?.();
        } else body.temperature = Math.min(settings.temperature, this.maxTemp);
        if (this.supports('reasoning', model)) {
            body.reasoning = { effort: this.normalizeReasoningEffort(model,
                options.reasoningEffort ?? options.getOpenAIReasoningEffort?.() ?? 'high') };
        }
        if (this.supports('web_search', model) && (options.webSearch ?? options.getWebSearch?.() ?? false)) {
            body.tools = [{ type: 'web_search' }];
        }
        return rememberNativeRequest(this, 'grok', this.buildApiRequest('https://api.x.ai/v1/responses',
            body, { 'Authorization': `Bearer ${apiKey}` }), history);
    }

    handleStream({ parsed, tokenCounter, writer, responseState }) {
        captureGrokStream(parsed, responseState);
        const display = streamDisplay(writer, responseState);
        const displayed = display.items ??= new Set();
        const key = `${parsed.output_index ?? 0}`;
        if (['response.reasoning_text.delta', 'response.reasoning_summary_text.delta'].includes(parsed.type) && parsed.delta) {
            displayed?.add(`thought:${key}`);
            writer.processContent(parsed.delta, true);
        } else if (parsed.type === 'response.output_text.delta' && parsed.delta) {
            displayed?.add(`text:${key}`);
            writer.processContent(parsed.delta);
        } else if (parsed.type === 'response.output_item.done') {
            this.renderCompletedItem(parsed.item, key, writer, displayed);
        } else if (parsed.type === 'response.completed' && !display.completed) {
            display.completed = true;
            (parsed.response?.output || []).forEach((item, index) => this.renderCompletedItem(item, `${index}`, writer, displayed));
            const usage = parsed.response?.usage;
            if (usage) updateResponsesUsage(usage, tokenCounter);
            const citations = responseState?.citations || grokCitations(parsed.response);
            if (citations.length) writer.processContent(this.buildCitationsTail(citations));
        } else if (['response.failed', 'error'].includes(parsed.type)) {
            throw new Error(parsed.response?.error?.message || parsed.error?.message || parsed.message || 'Grok response failed');
        }
    }

    renderCompletedItem(item, index, writer, displayed) {
        if (!item) return;
        const thought = item.type === 'reasoning';
        const key = `${thought ? 'thought' : 'text'}:${index}`;
        if (displayed?.has(key)) return;
        const blocks = thought ? typeof item.summary === 'string' ? [{ text: item.summary }] : item.summary || []
            : item.type === 'message' ? (item.content || []).filter(block => block.type === 'output_text') : [];
        for (const block of blocks) if (block.text) writer.processContent(block.text, thought);
        if (blocks.length) displayed?.add(key);
    }

    handleResponse({ data, tokenCounter, responseState }) {
        if (responseState) {
            responseState.payload = data.output || [];
            responseState.completed = data.status === 'completed' && !data.error && !data.incomplete_details;
            responseState.citations = grokCitations(data);
        }
        if (data.error) throw new Error(data.error.message || 'Grok response failed');
        if (data.usage) updateResponsesUsage(data.usage, tokenCounter);
        const parts = [];
        for (const item of data.output || []) {
            if (item.type === 'reasoning') {
                const summary = typeof item.summary === 'string' ? [{ text: item.summary }] : item.summary || [];
                for (const block of summary) if (block.text) parts.push({ type: 'thought', content: block.text });
            } else if (['reasoning_summary_text', 'reasoning_text'].includes(item.type) && item.text) {
                parts.push({ type: 'thought', content: item.text });
            } else if (item.type === 'message') {
                for (const block of item.content || []) {
                    if (block.type === 'output_text' && block.text) parts.push({ type: 'text', content: block.text });
                }
            }
        }
        const tail = this.buildCitationsTail(grokCitations(data));
        if (tail) parts.push({ type: 'text', content: tail });
        return parts;
    }
}

export class KimiProvider extends OpenAICompatibleProvider {
    constructor() { 
        super(); 
        this.maxTemp = MaxTemp.kimi; 
        this.maxTokens = MaxTokens.kimi; 
        this.streamCompletion = 'chat-done';
    }

    updateStreamTokenUsage(parsed, tokenCounter) {
        const usage = parsed.usage;
        updateChatUsage(usage, tokenCounter, usage.prompt_tokens_details?.cached_tokens ?? usage.cached_tokens ?? 0,
            usage.prompt_tokens_details?.cache_write_tokens || 0);
    }

    async getReasoningScope({ apiKey }) { return credentialScope(apiKey); }

    async prepareRequest(request) { return prepareProviderNativeRequest('kimi', request); }

    finalizeResponseState(state) { return finalizeProviderNativeState(state); }

    createRequest(params) {
        return rememberNativeRequest(this, 'kimi', super.createRequest(params), params.messages);
    }

    handleStream(params) {
        captureChatCompletion(params.parsed, params.responseState);
        super.handleStream(params);
    }

    handleResponse(params) {
        captureChatCompletion(params.data, params.responseState, false);
        return super.handleResponse(params);
    }

    getApiEndpoint() {
        return 'https://api.moonshot.ai/v1/chat/completions';
    }

    supportsImageMessages() {
        return true;
    }

    isThinkingDefaultOn(model) { return model === 'kimi-k2.6' || model === 'kimi-k3'; }

    supports(feature, model) {
        if (feature === 'thinking_toggle') return model === 'kimi-k2.6';
        if (feature === 'thinking' || feature === 'reasoning') return model === 'kimi-k3';
        return super.supports(feature, model);
    }

    getReasoningEfforts(model) {
        return model === 'kimi-k3' ? ['low', 'high', 'max'] : [];
    }

    normalizeReasoningEffort(model, effort) {
        if (model !== 'kimi-k3') return super.normalizeReasoningEffort(model, effort);
        return this.getReasoningEfforts(model).includes(effort) ? effort : 'max';
    }

    formatMessages(messages, context) {
        const formatted = super.formatMessages(messages, context);
        if (context?.model !== 'kimi-k3') return formatted;

        formatted.forEach((message, index) => {
            if (message.role !== RoleEnum.assistant || messages[index].parts?.some(part => part.providerState)) return;
            const reasoningContent = (messages[index].parts || [])
                .filter(part => part.type === 'thought' && part.model === context.model && part.content)
                .map(part => part.content)
                .join('\n');
            if (reasoningContent) message.reasoning_content = reasoningContent;
        });
        return formatted;
    }

    shouldIncludeMaxTokens({ model }) {
        return model !== 'kimi-k3';
    }

    shouldIncludeTemperature({ model }) {
        return model !== 'kimi-k2.6' && model !== 'kimi-k3';
    }

    extendRequestBody(body, { model, options, settings }) {
        if (model === 'kimi-k3') {
            body.max_completion_tokens = Math.min(settings.max_tokens, MaxTokens.kimi_k3);
            const requestedEffort = options.reasoningEffort ?? options.getOpenAIReasoningEffort?.() ?? 'max';
            body.reasoning_effort = this.normalizeReasoningEffort(model, requestedEffort);
            return;
        }
        if (model === 'kimi-k2.6') {
            const shouldThink = options.shouldThink ?? options.getShouldThink?.() ?? true;
            if (!shouldThink) {
                body.thinking = { type: "disabled" };
            }
            // When shouldThink is true: don't send anything (thinking enabled by default)
        }
        // kimi-k2-thinking: no thinking param needed (always on)
    }

    beforeCreateRequest({ model, options }) {
        const isThinking = model === 'kimi-k3' || model === 'kimi-k2-thinking' ||
            (model === 'kimi-k2.6' && (options.shouldThink ?? options.getShouldThink?.() ?? true));
        if (isThinking && options.streamWriter) {
            options.streamWriter.setThinkingModel();
        }
    }
}

export class MistralProvider extends BaseProvider {
    constructor() { 
        super(); 
        this.maxTemp = MaxTemp.mistral; 
        this.maxTokens = MaxTokens.mistral; 
        this.streamCompletion = 'chat';
    }

    async getReasoningScope({ apiKey }) { return credentialScope(apiKey); }

    async prepareRequest(request) { return prepareProviderNativeRequest('mistral', request); }

    finalizeResponseState(state) { return finalizeProviderNativeState(state); }

    supports(feature, model) {
        if (feature === 'reasoning') return ['mistral-small-latest', 'mistral-small-2603', 'mistral-medium-3-5'].includes(model);
        return super.supports(feature, model);
    }

    getReasoningEfforts(model) { return this.supports('reasoning', model) ? ['none', 'high'] : []; }

    normalizeReasoningEffort(model, effort) {
        return this.supports('reasoning', model) ? effort === 'none' || effort === 'minimal' ? 'none' : 'high'
            : super.normalizeReasoningEffort(model, effort);
    }

    formatMessages(messages) { 
        return messages.map(message => ({ 
            role: message.role, 
            content: this.extractTextContent(message) 
        })); 
    }

    createRequest({ model, messages, stream, settings, apiKey, options = {} }) {
        const body = { 
            model, 
            messages: this.formatMessages(messages), 
            max_tokens: Math.min(settings.max_tokens, this.maxTokens), 
            temperature: Math.min(settings.temperature, this.maxTemp), 
            stream 
        };
        if (this.supports('reasoning', model)) {
            body.reasoning_effort = this.normalizeReasoningEffort(model,
                options.reasoningEffort ?? options.getOpenAIReasoningEffort?.() ?? 'high');
            if (body.reasoning_effort === 'high') options.streamWriter?.setThinkingModel?.();
        }
        return rememberNativeRequest(this, 'mistral', this.buildApiRequest('https://api.mistral.ai/v1/chat/completions', body, {
            'Authorization': `Bearer ${apiKey}`
        }), messages);
    }

    createTranscriptionRequest({ model, audioBlob, apiKey, options }) {
        const formData = new FormData(); 
        formData.append('model', model); 
        formData.append('file', audioBlob, options.filename || 'audio.webm'); 
        
        if (options.language) {
            formData.append('language', options.language);
        }
        
        return ['https://api.mistral.ai/v1/audio/transcriptions', { 
            method: 'POST', 
            credentials: 'omit', 
            headers: { 'Authorization': `Bearer ${apiKey}` }, 
            body: formData 
        }];
    }

    handleStream({ parsed, tokenCounter, writer, responseState }) {
        const deltaData = parsed.data ?? parsed;
        captureChatCompletion(deltaData, responseState);
        if (deltaData.usage) {
            updateChatUsage(deltaData.usage, tokenCounter);
        }
        
        const choice = deltaData.choices?.[0];
        const content = choice?.delta?.content;
        
        if (typeof content === 'string' && content) {
            writer.processContent(content);
        } else if (Array.isArray(content)) { 
            content.forEach(chunk => { 
                if (chunk.type === 'text' && chunk.text) {
                    writer.processContent(chunk.text); 
                } else if (chunk.type === 'thinking') {
                    (chunk.thinking || []).forEach(thought => {
                        if (thought.text) {
                            writer.processContent(thought.text, true);
                        }
                    });
                }
            }); 
        }
    }

    handleResponse({ data, tokenCounter, responseState }) {
        captureChatCompletion(data, responseState, false);
        if (data.usage) {
            updateChatUsage(data.usage, tokenCounter);
        }
        
        const choice = data.choices?.[0];
        const content = choice?.message?.content;
        const parts = [];
        if (typeof content === 'string') {
            if (content) parts.push({ type: 'text', content });
        } else if (Array.isArray(content)) {
            for (const item of content) {
                if (item.type === 'text' && item.text) parts.push({ type: 'text', content: item.text });
                else if (item.type === 'thinking') {
                    for (const thought of item.thinking || []) {
                        if (thought.text) parts.push({ type: 'thought', content: thought.text });
                    }
                }
            }
        }
        return parts;
    }
}

export class LlamaCppProvider extends OpenAICompatibleProvider {
    constructor() {
        super();
        this.streamCompletion = 'chat';
    }

    async getReasoningScope({ options }) {
        const reasoning = options?.localModelOverride?.reasoning;
        return reasoning?.supported === true && typeof reasoning.identity === 'string' && reasoning.identity
            ? `local:${reasoning.identity}` : null;
    }

    async prepareRequest(request) { return prepareProviderNativeRequest('llamacpp', request); }

    finalizeResponseState(state) { return finalizeProviderNativeState(state); }

    createRequest(params) {
        return rememberNativeRequest(this, 'llamacpp', super.createRequest(params), params.messages);
    }

    handleStream(params) {
        captureChatCompletion(params.parsed, params.responseState);
        super.handleStream(params);
    }

    handleResponse(params) {
        captureChatCompletion(params.data, params.responseState, false);
        return super.handleResponse(params);
    }

    supportsImageMessages() {
        return true;
    }

    getApiEndpoint({ options }) {
        const { port } = options.localModelOverride || { port: 8080 };
        return `http://localhost:${port}/v1/chat/completions`;
    }

    getAuthHeaders() {
        return {};
    }

    getRequestModel({ model, options }) {
        const { raw } = options.localModelOverride || { raw: model };
        return raw;
    }

    shouldIncludeMaxTokens() {
        return false;
    }

    getRequestTemperature({ settings }) {
        return settings.temperature;
    }

    shouldIncludeStreamOptions() {
        return false;
    }

    afterUsageChunk(parsed, writer) {
        if (parsed.timings) {
            console.log(`Llama.cpp performance - Speed: ${parsed.timings.predicted_per_second?.toFixed(1)} tokens/sec`);
        }

        if (writer?.onComplete) {
            writer.onComplete();
        }
    }

    getStreamDelta(parsed) {
        const choice = parsed.choices?.[0];
        return choice?.delta || choice?.message;
    }

    processReasoningContent(reasoningContent, writer) {
        if (writer && !writer.isThinkingModel) {
            writer.setThinkingModel();
        }
        writer.processContent(reasoningContent, true);
    }

    requiresResponseUsage() {
        return false;
    }
}

export const Providers = { openai: new OpenAIProvider(), anthropic: new AnthropicProvider(), gemini: new GeminiProvider(), deepseek: new DeepSeekProvider(), grok: new GrokProvider(), kimi: new KimiProvider(), mistral: new MistralProvider(), llamacpp: new LlamaCppProvider() };
