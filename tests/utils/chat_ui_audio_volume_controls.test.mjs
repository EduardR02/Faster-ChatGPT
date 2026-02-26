import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { SidepanelChatUI } from '../../src/js/chat_ui.js';

class MockElement {
    constructor(tagName) {
        this.tagName = tagName.toUpperCase();
        this.className = '';
        this.textContent = '';
        this.children = [];
        this.parentNode = null;
        this.style = {};
        this.attributes = {};
        this.eventListeners = new Map();
        this.hidden = false;
        this._rect = { left: 0, width: 100 };
    }

    append(...nodes) {
        nodes.forEach((node) => this.appendChild(node));
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

    setAttribute(name, value) {
        this.attributes[name] = String(value);
    }

    addEventListener(type, callback) {
        if (!this.eventListeners.has(type)) {
            this.eventListeners.set(type, []);
        }
        this.eventListeners.get(type).push(callback);
    }

    dispatchEvent(event) {
        const listeners = this.eventListeners.get(event.type) || [];
        listeners.forEach(listener => listener(event));
    }

    setPointerCapture() {}

    releasePointerCapture() {}

    getBoundingClientRect() {
        return this._rect;
    }

    querySelector(selector) {
        if (!selector.startsWith('.')) return null;
        const targetClass = selector.slice(1);
        const classNames = this.className.split(' ').filter(Boolean);
        if (classNames.includes(targetClass)) return this;

        for (const child of this.children) {
            const match = child.querySelector?.(selector);
            if (match) return match;
        }
        return null;
    }
}

class MockAudioElement extends MockElement {
    constructor() {
        super('audio');
        this.preload = '';
        this.src = '';
        this.paused = true;
        this.currentTime = 0;
        this.duration = Number.NaN;
        this.volume = 1;
        this.muted = false;
    }

    async play() {
        this.paused = false;
        this.dispatchEvent({ type: 'play' });
    }

    pause() {
        this.paused = true;
        this.dispatchEvent({ type: 'pause' });
    }
}

const getAudioElement = (root) => root.children.find(child => child.tagName === 'AUDIO');

describe('audio player volume controls and layout', () => {
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

    test('renders two-row audio layout with volume controls', () => {
        const audioDiv = SidepanelChatUI.prototype.createAudioDisplay.call({}, {
            data: 'data:audio/mp3;base64,QUJDRA==',
            name: 'recording.mp3'
        });

        const topRow = audioDiv.querySelector('.audio-top-row');
        const bottomRow = audioDiv.querySelector('.audio-bottom-row');
        const nameLabel = audioDiv.querySelector('.audio-name');
        const timeLabel = audioDiv.querySelector('.audio-time');
        const volSection = audioDiv.querySelector('.audio-vol');
        const volButton = audioDiv.querySelector('.audio-vol-btn');
        const volFill = audioDiv.querySelector('.audio-vol-fill');

        expect(topRow).toBeTruthy();
        expect(bottomRow).toBeTruthy();
        expect(audioDiv.children[0]).toBe(topRow);
        expect(audioDiv.children[1]).toBe(bottomRow);
        expect(nameLabel.textContent).toBe('recording.mp3');
        expect(timeLabel.textContent).toBe('0:00 / 0:00');
        expect(volSection).toBeTruthy();
        expect(volButton.textContent).toBe('🔊');
        expect(volFill.style.width).toBe('100%');
    });

    test('mutes and restores previous volume with button toggle', () => {
        const audioDiv = SidepanelChatUI.prototype.createAudioDisplay.call({}, {
            data: 'data:audio/mp3;base64,QUJDRA==',
            name: 'clip.mp3'
        });

        const audioElement = getAudioElement(audioDiv);
        const volButton = audioDiv.querySelector('.audio-vol-btn');
        const volFill = audioDiv.querySelector('.audio-vol-fill');

        audioElement.volume = 0.6;
        audioElement.dispatchEvent({ type: 'volumechange' });
        expect(volFill.style.width).toBe('60%');
        expect(volButton.textContent).toBe('🔊');

        volButton.dispatchEvent({ type: 'click' });
        expect(audioElement.muted).toBe(true);
        expect(volButton.textContent).toBe('🔇');
        expect(volFill.style.width).toBe('0%');

        volButton.dispatchEvent({ type: 'click' });
        expect(audioElement.muted).toBe(false);
        expect(audioElement.volume).toBe(0.6);
        expect(volButton.textContent).toBe('🔊');
        expect(volFill.style.width).toBe('60%');
    });

    test('adjusts volume from volume track pointer and click input', () => {
        const audioDiv = SidepanelChatUI.prototype.createAudioDisplay.call({}, {
            data: 'data:audio/mp3;base64,QUJDRA==',
            name: 'clip.mp3'
        });

        const audioElement = getAudioElement(audioDiv);
        const volTrack = audioDiv.querySelector('.audio-vol-track');
        const volFill = audioDiv.querySelector('.audio-vol-fill');

        volTrack._rect = { left: 0, width: 50 };
        audioElement.muted = true;

        volTrack.dispatchEvent({ type: 'pointerdown', button: 0, pointerId: 1, clientX: 25 });
        expect(audioElement.muted).toBe(false);
        expect(audioElement.volume).toBe(0.5);
        expect(volFill.style.width).toBe('50%');

        volTrack.dispatchEvent({ type: 'pointermove', pointerId: 1, clientX: 10 });
        expect(audioElement.volume).toBe(0.2);
        expect(volFill.style.width).toBe('20%');

        volTrack.dispatchEvent({ type: 'pointerup', pointerId: 1 });
        volTrack.dispatchEvent({ type: 'pointermove', pointerId: 1, clientX: 40 });
        expect(audioElement.volume).toBe(0.2);

        volTrack.dispatchEvent({ type: 'click', clientX: 50 });
        expect(audioElement.volume).toBe(1);
        expect(volFill.style.width).toBe('100%');
    });
});
