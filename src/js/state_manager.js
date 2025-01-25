export class SettingsManager {
    constructor(requestedSettings = []) {
        this.isReady = false;
        this.funcQueue = [];
        this.state = {
            settings: {}
        };
        this.requestedSettings = ['mode', ...requestedSettings];
        this.settingsListeners = {};
        this.initialize();
    }

    runOnReady(func) {
        if (this.isReady) {
            func();
        } else {
            this.funcQueue.push(func);
        }
    }

    markAsReady() {
        this.isReady = true;
        this.funcQueue.forEach(func => func());
        this.funcQueue = [];
    }

    async initialize() {
        if (this.requestedSettings.length === 0) return;
        await this.loadSettings(this.requestedSettings);
        this.setupChangeListener();
        this.markAsReady();
    }

    setupChangeListener() {
        chrome.storage.onChanged.addListener((changes, areaName) => {
            if (areaName === 'local') {
                const filteredChanges = Object.fromEntries(
                    Object.entries(changes)
                        .filter(([key]) => this.requestedSettings.includes(key))
                        .map(([key, { newValue }]) => [key, newValue])
                );
                if (Object.keys(filteredChanges).length > 0) {
                    this.updateSettingsLocal(filteredChanges);
                }
            }
        });
    }

    async loadSettings(keys) {
        const loadedSettings = await this.loadFromStorage(keys);
        this.state.settings = { ...this.state.settings, ...loadedSettings };
    }

    async loadFromStorage(keys) {
        return new Promise((resolve) => {
            chrome.storage.local.get(keys, (settings) => {
                resolve(settings);
            });
        });
    }

    subscribeToSetting(key, callback) {
        if (!this.settingsListeners[key]) {
            this.settingsListeners[key] = [];
        }
        this.settingsListeners[key].push(callback);
    }

    updateSettingsLocal(newSettings) {
        for (const [path, value] of Object.entries(newSettings)) {
            this.deepUpdate(this.state.settings, path, value);

            if (this.settingsListeners[path]) {
                this.settingsListeners[path].forEach(func => func(value));
            }
        }
    }

    updateSettingsPersistent(newSettings) {
        this.updateSettingsLocal(newSettings);
        chrome.storage.local.set(this.state.settings);
    }

    deepUpdate(target, path, value) {
        const keys = path.split('.');
        let current = target;
        for (let i = 0; i < keys.length - 1; i++) {
            const key = keys[i];
            if (!current[key] || typeof current[key] !== 'object') {
                current[key] = {};
            }
            current = current[key];
        }
        current[keys[keys.length - 1]] = value;
    }

    getSetting(key) {
        return this.state.settings[key];
    }

    isOn() {
        return this.getSetting('mode') !== ModeEnum.Off;
    }

    isSettingsEmpty() {
        return Object.keys(this.state.settings).length === 0;
    }

    isInstantPromptMode() {
        return this.getSetting('mode') === ModeEnum.InstantPromptMode;
    }
}


export class SettingsStateManager extends SettingsManager {
    constructor() {
        super(['api_keys', 'max_tokens', 'temperature', 'loop_threshold', 'current_model', 'close_on_deselect',
            'stream_response', 'arena_mode', 'arena_models', 'auto_rename', 'auto_rename_model', 'models'
        ]);

        this.tempState = {
            api_keys: {},
            prompts: {}
        };
        this.pendingChanges = {};
        this.initialize();
    }

    updateSettingsPersistent(newSettings) {
        this.updateSettingsLocal(newSettings);
        chrome.storage.local.set(newSettings);
    }

    queueSettingChange(key, value) {
        if (typeof key === 'object') {
            Object.entries(key).forEach(([k, v]) => this.queueSingleSetting(k, v));
        } else {
            this.queueSingleSetting(key, value);
        }
    }

    queueSingleSetting(key, value) {
        if (value === this.state.settings[key]) {
            delete this.pendingChanges[key];
        } else {
            this.pendingChanges[key] = value;
        }
    }

    getSetting(key) {
        if (this.pendingChanges[key] !== undefined) {
            return this.pendingChanges[key];
        }
        return this.state.settings[key];
    }

