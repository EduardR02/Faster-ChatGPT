import { TabState } from './tab_state.js';
import { SidepanelChatUI } from './chat_ui.js';
import { SidepanelController } from './sidepanel_controller.js';
import { createElementWithClass } from './ui_utils.js';
import { createStateProxy } from './state_proxy.js';
import { findFirstAvailableModel, hasValidMultiModelSelection } from './model_selection.js';

const STORAGE_KEY = 'sidekick_open_tabs';
const MAX_TABS = 20;
const PERSIST_DEBOUNCE_MS = 250;

const indexModelProviders = (models) => {
    const providers = new Map();
    for (const [provider, providerModels] of Object.entries(models || {})) {
        for (const modelId of Object.keys(providerModels)) {
            if (!providers.has(modelId)) providers.set(modelId, provider);
        }
    }
    return providers;
};

/**
 * Manages multiple chat tabs in the sidepanel.
 */
export class TabManager {
    constructor(options) {
        Object.assign(this, {
            ...options,
            tabs: new Map(),
            activeTabId: null,
            tabOrder: [],
            defaultContinueFunc: null,
            persistTimer: null,
            isDirty: false,
            isRestoring: false,
            modelProviders: new Map()
        });

        this.initTabBar();
        
        if (this.globalState) {
            this.globalState.subscribeToSetting('models', models => {
                this.reconcileModels(models);
                this.reconcileModes({ models });
            });
            this.globalState.subscribeToSetting('arena_models', arenaModels => this.reconcileModes({ arenaModels }));
            this.globalState.subscribeToSetting('council_models', councilModels => this.reconcileModes({ councilModels }));
            this.globalState.runOnReady?.(() => {
                this.modelProviders = indexModelProviders(this.globalState.getSetting('models'));
            });
            this.globalState.subscribeToSetting('persist_tabs', (enabled) => {
                if (enabled === false) this.clearPersistedTabs();
                else this.schedulePersist();
            });
            window.addEventListener('pagehide', () => this.persistTabsNow());
        }
    }

    initTabBar() {
        this.tabBar = createElementWithClass('div', 'tab-bar');
        const addButton = createElementWithClass('button', 'tab-new-button', '+');
        addButton.title = 'New tab';
        addButton.onclick = () => {
            if (typeof this.onNewTabRequested === 'function') {
                this.onNewTabRequested();
                return;
            }

            this.createTab();
        };
        
        this.tabBar.appendChild(addButton);
        this.tabBarContainer.appendChild(this.tabBar);
    }

    createTab(options = {}) {
        if (this.tabs.size >= MAX_TABS) return null;

        const state = new TabState(this.globalState);
        const id = state.id;
        const stateProxy = this.createTabStateProxy(state);

        if (this.globalState?.runOnReady) {
            this.globalState.runOnReady(() => {
                if (state._currentModel === null) {
                    state.initializeModel();
                }
            });
        }

        const container = this.createTabDOM(id);
        const chatUI = new SidepanelChatUI({
            conversationWrapperId: `conversation-wrapper-${id}`,
            scrollElementId: container.id,
            stateManager: stateProxy,
            continueFunc: options.continueFunc || this.defaultContinueFunc
        });

        const controller = new SidepanelController({
            stateManager: stateProxy,
            chatUI,
            apiManager: this.apiManager,
            chatStorage: this.chatStorage,
            onTitleChange: (newTitle) => this.updateTabTitle(id, newTitle),
            onChatIdChange: (newChatId) => {
                const tab = this.tabs.get(id);
                if (tab) {
                    tab.tabState.chatId = newChatId;
                    this.schedulePersist();
                }
            }
        });

        const tab = {
            id,
            tabState: state,
            chatUI,
            controller,
            container,
            title: options.initialTitle || 'New Chat',
            reconstruction: options.reconstruction || null
        };

        this.tabs.set(id, tab);
        this.tabOrder.push(id);
        this.renderTabButton(tab);

        this.tabBar.scrollLeft = this.tabBar.scrollWidth;
        controller.initStates(tab.title);
        this.updateTabTitle(id, tab.title);

        if (options.activate !== false) {
            this.switchTab(id);
        }

        this.schedulePersist();
        return tab;
    }

