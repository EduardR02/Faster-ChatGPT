import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { requestPageContextForWindow } from '../../src/js/page_context_request.js';

class MockChromeEvent {
    addListener() {}
    removeListener() {}
}

const originalChrome = globalThis.chrome;
let activeTab;
let pageResponse;
let sentMessages;

globalThis.chrome = {
    runtime: {
        OnInstalledReason: { INSTALL: 'install', UPDATE: 'update' },
        getURL: path => `chrome-extension://test/${path}`,
        onInstalled: new MockChromeEvent(),
        onMessage: new MockChromeEvent(),
        sendMessage: async () => {},
        openOptionsPage() {}
    },
    commands: { onCommand: new MockChromeEvent() },
    sidePanel: { setOptions: async () => {}, open: async () => {} },
    windows: { getLastFocused: async () => ({ id: 1 }) },
    tabs: {
        query: async () => activeTab ? [activeTab] : [],
        sendMessage: async (tabId, message) => {
            sentMessages.push({ tabId, message });
            if (pageResponse instanceof Error) throw pageResponse;
            return pageResponse;
        },
        create: async () => {}
    },
    storage: {
        local: { get: async () => ({}), set: async () => {} }
    }
};

beforeEach(() => {
    activeTab = { id: 17, windowId: 4, url: 'https://example.com/article' };
    pageResponse = { ok: true, context: { url: activeTab.url, title: 'Article', content: 'Page text' } };
    sentMessages = [];
});

afterAll(() => {
    if (originalChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = originalChrome;
});

describe('direct active-tab page context requests', () => {
    test('returns context from the active normal webpage content script', async () => {
        expect(await requestPageContextForWindow(4)).toEqual(pageResponse.context);
        expect(sentMessages).toEqual([
            { tabId: 17, message: { type: 'collect_page_context' } }
        ]);
    });

    test('returns immediately when the active extension page has no content-script receiver', async () => {
        activeTab = { id: 18, windowId: 4, url: 'chrome-extension://test/src/html/history.html' };
        pageResponse = new Error('Receiving end does not exist');
        const originalSetTimeout = globalThis.setTimeout;
        let scheduledTimers = 0;
        globalThis.setTimeout = () => { scheduledTimers++; };

        try {
            expect(await requestPageContextForWindow(4)).toBeUndefined();
        } finally {
            globalThis.setTimeout = originalSetTimeout;
        }

        expect(scheduledTimers).toBe(0);
        expect(sentMessages).toEqual([
            { tabId: 18, message: { type: 'collect_page_context' } }
        ]);
    });
});
