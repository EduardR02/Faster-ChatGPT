/**
 * TabManager manages multiple chat tabs in the sidepanel.
 * Each tab has its own TabState, Controller, ChatUI, and DOM container.
 */

import { TabState } from './tab_state.js';
import { SidepanelChatUI } from './chat_ui.js';
import { SidepanelController } from './sidepanel_controller.js';
import { createElementWithClass } from './utils.js';

const STORAGE_KEY = 'sidekick_open_tabs';
const MAX_TABS = 20;
const PERSIST_DEBOUNCE_MS = 250;

export class TabManager {
    constructor(options) {
        const {
            globalState,
            apiManager,
            chatStorage,
            tabBarContainer,
            tabContentContainer,
            onTabSwitch = null,
            onTabClose = null
        } = options;

        this.globalState = globalState;
        this.apiManager = apiManager;
        this.chatStorage = chatStorage;
        this.tabBarContainer = tabBarContainer;
        this.tabContentContainer = tabContentContainer;
        this.onTabSwitch = onTabSwitch;
        this.onTabClose = onTabClose;

        this.tabs = new Map();
        this.activeTabId = null;
        this.tabOrder = [];
        this.defaultContinueFunc = null;
        this._persistTimer = null;
        this._persistDirty = false;
        this._isRestoring = false;

        this.initTabBar();
        this.initPersistence();
    }

    setDefaultContinueFunc(func) {
        this.defaultContinueFunc = func;
    }

    initTabBar() {
        this.tabBar = createElementWithClass('div', 'tab-bar');
        this.newTabButton = createElementWithClass('button', 'tab-new-button', '+');
        this.newTabButton.title = 'New tab';
        this.newTabButton.onclick = () => this.createTab();

        this.tabBar.appendChild(this.newTabButton);
        this.tabBarContainer.appendChild(this.tabBar);
    }

    initPersistence() {
        if (this.globalState?.subscribeToSetting) {
            this.globalState.subscribeToSetting('persist_tabs', (enabled) => {
                if (enabled === false) {
                    void this.clearPersistedTabs();
                } else {
                    this.schedulePersist();
                }
            });
        }

        window.addEventListener('pagehide', () => {
            void this.persistTabsNow();
        });
    }

    /**
     * Create a new tab with optional initial state
     */
    createTab(options = {}) {
        if (this.tabs.size >= MAX_TABS) {
            console.warn('Maximum tabs reached');
            return null;
        }

        const {
            activate = true,
            initialTitle = 'New Chat'
        } = options;

        const tabState = new TabState(this.globalState);
        const tabId = tabState.id;
        const stateManager = this.createTabStateProxy(tabState);

        // Defer model initialization until settings are ready
        // This ensures each tab captures its own model even if created before settings load
        this.globalState.runOnReady(() => {
            if (tabState._currentModel === null) {
                tabState.initializeModel();
            }
        });

        // Create DOM container for this tab
        const container = createElementWithClass('div', 'tab-content-container');
        container.id = `tab-container-${tabId}`;
        container.dataset.tabId = tabId;

        // Create conversation wrapper inside container
        const conversationWrapper = createElementWithClass('div', 'conversation-wrapper');
        conversationWrapper.id = `conversation-wrapper-${tabId}`;

        // Add title inside the scrollable conversation wrapper
        const titleWrapper = createElementWithClass('div', 'title-wrapper');
        const title = createElementWithClass('span', 'conversation-title', 'conversation');
        title.id = `tab-title-${tabId}`;
        titleWrapper.appendChild(title);
        conversationWrapper.appendChild(titleWrapper);

        container.appendChild(conversationWrapper);

        this.tabContentContainer.appendChild(container);

        // Create ChatUI for this tab
        const chatUI = new SidepanelChatUI({
            conversationWrapperId: conversationWrapper.id,
            scrollElementId: container.id,
            stateManager,
            continueFunc: options.continueFunc || this.defaultContinueFunc
        });

        // Create Controller for this tab
        const controller = new SidepanelController({
            stateManager,
            chatUI: chatUI,
            apiManager: this.apiManager,
            chatStorage: this.chatStorage,
            onTitleChange: (newTitle) => this.updateTabTitle(tabId, newTitle),
            onChatIdChange: (chatId) => {
                const tab = this.tabs.get(tabId);
                if (!tab) return;
                tab.tabState.chatId = chatId;
                this.schedulePersist();
            }
        });

        const tab = {
            id: tabId,
            tabState,
            chatUI,
            controller,
            container,
            title: initialTitle
        };

        this.tabs.set(tabId, tab);
        this.tabOrder.push(tabId);

        // Create tab button
        this.renderTabButton(tab);
        // Ensure newly created tab is visible if tab bar overflows horizontally
        this.tabBar.scrollLeft = this.tabBar.scrollWidth;

        // Initialize controller states before switching (so onTabSwitch has valid state)
        controller.initStates(initialTitle);
        this.updateTabTitle(tabId, initialTitle);
        if (activate) {
            this.switchTab(tabId);
        }

        this.schedulePersist();

        return tab;
    }

