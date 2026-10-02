import { createElementWithClass } from './ui_utils.js';

export const createRegenerateButton = (onRegenerate, onAfterRemove = null) => {
    const regenerateButton = createElementWithClass('button', 'button regenerate-button', '\u{21BB}');
    regenerateButton.onclick = () => {
        onRegenerate();
        regenerateButton.classList.add('fade-out');

        regenerateButton.ontransitionend = (event) => {
            if (event.propertyName === 'opacity') {
                regenerateButton.remove();
                onAfterRemove?.();
            }
        };
    };
    return regenerateButton;
};

export class Footer {
    constructor(inputTokens, outputTokens, isArena, isThinkingCallback, regenCallback, options = {}) {
        this.inputTokens = inputTokens;
        this.outputTokens = outputTokens;
        this.cachedInputTokens = options.cachedInputTokens || 0;
        this.cacheWriteInputTokens = options.cacheWriteInputTokens || 0;
        this.isArena = isArena;
        this.isThinking = isThinkingCallback;
        this.regen = regenCallback;
        this.hideRegenerate = options.hideRegenerate || false;
    }

    create(containerDiv) {
        const footerDiv = createElementWithClass('div', 'message-footer');
        
        const tokenLabel = this.isArena ? "~" : this.inputTokens;
        const cachedLabel = this.cachedInputTokens ? ` | ${this.cachedInputTokens} cached` : '';
        const infoText = `${tokenLabel} | ${this.outputTokens}${cachedLabel}`;
        const infoSpan = createElementWithClass('span', '', infoText);
        infoSpan.title = 'Input (excluding cached reads) | Output';
        if (this.cachedInputTokens) infoSpan.title += ` | Cached reads: ${this.cachedInputTokens}`;
        if (this.cacheWriteInputTokens) {
            infoSpan.title += ` | Cache writes: ${this.cacheWriteInputTokens} (included in input)`;
        }
        
        footerDiv.setAttribute('input-tokens', this.inputTokens);
        footerDiv.setAttribute('cached-input-tokens', this.cachedInputTokens);
        footerDiv.setAttribute('cache-write-input-tokens', this.cacheWriteInputTokens);
        footerDiv.appendChild(infoSpan);
        
        if (!this.isThinking() && !this.hideRegenerate) {
            const regenerateButton = createRegenerateButton(this.regen, () => {
                footerDiv.classList.add('centered');
            });
            footerDiv.appendChild(regenerateButton);
        } else {
            footerDiv.classList.add('centered');
        }
        
        containerDiv.appendChild(footerDiv);
    }
}
