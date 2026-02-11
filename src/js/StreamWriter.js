import { formatContent, IncrementalRenderer } from './ui_utils.js';

const canLiveRenderMarkdown = () => typeof globalThis.markdownit === 'function';

const getPartContentText = (part) => {
    const content = part?.content ?? '';
    return Array.isArray(content) ? content.join('') : content;
};

const hasNonWhitespaceContent = (part) => getPartContentText(part).trim().length > 0;

/**
 * Basic writer for non-UI streaming (e.g., auto-renaming).
 */
export class StreamWriterBase {
    constructor(container = null) {
        Object.assign(this, {
            contentDiv: container,
            chunks: [],
            isFirstChunk: true
        });
    }

    setThinkingModel() {}

    onComplete() {}

    processContent(content, isThought = false) {
        if (isThought) return; // Discard thoughts for renaming
        
        this.chunks.push(content);
        if (this.contentDiv) {
            if (this.isFirstChunk) {
                this.contentDiv.textContent = "";
                this.isFirstChunk = false;
            }
            this.contentDiv.append(content);
        }
    }

    done() {
        return this.chunks.join('');
    }
}

/**
 * Standard UI stream writer.
 */
export class StreamWriterSimple {
    constructor(contentDiv, produceNextDiv, scrollCallback = () => {}) {
        Object.assign(this, {
            contentDiv,
            produceNextDiv,
            scrollFunc: scrollCallback,
            parts: [{ type: 'text', content: [] }],
            isThoughtEnd: true,
            isThinkingModel: false,
            intervalId: null,
            thinkingCounter: null,
            bufferedContent: '',
            fullText: '',
            renderer: new IncrementalRenderer(),
            renderScheduled: false,
            useMarkdown: canLiveRenderMarkdown()
        });
    }

    _onNonEmptySwitch(isThought, currentPart) {
        this.nextPart(isThought);
    }

    _onDiscardReset() {
        this.bufferedContent = '';
        this.fullText = '';
        this.renderer.reset();
    }

    _handleTransition(content, isThought) {
        if (!content) return;

        if (isThought !== this.isThoughtEnd) return;

        this.isThoughtEnd = !isThought;
        const nextType = isThought ? 'thought' : 'text';
        const currentPart = this.parts.at(-1);
        const leavingType = isThought ? 'text' : 'thought';

        if (currentPart?.type === leavingType && !hasNonWhitespaceContent(currentPart)) {
            this.parts.pop();
            this.contentDiv.textContent = '';
            this._onDiscardReset();
            if (isThought) this.contentDiv.classList.add('thoughts');
            else this.contentDiv.classList.remove('thoughts');
            this.parts.push({ type: nextType, content: [] });
            return;
        }

        this._onNonEmptySwitch(isThought, currentPart);
        if (this.parts.at(-1)?.type !== nextType) {
            this.parts.push({ type: nextType, content: [] });
        }
    }

    _renderToDOM() {
        if (!this.useMarkdown) return;
        this.contentDiv.innerHTML = this.renderer.render(this.fullText);
        this.scrollFunc();
    }

    setThinkingModel() {
        this.isThoughtEnd = false;
        this.contentDiv.classList.add('thoughts');
        this.parts = [{ type: 'thought', content: [] }];
        this.bufferedContent = '';
        this.fullText = '';
        this.renderer.reset();
        this.isThinkingModel = true;
    }

    onComplete() {}

    addThinkingCounter() {
        const prefixSpan = this.contentDiv.closest('.assistant-message')?.querySelector('.message-prefix');
        if (!prefixSpan) return;

        this.thinkingModelWithCounter = true;

        const [firstWord, ...remainingWords] = prefixSpan.textContent.split(' ');
        const labelSuffix = remainingWords.length ? ' ' + remainingWords.join(' ') : '';
        const originalText = prefixSpan.textContent;
        const counter = {
            prefixSpan,
            originalText,
            firstWord,
            labelSuffix,
            secondsElapsed: 0,
            hasContent: false
        };

        this.stopThinkingCounter();
        this.intervalId = setInterval(() => {
            if (counter.hasContent) return;
            counter.secondsElapsed += 1;
            prefixSpan.textContent = `${firstWord} thinking for ${counter.secondsElapsed}s...${labelSuffix}`;
        }, 1000);
        this.thinkingCounter = counter;

        const originalProcessContent = this.processContent.bind(this);
        this.processContent = (content, isThought) => {
            if (!counter.hasContent) {
                counter.hasContent = true;
                this.stopThinkingCounter();
                if (content) {
                    prefixSpan.textContent = `${firstWord} thought for ${counter.secondsElapsed}s${labelSuffix}`;
                } else {
                    prefixSpan.textContent = originalText;
                }
            }
            originalProcessContent(content, isThought);
        };
    }

