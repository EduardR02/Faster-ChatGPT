import { describe, expect, test } from 'bun:test';
import { getAppendFetchWindow, getMissingMessageRange, takeContiguousMessages } from '../../src/js/history_live_updates.js';

describe('history live update helpers', () => {
    test('requests missing gap so user message is not skipped', () => {
        expect(getMissingMessageRange(5, 6)).toEqual({
            startIndex: 5,
            count: 2
        });
    });

    test('skips fully overlapped append windows', () => {
        expect(getAppendFetchWindow(7, 5, 1)).toBeNull();
    });

    test('only applies contiguous messages from storage', () => {
        const fetched = [
            { messageId: 6, role: 'assistant' }
        ];

        expect(takeContiguousMessages(fetched, 5)).toEqual([]);
        expect(takeContiguousMessages([
            { messageId: 5, role: 'user' },
            { messageId: 6, role: 'assistant' }
        ], 5)).toEqual([
            { messageId: 5, role: 'user' },
            { messageId: 6, role: 'assistant' }
        ]);
    });
});
