import { SidepanelRenameManager } from './rename_manager.js';

/**
 * Core chat data logic. Handles the structure of the current conversation.
 */
export class ChatCore {
    constructor(chatStorage) {
        this.chatStorage = chatStorage;
        this.currentChat = null;
        this.init();
    }

    init(title = "") {
        this.currentChat = this.chatStorage.createNewChatTracking(title);
    }

    reset(title = "") {
        this.init(title);
    }

    miscUpdate(update = {}) {
        Object.assign(this.currentChat, update);
    }
    
    addFromHistory(message) {
        const { chatId, messageId, timestamp, ...data } = message;
        this.currentChat.messages.push(data);
    }

    addMultipleFromHistory(messages) {
        messages.forEach(message => this.addFromHistory(message));
    }

    getLatestMessage() {
        return this.currentChat.messages.at(-1);
    }

    getLength() {
        return this.currentChat.messages.length;
    }

    getTitle() {
        return this.currentChat.title;
    }

    hasChatStarted() {
        return this.currentChat.messages.length > 1;
    }

    getChatId() {
        return this.currentChat.chatId;
    }

    getChat() {
        return this.currentChat;
    }

    getSystemPrompt() {
        const firstMessage = this.currentChat.messages[0];
        if (firstMessage?.role === 'system') {
            return firstMessage.contents?.[0]?.[0]?.content;
        }
        return undefined;
    }

    async refreshSearchDoc() {
        const chatId = this.getChatId();
        if (chatId) {
            await this.chatStorage.refreshSearchDoc(chatId);
        }
    }

    async loadChat(chatId) {
        this.currentChat = await this.chatStorage.loadChat(chatId);
        return this.currentChat;
    }
}

/**
 * Specialized ChatCore for the Sidepanel, including media and thinking states.
 */
export class SidepanelChatCore extends ChatCore {
    constructor(chatStorage, stateManager, chatHeader, onTitleChange = null, onChatIdChange = null) {
        super(chatStorage);
        Object.assign(this, {
            stateManager,
            chatHeader,
            onTitleChange,
            onChatIdChange,
            renameManager: new SidepanelRenameManager(chatStorage)
        });
        this.resetState();
    }

    reset(title = "") {
        super.reset(title);
        this.resetState();
    }

    resetState() {
        Object.assign(this, {
            continuedChatOptions: {},
            pendingMedia: {},
            tempMediaId: 0,
            thinkingChat: null
        });
    }

    initThinkingChat() {
        if (!this.thinkingChat && this.stateManager.thinkingMode) {
            this.thinkingChat = new ThinkingChat(this.stateManager);
        }
    }

    appendMedia(media, type) {
        const mediaId = this.tempMediaId++;
        this.pendingMedia[mediaId] = { media, type };
        return mediaId;
    }

    removeMedia(mediaId) {
        delete this.pendingMedia[mediaId];
    }

    realizeMedia(message) {
        if (message.role !== 'user') return;

        const images = [];
        const files = [];
        
        Object.values(this.pendingMedia).forEach(item => {
            if (item.type === 'image') {
                images.push(item.media);
            } else {
                files.push(item.media);
            }
        });

        if (images.length > 0) {
            message.images = images;
        }
        if (files.length > 0) {
            message.files = files;
        }
        
        this.pendingMedia = {};
    }

    async appendRegenerated(parts, modelId) {
        const latestMessage = this.getLatestMessage();
        
        // If the last message isn't a normal assistant message, create a new one
        // This handles cross-mode regeneration (arena->normal, council->normal, etc.)
        if (latestMessage?.role !== 'assistant' || latestMessage.responses || latestMessage.council) {
            return this.addAssistantMessage(parts, modelId);
        }

        parts.forEach(part => {
            part.model = modelId;
        });
        latestMessage.contents.push(parts);
        await this.updateSaved();
    }

    initArena(modelA, modelB) {
        const arenaMessage = this.chatStorage.initArenaMessage(modelA, modelB);
        if (this.thinkingChat) {
            this.thinkingChat.message = arenaMessage;
        } else {
            this.currentChat.messages.push(arenaMessage);
        }
    }

