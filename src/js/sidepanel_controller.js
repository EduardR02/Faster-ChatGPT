import { TokenCounter } from './TokenCounter.js';
import { StreamWriter, StreamWriterSimple } from './StreamWriter.js';
import { Footer } from './Footer.js';
import { ArenaRatingManager } from './ArenaRatingManager.js';
import { SidepanelChatCore } from './chat_core.js';

/**
 * orchestrates the interaction between the Sidepanel UI, Chat Core, and API.
 */
export class SidepanelController {
    constructor(options) {
        Object.assign(this, { 
            state: options.stateManager, 
            chatUI: options.chatUI, 
            api: options.apiManager, 
            storage: options.chatStorage, 
            arenaRating: new ArenaRatingManager() 
        });
        
        this.arenaRating.initDB();
        
        this.chatCore = new SidepanelChatCore(
            options.chatStorage, 
            options.stateManager, 
            this.chatUI.getChatHeader(), 
            options.onTitleChange, 
            options.onChatIdChange,
            options.apiManager
        );
    }

    getContinueFunc(index, subIndex = 0, modelKey = null) {
        if (!this.chatUI.continueFunc) return undefined;
        return () => this.chatUI.continueFunc(index, subIndex, modelKey);
    }

    initStates(chatTitle) {
        this.handleDefaultArenaChoice();
        this.state.resetChatState();
        this.chatUI.updateIncognito();
        this.chatCore.reset(chatTitle);
    }

    async makeApiCall(modelId, isRegeneration = false, options = {}) {
        const mode = options.mode ?? (this.state.isCouncilModeActive ? 'council' : (this.state.isArenaModeActive ? 'arena' : 'normal'));
        const isCouncilMode = mode === 'council' || mode === 'collector';
        const isArenaMode = mode === 'arena';
        const disableRegenerate = options.disableRegenerate ?? isCouncilMode;

        const providerName = this.api.getProviderName(modelId);
        const tokenCounter = new TokenCounter(providerName);
        const abortController = new AbortController();
        
        let apiModelId = modelId;
        let displayModelName = modelId;
        let apiOptions = this.getApiOptions();
        let wasManuallyAborted = false;
        const abortButtonOptions = mode === 'collector'
            ? { councilTarget: 'collector' }
            : (mode === 'council' ? { councilTarget: 'row' } : {});

        this.chatCore.initThinkingChat();
        this.chatUI.addManualAbortButton(modelId, () => {
            wasManuallyAborted = true;
            abortController.abort();
        }, abortButtonOptions);

        // Handle local model specific configuration
        if (this.api.getProviderName(modelId) === 'llamacpp') {
            const localConfig = await this.api.getLocalModelConfig();
            Object.assign(apiOptions, { localModelOverride: localConfig });
            apiModelId = localConfig.raw;
            displayModelName = localConfig.display;
        }

        const contentDiv = options.contentDiv ?? this.chatUI.getContentDiv(modelId);
        const streamWriter = this.createStreamWriter(contentDiv, isArenaMode && !isCouncilMode);
        const shouldStreamResponse = !this.api.isImageModel(modelId) && this.state.getSetting('stream_response');
        let isCallSuccessful = false;

        try {
            const apiResponse = await this.api.callApi(
                apiModelId, 
                options.messages ?? this.chatCore.getMessagesForAPI(modelId), 
                tokenCounter, 
                shouldStreamResponse ? streamWriter : null, 
                abortController, 
                apiOptions
            );

            if (!shouldStreamResponse) {
                this.processNonStreamedResponse(apiResponse, streamWriter);
            }
            isCallSuccessful = true;

        } catch (error) {
            if (!wasManuallyAborted) {
                this.chatUI.addErrorMessage(this.api.getUiErrorMessage(error));
            }
            if (mode === 'council') {
                this.chatUI.updateCouncilStatus(modelId, 'error');
                await this.chatCore.updateCouncilStatus(modelId, 'error');
            } else if (mode === 'collector') {
                this.chatUI.updateCouncilCollectorStatus('error');
                await this.chatCore.updateCouncilCollectorStatus('error');
            }
        } finally {
            tokenCounter.updateLifetimeTokens();
            this.chatUI.removeManualAbortButton(modelId, abortButtonOptions);
            
            if (mode === 'collector') {
                streamWriter.finalizeCurrentPart();
            } else {
                const isThinkingStatusCallback = disableRegenerate ? () => true : (isCallSuccessful ? null : () => false);
                const messageFooter = this.createFooter(tokenCounter, modelId, isThinkingStatusCallback, isArenaMode);
                await streamWriter.addFooter(messageFooter);
            }
        }

        if (isCallSuccessful) {
            await this.handleSuccessfulCall(modelId, displayModelName, streamWriter.parts, isRegeneration, mode);
            if (mode === 'normal' && this.state.isInactive(modelId)) {
                this.chatUI.ensureLatestAssistantRegenerate(() => this.regenerateResponse(modelId));
            }
        }

        return { inputTokens: tokenCounter.inputTokens, outputTokens: tokenCounter.outputTokens };
    }

