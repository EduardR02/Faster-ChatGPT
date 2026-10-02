import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { setLifetimeTokens, getLifetimeTokens } from '../../src/js/storage_utils.js';

const originalChrome = globalThis.chrome;
const originalSetTimeout = globalThis.setTimeout;
let storage;
let writeCount;
let expectedWrites;
let finishWrites;

const readTotals = () => new Promise(resolve => getLifetimeTokens(resolve));
const waitForWrites = count => {
    expectedWrites = count;
    return new Promise(resolve => { finishWrites = resolve; });
};

beforeEach(() => {
    storage = {};
    writeCount = 0;
    expectedWrites = 0;
    finishWrites = null;
    globalThis.chrome = {
        runtime: {},
        storage: { local: {
            get: (keys, callback) => {
                const snapshot = Object.fromEntries(keys.map(key => [key, storage[key]]));
                queueMicrotask(() => callback(snapshot));
            },
            set: (values, callback) => queueMicrotask(() => {
                Object.assign(storage, values);
                callback?.();
                if (++writeCount === expectedWrites) finishWrites();
            })
        } }
    };
});

afterEach(() => {
    globalThis.chrome = originalChrome;
    globalThis.setTimeout = originalSetTimeout;
});

describe('lifetime token storage', () => {
    test('legacy totals remain intact and missing cache categories read as zero', async () => {
        storage.lifetime_input_tokens = 1000;
        storage.lifetime_output_tokens = 500;
        expect(await readTotals()).toEqual({ input: 1000, output: 500, cachedInput: 0, cacheWriteInput: 0 });
        expect(storage).toEqual({ lifetime_input_tokens: 1000, lifetime_output_tokens: 500 });
    });

    test('serialized concurrent increments preserve every category without adding writes to input', async () => {
        storage.lifetime_input_tokens = 1000;
        storage.lifetime_output_tokens = 500;
        const completed = waitForWrites(3);
        setLifetimeTokens(10, 20, 30, 4);
        setLifetimeTokens(5, 5, 40, 2);
        setLifetimeTokens(1, 1, 50, 1);
        await completed;
        expect(await readTotals()).toEqual({ input: 1016, output: 526, cachedInput: 120, cacheWriteInput: 7 });
    });

    test('two-category callers preserve existing cache totals', async () => {
        Object.assign(storage, { lifetime_cached_input_tokens: 90, lifetime_cache_write_input_tokens: 30 });
        const completed = waitForWrites(1);
        setLifetimeTokens(20, 10);
        await completed;
        expect(await readTotals()).toEqual({ input: 20, output: 10, cachedInput: 90, cacheWriteInput: 30 });
    });

    test('exhausted background delivery retries fall back once with all four categories', async () => {
        chrome.runtime.sendMessage = () => Promise.reject(new Error('No background receiver'));
        globalThis.setTimeout = callback => { queueMicrotask(callback); return 0; };
        const completed = waitForWrites(1);
        setLifetimeTokens(50, 20, 100, 40);
        await completed;
        expect(await readTotals()).toEqual({ input: 50, output: 20, cachedInput: 100, cacheWriteInput: 40 });
    });
});
