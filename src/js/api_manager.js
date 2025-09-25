import { SettingsManager } from './state_manager.js';


export class ApiManager {
    constructor(options = {}) {
        this.settingsManager = new SettingsManager(['api_keys', 'max_tokens', 'temperature', 'models', 'current_model', 'web_search', 'reasoning_effort']);
        this.lastContentWasRedacted = false;
        // Getter for UI/state-driven reasoning toggle, injected by caller (optional)
        this.getShouldThink = options.getShouldThink || (() => false);
        this.getWebSearch = options.getWebSearch || null;
        this.getOpenAIReasoningEffort = options.getOpenAIReasoningEffort || (() => this.settingsManager.getSetting('reasoning_effort') || 'medium');
    }

    getCurrentModel() {
        return this.settingsManager.getSetting('current_model');
    }

    async callApi(model, messages, tokenCounter, streamWriter = null, abortController = null) {
        const provider = this.getProviderForModel(model);
        const apiKeys = this.settingsManager.getSetting('api_keys') || {};
        
        if (provider !== 'llamacpp' && !apiKeys[provider]?.trim()) {
            throw new Error(`${provider} API key is empty, switch to another model or enter a key in the settings.`);
        }

        const streamResponse = streamWriter !== null;
        messages = this.processFiles(messages);
        const [apiLink, requestOptions] = this.createApiRequest(model, messages, streamResponse, streamWriter);
        
        if (!apiLink || !requestOptions) {
            throw new Error("Invalid API request configuration.");
        }

        if (!abortController) abortController = new AbortController();
        requestOptions.signal = abortController.signal;

        // Determine timeout duration (longer for "thinking" models)
        const timeoutDuration = streamWriter?.thinkingModelWithCounter ? 60000 : 15000;
        const timeoutId = setTimeout(() => {
            abortController.abort();
        }, timeoutDuration);

        try {
            const response = await fetch(apiLink, requestOptions);
            clearTimeout(timeoutId);
            if (!response.ok) throw new Error(`API request failed with status ${response.status}`);

            return streamResponse 
                ? this.handleStreamResponse(response, model, tokenCounter, streamWriter)
                : this.handleNonStreamResponse(response, model, tokenCounter);
        } catch (error) {
            clearTimeout(timeoutId);
            if (streamWriter?.stopThinkingCounter) {
                streamWriter.stopThinkingCounter();
            }
            if (error.name === 'AbortError') {
                throw new Error(`API request for ${model} was aborted after ${timeoutDuration / 1000} seconds.`);
            }
            throw new Error(`API request error: ${error.message}`);
        }
    }

    processFiles(messages) {
        return messages.map(({ files, ...rest }) => ({
            ...rest,
            content: files?.length > 0
                ? `${rest.content}\n\nfiles:\n${files.map(f => 
                    `${f.name}:\n<|file_start|>${f.content}<|file_end|>`
                ).join("\n")}`
                : rest.content
        }));
    }