    setApiKey(provider, key) {
        this.tempState.api_keys[provider] = key;
    }

    commitChanges() {
        if (Object.keys(this.tempState.api_keys).length) {
            this.pendingChanges.api_keys = {
                ...this.state.settings.api_keys,
                ...this.tempState.api_keys
            };
        }
        
        if (Object.keys(this.tempState.prompts).length) {
            Object.entries(this.tempState.prompts).forEach(([key, value]) => {
                this.pendingChanges[key] = value;
            });
        }

        if (Object.keys(this.pendingChanges).length) {
            this.updateSettingsPersistent(this.pendingChanges);
            this.pendingChanges = {};
            this.tempState = { api_keys: {}, prompts: {} };
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
        this.updateSettingsPersistent({ models });

        const updates = {};

        if (super.getSetting('current_model') === apiName) {
            updates.current_model = this.getFirstAvailableModel();
            delete this.pendingChanges.current_model;
        }
        
        if (super.getSetting('auto_rename_model') === apiName) {
            updates.auto_rename_model = null;
            updates.auto_rename = false;
            delete this.pendingChanges.auto_rename_model;
            delete this.pendingChanges.auto_rename;
        }
        
        const arenaModels = super.getSetting('arena_models');
        if (arenaModels?.includes(apiName)) {
            updates.arena_models = arenaModels.filter(model => model !== apiName);
            
            if (this.pendingChanges.arena_models) {
                this.pendingChanges.arena_models = 
                    this.pendingChanges.arena_models.filter(model => model !== apiName);
                
                if (this.pendingChanges.arena_models.length < 2) {
                    delete this.pendingChanges.arena_models;
                    delete this.pendingChanges.arena_mode;
                }
            }
        }

        if (Object.keys(updates).length > 0) {
            this.updateSettingsPersistent(updates);
        }
    }

    getFirstAvailableModel() {
        for (const provider in this.state.settings.models) {
            const modelIds = Object.keys(this.state.settings.models[provider]);
            if (modelIds.length > 0) {
                return modelIds[0];
            }
        }
        return null;
    }

    async getPrompt(promptType) {
        if (this.tempState.prompts[promptType] !== undefined) {
            return this.tempState.prompts[promptType];
        }
        
        await this.loadPrompt(promptType);
        return this.tempState.prompts[promptType];
    }

    setPrompt(promptType, value) {
        this.tempState.prompts[promptType] = value;
    }

    async loadPrompt(promptType) {
        const result = await this.loadFromStorage([promptType]);
        if (result[promptType]) {
            this.tempState.prompts[promptType] = result[promptType];
        }
    }
}


export class ArenaStateManager extends SettingsManager {
    constructor(requestedSettings = []) {
        super(requestedSettings);
        
        // Shared arena state
        this.state = {
            ...this.state,
            isArenaModeActive: false,
            activeArenaModels: null,
        };
    }

    initArenaResponse(modelA, modelB) {
        this.state.activeArenaModels = [modelA, modelB];
        this.state.isArenaModeActive = true;
    }

    clearArenaState() {
        this.state.activeArenaModels = null;
        this.state.isArenaModeActive = false;
    }

    getArenaModel(index) {
        if (!this.state.activeArenaModels || !this.isArenaModeActive) 
            throw new Error('Active arena models are not set!');
        return this.state.activeArenaModels[index];
    }

    getArenaModelKey(model) {
        if (!this.state.activeArenaModels || !this.isArenaModeActive) 
            throw new Error('Active arena models are not set!');
        return this.state.activeArenaModels.indexOf(model) === 0 ? 'model_a' : 'model_b';
    }

    getModelIndex(model) {
        if (!this.state.activeArenaModels || !this.isArenaModeActive)
            return 0;
        return this.state.activeArenaModels.indexOf(model);
    }

    getArenaModels() {
        return this.state.activeArenaModels;
    }

    get isArenaModeActive() {
        return this.state.isArenaModeActive;
    }
}


export class HistoryStateManager extends ArenaStateManager {
    constructor() {
        super();
        // Direct properties for history management, so we don't have to call .state every time...
        this.isLoading = false;
        this.offset = 0;
        this.limit = 20;
        this.hasMoreItems = true;
        this.lastDateCategory = null;
        this.historyList = document.querySelector('.history-list');
    }

