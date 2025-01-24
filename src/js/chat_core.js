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

    replaceLastSimple(message) {
        this.currentChat.messages.pop();
        this.addSimple(message);
    }

    addSimple(message) {
        this.currentChat.messages.push(message);
    }
}


export class SidepanelChatCore {
    constructor(chatStorage, stateManager) {
        this.shouldSave = true;
        this.stateManager = stateManager;
        super(chatStorage);
    }

    appendRegenerated(model, message) {
        message.model = model;
        this.currentChat.messages.at(-1).contents.push(message);
    }

    initArena(modelA, modelB) {
        this.currentChat.messages.push(this.chatStorage.initArenaMessage(modelA, modelB));
    }

    updateArena(modelKey, message) {
        this.currentChat.messages.at(-1).responses[modelKey].push(message);

    }

    addAssistantMessage(model, message) {
        message.model = model;
        fullMessage = { role: 'assistant', contents: [message] };
        this.currentChat.messages.push(fullMessage);
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

    getMessagesForAPI(model) {
        const messages = this.currentChat.messages.map(msg => {
            if (msg.role === 'user' || msg.role === 'system') {
                const { contents, ...message } = msg;
                return { ...message, content: contents[0].content };
            }
            if (msg.responses) {
                if (!msg.continued_with || msg.continued_with === "none") return undefined;
                return { role: msg.role, content: msg.responses[msg.continuedWith].messages.at(-1).parts.at(-1)};
            }
            return { role: msg.role, content: msg.contents.at(-1).parts.at(-1) };
        }).filter(msg => msg !== undefined);
        if (messages.at(-1).role === 'assistant') {
            messages.pop();
        }
        return this.togglePrompt(messages, model);
    }

    togglePrompt(messages, model) {
        if (this.messages.length === 0) return;
    
        let prompt = this.messages[0].contents[0].content;
        if (messages[0].role !== 'system') prompt = "";
    
        if (this.stateManager.isThinking(model)) {
            prompt += "\n\n" + this.stateManager.getPrompt('thinking');
        } else if (this.stateManager.isSolving(model)) {
            prompt += "\n\n" + this.stateManager.getPrompt('solver');
        }
        
        if (messages[0].role === 'system') {
            messages[0].contents.content = prompt;
        } else {
            messages.unshift({ role: 'system', contents: { content: prompt } });
        }
        return messages;
    }
}