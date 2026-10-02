import { canonicalJSON, reasoningDigest, coherentPayload, captureOpenAIStream } from './reasoning_state.js';
import { sanitizeBase64Image } from './image_utils.js';

// The original history is request-local; credentials and history copies never enter capsules.
const requests = new WeakMap();
const textOf = parts => (parts || []).filter(part => part.type === 'text').map(part =>
    Array.isArray(part.content) ? part.content.join('') : part.content || '').join('');
const messageText = content => typeof content === 'string' ? content : (content || [])
    .filter(part => ['text', 'output_text'].includes(part.type)).map(part => part.text || '').join('');
const inlineData = part => part.inlineData || part.inline_data;
const imageURL = data => {
    const mime = data.mimeType || data.mime_type || 'image/png';
    return `data:${mime};base64,${sanitizeBase64Image(data.data, mime)}`;
};

export function grokCitations(data) {
    const urls = new Set((data?.citations || []).filter(url => typeof url === 'string'));
    for (const item of data?.output || []) {
        for (const part of item?.content || []) {
            for (const annotation of part?.annotations || []) {
                const url = annotation?.url || annotation?.url_citation?.url;
                if (typeof url === 'string') urls.add(url);
            }
        }
    }
    return [...urls];
}

export function rememberNativeRequest(owner, provider, request, messages) {
    requests.set(request[1], { owner, provider, messages });
    return request;
}

function coherent(provider, payload) {
    if (provider === 'grok') return coherentPayload('openai', payload);
    if (provider === 'gemini') return Array.isArray(payload) && payload.length > 0 &&
        Array.from(payload).every(part => part && typeof part === 'object' && !Array.isArray(part) &&
            Object.keys(part).length > 0);
    if (!payload || payload.role !== 'assistant') return false;
    if (provider === 'mistral') return typeof payload.content === 'string' ||
        Array.isArray(payload.content) && Array.from(payload.content).every(part =>
            part?.type === 'text' && typeof part.text === 'string' ||
            part?.type === 'thinking' && Array.isArray(part.thinking) &&
                part.thinking.every(inner =>
                    inner?.type === 'text' && typeof inner.text === 'string' ||
                    inner?.type === 'reference' && Array.isArray(inner.reference_ids) &&
                        inner.reference_ids.every(id => typeof id === 'string' || Number.isInteger(id)) ||
                    inner?.type === 'tool_reference' && typeof inner.tool === 'string' && typeof inner.title === 'string'));
    return (payload.content == null || typeof payload.content === 'string' || Array.isArray(payload.content)) &&
        typeof payload.reasoning_content === 'string';
}

function candidate(message, provider, owner) {
    const saved = message.role === 'assistant' ? message.parts?.[0]?.providerState : null;
    if (!saved || saved.version !== 1 || saved.provider !== provider || saved.replayable === false ||
        typeof saved.model !== 'string' || typeof saved.scope !== 'string' || typeof saved.prefix !== 'string') return null;
    const payload = provider === 'gemini' ? saved.parts : provider === 'grok' ? saved.output : saved.message;
    if (!coherent(provider, payload)) return null;
    let original;
    let images = [];
    if (provider === 'gemini') {
        original = payload.filter(part => !part.thought).map(part => part.text || '').join('');
        images = payload.filter(part => !part.thought && inlineData(part)?.data).map(part => imageURL(inlineData(part)));
    } else if (provider === 'grok') {
        original = payload.filter(item => item.type === 'message').map(item => messageText(item.content)).join('') +
            owner.buildCitationsTail(saved.citations || []);
    } else {
        original = messageText(payload.content);
        if (Array.isArray(payload.content)) images = payload.content.filter(part => part.type === 'image_url')
            .map(part => part.image_url?.url);
    }
    const displayedImages = [...(message.parts || []).filter(part => part.type === 'image' && !part.thought)
        .map(part => Array.isArray(part.content) ? part.content.join('') : part.content), ...(message.images || [])];
    return textOf(message.parts) === original && canonicalJSON(displayedImages) === canonicalJSON(images) ? saved : null;
}

export async function prepareProviderNativeRequest(provider, { model, requestOptions, reasoningScope }) {
    const context = requests.get(requestOptions);
    requests.delete(requestOptions);
    const body = JSON.parse(requestOptions.body);
    const key = provider === 'gemini' ? 'contents' : provider === 'grok' ? 'input' : 'messages';
    const initial = provider === 'gemini' ? { system: body.systemInstruction ?? null, tools: body.tools ?? [] }
        : { instructions: body.instructions ?? null, tools: body.tools ?? [] };
    let prefix = await reasoningDigest(canonicalJSON(initial));
    const replay = [];
    for (let index = 0; index < body[key].length; index++) {
        const message = body[key][index];
        const saved = context?.provider === provider && candidate(context.messages[index], provider, context.owner);
        const compatible = saved && reasoningScope && saved.scope === reasoningScope && saved.model === model && saved.prefix === prefix;
        const submitted = compatible ? provider === 'grok' ? saved.output :
            [provider === 'gemini' ? { role: 'model', parts: saved.parts } : saved.message] : [message];
        replay.push(...submitted);
        for (const item of submitted) prefix = await reasoningDigest(`${prefix}\n${canonicalJSON(item)}`);
    }
    body[key] = replay;
    requestOptions.body = JSON.stringify(body);
    return { version: 1, provider, model, scope: reasoningScope, prefix, completed: false, valid: true,
        payload: provider === 'gemini' || provider === 'grok' ? [] : { role: 'assistant', content: '' } };
}

