import { SettingsManager } from './state_manager.js';
import { Providers } from './LLMProviders.js';
import { ensureFreshChatGPTCredentials } from './chatgpt_auth.js';

// Timeout constants (in milliseconds)
const TIMEOUT = {
    TRANSCRIPTION: 60000,        // 60s for audio transcription
    API_NORMAL: 30000,           // 30s for standard API calls
    API_THINKING: 120000,        // 120s for thinking/reasoning models
    IMAGE_GENERATION: 120000,    // 120s for image generation
    LOCAL_SERVER_PING: 2000      // 2s to check if local server is running
};

// Local server configuration
const LOCAL_SERVER = {
    DEFAULT_PORT: 8080,
    FALLBACK_PORTS: [8000, 8080]
};

function parseJSONSafe(text) {
    try {
        return JSON.parse(text);
    } catch (_) {
        return undefined;
    }
}

function attachProviderState(parts, providerState) {
    if (!providerState || !parts) return;
    if (!parts.length) parts.push({ type: 'thought', content: '' });
    if (parts.length === 1 && parts[0].type === 'text' && !parts[0].content.length) {
        parts[0].type = 'thought';
    }
    parts[0].providerState = providerState;
}

function checkResponseStatus(parsed, policy) {
    const event = parsed.data ?? parsed;
    if (event.error || event.status === 'failed' || event.type === 'error' || event.type === 'response.failed') {
        throw new Error(event.response?.error?.message || event.error?.message || event.message || 'Provider response failed');
    }
    if (event.status === 'incomplete' || event.type === 'response.incomplete') {
        throw new Error(`Response incomplete: ${(event.response ?? event).incomplete_details?.reason || 'generation stopped early'}`);
    }
    if (policy === 'responses' && event.type === 'response.completed') {
        if (event.response?.status && event.response.status !== 'completed') {
            throw new Error(`Response ${event.response.status}`);
        }
        return true;
    }
    if (policy === 'anthropic') {
        if ((event.delta?.stop_reason ?? event.stop_reason) === 'max_tokens') {
            throw new Error('Response incomplete: max_tokens');
        }
        return event.type === 'message_stop';
    }
    if (policy === 'gemini') {
        const reason = event.candidates?.[0]?.finishReason;
        if (reason === 'MAX_TOKENS') throw new Error('Response incomplete: MAX_TOKENS');
        return !!reason;
    }
    if (policy === 'chat' || policy === 'chat-done') {
        const reason = event.choices?.[0]?.finish_reason;
        if (reason === 'length') throw new Error('Response incomplete: length');
        return !!reason;
    }
    return false;
}

function clearSSEEvent(state) {
    state.dataLines.length = 0;
    state.dataStructure = null;
}

function flushSSEEvent(state, events) {
    if (!state.dataLines.length) return;

    const parsed = parseJSONSafe(state.dataLines.join('\n'));
    if (parsed !== undefined) {
        events.push(parsed);
    } else {
        for (const line of state.dataLines) {
            const parsedLine = parseJSONSafe(line);
            if (parsedLine !== undefined) events.push(parsedLine);
        }
    }
    clearSSEEvent(state);
}

function scanJSONStructure(structure, text) {
    for (const character of text) {
        if (structure.inString) {
            if (structure.escaped) {
                structure.escaped = false;
            } else if (character === '\\') {
                structure.escaped = true;
            } else if (character === '"') {
                structure.inString = false;
            }
            continue;
        }

        if (character === '"') {
            structure.inString = true;
        } else if (character === '{') {
            structure.stack.push('}');
        } else if (character === '[') {
            structure.stack.push(']');
        } else if (character === '}' || character === ']') {
            if (structure.stack.pop() !== character) return false;
        }
    }
    return !structure.inString;
}

function startSSEEvent(state, value) {
    const trimmed = value.trimStart();
    const opening = trimmed[0];
    if (opening !== '{' && opening !== '[') return;

    const next = trimmed.slice(1).trimStart()[0];
    if (opening === '{' && next !== undefined && next !== '"' && next !== '}') return;
    if (opening === '[' && next !== undefined && !'[]{"-0123456789tfn'.includes(next)) return;

    const structure = { stack: [], inString: false, escaped: false };
    if (!scanJSONStructure(structure, value) || structure.stack.length === 0) return;

    state.dataLines.push(value);
    state.dataStructure = structure;
}

