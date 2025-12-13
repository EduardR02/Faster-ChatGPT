import { auto_resize_textfield_listener, update_textfield_height } from "./utils.js";
import { ApiManager } from "./api_manager.js";
import { ChatStorage } from './chat_storage.js';
import { SidepanelStateManager } from './state_manager.js';
import { TabManager } from './tab_manager.js';

class SidepanelApp {
    constructor() {
        this.stateManager = new SidepanelStateManager('chat_prompt');
        this.apiManager = new ApiManager({
            getShouldThink: () => this.getActiveTabState()?.getShouldThink() ?? false,
            getWebSearch: () => this.getActiveTabState()?.getShouldWebSearch() ?? false,
            getOpenAIReasoningEffort: () => this.getActiveTabState()?.getReasoningEffort() ?? 'medium',
            getGeminiThinkingLevel: () => this.getActiveTabState()?.getReasoningEffort() ?? 'medium',
            getImageAspectRatio: () => this.getActiveTabState()?.getImageAspectRatio() ?? 'auto',
            getImageResolution: () => this.getActiveTabState()?.getImageResolution() ?? '2K'
        });
        this.chatStorage = new ChatStorage();

        // Per-tab textarea content storage
        this.tabTextareaContent = new Map();
        this.sharedUIInitialized = false;
        this.openedForReconstruct = false;
        this.startupAt = Date.now();
        this.startupNewTabId = null;
        this._markNextTabAsStartupNew = false;

        // Initialize TabManager
        this.tabManager = new TabManager({
            globalState: this.stateManager,
            apiManager: this.apiManager,
            chatStorage: this.chatStorage,
            tabBarContainer: document.getElementById('tab-bar-container'),
            tabContentContainer: document.getElementById('tab-content-area'),
            onTabSwitch: (newTab, oldTabId) => this.handleTabSwitch(newTab, oldTabId),
            onTabClose: (tabId) => this.tabTextareaContent.delete(tabId)
        });

        // Set default continueFunc for tabs created via + button
        this.tabManager.setDefaultContinueFunc((index, secondaryIndex, modelChoice) =>
            this.continueFromCurrent(index, secondaryIndex, modelChoice)
        );

        // Subscribe to model changes - update the ACTIVE tab when model changes
        this.stateManager.subscribeToSetting('current_model', (model) => {
            const activeTabState = this.tabManager.getActiveTabState();
            if (activeTabState) {
                activeTabState.setCurrentModel(model);
            }
        });

        this.initEventListeners();

        this.stateManager.runOnReady(() => {
            void this.bootstrapTabs();
        });
    }

    ensureSharedUIInitialized() {
        if (this.sharedUIInitialized) return;
        const chatUI = this.getActiveChatUI();
        if (!chatUI) return;
        this.initSharedUI(chatUI);
        this.sharedUIInitialized = true;
        this.initIncognitoToggle();
    }

    ensureActiveTab() {
        if (this.getActiveController()) return;

        // If tabs exist but none is active, activate the first one
        const existingTabs = this.tabManager.getAllTabs();
        if (existingTabs.length > 0) {
            this.tabManager.switchTab(existingTabs[0].id);
            this.ensureSharedUIInitialized();
            return;
        }

        // No tabs exist, create a new one
        const tab = this.tabManager.createTab({
            continueFunc: (index, secondaryIndex, modelChoice) =>
                this.continueFromCurrent(index, secondaryIndex, modelChoice)
        });
        if (tab && this._markNextTabAsStartupNew) {
            this.startupNewTabId = tab.id;
        }
        if (tab) this.ensureSharedUIInitialized();
    }

    async bootstrapTabs() {
        await this.tabManager.restorePersistedTabs();

        if (!this.openedForReconstruct) {
            this._markNextTabAsStartupNew = true;
        }
        this.ensureActiveTab();
        this._markNextTabAsStartupNew = false;
    }

