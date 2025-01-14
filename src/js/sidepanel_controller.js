import { TokenCounter, StreamWriter, StreamWriterSimple, Footer } from './utils.js';

export class SidepanelController {
    constructor(options) {
        const {
            stateManager,
            chatUI,
            apiManager,
            chatStorage
        } = options;

        this.stateManager = stateManager;
        this.chatUI = chatUI;
        this.apiManager = apiManager;
        this.chatStorage = chatStorage;
        
        this.messages = [];
        this.pendingMessage = {};
        this.currentChat = null;
        this.initialPrompt = "";
        this.thoughtLoops = [0, 0];
        this.pendingFiles = {};
        this.pendingImages = [];
        this.tempMediaId = 0;
    }

    initStates(chatName) {
        this.handleDefaultArenaChoice();
        this.thoughtLoops = [0, 0];
        this.stateManager.resetChatState();
        this.chatUI.clearConversation();
        this.currentChat = this.chatStorage.createNewChatTracking(chatName);
        this.pendingMessage = {};
        this.messages = [];
        this.pendingFiles = {};
        this.pendingImages = [];
        this.tempMediaId = 0;
    }

    async makeApiCall(model, thoughtProcessState) {
        const contentDiv = this.chatUI.getContentDiv(model);
        const msgs = this.messages.concat(this.resolvePendingHandler(model));
        const api_provider = this.apiManager.getProviderForModel(model);
        const tokenCounter = new TokenCounter(api_provider);
        const isArenaMode = this.stateManager.isArenaModeActive;

        try {
            let streamWriter = this.createStreamWriter(contentDiv, isArenaMode, api_provider);
            const response = await this.apiManager.callApi(
                model, 
                msgs, 
                tokenCounter, 
                this.stateManager.getSetting('stream_response') ? streamWriter : null
            );

            await this.processApiResponse(response, streamWriter, tokenCounter, thoughtProcessState, model);
            
        } catch (error) {
            this.chatUI.addErrorMessage(`Error: ${error.message}`);
        }
    }

    handleArenaChoice(choice) {;
        const currentMessage = this.getCurrentArenaMessage();
        
        // Update message state
        currentMessage.choice = choice;
        const winnerIndex = this.determineWinnerIndex(choice);
        const winner = winnerIndex !== -1 ? this.stateManager.getArenaModel(winnerIndex) : null;
        
        currentMessage.continued_with = winner ? 
            (winnerIndex === 0 ? "model_a" : "model_b") : 
            "none";

        // Update UI and state
        this.chatUI.resolveArena(choice, currentMessage.continued_with);
        
        // Save if needed
        if (this.currentChat.id !== null && this.stateManager.shouldSave) {
            this.chatStorage.updateArenaMessage(
                this.currentChat.id, 
                this.currentChat.messages.length - 1,
                currentMessage
            );
        }

        // Clear arena state
        this.stateManager.clearArenaState();
        
        // Handle continuation
        if (choice === 'no_choice(bothbad)') {
            this.initApiCall();
        } else if (winner) {
            this.resolvePending(winner);
        }
    }

    addToPending(message, model, done = true, role = 'assistant') {
        if (!this.stateManager.isArenaModeActive) {
            this.addToNormalPending(message, model, role);
        } else {
            this.addToArenaPending(message, model);
        }
    }

    resolvePending(model = null) {
        this.messages.push(...this.resolvePendingHandler(model));
        this.pendingMessage = {};
    }

    // Private methods
    createStreamWriter(contentDiv, isArenaMode, apiProvider) {
        if (this.stateManager.getSetting('stream_response') && 
            (isArenaMode || apiProvider === "gemini")) {
            return new StreamWriter(
                contentDiv,
                () => this.chatUI.scrollIntoView(),
                isArenaMode ? 2500 : 5000
            );
        }
        return new StreamWriterSimple(
            contentDiv,
            () => this.chatUI.scrollIntoView()
        );
    }

