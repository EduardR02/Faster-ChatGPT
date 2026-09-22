import { describe, expect, mock, test } from 'bun:test';
import { AnthropicProvider, RoleEnum } from '../../src/js/LLMProviders.js';
import { TabState } from '../../src/js/tab_state.js';
import { SidepanelController } from '../../src/js/sidepanel_controller.js';

const provider = new AnthropicProvider();
const messages = [{ role: RoleEnum.user, parts: [{ type: 'text', content: 'Hello' }] }];
const efforts = ['low', 'medium', 'high', 'xhigh', 'max'];

const createBody = (options = {}, maxTokens = 200_000, temperature = 0.8) => {
    const [, request] = provider.createRequest({
        model: 'claude-opus-5-5',
        messages,
        stream: false,
        options,
        apiKey: 'key',
        settings: { temperature, max_tokens: maxTokens }
    });
    return JSON.parse(request.body);
};

describe('Claude Opus 5.5 request compatibility', () => {
    test('always sends adaptive thinking, omits sampling parameters, and caps output at 128k', () => {
        const streamWriter = { setThinkingModel: mock() };
        const body = createBody({ shouldThink: false, reasoningEffort: 'xhigh', streamWriter });

        expect(provider.supports('reasoning', 'claude-opus-5-5')).toBe(true);
        expect(provider.supports('thinking', 'claude-opus-5-5')).toBe(true);
        expect(provider.getReasoningEfforts('claude-opus-5-5')).toEqual(efforts);
        expect(body.model).toBe('claude-opus-5-5');
        expect(body.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
        expect(body.output_config).toEqual({ effort: 'xhigh' });
        expect(body.max_tokens).toBe(128_000);
        expect(body.temperature).toBeUndefined();
        expect(body.top_p).toBeUndefined();
        expect(body.top_k).toBeUndefined();
        expect(streamWriter.setThinkingModel).toHaveBeenCalledTimes(1);
    });

    test('serializes every documented effort level without normalization loss', () => {
        for (const effort of efforts) {
            expect(createBody({ reasoningEffort: effort }).output_config).toEqual({ effort });
        }
    });

    test('adds the documented basic web search tool when requested', () => {
        const body = createBody({ webSearch: true });

        expect(provider.supports('web_search', 'claude-opus-5-5')).toBe(true);
        expect(body.tools).toEqual([{ type: 'web_search_20250305', name: 'web_search', max_uses: 2 }]);
    });
});

test('a fresh Opus 5.5 tab sends medium effort until the user chooses another level', () => {
    const settings = { current_model: 'claude-opus-5-5', reasoning_effort: 'medium' };
    const state = new TabState({
        apiManager: null,
        getSetting: key => settings[key],
        updateSettingsLocal: updates => Object.assign(settings, updates),
        notifyChatReset() {}
    }, 'tab');
    const controller = Object.create(SidepanelController.prototype);
    controller.state = state;

    expect(createBody(controller.getApiOptions()).output_config).toEqual({ effort: 'medium' });
    state.cycleReasoningEffort(efforts);
    expect(createBody(controller.getApiOptions()).output_config).toEqual({ effort: 'high' });
});
