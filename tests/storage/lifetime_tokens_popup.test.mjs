import { afterEach, describe, expect, test } from 'bun:test';
import { parseHTML } from 'linkedom';

const originals = { chrome: globalThis.chrome, document: globalThis.document };
let moduleIndex = 0;
afterEach(() => {
    globalThis.chrome = originals.chrome;
    globalThis.document = originals.document;
});

async function renderLifetime(stored) {
    const { document, window } = parseHTML(`
        <button id="buttonMode" class="button"></button>
        <button id="buttonChat" class="button"></button>
        <button id="buttonSettings" class="button"></button>
        <button id="buttonHistory" class="button"></button>
        <div id="tokensValue"></div>
    `);
    globalThis.document = document;
    globalThis.chrome = {
        windows: { getCurrent: async () => ({ id: 1 }) },
        storage: { local: { get: (keys, callback) => {
            const keyList = Array.isArray(keys) ? keys : [keys];
            callback(Object.fromEntries(keyList.map(key => [key, stored[key]])));
        } } }
    };
    await import(`../../src/js/popup.js?lifetime-token-display=${++moduleIndex}`);
    document.dispatchEvent(new window.Event('DOMContentLoaded'));
    await Promise.resolve();
    await Promise.resolve();
    return document.getElementById('tokensValue');
}

describe('lifetime token popup display', () => {
    test('cached reads have a compact separate label and writes remain input-subset metadata', async () => {
        const display = await renderLifetime({
            lifetime_input_tokens: 1000,
            lifetime_output_tokens: 500,
            lifetime_cached_input_tokens: 2000,
            lifetime_cache_write_input_tokens: 700
        });
        expect(display.innerText).toBe('1000 | 500 | 2000 cached');
        expect(display.title).toContain('Cache writes: 700 (included in input)');
    });

    test('old totals keep their original display with absent cache fields', async () => {
        const display = await renderLifetime({ lifetime_input_tokens: 1000, lifetime_output_tokens: 500 });
        expect(display.innerText).toBe('1000 | 500');
        expect(display.title).not.toContain('Cache writes');
        expect(display.title).not.toContain('Cached reads:');
    });
});
