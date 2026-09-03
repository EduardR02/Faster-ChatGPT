import { beforeEach, describe, expect, test } from 'bun:test';
import { DEFAULT_MODELS, NEW_DEFAULT_MODELS } from '../../src/js/LLMProviders.js';
import { mergeNewDefaultModels } from '../../src/js/storage_utils.js';

describe('model catalog update', () => {
    let storage;

    beforeEach(() => {
        storage = {
            models: {
                openai: { 'custom-openai': 'Custom OpenAI' },
                anthropic: { 'claude-fable-5': 'My Fable Label' },
                custom: { 'private-model': 'Private Model' }
            }
        };
        globalThis.chrome = {
            storage: {
                local: {
                    get: async keys => Object.fromEntries(keys.filter(key => key in storage).map(key => [key, storage[key]])),
                    set: async updates => Object.assign(storage, updates)
                }
            }
        };
    });

    test('adds the new defaults without replacing custom models or labels', async () => {
        expect(await mergeNewDefaultModels()).toBe(true);

        for (const [provider, additions] of Object.entries(NEW_DEFAULT_MODELS)) {
            expect(Object.keys(storage.models[provider])).toEqual(expect.arrayContaining(Object.keys(additions)));
        }
        expect(storage.models.openai['custom-openai']).toBe('Custom OpenAI');
        expect(storage.models.anthropic['claude-fable-5']).toBe('My Fable Label');
        expect(storage.models.custom).toEqual({ 'private-model': 'Private Model' });
        expect(storage.model_catalog_version).toBe(4);
    });

    test('upgrades an existing version 3 catalog with Gemini 3.8 Flash', async () => {
        storage.model_catalog_version = 3;

        expect(await mergeNewDefaultModels()).toBe(true);
        expect(storage.models.gemini['gemini-3.8-flash']).toBe('Gemini 3.8 Flash');
        expect(storage.model_catalog_version).toBe(4);
    });

    test('runs only once and leaves the current catalog untouched afterward', async () => {
        await mergeNewDefaultModels();
        storage.models.openai['gpt-5.6-sol'] = 'Renamed Sol';

        expect(await mergeNewDefaultModels()).toBe(false);
        expect(storage.models.openai['gpt-5.6-sol']).toBe('Renamed Sol');
    });

    test('fresh-install defaults contain every update model', () => {
        for (const [provider, additions] of Object.entries(NEW_DEFAULT_MODELS)) {
            expect(DEFAULT_MODELS[provider]).toEqual(expect.objectContaining(additions));
        }
    });
});