    createTabDOM(id) {
        const container = createElementWithClass('div', 'tab-content-container');
        container.id = `tab-container-${id}`;
        
        const wrapper = createElementWithClass('div', 'conversation-wrapper');
        wrapper.id = `conversation-wrapper-${id}`;
        
        const titleWrapper = createElementWithClass('div', 'title-wrapper');
        const titleSpan = createElementWithClass('span', 'conversation-title', 'conversation');
        titleSpan.id = `tab-title-${id}`;
        
        titleWrapper.appendChild(titleSpan);
        wrapper.appendChild(titleWrapper);
        container.appendChild(wrapper);
        
        return this.tabContentContainer.appendChild(container);
    }

    createTabStateProxy(state) {
        return createStateProxy(state, this.globalState);
    }

    reconcileModels(models) {
        const nextProviders = indexModelProviders(models);
        const activeTabState = this.getActiveTabState();
        let activeModelChanged = false;

        for (const { tabState } of this.tabs.values()) {
            const currentModel = tabState.getCurrentModel();
            const providerChanged = this.modelProviders.get(currentModel) !== nextProviders.get(currentModel);
            if (!providerChanged) continue;
            tabState.setCurrentModel(findFirstAvailableModel(models, currentModel) ?? '');
            if (tabState === activeTabState) activeModelChanged = true;
        }

        this.modelProviders = nextProviders;

        if (activeModelChanged) {
            const currentModel = activeTabState.getCurrentModel() || null;
            if (this.globalState.getSetting('current_model') !== currentModel) {
                this.globalState.updateSettingsLocal({ current_model: currentModel });
            }
        }
    }

    reconcileModes(overrides = {}) {
        const models = overrides.models ?? this.globalState.getSetting('models') ?? {};
        const arenaModels = overrides.arenaModels ?? this.globalState.getSetting('arena_models');
        const councilModels = overrides.councilModels ?? this.globalState.getSetting('council_models');
        const arenaValid = hasValidMultiModelSelection(arenaModels, models);
        const councilValid = hasValidMultiModelSelection(councilModels, models);
        const activeTabState = this.getActiveTabState();
        let activeModeChanged = false;

        for (const { tabState } of this.tabs.values()) {
            if (!arenaValid && tabState.isArenaModeActive) {
                tabState.clearArenaState();
                if (tabState === activeTabState) activeModeChanged = true;
            }
            if (!councilValid && tabState.isCouncilModeActive) {
                tabState.clearCouncilState();
                if (tabState === activeTabState) activeModeChanged = true;
            }
        }

        const modeUpdates = {};
        if (this.globalState.getSetting('arena_mode') && !arenaValid) modeUpdates.arena_mode = false;
        if (this.globalState.getSetting('council_mode') && !councilValid) modeUpdates.council_mode = false;
        if (Object.keys(modeUpdates).length > 0) this.globalState.updateSettingsLocal(modeUpdates);
        if (activeModeChanged) this.onTabStateReconciled?.(activeTabState);
    }

    renderTabButton(tab) {
        const button = createElementWithClass('button', 'tab-button');
        button.id = `tab-btn-${tab.id}`;
        button.dataset.tabId = tab.id;

        const title = createElementWithClass('span', 'tab-title', tab.title);
        title.title = tab.title;

        const close = createElementWithClass('button', 'tab-close-button', '×');
        close.title = 'Close tab';
        close.onclick = (e) => {
            e.stopPropagation();
            this.closeTab(tab.id);
        };

        button.append(title, close);
        button.onclick = () => this.switchTab(tab.id);
        this.tabBar.insertBefore(button, this.tabBar.lastChild);
    }