    isTabReallyEmpty(tabId) {
        const tab = this.tabManager.getAllTabs().find(t => t.id === tabId);
        if (!tab) return false;

        const chatCore = tab.controller?.chatCore;
        const hasMessages = chatCore?.hasChatStarted?.() || false;
        const hasPendingMedia = Object.keys(chatCore?.pendingMedia || {}).length > 0;
        const hasChatId = !!(chatCore?.getChatId?.() || tab.tabState?.chatId);

        const activeTab = this.getActiveTab();
        const textareaText = activeTab?.id === tabId
            ? (document.getElementById('textInput')?.value || '')
            : (this.tabTextareaContent.get(tabId) || '');
        const hasText = textareaText.trim().length > 0;

        return !hasMessages && !hasText && !hasPendingMedia && !hasChatId;
    }

    initSharedUI(chatUI) {
        // Create a special proxy for shared UI elements that:
        // - Routes subscriptions and global settings to globalState
        // - Routes per-tab toggle operations to the ACTIVE tab
        const globalState = this.stateManager;
        const getActiveTabState = () => this.tabManager.getActiveTabState();

        const perTabMethods = new Set([
            'toggleShouldThink', 'getShouldThink', 'setShouldThink',
            'toggleShouldWebSearch', 'getShouldWebSearch', 'setShouldWebSearch', 'ensureWebSearchInitialized',
            'cycleReasoningEffort', 'getReasoningEffort', 'setReasoningEffort',
            'cycleImageAspectRatio', 'getImageAspectRatio',
            'cycleImageResolution', 'getImageResolution',
            // Incognito/chat state methods
            'toggleChatState', 'isChatNormal', 'isChatIncognito', 'isChatConverted', 'resetChatState'
        ]);

        // Properties that should be read from active tab
        const perTabProperties = new Set(['shouldSave', 'chatState']);

        const sharedUIStateManager = new Proxy(globalState, {
            get(target, prop) {
                // Per-tab methods - delegate to active tab
                if (perTabMethods.has(prop)) {
                    const activeTabState = getActiveTabState();
                    if (activeTabState && prop in activeTabState) {
                        return activeTabState[prop].bind(activeTabState);
                    }
                }
                // Per-tab properties - read from active tab
                if (perTabProperties.has(prop)) {
                    const activeTabState = getActiveTabState();
                    if (activeTabState && prop in activeTabState) {
                        return activeTabState[prop];
                    }
                }
                // Everything else goes to globalState
                const value = target[prop];
                return typeof value === 'function' ? value.bind(target) : value;
            }
        });

        // Set shared proxy for shared UI - click handlers will capture this reference
        chatUI.stateManager = sharedUIStateManager;

        chatUI.initSonnetThinking();
        this.stateManager.runOnReady(() => {
            chatUI.initWebSearchToggle();
            chatUI.initImageConfigToggles();
            chatUI.initModelPicker();
        });
    }

    // ========== Accessor Methods ==========

    getActiveController() {
        return this.tabManager.getActiveController();
    }

    getActiveChatUI() {
        return this.tabManager.getActiveChatUI();
    }

    getActiveTabState() {
        return this.tabManager.getActiveTabState();
    }

    getActiveTab() {
        return this.tabManager.getActiveTab();
    }

    // ========== Event Listeners ==========

    initEventListeners() {
        auto_resize_textfield_listener('textInput');
        this.initInputListener();
        this.initArenaToggleButton();
        this.initThinkingModeButton();
        this.initFooterButtons();
        this.initTextareaImageHandling();
        this.setupMessageListeners();
        this.stateManager.subscribeToChatReset("chat", () => this.handleNewChat());
    }

    initInputListener() {
        const inputField = document.getElementById('textInput');
        inputField.addEventListener('keydown', (event) => {
            if (inputField === document.activeElement && event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                this.handleInput(inputField);
            }
        });
    }

