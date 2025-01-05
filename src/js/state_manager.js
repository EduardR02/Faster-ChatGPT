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


export class SidepanelStateManager extends SettingsManager {
    constructor(requestedPrompt) {
        super(['loop_threshold', 'current_model', 'arena_models', 'stream_response', 'arena_mode']);

        // Additional state
        this.state = {
            ...this.state,
            isArenaModeActive: false,
            pendingThinkingMode: false,
            activeThinkingMode: false,
            chatState: CHAT_STATE.NORMAL,
            shouldSave: true,
            isSidePanel: true,
            chatResetOngoing: false,
            prompts: {
                active_prompt: {},
                thinking: '',
                solver: ''
            }
        };

        this.chatResetListeners = [];
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

    subscribeToChatReset(callback) {
        this.chatResetListeners.push(callback);
    }

    notifyChatReset() {
        this.chatResetListeners.forEach(func => func());
    }

    updateThinkingMode() {
        this.state.activeThinkingMode = this.state.pendingThinkingMode;
        this.state.pendingThinkingMode = false;
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

    get isArenaModeActive() {
        return this.state.isArenaModeActive;
    }

    get thinkingMode() {
        return this.state.activeThinkingMode;
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


const ModeEnum = {"InstantPromptMode": 0, "PromptMode": 1, "Off": 2};