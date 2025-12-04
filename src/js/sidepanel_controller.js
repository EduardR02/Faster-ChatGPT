import { TokenCounter, StreamWriter, StreamWriterSimple, Footer, ArenaRatingManager } from './utils.js';
import { SidepanelRenameManager } from './rename_manager.js';
import { SidepanelChatCore } from './chat_core.js';


export class SidepanelController {
    constructor(options) {
        const {
            stateManager,
            chatUI,
            apiManager,
            chatStorage,
            onTitleChange = null
        } = options;

        this.stateManager = stateManager;
        this.chatUI = chatUI;
        this.apiManager = apiManager;
        this.chatStorage = chatStorage;
        this.renameManager = new SidepanelRenameManager(chatStorage);
        this.arenaRatingManager = new ArenaRatingManager();
        this.arenaRatingManager.initDB();
        this.chatCore = new SidepanelChatCore(
            chatStorage,
            stateManager,
            this.chatUI.getChatHeader(),
            onTitleChange
        );
    }

    getContinueFunc(messageIndex, secondaryIndex = 0, modelKey = null) {
        if (!this.chatUI.continueFunc) return undefined;
        return () => this.chatUI.continueFunc(messageIndex, secondaryIndex, modelKey);
    }

    initStates(chatName) {
        this.handleDefaultArenaChoice();
        this.stateManager.resetChatState();
        this.chatUI.updateIncognito();
        this.chatCore.reset(chatName);
    }

    async makeApiCall(model, isRegen = false) {
        const api_provider = this.apiManager.getProviderForModel(model);
        const tokenCounter = new TokenCounter(api_provider);
        this.chatCore.initThinkingChat();
        const messages = this.chatCore.getMessagesForAPI(model);

        const abortController = new AbortController();
        let manualAborted = false;
        const manualAbort = () => {
            manualAborted = true;
            abortController.abort();
        };
        this.chatUI.addManualAbortButton(model, manualAbort);

        const streamWriter = this.createStreamWriter(
            this.chatUI.getContentDiv(model),
            this.stateManager.isArenaModeActive,
            api_provider
        );

        // For local models, fetch the actual model name from the server before making API call
        let actualModelId = model;
        let displayModelName = model;
        const options = {};
        if (api_provider === 'llamacpp') {
            const modelInfo = await this.apiManager.getLocalModelConfig();
            actualModelId = modelInfo.raw;
            displayModelName = modelInfo.display;
            options.localModelOverride = modelInfo;
        }

        // Disable streaming for image models (images are generated all at once)
        const isImageModel = this.apiManager.isImageModel(model);
        const streamResponse = !isImageModel && this.stateManager.getSetting('stream_response');
        let success = false;
        let responseResult;
        
        try {
            responseResult = await this.apiManager.callApi(
                actualModelId,
                messages,
                tokenCounter,
                streamResponse ? streamWriter : null,
                abortController,
                options
            );

            if (!streamResponse) {
                responseResult.forEach(msg => {
                    if (msg.type === 'image') {
                        if (streamWriter.parts.at(-1).content.length > 0) {
                            streamWriter.nextPart();
                        }
                        const part = streamWriter.parts.at(-1);
                        part.content = [msg.content];
                        part.type = 'image';
                        if (msg.thoughtSignature) part.thoughtSignature = msg.thoughtSignature;
                    } else {
                        streamWriter.processContent(msg.content, msg.type === 'thought');
                        if (msg.thoughtSignature) {
                            streamWriter.parts.at(-1).thoughtSignature = msg.thoughtSignature;
                        }
                    }
                });
            }
            success = true;
        } catch (error) {
            if (!manualAborted) {
                const uiMessage = this.apiManager.getUiErrorMessage(error);
                this.chatUI.addErrorMessage(uiMessage);
            }
        } finally {
            tokenCounter.updateLifetimeTokens();
            this.chatUI.removeManualAbortButton(model);
            const isThinkingFunc = success ? null : () => false;
            await streamWriter.addFooter(this.createMessageFooter(tokenCounter, model, isThinkingFunc));
        }

        if (success) {
            // Update UI with the actual model display name for local models
            if (api_provider === 'llamacpp') {
                this.chatUI.updateLastMessageModelName(displayModelName);
                if (this.stateManager.isArenaModeActive) {
                    const modelKey = this.stateManager.getArenaModelKey(model);
                    await this.chatCore.setArenaModelName(modelKey, displayModelName);
                    this.chatUI.setArenaModelDisplayName(model, displayModelName);
                }
            }

            // For normal mode, save with display name; for arena keep logical id for routing
            const saveModel = this.stateManager.isArenaModeActive ? model : displayModelName;
            await this.saveResponseMessage(streamWriter.parts, saveModel, isRegen);

            const latest = this.chatCore.getLatestMessage();
            if (!this.stateManager.isArenaModeActive && this.chatUI.continueFunc && latest?.role === 'assistant' && !latest.responses) {
                const messageIndex = this.chatCore.getLength() - 1;
                const secondaryIndex = latest.contents?.length ? latest.contents.length - 1 : 0;
                this.chatUI.renderContinueForAssistant(messageIndex, true, secondaryIndex);
            }
            // Thinking loop routing must use logical model id
            this.handleThinkingMode(model, isRegen);
        }
    }

