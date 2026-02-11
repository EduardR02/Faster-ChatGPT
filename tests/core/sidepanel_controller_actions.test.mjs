import { describe, test, expect } from 'bun:test';
import { SidepanelController } from '../../src/js/sidepanel_controller.js';
import { createChromeMock } from '../setup.mjs';

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

describe('SidepanelController council abort button routing', () => {
    const createMakeApiController = () => {
        const controller = Object.create(SidepanelController.prototype);
        const calls = {
            addAbort: [],
            removeAbort: []
        };

        controller.state = {
            isCouncilModeActive: false,
            isArenaModeActive: false,
            getSetting: (key) => {
                if (key === 'stream_response') return false;
                return null;
            },
            getShouldThink: () => false,
            getShouldWebSearch: () => false,
            getReasoningEffort: () => 'medium',
            getImageAspectRatio: () => 'auto',
            getImageResolution: () => '2K',
            isInactive: () => false
        };

        controller.api = {
            getProviderName: () => 'openai',
            isImageModel: () => false,
            callApi: async () => [],
            getUiErrorMessage: (error) => String(error?.message || error)
        };

        controller.chatCore = {
            initThinkingChat: () => {},
            getMessagesForAPI: () => []
        };

        controller.chatUI = {
            addManualAbortButton: (...args) => calls.addAbort.push(args),
            removeManualAbortButton: (...args) => calls.removeAbort.push(args),
            getContentDiv: () => ({}),
            addErrorMessage: () => {}
        };

        controller.createStreamWriter = () => ({
            parts: [],
            addFooter: async () => {},
            finalizeCurrentPart: () => {}
        });
        controller.processNonStreamedResponse = () => {};
        controller.createFooter = () => ({});
        controller.handleSuccessfulCall = async () => {};

        return { controller, calls };
    };

    test('keeps panel model abort button in council row', async () => {
        globalThis.chrome = createChromeMock();
        const { controller, calls } = createMakeApiController();

        await controller.makeApiCall('same-model', false, { mode: 'council' });

        expect(calls.addAbort[0][2]).toEqual({ councilTarget: 'row' });
        expect(calls.removeAbort[0][1]).toEqual({ councilTarget: 'row' });
    });

    test('targets collector abort button only in collector phase', async () => {
        globalThis.chrome = createChromeMock();
        const { controller, calls } = createMakeApiController();

        await controller.makeApiCall('same-model', false, { mode: 'collector' });

        expect(calls.addAbort[0][2]).toEqual({ councilTarget: 'collector' });
        expect(calls.removeAbort[0][1]).toEqual({ councilTarget: 'collector' });
    });
});

describe('SidepanelController sendUserMessage ordering', () => {
    test('waits for user message persistence before starting api flow', async () => {
        const controller = Object.create(SidepanelController.prototype);
        const callOrder = [];
        let resolveSave;
        const savePromise = new Promise(resolve => {
            resolveSave = resolve;
        });

        const latestUserMessage = {
            role: 'user',
            contents: [[{ type: 'text', content: 'hello' }]]
        };

        controller.chatUI = {
            getTextareaText: () => 'hello',
            setTextareaText: () => callOrder.push('setTextareaText'),
            addMessage: () => callOrder.push('addMessage'),
            removeRegenerateButtons: () => callOrder.push('removeRegenerateButtons'),
            removeCurrentRemoveMediaButtons: () => callOrder.push('removeCurrentRemoveMediaButtons')
        };

        controller.chatCore = {
            addUserMessage: () => {
                callOrder.push('addUserMessage');
                return savePromise;
            },
            getLength: () => 1,
            getLatestMessage: () => latestUserMessage
        };

        controller.getContinueFunc = () => undefined;
        controller.handleDefaultArenaChoice = () => {
            callOrder.push('handleDefaultArenaChoice');
        };
        controller.initApiCall = async () => {
            callOrder.push('initApiCall');
        };

        const sendPromise = controller.sendUserMessage();

        expect(callOrder).toEqual([
            'setTextareaText',
            'handleDefaultArenaChoice',
            'addUserMessage',
            'addMessage',
            'removeRegenerateButtons',
            'removeCurrentRemoveMediaButtons'
        ]);

        expect(callOrder.includes('initApiCall')).toBe(false);

        resolveSave();
        await sendPromise;

        expect(callOrder.at(-1)).toBe('initApiCall');
    });
});
