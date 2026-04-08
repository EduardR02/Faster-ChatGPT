import { beforeEach, describe, expect, test } from 'bun:test';
import { parseHTML } from 'linkedom';
import { HistoryChatUI } from '../../src/js/chat_ui.js';

describe('HistoryChatUI webpage context banner', () => {
    beforeEach(() => {
        const { document, window } = parseHTML(`
            <!doctype html>
            <html>
            <body>
                <div id="chat-view">
                    <div id="title-wrapper" class="title-wrapper">
                        <span id="history-chat-header">conversation</span>
                    </div>
                    <div id="history-conversation"></div>
                    <div class="title-wrapper">
                        <div id="history-chat-footer"></div>
                    </div>
                </div>
                <div id="history-list"></div>
            </body>
            </html>
        `);

        globalThis.document = document;
        globalThis.window = window;
    });

    test('renders stored webpage context when loading a chat from history', async () => {
        const chatUI = new HistoryChatUI({
            conversationWrapperId: 'history-conversation',
            stateManager: {
                historyList: document.getElementById('history-list'),
                limit: 20,
                offset: 0,
                shouldLoadMore: () => false
            },
            addPopupActions: () => {},
            loadHistoryItems: async () => [],
            loadChat: async () => ({
                chatId: 7,
                title: 'Saved chat',
                timestamp: Date.now(),
                continued_from_chat_id: null,
                webpage_context: {
                    title: 'Example page',
                    siteName: 'example.com',
                    content: 'Clean stored context',
                    wordCount: 321
                },
                messages: []
            }),
            getChatMeta: async () => null,
            continueFunc: null
        });

        await chatUI.buildChat(7);

        const banner = document.querySelector('.webpage-context-banner');
        expect(banner).not.toBeNull();
        expect(document.getElementById('history-conversation').firstElementChild).toBe(banner);
        expect(banner.textContent).toContain('321 words of context added');
        expect(banner.textContent).toContain('Example page');
        expect(banner.querySelector('.webpage-context-content').textContent).toContain('Clean stored context');
        expect(banner.querySelector('.webpage-context-remove')).toBeNull();
    });

    test('places banner after leading system messages', async () => {
        const chatUI = new HistoryChatUI({
            conversationWrapperId: 'history-conversation',
            stateManager: {
                historyList: document.getElementById('history-list'),
                limit: 20,
                offset: 0,
                shouldLoadMore: () => false
            },
            addPopupActions: () => {},
            loadHistoryItems: async () => [],
            loadChat: async () => ({
                chatId: 9,
                title: 'Saved chat',
                timestamp: Date.now(),
                continued_from_chat_id: null,
                webpage_context: {
                    title: 'Example page',
                    siteName: 'example.com',
                    content: 'Clean stored context',
                    wordCount: 321
                },
                messages: [
                    { role: 'system', contents: [[{ type: 'text', content: 'System prompt' }]] },
                    { role: 'user', contents: [[{ type: 'text', content: 'Hello' }]] }
                ]
            }),
            getChatMeta: async () => null,
            continueFunc: null
        });

        await chatUI.buildChat(9);

        const children = Array.from(document.getElementById('history-conversation').children);
        expect(children[0].classList.contains('history-system-message')).toBe(true);
        expect(children[1].classList.contains('webpage-context-banner')).toBe(true);
        expect(children[2].classList.contains('user-message')).toBe(true);
    });

    test('replaces previous history banner instead of stacking', async () => {
        const chatUI = new HistoryChatUI({
            conversationWrapperId: 'history-conversation',
            stateManager: {
                historyList: document.getElementById('history-list'),
                limit: 20,
                offset: 0,
                shouldLoadMore: () => false
            },
            addPopupActions: () => {},
            loadHistoryItems: async () => [],
            loadChat: async (chatId) => ({
                chatId,
                title: `Saved chat ${chatId}`,
                timestamp: Date.now(),
                continued_from_chat_id: null,
                webpage_context: {
                    title: `Example page ${chatId}`,
                    siteName: 'example.com',
                    content: `Clean stored context ${chatId}`,
                    wordCount: 100 + chatId
                },
                messages: []
            }),
            getChatMeta: async () => null,
            continueFunc: null
        });

        await chatUI.buildChat(7);
        await chatUI.buildChat(8);

        const banners = document.querySelectorAll('.webpage-context-banner');
        expect(banners.length).toBe(1);
        expect(banners[0].textContent).toContain('Example page 8');
    });
});
