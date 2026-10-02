import { TokenCounter } from '../../src/js/TokenCounter.js';
import { Footer } from '../../src/js/Footer.js';
import { parseHTML } from 'linkedom';
import { afterEach, describe, expect, test } from 'bun:test';

const originalDocument = globalThis.document;
const originalChrome = globalThis.chrome;
afterEach(() => {
    globalThis.document = originalDocument;
    globalThis.chrome = originalChrome;
});

const totals = counter => [
    counter.inputTokens, counter.outputTokens,
    counter.cachedInputTokens, counter.cacheWriteInputTokens
];

describe('per-response token snapshots', () => {
    test('repeated and increasing snapshots replace counts without double counting', () => {
        const counter = new TokenCounter();
        counter.update(100, 3, 80, 25);
        counter.update(100, 3, 80, 25);
        expect(totals(counter)).toEqual([100, 3, 80, 25]);
        counter.update(120, 40, 90, 30);
        expect(totals(counter)).toEqual([120, 40, 90, 30]);
    });

    test('partial output and cache snapshots retain all absent categories', () => {
        const counter = new TokenCounter();
        counter.update(50, 2, 300, 40);
        counter.update(undefined, 20);
        expect(totals(counter)).toEqual([50, 20, 300, 40]);
        counter.update(undefined, undefined, 320);
        expect(totals(counter)).toEqual([50, 20, 320, 40]);
        counter.update(55, undefined, undefined, 45);
        expect(totals(counter)).toEqual([55, 20, 320, 45]);
    });

    test('corrected lower snapshots and explicit zero reset only supplied categories', () => {
        const counter = new TokenCounter();
        counter.update(100, 50, 90, 40);
        counter.update(60, 25, 20, 10);
        expect(totals(counter)).toEqual([60, 25, 20, 10]);
        counter.update(undefined, 0, 0, 0);
        expect(totals(counter)).toEqual([60, 0, 0, 0]);
        counter.update(0);
        expect(totals(counter)).toEqual([0, 0, 0, 0]);
    });

    test('missing or nonnumeric fields do not erase a previous snapshot', () => {
        const counter = new TokenCounter();
        counter.update(30, 20, 10, 5);
        counter.update(null, '40', {}, undefined);
        counter.update(NaN, Infinity, -Infinity, '5');
        counter.update();
        expect(totals(counter)).toEqual([30, 20, 10, 5]);
    });

    test('lifetime persistence counts reads separately and writes only as an input subset', async () => {
        const stored = {};
        let completed;
        const writeCompleted = new Promise(resolve => { completed = resolve; });
        globalThis.chrome = {
            runtime: {},
            storage: { local: {
                get: (_keys, callback) => callback(stored),
                set: (values, callback) => {
                    Object.assign(stored, values);
                    callback();
                    completed();
                }
            } }
        };
        const counter = new TokenCounter();
        counter.update(100, 10, 300, 70);
        counter.update(undefined, 40);
        counter.updateLifetimeTokens();
        await writeCompleted;
        expect(stored).toEqual({
            lifetime_input_tokens: 100,
            lifetime_output_tokens: 40,
            lifetime_cached_input_tokens: 300,
            lifetime_cache_write_input_tokens: 70
        });
    });
});

describe('token footer', () => {
    const render = (options = {}, isArena = false) => {
        const { document } = parseHTML('<div id="message"></div>');
        globalThis.document = document;
        const container = document.getElementById('message');
        new Footer(100, 20, isArena, () => false, () => {}, { ...options, hideRegenerate: true }).create(container);
        return container.querySelector('.message-footer');
    };

    test('displays reads separately without displaying writes as additional input', () => {
        const footer = render({ cachedInputTokens: 300, cacheWriteInputTokens: 70 });
        expect(footer.textContent).toBe('100 | 20 | 300 cached');
        expect(footer.querySelector('span').title).toContain('Cache writes: 70 (included in input)');
        expect(footer.getAttribute('input-tokens')).toBe('100');
        expect(footer.getAttribute('cached-input-tokens')).toBe('300');
        expect(footer.getAttribute('cache-write-input-tokens')).toBe('70');
    });

    test('keeps the existing compact format when no cached reads exist', () => {
        const footer = render({ cacheWriteInputTokens: 70 });
        expect(footer.textContent).toBe('100 | 20');
        expect(footer.querySelector('span').title).toContain('Cache writes: 70 (included in input)');
        expect(render().textContent).toBe('100 | 20');
    });

    test('preserves the arena input label while showing actual cached reads', () => {
        expect(render({ cachedInputTokens: 300 }, true).textContent).toBe('~ | 20 | 300 cached');
    });
});
