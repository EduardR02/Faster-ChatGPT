/**
 * TabState holds all per-tab state that was previously mixed into SidepanelStateManager.
 * Each tab has its own TabState instance, enabling independent conversations.
 */

const CHAT_STATE = {
    NORMAL: 0,
    INCOGNITO: 1,
    CONVERTED: 2
};

const THINKING_STATE = {
    INACTIVE: 0,
    THINKING: 1,
    SOLVING: 2
};

export class TabState {
    constructor(globalStateManager, id = null) {
        this.id = id || crypto.randomUUID();
        this.globalState = globalStateManager;

        // Chat state
        this.chatState = CHAT_STATE.NORMAL;
        this.shouldSave = true;

        // Thinking mode state
        this._pendingThinkingMode = false;
        this.activeThinkingMode = false;
        this.thinkingStates = { default: THINKING_STATE.INACTIVE };

        // Arena state
        this.isArenaModeActive = false;
        this.activeArenaModels = null;

        // Per-chat toggles (initialized from global settings)
        this.shouldThink = false;
        this.shouldWebSearch = undefined;
        this.reasoningEffort = undefined;
        this.imageAspectRatio = undefined;
        this.imageResolution = undefined;

        // Per-tab model selection (null means use global default)
        this._currentModel = null;

        // Continued chat tracking
        this.continuedChatOptions = {};

        // Associated chatId (for persistence)
        this.chatId = null;

        // Window context (sidepanel vs tab)
        this.isSidePanel = true;
    }

    // Getter for pendingThinkingMode to match old API
    get pendingThinkingMode() {
        return this._pendingThinkingMode;
    }

    set pendingThinkingMode(value) {
        this._pendingThinkingMode = value;
    }

    // ========== Chat State ==========

    toggleChatState(hasChatStarted) {
        switch (this.chatState) {
            case CHAT_STATE.NORMAL:
                this.shouldSave = false;
                this.chatState = !hasChatStarted ? CHAT_STATE.INCOGNITO : CHAT_STATE.CONVERTED;
                break;
            case CHAT_STATE.INCOGNITO:
                this.shouldSave = true;
                this.chatState = !hasChatStarted ? CHAT_STATE.NORMAL : CHAT_STATE.CONVERTED;
                break;
            case CHAT_STATE.CONVERTED:
                this.shouldSave = false;
                this.chatState = CHAT_STATE.INCOGNITO;
                // Trigger chat reset via globalState notification
                this.globalState.notifyChatReset();
                break;
        }
    }

    resetChatState() {
        this.chatState = CHAT_STATE.NORMAL;
        this.shouldSave = true;
        this.clearContinuedChat();
        this.clearArenaState();
        this.initThinkingStateDefault();
    }

    isChatNormal() {
        return this.chatState === CHAT_STATE.NORMAL;
    }

    isChatIncognito() {
        return this.chatState === CHAT_STATE.INCOGNITO;
    }

    isChatConverted() {
        return this.chatState === CHAT_STATE.CONVERTED;
    }

    // ========== Thinking Mode ==========

    get thinkingMode() {
        return this.activeThinkingMode;
    }

    set thinkingMode(value) {
        this.pendingThinkingMode = value;
    }

    updateThinkingMode() {
        this.activeThinkingMode = this._pendingThinkingMode;
    }

    toggleThinkingMode() {
        this._pendingThinkingMode = !this._pendingThinkingMode;
    }

    isThinking(model = null) {
        const state = this.getThinkingState(model);
        return state === THINKING_STATE.THINKING;
    }

    isSolving(model = null) {
        const state = this.getThinkingState(model);
        return state === THINKING_STATE.SOLVING;
    }

    isInactive(model = null) {
        const state = this.getThinkingState(model);
        return state === THINKING_STATE.INACTIVE;
    }

    getThinkingState(model) {
        if (this.isArenaModeActive) {
            return this.thinkingStates[model];
        }
        return this.thinkingStates.default;
    }

    setThinkingState(state, model = null) {
        if (this.isArenaModeActive && model) {
            this.thinkingStates[model] = state;
        } else {
            this.thinkingStates.default = state;
        }
    }

    nextThinkingState(model = null) {
        const currentState = this.getThinkingState(model);
        let nextState = THINKING_STATE.INACTIVE;

        if (currentState === THINKING_STATE.THINKING) {
            nextState = THINKING_STATE.SOLVING;
        }

        this.setThinkingState(nextState, model);
    }