    processNonStreamedResponse(responseParts, writer) {
        responseParts.forEach(part => {
            if (part.type === 'image') {
                // If there's already content in the current part, move to a new one
                if (writer.parts.at(-1).content.length > 0) {
                    writer.nextPart();
                }
                const currentPart = writer.parts.at(-1);
                Object.assign(currentPart, { 
                    content: [part.content], 
                    type: 'image', 
                    thoughtSignature: part.thoughtSignature 
                });
            } else {
                writer.processContent(part.content, part.type === 'thought');
                if (part.thoughtSignature) {
                    writer.parts.at(-1).thoughtSignature = part.thoughtSignature;
                }
            }
        });
    }

    async handleSuccessfulCall(modelId, displayName, responseParts, isRegeneration, mode = 'normal') {
        const isCouncilMode = mode === 'council' || mode === 'collector';
        const isArenaMode = mode === 'arena';

        if (isArenaMode) {
            const key = this.state.getArenaModelKey(modelId);
            await this.chatCore.setArenaModelName(key, displayName);
            this.chatUI.setArenaModelDisplayName(modelId, displayName);
        } else if (mode === 'council' || mode === 'collector') {
            const showModelName = this.state.getSetting('show_model_name');
            if (mode === 'collector') {
                this.chatUI.updateCouncilCollectorStatus('complete');
                await this.chatCore.updateCouncilCollectorStatus('complete');
            } else {
                this.chatUI.updateCouncilStatus(modelId, 'complete');
                await this.chatCore.updateCouncilStatus(modelId, 'complete');
            }
            if (showModelName && mode === 'council') {
                this.chatUI.updateCouncilModelName(modelId, displayName);
            }
        } else {
            this.chatUI.updateLastMessageModelName(displayName);
        }

        const modelNameForStorage = (isArenaMode || isCouncilMode) ? modelId : displayName;
        await this.saveResponse(responseParts, modelNameForStorage, isRegeneration, mode);

        const lastMessage = this.chatCore.getLatestMessage();
        if (!isArenaMode && !isCouncilMode && this.chatUI.continueFunc && lastMessage?.role === 'assistant') {
            const messageIndex = this.chatCore.getLength() - 1;
            const contentIndex = (lastMessage.contents?.length || 1) - 1;
            this.chatUI.addContinueToLatestAssistant(messageIndex, contentIndex);
        }

        if (!isCouncilMode) {
            this.handleThinkingFollowup(modelId, isRegeneration);
        }

        const needsSearchRefresh = isArenaMode || isCouncilMode || isRegeneration || this.state.thinkingMode;
        if (this.state.isInactive(modelId) && needsSearchRefresh) {
            await this.chatCore.refreshSearchDoc();
        }
    }

    getApiOptions() {
        const state = this.state;
        return { 
            shouldThink: state.getShouldThink(), 
            webSearch: state.getShouldWebSearch(), 
            reasoningEffort: state.getReasoningEffort(), 
            imageAspectRatio: state.getImageAspectRatio(), 
            imageResolution: state.getImageResolution() 
        };
    }

    async saveResponse(responseParts, modelId, isRegeneration, mode = 'normal') {
        if (mode === 'arena' || this.state.isArenaModeActive) {
            return this.chatCore.updateArena(responseParts, modelId, this.state.getArenaModelKey(modelId));
        }

        if (mode === 'council') {
            return this.chatCore.updateCouncil(responseParts, modelId);
        }

        if (mode === 'collector') {
            return this.chatCore.updateCouncilCollector(responseParts, modelId);
        }
        
        if (isRegeneration && !this.state.thinkingMode) {
            return this.chatCore.appendRegenerated(responseParts, modelId);
        }
        
        await this.chatCore.addAssistantMessage(responseParts, modelId);
    }