function processSSELine(state, line, events) {
    if (line === '') {
        flushSSEEvent(state, events);
        return;
    }
    if (line.startsWith(':')) return;

    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    if (field !== 'data') return;

    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (value.trim() === '[DONE]') {
        flushSSEEvent(state, events);
        state.receivedDone = true;
        return;
    }

    const parsedLine = parseJSONSafe(value);
    if (!state.dataLines.length) {
        if (parsedLine !== undefined) {
            events.push(parsedLine);
        } else {
            startSSEEvent(state, value);
        }
        return;
    }

    const structure = state.dataStructure;
    if (!scanJSONStructure(structure, value)) {
        clearSSEEvent(state);
        if (parsedLine !== undefined) events.push(parsedLine);
        else startSSEEvent(state, value);
        return;
    }

    state.dataLines.push(value);
    if (structure.stack.length === 0) flushSSEEvent(state, events);
}

function processSSEBuffer(state, events, final = false) {
    const buffer = state.buffer;
    let lineStart = 0;

    for (let index = 0; index < buffer.length; index++) {
        const character = buffer[index];
        if (character !== '\r' && character !== '\n') continue;
        if (character === '\r' && index === buffer.length - 1 && !final) break;

        processSSELine(state, buffer.slice(lineStart, index), events);
        if (character === '\r' && buffer[index + 1] === '\n') index++;
        lineStart = index + 1;
    }

    state.buffer = buffer.slice(lineStart);
    if (final && state.buffer) {
        processSSELine(state, state.buffer, events);
        state.buffer = '';
    }
}

/**
 * Handles communication with various LLM APIs.
 * Supports streaming, audio transcription, and image generation.
 */
export class ApiManager {
    constructor(options = {}) {
        const { settingsManager = null, ...optionOverrides } = options;

        this.settingsManager = settingsManager || new SettingsManager([
            'api_keys', 'chatgpt_auth', 'max_tokens', 'temperature', 'models',
            'current_model', 'web_search', 'reasoning_effort',
            'auto_rename', 'auto_rename_model'
        ]);
        this.localServerPort = LOCAL_SERVER.DEFAULT_PORT;
        this.providerResolutionCache = new Map();
        this.providerResolutionCacheLimit = 100;

        Object.assign(this, {
            getShouldThink: optionOverrides.getShouldThink || (() => false),
            getWebSearch: optionOverrides.getWebSearch || (() => !!this.settingsManager.getSetting('web_search')),
            getOpenAIReasoningEffort: optionOverrides.getOpenAIReasoningEffort || (() => this.settingsManager.getSetting('reasoning_effort') || 'medium'),
            getGeminiThinkingLevel: optionOverrides.getGeminiThinkingLevel || (() => this.settingsManager.getSetting('reasoning_effort') || 'medium'),
            getImageAspectRatio: optionOverrides.getImageAspectRatio || (() => '16:9'),
            getImageResolution: optionOverrides.getImageResolution || (() => '2K')
        });
        Object.assign(this, optionOverrides);

        this.settingsManager.subscribeToSetting('models', () => {
            this.providerResolutionCache.clear();
        });
    }

    async resolveChatGPTAuth(providerName, abortController) {
        if (providerName !== 'openai') return null;
        const credentials = this.settingsManager.getSetting('chatgpt_auth');
        if (credentials == null) return null;

        const refreshed = await ensureFreshChatGPTCredentials(credentials, {
            signal: abortController?.signal
        });
        if (refreshed !== credentials) {
            this.settingsManager.updateSettingsLocal({ chatgpt_auth: refreshed });
            await chrome.storage.local.set({ chatgpt_auth: refreshed });
        }
        return refreshed;
    }

