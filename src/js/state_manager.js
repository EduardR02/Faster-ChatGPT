import { ModeEnum } from './storage_utils.js';

const settingsManagers = new Set();
let storageListenerAttached = false;

const dispatchStorageChanges = (changes, area) => {
    if (area !== 'local') return;
    settingsManagers.forEach(manager => manager.handleStorageChanges(changes));
};

const registerSettingsManager = (manager) => {
    settingsManagers.add(manager);
    if (!storageListenerAttached) {
        chrome.storage.onChanged.addListener(dispatchStorageChanges);
        storageListenerAttached = true;
    }
};

/**
 * Enums for application states.
 */
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
    if (state.isArenaModeActive && modelId) {
        return state.thinkingStates[modelId] ?? THINKING_STATE.INACTIVE;
    }
    return state.thinkingStates.default;
};

export const writeThinkingState = (state, value, modelId = null) => {
    if (state.isArenaModeActive && modelId) {
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
        if (modelId) {
            writeThinkingState(state, initialState, modelId);
            return;
        }
        const [modelA, modelB] = state.activeArenaModels;
        state.thinkingStates = { [modelA]: initialState, [modelB]: initialState };
        return;
    }

    state.thinkingStates = { default: initialState };
};

/**
 * Base class for managing application settings stored in chrome.storage.local.
 */
export class SettingsManager {
    constructor(requestedSettings = []) {
        this.isReady = false;
        this.onReadyQueue = [];
        this.state = { settings: {} };
        this.requestedKeys = ['mode', ...requestedSettings];
        this.listeners = new Map();
        
        this.init();
    }

    runOnReady(callback) {
        if (this.isReady) {
            callback();
        } else {
            this.onReadyQueue.push(callback);
        }
    }

    markReady() {
        this.isReady = true;
        this.onReadyQueue.forEach(callback => callback());
        this.onReadyQueue = [];
    }

    async init() {
        const storedSettings = await new Promise(resolve => chrome.storage.local.get(this.requestedKeys, resolve));
        Object.assign(this.state.settings, storedSettings);
        registerSettingsManager(this);

        this.markReady();
    }

    handleStorageChanges(changes) {
        const settingUpdates = {};
        for (const [key, change] of Object.entries(changes)) {
            if (this.requestedKeys.includes(key)) {
                settingUpdates[key] = change.newValue;
            }
        }
        if (Object.keys(settingUpdates).length > 0) {
            this.updateSettingsLocal(settingUpdates);
        }
    }

    subscribeToSetting(key, callback) {
        if (!this.listeners.has(key)) {
            this.listeners.set(key, []);
        }
        this.listeners.get(key).push(callback);
    }

    unsubscribeFromSetting(key, callback) {
        if (this.listeners.has(key)) {
            const list = this.listeners.get(key);
            const index = list.indexOf(callback);
            if (index !== -1) {
                list.splice(index, 1);
            }
        }
    }

    updateSettingsLocal(settingUpdates) {
        for (const [settingPath, value] of Object.entries(settingUpdates)) {
            const keys = settingPath.split('.');
            let current = this.state.settings;

            // Handle nested objects if necessary
            keys.forEach((key, index) => {
                if (index === keys.length - 1) {
                    current[key] = value;
                } else {
                    current[key] = current[key] || {};
                    current = current[key];
                }
            });

            this.listeners.get(settingPath)?.forEach(callback => callback(value));
        }
    }

    updateSettingsPersistent(settingUpdates) {
        this.updateSettingsLocal(settingUpdates);
        chrome.storage.local.set(this.state.settings);
    }

    loadFromStorage(keys) {
        return new Promise(resolve => chrome.storage.local.get(keys, resolve));
    }

    getSetting(key) {
        return this.state.settings[key];
    }

    isOn() {
        return this.getSetting('mode') !== ModeEnum.Off;
    }

    isInstantPromptMode() {
        return this.getSetting('mode') === ModeEnum.InstantPromptMode;
    }
}

/**
 * Manages settings for the extension Options page.
 */
export class SettingsStateManager extends SettingsManager {
    constructor() {
        super([
            'api_keys', 'max_tokens', 'temperature', 'loop_threshold', 'current_model',
            'close_on_deselect', 'show_model_name', 'stream_response', 'arena_mode',
            'arena_models', 'auto_rename', 'auto_rename_model', 'models',
            'reasoning_effort', 'web_search', 'persist_tabs', 'transcription_model'
        ]);
        this.temp = { api_keys: {}, prompts: {} };
        this.pendingChanges = {};
    }

