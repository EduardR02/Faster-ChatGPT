import { SettingsManager } from './state_manager.js';


export class ApiManager {
    constructor() {
        this.settingsManager = new SettingsManager(['api_keys', 'max_tokens', 'temperature', 'models', 'current_model']);
    }

    getCurrentModel() {
        return this.settingsManager.getSetting('current_model');
    }

    async callApi(model, messages, tokenCounter, streamWriter = null, abortController = null) {
        const provider = this.getProviderForModel(model);
        const apiKeys = this.settingsManager.getSetting('api_keys') || {};
        
        if (!apiKeys[provider]?.trim()) {
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
                return this.createAnthropicRequest(model, messages, streamResponse, apiKeys.anthropic);
            case 'gemini':
                return this.createGeminiRequest(model, messages, streamResponse, streamWriter, apiKeys.gemini);
            case 'deepseek':
                return this.createDeepseekRequest(model, messages, streamResponse, streamWriter, apiKeys.deepseek);
            default:
                throw new Error(`Unsupported model provider: ${provider}`);
        }
    }

    getProviderForModel(model) {
        const models = this.settingsManager.getSetting('models') || {};
        for (const [provider, providerModels] of Object.entries(models)) {
            if (model in providerModels) return provider;
        }
        return null;
    }

    formatMessagesForOpenAI(messages, addImages, hasSystemRole) {
        return messages.map(msg => {
            const role = msg.role === RoleEnum.system ? hasSystemRole ? "developer" : RoleEnum.user : msg.role;
            if (addImages && msg.role === RoleEnum.user && msg.images) {
                const imgDict = msg.images.map(img => ({ type: 'image_url', image_url: { url: img } }));
                return { role: role, content: [{ type: 'text', text: msg.content }, ...imgDict] };
            }
            return { role: role, content: msg.content };
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

    getBase64MediaType(base64String) {
        return base64String.split(':')[1].split(';')[0];
    }

    simpleBase64Splitter(base64String) {
        return base64String.split('base64,')[1];
    }

    createOpenAIRequest(model, messages, streamResponse, streamWriter, apiKey) {
        const o1 = model.includes('o1');
        const o3 = model.includes('o3');
        const noImage = model.includes('o1-mini') || model.includes('o1-preview') || o3;
        const isReasoner = o1 || o3;
        messages = this.formatMessagesForOpenAI(messages, !noImage, !o1);
        if (isReasoner && streamWriter) streamWriter.addThinkingCounter();

        return ['https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            credentials: 'omit',
            headers: {'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}`},
            body: JSON.stringify({
                model,
                messages,
                ...(o3 && { reasoning_effort: this.settingsManager.getSetting('reasoning_effort') || 'medium' }),
                ...(isReasoner ? {max_completion_tokens: this.settingsManager.getSetting('max_tokens')} : {
                    max_tokens: this.settingsManager.getSetting('max_tokens'),
                    temperature: Math.min(this.settingsManager.getSetting('temperature'), MaxTemp.openai)
                }),
                stream: streamResponse,
                ...(streamResponse && {stream_options: {include_usage: true}})
            })
        }];
    }

    createAnthropicRequest(model, messages, streamResponse, apiKey) {
        messages = this.formatMessagesForAnthropic(messages);
        return ['https://api.anthropic.com/v1/messages', {
            method: 'POST',
            credentials: 'omit',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01',
                'anthropic-dangerous-direct-browser-access': 'true'
            },
            body: JSON.stringify({
                model,
                system: [messages[0].content[0]],
                messages: messages.slice(1),
                max_tokens: this.settingsManager.getSetting('max_tokens'),
                temperature: Math.min(this.settingsManager.getSetting('temperature'), MaxTemp.anthropic),
                stream: streamResponse
            })
        }];
    }

    createDeepseekRequest(model, messages, streamResponse, streamWriter, apiKey) {
        const isReasoner = model.includes('reasoner');
        if (isReasoner && streamWriter) streamWriter.setThinkingModel();
        
        return ['https://api.deepseek.com/v1/chat/completions', {
            method: 'POST',
            credentials: 'omit',
            headers: {'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}`},
            body: JSON.stringify({
                model,
                messages: this.formatMessagesForDeepseek(messages),
                max_tokens: this.settingsManager.getSetting('max_tokens'),
                ...(!isReasoner && {temperature: Math.min(this.settingsManager.getSetting('temperature'), MaxTemp.deepseek)}),
                stream: streamResponse,
                ...(streamResponse && {stream_options: {include_usage: true}})
            })
        }];
    }

    createGeminiRequest(model, messages, streamResponse, streamWriter, apiKey) {
        const isThinking = model.includes('thinking');
        if (isThinking) {
            messages = messages.map(({role, content}) => ({role, content}));
            if (streamWriter) streamWriter.setThinkingModel();
        }
        
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
                    maxOutputTokens: this.settingsManager.getSetting('max_tokens'),
                    responseMimeType: "text/plain",
                    ...(isThinking && {thinking_config: {include_thoughts: true}})
                }
            })
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
            default:
                throw new Error(`Unsupported model provider: ${provider}`);
        }
    }

    handleOpenAINonStreamResponse(data, tokenCounter) {
        tokenCounter.update(data.usage.prompt_tokens, data.usage.completion_tokens);
        return this.returnMessage([data.choices[0].message.content]);
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

    returnMessage(parts, thoughts = []) {
        message = [];
        thoughts.forEach(thought => {
            message.push({ type: 'thought', content: thought });
        });
        parts.forEach(part => {
            message.push({ type: 'text', content: part });
        });
        return message;
    }

    processStreamData(data, model, tokenCounter, streamWriter) {
        const provider = this.getProviderForModel(model);
        const parsed = JSON.parse(data);

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
            default:
                throw new Error(`Unsupported model provider: ${provider}`);
        }
    }

    handleOpenAIStreamData(parsed, tokenCounter, streamWriter) {
        if (parsed.choices && parsed.choices.length > 0) {
            const content = parsed.choices[0].delta.content;
            if (content) {
                streamWriter.processContent(content);
            }
        } else if (parsed.usage && parsed.usage.prompt_tokens) {
            tokenCounter.update(parsed.usage.prompt_tokens, parsed.usage.completion_tokens);
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
                    // First time we see a thinking delta, set up the thinking UI
                    if (!streamWriter.isThinkingModel) {
                        streamWriter.setThinkingModel();
                    }
                    
                    const thinking = parsed.delta.thinking;
                    if (thinking) {
                        streamWriter.processContent(thinking, true);
                    }
                } else if (parsed.delta.text) {
                    // Legacy format support
                    streamWriter.processContent(parsed.delta.text);
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
}


const MaxTemp = {
    openai: 2.0,
    anthropic: 1.0,
    gemini: 2.0,
    deepseek: 2.0
};

const RoleEnum = { system: "system", user: "user", assistant: "assistant" };