export function finalizeProviderNativeState(state) {
    // New K3 captures must never masquerade as provenance-free legacy thoughts.
    if (state?.provider === 'kimi' && (!state.scope || !state.completed || !state.valid ||
        !coherent(state.provider, state.payload))) {
        return { version: 1, provider: state.provider, model: state.model, scope: state.scope,
            prefix: state.prefix, replayable: false, message: state.payload };
    }
    if (!state?.scope || !state.completed || !state.valid || !coherent(state.provider, state.payload)) return null;
    const payload = state.payload;
    const native = state.provider === 'gemini' ? payload.some(part => typeof part.thoughtSignature === 'string' && part.thoughtSignature.length)
        : state.provider === 'grok' ? payload.some(item => typeof item.encrypted_content === 'string' && item.encrypted_content.length)
        : state.provider === 'mistral' ? Array.isArray(payload.content) && payload.content.some(part => part.type === 'thinking')
        : typeof payload.reasoning_content === 'string' && payload.reasoning_content.length > 0;
    if (!native) return null;
    const saved = { version: 1, provider: state.provider, model: state.model, scope: state.scope,
        prefix: state.prefix, replayable: true };
    if (state.provider === 'gemini') saved.parts = payload;
    else if (state.provider === 'grok') {
        saved.output = payload;
        if (state.citations?.length) saved.citations = state.citations;
    } else saved.message = payload;
    return saved;
}

export function captureGemini(parsed, state, streaming = true) {
    if (parsed.error) {
        if (state) state.valid = false;
        throw new Error(parsed.error.message || 'Gemini response failed');
    }
    if (!state) return;
    const candidate = parsed.candidates?.[0];
    const parts = candidate?.content?.parts;
    if (parts) {
        if (!Array.isArray(parts)) state.valid = false;
        else if (streaming) state.payload.push(...parts);
        else state.payload = parts;
    }
    if (candidate?.finishReason) {
        state.completed = candidate.finishReason === 'STOP';
        if (!state.completed) state.valid = false;
    }
    if (parsed.error || parsed.promptFeedback?.blockReason) state.valid = false;
}

// Mistral streams deltas for one chunk until the thinking/text transition. Preserve all
// supplied inner chunks and metadata; only append text to an otherwise identical delta.
function appendChunk(chunks, chunk, continuation = true) {
    const last = chunks.at(-1);
    if (continuation && chunk.type === 'text' && last?.type === 'text' &&
        canonicalJSON({ ...last, text: '' }) === canonicalJSON({ ...chunk, text: '' })) last.text += chunk.text || '';
    else if (continuation && chunk.type === 'thinking' && last?.type === 'thinking' &&
        canonicalJSON({ ...last, thinking: [] }) === canonicalJSON({ ...chunk, thinking: [] })) {
        (chunk.thinking || []).forEach((inner, index) => appendChunk(last.thinking, inner, index === 0));
    } else chunks.push(structuredClone(chunk));
}

function appendToolCalls(message, calls) {
    message.tool_calls ??= [];
    for (const delta of calls) {
        const index = delta.index;
        if (!Number.isInteger(index) || index < 0) return false;
        const call = message.tool_calls[index] ??= {};
        for (const [key, value] of Object.entries(delta)) {
            if (key === 'index') continue;
            if (key === 'function') {
                call.function ??= {};
                for (const [name, text] of Object.entries(value)) call.function[name] = (call.function[name] || '') + text;
            } else call[key] = value;
        }
    }
    return true;
}

export function captureChatCompletion(parsed, state, streaming = true) {
    if (parsed.error) {
        if (state) state.valid = false;
        throw new Error(parsed.error.message || 'Chat completion failed');
    }
    if (!state) return;
    const choice = parsed.choices?.[0];
    if (!choice) return;
    if (!streaming || choice.message && !choice.delta) state.payload = structuredClone(choice.message || state.payload);
    else if (choice.delta) {
        const delta = choice.delta;
        const message = state.payload;
        for (const [key, value] of Object.entries(delta)) {
            if (value == null) continue;
            if (key === 'content') {
                if (state.provider === 'mistral' && Array.isArray(value)) {
                    if (typeof message.content === 'string') message.content = message.content ? [{ type: 'text', text: message.content }] : [];
                    value.forEach((chunk, index) => appendChunk(message.content, chunk, index === 0));
                } else if (typeof value === 'string') {
                    if (Array.isArray(message.content)) {
                        const last = message.content.at(-1);
                        if (last?.type === 'text') last.text += value;
                        else message.content.push({ type: 'text', text: value });
                    } else message.content = (message.content || '') + value;
                } else state.valid = false;
            } else if (key === 'reasoning_content') {
                if (typeof value !== 'string') state.valid = false;
                else message.reasoning_content = (message.reasoning_content || '') + value;
            } else if (key === 'tool_calls') {
                if (!Array.isArray(value) || !appendToolCalls(message, value)) state.valid = false;
            } else message[key] = value;
        }
    }
    if (choice.finish_reason) {
        state.completed = ['stop', 'tool_calls'].includes(choice.finish_reason);
        if (!state.completed) state.valid = false;
        if (state.payload.tool_calls && Array.from(state.payload.tool_calls).some(call => !call)) state.valid = false;
    }
}

export function captureGrokStream(parsed, state) {
    captureOpenAIStream(parsed, state);
    if (!state) return;
    const annotation = parsed.type === 'response.output_text.annotation.added' ? parsed.annotation : null;
    const url = annotation?.url || annotation?.url_citation?.url;
    if (url) (state.annotationURLs ??= new Set()).add(url);
    if (parsed.type === 'response.completed') {
        if (parsed.response?.error || parsed.response?.incomplete_details) state.valid = false;
        state.citations = [...new Set([...grokCitations({ ...parsed.response, output: state.payload }),
            ...(state.annotationURLs || [])])];
    }
}