    updateSettingsPersistent(settingUpdates) {
        this.updateSettingsLocal(settingUpdates);
        chrome.storage.local.set(settingUpdates);
    }

    queueSettingChange(keyOrObject, value) {
        if (typeof keyOrObject === 'object') {
            Object.entries(keyOrObject).forEach(([key, val]) => this.queueSettingChange(key, val));
            return;
        }

        if (value === this.state.settings[keyOrObject]) {
            delete this.pendingChanges[keyOrObject];
        } else {
            this.pendingChanges[keyOrObject] = value;
        }
    }

    getSetting(key) {
        return this.pendingChanges[key] !== undefined ? this.pendingChanges[key] : this.state.settings[key];
    }

    setApiKey(provider, key) {
        this.temp.api_keys[provider] = key;
    }

    commitChanges() {
        if (Object.keys(this.temp.api_keys).length > 0) {
            this.pendingChanges.api_keys = { ...this.state.settings.api_keys, ...this.temp.api_keys };
        }

        Object.assign(this.pendingChanges, this.temp.prompts);

        if (Object.keys(this.pendingChanges).length > 0) {
            this.updateSettingsPersistent(this.pendingChanges);
            this.pendingChanges = {};
            this.temp = { api_keys: {}, prompts: {} };
        }
    }

    addModel(provider, apiName, displayName) {
        const models = this.state.settings.models || {};
        if (!models[provider]) {
            models[provider] = {};
        }
        models[provider][apiName] = displayName;
        this.updateSettingsPersistent({ models });
    }

    removeModel(apiName) {
        const models = this.state.settings.models;
        let found = false;

        for (const provider in models) {
            if (apiName in models[provider]) {
                delete models[provider][apiName];
                found = true;
                break;
            }
        }

        if (!found) return;

        const settingUpdates = { models };

        // Handle fallout of model removal - check both persisted and pending
        if (this.state.settings.current_model === apiName) {
            settingUpdates.current_model = this.getFirstAvailableModel();
        }
        if (this.pendingChanges.current_model === apiName) {
            delete this.pendingChanges.current_model;
        }

        if (this.state.settings.auto_rename_model === apiName) {
            settingUpdates.auto_rename_model = null;
            settingUpdates.auto_rename = false;
        }
        if (this.pendingChanges.auto_rename_model === apiName) {
            delete this.pendingChanges.auto_rename_model;
            delete this.pendingChanges.auto_rename;
        }

        if (this.state.settings.transcription_model === apiName) {
            settingUpdates.transcription_model = null;
        }
        if (this.pendingChanges.transcription_model === apiName) {
            delete this.pendingChanges.transcription_model;
        }

        const arenaModels = this.state.settings.arena_models;
        if (arenaModels?.includes(apiName)) {
            settingUpdates.arena_models = arenaModels.filter(modelId => modelId !== apiName);
        }
        if (this.pendingChanges.arena_models?.includes(apiName)) {
            this.pendingChanges.arena_models = this.pendingChanges.arena_models.filter(m => m !== apiName);
            if (this.pendingChanges.arena_models.length < 2) {
                delete this.pendingChanges.arena_models;
                delete this.pendingChanges.arena_mode;
            }
        }

        this.updateSettingsPersistent(settingUpdates);
    }

    getFirstAvailableModel() {
        for (const provider in this.state.settings.models) {
            const modelIds = Object.keys(this.state.settings.models[provider]);
            if (modelIds.length > 0) return modelIds[0];
        }
        return null;
    }

    async getPrompt(type) {
        if (this.temp.prompts[type] === undefined) {
            const result = await new Promise(resolve => chrome.storage.local.get([type], resolve));
            if (result[type]) {
                this.temp.prompts[type] = result[type];
            }
        }
        return this.temp.prompts[type];
    }

    setPrompt(type, value) {
        this.temp.prompts[type] = value;
    }
}

/**
 * Manages Arena-specific state.
 */
export class ArenaStateManager extends SettingsManager {
    constructor(requestedSettings = []) {
        super(requestedSettings);
        this.state.isArenaModeActive = false;
        this.state.activeArenaModels = null;
    }

