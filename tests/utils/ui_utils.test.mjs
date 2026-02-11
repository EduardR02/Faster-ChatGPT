import { describe, test, expect, beforeEach, afterEach, afterAll } from 'bun:test';
import { updateTextfieldHeight } from '../../src/js/ui_utils.js';

let uiUtilsImportId = 0;
const importFreshUiUtils = async (tag) => {
    uiUtilsImportId += 1;
    return import(`../../src/js/ui_utils.js?${encodeURIComponent(tag)}=${uiUtilsImportId}`);
};

const originalMarkdownIt = globalThis.markdownit;
const originalTemml = globalThis.temml;
const originalTexmath = globalThis.texmath;

const ensureRealMarkdownIt = async () => {
    if (typeof globalThis.markdownit === 'function') return;
    const mod = await import('../../vendor/markdown-it/markdown-it.min.js');
    globalThis.markdownit = mod.default;
};

const normalizeHtml = (html) => String(html).replace(/\s+/g, ' ').trim();

afterAll(() => {
    globalThis.markdownit = originalMarkdownIt;
    globalThis.temml = originalTemml;
    globalThis.texmath = originalTexmath;
});

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

describe('formatContent', () => {
    test('fallback: renders safe plain text when markdown-it is unavailable', async () => {
        const previousMarkdownIt = globalThis.markdownit;
        globalThis.markdownit = undefined;

        try {
            const { formatContent } = await importFreshUiUtils('formatContent-fallback-no-markdownit');
            const html = formatContent('<b>unsafe</b>\nline 2\n\nhttps://example.com?q=1&x=2');

            expect(html).toContain('<p>');
            expect(html).toContain('&lt;b&gt;unsafe&lt;/b&gt;');
            expect(html).toContain('<br>');
            expect(html).toContain('target="_blank"');
            expect(html).toContain('rel="noopener noreferrer"');
            expect(html).not.toContain('<b>unsafe</b>');
        } finally {
            globalThis.markdownit = previousMarkdownIt;
        }
    });

    test('security: HTML disabled', async () => {
        await ensureRealMarkdownIt();
        const { formatContent } = await importFreshUiUtils('formatContent-html-disabled');

        const html = formatContent('<script>alert(1)</script>');
        expect(html).not.toContain('<script>');
        expect(html).toContain('&lt;script&gt;');
        expect(html).toContain('&lt;/script&gt;');
    });

    test('security: images disabled', async () => {
        await ensureRealMarkdownIt();
        const { formatContent } = await importFreshUiUtils('formatContent-images-disabled');

        const html = formatContent('![alt](http://evil.com/img.png)');
        expect(html).not.toContain('<img');
    });

    test('security: links get target=_blank and rel=noopener noreferrer', async () => {
        await ensureRealMarkdownIt();
        const { formatContent } = await importFreshUiUtils('formatContent-links-target');

        const html = formatContent('[link](https://example.com)');
        expect(html).toContain('target="_blank"');
        expect(html).toContain('rel="noopener noreferrer"');
    });

    test('code blocks render inside code-container with code element', async () => {
        await ensureRealMarkdownIt();
        const { formatContent } = await importFreshUiUtils('formatContent-code-fence');

        const html = formatContent('```js\nconsole.log("hi")\n```');
        expect(html).toContain('<div class="code-container">');
        expect(html).toContain('<code');
    });

    test('basic markdown renders strong and em', async () => {
        await ensureRealMarkdownIt();
        const { formatContent } = await importFreshUiUtils('formatContent-basic');

        const html = formatContent('**bold** *italic*');
        expect(html).toContain('<strong>');
        expect(html).toContain('<em>');
    });

    test('math fences include copyable source and pass trust=false to Temml', async () => {
        await ensureRealMarkdownIt();

        const previousTemml = globalThis.temml;
        const previousTexmath = globalThis.texmath;
        let texmathOptions = null;
        const texmathSpy = (md, options) => {
            texmathOptions = options;
        };
        const temmlSpy = {
            renderToString: (source, options) => {
                temmlSpy.lastCall = { source, options };
                return `<math>${source}</math>`;
            },
            lastCall: null
        };

        globalThis.texmath = texmathSpy;
        globalThis.temml = temmlSpy;

        try {
            const { formatContent } = await importFreshUiUtils('formatContent-math-fence-copy-source');
            const html = formatContent(['```latex', 'a^2 + b^2 = c^2', '```'].join('\n'));

            expect(html).toContain('<div class="code-container">');
            expect(html).toContain('class="copy-source"');
            expect(html).toContain('a^2 + b^2 = c^2');
            expect(temmlSpy.lastCall?.options?.trust).toBe(false);
            expect(texmathOptions?.katexOptions?.trust).toBe(false);
        } finally {
            globalThis.temml = previousTemml;
            globalThis.texmath = previousTexmath;
        }
    });

    test('preserves multiple spaces within paragraph output', async () => {
        await ensureRealMarkdownIt();
        const { formatContent } = await importFreshUiUtils('formatContent-preserves-multi-space');

        const paragraphHtml = formatContent('alpha  beta');
        const listHtml = formatContent('- item  value');

        expect(paragraphHtml).toContain('<p>alpha  beta</p>');
        expect(listHtml).toContain('item  value');
    });
});