    async handleArenaChoice(choice) {
        const latestMessageInChat = this.chatCore.getLatestMessage();
        this.chatUI.removeArenaFooter();

        // Determine winner index: -1 if none, 0 for A, 1 for B
        let arenaWinnerIndex = -1;
        if (['draw', 'reveal', 'ignored'].includes(choice)) {
            arenaWinnerIndex = Math.floor(Math.random() * 2);
        } else if (choice === 'model_a') {
            arenaWinnerIndex = 0;
        } else if (choice === 'model_b') {
            arenaWinnerIndex = 1;
        }

        const winnerKey = arenaWinnerIndex !== -1 ? (arenaWinnerIndex === 0 ? "model_a" : "model_b") : "none";
        await this.chatCore.updateArenaMisc(choice, winnerKey);

        const activeArenaModels = this.state.getArenaModels();
        if (['model_a', 'model_b', 'draw', 'draw(bothbad)'].includes(choice)) {
            this.arenaRating.addMatchAndUpdate(activeArenaModels[0], activeArenaModels[1], choice);
        }

        const modelEloRatings = [
            this.arenaRating.getModelRating(activeArenaModels[0]), 
            this.arenaRating.getModelRating(activeArenaModels[1])
        ];
        
        this.chatUI.resolveArena(choice, latestMessageInChat.continued_with, null, modelEloRatings);
        this.state.clearArenaState();

        if (choice !== 'no_choice(bothbad)') {
            this.chatUI.ensureLatestAssistantRegenerate(() => this.regenerateArenaMessage(activeArenaModels));
        }

        if (choice === 'no_choice(bothbad)') {
            void this.initApiCall();
        }
    }

    createStreamWriter(contentDiv, isArenaMode) {
        const produceNextDiv = (role, isThought) => this.chatUI.produceNextContentDiv(role, isThought);
        const scrollCallback = () => this.chatUI.scrollIntoView();
        
        const useSmoothStreaming = this.state.getSetting('stream_response') && isArenaMode;
        
        return useSmoothStreaming
            ? new StreamWriter(contentDiv, produceNextDiv, scrollCallback, 5000) 
            : new StreamWriterSimple(contentDiv, produceNextDiv, scrollCallback);
    }

    createFooter(tokenCounter, modelId, isThinkingCheck = null, forceArena = null) {
        const checkThinking = isThinkingCheck || (() => this.state.isThinking(modelId));
        const regenerateCallback = () => this.regenerateResponse(modelId);
        const isArena = forceArena ?? this.state.isArenaModeActive;
        
        return new Footer(
            tokenCounter.inputTokens, 
            tokenCounter.outputTokens, 
            isArena, 
            checkThinking, 
            regenerateCallback,
            { hideRegenerate: isThinkingCheck && isThinkingCheck() }
        );
    }

    handleThinkingFollowup(modelId, isRegeneration) {
        if (this.state.isInactive(modelId)) return;
        
        const lastMessage = this.chatCore.getLatestMessage();
        const messageIndex = Math.max(this.chatCore.getLength() - 1, 0);
        const contentIndex = lastMessage?.contents?.length || 0;
        
        this.chatUI.regenerateResponse(
            modelId, 
            isRegeneration, 
            true, 
            this.getContinueFunc(messageIndex, contentIndex),
            false
        );
        
        this.makeApiCall(modelId, isRegeneration);
    }