    async saveResponseMessage(message, model, isRegen) {
        if (this.stateManager.isArenaModeActive) {
            await this.chatCore.updateArena(message, model, this.stateManager.getArenaModelKey(model));
            return;
        }
        if (isRegen && !this.stateManager.thinkingMode) {
            await this.chatCore.appendRegenerated(message, model);
            return;
        }
        await this.chatCore.addAssistantMessage(message, model);
    }

    handleArenaChoice(choice) {
        const currentMessage = this.chatCore.getLatestMessage();
        this.chatUI.removeArenaFooter();
        
        const winnerIndex = this.determineWinnerIndex(choice);
        const winner = winnerIndex !== -1 ? this.stateManager.getArenaModel(winnerIndex) : null;
        
        const continued_with = winner ? 
            (winnerIndex === 0 ? "model_a" : "model_b") : 
            "none";
        this.chatCore.updateArenaMisc(choice, continued_with);
        const [modelA, modelB] = this.stateManager.getArenaModels();
        if (['model_a', 'model_b', 'draw', 'draw(bothbad)'].includes(choice)) {
            this.arenaRatingManager.addMatchAndUpdate(modelA, modelB, choice);
        }
        const ratings = [this.arenaRatingManager.getModelRating(modelA), this.arenaRatingManager.getModelRating(modelB)];
        this.chatUI.resolveArena(choice, currentMessage.continued_with, null, ratings);
        this.stateManager.clearArenaState();
        
        if (choice === 'no_choice(bothbad)') {
            this.initApiCall();
        }
    }

    // Private methods
    createStreamWriter(contentDiv, isArenaMode, apiProvider) {
        if (this.stateManager.getSetting('stream_response') && 
            (isArenaMode || apiProvider === "gemini")) {
            return new StreamWriter(
                contentDiv,
                (role, isThought) => this.chatUI.produceNextContentDiv(role, isThought),
                () => this.chatUI.scrollIntoView(),
                isArenaMode ? 2500 : 5000
            );
        }
        return new StreamWriterSimple(
            contentDiv,
            (role, isThought) => this.chatUI.produceNextContentDiv(role, isThought),
            () => this.chatUI.scrollIntoView()
        );
    }

    createMessageFooter(tokenCounter, model, isThinkingFunc = null) {
        return new Footer(
            tokenCounter.inputTokens,
            tokenCounter.outputTokens,
            this.stateManager.isArenaModeActive,
            isThinkingFunc !== null ? isThinkingFunc : () => this.stateManager.isThinking(model),
            () => this.regenerateResponse(model)
        );
    }

    handleThinkingMode(model, isRegen) {
        if (this.stateManager.isInactive(model)) return;
        const latest = this.chatCore.getLatestMessage();
        const secondaryIndex = latest?.contents?.length ?? 0;
        const messageIndex = Math.max(this.chatCore.getLength() - 1, 0);
        const continueFunc = this.getContinueFunc(messageIndex, secondaryIndex);
        this.chatUI.regenerateResponse(model, isRegen, true, continueFunc, false);
        this.makeApiCall(model, isRegen);
    }

