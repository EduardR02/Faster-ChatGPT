export class ChatCore {
    constructor(chatStorage) {
        this.chatStorage = chatStorage;
        this.currentChat = null // Raw DB state
        this.reset();
    }

    reset(title = "") {
        this.currentChat = this.chatStorage.createNewChatTracking(title);
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
}


export class SidepanelChatCore extends ChatCore {
    constructor(chatStorage, stateManager) {
        super(chatStorage);
        this.shouldSave = true;
        this.stateManager = stateManager;
    }

    appendRegenerated(model, message) {
        message.model = model;
        this.currentChat.messages.at(-1).contents.push(message);
    }

    initArena(modelA, modelB) {
        this.currentChat.messages.push(this.chatStorage.initArenaMessage(modelA, modelB));
    }

    updateArena(modelKey, message) {
        this.currentChat.messages.at(-1).responses[modelKey].messages.push(message);

    }

    addAssistantMessage(model, message) {
        message.model = model;
        const fullMessage = { role: 'assistant', contents: [message] };
        this.currentChat.messages.push(fullMessage);
    }

    addUserMessage(message = "", images = [], files = []) {
        const newMessage = {
            role: 'user',
            contents: [{ content: message }],
            ...(images.length && { images }),
            ...(files.length && { files })
        };
        this.currentChat.messages.push(newMessage);
    }

    addSystemMessage(message = "") {
        this.currentChat.messages.push({ role: 'system', contents: [{ content: message }] });
    }

    buildFromDB(dbChat, index = null, secondaryIndex = null, modelKey = null) {
        this.currentChat = {
            ...dbChat,
            messages: dbChat.messages.slice(0, index != null ? index + 1 : Infinity).map(({ messageId, timestamp, chatId, ...msg }) => msg),
        }
        if (secondaryIndex != null) {
            const lastMessage = this.currentChat.messages.at(-1);
            if (modelKey != null) {
                lastMessage.responses[modelKey] = lastMessage.responses[modelKey].slice(0, secondaryIndex + 1);
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
        const messages = this.currentChat.messages.map(msg => {
            if (msg.role === 'user' || msg.role === 'system') {
                const { contents, ...message } = msg;
                return { ...message, content: contents[0].content };
            }
            if (msg.responses) {
                if (!msg.continued_with || msg.continued_with === "none") return undefined;
                return { role: msg.role, content: msg.responses[msg.continued_with].messages.at(-1).parts.at(-1)};
            }
            return { role: msg.role, content: msg.contents.at(-1).parts.at(-1) };
        }).filter(msg => msg !== undefined);
        if (messages.at(-1).role === 'assistant') {
            messages.pop();
        }
        if (!model) return messages;
        return this.togglePrompt(messages, model);
    }

    togglePrompt(messages, model) {
        if (messages.length === 0) return;
    
        let prompt = messages[0].contents[0].content;
        if (messages[0].role !== 'system') prompt = "";
    
        if (this.stateManager.isThinking(model)) {
            prompt += "\n\n" + this.stateManager.getPrompt('thinking');
        } else if (this.stateManager.isSolving(model)) {
            prompt += "\n\n" + this.stateManager.getPrompt('solver');
        }
        
        if (messages[0].role === 'system') {
            messages[0].contents[0].content = prompt;
        } else {
            messages.unshift({ role: 'system', contents: [{ content: prompt }] });
        }
        return messages;
    }

    canContinueWithSameChatId(options, userMsg = null) {
        const { messages, index, secondaryIndex, modelChoice, fullChatLength } = options;
        if (!messages?.length || index == null) return false;
        
        const lastMessage = messages[messages.length - 1];
        if (fullChatLength !== messages.length) return false;
        if (index !== messages.length - 1) return false;
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
        if (msg1.contents[0].content !== msg2.contents[0].content) return false;
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
}