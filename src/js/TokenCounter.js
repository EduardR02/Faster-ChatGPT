import { setLifetimeTokens } from './storage_utils.js';

export class TokenCounter {
    constructor() {
        // Input includes cache writes; cached reads are a separate category.
        this.inputTokens = 0;
        this.outputTokens = 0;
        this.cachedInputTokens = 0;
        this.cacheWriteInputTokens = 0;
    }

    // Each supplied value is a cumulative snapshot for one API response.
    update(inputCount, outputCount, cachedInputCount, cacheWriteInputCount) {
        if (Number.isFinite(inputCount)) this.inputTokens = inputCount;
        if (Number.isFinite(outputCount)) this.outputTokens = outputCount;
        if (Number.isFinite(cachedInputCount)) this.cachedInputTokens = cachedInputCount;
        if (Number.isFinite(cacheWriteInputCount)) this.cacheWriteInputTokens = cacheWriteInputCount;
    }

    updateLifetimeTokens() { 
        setLifetimeTokens(this.inputTokens, this.outputTokens, this.cachedInputTokens, this.cacheWriteInputTokens);
    }
}
