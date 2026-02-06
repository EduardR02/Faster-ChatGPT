export const CHAT_STATE = { NORMAL: 0, INCOGNITO: 1, CONVERTED: 2 };
export const THINKING_STATE = { INACTIVE: 0, THINKING: 1, SOLVING: 2 };
export const REASONING_EFFORT_OPTIONS = ['minimal', 'low', 'medium', 'high', 'xhigh'];
export const IMAGE_ASPECT_OPTIONS = ['auto', '16:9', '9:16', '1:1', '4:3', '3:4', '3:2', '2:3', '4:5', '5:4', '21:9'];
export const IMAGE_RESOLUTION_OPTIONS = ['1K', '2K', '4K'];

export const cycleOption = (currentValue, options) => {
    const currentIndex = options.indexOf(currentValue);
    return options[(currentIndex + 1) % options.length];
};

export const readThinkingState = (state, modelId = null) => {
    if ((state.isArenaModeActive || state.isCouncilModeActive) && modelId) {
        return state.thinkingStates[modelId] ?? THINKING_STATE.INACTIVE;
    }
    return state.thinkingStates.default;
};

export const writeThinkingState = (state, value, modelId = null) => {
    if ((state.isArenaModeActive || state.isCouncilModeActive) && modelId) {
        state.thinkingStates[modelId] = value;
    } else {
        state.thinkingStates.default = value;
    }
};

export const advanceThinkingState = (state, modelId = null) => {
    const current = readThinkingState(state, modelId);
    const next = current === THINKING_STATE.THINKING ? THINKING_STATE.SOLVING : THINKING_STATE.INACTIVE;
    writeThinkingState(state, next, modelId);
};

export const initializeThinkingStates = (state, modelId = null) => {
    const initialState = state.activeThinkingMode ? THINKING_STATE.THINKING : THINKING_STATE.INACTIVE;
    if (state.isArenaModeActive) {
        if (modelId) return writeThinkingState(state, initialState, modelId);
        if (!state.activeArenaModels) return;
        const [modelA, modelB] = state.activeArenaModels;
        state.thinkingStates = { [modelA]: initialState, [modelB]: initialState };
        return;
    }
    if (state.isCouncilModeActive) {
        if (modelId) return writeThinkingState(state, initialState, modelId);
        state.thinkingStates = (state.activeCouncilModels || []).reduce((acc, model) => {
            acc[model] = initialState;
            return acc;
        }, {});
        return;
    }
    state.thinkingStates = { default: initialState };
};

export const initializeArenaCouncilState = (state, overrides = {}) => {
    Object.assign(state, {
        isArenaModeActive: false,
        activeArenaModels: null,
        isCouncilModeActive: false,
        activeCouncilModels: null,
        councilCollectorModel: null,
        ...overrides
    });
};

export const initializeInteractiveState = (state, overrides = {}) => {
    Object.assign(state, {
        pendingThinkingMode: false,
        activeThinkingMode: false,
        thinkingStates: { default: THINKING_STATE.INACTIVE },
        chatState: CHAT_STATE.NORMAL,
        shouldSave: true,
        shouldThink: false,
        shouldWebSearch: undefined,
        reasoningEffort: undefined,
        imageAspectRatio: undefined,
        imageResolution: undefined,
        ...overrides
    });
};

const S = (manager) => manager.getSessionState();
const resetModeDefaults = (manager) => manager.getModeDefaultsForReset?.() ?? { arena_mode: false, council_mode: false };
const syncModeFlags = (manager) => manager.shouldSyncModeFlagsOnToggle?.() ?? false;
const applyModeSettings = (manager, updates) => manager.applyModeSettingUpdates?.(updates);
const applyMixin = (targetPrototype, mixin) => {
    Object.defineProperties(targetPrototype, Object.getOwnPropertyDescriptors(mixin));
};

const arenaCouncilStateMixin = {
    get isArenaModeActive() { return S(this).isArenaModeActive; },
    get isCouncilModeActive() { return S(this).isCouncilModeActive; },

    initArenaResponse(modelA, modelB) {
        Object.assign(S(this), { activeArenaModels: [modelA, modelB], isArenaModeActive: true });
    },

    clearArenaState() {
        Object.assign(S(this), { activeArenaModels: null, isArenaModeActive: false });
    },

    initCouncilResponse(models, collectorModel) {
        Object.assign(S(this), {
            activeCouncilModels: models,
            councilCollectorModel: collectorModel,
            isCouncilModeActive: true
        });
    },

    clearCouncilState() {
        Object.assign(S(this), { activeCouncilModels: null, councilCollectorModel: null, isCouncilModeActive: false });
    },

    getCouncilModels() { return S(this).activeCouncilModels || []; },
    getCouncilCollectorModel() { return S(this).councilCollectorModel || this.getSetting('council_collector_model'); },
    getArenaModel(index) { return S(this).activeArenaModels ? S(this).activeArenaModels[index] : null; },
    getArenaModelKey(modelId) {
        const models = S(this).activeArenaModels;
        if (!models) return 'model_a';
        return models.indexOf(modelId) === 0 ? 'model_a' : 'model_b';
    },
    getModelIndex(modelId) { return S(this).activeArenaModels?.indexOf(modelId) ?? 0; },
    getArenaModels() { return S(this).activeArenaModels || []; }
};