    async handleInput() {
        const tabState = this.getActiveTabState();
        const controller = this.getActiveController();
        if (!tabState || !controller) return;

        // Check if mode is on (via proxy to global state)
        if (!this.stateManager.isOn()) return;

        if (controller.chatCore.getSystemPrompt() === undefined) {
            await this.initPrompt({ mode: "chat" });
        }
        controller.sendUserMessage();
    }

    async initPrompt(context) {
        const controller = this.getActiveController();
        if (controller) {
            await controller.initPrompt(context);
        }
    }

    continueFromCurrent(index, secondaryIndex = null, modelChoice = null) {
        const controller = this.getActiveController();
        const chatUI = this.getActiveChatUI();
        if (!controller) return;

        const options = {
            chatId: controller.chatCore.getChatId(),
            index,
            secondaryIndex,
            modelChoice,
            pendingUserMessage: controller.collectPendingUserMessage()
        };
        if (!options.chatId) {
            options.systemPrompt = controller.chatCore.getSystemPrompt();
        }
        void this.handleReconstructChat(options);
    }

    // ========== Tab Switch Handler ==========

    handleTabSwitch(newTab, oldTabId) {
        const textarea = document.getElementById('textInput');

        // Save old tab's textarea content before switching
        if (oldTabId && oldTabId !== newTab.id) {
            this.tabTextareaContent.set(oldTabId, textarea.value || '');
        }

        // Restore new tab's textarea content
        const savedContent = this.tabTextareaContent.get(newTab.id);
        textarea.value = savedContent !== undefined ? savedContent : '';
        update_textfield_height(textarea);

        // Update incognito button state
        const incognitoToggle = document.getElementById('incognito-toggle');
        if (incognitoToggle && newTab.chatUI) {
            newTab.chatUI.updateIncognitoButtonVisuals(incognitoToggle);
        }

        // Update thinking mode button (emoji button)
        const thinkingButton = document.querySelector('.thinking-mode');
        if (thinkingButton && newTab.tabState) {
            thinkingButton.classList.toggle('thinking-mode-on', newTab.tabState.pendingThinkingMode);
        }

        // Update arena mode button
        const arenaButton = document.querySelector('.arena-toggle-button');
        if (arenaButton) {
            const isArenaMode = this.stateManager.getSetting('arena_mode');
            arenaButton.textContent = isArenaMode ? '\u{2694}' : '\u{1F916}';
            arenaButton.classList.toggle('arena-mode-on', isArenaMode);
        }

        // Update sonnet thinking toggle (reason button) for this tab's state
        const sonnetThinkButton = document.getElementById('sonnet-thinking-toggle');
        if (sonnetThinkButton && newTab.tabState) {
            const model = newTab.tabState.getCurrentModel() || '';
            const hasReasoningLevels = /o\d/.test(model) || model.includes('gpt-5') ||
                (/gemini-[3-9]\.?\d*|gemini-\d{2,}/.test(model) && !(model.includes('gemini') && model.includes('image')));
            const reasoningLabel = sonnetThinkButton.querySelector('.reasoning-label');

            if (hasReasoningLevels) {
                // Reasoning-level models: always active, show effort level
                sonnetThinkButton.classList.add('active');
                if (reasoningLabel) reasoningLabel.textContent = newTab.tabState.getReasoningEffort();
            } else {
                // Other models: toggle based on shouldThink, clear label
                sonnetThinkButton.classList.toggle('active', newTab.tabState.getShouldThink());
                if (reasoningLabel) reasoningLabel.textContent = '';
            }
        }

        // Update web search toggle for this tab's state
        const webButton = document.getElementById('web-search-toggle');
        if (webButton && newTab.tabState) {
            webButton.classList.toggle('active', newTab.tabState.getShouldWebSearch());
        }

        // Update image config toggles
        const aspectBtn = document.getElementById('image-aspect-toggle');
        const resBtn = document.getElementById('image-res-toggle');
        if (aspectBtn && newTab.tabState) {
            const aspectLabel = aspectBtn.querySelector('.reasoning-label');
            if (aspectLabel) aspectLabel.textContent = newTab.tabState.getImageAspectRatio();
        }
        if (resBtn && newTab.tabState) {
            const resLabel = resBtn.querySelector('.reasoning-label');
            if (resLabel) resLabel.textContent = newTab.tabState.getImageResolution();
        }

        // Sync globalState.current_model to this tab's model
        // This triggers all subscriptions (model picker, visibility updates, etc.)
        const tabModel = newTab.tabState.getCurrentModel();
        if (tabModel && tabModel !== this.stateManager.getSetting('current_model')) {
            this.stateManager.updateSettingsLocal({ current_model: tabModel });
        }
    }