    initCouncil(models, collectorModel) {
        const councilMessage = this.chatStorage.initCouncilMessage(models, collectorModel);
        if (this.thinkingChat) {
            this.thinkingChat.message = councilMessage;
        } else {
            this.currentChat.messages.push(councilMessage);
        }
    }

    async updateCouncil(parts, modelId) {
        const latestMessage = this.getLatestMessage();
        if (!latestMessage?.council?.responses?.[modelId]) return;

        latestMessage.council.responses[modelId].parts = parts;
        await this.updateSaved();
    }

    async updateCouncilCollector(parts, collectorModel) {
        parts.forEach(part => {
            part.model = collectorModel;
        });

        const latestMessage = this.getLatestMessage();
        if (!latestMessage?.council) return;
        latestMessage.council.collector_model = collectorModel;

        latestMessage.contents[0] = parts;
        await this.updateSaved();
    }

    async updateCouncilCollectorStatus(status) {
        // No-op: status is ephemeral
    }

    async updateCouncilStatus(modelId, status) {
        // No-op: status is ephemeral
    }

    async updateArena(parts, modelId, modelKey) {
        if (this.thinkingChat) {
            this.thinkingChat.addMessage(parts, modelId, modelKey);
            if (this.thinkingChat.isDone) {
                await this.commitThinkingChat();
            }
        } else {
            this.getLatestMessage().responses[modelKey].messages.push(parts);
            await this.updateSaved();
        }
    }

    async setArenaModelName(modelKey, name) {
        const latestMessage = this.getLatestMessage();
        if (latestMessage?.responses?.[modelKey]) {
            latestMessage.responses[modelKey].name = name;
            await this.updateSaved();
        }
    }

    async updateArenaMisc(choice = null, continuedWith = null) {
        const latestMessage = this.getLatestMessage();
        if (choice) {
            latestMessage.choice = choice;
        }
        if (continuedWith) {
            latestMessage.continued_with = continuedWith;
        }
        await this.updateSaved();
    }

    async addAssistantMessage(parts, modelId) {
        parts.forEach(part => {
            part.model = modelId;
        });
        const message = { role: 'assistant', contents: [parts] };
        
        if (this.thinkingChat) {
            this.thinkingChat.addMessage(message, modelId);
            if (this.thinkingChat.isDone) {
                await this.commitThinkingChat();
            }
        } else {
            this.currentChat.messages.push(message);
            await this.saveNew();
        }
    }

    async addUserMessage(text = "") {
        const message = {
            role: 'user',
            contents: [[{ type: 'text', content: text }]]
        };
        this.realizeMedia(message);
        this.currentChat.messages.push(message);
        await this.saveNew();
    }

    insertSystemMessage(text = "") {
        const message = {
            role: 'system',
            contents: [[{ type: 'text', content: text }]]
        };
        const messages = this.currentChat.messages;
        
        if (!messages.length) {
            messages.push(message);
        } else if (messages[0].role === 'system') {
            messages[0] = message;
        } else {
            messages.unshift(message);
        }
    }

    async saveNew() {
        if (!this.stateManager.shouldSave) return;
        if (await this.handleContinuedChatSave()) return;

        if (!this.currentChat.chatId) {
            await this.createNewChat();
        } else {
            await this.addMessagesToExistingChat();
        }
    }

    async updateSaved() {
        if (!this.stateManager.shouldSave) return;
        await this.handleContinuedChatSave();
        
        const lastIndex = this.getLength() - 1;
        const lastMessage = this.getLatestMessage();
        
        await this.chatStorage.updateMessage(
            this.getChatId(), 
            lastIndex, 
            SidepanelChatCore.stripEphemeral(lastMessage),
            { skipSearchRefresh: true }
        );
    }

