import { afterEach, describe, expect, test } from 'bun:test';
import { createChromeMock } from '../setup.mjs';

const originalChrome = globalThis.chrome;
const originalFetch = globalThis.fetch;

const loadBackground = async () => {
    const chrome = createChromeMock();
    let onInstalled;
    chrome.runtime.getURL = path => `chrome-extension://test/${path}`;
    chrome.runtime.OnInstalledReason = { INSTALL: 'install', UPDATE: 'update' };
    chrome.runtime.onInstalled = { addListener: listener => { onInstalled = listener; } };
    chrome.runtime.onMessage = { addListener() {} };
    chrome.runtime.openOptionsPage = () => {};
    chrome.commands = { onCommand: { addListener() {} } };
    globalThis.chrome = chrome;
    await import(`../../src/js/background.js?installation=${crypto.randomUUID()}`);
    return onInstalled;
};

afterEach(() => {
    globalThis.chrome = originalChrome;
    globalThis.fetch = originalFetch;
});

describe('model configuration lifecycle', () => {
    test('extension updates leave manually configured models and selections untouched', async () => {
        const onInstalled = await loadBackground();
        const settings = {
            models: { openai: { 'custom-model': 'My model', 'gpt-5.6-sol': 'Renamed Sol' } },
            current_model: 'custom-model',
            arena_models: ['custom-model', 'gpt-5.6-sol'],
            api_keys: { openai: 'existing-key' }
        };
        await chrome.storage.local.set(settings);

        await onInstalled({ reason: 'update' });
        await onInstalled({ reason: 'update' });

        expect(await chrome.storage.local.get(Object.keys(settings))).toEqual(settings);
    });

    test('fresh installs include Astra among the available models', async () => {
        const onInstalled = await loadBackground();
        globalThis.fetch = async () => new Response('System prompt');

        await onInstalled({ reason: 'install' });

        const { models, current_model } = await chrome.storage.local.get(['models', 'current_model']);
        expect(models.openai['gpt-6-astra']).toBe('GPT-6 Astra');
        expect(Object.values(models).some(provider => current_model in provider)).toBe(true);
    });
});
