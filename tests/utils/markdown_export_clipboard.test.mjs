import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { parseHTML } from 'linkedom';
import { HistoryChatUI } from '../../src/js/chat_ui.js';
import {
    attachHistoryPopupEscape,
    attachHistoryPopupTrigger,
    focusHistoryPopupTrigger
} from '../../src/js/history_popup_trigger.js';
import { copyChatMarkdownToClipboard } from '../../src/js/markdown_export.js';

describe('copyChatMarkdownToClipboard', () => {
    let originalNavigator;
    let clipboardWrites;
    let clipboardError;

    beforeEach(() => {
        originalNavigator = globalThis.navigator;
        clipboardWrites = [];
        clipboardError = null;
        Object.defineProperty(globalThis, 'navigator', {
            value: {
                clipboard: {
                    writeText: async (text) => {
                        if (clipboardError) throw clipboardError;
                        clipboardWrites.push(text);
                    }
                }
            },
            configurable: true
        });
    });

    afterEach(() => {
        Object.defineProperty(globalThis, 'navigator', { value: originalNavigator, configurable: true });
    });

    test('loads chat without blob resolution and writes serialized markdown', async () => {
        const loadCalls = [];
        const chatStorage = {
            loadChat: async (...args) => {
                loadCalls.push(args);
                return {
                    title: 'Stored chat',
                    messages: [
                        { role: 'user', contents: [[{ type: 'text', content: 'Hi' }]], images: ['unresolved-blob-hash'] },
                        { role: 'assistant', contents: [[{ type: 'text', content: 'Hello!', model: 'gpt-5.2' }]] }
                    ]
                };
            }
        };

        await copyChatMarkdownToClipboard(chatStorage, 42);

        expect(loadCalls).toEqual([[42, null, { resolveBlobs: false }]]);
        expect(clipboardWrites).toEqual([
            '# Stored chat\n' +
            '\n' +
            '**You:**\n' +
            '\n' +
            '*[Image]*\n' +
            '\n' +
            'Hi\n' +
            '\n' +
            '**Assistant (gpt-5.2):**\n' +
            '\n' +
            'Hello!\n'
        ]);
    });

    test('throws when the chat no longer exists and leaves clipboard untouched', async () => {
        const chatStorage = { loadChat: async () => null };

        await expect(copyChatMarkdownToClipboard(chatStorage, 7)).rejects.toThrow('Chat not found: 7');
        expect(clipboardWrites).toEqual([]);
    });

    test('propagates clipboard write failures', async () => {
        clipboardError = new Error('Document is not focused');
        const chatStorage = { loadChat: async () => ({ title: 'T', messages: [] }) };

        await expect(copyChatMarkdownToClipboard(chatStorage, 1)).rejects.toThrow('Document is not focused');
    });

    test('does not let an older overlapping request write after a newer request starts', async () => {
        let resolveFirstLoad;
        let currentRequest = 1;
        const firstLoad = new Promise(resolve => { resolveFirstLoad = resolve; });
        const chatStorage = {
            loadChat: async (chatId) => chatId === 1
                ? firstLoad
                : { title: 'New request', messages: [] }
        };

        const firstCopy = copyChatMarkdownToClipboard(chatStorage, 1, () => currentRequest === 1);
        currentRequest = 2;
        const secondCopy = copyChatMarkdownToClipboard(chatStorage, 2, () => currentRequest === 2);
        resolveFirstLoad({ title: 'Stale request', messages: [] });

        expect(await secondCopy).toBe(true);
        expect(await firstCopy).toBe(false);
        expect(clipboardWrites).toEqual(['# New request\n']);
    });
});

