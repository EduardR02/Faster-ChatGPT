import { describe, expect, test } from 'bun:test';
import { SidepanelChatCore } from '../../src/js/chat_core.js';

const createCore = () => {
    const core = new SidepanelChatCore(
        { createNewChatTracking: () => ({ messages: [] }) },
        { thinkingMode: false },
        {},
        null,
        null,
        { settingsManager: {} }
    );
    core.currentChat.messages = [
        { role: 'user', contents: [[{ type: 'text', content: 'First' }]] },
        {
            role: 'assistant',
            contents: [[
                { type: 'thought', content: 'required K3 reasoning' },
                { type: 'text', content: 'Answer' }
            ]]
        },
        { role: 'user', contents: [[{ type: 'text', content: 'Continue' }]] }
    ];
    return core;
};

describe('Kimi K3 API history', () => {
    test('preserves assistant reasoning for K3 replay', () => {
        const messages = createCore().getMessagesForAPI('kimi-k3');

        expect(messages[1].parts).toEqual([
            { type: 'thought', content: 'required K3 reasoning' },
            { type: 'text', content: 'Answer' }
        ]);
    });

    test('continues stripping private thought text for other models', () => {
        const messages = createCore().getMessagesForAPI('gpt-5.6-sol');

        expect(messages[1].parts[0]).toEqual({ type: 'thought', content: '' });
    });
});
