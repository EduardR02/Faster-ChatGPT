import { describe, expect, test } from 'bun:test';
import { parseHTML } from 'linkedom';
import { createChromeMock } from '../setup.mjs';

const loadSidepanel = async (settings) => {
  const { document, window } = parseHTML(`
    <textarea id="textInput"></textarea>
    <div id="tab-bar-container"></div>
    <div id="tab-content-area"></div>
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
    updateInputReconstructionState: () => {},
    updateHeaderControls: () => {}
  });
  const tabManager = new TabManager({
    globalState: sidepanelState,
    tabBarContainer: document.getElementById('tab-bar-container'),
    tabContentContainer: document.getElementById('tab-content-area'),
    onTabSwitch: (tab, oldTabId) => app.handleTabSwitch(tab, oldTabId)
  });
  app.tabManager = tabManager;

  return { document, sidepanelState, settingsState, TabState, tabManager };
};

const addTab = (document, manager, TabState, id, model) => {
  const state = new TabState(manager.globalState, id);
  state.setCurrentModel(model);
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
    controller: {}
  };
  manager.tabs.set(id, tab);
  manager.tabOrder.push(id);
  return tab;
};

const applyStorageChanges = (state, previous, current) => {
  const changes = Object.fromEntries(['models', 'current_model'].map(key => [
    key,
    { oldValue: previous[key], newValue: current[key] }
  ]));
  state.handleStorageChanges(changes);
};

describe('model removal across sidepanel tabs', () => {
  test('storage model changes fallback every inactive tab before it can be switched in', async () => {
    const initial = {
      models: { openai: { removed: 'Removed', fallback: 'Fallback' } },
      current_model: 'removed'
    };
    const context = await loadSidepanel(initial);
    const { document, sidepanelState, settingsState, TabState, tabManager } = context;
    const active = addTab(document, tabManager, TabState, 'active', 'fallback');
    const inactiveA = addTab(document, tabManager, TabState, 'inactive-a', 'removed');
    const inactiveB = addTab(document, tabManager, TabState, 'inactive-b', 'removed');
    tabManager.activeTabId = active.id;
    active.container.classList.add('active');

    settingsState.removeModel('removed', 'openai');
    const current = await chrome.storage.local.get(['models', 'current_model']);
    applyStorageChanges(sidepanelState, initial, current);

    expect(inactiveA.tabState.getCurrentModel()).toBe('fallback');
    expect(inactiveB.tabState.getCurrentModel()).toBe('fallback');
    tabManager.switchTab(inactiveA.id);
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
    const context = await loadSidepanel(initial);
    const { document, sidepanelState, settingsState, TabState, tabManager } = context;
    const active = addTab(document, tabManager, TabState, 'active', 'shared');
    const inactive = addTab(document, tabManager, TabState, 'inactive', 'shared');
    tabManager.activeTabId = active.id;
    active.container.classList.add('active');

    settingsState.removeModel('shared', 'openai');
    const current = await chrome.storage.local.get(['models', 'current_model']);
    applyStorageChanges(sidepanelState, initial, current);

    expect(active.tabState.getCurrentModel()).toBe('claude');
    expect(inactive.tabState.getCurrentModel()).toBe('claude');
    tabManager.switchTab(inactive.id);
    expect(sidepanelState.getSetting('current_model')).toBe('claude');
  });
});