describe('Markdown copy history action', () => {
    const createHarness = () => {
        const historyHtml = readFileSync(new URL('../../src/html/history.html', import.meta.url), 'utf8');
        const { document, window } = parseHTML(historyHtml);
        globalThis.document = document;
        const popup = document.querySelector('.popup-menu');
        const state = { open: false, selected: 0, focusedActions: [], invokedActions: [], triggerFocused: 0 };
        popup.querySelectorAll('.popup-item').forEach(action => {
            action.focus = () => { state.focusedActions.push(action.dataset.action); };
        });
        popup.addEventListener('click', event => {
            if (event.target.dataset.action) state.invokedActions.push(event.target.dataset.action);
        });
        const context = {
            buildChat: () => { state.selected += 1; },
            addPopup: item => attachHistoryPopupTrigger(item.querySelector('.action-dots'), {
                isOpen: () => state.open,
                open: () => { state.open = true; },
                close: () => { state.open = false; },
                focusTarget: () => popup.querySelector('.popup-item')
            })
        };
        const item = HistoryChatUI.prototype.createHistoryItem.call(context, { chatId: 1, title: 'Test chat' });
        document.querySelector('.history-list').appendChild(item);
        item.querySelector('.action-dots').focus = () => { state.triggerFocused += 1; };
        return { context, document, window, item, popup, state };
    };

    const dispatchKey = (window, target, key) => {
        const event = new window.Event('keydown', { bubbles: true, cancelable: true });
        Object.defineProperty(event, 'key', { value: key });
        target.dispatchEvent(event);
        return event;
    };

    test('opens from Enter and Space, focuses the first action, and does not select the chat', () => {
        const originalDocument = globalThis.document;
        try {
            const harness = createHarness();
            const trigger = harness.item.querySelector('.action-dots');

            expect(trigger.tagName).toBe('BUTTON');
            expect(trigger.getAttribute('aria-label')).toBe('Actions for Test chat');
            for (const key of ['Enter', ' ']) {
                harness.state.open = false;
                const event = dispatchKey(harness.window, trigger, key);
                expect(event.defaultPrevented).toBe(true);
                expect(harness.state.open).toBe(true);
            }
            expect(harness.state.focusedActions).toEqual(['auto-rename', 'auto-rename']);
            expect(harness.state.selected).toBe(0);
        } finally {
            globalThis.document = originalDocument;
        }
    });

    test('keeps mouse selection and action clicks separate', () => {
        const originalDocument = globalThis.document;
        try {
            const harness = createHarness();

            harness.item.querySelector('.action-dots').click();
            expect(harness.state.open).toBe(true);
            expect(harness.state.focusedActions).toEqual([]);
            expect(harness.state.selected).toBe(0);

            harness.item.querySelector('.history-chat-select').click();
            expect(harness.state.selected).toBe(1);
        } finally {
            globalThis.document = originalDocument;
        }
    });

    test('exposes every popup action as a native button and invokes Rename', () => {
        const originalDocument = globalThis.document;
        try {
            const harness = createHarness();
            const actions = Array.from(harness.popup.querySelectorAll('.popup-item'));

            expect(actions.map(action => action.dataset.action)).toEqual([
                'auto-rename',
                'rename',
                'copy-markdown',
                'delete'
            ]);
            expect(actions.every(action => action.tagName === 'BUTTON')).toBe(true);

            harness.popup.querySelector('[data-action="rename"]').click();
            expect(harness.state.invokedActions).toEqual(['rename']);
        } finally {
            globalThis.document = originalDocument;
        }
    });

    test('Escape closes the popup and restores focus only while the trigger exists', () => {
        const originalDocument = globalThis.document;
        try {
            const harness = createHarness();
            attachHistoryPopupEscape(harness.popup, () => {
                harness.state.open = false;
                focusHistoryPopupTrigger(harness.item);
            });
            harness.state.open = true;

            const firstEscape = dispatchKey(
                harness.window,
                harness.popup.querySelector('[data-action="auto-rename"]'),
                'Escape'
            );
            expect(firstEscape.defaultPrevented).toBe(true);
            expect(harness.state.open).toBe(false);
            expect(harness.state.triggerFocused).toBe(1);

            harness.item.remove();
            harness.state.open = true;
            dispatchKey(harness.window, harness.popup.querySelector('[data-action="delete"]'), 'Escape');
            expect(harness.state.open).toBe(false);
            expect(harness.state.triggerFocused).toBe(1);
        } finally {
            globalThis.document = originalDocument;
        }
    });

    test('keeps arrow navigation working from the actions trigger', () => {
        const originalDocument = globalThis.document;
        try {
            const harness = createHarness();
            const historyList = harness.document.querySelector('.history-list');
            const nextItem = HistoryChatUI.prototype.createHistoryItem.call(
                harness.context,
                { chatId: 2, title: 'Next chat' }
            );
            historyList.appendChild(nextItem);
            nextItem.scrollIntoView = () => {};
            let focused = false;
            nextItem.querySelector('.history-chat-select').focus = () => { focused = true; };
            Object.defineProperty(harness.document, 'activeElement', {
                configurable: true,
                value: harness.item.querySelector('.action-dots')
            });
            HistoryChatUI.prototype.initKeyboardNav.call({
                historyList,
                paginator: { requestMore: async () => false }
            });

            const event = dispatchKey(harness.window, harness.item.querySelector('.action-dots'), 'ArrowDown');

            expect(event.defaultPrevented).toBe(true);
            expect(focused).toBe(true);
            expect(harness.state.selected).toBe(1);
        } finally {
            globalThis.document = originalDocument;
        }
    });
});
