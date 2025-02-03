import { TokenCounter, StreamWriter, StreamWriterSimple, Footer, ArenaRatingManager } from './utils.js';
import { SidepanelRenameManager } from './rename_manager.js';
import { SidepanelChatCore } from './chat_core.js';


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
        this.renameManager = new SidepanelRenameManager(chatStorage);
        this.arenaRatingManager = new ArenaRatingManager();
        this.arenaRatingManager.initDB();
        this.chatCore = new SidepanelChatCore(chatStorage, stateManager, this.chatUI.getChatHeader());
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

        const streamResponse = this.stateManager.getSetting('stream_response');
        let success = false;
        let responseResult;
        try {
            responseResult = await this.apiManager.callApi(
                model,
                messages,
                tokenCounter,
                streamResponse ? streamWriter : null,
                abortController
            );

            if (!streamResponse) {
                responseResult.forEach(msg =>
                    streamWriter.processContent(msg.content, msg.type === 'thought')
                );
            }
            success = true;
        } catch (error) {
            if (!manualAborted) this.chatUI.addErrorMessage(`Error: ${error.message}`);
        } finally {
            tokenCounter.updateLifetimeTokens();
            this.chatUI.removeManualAbortButton(model);
            // if the response fails or is stopped in thinking mode, the footer should still create a regenerate button,
            // which due to chatCore management conveniently continues with the thinking chain, discarding the invalid message
            const isThinkingFunc = success ? null : () => false;
            await streamWriter.addFooter(this.createMessageFooter(tokenCounter, model, isThinkingFunc));
        }

        if (success) {
            await this.saveResponseMessage(streamWriter.parts, model, isRegen);
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

    handleArenaChoice(choice) {;
        const currentMessage = this.chatCore.getLatestMessage();
        this.chatUI.removeArenaFooter();
        
        // Update message state
        const winnerIndex = this.determineWinnerIndex(choice);
        const winner = winnerIndex !== -1 ? this.stateManager.getArenaModel(winnerIndex) : null;
        
        const continued_with = winner ? 
            (winnerIndex === 0 ? "model_a" : "model_b") : 
            "none";
        // Update UI and state
        this.chatCore.updateArenaMisc(choice, continued_with);
        const [modelA, modelB] = this.stateManager.getArenaModels();
        if (['model_a', 'model_b', 'draw', 'draw(bothbad)'].includes(choice)) {
            this.arenaRatingManager.addMatchAndUpdate(modelA, modelB, choice);
        }
        const ratings = [this.arenaRatingManager.getModelRating(modelA), this.arenaRatingManager.getModelRating(modelB)];
        this.chatUI.resolveArena(choice, currentMessage.continued_with, null, ratings);
        this.stateManager.clearArenaState();
        
        // Handle continuation
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
        this.chatUI.regenerateResponse(model, isRegen);
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
            this.chatUI.addMessage('assistant', [], { model, hideModels: !this.stateManager.getSetting('show_model_name')});
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
        this.chatCore.initThinkingChat();   // needs to be before initArena so that the thinking chat exists when the message is added
        this.chatUI.createArenaMessage();
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
        this.chatCore.addUserMessage(text);
        this.chatUI.addMessage('user', this.chatCore.getLatestMessage().contents.at(-1));
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
        this.chatUI.regenerateResponse(actualModel, true, hideModels); 
            
        if (this.stateManager.isArenaModeActive && this.stateManager.thinkingMode) {
            this.chatCore.initThinkingChat();
            const [modelA, modelB] = this.stateManager.getArenaModels();
            this.chatCore.initArena(modelA, modelB);
        }

        this.makeApiCall(actualModel, true);
    }
}