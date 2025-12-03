import { SettingsManager } from './state_manager.js';
import { sanitizeBase64Image } from './image_utils.js';


export class ApiManager {
    constructor(options = {}) {
        this.settingsManager = new SettingsManager(['api_keys', 'max_tokens', 'temperature', 'models', 'current_model', 'web_search', 'reasoning_effort']);
        this.lastContentWasRedacted = false;
        this.localServerPort = 8080;
        this.getShouldThink = options.getShouldThink || (() => false);
        this.getWebSearch = options.getWebSearch || null;
        this.getOpenAIReasoningEffort = options.getOpenAIReasoningEffort || (() => this.settingsManager.getSetting('reasoning_effort') || 'medium');
        this.getGeminiThinkingLevel = options.getGeminiThinkingLevel || (() => this.settingsManager.getSetting('reasoning_effort') || 'medium');
        this.getImageAspectRatio = options.getImageAspectRatio || (() => '16:9');
        this.getImageResolution = options.getImageResolution || (() => '2K');
    }

    getCurrentModel() {
        return this.settingsManager.getSetting('current_model');
    }

    isImageModel(model) {
        return model.includes('image') || model.includes('imagen');
    }

    async callApi(model, messages, tokenCounter, streamWriter = null, abortController = null, options = {}) {
        const provider = this.getProviderForModel(model);
        const apiKeys = this.settingsManager.getSetting('api_keys') || {};

        if (provider !== 'llamacpp' && !apiKeys[provider]?.trim()) {
            throw new Error(`${provider} API key is empty, switch to another model or enter a key in the settings.`);
        }

        if (provider === 'llamacpp' && !options.localModelOverride) {
            options.localModelOverride = await this.getLocalModelConfig();
        }

        if (this.isImageModel(model)) {
            return this.callImageGenerationApi(model, messages, tokenCounter, streamWriter, abortController);
        }

        const streamResponse = streamWriter !== null;
        messages = this.processFiles(messages);
        const [apiLink, requestOptions] = this.createApiRequest(model, messages, streamResponse, streamWriter, options.localModelOverride);

        if (!abortController) abortController = new AbortController();
        requestOptions.signal = abortController.signal;

        const timeoutDuration = (streamWriter?.thinkingModelWithCounter || streamWriter?.isThinkingModel) ? 120000 : 30000;
        const timeoutId = setTimeout(() => {
            abortController.abort();
        }, timeoutDuration);

        try {
            const response = await fetch(apiLink, requestOptions);
            clearTimeout(timeoutId);

            if (!response.ok) {
                const errorDetail = await this.readErrorResponse(response);
                throw this.createApiError('API request failed', {
                    model,
                    provider,
                    status: response.status,
                    statusText: response.statusText,
                    detail: errorDetail
                });
            }

            return streamResponse 
                ? this.handleStreamResponse(response, model, tokenCounter, streamWriter)
                : this.handleNonStreamResponse(response, model, tokenCounter);
        } catch (error) {
            clearTimeout(timeoutId);
            if (streamWriter?.stopThinkingCounter) {
                streamWriter.stopThinkingCounter();
            }
            if (error?.name === 'AbortError') {
                throw this.createApiError('API request aborted', {
                    model,
                    provider,
                    detail: `Timed out after ${timeoutDuration / 1000} seconds`
                });
            }
            if (error?.isDetailedApiError) {
                throw error;
            }
            throw this.createApiError('API request error', {
                model,
                provider,
                detail: error
            });
        }
    }

    async callImageGenerationApi(model, messages, tokenCounter, streamWriter = null, abortController = null) {
        const provider = this.getProviderForModel(model);
        const apiKeys = this.settingsManager.getSetting('api_keys') || {};
        const [apiLink, requestOptions] = this.createImageApiRequest(provider, model, messages, apiKeys[provider]);
        
        if (!abortController) abortController = new AbortController();
        requestOptions.signal = abortController.signal;

        const timeoutDuration = 120000; // 2 minutes for image generation
        const timeoutId = setTimeout(() => {
            abortController.abort();
        }, timeoutDuration);

        try {
            const response = await fetch(apiLink, requestOptions);
            clearTimeout(timeoutId);
            
            if (!response.ok) {
                const errorDetail = await this.readErrorResponse(response);
                throw this.createApiError('Image generation failed', {
                    model,
                    provider,
                    status: response.status,
                    statusText: response.statusText,
                    detail: errorDetail
                });
            }

            const data = await response.json();
            return this.handleImageApiResponse(provider, data, tokenCounter, streamWriter);
        } catch (error) {
            clearTimeout(timeoutId);
            if (error?.name === 'AbortError') {
                throw this.createApiError('Image generation aborted', {
                    model,
                    provider,
                    detail: `Timed out after ${timeoutDuration / 1000} seconds`
                });
            }
            if (error?.isDetailedApiError) {
                throw error;
            }
            throw this.createApiError('Image generation error', {
                model,
                provider,
                detail: error
            });
        }
    }

    createImageApiRequest(provider, model, messages, apiKey) {
        switch (provider) {
            case 'gemini':
                return this.createGeminiImageRequest(model, messages, apiKey);
            default:
                throw new Error(`Image generation not supported for provider: ${provider}`);
        }
    }

    handleImageApiResponse(provider, data, tokenCounter, streamWriter) {
        switch (provider) {
            case 'gemini':
                return this.handleGeminiImageResponse(data, tokenCounter, streamWriter);
            default:
                throw new Error(`Image generation not supported for provider: ${provider}`);
        }
    }

