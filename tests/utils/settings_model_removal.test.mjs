import { describe, expect, test } from 'bun:test';
import { parseHTML } from 'linkedom';
import { createChromeMock } from '../setup.mjs';

const settingsMarkup = () => `
  <label id="models-label">Model:</label>
  <input id="model-display-name-input">
  <input id="model-api-name-input">
  <input id="arena_mode" type="checkbox">
  <input id="council_mode" type="checkbox">
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
    <input id="third" name="model_select" data-provider="openai" type="radio">
    <label class="model-label" for="third">Third</label>
  </div></div>
`;

const createSettings = async (overrides = {}) => {
  const { document } = parseHTML(settingsMarkup());
  document.getElementsByName = name => document.querySelectorAll(`[name="${name}"]`);
  globalThis.document = document;
  globalThis.chrome = createChromeMock();
  const storedSettings = {
    models: { openai: { 'Remove-Me': 'Remove Me', survivor: 'Survivor', third: 'Third' } },
    current_model: 'Remove-Me',
    api_keys: { openai: 'secret' },
    arena_mode: false,
    council_mode: false,
    ...overrides
  };
  await chrome.storage.local.set(storedSettings);
  const { SettingsUI } = await import('../../src/js/settings.js');
  const { SettingsStateManager } = await import('../../src/js/state_manager.js');
  const settings = Object.create(SettingsUI.prototype);
  settings.stateManager = new SettingsStateManager();
  settings.selectModes = ['arena', 'council', 'collector', 'rename', 'transcription'];
  await new Promise(resolve => settings.stateManager.runOnReady(resolve));
  document.getElementById('arena_mode').checked = storedSettings.arena_mode;
  document.getElementById('council_mode').checked = storedSettings.council_mode;
  return { document, settings };
};

describe('SettingsUI model removal', () => {
  test('empty fields remove the sole normal selection and refresh persisted/check state', async () => {
    const { document, settings } = await createSettings();

    await settings.removeModel();

    const stored = await chrome.storage.local.get(['models', 'current_model', 'api_keys']);
    expect(document.getElementById('Remove-Me')).toBeNull();
    expect(document.getElementById('survivor').checked).toBe(true);
    expect(stored.models).toEqual({ openai: { survivor: 'Survivor', third: 'Third' } });
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

  for (const mode of ['arena', 'council']) {
    test(`typed removal disables an invalid active ${mode} mode and restores normal checks`, async () => {
      const modeKey = `${mode}_mode`;
      const modelsKey = `${mode}_models`;
      const { document, settings } = await createSettings({
        current_model: 'third',
        [modeKey]: true,
        [modelsKey]: ['Remove-Me', 'survivor']
      });
      document.getElementById(`${mode}_select`).checked = true;
      for (const modelId of ['Remove-Me', 'survivor']) {
        const input = document.getElementById(modelId);
        input.type = 'checkbox';
        input.checked = true;
      }
      document.getElementById('model-api-name-input').value = 'remove-me';

      await settings.removeModel();

      const stored = await chrome.storage.local.get([modeKey, modelsKey]);
      expect(stored[modeKey]).toBe(false);
      expect(stored[modelsKey]).toEqual(['survivor']);
      expect(document.getElementById(modeKey).checked).toBe(false);
      expect(document.getElementById(`${mode}_select`).checked).toBe(false);
      expect(document.getElementById('survivor').checked).toBe(false);
      expect(document.getElementById('third').checked).toBe(true);
      expect(document.getElementById('models-label').classList.contains('settings-error')).toBe(false);
    });
  }
});