    stopThinkingCounter() {
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
        }
        if (this.thinkingCounter && !this.thinkingCounter.hasContent) {
            this.thinkingCounter.prefixSpan.textContent = this.thinkingCounter.originalText;
        }
        this.thinkingCounter = null;
    }

    processContent(content, isThought = false) {
        if (!content) return;

        this._handleTransition(content, isThought);

        this.parts.at(-1).content.push(content);
        this.fullText += content;
        this.bufferedContent += content;
        this.scheduleRender();
    }

    scheduleRender() {
        if (this.renderScheduled) return;

        this.renderScheduled = true;
        requestAnimationFrame(() => {
            this.renderScheduled = false;
            this.flushBufferedContent();
        });
    }

    flushBufferedContent() {
        if (!this.bufferedContent) return;

        if (this.useMarkdown) {
            this.bufferedContent = '';
            this._renderToDOM();
            return;
        }

        this.contentDiv.append(this.bufferedContent);
        this.bufferedContent = '';
        this.scrollFunc();
    }

    nextPart(isThought = false) {
        this.finalizeCurrentPart();
        this.parts.push({ type: isThought ? 'thought' : 'text', content: [] });
        this.switchDiv(isThought);
    }

    switchDiv(isThought = false) {
        const nextDiv = this.produceNextDiv('assistant', isThought);
        const wrapper = this.contentDiv.closest('.message-wrapper') || this.contentDiv.parentElement;
        
        wrapper.appendChild(nextDiv);
        this.contentDiv = nextDiv;
        this.bufferedContent = '';
        this.fullText = '';
        this.renderer.reset();
    }

    finalizeCurrentPart() {
        this.flushBufferedContent();

        const current = this.parts.at(-1);
        const content = getPartContentText(current);
        current.content = current.type === 'thought' && !content.trim() ? '' : content;
        
        if (current.type === 'image') {
            this.updateImageContent(current.content);
        } else {
            this.updateTextContent(current.content);
        }
    }

    updateImageContent(content) {
        this.contentDiv.classList.remove('message-content');
        this.contentDiv.classList.add('image-content');
        const img = document.createElement('img');
        img.src = content;
        this.contentDiv.innerHTML = '';
        this.contentDiv.appendChild(img);
    }

    updateTextContent(content) {
        this.contentDiv.innerHTML = formatContent(content);
    }


    async addFooter(footer) {
        this.stopThinkingCounter();
        this.finalizeCurrentPart();
        footer.create(this.contentDiv);
        this.scrollFunc();
    }
}

/**
 * Smooth stream writer with artificial delay for readability.
 */
export class StreamWriter extends StreamWriterSimple {
    constructor(contentDiv, produceNextDiv, scrollCallback, wordsPerMinute = 200) {
        super(contentDiv, produceNextDiv, scrollCallback);
        Object.assign(this, {
            contentQueue: [],
            contentOffset: 0,
            consumedChunkCount: 0,
            isProcessing: false,
            charDelay: 12000 / wordsPerMinute,
            accumulatedChars: 0,
            lastFrameTime: 0,
            pendingFooter: null,
            transitionQueue: []
        });
    }

    setThinkingModel() {
        super.setThinkingModel();
        this.transitionQueue = [];
        this.contentQueue = [];
        this.contentOffset = 0;
        this.consumedChunkCount = 0;
    }

    _onNonEmptySwitch(isThought, currentPart) {
        if (currentPart) {
            currentPart.content = getPartContentText(currentPart);
        }

        this.transitionQueue.push({
            boundaryIndex: this.consumedChunkCount + this.contentQueue.length,
            isThought,
            nextPartIndex: this.parts.length
        });
    }

