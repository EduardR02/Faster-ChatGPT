import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { DragDropManager } from '../../src/js/drag_drop_manager.js';

const createAreaMock = () => ({
    addEventListener: () => {},
    classList: { toggle: () => {} },
    value: '',
    selectionStart: 0,
    selectionEnd: 0,
    onpaste: null
});

describe('DragDropManager.handleFiles', () => {
    const OriginalFileReader = globalThis.FileReader;

    beforeEach(() => {
        globalThis.FileReader = class {
            readAsDataURL(file) {
                this.onload?.({ target: { result: `data:${file.type};base64,VEVTVA==` } });
            }

            readAsText(file) {
                this.onload?.({ target: { result: `TEXT:${file.name}` } });
            }
        };
    });

    afterEach(() => {
        globalThis.FileReader = OriginalFileReader;
    });

    test('routes audio files to onAudio as base64 data URLs', async () => {
        const onAudio = mock(() => {});
        const onFile = mock(() => {});

        const manager = new DragDropManager(createAreaMock(), {
            onImage: () => {},
            onAudio,
            onFile,
            onText: () => {},
            onError: () => {}
        });

        await manager.handleFiles([{ type: 'audio/mp3', name: 'sample.mp3' }]);

        expect(onAudio).toHaveBeenCalledWith('data:audio/mp3;base64,VEVTVA==', 'sample.mp3');
        expect(onFile).not.toHaveBeenCalled();
    });
});