    resolveProvider(modelId) {
        if (modelId && this.providerResolutionCache.has(modelId)) {
            return this.providerResolutionCache.get(modelId);
        }

        const models = this.settingsManager.getSetting('models') || {};
        const resolved = this.findProviderFromModelMap(models, modelId);
        const provider = resolved || { name: 'llamacpp', instance: Providers.llamacpp };

        if (modelId) {
            this.providerResolutionCache.set(modelId, provider);
            if (this.providerResolutionCache.size > this.providerResolutionCacheLimit) {
                const oldestKey = this.providerResolutionCache.keys().next().value;
                this.providerResolutionCache.delete(oldestKey);
            }
        }

        return provider;
    }

    findProviderFromModelMap(modelMap, modelId) {
        if (!modelId || !modelMap) return null;
        for (const [providerName, models] of Object.entries(modelMap)) {
            if (modelId in models) {
                return { name: providerName, instance: Providers[providerName] };
            }
        }
        return null;
    }

    getProvider(modelId) {
        return this.resolveProvider(modelId).instance;
    }

    getProviderName(modelId) {
        return this.resolveProvider(modelId).name;
    }

    isImageModel(modelId) { 
        const provider = this.getProvider(modelId);
        return typeof provider.createImageRequest === 'function' && provider.supports('image', modelId);
    }

    hasReasoningLevels(modelId) { 
        return this.getProvider(modelId).supports('reasoning', modelId); 
    }

    getReasoningEfforts(modelId) {
        return this.getProvider(modelId).getReasoningEfforts(modelId);
    }

    normalizeReasoningEffort(modelId, effort) {
        return this.getProvider(modelId).normalizeReasoningEffort(modelId, effort);
    }

    hasReasoningModes(modelId) {
        return this.getProvider(modelId).supports('reasoning_mode', modelId);
    }

    hasWebSearchSupport(modelId) { 
        return this.getProvider(modelId).supports('web_search', modelId); 
    }

    hasToggleThinking(modelId) { 
        const provider = this.getProvider(modelId);
        return provider.supports('thinking_toggle', modelId) || 
               provider.supports('thinking', modelId); 
    }

    canToggleThinking(modelId) {
        return this.getProvider(modelId).supports('thinking_toggle', modelId);
    }

    isThinkingDefaultOn(modelId) {
        return this.getProvider(modelId).isThinkingDefaultOn(modelId);
    }

    async transcribeAudio(modelId, audioBlob, options = {}) {
        const provider = this.getProvider(modelId);
        const providerName = this.getProviderName(modelId);

        if (providerName === 'llamacpp' || typeof provider.createTranscriptionRequest !== 'function') {
            const label = providerName === 'llamacpp' ? 'local models' : providerName;
            throw new Error(`Transcription is not supported for ${label}.`);
        }

        const apiKey = this.settingsManager.getSetting('api_keys')?.[providerName];
        if (!apiKey?.trim()) {
            throw new Error(`API key for ${providerName} is empty.`);
        }

        const [url, requestOptions] = provider.createTranscriptionRequest({ 
            model: modelId, 
            audioBlob, 
            apiKey, 
            options 
        });

        const response = await this._fetchWithTimeout(url, requestOptions, TIMEOUT.TRANSCRIPTION, {
            prefix: 'Transcription failed',
            model: modelId
        });

        const data = await response.json();
        return data.text?.trim() || '';
    }

