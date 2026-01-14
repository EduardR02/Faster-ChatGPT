import {
    CHAT_STATE,
    THINKING_STATE,
    REASONING_EFFORT_OPTIONS,
    IMAGE_ASPECT_OPTIONS,
    IMAGE_RESOLUTION_OPTIONS,
    cycleOption,
    readThinkingState,
    writeThinkingState,
    advanceThinkingState,
    initializeThinkingStates
} from './state_manager.js';

/**
 * Encapsulates the state of an individual chat tab.
 */
export class TabState {
    constructor(globalState, id = null) {
        Object.assign(this, {
            id: id || crypto.randomUUID(),
            globalState,
            chatState: CHAT_STATE.NORMAL,
            shouldSave: true,
            _pendingThinkingMode: false,
            activeThinkingMode: false,
            thinkingStates: { default: THINKING_STATE.INACTIVE },
            _isArenaModeActive: !!globalState.getSetting('arena_mode'), // Initialize from global default
            activeArenaModels: null,
            shouldThink: false,
            shouldWebSearch: undefined,
            reasoningEffort: undefined,
            imageAspectRatio: undefined,
            imageResolution: undefined,
            _currentModel: null,
            chatId: null,
            isSidePanel: true
        });
    }

    get pendingThinkingMode() { return this._pendingThinkingMode; }

    toggleChatState(hasChatStarted) {
        const current = this.chatState;
        if (current === CHAT_STATE.NORMAL) {
            this.shouldSave = false;
            this.chatState = hasChatStarted ? CHAT_STATE.CONVERTED : CHAT_STATE.INCOGNITO;
        } else if (current === CHAT_STATE.INCOGNITO) {
            this.shouldSave = true;
            this.chatState = hasChatStarted ? CHAT_STATE.CONVERTED : CHAT_STATE.NORMAL;
        } else {
            this.shouldSave = false;
            this.chatState = CHAT_STATE.INCOGNITO;
            this.globalState.notifyChatReset();
        }
    }

    resetChatState() {
        Object.assign(this, {
            chatState: CHAT_STATE.NORMAL,
            shouldSave: true,
            _isArenaModeActive: !!this.globalState.getSetting('arena_mode'), // Reset to default
            activeArenaModels: null
        });
        this.initThinkingState();
    }

    // Explicitly shadow the global isArenaModeActive
    get isArenaModeActive() { return this._isArenaModeActive; }
    set isArenaModeActive(value) { this._isArenaModeActive = !!value; }

    toggleArenaMode() {
        this._isArenaModeActive = !this._isArenaModeActive;
        return this._isArenaModeActive;
    }

    isChatNormal() { return this.chatState === CHAT_STATE.NORMAL; }
    isChatIncognito() { return this.chatState === CHAT_STATE.INCOGNITO; }
    isChatConverted() { return this.chatState === CHAT_STATE.CONVERTED; }

    get thinkingMode() { return this.activeThinkingMode; }
    updateThinkingMode() { this.activeThinkingMode = this._pendingThinkingMode; }
    toggleThinkingMode() { this._pendingThinkingMode = !this._pendingThinkingMode; }

    isThinking(modelId = null) { return readThinkingState(this, modelId) === THINKING_STATE.THINKING; }
    isSolving(modelId = null) { return readThinkingState(this, modelId) === THINKING_STATE.SOLVING; }
    isInactive(modelId = null) { return readThinkingState(this, modelId) === THINKING_STATE.INACTIVE; }

    getThinkingState(modelId) {
        return readThinkingState(this, modelId);
    }

    setThinkingState(state, modelId = null) {
        writeThinkingState(this, state, modelId);
    }

    nextThinkingState(modelId = null) {
        advanceThinkingState(this, modelId);
    }

    initThinkingState(modelId = null) {
        initializeThinkingStates(this, modelId);
    }

    initArenaResponse(modelA, modelB) {
        Object.assign(this, { 
            activeArenaModels: [modelA, modelB], 
            _isArenaModeActive: true 
        });
    }

    clearArenaState() {
        Object.assign(this, { 
            activeArenaModels: null, 
            _isArenaModeActive: false 
        });
    }

    getArenaModel(index) { 
        return this.activeArenaModels ? this.activeArenaModels[index] : null; 
    }

    getArenaModelKey(modelId) { 
        if (!this.activeArenaModels) return 'model_a';
        return this.activeArenaModels.indexOf(modelId) === 0 ? 'model_a' : 'model_b'; 
    }

    getModelIndex(modelId) { 
        return this.activeArenaModels?.indexOf(modelId) ?? 0; 
    }

    getArenaModels() { 
        return this.activeArenaModels || []; 
    }

    getShouldThink() { 
        return !!this.shouldThink; 
    }

    setShouldThink(value) { 
        this.shouldThink = !!value; 
    }

    toggleShouldThink() { 
        this.shouldThink = !this.shouldThink; 
    }

    ensureWebSearchInitialized() {
        if (this.shouldWebSearch === undefined) {
            this.shouldWebSearch = !!this.globalState.getSetting('web_search');
        }
    }

    getShouldWebSearch() {
        this.ensureWebSearchInitialized();
        return !!this.shouldWebSearch;
    }

    setShouldWebSearch(value) {
        this.shouldWebSearch = !!value;
    }

    toggleShouldWebSearch() {
        this.ensureWebSearchInitialized();
        this.shouldWebSearch = !this.shouldWebSearch;
    }

    getReasoningEffort() {
        return this.reasoningEffort || this.globalState.getSetting('reasoning_effort') || 'medium';
    }

    cycleReasoningEffort() {
        this.reasoningEffort = cycleOption(this.getReasoningEffort(), REASONING_EFFORT_OPTIONS);
        return this.reasoningEffort;
    }

    getImageAspectRatio() {
        return this.imageAspectRatio || 'auto';
    }

    cycleImageAspectRatio() {
        this.imageAspectRatio = cycleOption(this.getImageAspectRatio(), IMAGE_ASPECT_OPTIONS);
        return this.imageAspectRatio;
    }

    getImageResolution() {
        return this.imageResolution || '2K';
    }

    cycleImageResolution() {
        this.imageResolution = cycleOption(this.getImageResolution(), IMAGE_RESOLUTION_OPTIONS);
        return this.imageResolution;
    }

    getCurrentModel() { return this._currentModel ?? this.globalState.getSetting('current_model'); }
    setCurrentModel(modelId) { this._currentModel = modelId; }
    initializeModel() { this._currentModel = this.globalState.getSetting('current_model'); }
    getSetting(key) { return key === 'current_model' ? this.getCurrentModel() : this.globalState.getSetting(key); }
}
