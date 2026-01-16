import { sanitizeBase64Image } from './image_utils.js';

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
    anthropic: 32000,
    anthropic_thinking: 64000,
    gemini: 8192,
    gemini_modern: 65536,
    gemini_image: 32768,
    gemini_thinking: 65536,
    deepseek: 8000,
    anthropic_old: 8192,
    grok: 131072,
    kimi: 262144,
    mistral: 32768
};

export const DEFAULT_MODELS = {
    openai: { "gpt-5.2": "GPT-5.2", "gpt-5.2-mini": "GPT-5.2 mini" },
    anthropic: { "claude-4.5-opus": "Claude 4.5 Opus", "claude-sonnet-4-5": "Claude 4.5 Sonnet", "claude-4.5-haiku": "Claude 4.5 Haiku" },
    gemini: { "gemini-3-pro-preview": "Gemini 3 Pro", "gemini-3-flash-preview": "Gemini 3 Flash", "gemini-3-pro-image-preview": "Nano Banana Pro", "gemini-2.5-flash-lite": "Gemini 2.5 Flash Lite", "gemini-2.5-flash-image-preview": "Nano Banana" },
    deepseek: { "deepseek-chat": "DeepSeek V3.2", "deepseek-reasoner": "DeepSeek V3.2 thinking" },
    mistral: { "mistral-large-latest": "Mistral Large", "mistral-small-latest": "Mistral Small" },
    grok: { "grok-4": "Grok 4", "grok-4.1-fast-reasoning": "Grok 4.1 Fast Reasoning" },
    kimi: { "kimi-k2-turbo-preview": "Kimi 2 Turbo", "kimi-k2-thinking-turbo": "Kimi 2 Turbo thinking" },
    llamacpp: { "local-model": "Local Model" }
};

export class BaseProvider {
    constructor() {
        this.maxTemp = 1.0;
        this.maxTokens = 8192;
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
            
            return (last.length === 2 && sldSet.has(secondLast)) 
                ? parts.slice(-3).join('.') 
                : parts.slice(-2).join('.');
        } catch (_) { 
            return url; 
        }
    }

    buildCitationsTail(citations) {
        if (!Array.isArray(citations) || citations.length === 0) return '';
        
        const list = [...new Set(citations)]
            .slice(0, 10)
            .map(u => `[${this.extractBaseDomain(u)}](${u})`)
            .join(' · ');
            
        return `\n\n${list}\n`;
    }

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

export class OpenAIProvider extends BaseProvider {
    constructor() { 
        super(); 
        this.maxTemp = MaxTemp.openai; 
        this.maxTokens = MaxTokens.openai; 
    }