    async processApiResponse(response, streamWriter, tokenCounter, thoughtProcessState, model) {
        if (!this.stateManager.getSetting('stream_response')) {
            if (response?.thoughts !== undefined) {
                streamWriter.setThinkingModel();
                streamWriter.processContent(response.thoughts, true);
                streamWriter.processContent(response.text);
            } else {
                streamWriter.processContent(response);
            }
        }

        const msgFooter = this.createMessageFooter(tokenCounter, thoughtProcessState, model);
        await streamWriter.addFooter(
            msgFooter,
            (msg, done) => this.addToPending(msg, model, done)
        );

        tokenCounter.updateLifetimeTokens();
        this.handleThinkingMode(streamWriter.fullMessage, thoughtProcessState, model);
    }

    createMessageFooter(tokenCounter, thoughtProcessState, model) {
        return new Footer(
            tokenCounter.inputTokens,
            tokenCounter.outputTokens,
            this.stateManager.isArenaModeActive,
            thoughtProcessState,
            () => this.regenerateResponse(model)
        );
    }

    handleThinkingMode(msg, thoughtProcessState, model) {
        if (thoughtProcessState !== "thinking") return;
        
        const idx = this.chatUI.getContentDivIndex(model);
        this.thoughtLoops[idx]++;
        
        const thinkMore = msg.includes("*continue*");
        const maxItersReached = this.thoughtLoops[idx] >= this.stateManager.getSetting('loop_threshold');
        
        let nextThinkingState = thinkMore && !maxItersReached ? "thinking" : "solver";
        
        if (thinkMore && !maxItersReached) {
            this.addToPending("*System message: continue thinking*", model, false, 'user');
        } else {
            const systemMsg = maxItersReached ? 
                "*System message: max iterations reached, solve now*" : 
                "*System message: solve now*";
            this.addToPending(systemMsg, model, false, 'user');
            this.togglePrompt("solver");
        }
        
        this.chatUI.onContinue(this.chatUI.getContentDiv(model), nextThinkingState);
        this.makeApiCall(model, nextThinkingState);
    }

    async initApiCall() {
        this.chatUI.initScrollListener();
        this.stateManager.updateThinkingMode();
        this.stateManager.updateArenaMode();
        
        const thinkingState = this.stateManager.thinkingMode ? "thinking" : "none";
        this.togglePrompt(thinkingState);
        this.thoughtLoops = [0, 0];

        if (this.stateManager.isArenaModeActive) {
            await this.initArenaCall();
        } else {
            this.chatUI.addMessage('assistant');
            await this.makeApiCall(this.stateManager.getSetting('current_model'), thinkingState);
        }
    }

    async initArenaCall() {
        const enabledModels = this.stateManager.getSetting('arena_models');
        if (enabledModels.length < 2) {
            this.chatUI.addErrorMessage("Not enough models enabled for Arena mode.");
            return;
        }

        const [model1, model2] = this.getRandomArenaModels(enabledModels);
        const thinkingState = this.stateManager.thinkingMode ? "thinking" : "none";
        
        this.stateManager.initArenaResponse(model1, model2);
        this.chatUI.createArenaMessage();
        this.currentChat.messages.push(this.chatStorage.initArenaMessage(model1, model2));
        
        await Promise.all([
            this.makeApiCall(model1, thinkingState),
            this.makeApiCall(model2, thinkingState)
        ]);
        this.chatUI.addArenaFooter(this.handleArenaChoice.bind(this));
    }

    getRandomArenaModels(models) {
        const shuffled = [...models];
        for (let i = shuffled.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }
        return [shuffled[0], shuffled[1]];
    }

    addToNormalPending(message, model, role) {
        const historyMsg = { role, content: message, model };
        this.currentChat.messages.push(historyMsg);

        if (this.currentChat.id !== null && this.stateManager.shouldSave) {
            this.chatStorage.addMessages(
                this.currentChat.id, 
                [historyMsg], 
                this.currentChat.messages.length - 1
            );
        }

        this.pendingMessage[model] = this.pendingMessage[model] || [];
        this.pendingMessage[model].push({ role, content: message });
    }

