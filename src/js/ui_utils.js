const copyIconSvg = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" class="icon-xs"><path fill-rule="evenodd" clip-rule="evenodd" d="M7 5C7 3.34315 8.34315 2 10 2H19C20.6569 2 22 3.34315 22 5V14C22 15.6569 20.6569 17 19 17H17V19C17 20.6569 15.6569 22 14 22H5C3.34315 22 2 20.6569 2 19V10C2 8.34315 3.34315 7 5 7H7V5ZM9 7H14C15.6569 7 17 8.34315 17 10V15H19C19.5523 15 20 14.5523 20 14V5C20 4.44772 19.5523 4 19 4H10C9.44772 4 9 4.44772 9 5V7ZM5 9C4.44772 9 4 9.44772 4 10V19C4 19.5523 4.44772 20 5 20H14C14.5523 20 15 19.5523 15 19V10C15 9.44772 14.5523 9 14 9H5Z" fill="currentColor"></path></svg>`;
const createCopyBtn = () => `<button class="unset-button copy-code-button" aria-label="Copy" title="Copy">${copyIconSvg}</button>`;

const normalizeFenceLang = (info) => {
    const lang = (info || '').trim().split(/\s+/)[0] || '';
    return lang.replace(/[^A-Za-z0-9_-]/g, '');
};

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

    // Avoid loading remote images from markdown content.
    md.disable('image');

    if (typeof globalThis.texmath === 'function' && globalThis.katex) {
        md.use(globalThis.texmath, {
            engine: globalThis.katex,
            delimiters: ['dollars', 'brackets'],
            katexOptions: { throwOnError: false }
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

const formatContentLegacy = (message) => {
    const escapeMap = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;'
    };

    let formattedText = message.replace(/[&<>"']/g, char => escapeMap[char]);

    // Convert newlines to <br> tags since .message-content uses white-space: normal
    formattedText = formattedText.replace(/\n/g, '<br>\n');

    const codeBlockRegex = /(\n*)```(\w*)\n([\s\S]*?)```(\n+|$)/g;
    formattedText = formattedText.replace(codeBlockRegex, (match, preNewlines, language, codeContent) => {
        const lang = normalizeFenceLang(language);
        const codeElementHtml = `<code${lang ? ` class="language-${lang}"` : ''}>${codeContent}</code>`;
        const codeStyleDivHtml = `<pre class="code-style">${codeElementHtml}</pre>`;
        return `\n\n<div class="code-container">${createCopyBtn()}${codeStyleDivHtml}</div>\n`;
    });

    const markdownLinkRegex = /\[([^\]]+)\]\((https?:\/\/[^\)\s]+)\)/g;
    formattedText = formattedText.replace(markdownLinkRegex, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');

    return formattedText;
};

/**
 * Formats message content for display using markdown-it + KaTeX when available.
 */
export function formatContent(message) {
    initCodeCopy();

    const content = message ?? '';
    const md = getMarkdownRenderer();
    if (md) {
        try {
            return md.render(content);
        } catch (e) {
            console.error('Markdown render failed:', e);
            return formatContentLegacy(String(content));
        }
    }

    return formatContentLegacy(String(content));
}

let isCodeCopyInitialized = false;
/**
 * One-time initialization of global code copy event listener.
 */
function initCodeCopy() {
    if (isCodeCopyInitialized) return;

    if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') {
        return;
    }
    
    document.addEventListener('click', event => {
        const copyButton = event.target.closest('.copy-code-button');
        if (!copyButton || copyButton.disabled) return;
        
        const container = copyButton.closest('.code-container');
        const codeElement = container?.querySelector('code');
        const codeText = codeElement?.textContent;
        
        if (codeText && navigator?.clipboard?.writeText) {
            navigator.clipboard.writeText(codeText).then(() => {
                copyButton.classList.add('copied');
                
                const onTransitionEnd = () => {
                    copyButton.classList.remove('copied');
                };
                copyButton.addEventListener('transitionend', onTransitionEnd, { once: true });
            });
        }
    });
    
    isCodeCopyInitialized = true;
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
