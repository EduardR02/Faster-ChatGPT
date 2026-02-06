import { formatContent, highlightCodeBlocks } from './ui_utils.js';

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
            renderScheduled: false
        });
    }

    setThinkingModel() {
        this.isThoughtEnd = false;
        this.contentDiv.classList.add('thoughts');
        this.parts = [{ type: 'thought', content: [] }];
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

        // Handle transitions from thought to text (only when content is non-empty)
        if (!isThought && !this.isThoughtEnd) {
            this.isThoughtEnd = true;
            const currentPart = this.parts.at(-1);
            if (currentPart.type === 'thought' && currentPart.content.length === 0) {
                this.parts.pop();
                this.contentDiv.classList.remove('thoughts');
                this.parts.push({ type: 'text', content: [] });
            } else {
                this.nextPart();
            }
        }
        // Handle transition back from text to thought (for interleaved streams)
        else if (isThought && this.isThoughtEnd) {
            this.isThoughtEnd = false;
            const currentPart = this.parts.at(-1);
            if (currentPart.type === 'text' && currentPart.content.length === 0) {
                this.parts.pop();
                this.contentDiv.classList.add('thoughts');
                this.parts.push({ type: 'thought', content: [] });
            } else {
                this.nextPart(true);
            }
        }

        this.parts.at(-1).content.push(content);
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
    }

    finalizeCurrentPart() {
        this.flushBufferedContent();

        const current = this.parts.at(-1);
        current.content = current.content.join('');
        
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
        highlightCodeBlocks(this.contentDiv);
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
            isProcessing: false,
            charDelay: 12000 / wordsPerMinute,
            accumulatedChars: 0,
            lastFrameTime: 0,
            pendingFooter: null,
            pendingSwitch: false,
            pendingQueue: []
        });
    }

    setThinkingModel() {
        super.setThinkingModel();
        this.pendingSwitch = false;
        this.pendingQueue = [];
        this.contentOffset = 0;
    }

    processContent(content, isThought = false) {
        if (!content) return;

        // Handle transition from thought to text (only when content is non-empty)
        if (!isThought && !this.isThoughtEnd) {
            this.isThoughtEnd = true;
            if (this.parts.at(-1).content.length > 0) {
                this.pendingSwitch = true;
                this.parts.at(-1).content = this.parts.at(-1).content.join('');
            } else {
                this.parts.pop();
            }
            this.parts.push({ type: 'text', content: [] });
        }
        // Handle transition back from text to thought (for interleaved streams)
        else if (isThought && this.isThoughtEnd) {
            this.isThoughtEnd = false;
            // Finalize current text part if it has content
            if (this.parts.at(-1).content.length > 0) {
                this.pendingSwitch = true;
                this.parts.at(-1).content = this.parts.at(-1).content.join('');
            }
            this.parts.push({ type: 'thought', content: [] });
        }

        this.parts.at(-1).content.push(content);
        const targetQueue = this.pendingSwitch ? this.pendingQueue : this.contentQueue;
        if (content) {
            targetQueue.push(content);
        }

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
        }
    }

    consumeChars(charCount) {
        if (charCount <= 0) return '';

        const chunks = [];
        let remaining = charCount;

        while (remaining > 0 && this.contentQueue.length) {
            this.normalizeActiveQueue();
            if (!this.contentQueue.length) break;

            const current = this.contentQueue[0];
            const available = current.length - this.contentOffset;

            if (available <= remaining) {
                chunks.push(current.slice(this.contentOffset));
                remaining -= available;
                this.contentQueue.shift();
                this.contentOffset = 0;
                continue;
            }

            const endOffset = this.contentOffset + remaining;
            chunks.push(current.slice(this.contentOffset, endOffset));
            this.contentOffset = endOffset;
            remaining = 0;
        }

        return chunks.join('');
    }

    runAnimationLoop() {
        requestAnimationFrame(timestamp => {
            // Handle switching to text div after thought queue is empty - must check BEFORE early exit
            if (this.pendingSwitch && !this.hasActiveQueueContent()) {
                this.pendingSwitch = false;
                this.contentQueue = this.pendingQueue;
                this.pendingQueue = [];
                this.contentOffset = 0;

                // Finalize previous thought part
                const previousPart = this.parts.length >= 2 ? this.parts.at(-2) : null;
                if (previousPart) {
                    this.updateTextContent(previousPart.content);
                }

                this.switchDiv(this.parts.at(-1).type === 'thought');
                
                // Reset accumulated chars to prevent "clumped" start on new div
                this.accumulatedChars = 0;
                this.lastFrameTime = timestamp;
            }

            if (!this.hasActiveQueueContent()) {
                this.isProcessing = false;
                if (this.pendingFooter) {
                    const { footer, resolve } = this.pendingFooter;
                    this.pendingFooter = null;
                    super.addFooter(footer).then(resolve);
                }
                
                return;
            }

            if (!this.lastFrameTime) this.lastFrameTime = timestamp;

            const elapsed = timestamp - this.lastFrameTime;
            this.accumulatedChars += elapsed / this.charDelay;

            const charCount = Math.floor(this.accumulatedChars);
            this.accumulatedChars -= charCount;

            if (charCount > 0) {
                const chunk = this.consumeChars(charCount);
                if (chunk) {
                    this.contentDiv.append(chunk);
                    this.scrollFunc();
                }
            }

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