    supports(feature, model) {
        if (feature === 'reasoning') {
            return /o\d/.test(model) || model.includes('gpt-5');
        }
        if (feature === 'web_search') {
            return ['gpt-4.1', 'gpt-5'].some(substring => model.includes(substring)) && !model.includes('nano');
        }
        return super.supports(feature, model);
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

    createRequest({ model, messages, stream, options, apiKey, settings }) {
        const isReasoner = this.supports('reasoning', model);
        const shouldWebSearch = (options.webSearch ?? options.getWebSearch?.() ?? false) && 
                              this.supports('web_search', model);
        const noImage = model.includes('o1-mini') || model.includes('o1-preview') || model.includes('o3-mini');
        const systemMessage = messages.find(message => message.role === RoleEnum.system)?.parts
            ?.map(part => part.content).join('\n');

        if (isReasoner && options.streamWriter) {
            options.streamWriter.addThinkingCounter();
        }

        const body = {
            model,
            input: this.formatMessages(messages, !noImage),
            max_output_tokens: Math.min(settings.max_tokens, isReasoner ? MaxTokens.openai_thinking : this.maxTokens),
            stream
        };

        if (systemMessage) {
            body.instructions = systemMessage;
        }
        
        if (shouldWebSearch) {
            body.tools = [{ type: "web_search_preview" }];
        }
        
        if (isReasoner) {
            body.reasoning = { 
                effort: options.reasoningEffort ?? options.getOpenAIReasoningEffort?.() ?? 'medium' 
            };
        } else {
            body.temperature = Math.min(settings.temperature, this.maxTemp);
        }

        return this.buildApiRequest('https://api.openai.com/v1/responses', body, { 
            'Authorization': `Bearer ${apiKey}` 
        });
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

    handleStream({ parsed, tokenCounter, writer }) {
        if (parsed.type === 'response.output_text.delta' && parsed.delta) {
            writer.processContent(parsed.delta);
        } else if (parsed.type === 'response.completed' && parsed.response?.usage) {
            const usage = parsed.response.usage;
            tokenCounter.update(usage.input_tokens, usage.output_tokens);
        }
    }

    handleResponse({ data, tokenCounter }) {
        const output = data.output || [];
        const messageItem = output.find(item => item.type === 'message');
        const contentParts = messageItem?.content || [];
        const text = contentParts
            .filter(part => part.type === 'output_text')
            .map(part => part.text)
            .join('');
        
        const reasoningItem = output.find(item => item.type === 'reasoning');
        const summary = reasoningItem?.summary;
        
        if (data.usage) {
            tokenCounter.update(data.usage.input_tokens, data.usage.output_tokens);
        }
        
        const thoughts = summary ? (Array.isArray(summary) ? [summary.join('')] : [summary]) : [];
        return this.returnMessage([text], thoughts);
    }
}

export class AnthropicProvider extends BaseProvider {
    constructor() { 
        super(); 
        this.maxTemp = MaxTemp.anthropic; 
        this.maxTokens = MaxTokens.anthropic; 
    }

    supports(feature, model) {
        const thinkingModels = ['3-7-sonnet', 'sonnet-4', 'opus-4'];
        
        if (feature === 'thinking') {
            return thinkingModels.some(substring => model.includes(substring));
        }
        
        if (feature === 'web_search') {
            const webModels = ['3-7-sonnet', '3-5-sonnet-latest', '3-5-haiku-latest', 'sonnet-4', 'opus-4'];
            return webModels.some(substring => model.includes(substring));
        }
        
        return super.supports(feature, model);
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
        const canThink = this.supports('thinking', model);
        const isThinking = canThink && (options.shouldThink ?? options.getShouldThink?.() ?? false);
        const shouldWebSearch = (options.webSearch ?? options.getWebSearch?.() ?? false) && 
                              this.supports('web_search', model);
        
        let maxLimit = this.maxTokens;
        if (model.includes('opus')) {
            maxLimit = MaxTokens.anthropic;
        } else if (!canThink) {
            maxLimit = MaxTokens.anthropic_old;
        } else if (isThinking) {
            maxLimit = MaxTokens.anthropic_thinking;
        }
        
        const maxTokens = Math.min(settings.max_tokens, maxLimit);
        const hasSystem = messages.some(m => m.role === RoleEnum.system);
        const formatted = this.formatMessages(hasSystem ? messages : messages.filter(m => m.role !== RoleEnum.system));
        
        const body = { 
            model, 
            messages: hasSystem ? (formatted.length > 0 ? formatted.slice(1) : []) : formatted, 
            max_tokens: maxTokens, 
            stream 
        };

        if (hasSystem && formatted.length > 0 && formatted[0].content?.[0]) {
            body.system = [formatted[0].content[0]];
        }


        if (isThinking) {
            body.thinking = { 
                type: "enabled", 
                budget_tokens: Math.max(1024, maxTokens - 4000) 
            };
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

        return this.buildApiRequest('https://api.anthropic.com/v1/messages', body, { 
            'x-api-key': apiKey, 
            'anthropic-version': '2023-06-01', 
            'anthropic-dangerous-direct-browser-access': 'true' 
        });
    }

    handleStream({ parsed, tokenCounter, writer }) {
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
            }
        } else if (parsed.type === 'message_start' && parsed.message?.usage) {
            const usage = parsed.message.usage;
            const inputCount = (usage.input_tokens || 0) + 
                             (usage.cache_creation_input_tokens || 0) + 
                             (usage.cache_read_input_tokens || 0);
            tokenCounter.update(inputCount, usage.output_tokens || 0);
        } else if (parsed.type === 'message_delta' && parsed.usage?.output_tokens) {
            tokenCounter.update(0, parsed.usage.output_tokens);
        } else if (parsed.type === 'error') {
            throw new Error(parsed.error?.message || 'Anthropic Error');
        }
    }

    handleResponse({ data, tokenCounter }) {
        const usage = data.usage;
        const thoughts = [];
        const texts = [];
        
        if (usage) {
            const inputCount = usage.input_tokens + 
                             (usage.cache_creation_input_tokens || 0) + 
                             (usage.cache_read_input_tokens || 0);
            tokenCounter.update(inputCount, usage.output_tokens);
        }
        
        (data.content || []).forEach(block => { 
            if (block.type === 'thinking') {
                thoughts.push(block.thinking); 
            } else if (block.type === 'text') {
                texts.push(block.text); 
            }
        });
        
        return this.returnMessage(texts, thoughts);
    }
}

export class GeminiProvider extends BaseProvider {
    constructor() { 
        super(); 
        this.maxTemp = MaxTemp.gemini; 
        this.maxTokens = MaxTokens.gemini; 
    }