    /**
     * Create a proxy that combines TabState with global StateManager
     * This allows existing code to work with minimal changes
     */
    createTabStateProxy(tabState) {
        const globalState = this.globalState;

        return new Proxy(tabState, {
            get(target, prop) {
                // Per-tab state methods/properties
                if (prop in target) {
                    const value = target[prop];
                    return typeof value === 'function' ? value.bind(target) : value;
                }

                // Global state fallback
                if (prop in globalState) {
                    const value = globalState[prop];
                    return typeof value === 'function' ? value.bind(globalState) : value;
                }

                return undefined;
            },

            set(target, prop, value) {
                // Per-tab state
                if (prop in target) {
                    target[prop] = value;
                    return true;
                }

                // Global state
                if (prop in globalState) {
                    globalState[prop] = value;
                    return true;
                }

                target[prop] = value;
                return true;
            }
        });
    }

    renderTabButton(tab) {
        const button = createElementWithClass('button', 'tab-button');
        button.id = `tab-btn-${tab.id}`;
        button.dataset.tabId = tab.id;

        const titleSpan = createElementWithClass('span', 'tab-title', tab.title);
        titleSpan.title = tab.title;

        const closeBtn = createElementWithClass('button', 'tab-close-button', '\u00D7');
        closeBtn.title = 'Close tab';
        closeBtn.onclick = (e) => {
            e.stopPropagation();
            this.closeTab(tab.id);
        };

        button.appendChild(titleSpan);
        button.appendChild(closeBtn);

        button.onclick = () => this.switchTab(tab.id);

        // Insert before the new tab button
        this.tabBar.insertBefore(button, this.newTabButton);
    }

    switchTab(tabId) {
        if (!this.tabs.has(tabId)) return;
        if (tabId === this.activeTabId) return; // Already active, no-op

        const oldTabId = this.activeTabId;

        // Hide current tab
        if (oldTabId && this.tabs.has(oldTabId)) {
            const currentTab = this.tabs.get(oldTabId);
            currentTab.container.classList.remove('active');
            const currentBtn = document.getElementById(`tab-btn-${oldTabId}`);
            if (currentBtn) currentBtn.classList.remove('active');
        }

        // Show new tab
        const newTab = this.tabs.get(tabId);
        newTab.container.classList.add('active');
        const newBtn = document.getElementById(`tab-btn-${tabId}`);
        if (newBtn) newBtn.classList.add('active');

        this.activeTabId = tabId;

        // Callback with both old and new tab info
        if (this.onTabSwitch) {
            this.onTabSwitch(newTab, oldTabId);
        }
    }

    closeTab(tabId) {
        if (!this.tabs.has(tabId)) return;

        const tab = this.tabs.get(tabId);

        // Remove DOM
        tab.container.remove();
        const btn = document.getElementById(`tab-btn-${tabId}`);
        if (btn) btn.remove();

        // Remove from collections
        this.tabs.delete(tabId);
        this.tabOrder = this.tabOrder.filter(id => id !== tabId);
        if (this.onTabClose) {
            this.onTabClose(tabId);
        }

        this.schedulePersist();

        // If this was the active tab, switch to another
        if (this.activeTabId === tabId) {
            this.activeTabId = null;
            if (this.tabOrder.length > 0) {
                this.switchTab(this.tabOrder[this.tabOrder.length - 1]);
            } else {
                window.close();
            }
        }
    }

    getActiveTab() {
        return this.activeTabId ? this.tabs.get(this.activeTabId) : null;
    }

    getActiveController() {
        return this.getActiveTab()?.controller ?? null;
    }

    getActiveChatUI() {
        return this.getActiveTab()?.chatUI ?? null;
    }

    getActiveTabState() {
        return this.getActiveTab()?.tabState ?? null;
    }

    updateTabTitle(tabId, title) {
        const tab = this.tabs.get(tabId);
        if (!tab) return;

        tab.title = title || 'New Chat';

        const titleSpan = document.querySelector(`#tab-btn-${tabId} .tab-title`);
        if (titleSpan) titleSpan.textContent = titleSpan.title = tab.title;

        const contentTitle = document.getElementById(`tab-title-${tabId}`);
        if (contentTitle) contentTitle.textContent = tab.title;
    }

    /**
     * Check if current tab is "empty" (no chat started)
     */
    isCurrentTabEmpty() {
        const tab = this.getActiveTab();
        if (!tab) return true;

        const chatCore = tab.controller.chatCore;
        const hasMessages = chatCore.hasChatStarted();
        const hasText = tab.chatUI.getTextareaText().trim().length > 0;
        const hasPendingMedia = Object.keys(chatCore.pendingMedia || {}).length > 0;
        const hasAssociatedChat = !!(chatCore.getChatId() || tab.tabState.chatId);

        return !hasMessages && !hasText && !hasPendingMedia && !hasAssociatedChat;
    }