    initArenaResponse(modelA, modelB) {
        Object.assign(this.state, {
            activeArenaModels: [modelA, modelB],
            isArenaModeActive: true
        });
    }

    clearArenaState() {
        Object.assign(this.state, {
            activeArenaModels: null,
            isArenaModeActive: false
        });
    }

    getArenaModel(index) {
        return this.state.activeArenaModels ? this.state.activeArenaModels[index] : null;
    }

    getArenaModelKey(modelId) {
        if (!this.state.activeArenaModels) return 'model_a';
        return this.state.activeArenaModels.indexOf(modelId) === 0 ? 'model_a' : 'model_b';
    }

    getModelIndex(modelId) {
        return this.state.activeArenaModels?.indexOf(modelId) ?? 0;
    }

    getArenaModels() {
        return this.state.activeArenaModels || [];
    }

    get isArenaModeActive() {
        return this.state.isArenaModeActive;
    }
}

/**
 * Manages state for the History page.
 */
export class HistoryStateManager extends ArenaStateManager {
    constructor() {
        super();
        Object.assign(this, {
            isLoading: false,
            offset: 0,
            limit: 20,
            hasMoreItems: true,
            lastDateCategory: null,
            historyList: document.querySelector('.history-list')
        });
    }

    shouldLoadMore() {
        return this.historyList && 
               this.historyList.scrollHeight <= this.historyList.clientHeight && 
               this.hasMoreItems;
    }

    canLoadMore() {
        return !this.isLoading && this.hasMoreItems;
    }

    reset() {
        Object.assign(this, {
            isLoading: false,
            offset: 0,
            hasMoreItems: true,
            lastDateCategory: null
        });
    }

    isThinking(_) { return false; }
    isSolving(_) { return false; }
    isInactive(_) { return true; }
}

/**
 * Manages state for the Sidepanel application.
 */
export class SidepanelStateManager extends ArenaStateManager {
    constructor(activePromptKey) {
        super([
            'loop_threshold', 'current_model', 'arena_models', 'stream_response', 
            'arena_mode', 'show_model_name', 'models', 'web_search', 
            'reasoning_effort', 'persist_tabs', 'transcription_model'
        ]);
        
        Object.assign(this, {
            apiManager: null,
            chatResetListeners: new Map(),
            requestedPromptKey: activePromptKey,
            shouldSave: true
        });

        Object.assign(this.state, {
            pendingThinkingMode: false,
            activeThinkingMode: false,
            thinkingStates: { default: THINKING_STATE.INACTIVE },
            chatState: CHAT_STATE.NORMAL
        });

        this.state.prompts = { active_prompt: {}, thinking: '', solver: '' };
        this.initThinkingStateDefault();
        this.loadPrompts(activePromptKey);

        chrome.storage.onChanged.addListener((changes, area) => {
            if (area !== 'local') return;
            
            const promptUpdates = {};
            for (const [key, change] of Object.entries(changes)) {
                if (key.endsWith('_prompt')) {
                    promptUpdates[key] = change.newValue;
                }
            }
            
            if (Object.keys(promptUpdates).length > 0) {
                this.updatePromptsLocal(promptUpdates);
            }
        });
    }

    updatePromptsLocal(promptUpdates) {
        for (const [key, value] of Object.entries(promptUpdates)) {
            if (key === 'thinking_prompt') {
                this.state.prompts.thinking = value;
            } else if (key === 'solver_prompt') {
                this.state.prompts.solver = value;
            } else {
                this.state.prompts.active_prompt = { [key]: value };
            }
        }
    }

    async loadPrompts(promptKey) {
        const result = await new Promise(resolve => 
            chrome.storage.local.get(['thinking_prompt', 'solver_prompt', promptKey], resolve)
        );
        this.updatePromptsLocal(result);
    }

    async loadPrompt(promptKey) {
        const result = await new Promise(resolve => chrome.storage.local.get([promptKey], resolve));
        this.updatePromptsLocal(result);
    }

    getPrompt(type) {
        if (type === 'active_prompt') {
            return Object.values(this.state.prompts.active_prompt)[0];
        }
        return this.state.prompts[type];
    }

    get shouldSave() { return this.state.shouldSave; }
    set shouldSave(value) { this.state.shouldSave = !!value; }

    subscribeToChatReset(id, callback) {
        this.chatResetListeners.set(id, callback);
    }