    async runCouncilFlow(councilModels, collectorModel) {
        this.state.initCouncilResponse(councilModels, collectorModel);
        this.state.initThinkingState();
        this.chatCore.initCouncil(councilModels, collectorModel);

        const messageIndex = this.chatCore.getLength() - 1;
        const councilContainer = this.chatUI.createCouncilMessage(this.chatCore.getLatestMessage(), {
            messageIndex,
            allowContinue: false,
            hideModels: !this.state.getSetting('show_model_name')
        });
        this.chatUI.activeDivs = councilContainer;

        const councilCalls = councilModels.map(modelId => {
            const rowContent = councilContainer.querySelector(`.council-row[data-model-id="${modelId}"] .council-row-content`);
            const rowMessage = rowContent?.querySelector('.assistant-message');
            const messageContent = rowMessage?.querySelector('.message-content');
            const messageWrapper = rowMessage?.querySelector('.message-wrapper') || rowContent;

            if (!rowContent || !rowMessage) {
                console.error(`Council row content not found for model: ${modelId}`);
                this.chatUI.updateCouncilStatus(modelId, 'error');
                this.chatCore.updateCouncilStatus(modelId, 'error');
                return Promise.reject(new Error(`Row content missing for ${modelId}`));
            }

            return this.makeApiCall(modelId, false, {
                mode: 'council',
                contentDiv: messageContent || messageWrapper
            });
        });

        const councilResults = await Promise.allSettled(councilCalls);
        const hasCouncilSuccess = councilResults.some(result => result.status === 'fulfilled');

        if (!hasCouncilSuccess) {
            this.chatUI.updateCouncilCollectorStatus('error');
            this.chatUI.addErrorMessage('Council responses failed. Collector skipped.');
            return;
        }

        const collectorMessage = councilContainer.querySelector('.council-collector .assistant-message');
        const collectorContent = collectorMessage?.querySelector('.message-content');
        const collectorWrapper = collectorMessage?.querySelector('.message-wrapper');

        const tokenResult = await this.makeApiCall(collectorModel, false, {
            mode: 'collector',
            messages: this.buildCollectorPrompt(councilModels),
            contentDiv: collectorContent || collectorWrapper || collectorMessage
        });

        this.chatUI.addCouncilContinueButton(messageIndex);
        this.chatUI.ensureLatestAssistantRegenerate(
            () => this.regenerateCouncilMessage(councilModels, collectorModel),
            { inputTokens: tokenResult.inputTokens, outputTokens: tokenResult.outputTokens }
        );
    }

    async runArenaFlow(modelAId, modelBId) {
        const currentMessageIndex = this.chatCore.getLength();

        this.state.initArenaResponse(modelAId, modelBId);
        this.state.initThinkingState();
        this.chatCore.initThinkingChat();

        this.chatUI.createArenaMessage(null, {
            continueFunc: this.getContinueFunc(currentMessageIndex),
            messageIndex: currentMessageIndex,
            allowContinue: false
        });

        this.chatCore.initArena(modelAId, modelBId);

        await Promise.all([
            this.makeApiCall(modelAId, false, { mode: 'arena' }),
            this.makeApiCall(modelBId, false, { mode: 'arena' })
        ]);

        this.chatUI.addArenaFooter(choice => {
            void this.handleArenaChoice(choice);
        });
    }

    async runNormalFlow() {
        this.state.initThinkingState();
        const currentSelectedModel = this.state.getSetting('current_model');
        const nextMessageIndex = this.chatCore.getLength();

        this.chatUI.addMessage('assistant', [], {
            model: currentSelectedModel,
            hideModels: !this.state.getSetting('show_model_name'),
            continueFunc: this.getContinueFunc(nextMessageIndex, 0),
            allowContinue: false
        });

        await this.makeApiCall(currentSelectedModel, false, { mode: 'normal' });
    }

    regenerateArenaMessage(arenaModels = null) {
        this.chatUI.initScrollListener();
        this.state.updateThinkingMode();

        const latest = this.chatCore.getLatestMessage();
        const fallbackModels = [
            latest?.responses?.model_a?.name,
            latest?.responses?.model_b?.name
        ];
        const [rawModelA, rawModelB] = (Array.isArray(arenaModels) && arenaModels.length === 2)
            ? arenaModels
            : fallbackModels;
        const modelAId = this.resolveModelId(rawModelA);
        const modelBId = this.resolveModelId(rawModelB);

        if (!modelAId || !modelBId) {
            this.chatUI.addErrorMessage('Arena regenerate unavailable for this message.');
            return;
        }

        void this.runArenaFlow(modelAId, modelBId);
    }

    regenerateCouncilMessage(councilModels = null, collectorModel = null) {
        this.chatUI.initScrollListener();
        this.state.updateThinkingMode();

        const latest = this.chatCore.getLatestMessage();
        const resolvedModels = (Array.isArray(councilModels) && councilModels.length > 0)
            ? councilModels
            : Object.keys(latest?.council?.responses || {});
        const resolvedCollector = collectorModel
            || latest?.council?.collector_model
            || this.state.getSetting('council_collector_model')
            || this.state.getSetting('current_model');
        const collectorId = this.resolveModelId(resolvedCollector);

        if (resolvedModels.length < 2) {
            this.chatUI.addErrorMessage('Enable at least 2 models for Council.');
            return;
        }

        void this.runCouncilFlow(resolvedModels.map(model => this.resolveModelId(model)), collectorId);
    }

