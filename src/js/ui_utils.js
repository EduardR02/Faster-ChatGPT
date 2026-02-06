/**
 * Formats message content for display, handling escaping, code blocks, and links.
 */
export function formatContent(message) {
    initCodeCopy();
    
    const escapeMap = { 
        '&': '&amp;', 
        '<': '&lt;', 
        '>': '&gt;', 
        '"': '&quot;', 
        "'": '&#039;' 
    };
    
    // 1. Escape HTML entities
    let formattedText = message.replace(/[&<>"']/g, char => escapeMap[char]);

    // 2. Format code blocks
    const codeBlockRegex = /(\n*)```(\w*)\n([\s\S]*?)```(\n+|$)/g;
    formattedText = formattedText.replace(codeBlockRegex, (match, preNewlines, language, codeContent) => {
        const copyButtonHtml = createCopyBtn();
        const codeElementHtml = `<code class="language-${language}">${codeContent}</code>`;
        const codeStyleDivHtml = `<div class="code-style">${codeElementHtml}</div>`;
        
        return `\n\n<div class="code-container">${copyButtonHtml}${codeStyleDivHtml}</div>\n`;
    });

    // 3. Format markdown links
    const markdownLinkRegex = /\[([^\]]+)\]\((https?:\/\/[^\)\s]+)\)/g;
    formattedText = formattedText.replace(markdownLinkRegex, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');

    return formattedText;
}

/**
 * Applies syntax highlighting to code elements within a container.
 */
export const highlightCodeBlocks = (container) => {
    container.querySelectorAll('code').forEach(codeElement => {
        if (typeof hljs !== 'undefined') {
            hljs.highlightElement(codeElement);
        }
    });
};

const copyIconSvg = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" class="icon-xs"><path fill-rule="evenodd" clip-rule="evenodd" d="M7 5C7 3.34315 8.34315 2 10 2H19C20.6569 2 22 3.34315 22 5V14C22 15.6569 20.6569 17 19 17H17V19C17 20.6569 15.6569 22 14 22H5C3.34315 22 2 20.6569 2 19V10C2 8.34315 3.34315 7 5 7H7V5ZM9 7H14C15.6569 7 17 8.34315 17 10V15H19C19.5523 15 20 14.5523 20 14V5C20 4.44772 19.5523 4 19 4H10C9.44772 4 9 4.44772 9 5V7ZM5 9C4.44772 9 4 9.44772 4 10V19C4 19.5523 4.44772 20 5 20H14C14.5523 20 15 19.5523 15 19V10C15 9.44772 14.5523 9 14 9H5Z" fill="currentColor"></path></svg>`;
const createCopyBtn = () => `<button class="unset-button copy-code-button" aria-label="Copy" title="Copy">${copyIconSvg}</button>`;

let isCodeCopyInitialized = false;
/**
 * One-time initialization of global code copy event listener.
 */
function initCodeCopy() {
    if (isCodeCopyInitialized) return;
    
    document.addEventListener('click', event => {
        const copyButton = event.target.closest('.copy-code-button');
        if (!copyButton || copyButton.disabled) return;
        
        const container = copyButton.closest('.code-container');
        const codeElement = container?.querySelector('code');
        const codeText = codeElement?.textContent.trim();
        
        if (codeText) {
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
