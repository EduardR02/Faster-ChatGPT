import { setLifetimeTokens } from './storage_utils.js';

export class TokenCounter {
    constructor(provider) {
        this.provider = provider;
        this.inputTokens = 0;
        this.outputTokens = 0;
    }

    update(inputCount, outputCount) {
        const isGemini = (this.provider === 'gemini');
        
        if (typeof inputCount === 'number') {
            // Gemini provides total cumulative counts, others provide deltas
            this.inputTokens = isGemini ? inputCount : (this.inputTokens + inputCount);
        }
        
        if (typeof outputCount === 'number') {
            this.outputTokens = isGemini ? outputCount : (this.outputTokens + outputCount);
        }
    }

    updateLifetimeTokens() { 
        setLifetimeTokens(this.inputTokens, this.outputTokens); 
    }
}