    addToArenaPending(message, model) {
        const currentMessage = this.getCurrentArenaMessage();        
        currentMessage.responses[this.stateManager.getArenaModelKey(model)].messages.push(message);
        
        if (this.currentChat.id !== null && this.stateManager.shouldSave) {
            this.chatStorage.updateArenaMessage(
                this.currentChat.id,
                this.currentChat.messages.length - 1,
                currentMessage
            );
        }

        this.pendingMessage[model] = this.pendingMessage[model] || [];
        this.pendingMessage[model].push({ role: 'assistant', content: message });
    }

    resolvePendingHandler(model = null) {
        if (Object.keys(this.pendingMessage).length === 0) return [];
        
        if (model && model in this.pendingMessage) {
            return this.pendingMessage[model];
        }
        
        if (model && this.stateManager.isArenaModeActive) {
            return [];
        }
        
        if (this.stateManager.getSetting('current_model') in this.pendingMessage) {
            return this.pendingMessage[this.stateManager.getSetting('current_model')];
        }
        
        return this.pendingMessage[Object.keys(this.pendingMessage)[0]];
    }

    async initPrompt(context) {
        let promptString = context.mode + "_prompt";
    
        try {
            await this.stateManager.loadPrompt(promptString);
            this.messages = [];
            this.pendingMessage = {};
            
            let prompt = this.stateManager.getPrompt('active_prompt');
            if (context.mode === "selection") {
                prompt += `\n"""[${context.url}]"""\n"""[${context.text}]"""`;
            }
            
            this.appendContext(prompt, 'system');
            this.initialPrompt = prompt;
        } catch (error) {
            this.chatUI.addErrorMessage(`Error loading ${context.mode} prompt file:\n${error.message}`);
            throw error;
        }
    }
    
    appendContext(message, role) {
        this.messages.push({ role, content: message });
        this.realizePendingFiles(role);
    
        if (this.currentChat && role === 'user') {
            if (this.currentChat.id === null || this.stateManager.isContinuedChat) {
                if (this.stateManager.isContinuedChat) {
                    this.currentChat.messages.push(this.messages[this.messages.length - 1]);
                }
                else {
                    this.currentChat.messages = [...this.messages];
                }
                this.stateManager.isContinuedChat = false;
                
                if (this.stateManager.shouldSave) {
                    this.chatStorage.createChatWithMessages(
                        this.currentChat.title, 
                        this.currentChat.messages
                    ).then(res => this.currentChat.id = res.chatId);
                }
            } else {
                const newMsg = this.messages[this.messages.length - 1];
                this.currentChat.messages.push(newMsg);
    
                if (this.currentChat.id !== null && this.stateManager.shouldSave) {
                    this.chatStorage.addMessages(
                        this.currentChat.id, 
                        [newMsg], 
                        this.currentChat.messages.length - 1
                    );
                }
            }
        }
    }
    
    realizePendingFiles(role) {
        if (role !== 'user') return;
        
        if (this.pendingImages.length > 0) {
            this.messages[this.messages.length - 1].images = this.pendingImages;
            this.pendingImages = [];
        }

        if (Object.keys(this.pendingFiles).length > 0) {
            this.messages[this.messages.length - 1].files = [];
            for (const [key, value] of Object.entries(this.pendingFiles)) {
                this.messages[this.messages.length - 1].files.push(value);
            }
            this.chatUI.removeCurrentRemoveMediaButtons();
            this.pendingFiles = {};
        }
    }

    appendPendingImages(images) {
        images.forEach(image => {
            this.pendingImages.push(image);
            this.chatUI.appendImage(image);
        });
    }

    appendPendingFiles(files) {
        files.forEach(file => {
            const currentId = this.tempMediaId;     // ensure that the callback function gets the correct id
            this.pendingFiles[currentId] = file;
            this.chatUI.appendFile(file, () => this.removeFile(currentId));
            this.tempMediaId++;
        });
    }

    removeFile(tempId) {
        delete this.pendingFiles[tempId];
    }

    getCurrentArenaMessage() {
        return this.currentChat.messages[this.currentChat.messages.length - 1];
    }

