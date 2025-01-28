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
    }

    reset(title = "") {
        super.reset(title);
        this.continuedChatOptions = {};
        this.tempMediaId = 0;
        this.pendingMedia = {};
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

    appendRegenerated(model, message) {
        message.forEach(msg => msg.model = model);
        this.getLatestMessage().contents.push(message);
        this.updateSaved();
    }

    initArena(modelA, modelB) {
        this.currentChat.messages.push(this.chatStorage.initArenaMessage(modelA, modelB));
    }

    updateArena(modelKey, message) {
        this.getLatestMessage().responses[modelKey].messages.push(message);
        this.updateSaved();
    }

    updateArenaMisc(choice = null, continued_with = null) {
        const message = this.getLatestMessage();
        if (choice) message.choice = choice;
        if (continued_with) message.continued_with = continued_with;
        this.updateSaved();
    }

    addAssistantMessage(model, message) {
        message.forEach(msg => msg.model = model);
        const fullMessage = { role: 'assistant', contents: [message] };
        this.currentChat.messages.push(fullMessage);
        this.saveNew();
    }

    addUserMessage(message = "") {
        const newMessage = {
            role: 'user',
            contents: [[{ type: 'text', content: message }]],
        };
        this.realizeMedia(newMessage);
        this.currentChat.messages.push(newMessage);
        this.saveNew();
    }

    addUserMessageWithoutMedia(message = "") {
        this.currentChat.messages.push({ role: 'user', contents: [[{ type: 'text', content: message }]] });
        this.saveNew();
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

    saveNew() {
        if (!this.stateManager.shouldSave) return;
        if (Object.keys(this.continuedChatOptions).length > 0) {
            const options = this.continuedChatOptions;
            this.continuedChatOptions = {};
            if (this.canContinueWithSameChatId(options, this.currentChat.messages[options.index])) {
                const toAdd = this.currentChat.messages.length - options.fullChatLength;
                if (toAdd > 0) this.addMessagesToExistingChat(toAdd);
                return;
            }
            // If can't continue with same ID, create new chat with continued-from reference
            this.createNewChat(this.currentChat.chatId, false);
            return;
        }
        if (!this.currentChat.chatId) this.createNewChat();
        else this.addMessagesToExistingChat();
    }

    updateSaved() {
        if (!this.stateManager.shouldSave) return;
        this.chatStorage.updateMessage(this.getChatId(), this.getLength() - 1, this.getLatestMessage());
    }

    createNewChat(continuedFromId = null, shouldAutoRename = true) {
        this.chatStorage.createChatWithMessages(
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

    addMessagesToExistingChat(count = 1) {
        this.chatStorage.addMessages(
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
                return { ...message, content: contents[0][0].content };
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
        return this.togglePrompt(messages, model);
    }

    togglePrompt(api_messages, model) {
        if (api_messages.length === 0) return;
    
        let prompt = api_messages[0].content;
        if (api_messages[0].role !== 'system') prompt = "";
    
        if (this.stateManager.isThinking(model)) {
            prompt += "\n\n" + this.stateManager.getPrompt('thinking');
        } else if (this.stateManager.isSolving(model)) {
            prompt += "\n\n" + this.stateManager.getPrompt('solver');
        }
        
        if (api_messages[0].role === 'system') {
            api_messages[0].content = prompt;
        } else {
            api_messages.unshift({ role: 'system', content: prompt });
        }
        return api_messages;
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

    collectPendingUserMessage(text) {
        const message = {role: 'user', contents: [[{type: 'text', content: text}]]};
        this.realizeMedia(message);
        if (!text && message.images?.length === 0 && message.files?.length === 0) return null;
        return message;
    }
}