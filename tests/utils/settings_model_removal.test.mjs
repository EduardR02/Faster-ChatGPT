import { describe, expect, test } from 'bun:test';
import { parseHTML } from 'linkedom';
import { createChromeMock } from '../setup.mjs';

const settingsMarkup = () => `
  <label id="models-label">Model:</label>
  <input id="model-display-name-input">
  <input id="model-api-name-input">
  <input id="arena_select" type="checkbox">
  <input id="council_select" type="checkbox">
  <input id="collector_select" type="checkbox">
  <input id="rename_select" type="checkbox">
  <input id="transcription_select" type="checkbox">
  <div class="setting"><div class="models-dummy">
    <input id="Remove-Me" name="model_select" data-provider="openai" type="radio" checked>
    <label class="model-label" for="Remove-Me">Remove Me</label>
    <input id="survivor" name="model_select" data-provider="openai" type="radio">
    <label class="model-label" for="survivor">Survivor</label>
  </div></div>
`;

const createSettings = async () => {
  const { document } = parseHTML(settingsMarkup());
  document.getElementsByName = name => document.querySelectorAll(`[name="${name}"]`);
  globalThis.document = document;
  globalThis.chrome = createChromeMock();
  await chrome.storage.local.set({
    models: { openai: { 'Remove-Me': 'Remove Me', survivor: 'Survivor' } },
    current_model: 'Remove-Me',
    api_keys: { openai: 'secret' }
  });
  const { SettingsUI } = await import('../../src/js/settings.js');
  const { SettingsStateManager } = await import('../../src/js/state_manager.js');
  const settings = Object.create(SettingsUI.prototype);
  settings.stateManager = new SettingsStateManager();
  await new Promise(resolve => settings.stateManager.runOnReady(resolve));
  return { document, settings };
};

describe('SettingsUI model removal', () => {
  test('empty fields remove the sole normal selection and refresh persisted/check state', async () => {
    const { document, settings } = await createSettings();

    await settings.removeModel();

    const stored = await chrome.storage.local.get(['models', 'current_model', 'api_keys']);
    expect(document.getElementById('Remove-Me')).toBeNull();
    expect(document.getElementById('survivor').checked).toBe(true);
    expect(stored.models).toEqual({ openai: { survivor: 'Survivor' } });
    expect(stored.current_model).toBe('survivor');
    expect(stored.api_keys).toEqual({ openai: 'secret' });
  });

  test('empty arena selection is a no-op with settings feedback', async () => {
    const { document, settings } = await createSettings();
    document.getElementById('arena_select').checked = true;
    document.getElementById('survivor').type = 'checkbox';
    document.getElementById('survivor').checked = true;

    await settings.removeModel();

    expect(document.getElementById('Remove-Me')).not.toBeNull();
    expect(document.getElementById('survivor')).not.toBeNull();
    expect(document.getElementById('models-label').classList.contains('settings-error')).toBe(true);
  });
});