    switchTab(id) {
        if (!this.tabs.has(id) || id === this.activeTabId) return;

        if (this.activeTabId) {
            const currentTab = this.tabs.get(this.activeTabId);
            currentTab.container.classList.remove('active');
            const currentTabButton = document.getElementById(`tab-btn-${this.activeTabId}`);
            if (currentTabButton) {
                currentTabButton.classList.remove('active');
            }
        }

        const nextTab = this.tabs.get(id);
        nextTab.container.classList.add('active');
        const nextTabButton = document.getElementById(`tab-btn-${id}`);
        if (nextTabButton) {
            nextTabButton.classList.add('active');
        }

        const oldTabId = this.activeTabId;
        this.activeTabId = id;
        
        if (this.onTabSwitch) {
            this.onTabSwitch(nextTab, oldTabId);
        }
    }

    closeTab(id) {
        const tab = this.tabs.get(id);
        if (!tab) return;

        tab.reconstruction = null;
        tab.chatUI.destroy();
        tab.container.remove();
        const tabButton = document.getElementById(`tab-btn-${id}`);
        if (tabButton) {
            tabButton.remove();
        }
        
        this.tabs.delete(id);
        this.tabOrder = this.tabOrder.filter(tabId => tabId !== id);

        if (this.onTabClose) {
            this.onTabClose(id);
        }
        this.schedulePersist();

        if (this.activeTabId === id) {
            this.activeTabId = null;
            if (this.tabOrder.length > 0) {
                this.switchTab(this.tabOrder.at(-1));
            } else {
                window.close();
            }
        }
    }

    updateTabTitle(id, title) {
        const tab = this.tabs.get(id);
        if (!tab) return;

        tab.title = title || 'New Chat';
        const buttonTitleSpan = document.querySelector(`#tab-btn-${id} .tab-title`);
        if (buttonTitleSpan) {
            buttonTitleSpan.textContent = tab.title;
            buttonTitleSpan.title = tab.title;
        }
        
        const contentTitleSpan = document.getElementById(`tab-title-${id}`);
        if (contentTitleSpan) {
            contentTitleSpan.textContent = tab.title;
        }
    }

    isCurrentTabEmpty() {
        const activeTab = this.getActiveTab();
        if (!activeTab) return true;
        if (activeTab.reconstruction !== null) return false;
        
        const chatCore = activeTab.controller.chatCore;
        const hasStarted = chatCore.hasChatStarted();
        const hasInputText = activeTab.chatUI.getTextareaText().trim().length > 0;
        const hasPendingMedia = Object.keys(chatCore.pendingMedia).length > 0;
        const hasChatId = chatCore.getChatId() || activeTab.tabState.chatId;

        return !(hasStarted || hasInputText || hasPendingMedia || hasChatId);
    }

    getActiveTab() { return this.tabs.get(this.activeTabId); }
    getTab(id) { return this.tabs.get(id); }
    getActiveController() { return this.getActiveTab()?.controller; }
    getActiveChatUI() { return this.getActiveTab()?.chatUI; }
    getActiveTabState() { return this.getActiveTab()?.tabState; }

    getTabChatId(tab) {
        const reconstructionChatId = tab?.reconstruction?.options?.index === undefined
            ? tab?.reconstruction?.options?.chatId
            : null;
        return tab?.controller?.chatCore?.getChatId()
            ?? tab?.tabState?.chatId
            ?? reconstructionChatId;
    }

    findTabByChatId(chatId) {
        const numericChatId = Number(chatId);
        return Array.from(this.tabs.values()).find(tab => this.getTabChatId(tab) === numericChatId);
    }

    schedulePersist() {
        if (this.isRestoring || !this.isPersistenceEnabled()) return;
        
        this.isDirty = true;
        if (this.persistTimer) return;

        this.persistTimer = setTimeout(() => {
            this.persistTimer = null;
            this.persistTabsNow();
        }, PERSIST_DEBOUNCE_MS);
    }

