import { afterEach, describe, expect, test } from 'bun:test';
import { parseHTML } from 'linkedom';

const originalChrome = globalThis.chrome;
const originalDocument = globalThis.document;
const originalWindow = globalThis.window;
const originalFetch = globalThis.fetch;

const jsonResponse = body => new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' }
});

const jwt = payload => {
    const encode = value => btoa(JSON.stringify(value))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/g, '');
    return `${encode({ alg: 'none' })}.${encode(payload)}.signature`;
};

afterEach(() => {
    globalThis.chrome = originalChrome;
    globalThis.document = originalDocument;
    globalThis.window = originalWindow;
    globalThis.fetch = originalFetch;
});

describe('Settings ChatGPT authentication control', () => {
    test('connects, shows only account identity, and removes credentials on sign-out', async () => {
        const { document, window } = parseHTML(`
            <html><body>
                <span id="chatgpt-auth-status"></span>
                <button id="button-chatgpt-auth"><span>Connect </span></button>
            </body></html>
        `);
        globalThis.document = document;
        globalThis.window = window;

        const storage = {};
        const openedUrls = [];
        const closedTabs = [];
        const updatedListeners = new Set();
        const removedListeners = new Set();
        globalThis.chrome = {
            storage: {
                local: {
                    set: async values => Object.assign(storage, values),
                    remove: async key => delete storage[key]
                }
            },
            tabs: {
                onUpdated: {
                    addListener: listener => updatedListeners.add(listener),
                    removeListener: listener => updatedListeners.delete(listener)
                },
                onRemoved: {
                    addListener: listener => removedListeners.add(listener),
                    removeListener: listener => removedListeners.delete(listener)
                },
                async create({ url }) {
                    openedUrls.push(url);
                    const state = new URL(url).searchParams.get('state');
                    setTimeout(() => {
                        const callback = `http://localhost:1455/auth/callback?code=authorization-code&state=${state}`;
                        updatedListeners.forEach(listener => listener(17, { url: callback }, { id: 17, url: callback }));
                    }, 0);
                    return { id: 17 };
                },
                async remove(tabId) {
                    closedTabs.push(tabId);
                }
            }
        };

        const access = jwt({
            'https://api.openai.com/auth': { chatgpt_account_id: 'account-123' },
            'https://api.openai.com/profile': { email: 'person@example.com' }
        });
        const id = jwt({
            'https://api.openai.com/auth': { chatgpt_plan_type: 'plus' }
        });
        globalThis.fetch = async () => jsonResponse({
            access_token: access,
            refresh_token: 'secret-refresh',
            id_token: id,
            expires_in: 3600
        });

        const { SettingsUI } = await import('../../src/js/settings.js');
        const ui = Object.create(SettingsUI.prototype);
        ui.chatGPTAuthController = null;
        ui.stateManager = {
            value: undefined,
            getSetting() {
                return this.value;
            },
            updateSettingsLocal({ chatgpt_auth }) {
                this.value = chatgpt_auth;
            }
        };

        await ui.toggleChatGPTAuth();

        expect(new URL(openedUrls[0]).pathname).toBe('/oauth/authorize');
        expect(new URL(openedUrls[0]).searchParams.get('redirect_uri')).toBe('http://localhost:1455/auth/callback');
        expect(closedTabs).toEqual([17]);
        expect(storage.chatgpt_auth).toEqual(expect.objectContaining({
            accountId: 'account-123',
            email: 'person@example.com',
            planType: 'plus'
        }));
        expect(document.getElementById('chatgpt-auth-status').textContent)
            .toBe('Connected as person@example.com. OpenAI chat uses your ChatGPT subscription.');
        expect(document.getElementById('chatgpt-auth-status').textContent).not.toContain('secret-refresh');
        expect(document.querySelector('#button-chatgpt-auth span').textContent).toBe('Sign out ');

        await ui.toggleChatGPTAuth();

        expect(storage.chatgpt_auth).toBeUndefined();
        expect(ui.stateManager.value).toBeUndefined();
        expect(document.getElementById('chatgpt-auth-status').textContent)
            .toBe('Not connected. OpenAI chat uses the API key above.');
        expect(document.querySelector('#button-chatgpt-auth span').textContent).toBe('Connect ');
    });
});
