import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { SidepanelChatUI } from '../../src/js/chat_ui.js';

class MockElement {
    constructor(tagName) {
        this.tagName = tagName.toUpperCase();
        this.className = '';
        this.textContent = '';
        this.children = [];
        this.parentNode = null;
    }

    append(...nodes) {
        nodes.forEach(node => this.appendChild(node));
    }

    appendChild(node) {
        if (!node) return node;
        node.parentNode = this;
        this.children.push(node);
        return node;
    }

    remove() {
        if (!this.parentNode) return;
        this.parentNode.children = this.parentNode.children.filter(child => child !== this);
        this.parentNode = null;
    }
}

class MockAudioElement extends MockElement {
    constructor() {
        super('audio');
        this.controls = false;
        this.preload = '';
        this.src = '';
        this.hidden = false;
        this.paused = true;
    }
}

const getAudioElement = (root) => root.children.find(child => child.tagName === 'AUDIO');
const renderAudio = (audioItem, onRemove = null) =>
    SidepanelChatUI.prototype.createAudioDisplay.call(SidepanelChatUI.prototype, audioItem, onRemove);

describe('native audio player rendering', () => {
    let originalDocument;

    beforeEach(() => {
        originalDocument = globalThis.document;
        globalThis.document = {
            createElement: (tagName) => {
                if (tagName === 'audio') {
                    return new MockAudioElement();
                }
                return new MockElement(tagName);
            }
        };
    });

    afterEach(() => {
        globalThis.document = originalDocument;
    });

    test('renders a visible native audio element with controls, metadata preload, and source', () => {
        const audioDiv = renderAudio({
            data: 'data:audio/mp3;base64,QUJDRA==',
            name: 'clip.mp3'
        });

        const audioElement = getAudioElement(audioDiv);

        expect(audioElement).toBeTruthy();
        expect(audioElement.controls).toBe(true);
        expect(audioElement.preload).toBe('metadata');
        expect(audioElement.hidden).toBeFalsy();
        expect(audioElement.src).toBe('data:audio/mp3;base64,QUJDRA==');
    });

    test('identifies the attachment by its filename and renders no custom control widgets', () => {
        const audioDiv = renderAudio({
            data: 'data:audio/mp3;base64,QUJDRA==',
            name: 'clip.mp3'
        });

        expect(audioDiv.children).toHaveLength(2);
        expect(audioDiv.children[0].textContent).toBe('clip.mp3');
        expect(audioDiv.children.find(child => child.tagName === 'BUTTON')).toBeUndefined();
    });

    test('falls back to the default label and source for malformed audio items', () => {
        const fromString = renderAudio('data:audio/wav;base64,VEVTVA==');
        expect(fromString.children[0].textContent).toBe('Audio attachment');
        expect(getAudioElement(fromString).src).toBe('data:audio/wav;base64,VEVTVA==');

        const fromNull = renderAudio(null);
        expect(fromNull.children[0].textContent).toBe('Audio attachment');
        expect(getAudioElement(fromNull).src).toBe('');
    });
});