    async callApi(modelId, messages, tokenCounter, streamWriter = null, abortController = null, options = {}) {
        const providerName = options.localModelOverride ? 'llamacpp' : this.getProviderName(modelId);
        const provider = options.localModelOverride ? Providers.llamacpp : this.getProvider(modelId);
        const apiKey = this.settingsManager.getSetting('api_keys')?.[providerName];
        const chatGPTAuth = await this.resolveChatGPTAuth(providerName, abortController);

        if (providerName !== 'llamacpp' && provider.supports('image', modelId) && typeof provider.createImageRequest !== 'function') {
            throw new Error(`Image generation not supported for ${providerName}.`);
        }

        if (providerName !== 'llamacpp' && !apiKey?.trim() && !chatGPTAuth) {
            const credentialLabel = providerName === 'openai'
                ? 'OpenAI API key or ChatGPT connection'
                : `${providerName} API key`;
            throw new Error(`${credentialLabel} is empty.`);
        }

        // Re-probe the selected endpoint so model/template swaps cannot reuse old reasoning.
        if (providerName === 'llamacpp') {
            options = {
                ...options,
                localModelOverride: await this.getLocalModelConfig(
                    options.localModelOverride ?? (modelId === 'local-model' ? null : { raw: modelId }),
                    abortController
                )
            };
            modelId = options.localModelOverride.raw;
        }

        const filteredMessages = messages.filter(msg => {
            if (msg.role !== 'system') return true;
            return msg.parts?.some(part => part.type === 'text' && part.content?.trim());
        });

        // Delegate to image generation if applicable
        if (typeof provider.createImageRequest === 'function' && provider.supports('image', modelId)) {
            return this.callImageGenerationApi(modelId, filteredMessages, tokenCounter, streamWriter, abortController, options);
        }

        const isStreaming = (streamWriter !== null);
        const requestIsStreaming = isStreaming || !!chatGPTAuth;
        const processedMessages = this.processFiles(filteredMessages);

        const settings = {
            max_tokens: this.settingsManager.getSetting('max_tokens'),
            temperature: this.settingsManager.getSetting('temperature')
        };

        const reasoningScope = await provider.getReasoningScope({ apiKey, chatGPTAuth, options });

        const [url, requestOptions] = provider.createRequest({
            model: modelId,
            messages: processedMessages,
            stream: requestIsStreaming,
            options: { ...this, ...options, streamWriter, reasoningScope },
            apiKey,
            chatGPTAuth,
            settings
        });
        const responseState = await provider.prepareRequest({ model: modelId, requestOptions, reasoningScope });

        try {
            // Reasonable timeout extension for models that take longer to "think"
            const timeoutMs = (streamWriter?.isThinkingModel || streamWriter?.thinkingModelWithCounter)
                ? TIMEOUT.API_THINKING
                : TIMEOUT.API_NORMAL;

            const response = await this._fetchWithTimeout(
                url,
                requestOptions,
                timeoutMs,
                { prefix: 'API request failed', model: modelId, provider: providerName },
                abortController
            );

            if (requestIsStreaming) {
                return await this.handleStreamResponse(response, modelId, tokenCounter, streamWriter, responseState, requestOptions.signal, provider);
            }

            const data = await response.json();
            requestOptions.signal?.throwIfAborted();
            checkResponseStatus(data, provider.streamCompletion);
            const parts = provider.handleResponse({ data, tokenCounter, responseState });
            attachProviderState(parts, provider.finalizeResponseState(responseState));
            return parts;
        } catch (error) {
            streamWriter?.stopThinkingCounter?.();
            throw error;
        }
    }

    async callImageGenerationApi(modelId, messages, tokenCounter, streamWriter, abortController, options = {}) {
        const provider = this.getProvider(modelId);
        const providerName = this.getProviderName(modelId);
        const apiKey = this.settingsManager.getSetting('api_keys')?.[providerName];

        if (typeof provider.createImageRequest !== 'function') {
            throw new Error(`Image generation not supported for ${providerName}.`);
        }

        if (providerName !== 'llamacpp' && !apiKey?.trim()) {
            throw new Error(`${providerName} API key is empty.`);
        }
        
        const settings = {
            max_tokens: this.settingsManager.getSetting('max_tokens'),
            temperature: this.settingsManager.getSetting('temperature')
        };

        const reasoningScope = await provider.getReasoningScope({ apiKey, options });

        const [url, requestOptions] = provider.createImageRequest({
            model: modelId,
            messages: this.processFiles(messages),
            apiKey,
            settings,
            options: { ...this, ...options, streamWriter, reasoningScope }
        });
        const responseState = await provider.prepareRequest({ model: modelId, requestOptions, reasoningScope });

        const response = await this._fetchWithTimeout(
            url,
            requestOptions,
            TIMEOUT.IMAGE_GENERATION,
            { prefix: 'Image generation failed', model: modelId },
            abortController
        );

        const data = await response.json();
        requestOptions.signal?.throwIfAborted();
        const parts = provider.handleResponse({ data, tokenCounter, responseState });
        attachProviderState(parts, provider.finalizeResponseState(responseState));
        return parts;
    }

