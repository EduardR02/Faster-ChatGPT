const copyIconSvg = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" class="icon-xs"><path fill-rule="evenodd" clip-rule="evenodd" d="M7 5C7 3.34315 8.34315 2 10 2H19C20.6569 2 22 3.34315 22 5V14C22 15.6569 20.6569 17 19 17H17V19C17 20.6569 15.6569 22 14 22H5C3.34315 22 2 20.6569 2 19V10C2 8.34315 3.34315 7 5 7H7V5ZM9 7H14C15.6569 7 17 8.34315 17 10V15H19C19.5523 15 20 14.5523 20 14V5C20 4.44772 19.5523 4 19 4H10C9.44772 4 9 4.44772 9 5V7ZM5 9C4.44772 9 4 9.44772 4 10V19C4 19.5523 4.44772 20 5 20H14C14.5523 20 15 19.5523 15 19V10C15 9.44772 14.5523 9 14 9H5Z" fill="currentColor"></path></svg>`;
const createCopyBtn = () => `<button class="unset-button copy-code-button" aria-label="Copy" title="Copy">${copyIconSvg}</button>`;

const escapeHtml = (text) => String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

const linkifyEscapedText = (escapedText) => escapedText.replace(/https?:\/\/[^\s<]+/g, url => `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`);

const formatPlainParagraph = (text) => {
    const escaped = escapeHtml(text);
    const linked = linkifyEscapedText(escaped);
    return `<p>${linked.replaceAll('\n', '<br>')}</p>`;
};

const formatPlainTextFallback = (message) => {
    const text = String(message ?? '');
    if (!text) return '<p></p>';

    const segments = text.split('```');
    const html = [];

    for (let i = 0; i < segments.length; i += 1) {
        const segment = segments[i];
        const isCode = i % 2 === 1;

        if (isCode) {
            const escapedCode = escapeHtml(segment.trim());
            html.push(`<div class="code-container">${createCopyBtn()}<pre class="code-style"><code>${escapedCode}</code></pre></div>`);
            continue;
        }

        const paragraphs = segment.split(/\n{2,}/);
        for (const paragraph of paragraphs) {
            if (!paragraph) continue;
            html.push(formatPlainParagraph(paragraph));
        }
    }

    return html.length ? html.join('\n') : '<p></p>';
};

const normalizeFenceLang = (info) => {
    const lang = (info || '').trim().split(/\s+/)[0] || '';
    return lang.replace(/[^A-Za-z0-9_-]/g, '');
};

const mathLangs = new Set(['latex', 'tex', 'math', 'katex']);

let mdInstance = null;
const getMarkdownRenderer = () => {
    if (mdInstance) return mdInstance;
    if (typeof globalThis.markdownit !== 'function') return null;

    const md = globalThis.markdownit({
        html: false,
        linkify: true,
        typographer: false,
        breaks: true,
        highlight: function(str, lang) {
            const normalizedLang = normalizeFenceLang(lang);
            if (mathLangs.has(normalizedLang)) return '';
            if (normalizedLang && globalThis.hljs && typeof globalThis.hljs.getLanguage === 'function' && globalThis.hljs.getLanguage(normalizedLang)) {
                try {
                    return globalThis.hljs.highlight(str, { language: normalizedLang, ignoreIllegals: true }).value;
                } catch (_) {
                    // fallthrough to default escaping
                }
            }
            return '';
        }
    });

    md.disable('image');

    if (typeof globalThis.texmath === 'function' && globalThis.temml) {
        md.use(globalThis.texmath, {
            engine: globalThis.temml,
            delimiters: ['dollars', 'brackets'],
            katexOptions: {
                throwOnError: false,
                trust: false
            }
        });
    }

    const defaultLinkOpen = md.renderer.rules.link_open || ((tokens, idx, options, env, self) => self.renderToken(tokens, idx, options));
    md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
        tokens[idx].attrSet('target', '_blank');
        tokens[idx].attrSet('rel', 'noopener noreferrer');
        return defaultLinkOpen(tokens, idx, options, env, self);
    };

    md.renderer.rules.fence = (tokens, idx, options) => {
        const token = tokens[idx];
        const lang = normalizeFenceLang(token.info);

        if (mathLangs.has(lang) && globalThis.temml) {
            try {
                const source = token.content.trim();
                const escapedSource = md.utils.escapeHtml(source);
                const mathHtml = globalThis.temml.renderToString(source, { displayMode: true, throwOnError: false, trust: false });
                return `<div class="code-container">${createCopyBtn()}<div class="math-block">${mathHtml}</div><pre class="math-copy-source" hidden><code class="copy-source">${escapedSource}</code></pre></div>\n`;
            } catch (_) {
                // fallthrough to code block
            }
        }

        const highlighted = typeof options.highlight === 'function' ? options.highlight(token.content, lang) : '';
        const codeHtml = highlighted || md.utils.escapeHtml(token.content);
        const codeClass = highlighted
            ? ` class="hljs${lang ? ' language-' + lang : ''}"`
            : (lang ? ` class="language-${lang}"` : '');

        return `<div class="code-container">${createCopyBtn()}<pre class="code-style"><code${codeClass}>${codeHtml}</code></pre></div>\n`;
    };

    mdInstance = md;
    return md;
};

/**
 * Formats message content for display using markdown-it + Temml.
 */
export function formatContent(message) {
    const md = getMarkdownRenderer();
    if (!md) return formatPlainTextFallback(message);
    return md.render(String(message ?? ''));
}

export class IncrementalRenderer {
    constructor() {
        this.reset();
    }

    reset() {
        this.stableHtml = '';
        this.stableLength = 0;
    }