    restoreLatestAssistantActions() {
        const latestMessage = this.chatCore.getLatestMessage();
        if (latestMessage?.role !== 'assistant') return;

        if (latestMessage.council) {
            const messageIndex = this.chatCore.getLength() - 1;
            const councilModels = Object.keys(latestMessage.council.responses || {});
            const collectorModel = latestMessage.council.collector_model;
            this.chatUI.addCouncilContinueButton(messageIndex);
            this.chatUI.ensureLatestAssistantRegenerate(() => this.regenerateCouncilMessage(councilModels, collectorModel));
            return;
        }

        if (latestMessage.responses) {
            if (latestMessage.choice && latestMessage.choice !== 'ignored') {
                const arenaModels = [latestMessage.responses.model_a?.name, latestMessage.responses.model_b?.name];
                this.chatUI.ensureLatestAssistantRegenerate(() => this.regenerateArenaMessage(arenaModels));
            }
            return;
        }

        if (this.chatUI.continueFunc) {
            const messageIndex = this.chatCore.getLength() - 1;
            const contentIndex = (latestMessage.contents?.length || 1) - 1;
            this.chatUI.addContinueToLatestAssistant(messageIndex, contentIndex);
        }

        const modelId = latestMessage.contents?.at(-1)?.at(-1)?.model || this.state.getSetting('current_model');
        this.chatUI.ensureLatestAssistantRegenerate(() => this.regenerateResponse(this.resolveModelId(modelId)));
    }

    resolveModelId(nameOrId) {
        if (!nameOrId) return nameOrId;

        const modelsByProvider = this.state.getSetting('models') || {};
        for (const provider of Object.keys(modelsByProvider)) {
            for (const [modelId, displayName] of Object.entries(modelsByProvider[provider])) {
                if (modelId === nameOrId || displayName === nameOrId) {
                    return modelId;
                }
            }
        }
        return nameOrId;
    }

    async initApiCall() {
        this.chatUI.initScrollListener(); 
        this.state.updateThinkingMode();

        if (this.state.isCouncilModeActive) {
            const councilModels = this.state.getSetting('council_models') || [];
            const collectorModel = this.state.getSetting('council_collector_model') || this.state.getSetting('current_model');
            
            if (councilModels.length < 2) {
                return this.chatUI.addErrorMessage("Enable at least 2 models for Council.");
            }

            return this.runCouncilFlow(councilModels, collectorModel);
        }

        if (this.state.isArenaModeActive) {
            const enabledArenaModels = this.state.getSetting('arena_models');
            
            if (enabledArenaModels.length < 2) {
                return this.chatUI.addErrorMessage("Enable at least 2 models for Arena.");
            }
            
            const [modelAId, modelBId] = this.getRandomArenaModels(enabledArenaModels);
            return this.runArenaFlow(modelAId, modelBId);
        }

        return this.runNormalFlow();
    }

    async initPrompt(context) {
        try {
            const promptKey = context.mode + "_prompt";
            await this.state.loadPrompt(promptKey);
            
            let systemPromptText = this.state.getPrompt('active_prompt');
            if (context.mode === "selection") {
                systemPromptText += `\n"""[${context.url}]"""\n"""[${context.text}]"""`;
            }
            
            this.chatCore.insertSystemMessage(systemPromptText);
        } catch (error) { 
            this.chatUI.addErrorMessage(`Error loading prompt: ${error.message}`); 
            throw error; 
        } 
    }

    buildCollectorPrompt(councilModels) {
        const canonicalMessages = this.chatCore.getMessagesForAPI();

        // Build system content: collector prompt appended to existing system or standalone
        let systemContent = '';
        const hasSystemMessage = canonicalMessages[0]?.role === 'system';
        if (hasSystemMessage) {
            systemContent = canonicalMessages[0].parts[0]?.content || '';
        }

        const collectorPrompt = this.state.getPrompt('council_collector_prompt') || '';
        if (systemContent) {
            systemContent += '\n\n' + collectorPrompt;
        } else {
            systemContent = collectorPrompt;
        }

        // Get council responses - text only, thoughts are excluded for synthesis context
        const councilResponses = this.extractCouncilResponses(councilModels);

        // Get latest user query (last user message, not first)
        const userMessages = canonicalMessages.filter(m => m.role === 'user');
        let lastUserContent = '';
        for (let i = userMessages.length - 1; i >= 0; i--) {
            const textPart = userMessages[i].parts?.find(p => p.type === 'text');
            if (textPart?.content?.trim()) {
                lastUserContent = textPart.content.trim();
                break;
            }
        }

        // Build final user message with latest query and council responses
        const taskInstruction = 'Synthesize these expert responses into a single, definitive answer.';
        const userContent = taskInstruction
            + '\n\n<user_query>' + lastUserContent + '</user_query>'
            + '\n\n<council_responses>\n' + councilResponses + '\n</council_responses>';

        // Build messages: system + full canonical history (minus last user) + new user message
        const messages = [];

        // System message (update existing or insert new)
        messages.push({ role: 'system', parts: [{ type: 'text', content: systemContent }] });

        // Include all canonical messages except the last user (to avoid duplication)
        const historyStart = hasSystemMessage ? 1 : 0;
        const lastUserIndex = canonicalMessages.lastIndexOf(userMessages[userMessages.length - 1]);
        if (lastUserIndex >= 0) {
            messages.push(...canonicalMessages.slice(historyStart, lastUserIndex));
        } else {
            messages.push(...canonicalMessages.slice(historyStart));
        }

        // Single user message with latest query and council responses
        messages.push({ role: 'user', parts: [{ type: 'text', content: userContent }] });

        return messages;
    }
    