    shouldLoadMore() {
        const { scrollHeight, clientHeight } = this.historyList;
        return scrollHeight <= clientHeight && this.hasMoreItems;
    }

    canLoadMore() {
        return !this.isLoading && this.hasMoreItems;
    }

    isThinking(_) {
        return false;
    }

    isSolving(_) {
        return false;
    }

    reset() {
        this.isLoading = false;
        this.offset = 0;
        this.hasMoreItems = true;
        this.lastDateCategory = null;
    }
}


export class SidepanelStateManager extends ArenaStateManager {
    constructor(requestedPrompt) {
        super(['loop_threshold', 'current_model', 'arena_models', 'stream_response', 'arena_mode']);

        // Additional state
        this.state = {
            ...this.state,
            pendingThinkingMode: false,
            activeThinkingMode: false,
            thinkingStates: { default: THINKING_STATE.INACTIVE },
            chatState: CHAT_STATE.NORMAL,
            shouldSave: true,
            isSidePanel: true,
            continuedChatOptions: {},
            chatResetOngoing: false,
            prompts: {
                active_prompt: {},
                thinking: '',
                solver: ''
            }
        };

        this.chatResetListeners = {};
        this.requestedPrompt = requestedPrompt;
        this.loadPrompts(this.requestedPrompt)
        this.setupPromptChangeListener();
    }

    setupPromptChangeListener() {
        chrome.storage.onChanged.addListener((changes, areaName) => {
            if (areaName === 'local') {
                const filteredChanges = Object.fromEntries(
                    Object.entries(changes)
                        .filter(([key]) => key.endsWith('_prompt'))
                        .map(([key, { newValue }]) => [key, newValue])
                );
                if (Object.keys(filteredChanges).length > 0) {
                    this.updatePromptsLocal(filteredChanges);
                }
            }
        });
    }

    updatePromptsLocal(newPrompts) {
        for (const [key, value] of Object.entries(newPrompts)) {
            if (key === 'thinking_prompt') {
                this.state.prompts.thinking = value;
            } else if (key === 'solver_prompt') {
                this.state.prompts.solver = value
            } else {
                this.state.prompts.active_prompt = { [key]: value };
            }
        }
    }

    async loadPrompts(requestedPrompt) {
        const requiredPrompts = ['thinking_prompt', 'solver_prompt'];
        const allPrompts = [...new Set([requestedPrompt, ...requiredPrompts])];

        const prompts = await this.loadFromStorage(allPrompts);
        this.updatePromptsLocal(prompts);
    }

    async loadPrompt(requestedPrompt) {
        if (requestedPrompt === Object.keys(this.state.prompts.active_prompt)[0]) return;
        const prompt = await this.loadFromStorage([requestedPrompt]);
        this.updatePromptsLocal(prompt);
    }

    getPrompt(type) {
        if (type === 'active_prompt') {
            return Object.values(this.state.prompts[type])[0];
        }
        return this.state.prompts[type];
    }

    toggleChatState(hasChatStarted) {
        switch (this.state.chatState) {
            case CHAT_STATE.NORMAL:
                this.state.shouldSave = false;
                this.state.chatState = !hasChatStarted ? CHAT_STATE.INCOGNITO : CHAT_STATE.CONVERTED;
                break;
            case CHAT_STATE.INCOGNITO:
                this.state.shouldSave = true;
                this.state.chatState = !hasChatStarted ? CHAT_STATE.NORMAL : CHAT_STATE.CONVERTED;
                break;
            case CHAT_STATE.CONVERTED:
                this.state.shouldSave = false;
                this.state.chatState = CHAT_STATE.INCOGNITO;

                this.state.chatResetOngoing = true;
                this.notifyChatReset();
                this.state.chatResetOngoing = false;
                break;
        }
    }

    resetChatState() {
        if (this.state.chatResetOngoing) return;
        this.state.chatState = CHAT_STATE.NORMAL;
        this.state.shouldSave = true;
        this.clearContinuedChat();
        this.clearArenaState();
        this.initThinkingStateDefault();
    }

