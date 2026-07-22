import { describe, expect, test } from 'bun:test';
import { parseHTML } from 'linkedom';
import { createChromeMock } from '../setup.mjs';

const loadSidepanel = async (settings) => {
  const { document, window } = parseHTML(`
    <textarea id="textInput"></textarea>
    <div id="tab-bar-container"></div>
    <div id="tab-content-area"></div>
    <button class="arena-toggle-button--arena"></button>
    <button class="council-toggle-button"></button>
  `);
  globalThis.document = document;
  globalThis.window = window;
  globalThis.chrome = createChromeMock();
  await chrome.storage.local.set({ persist_tabs: false, ...settings });

  const [{ SidepanelStateManager, SettingsStateManager }, { TabState }, { TabManager }, { SidepanelApp }] = await Promise.all([
    import('../../src/js/state_manager.js'),
    import('../../src/js/tab_state.js'),
    import('../../src/js/tab_manager.js'),
    import('../../src/js/sidepanel.js')
  ]);
  const sidepanelState = new SidepanelStateManager('chat_prompt');
  sidepanelState.apiManager = {
    canToggleThinking: () => false,
    hasToggleThinking: () => false
  };
  const settingsState = new SettingsStateManager();
  await Promise.all([
    new Promise(resolve => sidepanelState.runOnReady(resolve)),
    new Promise(resolve => settingsState.runOnReady(resolve))
  ]);

  const app = Object.create(SidepanelApp.prototype);
  Object.assign(app, {
    stateManager: sidepanelState,
    textInput: document.getElementById('textInput'),
    tabTextareaContent: new Map(),
    voiceManager: { handleTabSwitch: () => {} },
    incognitoToggle: null,
    deferRestoredTabSwitchLoads: true,
    updateInputReconstructionState: () => {}
  });
  const tabManager = new TabManager({
    globalState: sidepanelState,
    tabBarContainer: document.getElementById('tab-bar-container'),
    tabContentContainer: document.getElementById('tab-content-area'),
    onTabSwitch: (tab, oldTabId) => app.handleTabSwitch(tab, oldTabId),
    onTabStateReconciled: tabState => app.updateHeaderControls(tabState)
  });
  app.tabManager = tabManager;

  return { document, sidepanelState, settingsState, TabState, tabManager };
};

const addTab = (document, manager, TabState, id, model = undefined) => {
  const state = new TabState(manager.globalState, id);
  if (model === undefined) state.initializeModel();
  else state.setCurrentModel(model);
  const container = document.createElement('div');
  container.id = `tab-container-${id}`;
  document.body.appendChild(container);
  const button = document.createElement('button');
  button.id = `tab-btn-${id}`;
  document.body.appendChild(button);
  const tab = {
    id,
    tabState: state,
    container,
    chatUI: { updateIncognitoButtonVisuals: () => {} },
    controller: { stateManager: manager.createTabStateProxy(state) }
  };
  manager.tabs.set(id, tab);
  manager.tabOrder.push(id);
  return tab;
};

const applyStorageChanges = (state, previous, current, keys) => {
  const changes = Object.fromEntries(keys.map(key => [
    key,
    { oldValue: previous[key], newValue: current[key] }
  ]));
  state.handleStorageChanges(changes);
};

