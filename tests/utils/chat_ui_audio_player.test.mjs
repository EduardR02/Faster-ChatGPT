import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { SidepanelChatUI, formatAudioTime } from '../../src/js/chat_ui.js';

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

describe('audio player formatting and controls', () => {
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

    test('formats audio time as m:ss', () => {
        expect(formatAudioTime(0)).toBe('0:00');
        expect(formatAudioTime(65)).toBe('1:05');
        expect(formatAudioTime(609)).toBe('10:09');
    });

    test('handles invalid audio time values safely', () => {
        expect(formatAudioTime(-1)).toBe('0:00');
        expect(formatAudioTime(Number.NaN)).toBe('0:00');
        expect(formatAudioTime(Number.POSITIVE_INFINITY)).toBe('0:00');
    });

    test('renders custom audio controls and updates playback state', async () => {
        const audioDiv = SidepanelChatUI.prototype.createAudioDisplay.call({}, {
            data: 'data:audio/mp3;base64,QUJDRA==',
            name: 'clip.mp3'
        });

        const playButton = audioDiv.querySelector('.audio-play-btn');
        const timeLabel = audioDiv.querySelector('.audio-time');
        const track = audioDiv.querySelector('.audio-track');
        const trackFill = audioDiv.querySelector('.audio-track-fill');
        const audioElement = getAudioElement(audioDiv);

        expect(playButton.textContent).toBe('▶');
        expect(timeLabel.textContent).toBe('0:00 / 0:00');
        expect(audioElement.hidden).toBe(true);
        expect(audioElement.src).toBe('data:audio/mp3;base64,QUJDRA==');

        audioElement.duration = 100;
        audioElement.dispatchEvent({ type: 'loadedmetadata' });
        expect(timeLabel.textContent).toBe('0:00 / 1:40');

        audioElement.currentTime = 25;
        audioElement.dispatchEvent({ type: 'timeupdate' });
        expect(timeLabel.textContent).toBe('0:25 / 1:40');
        expect(trackFill.style.width).toBe('25%');

        playButton.dispatchEvent({ type: 'click' });
        await Promise.resolve();
        expect(playButton.textContent).toBe('⏸');

        playButton.dispatchEvent({ type: 'click' });
        expect(playButton.textContent).toBe('▶');

        track._rect = { left: 0, width: 200 };
        track.dispatchEvent({ type: 'click', clientX: 50 });
        expect(audioElement.currentTime).toBe(25);
    });
});