const interactiveStateMixin = {
    get shouldSave() { return !!S(this).shouldSave; },
    set shouldSave(value) { S(this).shouldSave = !!value; },
    get pendingThinkingMode() { return !!S(this).pendingThinkingMode; },
    get thinkingMode() { return !!S(this).activeThinkingMode; },

    isThinking(modelId = null) { return readThinkingState(S(this), modelId) === THINKING_STATE.THINKING; },
    isSolving(modelId = null) { return readThinkingState(S(this), modelId) === THINKING_STATE.SOLVING; },
    isInactive(modelId = null) { return readThinkingState(S(this), modelId) === THINKING_STATE.INACTIVE; },
    getThinkingState(modelId) { return readThinkingState(S(this), modelId); },
    setThinkingState(stateValue, modelId = null) { writeThinkingState(S(this), stateValue, modelId); },
    nextThinkingState(modelId = null) { advanceThinkingState(S(this), modelId); },
    initThinkingStateDefault() { initializeThinkingStates(S(this)); },
    initThinkingState(modelId = null) { initializeThinkingStates(S(this), modelId); },

    updateThinkingMode() {
        const state = S(this);
        state.activeThinkingMode = state.pendingThinkingMode;
    },

    toggleThinkingMode() {
        const state = S(this);
        state.pendingThinkingMode = !state.pendingThinkingMode;
    },

    resetChatState() {
        const state = S(this);
        const defaults = resetModeDefaults(this);
        state.chatState = CHAT_STATE.NORMAL;
        this.shouldSave = true;
        state.activeArenaModels = null;
        state.activeCouncilModels = null;
        state.councilCollectorModel = null;
        state.isArenaModeActive = !!defaults.arena_mode;
        state.isCouncilModeActive = !!defaults.council_mode;
        if (this.initializeThinkingStateForReset) this.initializeThinkingStateForReset();
        else this.initThinkingStateDefault();
    },

    toggleArenaMode() {
        const state = S(this);
        const sync = syncModeFlags(this);
        const current = sync ? !!state.isArenaModeActive : !!this.getSetting('arena_mode');
        const next = !current;
        if (sync) {
            state.isArenaModeActive = next;
            if (next) {
                state.isCouncilModeActive = false;
                state.activeCouncilModels = null;
                state.councilCollectorModel = null;
            }
        }
        applyModeSettings(this, { arena_mode: next, council_mode: false });
        return next;
    },

    toggleCouncilMode() {
        const state = S(this);
        const sync = syncModeFlags(this);
        const current = sync ? !!state.isCouncilModeActive : !!this.getSetting('council_mode');
        const next = !current;
        if (sync) {
            state.isCouncilModeActive = next;
            if (next) {
                state.isArenaModeActive = false;
                state.activeArenaModels = null;
            }
        }
        applyModeSettings(this, { council_mode: next, arena_mode: false });
        return next;
    },

    toggleChatState(hasChatStarted) {
        const state = S(this);
        if (state.chatState === CHAT_STATE.NORMAL) {
            this.shouldSave = false;
            state.chatState = hasChatStarted ? CHAT_STATE.CONVERTED : CHAT_STATE.INCOGNITO;
            return;
        }
        if (state.chatState === CHAT_STATE.INCOGNITO) {
            this.shouldSave = true;
            state.chatState = hasChatStarted ? CHAT_STATE.CONVERTED : CHAT_STATE.NORMAL;
            return;
        }
        this.shouldSave = false;
        state.chatState = CHAT_STATE.INCOGNITO;
        this.notifyChatReset();
    },

    isChatNormal() { return S(this).chatState === CHAT_STATE.NORMAL; },
    isChatIncognito() { return S(this).chatState === CHAT_STATE.INCOGNITO; },
    isChatConverted() { return S(this).chatState === CHAT_STATE.CONVERTED; },
    getShouldThink() { return !!S(this).shouldThink; },
    setShouldThink(value) { S(this).shouldThink = !!value; },

    toggleShouldThink() {
        const state = S(this);
        state.shouldThink = !state.shouldThink;
    },

    ensureWebSearchInitialized() {
        const state = S(this);
        if (state.shouldWebSearch === undefined) state.shouldWebSearch = !!this.getSetting('web_search');
    },

    getShouldWebSearch() {
        this.ensureWebSearchInitialized();
        return !!S(this).shouldWebSearch;
    },

    setShouldWebSearch(value) { S(this).shouldWebSearch = !!value; },

    toggleShouldWebSearch() {
        this.ensureWebSearchInitialized();
        const state = S(this);
        state.shouldWebSearch = !state.shouldWebSearch;
    },

    getReasoningEffort() { return S(this).reasoningEffort || this.getSetting('reasoning_effort') || 'medium'; },

    cycleReasoningEffort() {
        const state = S(this);
        const nextEffort = cycleOption(this.getReasoningEffort(), REASONING_EFFORT_OPTIONS);
        state.reasoningEffort = nextEffort;
        return nextEffort;
    },

    getImageAspectRatio() { return S(this).imageAspectRatio || 'auto'; },

    cycleImageAspectRatio() {
        const state = S(this);
        const nextOption = cycleOption(this.getImageAspectRatio(), IMAGE_ASPECT_OPTIONS);
        state.imageAspectRatio = nextOption;
        return nextOption;
    },

    getImageResolution() { return S(this).imageResolution || '2K'; },

    cycleImageResolution() {
        const state = S(this);
        const nextOption = cycleOption(this.getImageResolution(), IMAGE_RESOLUTION_OPTIONS);
        state.imageResolution = nextOption;
        return nextOption;
    }
};

export const applyArenaCouncilStateMixin = (targetPrototype) => applyMixin(targetPrototype, arenaCouncilStateMixin);
export const applyInteractiveStateMixin = (targetPrototype) => applyMixin(targetPrototype, interactiveStateMixin);