    createGeminiImageRequest(model, messages, apiKey) {
        const formattedMessages = this.formatMessagesForGemini(messages);
        const isGemini3 = /gemini-[3-9]|gemini-\d{2,}/.test(model);
        
        const aspectRatio = this.getImageAspectRatio();
        const imageConfig = {
            ...(aspectRatio !== 'auto' && { aspectRatio }),
            ...(isGemini3 && { imageSize: this.getImageResolution() })
        };
        
        return [`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                contents: formattedMessages.slice(1),
                systemInstruction: formattedMessages[0],
                safetySettings: this.getGeminiSafetySettings(),
                generationConfig: {
                    temperature: Math.min(this.settingsManager.getSetting('temperature'), MaxTemp.gemini),
                    maxOutputTokens: Math.min(this.settingsManager.getSetting('max_tokens'), this.getGeminiMaxTokens(model)),
                    ...(Object.keys(imageConfig).length > 0 && { imageConfig })
                }
            })
        }];
    }

    handleGeminiImageResponse(data, tokenCounter, streamWriter) {
        const candidate = data.candidates?.[0];
        if (!candidate) {
            throw new Error("No content was generated");
        }

        if (data.usageMetadata) {
            const thoughtsTokens = data.usageMetadata.thoughtsTokenCount || 0;
            tokenCounter.update(
                data.usageMetadata.promptTokenCount || 0,
                (data.usageMetadata.candidatesTokenCount || 0) + thoughtsTokens
            );
        }

        const messageParts = this.mapGeminiContentParts(candidate.content?.parts);

        if (messageParts.length === 0) {
            throw new Error("No content in response");
        }

        return messageParts;
    }

    sanitizeGeminiImage(rawData, mimeType) {
        return sanitizeBase64Image(rawData || '', mimeType || '');
    }

    mapGeminiContentParts(parts) {
        const messageParts = [];
        for (const part of parts || []) {
            if (part.text !== undefined) {
                const entry = {
                    type: part.thought ? 'thought' : 'text',
                    content: part.text || ''
                };
                if (part.thoughtSignature) entry.thoughtSignature = part.thoughtSignature;
                messageParts.push(entry);
            } else if (part.inlineData?.data) {
                const mimeType = part.inlineData.mimeType || 'image/png';
                const base64 = this.sanitizeGeminiImage(part.inlineData.data, mimeType);
                const imageDataUri = `data:${mimeType};base64,${base64}`;
                const imagePart = { type: 'image', content: imageDataUri };
                if (part.thoughtSignature) imagePart.thoughtSignature = part.thoughtSignature;
                messageParts.push(imagePart);
            }
        }
        return messageParts;
    }

    processFiles(messages) {
        return messages.map(({ files, ...rest }) => {
            if (!files?.length) return rest;
            
            // Append files to the last text part (never attach to thoughts)
            const parts = Array.isArray(rest.parts) ? [...rest.parts] : [];
            const filesBlock = `files:\n${files.map(f =>
                `${f.name}:\n<|file_start|>${f.content ?? ''}<|file_end|>`
            ).join("\n")}`;

            let targetIndex = -1;
            for (let i = parts.length - 1; i >= 0; i--) {
                if (parts[i]?.type === 'text') {
                    targetIndex = i;
                    break;
                }
            }

            if (targetIndex >= 0) {
                const current = parts[targetIndex]?.content || '';
                const separator = current ? "\n\n" : "";
                parts[targetIndex] = { ...parts[targetIndex], content: `${current}${separator}${filesBlock}` };
            } else {
                parts.push({ type: 'text', content: filesBlock });
            }

            return { ...rest, parts };
        });
    }

    createApiRequest(model, messages, streamResponse, streamWriter, localModelOverride = null) {
        const provider = this.getProviderForModel(model);
        const apiKeys = this.settingsManager.getSetting('api_keys');

        switch (provider) {
            case 'openai':
                return this.createOpenAIRequest(model, messages, streamResponse, streamWriter, apiKeys.openai);
            case 'anthropic':
                return this.createAnthropicRequest(model, messages, streamResponse, streamWriter, apiKeys.anthropic);
            case 'gemini':
                return this.createGeminiRequest(model, messages, streamResponse, streamWriter, apiKeys.gemini);
            case 'deepseek':
                return this.createDeepseekRequest(model, messages, streamResponse, streamWriter, apiKeys.deepseek);
            case 'grok':
                return this.createGrokRequest(model, messages, streamResponse, streamWriter, apiKeys.grok);
            case 'kimi':
                return this.createKimiRequest(model, messages, streamResponse, streamWriter, apiKeys.kimi);
            case 'llamacpp':
                return this.createLlamaCppRequest(model, messages, streamResponse, streamWriter, localModelOverride);
            default:
                throw new Error(`Unsupported model provider: ${provider}`);
        }
    }

    getProviderForModel(model) {
        const models = this.settingsManager.getSetting('models') || {};
        for (const [provider, providerModels] of Object.entries(models)) {
            if (model in providerModels) return provider;
        }
        return "llamacpp";
    }

    getGeminiMaxTokens(model) {
        if (model.includes('image')) {
            return MaxTokens.gemini_image;
        }
        if (/gemini-[2-9]\.?\d*|gemini-\d{2,}/.test(model)) {
            return MaxTokens.gemini_modern;
        }
        return MaxTokens.gemini;
    }

    formatMessagesForOpenAI(messages, addImages) {
        return messages.filter(msg => msg.role !== RoleEnum.system).map(msg => {
            const content = [];
            
            const textContent = this.extractTextContent(msg);
            if (textContent) {
                const textType = msg.role === RoleEnum.assistant ? 'output_text' : 'input_text';
                content.push({ type: textType, text: textContent });
            }
            if (addImages && msg.images) {
                msg.images.forEach(img => {
                    content.push({ type: 'input_image', image_url: img });
                });
            }
            return { role: msg.role, content: content };
        });
    }

    formatMessagesForAnthropic(messages) {
        const new_messages = messages.map(msg => {
            const textContent = this.extractTextContent(msg);
            
            if (msg.images) {
                const imgDict = msg.images.map(img => ({
                    type: 'image',
                    source: { type: 'base64', media_type: this.getBase64MediaType(img), data: this.simpleBase64Splitter(img) }
                }));
                return { role: msg.role, content: [{ type: 'text', text: textContent }, ...imgDict] };
            }
            return {
                role: msg.role,
                content: [{ type: 'text', text: textContent }]
            };
        });

        new_messages.at(-1).content.at(-1).cache_control = { "type": "ephemeral" };
        
        return new_messages;
    }

    extractTextContent(msg) {
        if (!msg?.parts) return '';
        return msg.parts
            .filter(part => part.type === 'text' && part.content != null)
            .map(part => part.content)
            .join('\n');
    }

    formatMessagesForGemini(messages) {
        return messages.map(msg => {
            const parts = [];

            (msg.parts || []).forEach(part => {
                if (part.type === 'image' && part.content) {
                    const imagePart = {
                        inline_data: {
                            mime_type: this.getBase64MediaType(part.content),
                            data: this.simpleBase64Splitter(part.content)
                        }
                    };
                    if (part.thoughtSignature) imagePart.thoughtSignature = part.thoughtSignature;
                    parts.push(imagePart);
                    return;
                }

                // Gemini expects text parts; include a signature if present even if content is empty
                if (part.type === 'text' || part.thoughtSignature) {
                    const entry = { text: part.content ?? '' };
                    if (part.thoughtSignature) entry.thoughtSignature = part.thoughtSignature;
                    parts.push(entry);
                }
            });

            if (msg.images) {
                msg.images.forEach(img => {
                    if (img) {
                        parts.push({
                            inline_data: {
                                mime_type: this.getBase64MediaType(img),
                                data: this.simpleBase64Splitter(img)
                            }
                        });
                    }
                });
            }

            if (parts.length === 0) {
                parts.push({ text: '' });
            }

            return {
                role: msg.role === RoleEnum.assistant ? "model" : "user",
                parts
            };
        });
    }

    formatMessagesForDeepseek(messages) {
        return messages.map(msg => ({ role: msg.role, content: this.extractTextContent(msg) }));
    }

    formatMessagesForGrok(messages) {
        return messages.map(msg => {
            const textContent = this.extractTextContent(msg);

            if (msg.images) {
                const content = [];
                content.push({ type: 'text', text: textContent });
                msg.images.forEach(img => {
                    content.push({
                        type: 'image_url',
                        image_url: { url: img }
                    });
                });
                return { role: msg.role, content: content };
            }
            return { role: msg.role, content: textContent };
        });
    }

    formatMessagesForKimi(messages) {
        return messages.map(msg => ({ role: msg.role, content: this.extractTextContent(msg) }));
    }

    getBase64MediaType(base64String) {
        return base64String.split(':')[1].split(';')[0];
    }

    simpleBase64Splitter(base64String) {
        return base64String.split('base64,')[1];
    }

    extractBaseDomain(url) {
        try {
            const hostname = new URL(url).hostname.toLowerCase();
            const noWww = hostname.startsWith('www.') ? hostname.slice(4) : hostname;
            const parts = noWww.split('.');
            if (parts.length <= 2) return noWww;
            const last = parts[parts.length - 1];
            const secondLast = parts[parts.length - 2];
            const sldSet = new Set(['co', 'com', 'org', 'net', 'gov', 'ac', 'edu']);
            if (last.length === 2 && sldSet.has(secondLast)) {
                return parts.slice(-3).join('.');
            }
            return parts.slice(-2).join('.');
        } catch (_) {
            return url;
        }
    }

    buildCitationsTail(citations) {
        if (!Array.isArray(citations) || citations.length === 0) return '';
        const unique = [...new Set(citations)];
        const list = unique.slice(0, 10).map(u => `[${this.extractBaseDomain(u)}](${u})`).join(' · ');
        return `\n\n${list}\n`;
    }

    createOpenAIRequest(model, messages, streamResponse, streamWriter, apiKey) {
        const webSearchCompatibleModels = ['gpt-4.1', 'gpt-5'];
        const webSearchExcludedModels = ['gpt-4.1-nano', 'gpt-5-nano'];
        const hasWebSearch = webSearchCompatibleModels.some(m => model.includes(m)) && !webSearchExcludedModels.some(m => model.includes(m));
        const enableWebSearchSetting = this.getWebSearch ? !!this.getWebSearch() : !!this.settingsManager.getSetting('web_search');
        const enableWebSearch = enableWebSearchSetting && hasWebSearch;
        
        const isReasoner = /o\d/.test(model) || model.includes('gpt-5'); 
        const noImage = model.includes('o1-mini') || model.includes('o1-preview') || model.includes('o3-mini');

        const systemMessage = messages.find(msg => msg.role === RoleEnum.system)?.parts?.[0]?.content;
        const formattedInput = this.formatMessagesForOpenAI(messages, !noImage);

        if (isReasoner && streamWriter) streamWriter.addThinkingCounter();

        const maxOutputTokens = Math.min(
            this.settingsManager.getSetting('max_tokens'),
            isReasoner ? MaxTokens.openai_thinking : MaxTokens.openai // Assuming same limits apply roughly
        );

        const body = {
            model,
            input: formattedInput,
            ...(systemMessage && { instructions: systemMessage }),
            ...(enableWebSearch && { tools: [{ type: "web_search_preview" }] }),   // tools is only used if model requests it
            ...(isReasoner && { reasoning: { effort: this.getOpenAIReasoningEffort() } }),  // summary parameter also requires "verification"
            max_output_tokens: maxOutputTokens,
            // Temperature is not directly settable for reasoning models in /v1/responses it seems, omit for them
            ...(!isReasoner && { temperature: Math.min(this.settingsManager.getSetting('temperature'), MaxTemp.openai) }),
            stream: streamResponse,
        };

        Object.keys(body).forEach(key => (body[key] == null) && delete body[key]);


        return ['https://api.openai.com/v1/responses', {
            method: 'POST',
            credentials: 'omit',
            headers: {'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}`},
            body: JSON.stringify(body)
        }];
    }

    createAnthropicRequest(model, messages, streamResponse, streamWriter, apiKey) {
        const canThink = ['3-7-sonnet', 'sonnet-4', 'opus-4'].some(sub => model.includes(sub));
        const isThinking = canThink && this.getShouldThink();
        const maxTokens = Math.min(
            this.settingsManager.getSetting('max_tokens'),
            model.includes('opus') ? MaxTokens.anthropic :
            !canThink ? MaxTokens.anthropic_old :
            isThinking ? MaxTokens.anthropic_thinking : MaxTokens.anthropic
        );
        
        // Configure thinking for Sonnet 3.7
        let thinkingConfig = null;
        if (isThinking) {
            const thinkingBudget = Math.max(1024, maxTokens - 4000);
            thinkingConfig = {
                type: "enabled",
                budget_tokens: thinkingBudget
            };
            
            if (streamWriter) streamWriter.setThinkingModel();
        }

        const webSearchCompatibleModelSubstrings = ['claude-3-7-sonnet', 'claude-3-5-sonnet-latest', 'claude-3-5-haiku-latest', 'sonnet-4', 'opus-4'];
        const hasWeb = webSearchCompatibleModelSubstrings.some(substring => model.includes(substring));
        const enableWebSearchSetting = this.getWebSearch ? !!this.getWebSearch() : !!this.settingsManager.getSetting('web_search');
        const enableWebSearch = enableWebSearchSetting && hasWeb;
        
        messages = this.formatMessagesForAnthropic(messages);
        const requestBody = {
            model,
            system: [messages[0].content[0]],
            messages: messages.slice(1),
            max_tokens: maxTokens,
            ...(!thinkingConfig && { temperature: Math.min(this.settingsManager.getSetting('temperature'), MaxTemp.anthropic) }),
            ...(thinkingConfig && { thinking: thinkingConfig }),
            ...(enableWebSearch && { tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 2 }] }),
            stream: streamResponse
        };

        return ['https://api.anthropic.com/v1/messages', {
            method: 'POST',
            credentials: 'omit',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01',
                'anthropic-dangerous-direct-browser-access': 'true'
            },
            body: JSON.stringify(requestBody)
        }];
    }

    createDeepseekRequest(model, messages, streamResponse, streamWriter, apiKey) {
        const isReasoner = model.includes('reasoner');
        if (isReasoner && streamWriter) streamWriter.setThinkingModel();
        
        const maxTokens = Math.min(
            this.settingsManager.getSetting('max_tokens'),
            MaxTokens.deepseek
        );
        
        return ['https://api.deepseek.com/v1/chat/completions', {
            method: 'POST',
            credentials: 'omit',
            headers: {'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}`},
            body: JSON.stringify({
                model,
                messages: this.formatMessagesForDeepseek(messages),
                max_tokens: maxTokens,
                ...(!isReasoner && {temperature: Math.min(this.settingsManager.getSetting('temperature'), MaxTemp.deepseek)}),
                stream: streamResponse,
                ...(streamResponse && {stream_options: {include_usage: true}})
            })
        }];
    }

    createGeminiRequest(model, messages, streamResponse, streamWriter, apiKey) {
        const isGemini3Plus = /gemini-[3-9]\.?\d*|gemini-\d{2,}/.test(model);
        const isGemini25 = model.includes('gemini-2.5');
        const isGemini25Pro = isGemini25 && model.includes('pro');
        
        // Gemini 3+: always thinks, Gemini 2.5 Pro: always thinks, Gemini 2.5 Flash: toggle
        const isThinking = isGemini3Plus || isGemini25Pro || (isGemini25 && this.getShouldThink());
        
        if (isThinking && streamWriter) streamWriter.setThinkingModel();
        
        const maxTokens = Math.min(
            this.settingsManager.getSetting('max_tokens'),
            isThinking ? MaxTokens.gemini_thinking : this.getGeminiMaxTokens(model)
        );
        
        messages = this.formatMessagesForGemini(messages);
        const responseType = streamResponse ? "streamGenerateContent" : "generateContent";
        const streamParam = streamResponse ? "alt=sse&" : "";
        
        let thinkingParams = {};
        if (isGemini3Plus) {
            thinkingParams = { thinking_config: { thinkingLevel: this.getGeminiThinkingLevel(), include_thoughts: true } };
        } else if (isThinking) {
            thinkingParams = { thinking_config: { thinkingBudget: -1, include_thoughts: true } };
        }
        
        return [`https://generativelanguage.googleapis.com/v1beta/models/${model}:${responseType}?${streamParam}key=${apiKey}`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                contents: messages.slice(1),
                systemInstruction: messages[0],
                safetySettings: this.getGeminiSafetySettings(),
                generationConfig: {
                    temperature: Math.min(this.settingsManager.getSetting('temperature'), MaxTemp.gemini),
                    maxOutputTokens: maxTokens,
                    responseMimeType: "text/plain",
                    ...thinkingParams
                }
            })
        }];
    }

    createGrokRequest(model, messages, streamResponse, streamWriter, apiKey) {
        const isGrok4 = model.includes('grok-4');
        const isNonThinking = model.includes('non-reasoning');
        const canThink = isGrok4 && !isNonThinking;
        
        // For Grok-4 variants, use thinking counter instead of thinking model
        // (they don't return thinking traces but do consume reasoning tokens)
        // Exception: non-thinking variants don't need either
        if (canThink && streamWriter) {
            streamWriter.addThinkingCounter();
        }
        
        const maxTokens = Math.min(
            this.settingsManager.getSetting('max_tokens'),
            MaxTokens.grok
        );

        const enableWebSearchSetting = this.getWebSearch ? !!this.getWebSearch() : !!this.settingsManager.getSetting('web_search');
        const enableWebSearch = enableWebSearchSetting && isGrok4;
        
        const requestBody = {
            model,
            messages: this.formatMessagesForGrok(messages),
            max_tokens: maxTokens,
            temperature: Math.min(this.settingsManager.getSetting('temperature'), MaxTemp.grok),
            stream: streamResponse,
            ...(streamResponse && {stream_options: {include_usage: true}}),
            ...(enableWebSearch && { search_parameters: { mode: "auto" } })     // auto is a good default, enables web + x search, returns citations, and doesnt force the model to search.
        };
        
        return ['https://api.x.ai/v1/chat/completions', {
            method: 'POST',
            credentials: 'omit',
            headers: {'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}`},
            body: JSON.stringify(requestBody)
        }];
    }

    createKimiRequest(model, messages, streamResponse, streamWriter, apiKey) {
        const isThinking = model.includes('thinking');
        if (isThinking && streamWriter) streamWriter.setThinkingModel();

        const maxTokens = Math.min(
            this.settingsManager.getSetting('max_tokens'),
            MaxTokens.kimi
        );

        return ['https://api.moonshot.ai/v1/chat/completions', {
            method: 'POST',
            credentials: 'omit',
            headers: {'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}`},
            body: JSON.stringify({
                model,
                messages: this.formatMessagesForKimi(messages),
                max_tokens: maxTokens,
                temperature: Math.min(this.settingsManager.getSetting('temperature'), MaxTemp.kimi),
                stream: streamResponse,
                ...(streamResponse && {stream_options: {include_usage: true}})
            })
        }];
    }

    createLlamaCppRequest(model, messages, streamResponse, streamWriter, override = null) {
        const configuration = override || { raw: model, port: this.localServerPort || 8000 };
        const { raw: modelId, port } = configuration;

        const body = {
            model: modelId,
            messages: this.formatMessagesForGrok(messages),
            stream: streamResponse,
            temperature: this.settingsManager.getSetting('temperature')
        };

        return [`http://localhost:${port}/v1/chat/completions`, {
            method: 'POST',
            credentials: 'omit',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        }];
    }

    getGeminiSafetySettings() {
        return [
            { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
        ];
    }

    async handleStreamResponse(response, model, tokenCounter, streamWriter) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder("utf-8");
        let buffer = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop();

            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    const data = line.slice(6);
                    if (data === '[DONE]') continue;
                    this.processStreamData(data, model, tokenCounter, streamWriter);
                }
            }
        }
        return true;
    }

    async handleNonStreamResponse(response, model, tokenCounter) {
        const data = await response.json();
        const provider = this.getProviderForModel(model);
        switch (provider) {
            case 'openai':
                return this.handleOpenAINonStreamResponse(data, tokenCounter);
            case 'anthropic':
                return this.handleAnthropicNonStreamResponse(data, tokenCounter);
            case 'gemini':
                return this.handleGeminiNonStreamResponse(data, tokenCounter);
            case 'deepseek':
                return this.handleDeepseekNonStreamResponse(data, tokenCounter);
            case 'grok':
                return this.handleGrokNonStreamResponse(data, tokenCounter);
            case 'kimi':
                return this.handleKimiNonStreamResponse(data, tokenCounter);
            case 'llamacpp':
                return this.handleLlamaCppNonStreamResponse(data, tokenCounter);
            default:
                throw new Error(`Unsupported model provider: ${provider}`);
        }
    }

    handleOpenAINonStreamResponse(data, tokenCounter) {
        const messageItem = data.output?.find(item => item.type === 'message');
        const textContent = (messageItem?.content || [])
            .filter(part => part.type === 'output_text' && typeof part.text === 'string')
            .map(part => part.text)
            .join('') || '';

        const reasoningItem = data.output?.find(item => item.type === 'reasoning');
        const reasoningSummary = Array.isArray(reasoningItem?.summary) ? reasoningItem.summary.join('') : (reasoningItem?.summary || '');
        const thoughts = reasoningSummary ? [reasoningSummary] : [];

        const inputTokens = data.usage?.input_tokens || 0;
        const outputTokens = data.usage?.output_tokens || 0;
        tokenCounter.update(inputTokens, outputTokens);

        return this.returnMessage([textContent], thoughts);
    }
    
    handleAnthropicNonStreamResponse(data, tokenCounter) {
        const totalInputTokens = data.usage.input_tokens + 
            (data.usage.cache_creation_input_tokens || 0) + 
            (data.usage.cache_read_input_tokens || 0);
        tokenCounter.update(totalInputTokens, data.usage.output_tokens);
        return this.returnMessage([data.content[0].text]);
    }
    
    handleGeminiNonStreamResponse(data, tokenCounter) {
        const usage = data.usageMetadata || {};
        const thoughtsTokens = usage.thoughtsTokenCount || 0;
        tokenCounter.update(usage.promptTokenCount, (usage.candidatesTokenCount || 0) + thoughtsTokens);

        const candidate = data.candidates?.[0];
        const messageParts = this.mapGeminiContentParts(candidate?.content?.parts);
        return messageParts.length ? messageParts : this.returnMessage(['']);
    }

    handleDeepseekNonStreamResponse(data, tokenCounter) {
        tokenCounter.update(data.usage.prompt_tokens, data.usage.completion_tokens);
        const message = data.choices[0].message;
        const thoughts = message.reasoning_content ? [message.reasoning_content] : [];
        return this.returnMessage([message.content], thoughts);
    }

    handleGrokNonStreamResponse(data, tokenCounter) {
        tokenCounter.update(data.usage.prompt_tokens, data.usage.completion_tokens);
        const message = data.choices[0].message;
        const thoughts = message.reasoning_content ? [message.reasoning_content] : [];
        const citations = Array.isArray(data.citations) ? data.citations : [];
        if (citations.length) {
            const sourcesText = this.buildCitationsTail(citations);
            return this.returnMessage([message.content + sourcesText], thoughts);
        }
        return this.returnMessage([message.content], thoughts);
    }

    handleKimiNonStreamResponse(data, tokenCounter) {
        tokenCounter.update(data.usage.prompt_tokens, data.usage.completion_tokens);
        const message = data.choices[0].message;
        const thoughts = message.reasoning_content ? [message.reasoning_content] : [];
        return this.returnMessage([message.content], thoughts);
    }

    async handleLlamaCppNonStreamResponse(data, tokenCounter) {
        if (data.usage) {
            tokenCounter.update(data.usage.prompt_tokens || 0, data.usage.completion_tokens || 0);
        }
        
        const message = data.choices[0].message;
        const thoughts = message.reasoning_content ? [message.reasoning_content] : [];
        return this.returnMessage([message.content], thoughts);
    }

    returnMessage(parts, thoughts = []) {
        const message = [];
        thoughts.forEach(thought => {
            if (thought) message.push({ type: 'thought', content: thought });
        });
        parts.forEach(part => {
            // Handle both string parts and object parts (for images)
            if (typeof part === 'string') {
                if (part) message.push({ type: 'text', content: part });
            } else if (part && typeof part === 'object') {
                message.push(part);
            }
        });
        return message;
    }

    async readErrorResponse(response) {
        if (!response || typeof response.text !== 'function') {
            return '';
        }

        const contentType = response.headers?.get?.('content-type') || '';
        let bodyText = '';
        try {
            bodyText = await response.text();
        } catch (_) {
            return '';
        }

        const trimmed = bodyText.trim();
        if (!trimmed) {
            return '';
        }

        const parsedIsJson = contentType.includes('json');
        if (parsedIsJson) {
            const parsed = this.safeParseJson(trimmed);
            return parsed !== null ? this.formatErrorDetails(parsed) : trimmed;
        }

        const parsed = this.safeParseJson(trimmed);
        if (parsed !== null) {
            return this.formatErrorDetails(parsed);
        }

        return trimmed;
    }

    formatErrorDetails(value, seen = new WeakSet()) {
        if (value === null || value === undefined) return '';
        if (value instanceof Error) {
            const base = (value.message || value.name || '').trim();
            const cause = value.cause ? this.formatErrorDetails(value.cause, seen) : '';
            return cause ? `${base} | cause: ${cause}` : base;
        }

        const type = typeof value;
        if (type === 'string') {
            const trimmed = value.trim();
            if (!trimmed) return '';
            if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
                const parsed = this.safeParseJson(trimmed);
                if (parsed !== null) return this.formatErrorDetails(parsed, seen);
            }
            return trimmed;
        }

        if (type === 'number' || type === 'boolean' || type === 'bigint') {
            return String(value);
        }

        if (Array.isArray(value)) {
            const parts = value
                .map(item => this.formatErrorDetails(item, seen))
                .filter(Boolean);
            return parts.length ? [...new Set(parts)].join(' | ') : '';
        }

        if (type === 'object') {
            if (seen.has(value)) return '';
            seen.add(value);

            const parts = [];

            const textFields = ['message', 'detail', 'error', 'error_description', 'description'];
            textFields.forEach(field => {
                const fieldValue = value[field];
                if (typeof fieldValue === 'string') {
                    const formatted = this.formatErrorDetails(fieldValue, seen);
                    if (formatted) parts.push(formatted);
                } else if (fieldValue && fieldValue !== value) {
                    const formatted = this.formatErrorDetails(fieldValue, seen);
                    if (formatted) parts.push(formatted);
                }
            });

            if (typeof value.title === 'string' && value.title.trim() && typeof value.detail === 'string' && value.detail.trim()) {
                parts.push(`${value.title.trim()}: ${value.detail.trim()}`);
            }

            const meta = [];
            ['type', 'code', 'status', 'status_code', 'param', 'reason'].forEach(key => {
                const metaValue = value[key];
                if (metaValue === undefined || metaValue === null) return;
                const metaType = typeof metaValue;
                if (metaType === 'string') {
                    const trimmed = metaValue.trim();
                    if (trimmed) meta.push(`${key}=${trimmed}`);
                } else if (metaType === 'number' || metaType === 'boolean' || metaType === 'bigint') {
                    meta.push(`${key}=${metaValue}`);
                }
            });
            if (meta.length && parts.length) {
                parts[0] = `${parts[0]} (${meta.join(', ')})`;
            } else if (meta.length) {
                parts.push(meta.join(', '));
            }

            if (value.cause && value.cause !== value) {
                const cause = this.formatErrorDetails(value.cause, seen);
                if (cause) parts.push(`cause: ${cause}`);
            }

            if (Array.isArray(value.errors) && value.errors !== value) {
                const nestedErrors = this.formatErrorDetails(value.errors, seen);
                if (nestedErrors) parts.push(nestedErrors);
            }

            const uniqueParts = [...new Set(parts.map(part => part.trim()).filter(Boolean))];
            if (uniqueParts.length) return uniqueParts.join(' | ');

            if (typeof value.toString === 'function') {
                const fallback = String(value).trim();
                if (fallback && fallback !== '[object Object]') return fallback;
            }

            try {
                return JSON.stringify(value);
            } catch (_) {
                return '';
            }
        }

        if (type === 'function') {
            return value.name || '[function]';
        }

        return '';
    }

    safeParseJson(text) {
        try {
            return JSON.parse(text);
        } catch (_) {
            return null;
        }
    }

    createApiError(prefix, context = {}) {
        const { model, provider, status, statusText, detail } = context;
        const meta = [];
        if (model) {
            meta.push(`model=${model}`);
        }
        if (provider) {
            meta.push(`provider=${provider}`);
        }
        if (status != null) {
            const statusLabel = statusText ? `${status} ${statusText}` : status;
            meta.push(`status=${statusLabel}`);
        }

        const suffix = meta.length ? ` (${meta.join(', ')})` : '';
        const detailText = this.formatErrorDetails(detail);
        const message = detailText ? `${prefix}${suffix}: ${detailText}` : `${prefix}${suffix}`;
        const error = new Error(message);
        error.isDetailedApiError = true;
        return error;
    }

    getUiErrorMessage(error, options = {}) {
        const { prefix = 'Error' } = options;
        const detail = this.formatErrorDetails(error);

        const extractFallback = () => {
            if (error && typeof error.message === 'string') {
                return error.message.trim();
            }
            if (typeof error === 'string') {
                return error.trim();
            }
            if (error == null) {
                return '';
            }
            return String(error).trim();
        };

        let message = (detail || '').trim();
        if (!message) {
            message = extractFallback();
        }
        if (!message) {
            message = 'Unknown error';
        }

        if (!prefix) {
            return message;
        }

        const normalizedMessage = message.toLowerCase();
        const normalizedPrefix = `${prefix}:`.toLowerCase();
        if (normalizedMessage.startsWith(normalizedPrefix)) {
            return message;
        }
        return `${prefix}: ${message}`;
    }

    processStreamData(data, model, tokenCounter, streamWriter) {
        const provider = this.getProviderForModel(model);
        let parsed;
        try {
            parsed = JSON.parse(data);
        } catch (_) {
            return;     // ignore invalid json
        }

        switch (provider) {
            case 'openai':
                this.handleOpenAIStreamData(parsed, tokenCounter, streamWriter);
                break;
            case 'anthropic':
                this.handleAnthropicStreamData(parsed, tokenCounter, streamWriter);
                break;
            case 'gemini':
                this.handleGeminiStreamData(parsed, tokenCounter, streamWriter);
                break;
            case 'deepseek':
                this.handleDeepseekStreamData(parsed, tokenCounter, streamWriter);
                break;
            case 'grok':
                this.handleGrokStreamData(parsed, tokenCounter, streamWriter);
                break;
            case 'kimi':
                this.handleKimiStreamData(parsed, tokenCounter, streamWriter);
                break;
            case 'llamacpp':
                this.handleLlamaCppStreamData(parsed, tokenCounter, streamWriter);
                break;
            default:
                throw new Error(`Unsupported model provider: ${provider}`);
        }
    }

    handleOpenAIStreamData(parsed, tokenCounter, streamWriter) {
        switch (parsed.type) {
            case 'response.output_text.delta':
                if (parsed.delta) {
                    streamWriter.processContent(parsed.delta);
                }
                break;
            case 'response.completed':
                if (parsed.response?.usage) {
                    const inputTokens = parsed.response.usage.input_tokens || 0;
                    const outputTokens = parsed.response.usage.output_tokens || 0;
                    tokenCounter.update(inputTokens, outputTokens);
                }
                break;
            default:
                break;
        }
    }

    handleAnthropicStreamData(parsed, tokenCounter, streamWriter) {
        switch (parsed.type) {
            case 'content_block_delta':
                if (parsed.delta.type === 'text_delta') {
                    const content = parsed.delta.text;
                    if (content) {
                        streamWriter.processContent(content);
                    }
                } else if (parsed.delta.type === 'thinking_delta') {
                    const thinking = parsed.delta.thinking;
                    if (thinking) {
                        streamWriter.processContent(thinking, true);
                    }
                } else if (parsed.delta.text) {
                    streamWriter.processContent(parsed.delta.text);
                }
                break;
            case 'content_block_start':
                if (parsed.content_block && parsed.content_block.type === 'redacted_thinking') {
                    if (!this.lastContentWasRedacted) {
                        streamWriter.processContent("\n\n```\n*redacted thinking*\n```\n\n", true);
                        this.lastContentWasRedacted = true;
                    }
                } else {
                    this.lastContentWasRedacted = false;
                }
                break;
            case 'message_start':
                if (parsed.message && parsed.message.usage) {
                    const {input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens} = parsed.message.usage;
                    const totalInputTokens = input_tokens + (cache_creation_input_tokens || 0) + (cache_read_input_tokens || 0);
                    tokenCounter.update(totalInputTokens, output_tokens);
                }
                break;
            case 'message_delta':
                if (parsed.usage && parsed.usage.output_tokens) {
                    tokenCounter.update(0, parsed.usage.output_tokens);
                }
                break;
            case 'error': {
                const errorDetail = this.formatErrorDetails(parsed.error);
                throw this.createApiError('Anthropic stream error', {
                    provider: 'anthropic',
                    detail: errorDetail
                });
            }
        }
    }

    handleGeminiStreamData(parsed, tokenCounter, streamWriter) {
        parsed.candidates?.[0]?.content.parts?.forEach(contentDict => {
            if (contentDict.text !== undefined) {
                streamWriter.processContent(contentDict.text, !!contentDict.thought);
            }
            if (contentDict.thoughtSignature && streamWriter?.parts?.length) {
                streamWriter.parts.at(-1).thoughtSignature = contentDict.thoughtSignature;
            }
        });

        if (parsed.usageMetadata && parsed.usageMetadata.promptTokenCount) {
            const thoughtsTokens = parsed.usageMetadata.thoughtsTokenCount || 0;
            tokenCounter.update(
                parsed.usageMetadata.promptTokenCount,
                (parsed.usageMetadata.candidatesTokenCount || 0) + thoughtsTokens
            );
        }
    }

    handleDeepseekStreamData(parsed, tokenCounter, streamWriter) {
        if (parsed?.usage && parsed?.choices?.[0]?.delta?.content === "") {
            tokenCounter.update(parsed.usage.prompt_tokens, parsed.usage.completion_tokens);
            return;
        }
        const reasoningContent = parsed?.choices?.[0]?.delta?.reasoning_content;
        const content = parsed?.choices?.[0]?.delta?.content;
        
        if (reasoningContent) {
            streamWriter.processContent(reasoningContent, true);
        }
        if (content) {
            streamWriter.processContent(content);
        }
    }

    handleGrokStreamData(parsed, tokenCounter, streamWriter) {
        if (parsed?.usage && parsed?.choices?.length === 0) {
            // Include reasoning tokens in the completion token count for Grok models
            const baseCompletionTokens = parsed.usage.completion_tokens || 0;
            const reasoningTokens = parsed.usage.completion_tokens_details?.reasoning_tokens || 0;
            const totalCompletionTokens = baseCompletionTokens + reasoningTokens;

            tokenCounter.update(parsed.usage.prompt_tokens, totalCompletionTokens);

            // Append citations at end if provided by Grok
            const citations = Array.isArray(parsed.citations) ? parsed.citations : [];
            if (citations.length) {
                const sourcesText = this.buildCitationsTail(citations);
                streamWriter.processContent(sourcesText);
            }
            return;
        }

        const reasoningContent = parsed?.choices?.[0]?.delta?.reasoning_content;
        const content = parsed?.choices?.[0]?.delta?.content;

        if (reasoningContent) {
            streamWriter.processContent(reasoningContent, true);
        }
        if (content) {
            streamWriter.processContent(content);
        }
    }

    handleKimiStreamData(parsed, tokenCounter, streamWriter) {
        if (parsed?.usage && parsed?.choices?.length === 0) {
            tokenCounter.update(parsed.usage.prompt_tokens, parsed.usage.completion_tokens);
            return;
        }
        const reasoningContent = parsed?.choices?.[0]?.delta?.reasoning_content;
        const content = parsed?.choices?.[0]?.delta?.content;

        if (reasoningContent) {
            streamWriter.processContent(reasoningContent, true);
        }
        if (content) {
            streamWriter.processContent(content);
        }
    }

    handleLlamaCppStreamData(parsed, tokenCounter, streamWriter) {
        if (parsed.usage && (!parsed.choices || parsed.choices.length === 0)) {
            tokenCounter.update(parsed.usage.prompt_tokens || 0, parsed.usage.completion_tokens || 0);
            if (parsed.timings) {
                console.log(`Llama.cpp performance - Speed: ${parsed.timings.predicted_per_second?.toFixed(1)} tokens/sec`);
            }
            
            if (streamWriter?.onComplete) {
                streamWriter.onComplete();
            }
            return;
        }
        
        const firstChoice = parsed.choices?.[0];

        if (!firstChoice) return;

        const delta = firstChoice.delta;
        const message = firstChoice.message;

        const reasoningContent = delta?.reasoning_content || message?.reasoning_content;
        const content = delta?.content || message?.content;

        if (reasoningContent && !streamWriter.isThinkingModel) {
            streamWriter.setThinkingModel();
        }

        if (reasoningContent) {
            streamWriter.processContent(reasoningContent, true);
        }
        if (content) {
            streamWriter.processContent(content);
        }
    }

    async getLocalModelConfig() {
        const portsToTry = [this.localServerPort || 8080, this.localServerPort === 8080 ? 8000 : 8080];

        const fetchModel = async (port) => {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 2000);
            
            try {
                const response = await fetch(`http://localhost:${port}/v1/models`, {
                    signal: controller.signal
                });
                clearTimeout(timeoutId);
                
                if (!response.ok) throw new Error(`Port ${port} not available`);
                const data = await response.json();
                const firstModel = data.data?.[0] || {};
                const raw = typeof firstModel === 'string' ? firstModel : (firstModel.id || firstModel.name || 'local-model');
                return {
                    raw,
                    display: this.parseModelName(raw),
                    port
                };
            } finally {
                clearTimeout(timeoutId);
            }
        };

        for (const port of portsToTry) {
            try {
                const info = await fetchModel(port);
                this.localServerPort = info.port;
                return info;
            } catch (_) {
                // Move to the next port
            }
        }

        return {
            raw: 'local-model',
            display: 'Local Model',
            port: this.localServerPort || 8000
        };
    }

    parseModelName(rawPath) {
        if (!rawPath || rawPath === 'local-model') return 'Local Model';

        const filename = rawPath.split(/[/\\]/).pop();
        return filename
            .replace(/\.(gguf|ggml|bin|safetensors)$/i, '')
            .replace(/[-_]/g, ' ')
            .replace(/\b\w/g, l => l.toUpperCase()) || 'Local Model';
    }
}


const MaxTemp = {
    openai: 2.0,
    anthropic: 1.0,
    gemini: 2.0,
    deepseek: 2.0,
    grok: 2.0,
    kimi: 1.0
};

const MaxTokens = {
    openai: 16384,
    openai_thinking: 100000,
    anthropic: 32000,   // sonnet-4 is 64k, opus-4 is 32k, older models like original sonnet 3.5 are 8k or less
    anthropic_thinking: 64000,
    gemini: 8192,       // Old Gemini models (2.0 and below)
    gemini_modern: 65536,  // Gemini 2.5+ and 3+
    gemini_image: 32768,   // Gemini image models (Nano Banana variants)
    gemini_thinking: 65536,
    deepseek: 8000,
    anthropic_old: 8192,
    grok: 131072,
    kimi: 262144
};

// for now decided against of having a "max tokens" for every api, as it varies by model... let the user figure it out :)

const RoleEnum = { system: "system", user: "user", assistant: "assistant" };
