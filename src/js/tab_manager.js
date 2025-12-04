/**
 * TabManager manages multiple chat tabs in the sidepanel.
 * Each tab has its own TabState, Controller, ChatUI, and DOM container.
 */

import { TabState } from './tab_state.js';
import { SidepanelChatUI } from './chat_ui.js';
import { SidepanelController } from './sidepanel_controller.js';
import { SidepanelChatCore } from './chat_core.js';
import { createElementWithClass } from './utils.js';

const STORAGE_KEY = 'sidekick_open_tabs';
const MAX_TABS = 20;

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

        this.initTabBar();
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

    /**
     * Create a new tab with optional initial state
     */
    createTab(options = {}) {
        if (this.tabs.size >= MAX_TABS) {
            console.warn('Maximum tabs reached');
            return null;
        }

        const tabState = new TabState(this.globalState);
        const tabId = tabState.id;

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
            stateManager: this.createTabStateProxy(tabState),
            continueFunc: options.continueFunc || this.defaultContinueFunc
        });

        // Create Controller for this tab
        const controller = new SidepanelController({
            stateManager: this.createTabStateProxy(tabState),
            chatUI: chatUI,
            apiManager: this.apiManager,
            chatStorage: this.chatStorage
        });

        const tab = {
            id: tabId,
            tabState,
            chatUI,
            controller,
            container,
            title: 'New Chat'
        };

        this.tabs.set(tabId, tab);
        this.tabOrder.push(tabId);

        // Create tab button
        this.renderTabButton(tab);
        // Ensure newly created tab is visible if tab bar overflows horizontally
        if (this.tabBar) {
            this.tabBar.scrollLeft = this.tabBar.scrollWidth;
        }

        // Switch to new tab
        this.switchTab(tabId);

        // Initialize controller states
        controller.initStates('New Chat');

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

        // If this was the active tab, switch to another
        if (this.activeTabId === tabId) {
            this.activeTabId = null;
            if (this.tabOrder.length > 0) {
                this.switchTab(this.tabOrder[this.tabOrder.length - 1]);
            } else {
                // Close sidepanel if last tab closed
                window.close();
            }
        }
    }

    getActiveTab() {
        if (!this.activeTabId) return null;
        return this.tabs.get(this.activeTabId);
    }

    getActiveController() {
        const tab = this.getActiveTab();
        return tab ? tab.controller : null;
    }

    getActiveChatUI() {
        const tab = this.getActiveTab();
        return tab ? tab.chatUI : null;
    }

    getActiveTabState() {
        const tab = this.getActiveTab();
        return tab ? tab.tabState : null;
    }

    updateTabTitle(tabId, title) {
        if (!this.tabs.has(tabId)) return;

        const tab = this.tabs.get(tabId);
        tab.title = title || 'New Chat';

        // Update tab button title
        const btn = document.getElementById(`tab-btn-${tabId}`);
        if (btn) {
            const titleSpan = btn.querySelector('.tab-title');
            if (titleSpan) {
                titleSpan.textContent = tab.title;
                titleSpan.title = tab.title;
            }
        }

        // Update in-content title (inside scrollable area)
        const contentTitle = document.getElementById(`tab-title-${tabId}`);
        if (contentTitle) {
            contentTitle.textContent = tab.title;
        }

        this.persistTabs();
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

        return !hasMessages && !hasText && !hasPendingMedia;
    }

    /**
     * Handle new selection - create new tab unless current is empty
     */
    handleNewSelection(text, url, initCallback) {
        if (!this.isCurrentTabEmpty()) {
            this.createTab();
        }
        initCallback(this.getActiveTab());
    }

    /**
     * Handle new chat request - always create new tab
     */
    handleNewChat(initCallback) {
        this.createTab();
        initCallback(this.getActiveTab());
    }

    /**
     * Handle reconstruct chat - new tab unless current is empty
     */
    handleReconstructChat(options, initCallback) {
        if (!this.isCurrentTabEmpty()) {
            this.createTab();
        }
        initCallback(this.getActiveTab(), options);
    }

    // ========== Persistence ==========

    async persistTabs() {
        const shouldPersist = await this.shouldPersistTabs();
        if (!shouldPersist) return;

        const data = {
            activeTabId: this.activeTabId,
            tabs: this.tabOrder.map(tabId => {
                const tab = this.tabs.get(tabId);
                return {
                    id: tabId,
                    chatId: tab.controller.chatCore.getChatId(),
                    title: tab.title
                };
            }).filter(t => t.chatId) // Only persist tabs with saved chats
        };

        chrome.storage.local.set({ [STORAGE_KEY]: data });
    }

    async restoreTabs() {
        const shouldPersist = await this.shouldPersistTabs();
        if (!shouldPersist) {
            this.createTab();
            return;
        }

        const result = await chrome.storage.local.get([STORAGE_KEY]);
        const data = result[STORAGE_KEY];

        if (!data || !data.tabs || data.tabs.length === 0) {
            this.createTab();
            return;
        }

        // Restore tabs
        for (const tabData of data.tabs) {
            const tab = this.createTab();
            if (tab && tabData.chatId) {
                tab.tabState.chatId = tabData.chatId;
                this.updateTabTitle(tab.id, tabData.title);
                // Reconstruct chat will be called after by the app
            }
        }

        // Switch to previously active tab
        if (data.activeTabId && this.tabs.has(data.activeTabId)) {
            this.switchTab(data.activeTabId);
        }
    }

    async shouldPersistTabs() {
        const result = await chrome.storage.local.get(['persist_tabs']);
        return result.persist_tabs !== false; // Default to true
    }

    async loadRestoredChats() {
        for (const [tabId, tab] of this.tabs) {
            if (tab.tabState.chatId) {
                try {
                    const chat = await this.chatStorage.loadChat(tab.tabState.chatId);
                    if (chat) {
                        tab.controller.chatCore.buildFromDB(chat);
                        tab.chatUI.buildChat(tab.controller.chatCore.getChat());
                        this.updateTabTitle(tabId, chat.title);
                    }
                } catch (e) {
                    console.warn(`Failed to restore chat for tab ${tabId}:`, e);
                }
            }
        }
    }

    // ========== Utility ==========

    getTabCount() {
        return this.tabs.size;
    }

    getAllTabs() {
        return Array.from(this.tabs.values());
    }
}
