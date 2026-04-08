import { beforeEach, describe, expect, test } from 'bun:test';
import { parseHTML } from 'linkedom';
import { SidepanelChatUI } from '../../src/js/chat_ui.js';

describe('SidepanelChatUI webpage context banner', () => {
    beforeEach(() => {
        const { document, window } = parseHTML(`
            <div id="tab-container-test">
                <div id="conversation-wrapper-test" class="conversation-wrapper">
                    <div class="title-wrapper"><span class="conversation-title">conversation</span></div>
                </div>
            </div>
            <div class="textarea-wrapper"><textarea></textarea></div>
        `);

        globalThis.document = document;
        globalThis.window = window;
    });

    test('renders banner and supports removal', () => {
        let removed = false;
        const chatUI = new SidepanelChatUI({
            conversationWrapperId: 'conversation-wrapper-test',
            scrollElementId: 'tab-container-test',
            stateManager: {
                subscribeToSetting: () => {},
                unsubscribeFromSetting: () => {}
            }
        });

        chatUI.setWebpageContext({
            title: 'Example page',
            siteName: 'example.com',
            content: 'Clean context',
            wordCount: 321
        }, () => {
            removed = true;
        });

        const banner = document.querySelector('.webpage-context-banner');
        expect(banner).not.toBeNull();
        expect(banner.textContent).toContain('321 words of context added');
        expect(banner.textContent).toContain('Example page');

        banner.querySelector('.webpage-context-remove').click();
        expect(removed).toBe(true);
    });
});