    extractCouncilResponses(councilModels) {
        const latestMessage = this.chatCore.getLatestMessage();
        const councilData = latestMessage?.council;
        if (!councilData?.responses) return '';
        
        return councilModels.map(modelId => {
            const response = councilData.responses[modelId];
            const text = response?.parts
                ?.filter(p => p?.type === 'text')
                .map(p => p.content)
                .join('\n') || '[no response]';
            return `<response model="${modelId}">${text}</response>`;
        }).join('\n');
    }

    sendUserMessage() {
        const userInputText = this.chatUI.getTextareaText().trim();
        if (!userInputText) return;

        this.chatUI.setTextareaText('');
        this.handleDefaultArenaChoice();

        const saveUserMessagePromise = this.chatCore.addUserMessage(userInputText);
        
        const messageIndex = this.chatCore.getLength() - 1;
        const latestUserMessage = this.chatCore.getLatestMessage();
        const userMessageParts = latestUserMessage.contents.at(-1);
        
        this.chatUI.addMessage('user', userMessageParts, { 
            continueFunc: this.getContinueFunc(messageIndex, latestUserMessage.contents.length - 1) 
        });

        this.chatUI.removeRegenerateButtons(); 
        this.chatUI.removeCurrentRemoveMediaButtons();

        void saveUserMessagePromise;
        queueMicrotask(() => {
            void this.initApiCall();
        });
    }

    collectPendingUserMessage() {
        const userInputText = this.chatUI.getTextareaText().trim();
        return this.chatCore.collectPendingUserMessage(userInputText);
    }

    appendPendingMedia(mediaList, type) {
        mediaList.forEach(mediaItem => {
            const mediaId = this.chatCore.appendMedia(mediaItem, type);
            if (type === 'image') {
                this.chatUI.appendImage(mediaItem, () => this.chatCore.removeMedia(mediaId));
            } else {
                this.chatUI.appendFile(mediaItem, () => this.chatCore.removeMedia(mediaId));
            }
        });
    }

    handleDefaultArenaChoice() {
        const latest = this.chatCore.getLatestMessage();
        if (this.state.isArenaModeActive && latest?.role === 'assistant' && latest.choice === 'ignored') {
            void this.handleArenaChoice('ignored');
        }
    }

    regenerateResponse(modelId) {
        this.chatUI.initScrollListener(); 
        this.state.updateThinkingMode(); 
        this.state.initThinkingState(modelId);

        const currentActiveModel = this.state.isArenaModeActive ? modelId : this.state.getSetting('current_model');
        const shouldHideModelName = !this.state.getSetting('show_model_name') || this.state.isArenaModeActive;
        const lastMessageInChat = this.chatCore.getLatestMessage();
        const currentMessageIndex = Math.max(this.chatCore.getLength() - 1, 0);
        const nextContentIndex = lastMessageInChat?.contents?.length || 0;
        
        this.chatUI.regenerateResponse(
            currentActiveModel, 
            true, 
            shouldHideModelName, 
            this.getContinueFunc(currentMessageIndex, nextContentIndex),
            false
        );

        if (this.state.isArenaModeActive && this.state.thinkingMode) {
            this.chatCore.initThinkingChat();
            const activeArenaModels = this.state.getArenaModels();
            this.chatCore.initArena(activeArenaModels[0], activeArenaModels[1]);
        }
        
        this.makeApiCall(currentActiveModel, true);
    }

    getRandomArenaModels(models) {
        const shuffled = [...models];
        for (let i = shuffled.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }
        return [shuffled[0], shuffled[1]];
    }
}