    isChatNormal() {
        return this.state.chatState === CHAT_STATE.NORMAL;
    }

    isChatIncognito() {
        return this.state.chatState === CHAT_STATE.INCOGNITO;
    }

    isChatConverted() {
        return this.state.chatState === CHAT_STATE.CONVERTED;
    }

    isThinking(model = null) {
        const state = this.getThinkingState(model);
        return state === THINKING_STATE.THINKING;
    }

    isSolving(model = null) {
        const state = this.getThinkingState(model);
        return state === THINKING_STATE.SOLVING;
    }

    subscribeToChatReset(key, callback) {
        this.chatResetListeners[key] = callback;
    }

    notifyChatReset() {
        for (const callback of Object.values(this.chatResetListeners)) {
            callback();
        }
    }

    updateThinkingMode() {
        this.state.activeThinkingMode = this.state.pendingThinkingMode;
    }
    
    toggleThinkingMode() {
        this.state.pendingThinkingMode = !this.state.pendingThinkingMode;
    }

    updateArenaMode() {
        this.state.isArenaModeActive = this.getSetting('arena_mode');
    }

    toggleArenaMode() {
        this.updateSettingsLocal({ arena_mode: !this.getSetting('arena_mode') });
    }

    nextThinkingState(model = null) {
        const currentState = this.getThinkingState(model);
        let nextState = THINKING_STATE.INACTIVE;

        if (currentState === THINKING_STATE.THINKING) {
            nextState = THINKING_STATE.SOLVING;
        }

        this.setThinkingState(nextState, model);
    }

    initArenaThinkingStates(model = null) {
        const thinkingState = this.thinkingMode ? THINKING_STATE.THINKING : THINKING_STATE.INACTIVE;
        if (model) {
            this.setThinkingState(thinkingState, model);
            return;
        }
        const [modelA, modelB] = this.state.activeArenaModels;
        this.state.thinkingStates = { [modelA]: thinkingState, [modelB]: thinkingState };
    }

    initThinkingStateDefault() {
        const thinkingState = this.thinkingMode ? THINKING_STATE.THINKING : THINKING_STATE.INACTIVE;
        this.state.thinkingStates = { default: thinkingState };
    }

    initThinkingState(model = null) {
        if (this.isArenaModeActive) {
            this.initArenaThinkingStates(model);
        } else {
            this.initThinkingStateDefault();
        }
    }

    getThinkingState(model) {
        if (this.isArenaModeActive) {
            return this.state.thinkingStates[model];
        }
        return this.state.thinkingStates.default;
    }

    setThinkingState(state, model = null) {
        if (this.isArenaModeActive && model) {
            this.state.thinkingStates[model] = state;
        } else {
            this.state.thinkingStates.default = state;
        }
    }

    clearContinuedChat() {
        this.continuedChatOptions = {};
    }

    get thinkingMode() {
        return this.state.activeThinkingMode;
    }

    get continuedChatOptions() {
        return this.state.continuedChatOptions;
    }

    set continuedChatOptions(options) {
        this.state.continuedChatOptions = options;
    }

    get pendingThinkingMode() {
        return this.state.pendingThinkingMode;
    }

    set isSidePanel(value) {
        this.state.isSidePanel = value;
    }

    get isSidePanel() {
        return this.state.isSidePanel;
    }

    get shouldSave() {
        return this.state.shouldSave;
    }

    set thinkingMode(value) {
        this.state.pendingThinkingMode = value;
        // Warn if thinking mode is active and prompts are missing
        if (this.state.thinkingMode) {
            if (!this.state.prompts.thinking) {
                throw new Error('Thinking prompt is empty!');
            }
            if (!this.state.prompts.solver) {
                throw new Error('Solver prompt is empty!');
            }
        }
    }
}


export const CHAT_STATE = {
    NORMAL: 0,      // Fresh normal chat
    INCOGNITO: 1,   // Fresh incognito or continued as incognito
    CONVERTED: 2    // Used the one-time transition either way
};


const THINKING_STATE = {
    INACTIVE: 0,
    THINKING: 1,
    SOLVING: 2
};


const ModeEnum = {"InstantPromptMode": 0, "PromptMode": 1, "Off": 2};