    _onDiscardReset() {
        this.fullText = '';
        this.renderer.reset();
        this.contentQueue = [];
        this.contentOffset = 0;
        this.consumedChunkCount = 0;
        this.transitionQueue = [];
    }

    processContent(content, isThought = false) {
        if (!content) return;

        this._handleTransition(content, isThought);

        this.parts.at(-1).content.push(content);
        this.contentQueue.push(content);

        if (!this.isProcessing) {
            this.isProcessing = true;
            this.lastFrameTime = 0;
            this.runAnimationLoop();
        }
    }

    hasActiveQueueContent() {
        this.normalizeActiveQueue();
        return this.contentQueue.length > 0;
    }

    normalizeActiveQueue() {
        while (this.contentQueue.length && this.contentOffset >= this.contentQueue[0].length) {
            this.contentQueue.shift();
            this.contentOffset = 0;
            this.consumedChunkCount += 1;
        }
    }

    consumeChars(charCount) {
        if (charCount <= 0) return '';

        const chunks = [];
        let remaining = charCount;

        while (remaining > 0 && this.contentQueue.length) {
            this.normalizeActiveQueue();
            if (!this.contentQueue.length) break;

            const nextTransition = this.transitionQueue[0];
            if (nextTransition && this.contentOffset === 0 && this.consumedChunkCount === nextTransition.boundaryIndex) {
                break;
            }

            const current = this.contentQueue[0];
            const available = current.length - this.contentOffset;

            if (available <= remaining) {
                chunks.push(current.slice(this.contentOffset));
                remaining -= available;
                this.contentQueue.shift();
                this.contentOffset = 0;
                this.consumedChunkCount += 1;
                continue;
            }

            const endOffset = this.contentOffset + remaining;
            chunks.push(current.slice(this.contentOffset, endOffset));
            this.contentOffset = endOffset;
            remaining = 0;
        }

        return chunks.join('');
    }

    switchAtBoundaries(timestamp) {
        let switched = false;

        while (this.transitionQueue.length) {
            this.normalizeActiveQueue();

            const transition = this.transitionQueue[0];
            if (this.contentOffset !== 0 || this.consumedChunkCount !== transition.boundaryIndex) break;

            const previousPart = this.parts[transition.nextPartIndex - 1];
            if (previousPart) this.updateTextContent(previousPart.content);

            this.switchDiv(transition.isThought);
            this.transitionQueue.shift();
            switched = true;
        }

        if (switched) {
            this.accumulatedChars = 0;
            this.lastFrameTime = timestamp;
        }
    }

    finalizeIfIdle() {
        if (this.hasActiveQueueContent()) return false;

        this.isProcessing = false;
        if (this.pendingFooter) {
            const { footer, resolve } = this.pendingFooter;
            this.pendingFooter = null;
            super.addFooter(footer).then(resolve);
        }

        return true;
    }

    runAnimationLoop() {
        requestAnimationFrame(timestamp => {
            this.switchAtBoundaries(timestamp);
            if (this.finalizeIfIdle()) return;

            if (!this.lastFrameTime) this.lastFrameTime = timestamp;

            const elapsed = timestamp - this.lastFrameTime;
            this.accumulatedChars += elapsed / this.charDelay;

            const charCount = Math.floor(this.accumulatedChars);
            this.accumulatedChars -= charCount;

            if (charCount > 0) {
                const chunk = this.consumeChars(charCount);
                this.accumulatedChars += charCount - chunk.length;
                if (chunk) {
                    if (this.useMarkdown) {
                        this.fullText += chunk;
                        this._renderToDOM();
                    } else {
                        this.contentDiv.append(chunk);
                        this.scrollFunc();
                    }
                }
            }

            this.switchAtBoundaries(timestamp);
            if (this.finalizeIfIdle()) return;

            this.lastFrameTime = timestamp;
            this.runAnimationLoop();
        });
    }

    addFooter(footer) {
        if (this.isProcessing) {
            return new Promise(resolve => {
                this.pendingFooter = { footer, resolve };
            });
        }
        return super.addFooter(footer);
    }
}
