import { describe, test, expect } from 'bun:test';
import { getDistanceFromBottom, isWithinBottomGrace } from '../../src/js/chat_ui.js';

describe('chat UI scroll helpers', () => {
    test('calculates distance from bottom', () => {
        const element = { scrollHeight: 1200, clientHeight: 400, scrollTop: 700 };
        expect(getDistanceFromBottom(element)).toBe(100);
    });

    test('uses generous default grace for near-bottom detection', () => {
        const element = { scrollHeight: 1200, clientHeight: 400, scrollTop: 690 };
        expect(isWithinBottomGrace(element)).toBe(true);
        expect(isWithinBottomGrace(element, 5)).toBe(false);
    });

    test('handles missing scroll element safely', () => {
        expect(getDistanceFromBottom(null)).toBe(Number.POSITIVE_INFINITY);
        expect(isWithinBottomGrace(null)).toBe(false);
    });
});