    createApiRequest(model, messages, streamResponse, streamWriter) {
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
            case 'llamacpp':
                return this.createLlamaCppRequest(model, messages, streamResponse, streamWriter);
            default:
                throw new Error(`Unsupported model provider: ${provider}`);
        }
    }

    getProviderForModel(model) {
        const models = this.settingsManager.getSetting('models') || {};
        for (const [provider, providerModels] of Object.entries(models)) {
            if (model in providerModels) return provider;
        }
        return "llamacpp";  // fallback to llamacpp if unknown model, this is intended as local model names are not stored in the settings
    }

    formatMessagesForOpenAI(messages, addImages) {
        // Note: System message is handled separately as 'instructions' in the /v1/responses API
        return messages.filter(msg => msg.role !== RoleEnum.system).map(msg => {
            const content = [];
            if (msg.content) {
                // Use 'output_text' for assistant messages, 'input_text' otherwise (for user messages)
                const textType = msg.role === RoleEnum.assistant ? 'output_text' : 'input_text';
                content.push({ type: textType, text: msg.content });
            }
            if (addImages && msg.role === RoleEnum.user && msg.images) {
                msg.images.forEach(img => {
                    // Assuming base64 data URI format "data:[<mediatype>];base64,<data>"
                    content.push({ type: 'input_image', image_url: img });
                });
            }
            // Map internal roles to OpenAI /v1/responses roles if needed, though 'user' and 'assistant' match
            return { role: msg.role, content: content };
        });
    }

    formatMessagesForAnthropic(messages) {
        const new_messages = messages.map(msg => {
            if (msg.role === RoleEnum.user && msg.images) {
                const imgDict = msg.images.map(img => ({
                    type: 'image',
                    source: { type: 'base64', media_type: this.getBase64MediaType(img), data: this.simpleBase64Splitter(img) }
                }));
                return { role: msg.role, content: [{ type: 'text', text: msg.content }, ...imgDict] };
            }
            return {
                role: msg.role,
                content: [{ type: 'text', text: msg.content }]
            };
        });

        // add message caching
        new_messages.at(-1).content.at(-1).cache_control = { "type": "ephemeral" };
        
        return new_messages;
    }

    formatMessagesForGemini(messages) {
        return messages.map(msg => {
            const parts = [];
            if (msg.content) {
                parts.push({ text: msg.content });
            }
            if (msg.role === RoleEnum.user && msg.images) {
                msg.images.forEach(img => {
                    parts.push({
                        inline_data: {
                            mime_type: this.getBase64MediaType(img),
                            data: this.simpleBase64Splitter(img)
                        }
                    });
                });
            }
            return {
                role: msg.role === RoleEnum.assistant ? "model" : "user",
                parts: parts
            };
        });
    }

    formatMessagesForDeepseek(messages) {
        // because no images supported yet
        return messages.map(msg => ({ role: msg.role, content: msg.content }));
    }

    formatMessagesForGrok(messages) {
        // Grok uses standard OpenAI format and supports vision - always include images
        return messages.map(msg => {
            if (msg.role === RoleEnum.user && msg.images) {
                const content = [];
                content.push({ type: 'text', text: msg.content });
                msg.images.forEach(img => {
                    content.push({
                        type: 'image_url',
                        image_url: { url: img }
                    });
                });
                return { role: msg.role, content: content };
            }
            return { role: msg.role, content: msg.content };
        });
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
        const webSearchCompatibleModels = ['gpt-4.1', 'gpt-5']; // Add model substrings here
        const webSearchExcludedModels = ['gpt-4.1-nano', 'gpt-5-nano'];
        const hasWebSearch = webSearchCompatibleModels.some(m => model.includes(m)) && !webSearchExcludedModels.some(m => model.includes(m));
        const enableWebSearchSetting = this.getWebSearch ? !!this.getWebSearch() : !!this.settingsManager.getSetting('web_search');
        const enableWebSearch = enableWebSearchSetting && hasWebSearch;
        
        // Use regex to check for 'o' followed by a digit (e.g., o1, o3, o4)
        const isReasoner = /o\d/.test(model) || model.includes('gpt-5');    // looks like gpt-5 and o3 require "verification" for now, (gpt-5 for streaming), which is just fking 
        const noImage = model.includes('o1-mini') || model.includes('o1-preview') || model.includes('o3-mini');

        const systemMessage = messages.find(msg => msg.role === RoleEnum.system)?.content;
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

        // Remove null/undefined values from body
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
            // Calculate thinking budget (leave at least 4000 tokens for answer)
            const thinkingBudget = Math.max(1024, maxTokens - 4000);
            thinkingConfig = {
                type: "enabled",
                budget_tokens: thinkingBudget
            };
            
            // Set up thinking UI if using streaming
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
        const isThinking = model.includes('thinking') || model.includes('gemini-2.5-pro') || model.includes('gemini-2.5-flash');  // very specific but no better way to do this rn
        if (isThinking) {
            if (streamWriter) streamWriter.addThinkingCounter();
        }
        
        const maxTokens = Math.min(
            this.settingsManager.getSetting('max_tokens'),
            isThinking ? MaxTokens.gemini_thinking : MaxTokens.gemini
        );
        
        messages = this.formatMessagesForGemini(messages);
        const apiVersion = isThinking ? 'v1alpha' : 'v1beta';
        const responseType = streamResponse ? "streamGenerateContent" : "generateContent";
        const streamParam = streamResponse ? "alt=sse&" : "";
        
        return [`https://generativelanguage.googleapis.com/${apiVersion}/models/${model}:${responseType}?${streamParam}key=${apiKey}`, {
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
                    ...(isThinking && {thinking_config: {include_thoughts: true}})  // this param doesn't work anymore, they stopped giving thoughts in response...
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

    createLlamaCppRequest(model, messages, streamResponse, streamWriter) {
        const body = {
            model: "local",
            messages: this.formatMessagesForGrok(messages),
            stream: streamResponse,
            temperature: this.settingsManager.getSetting('temperature')
        };

        return ['http://localhost:8080/v1/chat/completions', {
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
        tokenCounter.update(data.usageMetadata.promptTokenCount, data.usageMetadata.candidatesTokenCount);
        const thoughts = data.candidates[0].content.parts.find(part => part.thought)?.text || '';
        const text = data.candidates[0].content.parts.find(part => !part.thought)?.text || '';
        return this.returnMessage([text], thoughts ? [thoughts] : []);
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
            if (part) message.push({ type: 'text', content: part });
        });
        return message;
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
            case 'llamacpp':
                this.handleLlamaCppStreamData(parsed, tokenCounter, streamWriter);
                break;
            default:
                throw new Error(`Unsupported model provider: ${provider}`);
        }
    }

    handleOpenAIStreamData(parsed, tokenCounter, streamWriter) {
        // Handle the new SSE event types from /v1/responses
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
            // TODO: Potentially handle other events like 'response.reasoning.delta' if needed
            // TODO: Handle 'response.web_search_call.started/completed' etc. if UI feedback is desired
            // TODO: Handle 'response.error' for stream errors
            default:
                // Ignore other event types for now
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
                    // Legacy format support
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
            case 'error':
                throw new Error(`Anthropic stream error: ${parsed.error}`);
        }
    }

    handleGeminiStreamData(parsed, tokenCounter, streamWriter) {
        parsed.candidates?.[0]?.content.parts?.forEach(contentDict => {
            if (contentDict.text) {
                streamWriter.processContent(contentDict.text, !!contentDict.thought);
            }
        });

        if (parsed.usageMetadata && parsed.usageMetadata.promptTokenCount) {
            tokenCounter.update(parsed.usageMetadata.promptTokenCount, parsed.usageMetadata.candidatesTokenCount);
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

    handleLlamaCppStreamData(parsed, tokenCounter, streamWriter) {
        // Handle final chunk with usage info but empty choices
        if (parsed.usage && parsed.choices.length === 0) {
            tokenCounter.update(parsed.usage.prompt_tokens || 0, parsed.usage.completion_tokens || 0);
            if (parsed.timings) {
                console.log(`Llama.cpp performance - Speed: ${parsed.timings.predicted_per_second?.toFixed(1)} tokens/sec`);
            }
            
            // Notify that we can now fetch the model name
            if (streamWriter && streamWriter.onComplete) {
                streamWriter.onComplete();
            }
            return;
        }
        
        // Handle content chunks
        if (parsed.choices?.[0]?.delta) {
            const reasoningContent = parsed.choices[0].delta.reasoning_content;
            const content = parsed.choices[0].delta.content;
            
            // Auto-detect reasoning model and enable thinking UI
            if (reasoningContent && !streamWriter.isThinkingModel) {
                console.log('Detected reasoning model - enabling thinking mode');
                streamWriter.setThinkingModel();
            }
            
            if (reasoningContent) {
                streamWriter.processContent(reasoningContent, true);
            }
            if (content) {
                streamWriter.processContent(content);
            }
        }
    }

    async fetchLlamaCppModelName() {
        try {
            const response = await fetch('http://localhost:8080/v1/models');
            if (response.ok) {
                const data = await response.json();
                const rawName = data.data?.[0]?.id || 'Local Model';
                return this.parseModelName(rawName);
            }
        } catch (error) {
            console.log('Could not fetch llama.cpp model name');
        }
        return 'Local Model';
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
    grok: 2.0
};

const MaxTokens = {
    openai: 16384,
    openai_thinking: 100000,
    anthropic: 32000,   // sonnet-4 is 64k, opus-4 is 32k, older models like original sonnet 3.5 are 8k or less
    anthropic_thinking: 64000,
    gemini: 8192,
    gemini_thinking: 65536,
    deepseek: 8000,
    anthropic_old: 8192,
    grok: 131072
};

// for now decided against of having a "max tokens" for every api, as it varies by model... let the user figure it out :)

const RoleEnum = { system: "system", user: "user", assistant: "assistant" };