/**
 * Human-readable Markdown export for chats.
 *
 * Pure serializer for the v3 chat data model (contents/regenerations, arena
 * branches, council responses, thoughts, media placeholders) plus a thin
 * clipboard boundary helper. Message content is already Markdown source, so
 * it passes through verbatim - no HTML rendering is involved.
 */

const REGEN_ARROW = '⟳'; // Matches chat_ui.js UNICODE.REGEN_ARROW

const ROLE_LABELS = { user: 'You', assistant: 'Assistant', system: 'System' };

const ARENA_MODEL_KEYS = ['model_a', 'model_b'];

const arenaFallbackName = (modelKey) => (modelKey === 'model_a' ? 'Model A' : 'Model B');

const arenaDisplayName = (responses, modelKey) => {
    const fallback = arenaFallbackName(modelKey);
    const name = responses?.[modelKey]?.name;
    return name && name !== fallback ? `${fallback} (${name})` : fallback;
};

const modelOf = (parts) => {
    for (let i = parts.length - 1; i >= 0; i--) {
        if (parts[i]?.model) return parts[i].model;
    }
    return null;
};

const blockquote = (text) => text
    .split('\n')
    .map(line => (line ? `> ${line}` : '>'))
    .join('\n');

const serializeParts = (parts) => {
    const blocks = [];
    for (const part of parts) {
        if (!part) continue;
        if (part.type === 'image') {
            blocks.push('*[Image]*');
        } else if (part.type === 'audio') {
            blocks.push('*[Audio]*');
        } else if (part.content) {
            blocks.push(part.type === 'thought' ? blockquote(`*Thinking:*\n${part.content}`) : part.content);
        }
    }
    return blocks.join('\n\n');
};

const serializeMedia = (message) => {
    const lines = [];
    (message.images || []).forEach(() => lines.push('*[Image]*'));
    (message.files || []).forEach(file => lines.push(file?.name ? `*[File: ${file.name}]*` : '*[File]*'));
    (message.audio || []).forEach(item => {
        const name = typeof item === 'string' ? '' : (item?.name || '');
        lines.push(name ? `*[Audio: ${name}]*` : '*[Audio]*');
    });
    return lines.join('\n');
};

const labeledBlock = (label, body, isRegeneration = false) =>
    `**${isRegeneration ? `${label} ${REGEN_ARROW}` : label}:**\n\n${body}`;

const serializeContentGroups = (message, baseLabel, mediaBlock = '') => {
    const blocks = [];
    (message.contents || []).forEach((parts, index) => {
        const body = [index === 0 ? mediaBlock : '', serializeParts(parts)].filter(Boolean).join('\n\n');
        if (!body) return;
        const model = modelOf(parts);
        blocks.push(labeledBlock(model ? `${baseLabel} (${model})` : baseLabel, body, index > 0));
    });
    if (!blocks.length && mediaBlock) {
        blocks.push(labeledBlock(baseLabel, mediaBlock));
    }
    return blocks;
};

const arenaResultLines = (message) => {
    const lines = [];
    const choice = message.choice;
    if (choice === 'model_a' || choice === 'model_b') {
        lines.push(`*Winner: ${arenaDisplayName(message.responses, choice)}*`);
    } else if (choice === 'draw') {
        lines.push('*Result: draw*');
    } else if (choice === 'no_choice(bothbad)') {
        lines.push('*Result: no choice (both bad)*');
    } else if (choice && choice !== 'ignored' && choice !== 'reveal') {
        lines.push(`*Result: ${choice}*`);
    }
    if (message.continued_with === 'model_a' || message.continued_with === 'model_b') {
        lines.push(`*Continued with ${arenaDisplayName(message.responses, message.continued_with)}*`);
    }
    return lines;
};

const serializeArena = (message) => {
    const blocks = [];
    for (const modelKey of ARENA_MODEL_KEYS) {
        (message.responses?.[modelKey]?.messages || []).forEach((parts, index) => {
            const body = serializeParts(parts);
            if (!body) return;
            blocks.push(labeledBlock(arenaDisplayName(message.responses, modelKey), body, index > 0));
        });
    }
    blocks.push(...arenaResultLines(message));
    return blocks.length ? ['**Arena:**', ...blocks] : [];
};

const serializeCouncil = (message) => {
    const blocks = [];
    const responses = message.council?.responses || {};
    for (const [modelId, entry] of Object.entries(responses)) {
        const body = serializeParts(entry?.parts || []);
        if (!body) continue;
        blocks.push(labeledBlock(entry?.name || modelId, body));
    }
    const collector = message.council?.collector_model;
    const summaryLabel = collector ? `Council summary (${collector})` : 'Council summary';
    (message.contents || []).forEach((parts, index) => {
        const body = serializeParts(parts);
        if (!body) return;
        blocks.push(labeledBlock(summaryLabel, body, index > 0));
    });
    return blocks.length ? ['**Council:**', ...blocks] : [];
};

const serializeMessage = (message) => {
    if (message.responses) return serializeArena(message);
    if (message.council) return serializeCouncil(message);
    const baseLabel = ROLE_LABELS[message.role] || message.role || 'unknown';
    return serializeContentGroups(message, baseLabel, serializeMedia(message));
};

export const serializeChatToMarkdown = (chat) => {
    const title = (chat?.title || '').trim() || 'Untitled chat';
    const sections = [`# ${title}`];
    for (const message of chat?.messages || []) {
        sections.push(...serializeMessage(message));
    }
    return `${sections.join('\n\n')}\n`;
};

/**
 * Loads a chat without resolving blob data (media becomes placeholders) and
 * writes its Markdown serialization to the clipboard.
 */
export const copyChatMarkdownToClipboard = async (chatStorage, chatId) => {
    const chat = await chatStorage.loadChat(chatId, null, { resolveBlobs: false });
    if (!chat) throw new Error(`Chat not found: ${chatId}`);
    await navigator.clipboard.writeText(serializeChatToMarkdown(chat));
};