    /**
     * Internal helper for fetch with timeout and unified error handling.
     */
    async _fetchWithTimeout(url, requestOptions, timeoutMs, errorContext, externalAbort = null) {
        const abortController = externalAbort || new AbortController();
        requestOptions.signal = abortController.signal;
        
        const timeoutId = setTimeout(() => abortController.abort(), timeoutMs);

        try {
            const response = await fetch(url, requestOptions);
            clearTimeout(timeoutId);

            if (!response.ok) {
                const errorDetail = await this.readErrorResponse(response);
                throw this.createApiError(errorContext.prefix, { 
                    ...errorContext, 
                    status: response.status, 
                    detail: errorDetail 
                });
            }
            return response;
        } catch (error) {
            clearTimeout(timeoutId);
            if (error.name === 'AbortError') {
                throw this.createApiError(errorContext.prefix, { ...errorContext, detail: 'Timed out' });
            }
            // Preserve detailed API errors
            if (error.isDetailedApiError) throw error;
            
            throw this.createApiError('API request error', { ...errorContext, detail: error.message || error });
        }
    }

    /**
     * Parses a chunk of SSE data.
     * @param {Object} state Object containing a 'buffer' string; the parser
     *   also keeps pending data lines in state.dataLines across calls.
     * @param {string} chunk New data to parse.
     * @returns {Array<Object>} Array of parsed event data objects.
     */
    static parseSSEChunk(state, chunk) {
        state.buffer += chunk;
        state.dataLines ??= [];
        state.dataStructure ??= null;
        const events = [];
        processSSEBuffer(state, events);
        return events;
    }

    /**
     * Flushes the SSE parser state once the stream has ended, emitting any
     * final event that was not terminated by a newline or blank line.
     * @param {Object} state Parser state previously used with parseSSEChunk.
     * @returns {Array<Object>} Array of parsed event data objects.
     */
    static flushSSEBuffer(state) {
        state.dataLines ??= [];
        state.dataStructure ??= null;
        const events = [];
        processSSEBuffer(state, events, true);
        flushSSEEvent(state, events);
        return events;
    }

    async handleStreamResponse(response, modelId, tokenCounter, writer, responseState = null, signal = null, provider = this.getProvider(modelId)) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder("utf-8");
        const state = { buffer: '', dataLines: [], dataStructure: null };
        let streamCompleted = false;
        const policy = provider.streamCompletion;
        let ended = false;
        const collected = writer ? null : [];
        const outputWriter = writer || {
            parts: collected,
            processContent(content, isThought = false) {
                if (!content) return;
                const type = isThought ? 'thought' : 'text';
                const last = collected.at(-1);
                if (last?.type === type) last.content += content;
                else collected.push({ type, content });
            },
            processImage(content, { thought = false } = {}) {
                collected.push({ type: 'image', content, ...(thought ? { thought: true } : {}) });
            },
            setThinkingModel() {
                this.isThinkingModel = true;
            }
        };