    // ========== Toggle Buttons ==========

    initArenaToggleButton() {
        const button = document.querySelector('.arena-toggle-button');

        const updateButton = () => {
            const isArenaMode = this.stateManager.getSetting('arena_mode');
            button.textContent = isArenaMode ? '\u{2694}' : '\u{1F916}';
            button.classList.toggle('arena-mode-on', isArenaMode);
        };

        this.stateManager.runOnReady(updateButton);
        this.stateManager.subscribeToSetting('arena_mode', updateButton);

        button.addEventListener('click', () => {
            this.stateManager.toggleArenaMode();
            updateButton();
        });
    }

    initThinkingModeButton() {
        const button = document.querySelector('.thinking-mode');
        button.addEventListener('click', () => {
            const tabState = this.getActiveTabState();
            if (tabState) {
                tabState.toggleThinkingMode();
                button.classList.toggle('thinking-mode-on', tabState.pendingThinkingMode);
            }
        });
    }

    // ========== Footer Buttons ==========

    initFooterButtons() {
        this.initHistoryButton();
        this.initSettingsButton();
        this.initIncognitoToggle();
        this.initPopoutToggle();
    }

    initHistoryButton() {
        document.getElementById('history-button').addEventListener('click', () => {
            chrome.tabs.create({ url: chrome.runtime.getURL('src/html/history.html') });
        });
    }

    initSettingsButton() {
        document.getElementById('settings-button').addEventListener('click', () => {
            chrome.runtime.openOptionsPage();
        });
    }

    initIncognitoToggle() {
        const buttonFooter = document.getElementById('sidepanel-button-footer');
        const incognitoToggle = document.getElementById('incognito-toggle');
        const hoverText = buttonFooter.querySelectorAll('.hover-text');

        const hasChatStarted = () => {
            const controller = this.getActiveController();
            return controller ? controller.chatCore.hasChatStarted() : false;
        };

        const chatUI = this.getActiveChatUI();
        if (chatUI) {
            chatUI.setupIncognitoButtonHandlers(incognitoToggle, buttonFooter, hoverText, hasChatStarted);
            chatUI.updateIncognitoButtonVisuals(incognitoToggle);
        }
    }

    initPopoutToggle() {
        const button = document.getElementById('pop-out-toggle');
        button.addEventListener('click', async () => {
            await this.handlePopoutToggle();
        });
    }

    // ========== Message Listeners ==========

    setupMessageListeners() {
        chrome.runtime.onMessage.addListener((msg) => {
            switch (msg.type) {
                case 'chat_renamed':
                    this.handleChatRenamed(msg.chatId, msg.title);
                    return;
            }

            if (!this.stateManager.isOn()) return;

            switch (msg.type) {
                case 'new_selection':
                    this.handleNewSelection(msg.text, msg.url);
                    break;
                case 'new_chat':
                    this.handleNewChat();
                    break;
                case 'reconstruct_chat':
                    this.handleReconstructChat(msg.options);
                    break;
            }
        });
    }

    handleChatRenamed(chatId, title) {
        const tab = this.tabManager.findTabByChatId(chatId);
        if (tab) {
            tab.controller.chatCore.miscUpdate({ title });
            this.tabManager.updateTabTitle(tab.id, title);
        }
    }