    async initApiCall() {
        this.chatUI.initScrollListener();
        this.stateManager.updateThinkingMode();
        this.stateManager.updateArenaMode();

        if (this.stateManager.isArenaModeActive) {
            await this.initArenaCall();
        } else {
            this.stateManager.initThinkingState();
            const model = this.stateManager.getSetting('current_model');
            const nextIndex = this.chatCore.getLength();
            const continueFunc = this.getContinueFunc(nextIndex, 0);
            this.chatUI.addMessage('assistant', [], { model, hideModels: !this.stateManager.getSetting('show_model_name'), continueFunc, allowContinue: false });
            await this.makeApiCall(model);
        }
    }

    async initArenaCall() {
        const enabledModels = this.stateManager.getSetting('arena_models');
        if (enabledModels.length < 2) {
            this.chatUI.addErrorMessage("Not enough models enabled for Arena mode.");
            return;
        }

        const [model1, model2] = this.getRandomArenaModels(enabledModels);
        
        this.stateManager.initArenaResponse(model1, model2);
        this.stateManager.initThinkingState();
        this.chatCore.initThinkingChat();
        const messageIndex = this.chatCore.getLength();
        const continueFunc = this.getContinueFunc(messageIndex);
        this.chatUI.createArenaMessage(null, { continueFunc, messageIndex });
        this.chatCore.initArena(model1, model2);
        
        await Promise.all([
            this.makeApiCall(model1),
            this.makeApiCall(model2)
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

    async initPrompt(context) {
        let promptString = context.mode + "_prompt";
        try {
            await this.stateManager.loadPrompt(promptString);
            
            let prompt = this.stateManager.getPrompt('active_prompt');
            if (context.mode === "selection") {
                prompt += `\n"""[${context.url}]"""\n"""[${context.text}]"""`;
            }
            
            this.chatCore.insertSystemMessage(prompt);
        } catch (error) {
            this.chatUI.addErrorMessage(`Error loading ${context.mode} prompt file:\n${error.message}`);
            throw error;
        }
    }

    sendUserMessage() {
        const text = this.chatUI.getTextareaText().trim();
        if (!text) return;
        this.chatUI.setTextareaText('');
        this.handleDefaultArenaChoice();
        const latestBefore = this.chatCore.getLatestMessage();
        if (latestBefore?.role === 'assistant' && !latestBefore.responses && this.chatUI.continueFunc) {
            const messageIndex = this.chatCore.getLength() - 1;
            const secondaryIndex = latestBefore.contents?.length ? latestBefore.contents.length - 1 : 0;
            this.chatUI.renderContinueForAssistant(messageIndex, false, secondaryIndex);
        }
        this.chatCore.addUserMessage(text);
        const idx = this.chatCore.getLength() - 1;
        const latest = this.chatCore.getLatestMessage();
        const continueFunc = this.getContinueFunc(idx, latest.contents.length - 1);
        this.chatUI.addMessage('user', latest.contents.at(-1), { continueFunc });
        this.chatUI.removeRegenerateButtons();
        this.chatUI.removeCurrentRemoveMediaButtons();
        this.initApiCall();
    }

    collectPendingUserMessage() {
        const text = this.chatUI.getTextareaText().trim();
        return this.chatCore.collectPendingUserMessage(text);
    }

    appendPendingMedia(media, type) {
        media.forEach(item => {
            const currentId = this.chatCore.appendMedia(item, type);
            if (type === 'image') this.chatUI.appendImage(item, () => this.chatCore.removeMedia(currentId));
            else this.chatUI.appendFile(item, () => this.chatCore.removeMedia(currentId));
        });
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

    regenerateResponse(model) {
        this.stateManager.updateThinkingMode();
        this.stateManager.initThinkingState(model);
        const actualModel = this.stateManager.isArenaModeActive ? model : 
            this.stateManager.getSetting('current_model');

            const hideModels = !this.stateManager.getSetting('show_model_name') || this.stateManager.isArenaModeActive;
        const latest = this.chatCore.getLatestMessage();
        const secondaryIndex = latest?.contents?.length ?? 0;
        const messageIndex = Math.max(this.chatCore.getLength() - 1, 0);
        const continueFunc = this.getContinueFunc(messageIndex, secondaryIndex);
        this.chatUI.regenerateResponse(actualModel, true, hideModels, continueFunc, false); 
            
        if (this.stateManager.isArenaModeActive && this.stateManager.thinkingMode) {
            this.chatCore.initThinkingChat();
            const [modelA, modelB] = this.stateManager.getArenaModels();
            this.chatCore.initArena(modelA, modelB);
        }

        this.makeApiCall(actualModel, true);
    }
}