    // ========== Persistence ==========

    isTabPersistenceEnabled() {
        if (!this.globalState?.isReady) return false;
        return this.globalState.getSetting('persist_tabs') !== false;
    }

    getTabChatId(tab) {
        return tab?.controller?.chatCore?.getChatId() ?? tab?.tabState?.chatId ?? null;
    }

    findTabByChatId(chatId) {
        if (chatId == null) return null;
        const targetId = Number(chatId);
        if (!Number.isFinite(targetId)) return null;
        return [...this.tabs.values()].find(tab => this.getTabChatId(tab) === targetId) ?? null;
    }

    buildPersistedState() {
        const seen = new Set();
        const chatIds = this.tabOrder
            .map(tabId => this.getTabChatId(this.tabs.get(tabId)))
            .filter(id => id != null && !seen.has(id) && seen.add(id));
        return { chatIds };
    }

    schedulePersist() {
        if (this._isRestoring) return;
        if (!this.isTabPersistenceEnabled()) return;

        this._persistDirty = true;
        if (this._persistTimer) return;

        this._persistTimer = setTimeout(() => {
            this._persistTimer = null;
            void this.persistTabsNow();
        }, PERSIST_DEBOUNCE_MS);
    }

    async persistTabsNow() {
        if (this._persistTimer) {
            clearTimeout(this._persistTimer);
            this._persistTimer = null;
        }
        if (!this._persistDirty) return;
        this._persistDirty = false;

        if (!this.isTabPersistenceEnabled()) return;

        const data = this.buildPersistedState();
        if (!data.chatIds.length) {
            await this.clearPersistedTabs();
            return;
        }
        await chrome.storage.local.set({ [STORAGE_KEY]: data });
    }

    async clearPersistedTabs() {
        if (this._persistTimer) {
            clearTimeout(this._persistTimer);
            this._persistTimer = null;
        }
        this._persistDirty = false;
        await chrome.storage.local.remove([STORAGE_KEY]);
    }

    async restorePersistedTabs() {
        if (!this.isTabPersistenceEnabled()) return;

        this._isRestoring = true;
        try {
            const result = await chrome.storage.local.get([STORAGE_KEY]);
            const chatIds = result[STORAGE_KEY]?.chatIds;
            if (!Array.isArray(chatIds) || chatIds.length === 0) return;

            // Get existing chatIds to avoid duplicates
            const existing = new Set();
            for (const tab of this.tabs.values()) {
                const id = this.getTabChatId(tab);
                if (id != null) existing.add(id);
            }

            // Filter to new chats only, respecting max tabs
            const toRestore = [];
            for (const chatId of chatIds) {
                if (chatId == null || existing.has(chatId)) continue;
                existing.add(chatId);
                toRestore.push(chatId);
                if (this.tabs.size + toRestore.length >= MAX_TABS) break;
            }
            if (toRestore.length === 0) return;

            const loadPromises = toRestore.map(async (chatId) => {
                const tab = this.createTab({ activate: false, initialTitle: 'Loading...' });
                if (!tab) return false;
                tab.tabState.chatId = chatId;
                return this.loadChatIntoTab(tab.id, chatId);
            });

            const results = await Promise.all(loadPromises);
            if (results.some(success => !success)) this._persistDirty = true;
        } catch (e) {
            console.warn('Failed to restore tabs:', e);
        } finally {
            this._isRestoring = false;
            if (this._persistDirty) {
                void this.persistTabsNow();
            }
        }
    }

    async loadChatIntoTab(tabId, chatId) {
        const tab = this.tabs.get(tabId);
        if (!tab) return false;

        try {
            const chat = await this.chatStorage.loadChat(chatId);
            if (!this.tabs.has(tabId)) return false; // Tab was closed during load
            if (!chat?.chatId) throw new Error('Chat not found');
            if (tab.tabState.chatId !== chat.chatId) return false; // Tab was reassigned

            tab.controller.initStates(chat.title || 'Chat');
            tab.controller.chatCore.buildFromDB(chat);
            tab.chatUI.updateIncognito(tab.controller.chatCore.hasChatStarted());
            tab.chatUI.buildChat(tab.controller.chatCore.getChat());
            tab.tabState.chatId = chat.chatId;
            this.updateTabTitle(tabId, chat.title || 'Chat');
            requestAnimationFrame(() => {
                if (this.tabs.has(tabId)) {
                    tab.container.scrollTop = tab.container.scrollHeight;
                }
            });
            return true;
        } catch (e) {
            console.warn(`Failed to restore chat ${chatId}:`, e);
            if (this.tabs.has(tabId)) this.closeTab(tabId);
            return false;
        }
    }

    // ========== Utility ==========

    getTabCount() {
        return this.tabs.size;
    }

    getAllTabs() {
        return Array.from(this.tabs.values());
    }

    // NOTE: no explicit cancel needed; restore applies only if tabState.chatId matches.
}
