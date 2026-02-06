import { describe, test, expect, spyOn, beforeEach, afterEach } from 'bun:test';
import { StreamWriterSimple, StreamWriter } from '../../src/js/StreamWriter.js';

// Mock DOM environment minimally
if (typeof document === 'undefined') {
    global.document = {
            createElement: (tag) => {
                const el = {
                    tagName: tag.toUpperCase(),
                    classList: {
                        add: () => {},
                        remove: () => {},
                    },
                    append: (content) => {
                        el.textContent += content;
                        el.innerHTML += content;
                    },
                    appendChild: () => {},
                    querySelector: () => null,
                    closest: () => null,
                    _innerHTML: '',
                    _textContent: '',
                    style: {},
                };
                Object.defineProperty(el, 'innerHTML', {
                    get() { return this._innerHTML; },
                    set(val) {
                        this._innerHTML = val;
                        this._textContent = val;
                    },
                    configurable: true
                });
                Object.defineProperty(el, 'textContent', {
                    get() { return this._textContent; },
                    set(val) { this._textContent = val; },
                    configurable: true
                });
                return el;
            },
    };
}

if (typeof requestAnimationFrame === 'undefined') {
    global.requestAnimationFrame = (callback) => setTimeout(() => callback(Date.now()), 0);
}

// Mock ui_utils
// Note: In Bun, when we import StreamWriter.js, it will import ui_utils.js.
// Since we are running in an environment where we can't easily mock imports for already loaded modules without a bundler/mocking lib,
// we will rely on our StreamWriter subclassing to override methods that call ui_utils.

class TestStreamWriterSimple extends StreamWriterSimple {
    constructor(...args) {
        super(...args);
        this.recordedText = [];
        this.currentText = "";
    }
    updateTextContent(content) {
        this.currentText = content;
        this.recordedText.push(content);
    }
    updateImageContent(content) {
        this.recordedText.push({ image: content });
    }
}

class TestStreamWriter extends StreamWriter {
    constructor(...args) {
        super(...args);
        this.recordedText = [];
        this.currentText = "";
    }
    updateTextContent(content) {
        this.currentText = content;
        this.recordedText.push(content);
    }
    updateImageContent(content) {
        this.recordedText.push({ image: content });
    }
}

function createMockDiv() {
    const div = {
        classList: {
            add: () => {},
            remove: () => {},
        },
        append: (content) => {
            div.textContent += content;
            div.innerHTML += content;
        },
        appendChild: () => {},
        closest: () => null,
        _innerHTML: '',
        _textContent: '',
        parentElement: {
            appendChild: () => {}
        }
    };
    Object.defineProperty(div, 'innerHTML', {
        get() { return this._innerHTML; },
        set(val) {
            this._innerHTML = val;
            this._textContent = val; // Simple assignment for tests
        },
        configurable: true
    });
    Object.defineProperty(div, 'textContent', {
        get() { return this._textContent; },
        set(val) { this._textContent = val; },
        configurable: true
    });
    return div;
}

// Helper to wait for a condition with a timeout
const waitUntil = async (condition, timeout = 1000) => {
    const start = Date.now();
    while (!condition() && Date.now() - start < timeout) {
        await new Promise(r => setTimeout(r, 10));
    }
};

// Helper to wait for StreamWriter animation loop to finish
const waitForProcessing = async (writer, timeout = 1000) => {
    await waitUntil(() => !writer.isProcessing, timeout);
};

describe('StreamWriterSimple', () => {
    test('basic text streaming and finalization', () => {
        const div = createMockDiv();
        const nextDiv = createMockDiv();
        const writer = new TestStreamWriterSimple(div, () => nextDiv);
        
        writer.processContent('Hello ');
        writer.processContent('World');
        
        expect(writer.parts).toHaveLength(1);
        expect(writer.parts[0].content).toEqual(['Hello ', 'World']);
        
        writer.finalizeCurrentPart();
        expect(writer.currentText).toBe('Hello World');
    });

    test('batches append and scroll to animation frame', async () => {
        const div = createMockDiv();
        const nextDiv = createMockDiv();
        const appendSpy = spyOn(div, 'append');
        let scrollCalls = 0;
        const writer = new TestStreamWriterSimple(div, () => nextDiv, () => {
            scrollCalls += 1;
        });

        writer.processContent('Hello');
        writer.processContent(' ');
        writer.processContent('World');

        expect(appendSpy).toHaveBeenCalledTimes(0);
        expect(scrollCalls).toBe(0);

        await new Promise(resolve => setTimeout(resolve, 10));

        expect(appendSpy).toHaveBeenCalledTimes(1);
        expect(appendSpy).toHaveBeenCalledWith('Hello World');
        expect(scrollCalls).toBe(1);
    });

    test('flushes buffered thought content before switching div', async () => {
        const div = createMockDiv();
        const nextDiv = createMockDiv();
        const writer = new TestStreamWriterSimple(div, () => nextDiv);

        writer.setThinkingModel();
        writer.processContent('Thinking...', true);
        writer.processContent('Answer', false);

        await new Promise(resolve => setTimeout(resolve, 10));

        expect(div.textContent).toContain('Thinking...');
        expect(div.textContent).not.toContain('Answer');
        expect(nextDiv.textContent).toContain('Answer');
    });

    test('thought to text transition', () => {
        const div = createMockDiv();
        const nextDiv = createMockDiv();
        const writer = new TestStreamWriterSimple(div, () => nextDiv);
        
        writer.setThinkingModel();
        writer.processContent('Thinking...', true);
        
        expect(writer.parts[0].type).toBe('thought');
        
        writer.processContent('Final answer', false);
        
        expect(writer.parts).toHaveLength(2);
        expect(writer.parts[0].type).toBe('thought');
        expect(writer.parts[1].type).toBe('text');
        expect(writer.parts[0].content).toBe('Thinking...'); // nextPart calls finalizeCurrentPart
        expect(writer.parts[1].content).toEqual(['Final answer']);
    });

    test('discard thoughts in StreamWriterBase', () => {
        const { StreamWriterBase } = require('../../src/js/StreamWriter.js');
        const writer = new StreamWriterBase();
        writer.processContent('ignore me', true);
        writer.processContent('keep me', false);
        expect(writer.chunks).toEqual(['keep me']);
        expect(writer.done()).toBe('keep me');
    });
});