        const consume = parsed => {
            provider.handleStream({ parsed, tokenCounter, writer: outputWriter, responseState });
            if (checkResponseStatus(parsed, policy)) streamCompleted = true;
        };
        try {
            while (true) {
                signal?.throwIfAborted();
                const { done, value } = await reader.read();
                if (done) {
                    ended = true;
                    break;
                }
                for (const parsed of ApiManager.parseSSEChunk(state, decoder.decode(value, { stream: true }))) {
                    consume(parsed);
                }
            }
            for (const parsed of ApiManager.parseSSEChunk(state, decoder.decode())) consume(parsed);
            for (const parsed of ApiManager.flushSSEBuffer(state)) consume(parsed);
            signal?.throwIfAborted();
            if (policy && (!streamCompleted || policy === 'chat-done' && !state.receivedDone)) {
                throw new Error('Response incomplete: stream ended before completion');
            }
            const parts = writer ? writer.parts : (collected.length ? collected : provider.returnMessage([''], ['']));
            attachProviderState(parts, provider.finalizeResponseState(responseState));
            return writer ? true : parts;
        } catch (error) {
            if (responseState) responseState.valid = false;
            throw error;
        } finally {
            if (!ended) await reader.cancel().catch(() => {});
            reader.releaseLock();
        }
    }


    processFiles(messages) {
        return messages.map(message => {
            if (!message.files?.length) return message;

            const fileBlocks = message.files.map(file => `${file.name}:\n<|file_start|>${file.content ?? ''}<|file_end|>`);
            const combinedContent = `files:\n${fileBlocks.join("\n")}`;
            
            const messageParts = Array.isArray(message.parts) ? [...message.parts] : [];
            const lastTextIndex = messageParts.findLastIndex(part => part.type === 'text');
            
            if (lastTextIndex >= 0) {
                const existingContent = messageParts[lastTextIndex].content || '';
                const separator = existingContent ? '\n\n' : '';
                messageParts[lastTextIndex] = {
                    ...messageParts[lastTextIndex],
                    content: `${existingContent}${separator}${combinedContent}`
                };
            } else {
                messageParts.push({ type: 'text', content: combinedContent });
            }

            const { files, ...restOfMessage } = message;
            return { ...restOfMessage, parts: messageParts };
        });
    }

    async readErrorResponse(response) {
        try {
            const responseText = (await response.text()).trim();
            if (response.headers.get('content-type')?.includes('json')) {
                const parsedError = JSON.parse(responseText);
                return this.formatErrorDetails(parsedError);
            }
            return responseText;
        } catch (error) {
            return 'Could not parse error response';
        }
    }

    formatErrorDetails(value, seenObjects = new WeakSet()) {
        if (!value) return '';
        if (value instanceof Error) return value.message;
        if (typeof value === 'string') {
            const trimmed = value.trim();
            if (!trimmed) return '';
            if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
                try {
                    return this.formatErrorDetails(JSON.parse(trimmed), seenObjects);
                } catch (_) {
                    return trimmed;
                }
            }
            return trimmed;
        }
        if (typeof value !== 'object') return String(value);
        if (seenObjects.has(value)) return '';
        
        seenObjects.add(value);
        
        if (Array.isArray(value)) {
            return value
                .map(item => this.formatErrorDetails(item, seenObjects))
                .filter(Boolean)
                .join(' | ');
        }

        const commonErrorKeys = ['message', 'detail', 'error', 'error_description', 'description', 'reason'];
        const errorParts = commonErrorKeys
            .map(key => value[key] && this.formatErrorDetails(value[key], seenObjects))
            .filter(Boolean);

        if (typeof value.title === 'string' && typeof value.detail === 'string') {
            const title = value.title.trim();
            const detail = value.detail.trim();
            if (title && detail) {
                errorParts.push(`${title}: ${detail}`);
            }
        }

        const metaKeys = ['type', 'code', 'status', 'status_code', 'param'];
        const meta = metaKeys
            .map(key => {
                const metaValue = value[key];
                if (metaValue == null) return null;
                if (typeof metaValue === 'string') {
                    const trimmed = metaValue.trim();
                    return trimmed ? `${key}=${trimmed}` : null;
                }
                if (typeof metaValue === 'number' || typeof metaValue === 'boolean' || typeof metaValue === 'bigint') {
                    return `${key}=${metaValue}`;
                }
                return null;
            })
            .filter(Boolean);

        if (meta.length && errorParts.length) {
            errorParts[0] = `${errorParts[0]} (${meta.join(', ')})`;
        } else if (meta.length) {
            errorParts.push(meta.join(', '));
        }
        
        return errorParts.length ? errorParts.join(' | ') : JSON.stringify(value);
    }

    createApiError(prefix, context = {}) {
        const metadata = Object.entries(context)
            .filter(([_, val]) => val != null)
            .map(([key, val]) => `${key}=${val}`)
            .join(', ');
            
        const error = new Error(`${prefix}${metadata ? ` (${metadata})` : ''}`);
        error.isDetailedApiError = true;
        return error;
    }

    getUiErrorMessage(error, options = {}) {
        const prefix = options.prefix || 'Error';
        const message = (typeof error === 'string' ? error : error.message || 'Unknown error').trim();
        return message.toLowerCase().startsWith(prefix.toLowerCase()) 
            ? message 
            : `${prefix}: ${message}`;
    }

    formatLocalModelName(rawId) {
        if (!rawId || rawId === 'local-model') return 'Local Model';
        const filename = rawId.split(/[/\\]/).pop() || '';
        return filename
            .replace(/\.(gguf|ggml|bin|safetensors)$/i, '')
            .replace(/[-_]/g, ' ')
            .replace(/\b\w/g, char => char.toUpperCase()) || 'Local Model';
    }

    async getLocalModelReasoning(port, rawId, externalAbort = null) {
        const abort = new AbortController();
        const cancel = () => abort.abort();
        externalAbort?.signal.addEventListener('abort', cancel, { once: true });
        if (externalAbort?.signal.aborted) cancel();
        const timeout = setTimeout(cancel, TIMEOUT.LOCAL_SERVER_PING);
        try {
            const endpoint = `http://localhost:${port}`;
            const query = rawId && rawId !== 'local-model' ? `?model=${encodeURIComponent(rawId)}` : '';
            const response = await fetch(`${endpoint}/props${query}`, { signal: abort.signal });
            if (!response.ok) return { supported: false, identity: null };
            const props = await response.json();
            const loadedModel = props.model_path || props.default_generation_settings?.model || props.model
                || (rawId !== 'local-model' ? rawId : null);
            if (typeof loadedModel !== 'string' || !loadedModel || loadedModel === 'local-model') {
                return { supported: false, identity: null };
            }
            const identityData = JSON.stringify([
                endpoint, rawId, loadedModel, props.chat_template ?? null, props.chat_template_tool_use ?? null
            ]);
            const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(identityData));
            const identity = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
            return { supported: props.chat_template_caps?.supports_preserve_reasoning === true, identity };
        } catch (_) {
            return { supported: false, identity: null };
        } finally {
            clearTimeout(timeout);
            externalAbort?.signal.removeEventListener('abort', cancel);
        }
    }

    async getLocalModelConfig(override = null, externalAbort = null, { probeReasoning = true } = {}) {
        if (override?.port != null) {
            const port = override.port;
            const raw = override.raw || 'local-model';
            const reasoning = probeReasoning ? await this.getLocalModelReasoning(port, raw, externalAbort) : undefined;
            return { ...override, raw, display: override.display || this.formatLocalModelName(raw), port, reasoning };
        }
        const ports = [...new Set([this.localServerPort, ...LOCAL_SERVER.FALLBACK_PORTS])];
        const selectedRaw = override?.raw && override.raw !== 'local-model' ? override.raw : null;
        for (const port of ports) {
            if (externalAbort?.signal.aborted) break;
            const abort = new AbortController();
            const cancel = () => abort.abort();
            externalAbort?.signal.addEventListener('abort', cancel, { once: true });
            const timeout = setTimeout(cancel, TIMEOUT.LOCAL_SERVER_PING);
            try {
                const response = await fetch(`http://localhost:${port}/v1/models`, { signal: abort.signal });
                if (response.ok) {
                    const data = await response.json();
                    const firstModel = data.data?.[0];
                    const rawId = selectedRaw || (typeof firstModel === 'string'
                        ? firstModel
                        : (firstModel?.id || firstModel?.name || 'local-model'));
                    this.localServerPort = port;
                    const reasoning = probeReasoning ? await this.getLocalModelReasoning(port, rawId, externalAbort) : undefined;
                    return { ...override, raw: rawId, display: override?.display || this.formatLocalModelName(rawId), port, reasoning };
                }
            } catch (_) {
            } finally {
                clearTimeout(timeout);
                externalAbort?.signal.removeEventListener('abort', cancel);
            }
        }
        return {
            ...override, raw: selectedRaw || 'local-model',
            display: override?.display || (selectedRaw ? this.formatLocalModelName(selectedRaw) : 'Local Model'),
            port: this.localServerPort,
            reasoning: { supported: false, identity: null }
        };
    }
}