    isPersistenceEnabled() {
        return this.globalState?.isReady && this.globalState?.getSetting('persist_tabs') !== false;
    }

    async persistTabsNow() {
        if (this.persistTimer) {
            clearTimeout(this.persistTimer);
        }
        if (!this.isDirty || !this.isPersistenceEnabled()) return;

        this.isDirty = false;
        const chatIds = [...new Set(this.tabOrder
            .map(tabId => this.getTabChatId(this.tabs.get(tabId)))
            .filter(chatId => chatId != null))];

        if (chatIds.length === 0) {
            await chrome.storage.local.remove([STORAGE_KEY]);
        } else {
            await chrome.storage.local.set({ [STORAGE_KEY]: { chatIds } });
        }
    }

    async clearPersistedTabs() {
        if (this.persistTimer) {
            clearTimeout(this.persistTimer);
        }
        this.isDirty = false;
        await chrome.storage.local.remove([STORAGE_KEY]);
    }

    async restorePersistedTabs() {
        if (!this.isPersistenceEnabled()) return;
        this.isRestoring = true;

        try {
            const storageResult = await chrome.storage.local.get([STORAGE_KEY]);
            const persistedChatIds = storageResult[STORAGE_KEY]?.chatIds;
            if (!persistedChatIds?.length) return;

            const existingChatIds = new Set(Array.from(this.tabs.values())
                .map(tab => this.getTabChatId(tab))
                .filter(chatId => chatId != null));

            const seen = new Set();
            const normalizedChatIds = [];
            let needsCleanup = false;
            for (const chatId of persistedChatIds) {
                const numericChatId = Number(chatId);
                if (chatId == null || (typeof chatId === 'string' && !chatId.trim()) || !Number.isInteger(numericChatId) || numericChatId <= 0 || seen.has(numericChatId)) {
                    needsCleanup = true;
                    continue;
                }
                seen.add(numericChatId);
                if (existingChatIds.has(numericChatId)) {
                    needsCleanup = true;
                    continue;
                }
                normalizedChatIds.push(numericChatId);
            }

            const availableSlots = MAX_TABS - this.tabs.size;
            if (normalizedChatIds.length > availableSlots) needsCleanup = true;
            const chatIdsToRestore = normalizedChatIds.slice(0, availableSlots);
            const metadataResults = await Promise.all(chatIdsToRestore.map(async chatId => {
                try {
                    return { chatId, metadata: await this.chatStorage.getChatMetadataById(chatId) };
                } catch (error) {
                    console.warn(`Failed to restore chat metadata for ${chatId}:`, error);
                    return { chatId, metadata: null };
                }
            }));

            for (const { chatId, metadata } of metadataResults) {
                if (!metadata) {
                    needsCleanup = true;
                    continue;
                }
                if (Array.from(this.tabs.values()).some(tab => this.getTabChatId(tab) === chatId)) {
                    needsCleanup = true;
                    continue;
                }

                const newTab = this.createTab({
                    activate: false,
                    initialTitle: metadata.title || 'Chat',
                    reconstruction: { status: 'pending', options: { chatId } }
                });
                if (!newTab) {
                    needsCleanup = true;
                    continue;
                }
                newTab.tabState.chatId = chatId;
            }

            if (needsCleanup) this.isDirty = true;
        } catch (error) {
            console.warn('Failed to restore persisted tabs:', error);
        } finally {
            this.isRestoring = false;
            if (this.isDirty) {
                try {
                    await this.persistTabsNow();
                } catch (error) {
                    console.warn('Failed to clean up persisted tabs:', error);
                }
            }
        }
    }

    getTabCount() { return this.tabs.size; }
    getAllTabs() { return Array.from(this.tabs.values()); }
    setDefaultContinueFunc(func) { this.defaultContinueFunc = func; }
}
