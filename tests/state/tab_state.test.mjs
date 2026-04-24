import { describe, test, expect, beforeEach } from 'bun:test';
import { TabState } from '../../src/js/tab_state.js';
import { SidepanelStateManager } from '../../src/js/state_manager.js';

// Minimal chrome API mock for tests
global.chrome = {
    storage: {
        local: {
            get: (_keys, cb) => { if (cb) cb({}); return Promise.resolve({}); },
            set: (_data, cb) => { if (cb) cb(); return Promise.resolve(); }
        },
        onChanged: { addListener: () => {} }
    }
};

// Mock apiManager with the providers we need
function createMockApiManager() {
    const genericProvider = { name: 'generic', supports: () => false, isThinkingDefaultOn: () => false };
    const providers = {
        'moonshot': {
            name: 'moonshot',
            supports: (feature, model) => {
                if (feature === 'thinking_toggle') return model === 'kimi-k2.6';
                if (feature === 'thinking') return model === 'kimi-k2.6' || model === 'kimi-k2-thinking';
                return false;
            },
            isThinkingDefaultOn: (model) => model === 'kimi-k2.6'
        },
        'deepseek': {
            name: 'deepseek',
            supports: (feature, model) => {
                if (feature === 'thinking_toggle') return model === 'deepseek-chat';
                if (feature === 'thinking') return model === 'deepseek-chat' || model === 'deepseek-reasoner';
                return false;
            },
            isThinkingDefaultOn: (model) => model.includes('reasoner')
        },
        'openai': {
            name: 'openai',
            supports: (feature, model) => {
                if (feature === 'reasoning') return model === 'o3' || model === 'o4-mini';
                return false;
            },
            isThinkingDefaultOn: () => false
        }
    };

    const lookup = (modelId) => {
        if (modelId === 'kimi-k2.6' || modelId === 'kimi-k2-thinking') return providers.moonshot;
        if (modelId.startsWith('deepseek-')) return providers.deepseek;
        if (modelId === 'gpt-4o' || modelId === 'o3' || modelId === 'o4-mini') return providers.openai;
        return genericProvider;
    };

    return {
        getProvider: lookup,
        canToggleThinking: (modelId) => lookup(modelId).supports('thinking_toggle', modelId),
        hasToggleThinking: (modelId) => {
            const p = lookup(modelId);
            return p.supports('thinking_toggle', modelId) || p.supports('thinking', modelId);
        },
        isThinkingDefaultOn: (modelId) => lookup(modelId).isThinkingDefaultOn(modelId),
        hasReasoningLevels: (modelId) => lookup(modelId).supports('reasoning', modelId)
    };
}

describe('TabState - shouldThink persistence across model changes', () => {
    let globalState;
    let apiManager;

    beforeEach(async () => {
        globalState = new SidepanelStateManager('test_prompt');
        apiManager = createMockApiManager();
        globalState.apiManager = apiManager;
        // Wait for async init to complete
        await new Promise(resolve => globalState.runOnReady(resolve));
    });

    test('setCurrentModel syncs shouldThink to default for toggle-thinking models', () => {
        // Start with a non-thinking model first
        globalState.updateSettingsLocal({ current_model: 'gpt-4o' });
        const tab = new TabState(globalState);
        tab.setCurrentModel('gpt-4o');
        expect(tab.getShouldThink()).toBe(false);

        // Switch to kimi-k2.6 (toggleable, default ON)
        tab.setCurrentModel('kimi-k2.6');
        expect(tab.getShouldThink()).toBe(true);

        // Switch to deepseek-chat (toggleable, default OFF)
        tab.setCurrentModel('deepseek-chat');
        expect(tab.getShouldThink()).toBe(false);
    });

    test('setCurrentModel sets shouldThink(false) for non-thinking models', () => {
        globalState.updateSettingsLocal({ current_model: 'kimi-k2.6' });
        const tab = new TabState(globalState);
        tab.setCurrentModel('kimi-k2.6');
        expect(tab.getShouldThink()).toBe(true);

        // Switch to gpt-4o (no thinking support)
        tab.setCurrentModel('gpt-4o');
        expect(tab.getShouldThink()).toBe(false);
    });

    test('setCurrentModel preserves shouldThink for non-toggle thinkers (always-on)', () => {
        globalState.updateSettingsLocal({ current_model: 'deepseek-chat' });
        const tab = new TabState(globalState);
        tab.setCurrentModel('deepseek-chat');
        expect(tab.getShouldThink()).toBe(false);

        // Switch to deepseek-reasoner (always-on, no toggle)
        tab.setCurrentModel('deepseek-reasoner');
        // shouldThink is irrelevant for non-toggle thinkers, but it should not be forcibly changed
        // In our impl, non-toggle thinkers leave shouldThink alone
        expect(tab.getShouldThink()).toBe(false);
    });

    test('setCurrentModel is a no-op when model does not change', () => {
        globalState.updateSettingsLocal({ current_model: 'kimi-k2.6' });
        const tab = new TabState(globalState);
        tab.setCurrentModel('kimi-k2.6');
        expect(tab.getShouldThink()).toBe(true);

        // User manually toggles thinking OFF
        tab.toggleShouldThink();
        expect(tab.getShouldThink()).toBe(false);

        // Simulate tab switch: setCurrentModel called with same model
        // (this happens via handleTabSwitch → current_model subscription)
        tab.setCurrentModel('kimi-k2.6');

        // CRITICAL: shouldThink must survive — tab switches must not reset user choice
        expect(tab.getShouldThink()).toBe(false);
    });

    test('initializeModel sets correct shouldThink for new tabs', async () => {
        globalState.updateSettingsLocal({ current_model: 'kimi-k2.6' });
        const tab = new TabState(globalState);
        tab.initializeModel();
        expect(tab.getShouldThink()).toBe(true);

        // Another tab with deepseek-chat
        globalState.updateSettingsLocal({ current_model: 'deepseek-chat' });
        const tab2 = new TabState(globalState);
        tab2.initializeModel();
        expect(tab2.getShouldThink()).toBe(false);
    });

    test('user toggle survives setCurrentModel no-op (simulates tab switch roundtrip)', () => {
        globalState.updateSettingsLocal({ current_model: 'kimi-k2.6' });
        const tab = new TabState(globalState);
        tab.setCurrentModel('kimi-k2.6');
        expect(tab.getShouldThink()).toBe(true);

        // User toggles OFF
        tab.toggleShouldThink();
        expect(tab.getShouldThink()).toBe(false);

        // Tab switch to another model
        const tab2 = new TabState(globalState);
        tab2.setCurrentModel('deepseek-chat');

        // Tab switch back (setCurrentModel called again with same model)
        tab.setCurrentModel('kimi-k2.6');
        // Manual choice preserved
        expect(tab.getShouldThink()).toBe(false);
    });
});