describe('model removal across sidepanel tabs', () => {
  test('a models-only event reconciles the active source, subscribers, inactive tabs, and future tabs', async () => {
    const initial = {
      models: { openai: { removed: 'Removed', fallback: 'Fallback', diverged: 'Diverged' } },
      current_model: 'diverged'
    };
    const previous = structuredClone(initial);
    const context = await loadSidepanel(initial);
    const { document, sidepanelState, settingsState, TabState, tabManager } = context;
    const active = addTab(document, tabManager, TabState, 'active', 'removed');
    const inactive = addTab(document, tabManager, TabState, 'inactive', 'removed');
    tabManager.activeTabId = active.id;
    active.container.classList.add('active');
    const renderedModels = [];
    sidepanelState.subscribeToSetting('current_model', model => renderedModels.push(model));

    settingsState.removeModel('removed', 'openai');
    const current = await chrome.storage.local.get(['models', 'current_model']);
    expect(current.current_model).toBe('diverged');
    applyStorageChanges(sidepanelState, previous, current, ['models']);

    expect(active.tabState.getCurrentModel()).toBe('fallback');
    expect(inactive.tabState.getCurrentModel()).toBe('fallback');
    expect(sidepanelState.getSetting('current_model')).toBe('fallback');
    expect(renderedModels).toEqual(['fallback']);

    const future = addTab(document, tabManager, TabState, 'future');
    expect(future.tabState.getCurrentModel()).toBe('fallback');
    tabManager.switchTab(inactive.id);
    tabManager.switchTab(future.id);
    expect(sidepanelState.getSetting('current_model')).toBe('fallback');
  });

  test('provider resolution changes invalidate shared identifiers in every tab', async () => {
    const initial = {
      models: {
        openai: { shared: 'OpenAI Shared' },
        anthropic: { shared: 'Anthropic Shared', claude: 'Claude' }
      },
      current_model: 'shared'
    };
    const previous = structuredClone(initial);
    const context = await loadSidepanel(initial);
    const { document, sidepanelState, settingsState, TabState, tabManager } = context;
    const active = addTab(document, tabManager, TabState, 'active', 'shared');
    const inactive = addTab(document, tabManager, TabState, 'inactive', 'shared');
    tabManager.activeTabId = active.id;
    active.container.classList.add('active');

    settingsState.removeModel('shared', 'openai');
    const current = await chrome.storage.local.get(['models', 'current_model']);
    applyStorageChanges(sidepanelState, previous, current, ['models']);

    expect(active.tabState.getCurrentModel()).toBe('claude');
    expect(inactive.tabState.getCurrentModel()).toBe('claude');
    tabManager.switchTab(inactive.id);
    expect(sidepanelState.getSetting('current_model')).toBe('claude');
  });

  for (const mode of ['arena', 'council']) {
    test(`storage listeners clear invalid ${mode} state from every tab and active controls`, async () => {
      const modeKey = `${mode}_mode`;
      const modelsKey = `${mode}_models`;
      const initial = {
        models: { openai: { removed: 'Removed', fallback: 'Fallback' } },
        current_model: 'fallback',
        arena_mode: false,
        council_mode: false,
        arena_models: [],
        council_models: [],
        [modeKey]: true,
        [modelsKey]: ['removed', 'fallback']
      };
      const previous = structuredClone(initial);
      const context = await loadSidepanel(initial);
      const { document, sidepanelState, settingsState, TabState, tabManager } = context;
      const active = addTab(document, tabManager, TabState, 'active', 'fallback');
      const inactive = addTab(document, tabManager, TabState, 'inactive', 'fallback');
      for (const tab of [active, inactive]) {
        if (mode === 'arena') tab.tabState.initArenaResponse('removed', 'fallback');
        else tab.tabState.initCouncilResponse(['removed', 'fallback'], 'fallback');
      }
      tabManager.activeTabId = active.id;
      active.container.classList.add('active');

      settingsState.removeModel('removed', 'openai');
      const current = await chrome.storage.local.get(['models', modeKey, modelsKey]);
      const eventBatches = mode === 'arena'
        ? [['models'], [modelsKey, modeKey]]
        : [[modeKey], [modelsKey], ['models']];
      for (const keys of eventBatches) applyStorageChanges(sidepanelState, previous, current, keys);

      expect(sidepanelState.getSetting(modeKey)).toBe(false);
      expect(active.tabState[`is${mode[0].toUpperCase()}${mode.slice(1)}ModeActive`]).toBe(false);
      expect(inactive.tabState[`is${mode[0].toUpperCase()}${mode.slice(1)}ModeActive`]).toBe(false);
      expect(active.controller.stateManager[`is${mode[0].toUpperCase()}${mode.slice(1)}ModeActive`]).toBe(false);
      const selector = mode === 'arena' ? '.arena-toggle-button--arena' : '.council-toggle-button';
      expect(document.querySelector(selector).classList.contains(`${mode}-mode-on`)).toBe(false);
    });
  }
});
