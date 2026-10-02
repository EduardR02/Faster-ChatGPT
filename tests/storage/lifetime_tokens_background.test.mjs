import { afterEach, describe, expect, test } from 'bun:test';
import { setLifetimeTokens, getLifetimeTokens } from '../../src/js/storage_utils.js';

const originalChrome = globalThis.chrome;
afterEach(() => { globalThis.chrome = originalChrome; });

describe('background lifetime token accounting', () => {
    test('serializes messages from multiple callers and accepts legacy increments without resetting cache totals', async () => {
        const stored = {
            lifetime_input_tokens: 1000,
            lifetime_output_tokens: 500,
            lifetime_cached_input_tokens: 90,
            lifetime_cache_write_input_tokens: 30
        };
        let receive;
        const deliveries = [];
        const ignoredEvent = { addListener() {} };
        globalThis.chrome = {
            runtime: {
                getURL: path => `chrome-extension://test/${path}`,
                onInstalled: ignoredEvent,
                onMessage: { addListener: listener => { receive = listener; } },
                sendMessage: message => {
                    const delivery = new Promise(resolve => receive(message, {}, resolve));
                    deliveries.push(delivery);
                    return delivery;
                }
            },
            commands: { onCommand: ignoredEvent },
            storage: { local: {
                get: (keys, callback) => {
                    const snapshot = Object.fromEntries(keys.map(key => [key, stored[key]]));
                    queueMicrotask(() => callback(snapshot));
                },
                set: (values, callback) => queueMicrotask(() => {
                    Object.assign(stored, values);
                    callback();
                })
            } }
        };
        await import('../../src/js/background.js?lifetime-token-accounting');
        setLifetimeTokens(100, 20, 300, 70);
        setLifetimeTokens(10, 5, 50, 4);
        chrome.runtime.sendMessage({ type: 'increment_lifetime_tokens', inputDelta: 1, outputDelta: 2 });
        expect(await Promise.all(deliveries)).toEqual([{ ok: true }, { ok: true }, { ok: true }]);
        const totals = await new Promise(resolve => getLifetimeTokens(resolve));
        expect(totals).toEqual({ input: 1111, output: 527, cachedInput: 440, cacheWriteInput: 104 });
    });
});