describe('IncrementalRenderer', () => {
    test('no split point: renders entirely as tail (matches full render)', async () => {
        await ensureRealMarkdownIt();
        const { IncrementalRenderer, formatContent } = await importFreshUiUtils('incremental-no-split');

        const renderer = new IncrementalRenderer();
        const text = 'Hello world';
        const inc = renderer.render(text);
        const full = formatContent(text);

        expect(normalizeHtml(inc)).toBe(normalizeHtml(full));
        expect(renderer.stableLength).toBe(0);
        expect(renderer.stableHtml).toBe('');
    });

    test('split at paragraph boundary: caches stable portion and re-renders tail', async () => {
        await ensureRealMarkdownIt();
        const { IncrementalRenderer, formatContent } = await importFreshUiUtils('incremental-paragraph-split');

        const renderer = new IncrementalRenderer();
        const text1 = 'First paragraph.\n\nSecond';
        const split = text1.indexOf('\n\n') + 2;
        expect(split).toBeGreaterThan(1);

        renderer.render(text1);
        expect(renderer.stableLength).toBe(split);
        expect(renderer.stableHtml).toBe(formatContent(text1.slice(0, split)));

        const stableHtmlBefore = renderer.stableHtml;
        const stableLengthBefore = renderer.stableLength;
        const text2 = text1 + ' more';
        const inc2 = renderer.render(text2);

        expect(renderer.stableLength).toBe(stableLengthBefore);
        expect(renderer.stableHtml).toBe(stableHtmlBefore);
        expect(normalizeHtml(inc2)).toBe(normalizeHtml(formatContent(text2)));
    });

    test('code fence protection: does not split on \\n\\n inside fenced code', async () => {
        await ensureRealMarkdownIt();
        const { IncrementalRenderer } = await importFreshUiUtils('incremental-code-fence-protection');

        const renderer = new IncrementalRenderer();
        const text = [
            '```js',
            "console.log('a');",
            '',
            "console.log('b');",
            '```',
            '',
            'after'
        ].join('\n');

        const outsideSplitIndex = text.indexOf('\n\nafter');
        expect(outsideSplitIndex).toBeGreaterThan(-1);
        const expectedSplit = outsideSplitIndex + 2;

        renderer.render(text);
        expect(renderer.stableLength).toBe(expectedSplit);

        const stableText = text.slice(0, renderer.stableLength);
        expect(stableText).toContain('\n```\n\n');
        expect(stableText).not.toContain('after');
    });

    test('incremental growth: stableLength only grows', async () => {
        await ensureRealMarkdownIt();
        const { IncrementalRenderer } = await importFreshUiUtils('incremental-growth');

        const renderer = new IncrementalRenderer();
        const inputs = [
            'a',
            'a\n\nb',
            'a\n\nb\n\nc',
            'a\n\nb\n\nc\nd'
        ];

        let last = 0;
        for (const text of inputs) {
            renderer.render(text);
            expect(renderer.stableLength).toBeGreaterThanOrEqual(last);
            const expected = text.includes('\n\n') ? text.lastIndexOf('\n\n') + 2 : 0;
            expect(renderer.stableLength).toBe(expected);
            last = renderer.stableLength;
        }
    });

    test('reset clears stableHtml and stableLength', async () => {
        await ensureRealMarkdownIt();
        const { IncrementalRenderer } = await importFreshUiUtils('incremental-reset');

        const renderer = new IncrementalRenderer();
        renderer.render('p1\n\np2');
        expect(renderer.stableLength).toBeGreaterThan(0);
        expect(renderer.stableHtml).not.toBe('');

        renderer.reset();
        expect(renderer.stableLength).toBe(0);
        expect(renderer.stableHtml).toBe('');
    });

    test('consistency: incremental render matches full markdown render for typical output', async () => {
        await ensureRealMarkdownIt();
        const { IncrementalRenderer, formatContent } = await importFreshUiUtils('incremental-consistency');

        const text = [
            'Intro paragraph.',
            '',
            '```js',
            "console.log('hi')",
            '```',
            '',
            'Outro paragraph.'
        ].join('\n');

        const renderer = new IncrementalRenderer();
        const inc = renderer.render(text);
        const full = formatContent(text);

        expect(normalizeHtml(inc)).toBe(normalizeHtml(full));
    });

    test('single-line \\[..\\] display math closes and allows stable split', async () => {
        await ensureRealMarkdownIt();
        const { IncrementalRenderer } = await importFreshUiUtils('incremental-display-math-single-line-close');

        const renderer = new IncrementalRenderer();
        const text = '\\[ E=mc^2 \\]\n\nNext paragraph';
        const expectedSplit = text.indexOf('\n\n') + 2;

        renderer.render(text);

        expect(expectedSplit).toBeGreaterThan(1);
        expect(renderer.stableLength).toBe(expectedSplit);
        expect(renderer.stableHtml).not.toBe('');
    });
});
