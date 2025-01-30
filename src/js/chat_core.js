import { SidepanelRenameManager } from './rename_manager.js';


export class ChatCore {
    constructor(chatStorage) {
        this.chatStorage = chatStorage;
        this.currentChat = null // Raw DB state
        this.init();
    }

    init(title = "") {
        this.currentChat = this.chatStorage.createNewChatTracking(title);
    }

    reset(title = "") {
        this.init(title);
    }

    miscUpdate(update = {}) {
        if ("messages" in update) return;
        this.currentChat = { ...this.currentChat, ...update }
    }

    replaceLastFromHistory(message) {
        this.currentChat.messages.pop();
        this.addFromHistory(message);
    }

    addFromHistory(message) {
        const { chatId, messageId, timestamp, ...msg } = message;
        this.currentChat.messages.push(msg);
    }

    addMultipleFromHistory(messages) {
        messages.forEach(msg => this.addFromHistory(msg));
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

    getSystemPrompt() {
        if (this.currentChat.messages.length === 0) return undefined;
        return this.currentChat.messages[0].contents[0][0].content;
    }

    async loadChat(chatId) {
        this.currentChat = await this.chatStorage.loadChat(chatId);
        return this.currentChat;
    }

    getChat() {
        return this.currentChat;
    }
}


export class SidepanelChatCore extends ChatCore {
    constructor(chatStorage, stateManager, chatHeader) {
        super(chatStorage);
        this.stateManager = stateManager;
        this.renameManager = new SidepanelRenameManager(chatStorage);
        this.continuedChatOptions = {};
        this.chatHeader = chatHeader;
        this.tempMediaId = 0;
        this.pendingMedia = {};
        this.thinkingChat = null;
    }

    reset(title = "") {
        super.reset(title);
        this.continuedChatOptions = {};
        this.tempMediaId = 0;
        this.pendingMedia = {};
        this.thinkingChat = null;
    }

    initThinkingChat() {
        if (this.thinkingChat || !this.stateManager.thinkingMode) return;
        this.thinkingChat = new ThinkingChat(this.stateManager);
    }

    appendMedia(media, type) {
        const mediaId = this.tempMediaId;
        this.pendingMedia[mediaId] = { media, type };
        this.tempMediaId++;
        return mediaId;
    }

    removeMedia(mediaId) {
        delete this.pendingMedia[mediaId];
    }

    realizeMedia(message) {
        if (message.role !== 'user') return;
        let images = [];
        let files = [];
        for (const mediaId in this.pendingMedia) {
            const { media, type } = this.pendingMedia[mediaId];
            if (type === 'image') images.push(media);
            else files.push(media);
        }
        if (images.length > 0) message.images = images;
        if (files.length > 0) message.files = files;
        this.pendingMedia = {};
    }

    async appendRegenerated(message, model) {
        message.forEach(msg => msg.model = model);
        this.getLatestMessage().contents.push(message);
        await this.updateSaved();
    }

    initArena(modelA, modelB) {
        const initialMessage = this.chatStorage.initArenaMessage(modelA, modelB);
        if (this.thinkingChat) this.thinkingChat.message = initialMessage;
        else this.currentChat.messages.push(initialMessage);
    }

    async updateArena(message, model, modelKey) {
        if (this.thinkingChat) {
            this.thinkingChat.addMessage(message, model, modelKey);
            if (this.thinkingChat.done) this.commitThinkingChat();
        } else {
            this.getLatestMessage().responses[modelKey].messages.push(message);
            await this.updateSaved();
        }
    }

    async updateArenaMisc(choice = null, continued_with = null) {
        const message = this.getLatestMessage();
        if (choice) message.choice = choice;
        if (continued_with) message.continued_with = continued_with;
        await this.updateSaved();
    }

    async addAssistantMessage(message, model) {
        message.forEach(msg => msg.model = model);
        const fullMessage = { role: 'assistant', contents: [message] };
        if (this.thinkingChat) {
            this.thinkingChat.addMessage(fullMessage, model);
            if (this.thinkingChat.done) this.commitThinkingChat();
        } else {
            this.currentChat.messages.push(fullMessage);
            await this.saveNew();
        }
    }

    async addUserMessage(message = "") {
        const newMessage = {
            role: 'user',
            contents: [[{ type: 'text', content: message }]],
        };
        this.realizeMedia(newMessage);
        this.currentChat.messages.push(newMessage);
        await this.saveNew();
    }

    insertSystemMessage(message = "") {
        const systemMessage = { role: 'system', contents: [[{ type: 'text', content: message }]] };
        if (this.currentChat.messages.length === 0) {
            this.currentChat.messages.push(systemMessage);
        }
        else if (this.currentChat.messages[0].role === 'system') {
            this.currentChat.messages[0] = systemMessage;
        }
        else {
            this.currentChat.messages.unshift(systemMessage);
        }
    }

