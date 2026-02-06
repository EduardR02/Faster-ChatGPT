import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { updateTextfieldHeight } from '../../src/js/ui_utils.js';

describe('updateTextfieldHeight', () => {
    let originalWindow;

    beforeEach(() => {
        originalWindow = globalThis.window;
        globalThis.window = {
            getComputedStyle: () => ({ maxHeight: '100px' })
        };
    });

    afterEach(() => {
        globalThis.window = originalWindow;
    });

    test('sets height to content height when below max', () => {
        const element = {
            style: {},
            scrollHeight: 80,
            scrollTop: 0
        };

        updateTextfieldHeight(element);

        expect(element.style.height).toBe('80px');
        expect(element.style.overflowY).toBe('hidden');
        expect(element.scrollTop).toBe(0);
    });

    test('caps height at max and enables overflow when content exceeds max', () => {
        const element = {
            style: {},
            scrollHeight: 220,
            scrollTop: 0
        };

        updateTextfieldHeight(element);

        expect(element.style.height).toBe('100px');
        expect(element.style.overflowY).toBe('auto');
        expect(element.scrollTop).toBe(220);
    });
});