    supports(feature, model) {
        if (feature === 'reasoning') {
            return /gemini-[3-9]\.?\d*|gemini-\d{2,}/.test(model) && !model.includes('image');
        }
        if (feature === 'thinking_toggle') {
            return model.includes('gemini-2.5') && model.includes('flash') && !model.includes('image');
        }
        return super.supports(feature, model);
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
                if (part.type === 'image' && part.content) {
                    const entry = { 
                        inline_data: { 
                            mime_type: this.getBase64MediaType(part.content), 
                            data: this.simpleBase64Splitter(part.content) 
                        } 
                    };
                    if (part.thoughtSignature) entry.thoughtSignature = part.thoughtSignature;
                    parts.push(entry);
                } else if (part.type === 'text' || part.thoughtSignature) {
                    const entry = { text: part.content ?? '' };
                    if (part.thoughtSignature) entry.thoughtSignature = part.thoughtSignature;
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
        
        if (isThinking && options.streamWriter) {
            options.streamWriter.setThinkingModel();
        }
        
        const formatted = this.formatMessages(messages);
        const maxTokens = Math.min(
            settings.max_tokens, 
            isThinking ? MaxTokens.gemini_thinking : this.getGeminiMaxTokens(model)
        );

        const generationConfig = { 
            temperature: Math.min(settings.temperature, this.maxTemp), 
            maxOutputTokens: maxTokens, 
            responseMimeType: "text/plain" 
        };

        if (isGemini3) {
            const effort = options.reasoningEffort ?? options.getGeminiThinkingLevel?.() ?? 'medium';
            const isFlash = model.includes('flash');
            const level = isFlash 
                ? (effort === 'xhigh' ? 'high' : effort) 
                : ((effort === 'minimal' || effort === 'low') ? 'low' : 'high');
            generationConfig.thinking_config = { thinkingLevel: level, include_thoughts: true };
        } else if (isThinking) {
            generationConfig.thinking_config = { thinkingBudget: -1, include_thoughts: true };
        }
        
        const baseUrl = 'https://generativelanguage.googleapis.com/v1beta/models/';
        const endpoint = stream ? "streamGenerateContent?alt=sse&" : "generateContent?";
        const url = `${baseUrl}${model}:${endpoint}key=${apiKey}`;

        const body = { 
            contents: formatted.slice(1), 
            systemInstruction: formatted[0], 
            safetySettings: [
                { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" }, 
                { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" }, 
                { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" }, 
                { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
            ], 
            generationConfig: generationConfig 
        };

        return this.buildApiRequest(url, body);
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

        const body = { 
            contents: formatted.slice(1), 
            systemInstruction: formatted[0], 
            safetySettings: [
                { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" }, 
                { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" }, 
                { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" }, 
                { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
            ], 
            generationConfig: { 
                temperature: Math.min(settings.temperature, this.maxTemp), 
                maxOutputTokens: Math.min(settings.max_tokens, this.getGeminiMaxTokens(model)), 
                ...(Object.keys(imageConfig).length && { imageConfig }) 
            } 
        };

        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
        return this.buildApiRequest(url, body);
    }

    handleStream({ parsed, tokenCounter, writer }) {
        const parts = parsed.candidates?.[0]?.content?.parts;
        if (parts) {
            parts.forEach(part => { 
                if (part.text !== undefined) {
                    writer.processContent(part.text, !!part.thought); 
                }
                if (part.thoughtSignature && writer?.parts?.length) {
                    writer.parts.at(-1).thoughtSignature = part.thoughtSignature; 
                }
            });
        }
        const usage = parsed.usageMetadata;
        if (usage?.promptTokenCount) {
            tokenCounter.update(usage.promptTokenCount, (usage.candidatesTokenCount || 0) + (usage.thoughtsTokenCount || 0));
        }
    }

    handleResponse({ data, tokenCounter }) {
        const usage = data.usageMetadata || {};
        tokenCounter.update(usage.promptTokenCount || 0, (usage.candidatesTokenCount || 0) + (usage.thoughtsTokenCount || 0));
        
        const parts = data.candidates?.[0]?.content?.parts || [];
        const messageParts = [];
        
        parts.forEach(part => {
            if (part.text !== undefined) { 
                const entry = { type: part.thought ? 'thought' : 'text', content: part.text || '' }; 
                if (part.thoughtSignature) entry.thoughtSignature = part.thoughtSignature; 
                messageParts.push(entry); 
            } else if (part.inlineData?.data) { 
                const mimeType = part.inlineData.mimeType || 'image/png';
                const base64 = sanitizeBase64Image(part.inlineData.data, mimeType); 
                const entry = { type: 'image', content: `data:${mimeType};base64,${base64}` }; 
                if (part.thoughtSignature) entry.thoughtSignature = part.thoughtSignature; 
                messageParts.push(entry); 
            }
        });
        
        return messageParts.length ? messageParts : this.returnMessage(['']);
    }
}

export class DeepSeekProvider extends BaseProvider {
    constructor() { 
        super(); 
        this.maxTemp = MaxTemp.deepseek; 
        this.maxTokens = MaxTokens.deepseek; 
    }

    formatMessages(messages) { 
        return messages.map(message => ({ 
            role: message.role, 
            content: this.extractTextContent(message) 
        })); 
    }

    createRequest({ model, messages, stream, settings, apiKey, options }) {
        if (model.includes('reasoner') && options.streamWriter) {
            options.streamWriter.setThinkingModel();
        }

        const body = { 
            model, 
            messages: this.formatMessages(messages), 
            max_tokens: Math.min(settings.max_tokens, this.maxTokens), 
            stream 
        };

        if (!model.includes('reasoner')) {
            body.temperature = Math.min(settings.temperature, this.maxTemp);
        }
        
        if (stream) {
            body.stream_options = { include_usage: true };
        }

        return this.buildApiRequest('https://api.deepseek.com/v1/chat/completions', body, { 
            'Authorization': `Bearer ${apiKey}` 
        });
    }

    handleStream({ parsed, tokenCounter, writer }) {
        if (parsed.usage && parsed.choices?.[0]?.delta?.content === "") { 
            tokenCounter.update(parsed.usage.prompt_tokens, parsed.usage.completion_tokens); 
            return; 
        }

        const choice = parsed.choices?.[0];
        const delta = choice?.delta;
        if (delta?.reasoning_content) {
            writer.processContent(delta.reasoning_content, true);
        }
        if (delta?.content) {
            writer.processContent(delta.content);
        }
    }

    handleResponse({ data, tokenCounter }) {
        if (data.usage) {
            tokenCounter.update(data.usage.prompt_tokens, data.usage.completion_tokens);
        }
        const message = data.choices[0].message;
        const thoughts = message.reasoning_content ? [message.reasoning_content] : [];
        return this.returnMessage([message.content], thoughts);
    }
}

export class GrokProvider extends BaseProvider {
    constructor() {
        super();
        this.maxTemp = MaxTemp.grok;
        this.maxTokens = MaxTokens.grok;
    }

    supports(feature, model) {
        if (feature === 'web_search') {
            return model?.includes('grok-4');
        }
        return super.supports(feature, model);
    }

    formatMessages(messages) {
        return messages.map(msg => {
            const text = this.extractTextContent(msg);
            if (msg.images) { 
                const content = [{ type: 'text', text }]; 
                msg.images.forEach(img => {
                    content.push({ type: 'image_url', image_url: { url: img } }); 
                });
                return { role: msg.role, content }; 
            }
            return { role: msg.role, content: text };
        });
    }

    createRequest({ model, messages, stream, settings, apiKey, options }) {
        if (model.includes('grok-4') && !model.includes('non-reasoning') && options.streamWriter) {
            options.streamWriter.addThinkingCounter();
        }

        const body = { 
            model, 
            messages: this.formatMessages(messages), 
            max_tokens: Math.min(settings.max_tokens, this.maxTokens), 
            temperature: Math.min(settings.temperature, this.maxTemp), 
            stream 
        };

        if (stream) {
            body.stream_options = { include_usage: true };
        }

        const shouldSearch = (options.webSearch ?? options.getWebSearch?.() ?? false);
        if (model.includes('grok-4') && shouldSearch) {
            body.search_parameters = { mode: "auto" };
        }

        return this.buildApiRequest('https://api.x.ai/v1/chat/completions', body, { 
            'Authorization': `Bearer ${apiKey}` 
        });
    }

    handleStream({ parsed, tokenCounter, writer }) {
        if (parsed.usage && (!parsed.choices || !parsed.choices.length)) { 
            const completion = (parsed.usage.completion_tokens || 0) + 
                             (parsed.usage.completion_tokens_details?.reasoning_tokens || 0);
            tokenCounter.update(parsed.usage.prompt_tokens, completion); 
            
            if (parsed.citations?.length) {
                writer.processContent(this.buildCitationsTail(parsed.citations)); 
            }
            return; 
        }

        const d = parsed.choices?.[0]?.delta;
        if (d?.reasoning_content) {
            writer.processContent(d.reasoning_content, true);
        }
        if (d?.content) {
            writer.processContent(d.content);
        }
    }

    handleResponse({ data, tokenCounter }) {
        tokenCounter.update(data.usage.prompt_tokens, data.usage.completion_tokens);
        const m = data.choices[0].message; 
        let c = m.content;
        
        if (data.citations?.length) {
            c += this.buildCitationsTail(data.citations);
        }
        
        const thoughts = m.reasoning_content ? [m.reasoning_content] : [];
        return this.returnMessage([c], thoughts);
    }
}

export class KimiProvider extends BaseProvider {
    constructor() { 
        super(); 
        this.maxTemp = MaxTemp.kimi; 
        this.maxTokens = MaxTokens.kimi; 
    }

    formatMessages(messages) { 
        return messages.map(msg => ({ 
            role: msg.role, 
            content: this.extractTextContent(msg) 
        })); 
    }

    createRequest({ model, messages, stream, settings, apiKey, options }) {
        if (model.includes('thinking') && options.streamWriter) {
            options.streamWriter.setThinkingModel();
        }

        const body = { 
            model, 
            messages: this.formatMessages(messages), 
            max_tokens: Math.min(settings.max_tokens, this.maxTokens), 
            temperature: Math.min(settings.temperature, this.maxTemp), 
            stream 
        };

        if (stream) {
            body.stream_options = { include_usage: true };
        }

        return this.buildApiRequest('https://api.moonshot.ai/v1/chat/completions', body, { 
            'Authorization': `Bearer ${apiKey}` 
        });
    }

    handleStream({ parsed, tokenCounter, writer }) {
        // Only update tokens when usage exists AND choices is empty (final message)
        if (parsed.usage && (!parsed.choices || parsed.choices.length === 0)) {
            tokenCounter.update(parsed.usage.prompt_tokens, parsed.usage.completion_tokens);
            return;
        }

        const d = parsed.choices?.[0]?.delta;
        if (d?.reasoning_content) writer.processContent(d.reasoning_content, true);
        if (d?.content) writer.processContent(d.content);
    }

    handleResponse({ data, tokenCounter }) { 
        tokenCounter.update(data.usage.prompt_tokens, data.usage.completion_tokens); 
        const m = data.choices[0].message; 
        const thoughts = m.reasoning_content ? [m.reasoning_content] : [];
        return this.returnMessage([m.content], thoughts); 
    }
}

export class MistralProvider extends BaseProvider {
    constructor() { 
        super(); 
        this.maxTemp = MaxTemp.mistral; 
        this.maxTokens = MaxTokens.mistral; 
    }

    formatMessages(messages) { 
        return messages.map(message => ({ 
            role: message.role, 
            content: this.extractTextContent(message) 
        })); 
    }

    createRequest({ model, messages, stream, settings, apiKey }) { 
        const body = { 
            model, 
            messages: this.formatMessages(messages), 
            max_tokens: Math.min(settings.max_tokens, this.maxTokens), 
            temperature: Math.min(settings.temperature, this.maxTemp), 
            stream 
        };
        return this.buildApiRequest('https://api.mistral.ai/v1/chat/completions', body, { 
            'Authorization': `Bearer ${apiKey}` 
        }); 
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

    handleStream({ parsed, tokenCounter, writer }) {
        const deltaData = parsed.data ?? parsed; 
        if (deltaData.usage && !writer._mistralUsageUpdated) { 
            tokenCounter.update(deltaData.usage.prompt_tokens, deltaData.usage.completion_tokens); 
            writer._mistralUsageUpdated = true; 
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
                    chunk.thinking.forEach(thought => {
                        if (thought.text) {
                            writer.processContent(thought.text, true);
                        }
                    });
                }
            }); 
        }
    }

    handleResponse({ data, tokenCounter }) { 
        if (data.usage) {
            tokenCounter.update(data.usage.prompt_tokens, data.usage.completion_tokens); 
        }
        
        const choice = data.choices?.[0];
        const content = choice?.message?.content;
        const texts = [];
        const thoughts = []; 
        
        if (typeof content === 'string') {
            texts.push(content); 
        } else if (Array.isArray(content)) {
            content.forEach(item => { 
                if (item.type === 'text') {
                    texts.push(item.text); 
                } else if (item.type === 'thinking') {
                    item.thinking.forEach(thought => thoughts.push(thought.text)); 
                }
            }); 
        }
        return this.returnMessage(texts.length ? texts : [''], thoughts); 
    }
}

export class LlamaCppProvider extends BaseProvider {
    createRequest({ model, messages, stream, settings, options }) { 
        const { raw, port } = options.localModelOverride || { raw: model, port: 8080 }; 
        const body = { 
            model: raw, 
            messages: new GrokProvider().formatMessages(messages), 
            stream, 
            temperature: settings.temperature 
        };
        return this.buildApiRequest(`http://localhost:${port}/v1/chat/completions`, body); 
    }

    handleStream({ parsed, tokenCounter, writer }) {
        // Only complete when usage exists AND choices is empty (final message)
        if (parsed.usage && (!parsed.choices || parsed.choices.length === 0)) {
            tokenCounter.update(parsed.usage.prompt_tokens, parsed.usage.completion_tokens);
            if (parsed.timings) {
                console.log(`Llama.cpp performance - Speed: ${parsed.timings.predicted_per_second?.toFixed(1)} tokens/sec`);
            }
            if (writer?.onComplete) {
                writer.onComplete();
            }
            return;
        }

        const choice = parsed.choices?.[0];
        const data = choice?.delta || choice?.message;

        if (data?.reasoning_content) {
            if (writer && !writer.isThinkingModel) {
                writer.setThinkingModel();
            }
            writer.processContent(data.reasoning_content, true);
        }

        if (data?.content) {
            writer.processContent(data.content);
        }
    }

    handleResponse({ data, tokenCounter }) { 
        if (data.usage) {
            tokenCounter.update(data.usage.prompt_tokens, data.usage.completion_tokens); 
        }
        const message = data.choices[0].message; 
        const thoughts = message.reasoning_content ? [message.reasoning_content] : [];
        return this.returnMessage([message.content], thoughts); 
    }
}

export const Providers = { openai: new OpenAIProvider(), anthropic: new AnthropicProvider(), gemini: new GeminiProvider(), deepseek: new DeepSeekProvider(), grok: new GrokProvider(), kimi: new KimiProvider(), mistral: new MistralProvider(), llamacpp: new LlamaCppProvider() };
