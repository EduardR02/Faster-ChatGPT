import { describe, test, expect } from 'bun:test';
import { normalizeAudioItem, SidepanelChatUI } from '../../src/js/chat_ui.js';

describe('chat UI audio helpers', () => {
    test('normalizes object audio items preserving name and data', () => {
        const audioItem = { name: 'clip.mp3', data: 'data:audio/mp3;base64,QUJD' };
        expect(normalizeAudioItem(audioItem)).toEqual(audioItem);
    });

    test('normalizes string audio items with default name', () => {
        const dataUrl = 'data:audio/wav;base64,VEVTVA==';
        expect(normalizeAudioItem(dataUrl)).toEqual({
            data: dataUrl,
            name: 'Audio attachment'
        });
    });

    test('wraps audio part content before rendering display', () => {
        const dataUrl = 'data:audio/mp3;base64,QUJDRA==';
        const createAudioDisplayCalls = [];
        const fakeUi = {
            createImageContent: () => {
                throw new Error('unexpected image rendering');
            },
            createAudioDisplay: (audioItem) => {
                createAudioDisplayCalls.push(audioItem);
                return { type: 'audio-node', audioItem };
            },
            createContentDiv: () => ({ classList: { add: () => {} } })
        };

        const rendered = SidepanelChatUI.prototype.produceNextContentDiv.call(fakeUi, 'user', false, dataUrl, 'audio');

        expect(createAudioDisplayCalls).toEqual([{ data: dataUrl }]);
        expect(rendered).toEqual({ type: 'audio-node', audioItem: { data: dataUrl } });
    });
});
