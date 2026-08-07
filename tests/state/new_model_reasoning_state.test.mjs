import { describe, expect, test } from 'bun:test';
import { initializeInteractiveState } from '../../src/js/conversation_state.js';
import { SidepanelController } from '../../src/js/sidepanel_controller.js';
import { TabState } from '../../src/js/tab_state.js';

const createTabState = (reasoningEffort = 'medium') => {
    const settings = { reasoning_effort: reasoningEffort, current_model: 'gpt-5.6-sol' };
    const globalState = {
        apiManager: null,
        getSetting: key => settings[key],
        updateSettingsLocal: updates => Object.assign(settings, updates),
        notifyChatReset: () => {}
    };
    return new TabState(globalState, 'tab');
};

describe('model-specific reasoning session state', () => {
    test('initializes reasoningMode as unset and reads it as standard', () => {
        const state = {};
        initializeInteractiveState(state);
        const manager = createTabState();

        expect(state.reasoningMode).toBeUndefined();
        expect(manager.state.reasoningMode).toBeUndefined();
        expect(manager.getReasoningMode()).toBe('standard');
    });

    test('toggles reasoning mode independently between standard and pro', () => {
        const manager = createTabState();

        expect(manager.toggleReasoningMode()).toBe('pro');
        expect(manager.getReasoningMode()).toBe('pro');
        expect(manager.toggleReasoningMode()).toBe('standard');
        expect(manager.getReasoningMode()).toBe('standard');
    });

    test('cycles a supplied model-specific effort list', () => {
        const manager = createTabState('medium');
        const efforts = ['none', 'low', 'medium', 'high', 'xhigh', 'max'];

        expect(manager.cycleReasoningEffort(efforts)).toBe('high');
        expect(manager.cycleReasoningEffort(efforts)).toBe('xhigh');
    });

    test('preserves no-argument cycling and makes a fixed max list stable', () => {
        const manager = createTabState('medium');

        expect(manager.cycleReasoningEffort()).toBe('high');
        expect(manager.cycleReasoningEffort(['max'])).toBe('max');
        expect(manager.cycleReasoningEffort(['max'])).toBe('max');
    });

    test('cycles the kimi-k3 three-level list low -> high -> max -> low', () => {
        const manager = createTabState('medium');
        const efforts = ['low', 'high', 'max'];

        expect(manager.cycleReasoningEffort(efforts, 'low')).toBe('high');
        expect(manager.cycleReasoningEffort(efforts, 'high')).toBe('max');
        expect(manager.cycleReasoningEffort(efforts, 'max')).toBe('low');
        expect(manager.getReasoningEffort()).toBe('low');
    });

    test('cycles from a normalized effort instead of stale session state', () => {
        const manager = createTabState('max');
        const efforts = ['minimal', 'low', 'medium', 'high', 'xhigh'];

        expect(manager.cycleReasoningEffort(efforts, 'medium')).toBe('high');
    });

    test('passes reasoning mode through controller API options', () => {
        const controller = Object.create(SidepanelController.prototype);
        controller.state = {
            getShouldThink: () => true,
            getShouldWebSearch: () => false,
            getReasoningEffort: () => 'max',
            getReasoningMode: () => 'pro',
            getImageAspectRatio: () => 'auto',
            getImageResolution: () => '2K'
        };

        expect(controller.getApiOptions()).toEqual({
            shouldThink: true,
            webSearch: false,
            reasoningEffort: 'max',
            reasoningMode: 'pro',
            imageAspectRatio: 'auto',
            imageResolution: '2K'
        });
    });

    test('builds collector history for the selected collector model', () => {
        const controller = Object.create(SidepanelController.prototype);
        let requestedModel;
        controller.chatCore = {
            getMessagesForAPI: modelId => {
                requestedModel = modelId;
                return [{ role: 'user', parts: [{ type: 'text', content: 'Question' }] }];
            }
        };
        controller.state = { getPrompt: () => 'Collector prompt' };
        controller.extractCouncilResponses = () => '<response>Answer</response>';

        controller.buildCollectorPrompt([], 'kimi-k3');

        expect(requestedModel).toBe('kimi-k3');
    });
});