    async handleNewSelection(text, url) {
        this.ensureActiveTab();

        // Create new tab unless current is empty
        if (!this.tabManager.isCurrentTabEmpty()) {
            const newTab = this.tabManager.createTab({
                continueFunc: (index, secondaryIndex, modelChoice) =>
                    this.continueFromCurrent(index, secondaryIndex, modelChoice)
            });
            if (!newTab) {
                this.getActiveChatUI()?.addErrorMessage("Maximum tabs reached. Close a tab first.");
                return;
            }
        }

        const controller = this.getActiveController();
        const chatUI = this.getActiveChatUI();
        const tabState = this.getActiveTabState();
        if (!controller || !chatUI) return;

        if (tabState) tabState.chatId = null;

        this.stateManager.subscribeToChatReset("chat", () => this.handleNewSelection(text, url));
        const hostname = new URL(url).hostname;
        controller.initStates(`Selection from ${hostname}`);
        chatUI.clearConversation();
        chatUI.addSystemMessage(text, `Selected Text - site:${hostname}`);

        // Update tab title
        const tab = this.getActiveTab();
        if (tab) {
            this.tabManager.updateTabTitle(tab.id, `Selection from ${hostname}`);
        }

        await this.initPrompt({ mode: "selection", text, url });

        if (this.stateManager.isInstantPromptMode()) {
            controller.chatCore.addUserMessage("Please explain!");
            controller.initApiCall();
        }
    }

    handleNewChat() {
        this.ensureActiveTab();

        // Create new tab only if current tab has content
        if (!this.tabManager.isCurrentTabEmpty()) {
            const newTab = this.tabManager.createTab({
                continueFunc: (index, secondaryIndex, modelChoice) =>
                    this.continueFromCurrent(index, secondaryIndex, modelChoice)
            });
            if (!newTab) {
                this.getActiveChatUI()?.addErrorMessage("Maximum tabs reached. Close a tab first.");
                return;
            }
        }

        const controller = this.getActiveController();
        const chatUI = this.getActiveChatUI();
        const tabState = this.getActiveTabState();
        if (!controller || !chatUI || !tabState) return;

        this.stateManager.subscribeToChatReset("chat", () => this.handleNewChat());
        tabState.chatId = null;
        controller.initStates("New Chat");
        chatUI.clearConversation();

        if (this.stateManager.isInstantPromptMode()) {
            chatUI.addWarningMessage("Warning: Instant prompt mode does not make sense in chat mode and will be ignored.");
        }
        this.initPrompt({ mode: "chat" });
    }