    render(fullText) {
        const text = String(fullText ?? '');
        const md = getMarkdownRenderer();

        if (!md) {
            this.reset();
            return formatPlainTextFallback(text);
        }

        if (this.stableLength > text.length) {
            this.reset();
        }

        const splitPoint = this.findLastStableSplit(text);
        if (splitPoint > this.stableLength) {
            this.stableHtml = md.render(text.substring(0, splitPoint));
            this.stableLength = splitPoint;
        }

        const tail = text.substring(this.stableLength);
        const tailHtml = tail ? md.render(tail) : '';
        return this.stableHtml + tailHtml;
    }

    findLastStableSplit(text) {
        let inFence = false;
        let fenceChar = '';
        let fenceLen = 0;
        let inDisplayMath = false;
        let lastSplit = 0;
        let i = 0;
        let justOpenedDisplayMathAt = -1;

        while (i < text.length) {
            if (justOpenedDisplayMathAt >= 0 && i > justOpenedDisplayMathAt) {
                justOpenedDisplayMathAt = -1;
            }

            if (i === 0 || text[i - 1] === '\n') {
                let lineStart = i;
                let spaces = 0;
                while (spaces < 3 && lineStart < text.length && text[lineStart] === ' ') {
                    lineStart += 1;
                    spaces += 1;
                }

                const ch = text[lineStart];

                // Code fence detection (backtick/tilde, 3+ chars).
                if (!inDisplayMath && (ch === '`' || ch === '~')) {
                    let count = 0;
                    let j = lineStart;
                    while (j < text.length && text[j] === ch) {
                        count += 1;
                        j += 1;
                    }

                    if (count >= 3) {
                        if (!inFence) {
                            inFence = true;
                            fenceChar = ch;
                            fenceLen = count;
                        } else if (ch === fenceChar && count >= fenceLen) {
                            let k = j;
                            let onlyWhitespace = true;
                            while (k < text.length && text[k] !== '\n') {
                                const c = text[k];
                                if (c !== ' ' && c !== '\t' && c !== '\r') {
                                    onlyWhitespace = false;
                                    break;
                                }
                                k += 1;
                            }
                            if (onlyWhitespace) {
                                inFence = false;
                                fenceChar = '';
                                fenceLen = 0;
                            }
                        }
                    }
                }

                // Display math opening detection ($$ and \[ at line start, outside code fences).
                if (!inFence) {
                    if (!inDisplayMath && ch === '$' && lineStart + 1 < text.length && text[lineStart + 1] === '$') {
                        inDisplayMath = true;
                        justOpenedDisplayMathAt = lineStart;
                    } else if (!inDisplayMath && ch === '\\' && lineStart + 1 < text.length) {
                        const next = text[lineStart + 1];
                        if (next === '[') {
                            inDisplayMath = true;
                            justOpenedDisplayMathAt = lineStart;
                        }
                    }
                }
            }

            if (!inFence && inDisplayMath && i !== justOpenedDisplayMathAt) {
                if (text[i] === '\\' && i + 1 < text.length && text[i + 1] === ']') {
                    inDisplayMath = false;
                    i += 1;
                    continue;
                }

                if (text[i] === '$' && i + 1 < text.length && text[i + 1] === '$') {
                    inDisplayMath = false;
                    i += 1;
                    continue;
                }
            }

            // Paragraph boundary (only outside fences and display math).
            if (!inFence && !inDisplayMath && text[i] === '\n' && i + 1 < text.length && text[i + 1] === '\n') {
                lastSplit = i + 2;
            }

            i += 1;
        }

        return lastSplit;
    }
}

// Code copy: single delegated listener, initialized once at module load.
if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    document.addEventListener('click', event => {
        const copyButton = event.target.closest('.copy-code-button');
        if (!copyButton || copyButton.disabled) return;

        const codeContainer = copyButton.closest('.code-container');
        const codeText = codeContainer?.querySelector('.copy-source')?.textContent ?? codeContainer?.querySelector('code')?.textContent;
        if (codeText && navigator?.clipboard?.writeText) {
            navigator.clipboard.writeText(codeText).then(() => {
                copyButton.classList.add('copied');
                copyButton.addEventListener('transitionend', () => copyButton.classList.remove('copied'), { once: true });
            });
        }
    });
}

/**
 * Attaches auto-resize behavior to a textarea.
 */
export const autoResizeTextfieldListener = (elementId) => {
    const element = document.getElementById(elementId);
    if (!element) return;
    
    const updateHeight = () => updateTextfieldHeight(element);
    
    element.addEventListener('input', updateHeight);
    window.addEventListener('resize', updateHeight);
    
    updateHeight();
};

/**
 * Updates height of an element based on its scrollHeight.
 */
export function updateTextfieldHeight(element) {
    if (!element) return;
    
    element.style.height = 'auto';
    const contentHeight = element.scrollHeight;
    const computedStyle = typeof window !== 'undefined' && typeof window.getComputedStyle === 'function'
        ? window.getComputedStyle(element)
        : null;
    const maxHeight = Number.parseFloat(computedStyle?.maxHeight ?? '');
    const hasMaxHeight = Number.isFinite(maxHeight);
    const targetHeight = hasMaxHeight ? Math.min(contentHeight, maxHeight) : contentHeight;

    element.style.height = targetHeight + 'px';

    const isScrollable = hasMaxHeight && contentHeight > maxHeight + 2;
    element.style.overflowY = isScrollable ? 'auto' : 'hidden';
    
    if (isScrollable) {
        element.scrollTop = contentHeight;
    }
}

/**
 * Helper to create a DOM element with classes and optional text content.
 */
export const createElementWithClass = (tagName, className, textContent = null) => {
    const element = document.createElement(tagName);
    if (className) element.className = className;
    if (textContent !== null) element.textContent = textContent;
    return element;
};
