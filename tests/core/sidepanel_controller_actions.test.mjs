import { describe, test, expect } from 'bun:test';
import { SidepanelController } from '../../src/js/sidepanel_controller.js';

const createController = ({ latestMessage, length = 1, models = {} } = {}) => {
    const controller = Object.create(SidepanelController.prototype);
    const calls = {
        continue: null,
        regenCallback: null,
        councilContinueIndex: null,
        regenModel: null,
        councilRegen: null,
        arenaRegen: null
    };

    controller.chatCore = {
        getLatestMessage: () => latestMessage,
        getLength: () => length
    };

    controller.chatUI = {
        continueFunc: () => {},
        addContinueToLatestAssistant: (...args) => {
            calls.continue = args;
        },
        addCouncilContinueButton: (index) => {
            calls.councilContinueIndex = index;
        },
        ensureLatestAssistantRegenerate: (callback) => {
            calls.regenCallback = callback;
        }
    };

    controller.state = {
        getSetting: (key) => {
            if (key === 'models') return models;
            if (key === 'current_model') return 'fallback-model';
            return null;
        }
    };

    controller.regenerateResponse = (modelId) => {
        calls.regenModel = modelId;
    };
    controller.regenerateCouncilMessage = (councilModels, collectorModel) => {
        calls.councilRegen = { councilModels, collectorModel };
    };
    controller.regenerateArenaMessage = (arenaModels) => {
        calls.arenaRegen = arenaModels;
    };

    return { controller, calls };
};

describe('SidepanelController assistant action restoration', () => {
    test('restores council-level continue and regenerate handlers', () => {
        const latestMessage = {
            role: 'assistant',
            council: {
                collector_model: 'collector-model',
                responses: {
                    'model-a': {},
                    'model-b': {}
                }
            }
        };
        const { controller, calls } = createController({ latestMessage, length: 4 });

        controller.restoreLatestAssistantActions();

        expect(calls.councilContinueIndex).toBe(3);
        expect(typeof calls.regenCallback).toBe('function');

        calls.regenCallback();
        expect(calls.councilRegen).toEqual({
            councilModels: ['model-a', 'model-b'],
            collectorModel: 'collector-model'
        });
    });

    test('restores normal latest continue and regenerate with model resolution', () => {
        const latestMessage = {
            role: 'assistant',
            contents: [
                [{ type: 'text', content: 'v1', model: 'Display Model' }],
                [{ type: 'text', content: 'v2', model: 'Display Model' }]
            ]
        };
        const models = {
            openai: {
                'gpt-4.1': 'Display Model'
            }
        };
        const { controller, calls } = createController({ latestMessage, length: 2, models });

        controller.restoreLatestAssistantActions();

        expect(calls.continue).toEqual([1, 1]);
        expect(typeof calls.regenCallback).toBe('function');

        calls.regenCallback();
        expect(calls.regenModel).toBe('gpt-4.1');
    });

    test('restores completed arena regenerate handler', () => {
        const latestMessage = {
            role: 'assistant',
            choice: 'model_a',
            responses: {
                model_a: { name: 'model-one' },
                model_b: { name: 'model-two' }
            }
        };
        const { controller, calls } = createController({ latestMessage, length: 3 });

        controller.restoreLatestAssistantActions();
        expect(typeof calls.regenCallback).toBe('function');

        calls.regenCallback();
        expect(calls.arenaRegen).toEqual(['model-one', 'model-two']);
    });
});

describe('SidepanelController model resolution', () => {
    test('resolves model ids from display names', () => {
        const { controller } = createController({
            models: {
                anthropic: {
                    'claude-sonnet': 'Claude Sonnet'
                }
            }
        });

        expect(controller.resolveModelId('Claude Sonnet')).toBe('claude-sonnet');
        expect(controller.resolveModelId('claude-sonnet')).toBe('claude-sonnet');
        expect(controller.resolveModelId('unknown-model')).toBe('unknown-model');
    });
});