    async handleReconstructChat(options) {
        this.openedForReconstruct = true;
        this.ensureActiveTab();

        if (options?.chatId) {
            const existing = this.tabManager.findTabByChatId(options.chatId);
            if (existing) {
                // Tab already open with this chat - just switch to it
                const maybeCloseStartupNewTab =
                    this.startupNewTabId &&
                    this.startupNewTabId !== existing.id &&
                    Date.now() - this.startupAt < 2000 &&
                    this.isTabReallyEmpty(this.startupNewTabId);

                this.tabManager.switchTab(existing.id);

                if (maybeCloseStartupNewTab) {
                    this.tabManager.closeTab(this.startupNewTabId);
                    this.startupNewTabId = null;
                }
                return; // Don't rebuild - tab already has the chat loaded
            }
            if (!this.tabManager.isCurrentTabEmpty()) {
                const newTab = this.tabManager.createTab({
                    continueFunc: (index, secondaryIndex, modelChoice) =>
                        this.continueFromCurrent(index, secondaryIndex, modelChoice)
                });
                if (!newTab) {
                    this.getActiveChatUI()?.addErrorMessage("Maximum tabs reached. Close a tab first.");
                    return;
                }
            }
        } else {
            // Create new tab unless current is empty
            if (!this.tabManager.isCurrentTabEmpty()) {
                const newTab = this.tabManager.createTab({
                    continueFunc: (index, secondaryIndex, modelChoice) =>
                        this.continueFromCurrent(index, secondaryIndex, modelChoice)
                });
                if (!newTab) {
                    this.getActiveChatUI()?.addErrorMessage("Maximum tabs reached. Close a tab first.");
                    return;
                }
            }
        }

        const controller = this.getActiveController();
        const chatUI = this.getActiveChatUI();
        const tabState = this.getActiveTabState();
        const tab = this.getActiveTab();
        if (!controller || !chatUI || !tabState) return;

        const newChatName = options.chatId ? "Continued Chat" : "New Chat";
        if (!options.chatId) tabState.chatId = null;
        controller.initStates(newChatName);
        tabState.isSidePanel = options.isSidePanel === false ? false : true;

        if (!options.chatId && !options.pendingUserMessage) {
            if (options.systemPrompt) controller.chatCore.insertSystemMessage(options.systemPrompt);
            chatUI.clearConversation();
            return;
        }

        let lastMessage = null;
        if (options.chatId) {
            const normalizedChatId = Number(options.chatId);
            if (!Number.isFinite(normalizedChatId)) {
                chatUI?.addErrorMessage("Invalid chat ID");
                return;
            }

            const messageLimit = options.index !== undefined ? options.index + 1 : null;
            let chat;
            try {
                chat = await this.chatStorage.loadChat(normalizedChatId, messageLimit);
            } catch (e) {
                console.warn('Failed to load chat:', e);
                chatUI?.addErrorMessage("Failed to load chat");
                return;
            }
            if (!chat?.messages) {
                chatUI?.addErrorMessage("Chat not found");
                return;
            }
            const fullChatLength = await this.chatStorage.getChatLength(normalizedChatId);
            lastMessage = chat.messages.at(-1);
            const secondaryLength = lastMessage?.contents
                ? lastMessage.contents.length
                : lastMessage?.responses[options.modelChoice || 'model_a']?.messages?.length;

            controller.chatCore.buildFromDB(chat, null, options.secondaryIndex, options.modelChoice);
            chatUI.updateIncognito(controller.chatCore.hasChatStarted());
            chatUI.buildChat(controller.chatCore.getChat());
            if (tab?.container) {
                requestAnimationFrame(() => {
                    tab.container.scrollTop = tab.container.scrollHeight;
                });
            }

            const continueOptions = {
                fullChatLength,
                lastMessage,
                index: options.index,
                modelChoice: options.modelChoice,
                secondaryIndex: options.secondaryIndex,
                secondaryLength
            };
            controller.chatCore.continuedChatOptions = continueOptions;

            // Update tab title
            if (tab && chat.title) {
                this.tabManager.updateTabTitle(tab.id, chat.title);
            }

            // Store chatId in tabState for persistence
            tabState.chatId = normalizedChatId;
            this.tabManager.schedulePersist();
        }

        if (options.systemPrompt) controller.chatCore.insertSystemMessage(options.systemPrompt);

        if (lastMessage?.role !== "user") lastMessage = options.pendingUserMessage;
        this.handleIfLastUserMessage(lastMessage || options.pendingUserMessage);

        const latest = controller.chatCore.getLatestMessage();
        if (latest?.role === 'assistant' && !latest.responses) {
            const latestPart = latest.contents?.at(-1)?.at(-1);
            const model = latestPart?.model || this.stateManager.getSetting('current_model');
            chatUI.addRegenerateFooterToLastMessage(() => controller.regenerateResponse(model));
        }
    }

    handleIfLastUserMessage(lastMessage) {
        const controller = this.getActiveController();
        const chatUI = this.getActiveChatUI();
        if (!controller || !chatUI) return;

        if (lastMessage && lastMessage.role === "user") {
            if (lastMessage.images) controller.appendPendingMedia(lastMessage.images, 'image');
            if (lastMessage.files) controller.appendPendingMedia(lastMessage.files, 'file');
            if (lastMessage.contents) chatUI.setTextareaText(lastMessage.contents.at(-1).at(-1).content);
        } else {
            chatUI.setTextareaText('');
        }
    }