    async createNewChat(options = {}, autoRename = true) {
        const messages = this.currentChat.messages.map(SidepanelChatCore.stripEphemeral);
        const result = await this.chatStorage.createChatWithMessages(this.currentChat.title, messages, options);
        
        this.currentChat.chatId = result.chatId;
        this.onChatIdChange?.(result.chatId);

        if (autoRename) {
            this.renameManager.autoRename(result.chatId, this.chatHeader).then(renameResult => {
                if (renameResult?.newName) {
                    this.currentChat.title = renameResult.newName;
                    this.onTitleChange?.(renameResult.newName);
                }
            }).catch(error => console.warn('Auto-rename failed:', error));
        }
    }

    async addMessagesToExistingChat(count = 1) {
        const messages = this.currentChat.messages.slice(-count).map(SidepanelChatCore.stripEphemeral);
        const startIndex = this.currentChat.messages.length - count;
        await this.chatStorage.addMessages(this.currentChat.chatId, messages, startIndex);
    }

    /**
     * Removes thought signatures before saving.
     */
    static stripEphemeral(message) {
        if (!message) return message;

        const stripGroup = group => group.map(({ thoughtSignature, ...part }) => part);

        // Handle council messages
        if (message.council?.responses) {
            const strippedResponses = {};
            for (const [modelKey, modelResp] of Object.entries(message.council.responses)) {
                strippedResponses[modelKey] = {
                    ...modelResp,
                    parts: stripGroup(modelResp.parts || [])
                };
            }
            return {
                ...message,
                contents: message.contents.map(stripGroup),
                council: {
                    collector_model: message.council.collector_model,
                    responses: strippedResponses
                }
            };
        }

        // Handle regular messages with contents
        if (message.contents) {
            return {
                ...message,
                contents: message.contents.map(stripGroup)
            };
        }

        const stripResponses = (responses) => {
            const stripped = {};
            for (const [modelKey, modelResp] of Object.entries(responses || {})) {
                if (modelResp?.messages) {
                    stripped[modelKey] = {
                        ...modelResp,
                        messages: modelResp.messages.map(stripGroup)
                    };
                } else {
                    stripped[modelKey] = modelResp;
                }
            }
            return stripped;
        };

        // Handle arena messages with responses
        if (message.responses) {
            return { ...message, responses: stripResponses(message.responses) };
        }

        return message;
    }

    buildFromDB(chat, index = null, subIdx = null, modelKey = null) {
        this.currentChat = { 
            ...chat, 
            messages: chat.messages
                .slice(0, index != null ? index + 1 : Infinity)
                .map(({ messageId, timestamp, chatId, ...rest }) => rest) 
        };

        const latestMessage = this.getLatestMessage();
        if (subIdx != null && latestMessage) {
            if (modelKey != null && latestMessage.responses) {
                latestMessage.responses[modelKey].messages = latestMessage.responses[modelKey].messages.slice(0, subIdx + 1);
                latestMessage.continued_with = modelKey;
            } else if (latestMessage.role === 'assistant') {
                latestMessage.contents = latestMessage.contents.slice(0, subIdx + 1);
            } else if (latestMessage.role === 'user') {
                this.currentChat.messages.pop();
            }
        }
    }

    getMessagesForAPI(modelId = null) {
        const sanitizePart = (part) => {
            if (!part) return part;
            if (part.type === 'thought') {
                return { ...part, content: '' };
            }
            return part;
        };

        const sanitizeParts = (parts) => {
            if (!Array.isArray(parts)) return [];
            return parts.map(sanitizePart);
        };

        const messages = this.currentChat.messages.map(message => {
            if (message.role === 'user' || message.role === 'system') {
                const lastContentVersion = message.contents.at(-1) || [];
                const textPart = lastContentVersion.find(p => p.type === 'text') || lastContentVersion.at(-1);
                const normalized = { 
                    role: message.role, 
                    parts: [{ type: 'text', content: textPart?.content || '' }] 
                };
                if (message.images) {
                    normalized.images = message.images;
                }
                if (message.files) {
                    normalized.files = message.files;
                }
                return normalized;
            }
            
            if (message.responses) {
                const modelKey = message.continued_with;
                if (modelKey && modelKey !== 'none') {
                    return { role: message.role, parts: sanitizeParts(message.responses[modelKey].messages.at(-1)) };
                }
                return null;
            }
            
            if (message.council) {
                return { role: message.role, parts: sanitizeParts(message.contents?.at(-1) || []) };
            }
            
            return { role: message.role, parts: sanitizeParts(message.contents.at(-1)) };
        }).filter(Boolean);
        
        // Remove trailing assistant message for regeneration
        while (messages.at(-1)?.role === 'assistant') {
            messages.pop();
        }

        if (modelId && this.stateManager.thinkingMode) {
            this.thinkingChat.getMessagesForAPI(messages, modelId);
        }
        
        return messages;
    }