    initThinkingStateDefault() {
        const thinkingState = this.thinkingMode ? THINKING_STATE.THINKING : THINKING_STATE.INACTIVE;
        this.thinkingStates = { default: thinkingState };
    }

    initArenaThinkingStates(model = null) {
        const thinkingState = this.thinkingMode ? THINKING_STATE.THINKING : THINKING_STATE.INACTIVE;
        if (model) {
            this.setThinkingState(thinkingState, model);
            return;
        }
        const [modelA, modelB] = this.activeArenaModels;
        this.thinkingStates = { [modelA]: thinkingState, [modelB]: thinkingState };
    }

    initThinkingState(model = null) {
        if (this.isArenaModeActive) {
            this.initArenaThinkingStates(model);
        } else {
            this.initThinkingStateDefault();
        }
    }

    // ========== Arena Mode ==========

    updateArenaMode() {
        this.isArenaModeActive = this.globalState.getSetting('arena_mode');
    }

    initArenaResponse(modelA, modelB) {
        this.activeArenaModels = [modelA, modelB];
        this.isArenaModeActive = true;
    }

    clearArenaState() {
        this.activeArenaModels = null;
        this.isArenaModeActive = false;
    }

    getArenaModel(index) {
        if (!this.activeArenaModels || !this.isArenaModeActive) {
            throw new Error('Active arena models are not set!');
        }
        return this.activeArenaModels[index];
    }

    getArenaModelKey(model) {
        if (!this.activeArenaModels || !this.isArenaModeActive) {
            throw new Error('Active arena models are not set!');
        }
        return this.activeArenaModels.indexOf(model) === 0 ? 'model_a' : 'model_b';
    }

    getModelIndex(model) {
        if (!this.activeArenaModels || !this.isArenaModeActive) {
            return 0;
        }
        return this.activeArenaModels.indexOf(model);
    }

    getArenaModels() {
        return this.activeArenaModels;
    }

    // ========== Per-Chat Toggles ==========

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

    setReasoningEffort(value) {
        if (!['low', 'medium', 'high'].includes(value)) return;
        this.reasoningEffort = value;
    }

    cycleReasoningEffort() {
        const order = ['low', 'medium', 'high'];
        const current = this.getReasoningEffort();
        const next = order[(order.indexOf(current) + 1) % order.length];
        this.reasoningEffort = next;
        return next;
    }

    getImageAspectRatio() {
        return this.imageAspectRatio || 'auto';
    }

    cycleImageAspectRatio() {
        const options = ['auto', '16:9', '9:16', '1:1', '4:3', '3:4', '3:2', '2:3', '4:5', '5:4', '21:9'];
        const current = this.getImageAspectRatio();
        const next = options[(options.indexOf(current) + 1) % options.length];
        this.imageAspectRatio = next;
        return next;
    }

    getImageResolution() {
        return this.imageResolution || '2K';
    }

    cycleImageResolution() {
        const options = ['1K', '2K', '4K'];
        const current = this.getImageResolution();
        const next = options[(options.indexOf(current) + 1) % options.length];
        this.imageResolution = next;
        return next;
    }

    // ========== Continued Chat ==========

    clearContinuedChat() {
        this.continuedChatOptions = {};
    }

    // ========== Serialization (for persistence) ==========

    serialize() {
        return {
            id: this.id,
            chatId: this.chatId
        };
    }

    static deserialize(data, globalStateManager) {
        const tabState = new TabState(globalStateManager, data.id);
        tabState.chatId = data.chatId;
        return tabState;
    }

    // ========== Per-Tab Model Selection ==========

    getCurrentModel() {
        return this._currentModel ?? this.globalState.getSetting('current_model');
    }

    setCurrentModel(model) {
        this._currentModel = model;
    }

    initializeModel() {
        // Initialize with current global model when tab is created
        this._currentModel = this.globalState.getSetting('current_model');
    }

    // Override getSetting to handle per-tab current_model
    // This ensures each tab's API calls use its own model
    getSetting(key) {
        if (key === 'current_model') {
            return this.getCurrentModel();
        }
        return this.globalState.getSetting(key);
    }

    // Don't override updateSettingsLocal - let changes go to globalState
    // SidepanelApp will catch them via subscription and update the active tab

    // ========== Utility ==========

    isEmpty() {
        return !this.chatId;
    }
}

export { CHAT_STATE, THINKING_STATE };
