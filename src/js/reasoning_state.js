// Native payloads stay separate from display parts and never contain credentials.
const encoder = new TextEncoder();
export const isThinkingBlock = block => block?.type === 'thinking' || block?.type === 'redacted_thinking';

// Display and replay validation use the same projection; native blocks stay untouched.
export function citationURLs(provider, payload) {
    const blocks = provider === 'anthropic' ? payload : payload.flatMap(item => item?.content || []);
    return blocks.flatMap(block => (provider === 'anthropic' ? block?.citations : block?.annotations) || [])
        .map(citation => citation?.url || citation?.url_citation?.url).filter(url => typeof url === 'string');
}

function citationLinks(citations, inline) {
    const links = [];
    for (const url of new Set(citations || [])) {
        try {
            const parsed = new URL(url);
            if (!['http:', 'https:'].includes(parsed.protocol)) continue;
            let label = `${links.length + 1}`;
            if (!inline) {
                const hostname = parsed.hostname.toLowerCase().replace(/^www\./, '');
                const parts = hostname.split('.');
                const sld = ['co', 'com', 'org', 'net', 'gov', 'ac', 'edu'];
                label = parts.length > 2
                    ? parts.slice(parts.at(-1).length === 2 && sld.includes(parts.at(-2)) ? -3 : -2).join('.')
                    : hostname;
            }
            const target = parsed.href.replace(/[()\\<>]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
            links.push(`[${label.replace(/[[\]\\]/g, '\\$&')}](${target})`);
        } catch (_) { /* Invalid source URLs are not clickable citations. */ }
    }
    return links.join(' · ');
}

export function buildCitationsTail(citations) {
    const links = citationLinks(citations, false);
    return links ? `\n\n${links}\n` : '';
}

// Terminal block-end references keep streaming append-only and the saved projection exact.
export function buildInlineCitations(citations) {
    const links = citationLinks(citations, true);
    return links ? ` ${links}` : '';
}

export function nativeVisibleText(provider, payload) {
    const blocks = provider === 'anthropic' ? payload.filter(block => block.type === 'text')
        : payload.filter(item => item.type === 'message').flatMap(item => item.content || []);
    const text = blocks.map(block => block.type === 'refusal' ? block.refusal || ''
        : ['text', 'output_text'].includes(block.type) ? block.text || '' : '').join('');
    return text + buildInlineCitations(citationURLs(provider, payload));
}

// Anthropic compares JSON values, except cache markers. Keep array and string order exact.
export function canonicalJSON(value) {
    if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).filter(key => key !== 'cache_control' && value[key] !== undefined)
            .sort().map(key => `${JSON.stringify(key)}:${canonicalJSON(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}

export async function reasoningDigest(value) {
    const bytes = await crypto.subtle.digest('SHA-256', encoder.encode(value));
    return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function credentialScope(apiKey) {
    return apiKey ? `key:${await reasoningDigest(apiKey)}` : null;
}

export function nativeCandidate(message, provider) {
    const state = message.role === 'assistant' ? message.parts?.[0]?.providerState : null;
    if (state?.version !== 1 || state.provider !== provider || state.replayable === false) return null;
    const payload = provider === 'openai' ? state.output : state.content;
    if (!Array.isArray(payload) || !payload.length || Array.from(payload).some(item => !item || typeof item.type !== 'string') ||
        typeof state.model !== 'string' || typeof state.scope !== 'string' || typeof state.prefix !== 'string') return null;
    const visible = (message.parts || []).filter(part => part.type === 'text')
        .map(part => part.content || '').join('');
    const original = nativeVisibleText(provider, payload);
    return visible === original ? state : null;
}

function hasNativePayload(provider, payload) {
    return provider === 'openai'
        ? payload.some(item => item?.type === 'reasoning' && typeof item.encrypted_content === 'string' && item.encrypted_content.length > 0)
        : payload.some(block => block?.type === 'thinking' && typeof block.thinking === 'string' && typeof block.signature === 'string' && block.signature.length > 0 ||
            block?.type === 'redacted_thinking' && typeof block.data === 'string' && block.data.length > 0 ||
            ['server_tool_use', 'web_search_tool_result'].includes(block?.type) ||
            block?.type === 'text' && Array.isArray(block.citations) && block.citations.length > 0);
}

export function coherentPayload(provider, payload) {
    if (!Array.isArray(payload) || !payload.length || Array.from(payload).some(item => !item || typeof item.type !== 'string')) return false;
    if (provider === 'openai') {
        return payload.every(item => !item.status || item.status === 'completed' ||
            item.status === 'failed' && item.type.endsWith('_call')) &&
            payload.every(item => item.type !== 'reasoning' || typeof item.encrypted_content === 'string' && item.encrypted_content.length > 0);
    }
    return payload.every(block => block.type !== 'thinking' || typeof block.thinking === 'string' && typeof block.signature === 'string' && block.signature.length > 0) &&
        payload.every(block => block.type !== 'redacted_thinking' || typeof block.data === 'string' && block.data.length > 0);
}

// Each message is processed once; persisted state stores only a digest, not a history copy.
export async function prepareNativeRequest(provider, { model, requestOptions, reasoningScope }, candidates = []) {
    const body = JSON.parse(requestOptions.body);
    const anthropic = provider === 'anthropic';
    let prefix = await reasoningDigest(canonicalJSON(anthropic
        ? { system: body.system ?? null, tools: body.tools ?? [] }
        : { instructions: body.instructions ?? null, tools: body.tools ?? [] }));
    let predecessor = null;
    let sentThinking = false;
    const history = anthropic ? body.messages : body.input;
    const replay = [];
    for (let index = 0; index < history.length; index++) {
        let message = history[index];
        if (anthropic) {
            message = { ...message, content: message.content.filter(block => block.type !== 'text' || block.text) };
        }
        const saved = candidates[index];
        let native = null;
        if (saved && reasoningScope && saved.scope === reasoningScope) {
            const payload = anthropic ? saved.content : saved.output;
            const compatible = saved.model === model && saved.prefix === prefix && coherentPayload(provider, payload);
            if (anthropic) {
                // Removing an oldest run is allowed. A gap or a restored predecessor is not.
                const chainMatches = !sentThinking || saved.predecessor === predecessor;
                native = compatible && chainMatches ? payload : payload.filter(block => !isThinkingBlock(block));
                if (!native.length) native = null;
            } else if (compatible) {
                native = payload;
            }
        }
        if (anthropic) {
            const submitted = native ? { role: message.role, content: native } : message;
            if (submitted.content.length) replay.push(submitted);
            const semantic = { ...submitted, content: submitted.content.filter(block => !isThinkingBlock(block)) };
            if (semantic.content.length) prefix = await reasoningDigest(`${prefix}\n${canonicalJSON(semantic)}`);
            const lastThinking = submitted.content.findLast(isThinkingBlock);
            if (lastThinking) {
                predecessor = await reasoningDigest(canonicalJSON(lastThinking));
                sentThinking = true;
            }
        } else {
            const submitted = native || [message];
            replay.push(...submitted);
            for (const item of submitted) prefix = await reasoningDigest(`${prefix}\n${canonicalJSON(item)}`);
        }
    }
    if (anthropic) body.messages = replay;
    else body.input = replay;
    requestOptions.body = JSON.stringify(body);
    const state = { version: 1, provider, model, scope: reasoningScope, prefix, predecessor,
        completed: false, valid: true, payload: [] };
    if (anthropic) {
        state.openBlocks = new Set();
        state.blockInputs = new Map();
    }
    return state;
}

export function finalizeNativeState(state) {
    if (!state?.scope || !state.completed || !state.valid || state.openBlocks?.size ||
        !coherentPayload(state.provider, state.payload) || !hasNativePayload(state.provider, state.payload)) return null;
    const saved = { version: 1, provider: state.provider, model: state.model, scope: state.scope, prefix: state.prefix };
    if (state.provider === 'anthropic') {
        saved.predecessor = state.predecessor;
        saved.content = state.payload;
    } else {
        saved.output = state.payload;
    }
    return saved;
}

export function captureOpenAIStream(parsed, state) {
    if (!state) return;
    if (parsed.type === 'response.output_item.done') {
        if (!Number.isInteger(parsed.output_index) || parsed.output_index < 0 || !parsed.item) state.valid = false;
        else state.payload[parsed.output_index] = parsed.item;
    } else if (parsed.type === 'response.completed') {
        if (Array.isArray(parsed.response?.output)) state.payload = parsed.response.output;
        state.completed = !parsed.response?.status || parsed.response.status === 'completed';
        // Array.every skips holes; missing output indexes mean the response is not coherent.
        if (Array.from(state.payload).some(item => !item)) state.valid = false;
    } else if (['response.failed', 'response.incomplete', 'error'].includes(parsed.type)) {
        state.valid = false;
    }
}

export function captureAnthropicStream(parsed, state) {
    if (!state) return;
    const index = parsed.index;
    if (parsed.type === 'content_block_start') {
        if (!Number.isInteger(index) || index < 0 || !parsed.content_block || state.payload[index]) {
            state.valid = false;
            return;
        }
        state.payload[index] = { ...parsed.content_block };
        if (Array.isArray(parsed.content_block.citations)) {
            state.payload[index].citations = parsed.content_block.citations.slice();
        }
        state.openBlocks.add(index);
    } else if (parsed.type === 'content_block_delta') {
        const block = state.payload[index];
        const delta = parsed.delta || {};
        if (!block || !state.openBlocks.has(index)) {
            state.valid = false;
            return;
        }
        switch (delta.type) {
            case 'text_delta':
                if (block.type !== 'text' || typeof delta.text !== 'string') state.valid = false;
                else block.text = (block.text || '') + delta.text;
                break;
            case 'thinking_delta':
                if (block.type !== 'thinking' || typeof delta.thinking !== 'string') state.valid = false;
                else block.thinking = (block.thinking || '') + delta.thinking;
                break;
            case 'signature_delta':
                if (block.type !== 'thinking' || typeof delta.signature !== 'string') state.valid = false;
                else block.signature = (block.signature || '') + delta.signature;
                break;
            case 'input_json_delta': {
                if (!['tool_use', 'server_tool_use'].includes(block.type) || typeof delta.partial_json !== 'string') {
                    state.valid = false;
                    break;
                }
                const chunks = state.blockInputs.get(index) || [];
                chunks.push(delta.partial_json);
                state.blockInputs.set(index, chunks);
                break;
            }
            case 'citations_delta':
                if (block.type !== 'text' || !delta.citation || typeof delta.citation !== 'object') state.valid = false;
                else (block.citations ??= []).push(delta.citation);
                break;
            default: state.valid = false;
        }
    } else if (parsed.type === 'content_block_stop') {
        if (!state.openBlocks.delete(index)) state.valid = false;
        const chunks = state.blockInputs.get(index);
        if (chunks) {
            try { state.payload[index].input = JSON.parse(chunks.join('')); }
            catch (_) { state.valid = false; }
            state.blockInputs.delete(index);
        }
    } else if (parsed.type === 'message_delta') {
        if (parsed.delta?.stop_reason) state.stopReason = parsed.delta.stop_reason;
    } else if (parsed.type === 'message_stop') {
        state.completed = !!state.stopReason && state.stopReason !== 'max_tokens';
        if (Array.from(state.payload).some(block => !block)) state.valid = false;
    } else if (parsed.type === 'error') {
        state.valid = false;
    }
}
