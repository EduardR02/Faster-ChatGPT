export class ApiManager {
    constructor() {
        this.settings = {};
        this.initSettingsAndListener();
    }

    async initSettingsAndListener() {
        const storageData = await chrome.storage.local.get(['api_keys', 'max_tokens', 'temperature', 'models', 'current_model']);
        this.settings = {
            api_keys: storageData.api_keys || {},
            max_tokens: storageData.max_tokens || 2000,
            temperature: storageData.temperature || 0.7,
            models: storageData.models || {},
            current_model: storageData.current_model
        };

        if (Object.keys(this.settings.api_keys).length === 0) {
            throw new Error("No API keys found in storage. Please add your API keys in the extension options.");
        }

        chrome.storage.onChanged.addListener((changes, namespace) => {
            if (namespace !== "local") return;
            for (let [key, { newValue }] of Object.entries(changes)) {
                if (key in this.settings) {
                    this.settings[key] = newValue;
                }
            }
        });
    }

    getCurrentModel() {
        return this.settings.current_model;
    }

    async callApi(model, messages, tokenCounter, streamWriter = null) {
        const provider = this.getProviderForModel(model);
        if (!this.settings.api_keys[provider] || this.settings.api_keys[provider] === "") {
            throw new Error(`${provider} API key is empty, switch to another model or enter a key in the settings.`);
        }

        const streamResponse = streamWriter !== null;
        const [apiLink, requestOptions] = this.createApiRequest(model, messages, streamResponse);
        if (!apiLink || !requestOptions) {
            throw new Error("Invalid API request configuration.");
        }

        try {
            const response = await fetch(apiLink, requestOptions);
            if (!response.ok) {
                throw new Error(`API request failed with status ${response.status}`);
            }

            if (streamResponse) {
                return this.handleStreamResponse(response, model, tokenCounter, streamWriter);
            } else {
                return this.handleNonStreamResponse(response, model, tokenCounter);
            }
        } catch (error) {
            throw new Error(`API request error: ${error.message}`);
        }
    }

    createApiRequest(model, messages, streamResponse) {
        const provider = this.getProviderForModel(model);
        switch (provider) {
            case 'openai':
                return this.createOpenAIRequest(model, messages, streamResponse);
            case 'anthropic':
                return this.createAnthropicRequest(model, messages, streamResponse);
            case 'gemini':
                return this.createGeminiRequest(model, messages, streamResponse);
            case 'deepseek':
                return this.createDeepseekRequest(model, messages, streamResponse);
            default:
                throw new Error(`Unsupported model provider: ${provider}`);
        }
    }

    getProviderForModel(model) {
        for (const [provider, models] of Object.entries(this.settings.models)) {
            if (model in models) return provider;
        }
        return null;
    }

    formatMessagesForOpenAI(messages) {
        return messages.map(msg => {
            const role = msg.role === RoleEnum.system ? "developer" : msg.role;
            if (msg.role === RoleEnum.user && msg.images) {
                const imgDict = msg.images.map(img => ({ type: 'image_url', image_url: { url: img } }));
                return { role: role, content: [{ type: 'text', text: msg.content }, ...imgDict] };
            }
            return { role: role, content: msg.content };
        });
    }

    formatMessagesForAnthropic(messages) {
        return messages.map(msg => {
            if (msg.role === RoleEnum.user && msg.images) {
                const imgDict = msg.images.map(img => ({
                    type: 'image',
                    source: { type: 'base64', media_type: this.getBase64MediaType(img), data: this.simpleBase64Splitter(img) }
                }));
                return { role: msg.role, content: [{ type: 'text', text: msg.content }, ...imgDict] };
            }
            return { role: msg.role, content: msg.content };
        });
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

    createOpenAIRequest(model, messages, streamResponse) {
        messages = this.formatMessagesForOpenAI(messages);
        if (model.includes('o1')) {
            return this.createOpenAIThinkingRequest(model, messages);
        }
        const requestOptions = {
            method: 'POST',
            credentials: 'omit',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.settings.api_keys.openai}`
            },
            body: JSON.stringify({
                model: model,
                messages: messages,
                max_tokens: this.settings.max_tokens,
                temperature: Math.min(this.settings.temperature, MaxTemp.openai),
                stream: streamResponse,
                ...(streamResponse && {
                    stream_options: { include_usage: true }
                })
            })
        };
        return ['https://api.openai.com/v1/chat/completions', requestOptions];
    }

    createOpenAIThinkingRequest(model, messages, streamResponse) {
        if (messages?.[0]?.role === "developer") {
            // o1 type models currently don't support system prompts, so we have to just change it to user
            messages[0].role = RoleEnum.user;
        }
        const requestOptions = {
            method: 'POST',
            credentials: 'omit',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + this.settings.api_keys.openai
            },
            body: JSON.stringify({
                model: model,
                messages: messages,
                max_completion_tokens: this.settings.max_tokens,
                stream: streamResponse,
                ...(streamResponse && {
                    stream_options: { include_usage: true }
                })
            })
        };
        return ['https://api.openai.com/v1/chat/completions', requestOptions];
    }

    createAnthropicRequest(model, messages, streamResponse) {
        messages = this.formatMessagesForAnthropic(messages);
        const requestOptions = {
            method: 'POST',
            credentials: 'omit',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': this.settings.api_keys.anthropic,
                'anthropic-version': '2023-06-01',
                'anthropic-dangerous-direct-browser-access': 'true'
            },
            body: JSON.stringify({
                model: model,
                system: messages[0].content,
                messages: messages.slice(1),
                max_tokens: this.settings.max_tokens,
                temperature: Math.min(this.settings.temperature, MaxTemp.anthropic),
                stream: streamResponse
            })
        };
        return ['https://api.anthropic.com/v1/messages', requestOptions];
    }

    createDeepseekRequest(model, messages, streamResponse) {
        messages = this.formatMessagesForDeepseek(messages);
        const requestOptions = {
            method: 'POST',
            credentials: 'omit',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.settings.api_keys.deepseek}`
            },
            body: JSON.stringify({
                model: model,
                messages: messages,
                max_tokens: this.settings.max_tokens,
                temperature: Math.min(this.settings.temperature, MaxTemp.deepseek),
                stream: streamResponse,
                ...(streamResponse && {
                    stream_options: { include_usage: true }
                })
            })
        };
        return ['https://api.deepseek.com/v1/chat/completions', requestOptions];
    }

    createGeminiRequest(model, messages, streamResponse) {
        // Filter out images if it's a thinking model
        if (model.includes('thinking')) {
            messages = messages.map(msg => ({
                role: msg.role,
                content: msg.content
            }));
        }
        
        messages = this.formatMessagesForGemini(messages);
        
        const requestOptions = {
            method: 'POST',
            credentials: 'omit',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: messages.slice(1),
                systemInstruction: messages[0],
                safetySettings: this.getGeminiSafetySettings(),
                generationConfig: {
                    temperature: Math.min(this.settings.temperature, MaxTemp.gemini),
                    maxOutputTokens: this.settings.max_tokens,
                    responseMimeType: "text/plain"
                },
            })
        };
    
        const apiVersion = model.includes('thinking') ? 'v1alpha' : 'v1beta';
        const responseType = streamResponse ? "streamGenerateContent" : "generateContent";
        const streamParam = streamResponse ? "alt=sse&" : "";
        const requestLink = `https://generativelanguage.googleapis.com/${apiVersion}/models/${model}:${responseType}?${streamParam}key=${this.settings.api_keys.gemini}`;
        
        return [requestLink, requestOptions];
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
        return data.choices[0].message.content;
    }

    handleAnthropicNonStreamResponse(data, tokenCounter) {
        tokenCounter.update(data.usage.input_tokens, data.usage.output_tokens);
        return data.content[0].text;
    }

    handleGeminiNonStreamResponse(data, tokenCounter) {
        tokenCounter.update(data.usageMetadata.promptTokenCount, data.usageMetadata.candidatesTokenCount);
        return {
            thoughts: data.candidates[0].content.parts.find(part => part.thought)?.text || '',
            text: data.candidates[0].content.parts.find(part => !part.thought)?.text || ''
        };
    }

    handleDeepseekNonStreamResponse(data, tokenCounter) {
        tokenCounter.update(data.usage.prompt_tokens, data.usage.completion_tokens);
        return data.choices[0].message.content;
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
                const content = parsed.delta.text;
                if (content) {
                    streamWriter.processContent(content);
                }
                break;
            case 'message_start':
                if (parsed.message && parsed.message.usage && parsed.message.usage.input_tokens) {
                    tokenCounter.update(parsed.message.usage.input_tokens, parsed.message.usage.output_tokens);
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
        if (parsed.candidates && parsed.candidates.length > 0) {
            parsed.candidates[0].content.parts.forEach(part => {
                if (part.text) {
                    streamWriter.processContent(part.text, !!part.thought);
                    if (part.thought) {
                        streamWriter.processContent('\n\n', true);
                    }
                }
            });
        }
        
        if (parsed.usageMetadata && parsed.usageMetadata.promptTokenCount) {
            tokenCounter.update(parsed.usageMetadata.promptTokenCount, parsed.usageMetadata.candidatesTokenCount);
        }
    }

    handleDeepseekStreamData(parsed, tokenCounter, streamWriter) {
        if (parsed?.usage && parsed?.choices?.[0]?.delta?.content === "") {
            tokenCounter.update(parsed.usage.prompt_tokens, parsed.usage.completion_tokens);
            return;
        }
        const content = parsed?.choices?.[0]?.delta?.content;
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