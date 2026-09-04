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

describe('pending audio attachment removal', () => {
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

    test('pending attachments keep the native audio contract alongside a remove control', () => {
        const audioDiv = renderAudio({
            data: 'data:audio/mp3;base64,QUJDRA==',
            name: 'pending.mp3'
        }, () => {});

        expect(audioDiv.children).toHaveLength(3);
        expect(audioDiv.children[0].textContent).toBe('pending.mp3');

        const audioElement = getAudioElement(audioDiv);
        expect(audioElement.controls).toBe(true);
        expect(audioElement.preload).toBe('metadata');
        expect(audioElement.src).toBe('data:audio/mp3;base64,QUJDRA==');

        const removeButton = audioDiv.children.find(child => child.tagName === 'BUTTON');
        expect(typeof removeButton.onclick).toBe('function');
    });

    test('removing pending audio pauses playback before detaching and notifies the caller', () => {
        const timeline = [];
        const container = new MockElement('div');
        const audioDiv = renderAudio({
            data: 'data:audio/mp3;base64,QUJDRA==',
            name: 'pending.mp3'
        }, () => timeline.push('notify'));
        container.appendChild(audioDiv);

        const audioElement = getAudioElement(audioDiv);
        audioElement.paused = false; // native playback in progress
        audioElement.pause = () => {
            audioElement.paused = true;
            timeline.push('pause');
        };
        audioDiv.remove = () => {
            timeline.push('remove');
            MockElement.prototype.remove.call(audioDiv);
        };

        const removeButton = audioDiv.children.find(child => child.tagName === 'BUTTON');
        removeButton.onclick();

        expect(timeline).toEqual(['pause', 'remove', 'notify']);
        expect(audioElement.paused).toBe(true);
        expect(container.children).toHaveLength(0);
    });
});
