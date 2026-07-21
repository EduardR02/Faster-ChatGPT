import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runHistoryMarkdownAction } from '../../src/js/history_markdown_action.js';

describe('Save Markdown history popup wiring', () => {
    test('places a native Save Markdown button directly after Copy Markdown and routes it', () => {
        const historyHtml = readFileSync(new URL('../../src/html/history.html', import.meta.url), 'utf8');
        const historySource = readFileSync(new URL('../../src/js/history.js', import.meta.url), 'utf8');
        const layoutCss = readFileSync(new URL('../../src/css/layout.css', import.meta.url), 'utf8');
        const popupHtml = historyHtml.match(/<div class="popup-menu">([\s\S]*?)<\/div>\s*<script/)[1];
        const actions = Array.from(popupHtml.matchAll(/<button\b([^>]*)data-action="([^"]+)"([^>]*)>([^<]*)<\/button>/g))
            .map(match => ({ attributes: `${match[1]}${match[3]}`, action: match[2], label: match[4] }));
        const saveIndex = actions.findIndex(action => action.action === 'save-markdown');

        expect(actions.map(action => action.action)).toEqual([
            'auto-rename',
            'rename',
            'copy-markdown',
            'save-markdown',
            'delete'
        ]);
        expect(actions[saveIndex].attributes).toContain('type="button"');
        expect(actions[saveIndex].label).toBe('Save Markdown');
        expect(actions[saveIndex - 1].action).toBe('copy-markdown');
        expect(historySource).toContain("case 'save-markdown':");
        expect(historySource).toContain('this.handleSaveMarkdown(event.target)');
        expect(historySource).toContain("pendingText: 'saving...'");
        expect(historySource).toContain("successText: 'saved!'");
        expect(layoutCss).toContain('button.popup-action:focus-visible');
    });

    test('shows success feedback and schedules the same transient close lifecycle', async () => {
        const button = { textContent: 'Save Markdown' };
        let closeScheduled = 0;

        const applied = await runHistoryMarkdownAction({
            button,
            pendingText: 'saving...',
            successText: 'saved!',
            operation: async () => {
                expect(button.textContent).toBe('saving...');
                return true;
            },
            isCurrent: () => true,
            onError: () => { throw new Error('unexpected error'); },
            scheduleClose: () => { closeScheduled += 1; }
        });

        expect(applied).toBe(true);
        expect(button.textContent).toBe('saved!');
        expect(closeScheduled).toBe(1);
    });

    test('shows failure feedback, reports the error, and still schedules transient close', async () => {
        const button = { textContent: 'Save Markdown' };
        const failure = new Error('Download blocked');
        const reported = [];
        let closeScheduled = 0;

        const applied = await runHistoryMarkdownAction({
            button,
            pendingText: 'saving...',
            successText: 'saved!',
            operation: async () => { throw failure; },
            isCurrent: () => true,
            onError: error => reported.push(error),
            scheduleClose: () => { closeScheduled += 1; }
        });

        expect(applied).toBe(true);
        expect(button.textContent).toBe('failed :(');
        expect(reported).toEqual([failure]);
        expect(closeScheduled).toBe(1);
    });

    test('does not overwrite feedback or close a popup after its request becomes stale', async () => {
        const button = { textContent: 'Save Markdown' };
        let current = true;
        let closeScheduled = 0;

        const applied = await runHistoryMarkdownAction({
            button,
            pendingText: 'saving...',
            successText: 'saved!',
            operation: async () => {
                current = false;
                return true;
            },
            isCurrent: () => current,
            onError: () => {},
            scheduleClose: () => { closeScheduled += 1; }
        });

        expect(applied).toBe(false);
        expect(button.textContent).toBe('saving...');
        expect(closeScheduled).toBe(0);
    });
});
