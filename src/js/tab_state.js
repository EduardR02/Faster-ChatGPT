import {
    initializeArenaCouncilState,
    initializeInteractiveState,
    applyArenaCouncilStateMixin,
    applyInteractiveStateMixin
} from './conversation_state.js';

/**
 * Encapsulates the state of an individual chat tab.
 */
export class TabState {
    constructor(globalState, id = null) {
        this.id = id || crypto.randomUUID();
        this.globalState = globalState;
        this.state = {};
        this._currentModel = null;
        this.chatId = null;
        this.isSidePanel = true;

        initializeArenaCouncilState(this.state, {
            isArenaModeActive: !!globalState.getSetting('arena_mode'),
            isCouncilModeActive: !!globalState.getSetting('council_mode')
        });
        initializeInteractiveState(this.state);
    }

    getSessionState() {
        return this.state;
    }

    applyModeSettingUpdates(settingUpdates) {
        this.globalState.updateSettingsLocal(settingUpdates);
    }

    shouldSyncModeFlagsOnToggle() {
        return true;
    }

    getModeDefaultsForReset() {
        return {
            arena_mode: !!this.globalState.getSetting('arena_mode'),
            council_mode: !!this.globalState.getSetting('council_mode')
        };
    }

    initializeThinkingStateForReset() {
        this.initThinkingState();
    }

    notifyChatReset() {
        this.globalState.notifyChatReset();
    }

    getCurrentModel() {
        return this._currentModel ?? this.globalState.getSetting('current_model');
    }

    setCurrentModel(modelId) {
        this._currentModel = modelId;
    }

    initializeModel() {
        this._currentModel = this.globalState.getSetting('current_model');
    }

    getSetting(key) {
        return key === 'current_model' ? this.getCurrentModel() : this.globalState.getSetting(key);
    }
}

applyArenaCouncilStateMixin(TabState.prototype);
applyInteractiveStateMixin(TabState.prototype);
