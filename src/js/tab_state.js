import {
    initializeArenaCouncilState,
    initializeInteractiveState,
    applyArenaCouncilStateMixin,
    applyInteractiveStateMixin
} from './conversation_state.js';
import { hasValidMultiModelSelection } from './model_selection.js';

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

        const models = globalState.getSetting('models');
        initializeArenaCouncilState(this.state, {
            isArenaModeActive: !!globalState.getSetting('arena_mode') &&
                hasValidMultiModelSelection(globalState.getSetting('arena_models'), models),
            isCouncilModeActive: !!globalState.getSetting('council_mode') &&
                hasValidMultiModelSelection(globalState.getSetting('council_models'), models)
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
        const models = this.globalState.getSetting('models');
        return {
            arena_mode: !!this.globalState.getSetting('arena_mode') &&
                hasValidMultiModelSelection(this.globalState.getSetting('arena_models'), models),
            council_mode: !!this.globalState.getSetting('council_mode') &&
                hasValidMultiModelSelection(this.globalState.getSetting('council_models'), models)
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
        if (modelId === this._currentModel) return;
        this._currentModel = modelId;
        // Sync shouldThink default when the model actually changes
        if (modelId && this.globalState.apiManager) {
            const am = this.globalState.apiManager;
            if (am.canToggleThinking(modelId)) {
                this.setShouldThink(am.isThinkingDefaultOn(modelId));
            } else if (!am.hasToggleThinking(modelId)) {
                this.setShouldThink(false);
            }
            // Non-toggle thinkers (always-on): leave shouldThink alone
        }
    }

    initializeModel() {
        this._currentModel = this.globalState.getSetting('current_model');
        // Sync shouldThink default for toggle-thinking models on tab creation
        if (this._currentModel && this.globalState.apiManager) {
            const canToggle = this.globalState.apiManager.canToggleThinking(this._currentModel);
            if (canToggle) {
                const defaultOn = this.globalState.apiManager.isThinkingDefaultOn(this._currentModel);
                this.setShouldThink(defaultOn);
            }
        }
    }

    getSetting(key) {
        return key === 'current_model' ? this.getCurrentModel() : this.globalState.getSetting(key);
    }
}

applyArenaCouncilStateMixin(TabState.prototype);
applyInteractiveStateMixin(TabState.prototype);