    async saveNew() {
        if (!this.stateManager.shouldSave) return;
        if (Object.keys(this.continuedChatOptions).length > 0) {
            const options = this.continuedChatOptions;
            this.continuedChatOptions = {};
            if (this.canContinueWithSameChatId(options, this.currentChat.messages[options.index])) {
                const toAdd = this.currentChat.messages.length - options.fullChatLength;
                if (toAdd > 0) await this.addMessagesToExistingChat(toAdd);
                return;
            }
            // If can't continue with same ID, create new chat with continued-from reference
            await this.createNewChat(this.currentChat.chatId, false);
            return;
        }
        if (!this.currentChat.chatId) await this.createNewChat();
        else await this.addMessagesToExistingChat();
    }

    async updateSaved() {
        if (!this.stateManager.shouldSave) return;
        await this.chatStorage.updateMessage(this.getChatId(), this.getLength() - 1, this.getLatestMessage());
    }

    async createNewChat(continuedFromId = null, shouldAutoRename = true) {
        await this.chatStorage.createChatWithMessages(
            this.currentChat.title, 
            this.currentChat.messages,
            continuedFromId
        ).then(res => {
            this.currentChat.chatId = res.chatId;
            if (shouldAutoRename) {
                this.renameManager.autoRename(this.currentChat.chatId, this.chatHeader);
            }
        });
    }

    async addMessagesToExistingChat(count = 1) {
        await this.chatStorage.addMessages(
            this.currentChat.chatId, 
            this.currentChat.messages.slice(-count), 
            this.currentChat.messages.length - count
        );
    }

    buildFromDB(dbChat, index = null, secondaryIndex = null, modelKey = null) {
        this.currentChat = {
            ...dbChat,
            messages: dbChat.messages.slice(0, index != null ? index + 1 : Infinity).map(({ messageId, timestamp, chatId, ...msg }) => msg),
        }
        if (secondaryIndex != null) {
            const lastMessage = this.currentChat.messages.at(-1);
            if (modelKey != null) {
                lastMessage.responses[modelKey].messages = lastMessage.responses[modelKey].messages.slice(0, secondaryIndex + 1);
                lastMessage.continued_with = modelKey;
            }
            else {
                if (lastMessage.role === 'user') {
                    this.currentChat.messages.pop();
                    return;
                }
                lastMessage.contents = lastMessage.contents.slice(0, secondaryIndex + 1);
            }
        }
    }

    getMessagesForAPI(model = null) {
        // for now like this, will have to change if multiple thoughts or messages possible in a single response
        const messages = this.currentChat.messages.map(msg => {
            if (msg.role === 'user' || msg.role === 'system') {
                const { contents, ...message } = msg;
                return { ...message, content: contents.at(-1).at(-1).content };
            }
            if (msg.responses) {
                if (!msg.continued_with || msg.continued_with === "none") return undefined;
                return { role: msg.role, content: msg.responses[msg.continued_with].messages.at(-1).at(-1).content};
            }
            return { role: msg.role, content: msg.contents.at(-1).at(-1).content };
        }).filter(msg => msg !== undefined);
        if (messages.at(-1).role === 'assistant') {
            messages.pop();
        }
        if (!model) return messages;
        if (this.stateManager.thinkingMode) this.thinkingChat.getMessagesForAPI(messages, model);
        return messages;
    }

    commitThinkingChat() {
        if (!this.thinkingChat) return;
        if (this.getLatestMessage()?.role === 'assistant') {
            const latestMessage = this.getLatestMessage();
            if (this.getLatestMessage().responses) {
                ['model_a', 'model_b'].forEach(modelKey => {
                    latestMessage.responses[modelKey].messages.push(this.thinkingChat.message.responses[modelKey].messages.at(-1));
                });
            }
            else {
                latestMessage.contents.push(this.thinkingChat.message.contents.at(-1));
            }
            this.updateSaved();
            this.thinkingChat = null;
            return;
        }
        
        this.currentChat.messages.push(this.thinkingChat.message);
        this.thinkingChat = null;
        this.saveNew();
    }

    canContinueWithSameChatId(options, userMsg = null) {
        const { lastMessage, index, secondaryIndex, modelChoice, fullChatLength, secondaryLength } = options;
        if (!lastMessage || index == null || secondaryIndex == null || secondaryLength == null || fullChatLength == null) return false;
        if (fullChatLength !== index + 1) return false;
        if (secondaryLength !== secondaryIndex + 1) return false;

        const role = lastMessage.role;
        return role === 'system' || 
               (role === 'user' && this.isUserMessageEqual(lastMessage, userMsg)) ||
               (role === 'assistant' && !lastMessage.responses && lastMessage.contents.length === secondaryIndex + 1) ||
               (secondaryIndex != null && 
                modelChoice && modelChoice !== "none" &&
                lastMessage.continued_with === modelChoice && 
                lastMessage.responses[modelChoice].messages.length === secondaryIndex + 1);
    }