    notifyChatReset() {
        this.chatResetListeners.forEach(callback => callback());
    }

    // --- Thinking States ---

    isThinking(modelId = null) {
        return readThinkingState(this.state, modelId) === THINKING_STATE.THINKING;
    }

    isSolving(modelId = null) {
        return readThinkingState(this.state, modelId) === THINKING_STATE.SOLVING;
    }

    isInactive(modelId = null) {
        return readThinkingState(this.state, modelId) === THINKING_STATE.INACTIVE;
    }

    getThinkingState(modelId) {
        return readThinkingState(this.state, modelId);
    }

    setThinkingState(state, modelId = null) {
        writeThinkingState(this.state, state, modelId);
    }

    nextThinkingState(modelId = null) {
        advanceThinkingState(this.state, modelId);
    }

    initThinkingStateDefault() {
        initializeThinkingStates(this.state);
    }

    initThinkingState(modelId = null) {
        initializeThinkingStates(this.state, modelId);
    }

    updateThinkingMode() {
        this.state.activeThinkingMode = this.state.pendingThinkingMode;
    }

    toggleThinkingMode() {
        this.state.pendingThinkingMode = !this.state.pendingThinkingMode;
    }

    get thinkingMode() {
        return this.state.activeThinkingMode;
    }

    // --- Chat State Toggles ---

    resetChatState() {
        this.state.chatState = CHAT_STATE.NORMAL;
        this.shouldSave = true;
        this.clearArenaState();
        this.initThinkingStateDefault();
    }

    toggleArenaMode() {
        this.updateSettingsLocal({ arena_mode: !this.getSetting('arena_mode') });
    }

    toggleChatState(hasChatStarted) {
        const current = this.state.chatState;
        
        if (current === CHAT_STATE.NORMAL) {
            this.shouldSave = false;
            this.state.chatState = hasChatStarted ? CHAT_STATE.CONVERTED : CHAT_STATE.INCOGNITO;
        } else if (current === CHAT_STATE.INCOGNITO) {
            this.shouldSave = true;
            this.state.chatState = hasChatStarted ? CHAT_STATE.CONVERTED : CHAT_STATE.NORMAL;
        } else if (current === CHAT_STATE.CONVERTED) {
            this.shouldSave = false;
            this.state.chatState = CHAT_STATE.INCOGNITO;
            this.notifyChatReset();
        }
    }

    isChatNormal() { return this.state.chatState === CHAT_STATE.NORMAL; }
    isChatIncognito() { return this.state.chatState === CHAT_STATE.INCOGNITO; }

    // --- Feature Toggles ---

    getShouldThink() { return !!this.state.shouldThink; }
    setShouldThink(value) { this.state.shouldThink = !!value; }
    toggleShouldThink() { this.state.shouldThink = !this.state.shouldThink; }

    ensureWebSearchInitialized() {
        if (this.state.shouldWebSearch === undefined) {
            this.state.shouldWebSearch = !!this.getSetting('web_search');
        }
    }

    getShouldWebSearch() {
        this.ensureWebSearchInitialized();
        return !!this.state.shouldWebSearch;
    }

    setShouldWebSearch(value) { this.state.shouldWebSearch = !!value; }
    toggleShouldWebSearch() {
        this.ensureWebSearchInitialized();
        this.state.shouldWebSearch = !this.state.shouldWebSearch;
    }

    // --- Configuration Cyclers ---

    getReasoningEffort() {
        return this.state.reasoningEffort || this.getSetting('reasoning_effort') || 'medium';
    }

    cycleReasoningEffort() {
        const nextEffort = cycleOption(this.getReasoningEffort(), REASONING_EFFORT_OPTIONS);
        this.state.reasoningEffort = nextEffort;
        return nextEffort;
    }

    getImageAspectRatio() {
        return this.state.imageAspectRatio || 'auto';
    }

    cycleImageAspectRatio() {
        const nextOption = cycleOption(this.getImageAspectRatio(), IMAGE_ASPECT_OPTIONS);
        this.state.imageAspectRatio = nextOption;
        return nextOption;
    }

    getImageResolution() {
        return this.state.imageResolution || '2K';
    }

    cycleImageResolution() {
        const nextOption = cycleOption(this.getImageResolution(), IMAGE_RESOLUTION_OPTIONS);
        this.state.imageResolution = nextOption;
        return nextOption;
    }
}
