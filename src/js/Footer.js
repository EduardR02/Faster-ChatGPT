import { createElementWithClass } from './ui_utils.js';

export class Footer {
    constructor(inputTokens, outputTokens, isArena, isThinkingCallback, regenCallback) {
        this.inputTokens = inputTokens;
        this.outputTokens = outputTokens;
        this.isArena = isArena;
        this.isThinking = isThinkingCallback;
        this.regen = regenCallback;
    }

    create(containerDiv) {
        const footerDiv = createElementWithClass('div', 'message-footer');
        
        const tokenLabel = this.isArena ? "~" : this.inputTokens;
        const infoText = `${tokenLabel} | ${this.outputTokens}`;
        const infoSpan = createElementWithClass('span', '', infoText);
        
        footerDiv.setAttribute('input-tokens', this.inputTokens);
        footerDiv.appendChild(infoSpan);
        
        if (!this.isThinking()) {
            const regenerateButton = createElementWithClass('button', 'button regenerate-button', '\u{21BB}'); // Refresh icon
            
            regenerateButton.onclick = () => {
                this.regen();
                regenerateButton.classList.add('fade-out');
                
                regenerateButton.ontransitionend = (event) => {
                    if (event.propertyName === 'opacity') {
                        regenerateButton.remove();
                        footerDiv.classList.add('centered');
                    }
                };
            };
            
            footerDiv.appendChild(regenerateButton);
        } else {
            footerDiv.classList.add('centered');
        }
        
        containerDiv.appendChild(footerDiv);
    }
}
