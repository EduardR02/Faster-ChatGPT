import { SettingsManager } from './state_manager.js';
import { Providers } from './LLMProviders.js';

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

/**
 * Handles communication with various LLM APIs.
 * Supports streaming, audio transcription, and image generation.
 */
export class ApiManager {
    constructor(options = {}) {
        const { settingsManager = null, ...optionOverrides } = options;

        this.settingsManager = settingsManager || new SettingsManager([
            'api_keys', 'max_tokens', 'temperature', 'models',
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

    hasWebSearchSupport(modelId) { 
        return this.getProvider(modelId).supports('web_search', modelId); 
    }

    hasToggleThinking(modelId) { 
        const provider = this.getProvider(modelId);
        return provider.supports('thinking_toggle', modelId) || 
               provider.supports('thinking', modelId); 
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
        const provider = this.getProvider(modelId);
        const providerName = this.getProviderName(modelId);
        const apiKey = this.settingsManager.getSetting('api_keys')?.[providerName];

        if (provider.supports('image', modelId) && typeof provider.createImageRequest !== 'function') {
            throw new Error(`Image generation not supported for ${providerName}.`);
        }

        if (providerName !== 'llamacpp' && !apiKey?.trim()) {
            throw new Error(`${providerName} API key is empty.`);
        }

        // Handle local model configuration
        if (providerName === 'llamacpp' && !options.localModelOverride) {
            options.localModelOverride = await this.getLocalModelConfig();
        }

        const filteredMessages = messages.filter(msg => {
            if (msg.role !== 'system') return true;
            return msg.parts?.some(part => part.type === 'text' && part.content?.trim());
        });

        // Delegate to image generation if applicable
        if (this.isImageModel(modelId)) {
            return this.callImageGenerationApi(modelId, filteredMessages, tokenCounter, streamWriter, abortController, options);
        }

        const isStreaming = (streamWriter !== null);
        const processedMessages = this.processFiles(filteredMessages);
        
        const settings = {
            max_tokens: this.settingsManager.getSetting('max_tokens'),
            temperature: this.settingsManager.getSetting('temperature')
        };

        const [url, requestOptions] = provider.createRequest({
            model: modelId,
            messages: processedMessages,
            stream: isStreaming,
            options: { ...this, ...options, streamWriter },
            apiKey,
            settings
        });

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

            if (isStreaming) {
                return await this.handleStreamResponse(response, modelId, tokenCounter, streamWriter);
            } else {
                const data = await response.json();
                return provider.handleResponse({ data, tokenCounter });
            }
        } catch (error) {
            streamWriter?.stopThinkingCounter?.();
            throw error;
        }
    }

    async callImageGenerationApi(modelId, messages, tokenCounter, streamWriter, abortController, options) {
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

        const [url, requestOptions] = provider.createImageRequest({
            model: modelId,
            messages: this.processFiles(messages),
            apiKey,
            settings,
            options: { ...this, ...options }
        });

        const response = await this._fetchWithTimeout(
            url,
            requestOptions,
            TIMEOUT.IMAGE_GENERATION,
            { prefix: 'Image generation failed', model: modelId },
            abortController
        );

        const data = await response.json();
        return provider.handleResponse({ data, tokenCounter });
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
     * @param {Object} state Object containing 'buffer' string.
     * @param {string} chunk New data to parse.
     * @returns {Array<Object>} Array of parsed event data objects.
     */
    static parseSSEChunk(state, chunk) {
        state.buffer += chunk;
        const lines = state.buffer.split('\n');
        state.buffer = lines.pop(); // Keep the last incomplete line in the buffer

        const events = [];
        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith('data: ') && trimmed.slice(6) !== '[DONE]') {
                try {
                    events.push(JSON.parse(trimmed.slice(6)));
                } catch (_) {
                    continue;
                }
            }
        }
        return events;
    }

    async handleStreamResponse(response, modelId, tokenCounter, writer) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder("utf-8");
        const provider = this.getProvider(modelId);
        const state = { buffer: '' };

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            const chunk = decoder.decode(value, { stream: true });
            const events = ApiManager.parseSSEChunk(state, chunk);

            for (const parsed of events) {
                provider.handleStream({ parsed, tokenCounter, writer });
            }
        }
        return true;
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

    async getLocalModelConfig() {
        const ports = [...new Set([this.localServerPort, ...LOCAL_SERVER.FALLBACK_PORTS])];
        for (const port of ports) {
            const abort = new AbortController();
            const timeout = setTimeout(() => abort.abort(), TIMEOUT.LOCAL_SERVER_PING);
            try {
                const response = await fetch(`http://localhost:${port}/v1/models`, { signal: abort.signal });
                if (response.ok) {
                    const data = await response.json();
                    const firstModel = data.data?.[0];
                    const rawId = typeof firstModel === 'string'
                        ? firstModel
                        : (firstModel?.id || firstModel?.name || 'local-model');
                    this.localServerPort = port;
                    const displayName = this.formatLocalModelName(rawId);
                    return { raw: rawId, display: displayName, port };
                }
            } catch (_) {
            } finally {
                clearTimeout(timeout);
            }
        }
        return { raw: 'local-model', display: 'Local Model', port: LOCAL_SERVER.DEFAULT_PORT };
    }
}