    // ========== Popout Handling ==========

    async handlePopoutToggle() {
        const controller = this.getActiveController();
        const tabState = this.getActiveTabState();
        const chatUI = this.getActiveChatUI();
        if (!controller || !tabState) return;

        // Warn if tabs would be lost
        const tabCount = this.tabManager.getTabCount();
        if (tabCount > 1) {
            const persistenceEnabled = this.stateManager.getSetting('persist_tabs') !== false;
            if (!persistenceEnabled) {
                chatUI?.addErrorMessage("Close other tabs before popping out (they would be lost).");
                return;
            }
            // Even with persistence, unsaved tabs (no chatId) will be lost
            const currentTabId = this.getActiveTab()?.id;
            const unsavedCount = this.tabManager.getAllTabs()
                .filter(t => t.id !== currentTabId && !this.tabManager.getTabChatId(t)).length;
            if (unsavedCount > 0) {
                chatUI?.addErrorMessage(`Close ${unsavedCount} unsaved tab(s) before popping out (drafts aren't persisted).`);
                return;
            }
        }

        const index = Math.max(controller.chatCore.getLength() - 1, 0);
        const options = {
            chatId: controller.chatCore.getChatId(),
            isSidePanel: !tabState.isSidePanel,
            index,
            pendingUserMessage: controller.collectPendingUserMessage()
        };

        const latestMessage = controller.chatCore.getLatestMessage();
        if (latestMessage?.responses) {
            const modelChoice = latestMessage.continued_with && latestMessage.continued_with !== "none"
                ? latestMessage.continued_with
                : 'model_a';
            options.secondaryIndex = latestMessage.responses[modelChoice].messages.length - 1;
            options.modelChoice = modelChoice;
        }
        if (latestMessage?.role === 'assistant') {
            options.secondaryIndex = latestMessage.contents.length - 1;
        }
        if (!options.chatId) {
            options.systemPrompt = controller.chatCore.getSystemPrompt();
        }

        if (tabState.isSidePanel) {
            await this.handleSidepanelToTab(options);
        } else {
            await this.handleTabToSidepanel(options);
        }
    }

    async handleSidepanelToTab(options) {
        chrome.tabs.create({
            url: chrome.runtime.getURL('src/html/sidepanel.html')
        });

        await new Promise(resolve => {
            chrome.runtime.onMessage.addListener(function listener(message) {
                if (message.type === "sidepanel_ready") {
                    chrome.runtime.onMessage.removeListener(listener);
                    resolve();
                }
            });
        });

        chrome.runtime.sendMessage({
            type: "reconstruct_chat",
            options: options
        });

        window.close();
    }

    async handleTabToSidepanel(options) {
        const [tabCount, { isOpen }] = await Promise.all([
            chrome.tabs.query({ windowId: chrome.windows.WINDOW_ID_CURRENT }).then(tabs => tabs.length),
            chrome.runtime.sendMessage({ type: "is_sidepanel_open" })
        ]);

        if (!isOpen) {
            await chrome.runtime.sendMessage({ type: "open_side_panel" });
        }

        await chrome.runtime.sendMessage({
            type: "reconstruct_chat",
            options: options
        });

        if (tabCount === 1) {
            await chrome.tabs.create({ url: 'chrome://newtab' });
        }
        window.close();
    }

    // ========== Media Handling ==========

    initTextareaImageHandling() {
        const textarea = document.getElementById('textInput');
        this.setupDragAndDropListeners(textarea);
        this.setupPasteListener(textarea);
        this.setupDropListener(textarea);
    }

