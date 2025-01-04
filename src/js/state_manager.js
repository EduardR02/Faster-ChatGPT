import { CHAT_STATE } from './utils.js';


export class SettingsManager {
    constructor(requestedSettings = []) {
        this.state = {
            settings: {}
        };
        this.requestedSettings = requestedSettings;
        this.initialize();
    }

    async initialize() {
        if (this.requestedSettings.length === 0) return;
        await this.loadSettings(this.requestedSettings);
        this.setupChangeListener();
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

    updateSettingsLocal(newSettings) {
        for (const [path, value] of Object.entries(newSettings)) {
            deepUpdate(this.state.settings, path, value);
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
}


export class SidepanelStateManager extends SettingsManager {
    constructor(requestedSettings = [], requestedPrompt) {
        super(requestedSettings);

        // Additional state
        this.state = {
            ...this.state,
            isArenaMode: false,
            thinkingMode: false,
            chatState: CHAT_STATE.NORMAL,
            shouldSave: true,
            prompts: {
                thinking: '',
                solver: ''
            }
        };

        // Chat state listeners
        this.chatStateListeners = [];
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
                this.state.prompts.active_prompt = value;
            }
        }
    }


    async loadPrompts(requestedPrompt) {
        const requiredPrompts = ['thinking_prompt', 'solver_prompt'];
        const allPrompts = [...new Set([requestedPrompt, ...requiredPrompts])];

        const prompts = await this.loadFromStorage(allPrompts);

        this.state.prompts = {
            active_prompt: prompts[requestedPrompt] || '',
            thinking: prompts.thinking_prompt || '',
            solver: prompts.solver_prompt || ''
        };
    }

    getPrompt(type) {
        return this.state.prompts[type];
    }

    // Chat State Management
    setChatState(newState) {
        if (this.state.chatState !== newState) {
            this.state.chatState = newState;
            this.notifyChatStateChange();
        }
    }

    subscribeToChatState(callback) {
        this.chatStateListeners.push(callback);
    }

    notifyChatStateChange() {
        this.chatStateListeners.forEach(cb => cb(this.state.chatState, this.state.shouldSave));
    }

    // Additional Getters/Setters
    get isArenaMode() {
        return this.state.isArenaMode;
    }

    set isArenaMode(value) {
        this.state.isArenaMode = value;
    }

    get thinkingMode() {
        return this.state.thinkingMode;
    }

    set thinkingMode(value) {
        this.state.thinkingMode = value;
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