    determineWinnerIndex(choice) {
        if (['draw', 'reveal', 'ignored'].includes(choice)) {
            return Math.floor(Math.random() * 2);
        }
        if (choice === 'model_a') return 0;
        if (choice === 'model_b') return 1;
        return -1;
    }

    handleDefaultArenaChoice() {
        if (this.stateManager.isArenaModeActive) {
            this.handleArenaChoice('ignored');
        }
    }

    togglePrompt(promptType = "none") {
        if (this.messages.length === 0) return;
        
        switch (promptType) {
            case "thinking":
                this.messages[0].content = this.initialPrompt + "\n\n" + 
                    this.stateManager.getPrompt('thinking');
                break;
            case "solver":
                this.messages[0].content = this.initialPrompt + "\n\n" + 
                    this.stateManager.getPrompt('solver');
                break;
            case "none":
                this.messages[0].content = this.initialPrompt;
        }
    }

    regenerateResponse(model) {
        this.stateManager.updateThinkingMode();
        const thinkingState = this.stateManager.thinkingMode ? "thinking" : "none";
        this.thoughtLoops[this.chatUI.getContentDivIndex(model)] = 0;
        
        const contentDiv = this.chatUI.regenerateResponse(model);
        if (!contentDiv) return;

        this.chatUI.initScrollListener();
        this.discardPending(model);
        
        const actualModel = this.stateManager.isArenaModeActive ? 
            model : 
            this.stateManager.getSetting('current_model');
            
        this.makeApiCall(actualModel, thinkingState);
    }

    discardPending(model = null) {
        if (model && model in this.pendingMessage) {
            delete this.pendingMessage[model];
        } else if (model === null) {
            this.pendingMessage = {};
        }
    }

    buildAPIChatFromHistoryFormat(historyChat, continueFromIndex = null, arenaMessageIndex = null, modelChoice = null) {
        this.currentChat = {
            id: historyChat.meta.chatId,
            title: historyChat.meta.title + " (Continued)",
            messages: (continueFromIndex ? historyChat.messages.slice(0, continueFromIndex + 1) : historyChat.messages)
                .map(({ messageId, timestamp, chatId, ...msg }) => msg)
        };
        const workingMessages = this.currentChat.messages;
    
        this.messages = [];
        this.pendingMessage = {};
        for (let i = 0; i < workingMessages.length; i++) {
            const msg = workingMessages[i];
            const isLastMessage = i === workingMessages.length - 1;

            if (isLastMessage && msg.role === 'user') {
                this.currentChat.messages.pop();
                return;
            }
    
            // If it's not an assistant message, add it
            if (msg.role !== 'assistant') {
                const { chatId, messageId, timestamp, ...rest } = msg;
                this.messages.push(rest);
                continue;
            }
    
            // Find next user message
            let nextUserIndex = workingMessages.findIndex((m, idx) =>
                idx > i && ('content' in m && m.role === 'user')
            );
    
            // For assistant messages (both regular and arena), 
            // take if it's the last one before next user (or end of messages)
            if (nextUserIndex === -1 ? (i === workingMessages.length - 1) : (i === nextUserIndex - 1)) {
                if ('content' in msg) {
                    this.messages.push({
                        role: 'assistant',
                        content: msg.content
                    });
                } else {  // arena message
                    // If it's the last message and we're continuing from it, use modelChoice and arenaMessageIndex
                    const model = (isLastMessage ? modelChoice : msg.continued_with) || 'model_a';
                    // this case should actually not be possible, because 'none' means draw(bothbad), which means the arena is full regenerated,
                    // which means this can't be the last message before a user message
                    if (!isLastMessage && model === 'none') continue;
                    const messages = msg.responses[model].messages;
                    const index = (isLastMessage && arenaMessageIndex !== null) ? arenaMessageIndex : messages.length - 1;
    
                    this.messages.push({
                        role: 'assistant',
                        content: messages[index],
                    });
                }
                // Skip to the next user message to avoid duplicates
                i = nextUserIndex !== -1 ? nextUserIndex - 1 : i;
            }
        }
    }
}