    setupDragAndDropListeners(textarea) {
        ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
            textarea.addEventListener(eventName, e => {
                e.preventDefault();
                e.stopPropagation();
                textarea.classList.toggle('dragging',
                    eventName === 'dragover' || eventName === 'dragenter');
            }, false);
        });
    }

    setupPasteListener(textarea) {
        textarea.addEventListener('paste', async (e) => {
            const items = Array.from(e.clipboardData.items);

            const files = items
                .filter(item => item.kind === 'file')
                .map(item => item.getAsFile())
                .filter(file => file !== null);

            if (files.length > 0) {
                e.preventDefault();
                this.handleFilesDrop(files);
            }
        });
    }

    setupDropListener(textarea) {
        textarea.addEventListener('drop', async (e) => {
            if (e.dataTransfer.files.length > 0) {
                await this.handleFilesDrop(e.dataTransfer.files);
                return;
            }

            const imgSrc = this.getImageSourceFromDrop(e);
            if (imgSrc) {
                const base64String = await this.urlToBase64(imgSrc);
                if (base64String) {
                    const controller = this.getActiveController();
                    if (controller) {
                        controller.appendPendingMedia([base64String], 'image');
                    }
                    return;
                }
            }

            this.handleTextDrop(e, textarea);
        });
    }

    async handleFilesDrop(files) {
        for (const file of files) {
            if (file.type.match('image.*')) {
                await this.handleImageFile(file);
            } else if (!file.type.match('video.*')) {
                await this.handleTextFile(file);
            }
        }
    }

    handleImageFile(file) {
        return new Promise(resolve => {
            const reader = new FileReader();
            reader.onload = e => {
                const controller = this.getActiveController();
                if (controller) {
                    controller.appendPendingMedia([e.target.result], 'image');
                }
                resolve();
            };
            reader.readAsDataURL(file);
        });
    }

    handleTextFile(file) {
        return new Promise(resolve => {
            const reader = new FileReader();
            reader.onload = e => {
                const controller = this.getActiveController();
                if (controller) {
                    controller.appendPendingMedia([{ name: file.name, content: e.target.result }], 'file');
                }
                resolve();
            };
            reader.onerror = error => {
                const chatUI = this.getActiveChatUI();
                if (chatUI) {
                    const uiMessage = this.apiManager.getUiErrorMessage(error);
                    chatUI.addErrorMessage(uiMessage);
                }
                resolve();
            };
            reader.readAsText(file);
        });
    }

    getImageSourceFromDrop(e) {
        const html = e.dataTransfer.getData('text/html');
        if (!html) return null;

        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');
        return doc.querySelector('img')?.src;
    }

    async urlToBase64(url) {
        const MAX_BYTES = 20_000_000;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 8000);
        try {
            const response = await fetch(url, { signal: controller.signal });
            clearTimeout(timeoutId);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);

            const headerLength = Number(response.headers.get('content-length'));
            if (Number.isFinite(headerLength) && headerLength > MAX_BYTES) {
                throw new Error('image too large');
            }

            const blob = await response.blob();
            if (blob.size > MAX_BYTES) throw new Error('image too large');

            return await new Promise(resolve => {
                const reader = new FileReader();
                reader.onload = e => resolve(e.target.result);
                reader.readAsDataURL(blob);
            });
        } catch (error) {
            const chatUI = this.getActiveChatUI();
            if (chatUI) {
                const message = error.name === 'AbortError'
                    ? 'Image fetch timed out'
                    : `Error converting image to base64: ${error.message}`;
                chatUI.addErrorMessage(message);
            }
            return null;
        } finally {
            clearTimeout(timeoutId);
        }
    }

    handleTextDrop(e, textarea) {
        const text = e.dataTransfer.getData('text');
        if (text) {
            const start = textarea.selectionStart;
            const value = textarea.value.slice(0, start) +
                           text +
                           textarea.value.slice(textarea.selectionEnd);
            const chatUI = this.getActiveChatUI();
            if (chatUI) {
                chatUI.setTextareaText(value);
            }
        }
    }
}


// Initialize the application when the DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    new SidepanelApp();
    chrome.runtime.sendMessage({ type: "sidepanel_ready" });
});