describe('StreamWriter (Smooth)', () => {
    test('stores incoming content as chunks instead of characters', () => {
        const div = createMockDiv();
        const nextDiv = createMockDiv();
        const writer = new TestStreamWriter(div, () => nextDiv, () => {}, 120000);

        writer.processContent('chunk-one');
        writer.processContent('chunk-two');

        expect(writer.contentQueue).toEqual(['chunk-one', 'chunk-two']);
    });

    test('queues post-thought content in chunk queue during pending switch', () => {
        const div = createMockDiv();
        const nextDiv = createMockDiv();
        const writer = new TestStreamWriter(div, () => nextDiv, () => {}, 120000);

        writer.setThinkingModel();
        writer.processContent('thought', true);
        writer.processContent('result', false);

        expect(writer.pendingSwitch).toBe(true);
        expect(writer.pendingQueue).toEqual(['result']);
    });

    test('animates content over time', async () => {
        const div = createMockDiv();
        const nextDiv = createMockDiv();
        const appendSpy = spyOn(div, 'append');
        
        // 120000 WPM = high speed for testing
        const writer = new TestStreamWriter(div, () => nextDiv, () => {}, 120000);
        
        writer.processContent('Fast');
        
        // Wait for animation loop to process queues with safety timeout
        await waitForProcessing(writer);
        
        expect(appendSpy).toHaveBeenCalledWith(expect.stringContaining('Fast'));
        expect(writer.isProcessing).toBe(false);
    });

    test('handles thought to text transition with queue', async () => {
        const div = createMockDiv();
        const nextDiv = createMockDiv();
        let producedNext = false;
        const produceNext = () => {
            producedNext = true;
            return nextDiv;
        };

        const writer = new TestStreamWriter(div, produceNext, () => {}, 1000000);
        
        writer.setThinkingModel();
        writer.processContent('thought', true);
        // We need to wait a bit so 'thought' starts animating and occupies contentQueue
        await new Promise(r => setTimeout(r, 10));
        
        writer.processContent('result', false);
        
        // At this point, if 'thought' is still in contentQueue, animation is still running for thought
        writer.charDelay = 100; // slow it down
        writer.processContent('more', false);

        writer.charDelay = 0.01; // speed up
        await waitForProcessing(writer);
        expect(writer.isProcessing).toBe(false);
        
        expect(producedNext).toBe(true);
        expect(writer.parts).toHaveLength(2);
        // Confirm thought content stays in original container
        expect(div.textContent).toContain('thought');
        // Answer goes to the new container
        expect(nextDiv.textContent).toContain('result');
        expect(nextDiv.textContent).toContain('more');
    });

    test('thought to text switch arriving before animation completes', async () => {
        const div = createMockDiv();
        const nextDiv = createMockDiv();
        const writer = new TestStreamWriter(div, () => nextDiv, () => {}, 1); // 1 WPM = very slow
        
        writer.setThinkingModel();
        writer.processContent('Long thought content', true);
        
        // Switch to text while still "animating" thought
        writer.processContent('Immediate answer', false);
        
        // Fast forward
        writer.charDelay = 0.01;
        await waitForProcessing(writer);
        expect(writer.isProcessing).toBe(false);
        
        expect(writer.parts).toHaveLength(2);
        expect(writer.parts[0].type).toBe('thought');
        expect(writer.parts[1].type).toBe('text');
        // Confirm thought content stays in original container
        expect(div.textContent).toContain('Long thought content');
        expect(nextDiv.textContent).toContain('Immediate answer');
    });
});