    async commitThinkingChat() {
        if (!this.thinkingChat) return;

        const latestMessage = this.getLatestMessage();
        const thinkingMessage = this.thinkingChat.message;

        if (latestMessage?.role === 'user') {
            this.currentChat.messages.push(thinkingMessage);
            await this.saveNew();
        } else if (latestMessage?.role === 'assistant') {
            if (latestMessage.responses) {
                for (const modelKey of Object.keys(latestMessage.responses)) {
                    const newMessages = thinkingMessage.responses[modelKey].messages;
                    if (newMessages.length > 0) {
                        latestMessage.responses[modelKey].messages.push(newMessages.at(-1));
                    }
                }
            } else if (latestMessage.council?.responses) {
                for (const modelKey of Object.keys(latestMessage.council.responses)) {
                    const newParts = thinkingMessage.council.responses[modelKey].parts;
                    if (newParts.length > 0) {
                        latestMessage.council.responses[modelKey].parts = newParts;
                    }
                }
                if (thinkingMessage.contents?.length) {
                    latestMessage.contents = latestMessage.contents || [];
                    latestMessage.contents.push(thinkingMessage.contents.at(-1));
                }
            } else {
                latestMessage.contents.push(thinkingMessage.contents.at(-1));
            }

            await this.updateSaved();
        }
        this.thinkingChat = null;
    }

    canContinue(options, userMessage = null) {
        const { lastMessage, index, secondaryIndex, modelChoice, fullChatLength, secondaryLength } = options;
        
        if (!lastMessage || index == null || secondaryIndex == null || secondaryLength == null || fullChatLength == null) return false;
        if (fullChatLength !== index + 1 || secondaryLength !== secondaryIndex + 1) return false;

        if (lastMessage.role === 'system') return true;
        if (lastMessage.role === 'user') return this.isUserMessageEqual(lastMessage, userMessage);
        
        if (lastMessage.role === 'assistant') {
            if (lastMessage.responses) {
                return (modelChoice && modelChoice !== 'none' && lastMessage.continued_with === modelChoice && lastMessage.responses[modelChoice].messages.length === secondaryIndex + 1);
            }
            if (lastMessage.council) {
                return lastMessage.contents?.length === secondaryIndex + 1;
            }
            return lastMessage.contents.length === secondaryIndex + 1;
        }
        
        return false;
    }

    isUserMessageEqual(msgA, msgB) {
        if (!msgA || !msgB) return false;

        let isContentSame = true;
        msgA.contents?.forEach((item, index) => {
            if (item[0]?.content !== msgB.contents?.[index]?.[0]?.content) {
                isContentSame = false;
            }
        });
        if (!isContentSame) return false;

        if (msgA.files?.length !== msgB.files?.length) return false;
        if (msgA.images?.length !== msgB.images?.length) return false;

        if (msgA.files) {
            for (let i = 0; i < msgA.files.length; i++) {
                if (msgA.files[i].name !== msgB.files[i].name || msgA.files[i].content !== msgB.files[i].content) {
                    return false;
                }
            }
        }

        if (msgA.images) {
            for (let i = 0; i < msgA.images.length; i++) {
                if (msgA.images[i] !== msgB.images[i]) return false;
            }
        }

        return true;
    }