    isUserMessageEqual(msg1, msg2) {
        if (!msg1 || !msg2) return false;

        let isContentSame = true;
        msg1.contents.forEach((item, index) => {
            if (item[0].content !== msg2.contents[index][0]?.content) {
                isContentSame = false;
            }
        });
        if (!isContentSame) return false;

        if (msg1.files?.length !== msg2.files?.length) return false;
        if (msg1.images?.length !== msg2.images?.length) return false;
        if (msg1.files) {
            for (let i = 0; i < msg1.files.length; i++) {
                if (msg1.files[i].name !== msg2.files[i].name || msg1.files[i].content !== msg2.files[i].content) return false;
            }
        }
        if (msg1.images) {
            for (let i = 0; i < msg1.images.length; i++) {
                if (msg1.images[i] !== msg2.images[i]) return false;
            }
        }
        return true;
    }

    isDoneThinking() {
        return !this.thinkingChat || this.thinkingChat.done;
    }

    collectPendingUserMessage(text) {
        const message = {role: 'user', contents: [[{type: 'text', content: text}]]};
        this.realizeMedia(message);
        if (!text && message.images?.length === 0 && message.files?.length === 0) return null;
        return message;
    }
}


class ThinkingChat {
    constructor(stateManager) {
        this.message = null;
        this.thinkingLoops = [0, 0];
        this.stateManager = stateManager; // For prompt toggling and state checks
        this.done = false;
        this.loopThreshold = this.stateManager.getSetting('loop_threshold')
    }

    getLatestThinking(model) {
        if (!this.message) return null;
        if (this.message.responses) {
            const modelKey = this.stateManager.getArenaModelKey(model);
            if (this.message.responses[modelKey].messages.length === 0) return null;
        }
        let messages = null
        if (this.message.responses) { // Arena mode
            if (!model) return null;
            const modelKey = this.stateManager.getArenaModelKey(model);
            messages = this.message.responses[modelKey].messages;
        } else {
            messages = this.message.contents;
        }
        return {
            role: 'assistant',
            content: messages.at(-1).at(-1).content
        };
    }

    getMessagesForAPI(messages, model) {
        const latestThinking = this.getLatestThinking(model);
        if (latestThinking) {
            messages.push(latestThinking);
        }
        let userPrompt = "";
        if (this.stateManager.isThinking(model) && this.message) {
            userPrompt = "Please reflect and improve your thoughts.";
        } else if (this.stateManager.isSolving(model)) {
            userPrompt = "Using the detailed thoughts given to you, please solve now.";
        }
        if (userPrompt) messages.push({ role: 'user', content: userPrompt });
        return this.togglePrompt(messages, model);
    }

    togglePrompt(messages, model) {
        if (messages.length === 0) return messages;

        let prompt = messages[0].content;
        if (messages[0].role !== 'system') prompt = "";

        // Add appropriate prompt based on state
        if (this.stateManager.isThinking(model)) {
            prompt += "\n\n" + this.stateManager.getPrompt('thinking');
        } else if (this.stateManager.isSolving(model)) {
            prompt += "\n\n" + this.stateManager.getPrompt('solver');
        }

        if (messages[0].role === 'system') {
            messages[0].content = prompt;
        } else {
            messages.unshift({ role: 'system', content: prompt });
        }
        return messages;
    }

    addMessage(message, model, modelKey = null) {
        if (this.done) return;
        if (modelKey) {
            // Arena message
            if (this.message.responses[modelKey].messages.length === 0) this.message.responses[modelKey].messages.push([]);
            this.message.responses[modelKey].messages.at(-1).push(...message);
            const index = modelKey === 'model_a' ? 0 : 1;
            const models = this.stateManager.getArenaModels();
            this.updateThinkingState(index, model, modelKey, models);
        } else {
            if (!this.message) this.message = message;
            else this.message.contents.at(-1).push(...message.contents.at(-1));
            this.updateThinkingState(0, model);
        }
    }

    updateThinkingState(index, model, modelKey = null, models = null) {
        this.thinkingLoops[index]++;
        if (this.stateManager.isSolving(model)) {
            this.stateManager.nextThinkingState(model);
            if (!modelKey || this.stateManager.isInactive(models[1 - index])) {
                this.done = true;
            }
            return;
        }
        
        if (this.thinkingLoops[index] >= this.loopThreshold) {
            this.stateManager.nextThinkingState(model);
        }
    }
}