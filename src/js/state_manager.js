import { ModeEnum } from './storage_utils.js';
import {
    THINKING_STATE,
    initializeArenaCouncilState,
    initializeInteractiveState,
    applyArenaCouncilStateMixin,
    applyInteractiveStateMixin
} from './conversation_state.js';

export {
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
} from './conversation_state.js';

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

    getSessionState() {
        return this.state;
    }

    applyModeSettingUpdates(settingUpdates) {
        this.updateSettingsPersistent(settingUpdates);
    }

    shouldSyncModeFlagsOnToggle() {
        return false;
    }

    getModeDefaultsForReset() {
        return { arena_mode: false, council_mode: false };
    }

    initializeThinkingStateForReset() {
        this.initThinkingStateDefault?.();
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
            'reasoning_effort', 'web_search', 'persist_tabs', 'transcription_model',
            'council_mode', 'council_models', 'council_collector_model'
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

        if (this.state.settings.council_collector_model === apiName) {
            settingUpdates.council_collector_model = this.getFirstAvailableModel();
        }
        if (this.pendingChanges.council_collector_model === apiName) {
            delete this.pendingChanges.council_collector_model;
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

        const councilModels = this.state.settings.council_models;
        if (councilModels?.includes(apiName)) {
            settingUpdates.council_models = councilModels.filter(modelId => modelId !== apiName);
        }
        if (this.pendingChanges.council_models?.includes(apiName)) {
            this.pendingChanges.council_models = this.pendingChanges.council_models.filter(m => m !== apiName);
            if (this.pendingChanges.council_models.length < 2) {
                delete this.pendingChanges.council_models;
                delete this.pendingChanges.council_mode;
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
 * Compatibility wrapper for direct ArenaStateManager imports.
 */
export class ArenaStateManager extends SettingsManager {
    constructor(requestedSettings = []) {
        super(requestedSettings);
        initializeArenaCouncilState(this.state);
    }
}

/**
 * Manages state for the History page.
 */
export class HistoryStateManager extends SettingsManager {
    constructor() {
        super(['show_model_name', 'models']);
        initializeArenaCouncilState(this.state);
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
export class SidepanelStateManager extends SettingsManager {
    constructor(activePromptKey) {
        super([
            'api_keys', 'max_tokens', 'temperature',
            'loop_threshold', 'current_model', 'arena_models', 'stream_response',
            'arena_mode', 'show_model_name', 'models', 'web_search',
            'reasoning_effort', 'persist_tabs', 'transcription_model',
            'auto_rename', 'auto_rename_model',
            'council_mode', 'council_models', 'council_collector_model'
        ]);

        Object.assign(this, {
            apiManager: null,
            chatResetListeners: new Map(),
            requestedPromptKey: activePromptKey
        });

        initializeArenaCouncilState(this.state);
        initializeInteractiveState(this.state, {
            thinkingStates: { default: THINKING_STATE.INACTIVE }
        });

        this.state.prompts = { active_prompt: {}, thinking: '', solver: '', council_collector_prompt: '' };
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
            } else if (key === 'council_collector_prompt') {
                this.state.prompts.council_collector_prompt = value;
            } else {
                this.state.prompts.active_prompt = { [key]: value };
            }
        }
    }

    async loadPrompts(promptKey) {
        const result = await new Promise(resolve =>
            chrome.storage.local.get(['thinking_prompt', 'solver_prompt', 'council_collector_prompt', promptKey], resolve)
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
        if (type === 'council_collector_prompt') {
            return this.state.prompts.council_collector_prompt;
        }
        return this.state.prompts[type];
    }

    subscribeToChatReset(id, callback) {
        this.chatResetListeners.set(id, callback);
    }

    notifyChatReset() {
        this.chatResetListeners.forEach(callback => callback());
    }
}

applyArenaCouncilStateMixin(ArenaStateManager.prototype);
applyArenaCouncilStateMixin(HistoryStateManager.prototype);
applyArenaCouncilStateMixin(SidepanelStateManager.prototype);
applyInteractiveStateMixin(SidepanelStateManager.prototype);