    async handleContinuedChatSave() {
        if (Object.keys(this.continuedChatOptions).length === 0) return false;
        
        const options = this.continuedChatOptions;
        this.continuedChatOptions = {};

        if (this.canContinue(options, this.currentChat.messages[options.index])) {
            const addedCount = this.currentChat.messages.length - options.fullChatLength;
            if (addedCount > 0) await this.addMessagesToExistingChat(addedCount);
        } else {
            const createOptions = {
                continued_from_chat_id: this.currentChat.chatId,
                renamed: this.currentChat.renamed || false
            };
            await this.createNewChat(createOptions, false);
        }
        return true;
    }

    isDoneThinking() {
        return !this.thinkingChat || this.thinkingChat.isDone;
    }

    collectPendingUserMessage(text) {
        const message = {
            role: 'user',
            contents: [[{ type: 'text', content: text }]]
        };
        this.realizeMedia(message);
        
        const hasMedia = message.images?.length || message.files?.length;
        return (text || hasMedia) ? message : null;
    }
}

/**
 * Manages the "thinking" loop for multi-step prompting.
 */
class ThinkingChat {
    constructor(stateManager) {
        Object.assign(this, {
            stateManager,
            message: null,
            loopCounts: [0, 0],
            isDone: false,
            loopThreshold: stateManager.getSetting('loop_threshold')
        });
    }

    getLatestParts(modelId) {
        if (!this.message) return null;
        
        const partsList = this.message.responses 
            ? this.message.responses[this.stateManager.getArenaModelKey(modelId)]?.messages?.at(-1)
            : (this.message.council?.responses?.[modelId]?.parts || this.message.contents?.at(-1));
            
        if (!partsList?.length) return null;

        const sanitizePart = (part) => {
            if (!part) return part;
            if (part.type === 'thought') {
                return { ...part, content: '' };
            }
            return part;
        };

        return { role: 'assistant', parts: partsList.map(sanitizePart) };
    }

    getMessagesForAPI(messages, modelId) {
        const latestParts = this.getLatestParts(modelId);
        if (latestParts) {
            messages.push(latestParts);
        }

        const promptText = this.stateManager.isThinking(modelId) && this.message 
            ? "Please reflect and improve your thoughts."
            : (this.stateManager.isSolving(modelId) ? "Using the detailed thoughts given to you, please solve now." : "");
            
        if (promptText) {
            messages.push({ role: 'user', parts: [{ type: 'text', content: promptText }] });
        }
        
        return this.injectSystemPrompts(messages, modelId);
    }

    injectSystemPrompts(messages, modelId) {
        if (!messages.length) return messages;

        let systemContent = (messages[0].role === 'system' ? messages[0].parts?.[0]?.content || "" : "");
        const promptType = this.stateManager.isThinking(modelId) ? 'thinking' : (this.stateManager.isSolving(modelId) ? 'solver' : null);
        
        if (!promptType) return messages;

        systemContent += "\n\n" + this.stateManager.getPrompt(promptType);

        if (messages[0].role === 'system') {
            messages[0].parts[0].content = systemContent;
        } else {
            messages.unshift({ role: 'system', parts: [{ type: 'text', content: systemContent }] });
        }
        
        return messages;
    }

    addMessage(parts, modelId, modelKey = null) {
        if (this.isDone) return;

        if (modelKey) {
            const modelMsgs = this.message.responses[modelKey].messages;
            if (!modelMsgs.length) {
                modelMsgs.push([]);
            }
            modelMsgs.at(-1).push(...parts);
            this.updateLoopState(modelKey === 'model_a' ? 0 : 1, modelId, modelKey);
        } else {
            if (!this.message) {
                this.message = parts;
            } else {
                this.message.contents.at(-1).push(...parts.contents.at(-1));
            }
            this.updateLoopState(0, modelId);
        }
    }

    updateLoopState(index, modelId, modelKey = null) {
        this.loopCounts[index]++;
        
        if (this.stateManager.isSolving(modelId)) {
            this.stateManager.nextThinkingState(modelId);
            // In Arena, wait for both to be inactive
            if (!modelKey || this.stateManager.isInactive(this.stateManager.getArenaModels()[1 - index])) {
                this.isDone = true;
            }
        } else if (this.loopCounts[index] >= this.loopThreshold) {
            this.stateManager.nextThinkingState(modelId);
        }
    }
}
