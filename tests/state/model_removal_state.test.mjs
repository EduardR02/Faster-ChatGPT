import { beforeEach, describe, expect, test } from 'bun:test';
import { createChromeMock } from '../setup.mjs';

const initialModels = () => ({
  openai: { 'Remove-Me': 'Remove Me', survivor: 'Survivor' },
  anthropic: { claude: 'Claude' }
});

const createManager = async (settings) => {
  globalThis.chrome = createChromeMock();
  await chrome.storage.local.set(settings);
  const { SettingsStateManager } = await import('../../src/js/state_manager.js');
  const manager = new SettingsStateManager();
  await new Promise(resolve => manager.runOnReady(resolve));
  return manager;
};

describe('SettingsStateManager model removal', () => {
  beforeEach(() => {
    globalThis.document = {};
  });

  test('preserves storage shape and credentials while restoring selected-model invariants', async () => {
    const apiKeys = { openai: 'secret', anthropic: 'other-secret' };
    const manager = await createManager({
      models: initialModels(),
      current_model: 'Remove-Me',
      auto_rename: true,
      auto_rename_model: 'Remove-Me',
      transcription_model: 'Remove-Me',
      council_collector_model: 'Remove-Me',
      arena_models: ['Remove-Me', 'claude'],
      council_models: ['Remove-Me', 'survivor'],
      api_keys: apiKeys
    });

    manager.removeModel('Remove-Me', 'openai');

    const stored = await chrome.storage.local.get([
      'models', 'current_model', 'auto_rename', 'auto_rename_model',
      'transcription_model', 'council_collector_model', 'arena_models',
      'council_models', 'api_keys'
    ]);
    expect(stored.models).toEqual({
      openai: { survivor: 'Survivor' },
      anthropic: { claude: 'Claude' }
    });
    expect(stored.current_model).toBe('survivor');
    expect(stored.auto_rename).toBe(false);
    expect(stored.auto_rename_model).toBeNull();
    expect(stored.transcription_model).toBeNull();
    expect(stored.council_collector_model).toBe('survivor');
    expect(stored.arena_models).toEqual(['claude']);
    expect(stored.council_models).toEqual(['survivor']);
    expect(stored.api_keys).toEqual(apiKeys);
  });

  test('removes the exact provider entry without invalidating a shared model identifier', async () => {
    const manager = await createManager({
      models: {
        openai: { shared: 'OpenAI Shared' },
        anthropic: { shared: 'Anthropic Shared', claude: 'Claude' }
      },
      current_model: 'shared',
      arena_models: ['shared', 'claude']
    });

    manager.removeModel('shared', 'anthropic');

    const stored = await chrome.storage.local.get(['models', 'current_model', 'arena_models']);
    expect(stored.models).toEqual({
      openai: { shared: 'OpenAI Shared' },
      anthropic: { claude: 'Claude' }
    });
    expect(stored.current_model).toBe('shared');
    expect(stored.arena_models).toEqual(['shared', 'claude']);
  });
});
