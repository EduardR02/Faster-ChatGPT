import { describe, test, expect, spyOn, beforeEach, afterEach } from 'bun:test';
import { StreamWriterSimple, StreamWriter } from '../../src/js/StreamWriter.js';

// Mock DOM environment minimally
if (typeof document === 'undefined') {
    global.document = {
        createElement: (tag) => ({
            tagName: tag.toUpperCase(),
            classList: {
                add: () => {},
                remove: () => {},
            },
            append: () => {},
            appendChild: () => {},
            querySelector: () => null,
            closest: () => null,
            innerHTML: '',
            textContent: '',
            style: {},
        }),
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
    return {
        classList: {
            add: () => {},
            remove: () => {},
        },
        append: () => {},
        appendChild: () => {},
        closest: () => null,
        innerHTML: '',
        textContent: '',
        parentElement: {
            appendChild: () => {}
        }
    };
}

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
    test('animates content over time', async () => {
        const div = createMockDiv();
        const nextDiv = createMockDiv();
        const appendSpy = spyOn(div, 'append');
        
        // 120000 WPM = high speed for testing
        const writer = new TestStreamWriter(div, () => nextDiv, () => {}, 120000);
        
        writer.processContent('Fast');
        
        // Wait for animation frame
        await new Promise(r => setTimeout(r, 50));
        
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
        writer.processContent('result', false);
        
        expect(writer.pendingSwitch).toBe(true);
        expect(writer.pendingQueue).toContain('r');
        
        // Wait for animation loop to process queues
        while(writer.isProcessing) {
            await new Promise(r => setTimeout(r, 10));
        }
        
        expect(producedNext).toBe(true);
        expect(writer.parts).toHaveLength(2);
        expect(writer.parts[0].content).toBe('thought');
    });
});
