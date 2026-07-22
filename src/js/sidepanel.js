import { autoResizeTextfieldListener, updateTextfieldHeight } from "./ui_utils.js";
import { ApiManager } from "./api_manager.js";
import { ChatStorage } from './chat_storage.js';
import { SidepanelStateManager } from './state_manager.js';
import { TabManager } from './tab_manager.js';
import { SidepanelChatUI } from './chat_ui.js';
import { DragDropManager } from './drag_drop_manager.js';
import { VoiceManager } from './voice_manager.js';
import { createStateProxy } from './state_proxy.js';
import { openSidePanelWithHandoff } from './sidepanel_handoff.js';

// Configuration constants
const STARTUP_WINDOW_MS = 2000;  // Time window to consider closing empty startup tabs
const NEW_TAB_URL = 'chrome://newtab';
const POPOUT_READY_TIMEOUT_MS = 5000;
const CONTINUATION_RENDER_TAIL_MESSAGES = 80;
const HANDOFF_TYPES = new Set(['new_selection', 'new_chat', 'reconstruct_chat']);

// Arena and Council mode toggle icons
const ICON = {
    ARENA: '\u{2694}',       // ⚔️ Crossed swords - arena mode enabled
    CHAT: '\u{1F916}',       // 🤖 Robot - normal chat mode
    COUNCIL_OFF: '\u{2726}', // ✦ Black Four Pointed Star - council mode disabled
    COUNCIL_ON: '\u{2042}'   // ⁂ Asterism - council mode enabled
};

export function waitForCreatedTabReceiver(createTab, expectedUrl, timeoutMs = POPOUT_READY_TIMEOUT_MS) {
    let targetTabId = null;
    let settled = false;
    let timedOut = false;
    let timeoutId;
    let orphanClosed = false;
    const readyTabs = new Map();

    return new Promise((resolve, reject) => {
        const closeOrphan = tabId => {
            if (orphanClosed || !Number.isInteger(tabId)) return;
            orphanClosed = true;
            try {
                Promise.resolve(chrome.tabs.remove(tabId)).catch(() => {});
            } catch {}
        };
        const cleanup = () => {
            chrome.runtime.onMessage.removeListener(listener);
            clearTimeout(timeoutId);
        };
        const finish = (callback) => {
            if (settled) return;
            settled = true;
            cleanup();
            callback();
        };
        const listener = (message, sender) => {
            const tabId = sender?.tab?.id;
            if (
                message.type !== 'sidepanel_ready'
                || sender?.url !== expectedUrl
                || !Number.isInteger(tabId)
                || typeof message.receiverToken !== 'string'
                || message.receiverToken.length < 32
            ) return;
            readyTabs.set(tabId, message.receiverToken);
            if (tabId === targetTabId) {
                finish(() => resolve({ tab: sender.tab, receiverToken: message.receiverToken }));
            }
        };

        chrome.runtime.onMessage.addListener(listener);
        timeoutId = setTimeout(() => {
            timedOut = true;
            closeOrphan(targetTabId);
            finish(() => reject(new Error('Popped-out chat did not become ready')));
        }, timeoutMs);

        let createRequest;
        try {
            createRequest = createTab();
        } catch (error) {
            finish(() => reject(error));
            return;
        }

        Promise.resolve(createRequest).then(tab => {
            if (settled) {
                if (timedOut) closeOrphan(tab?.id);
                return;
            }
            if (!Number.isInteger(tab?.id)) {
                finish(() => reject(new Error('Popped-out chat tab was not created')));
                return;
            }
            targetTabId = tab.id;
            const receiverToken = readyTabs.get(targetTabId);
            if (receiverToken) finish(() => resolve({ tab, receiverToken }));
        }, error => finish(() => reject(error)));
    });
}

export class SidepanelApp {
    constructor() {
        this.stateManager = new SidepanelStateManager('chat_prompt');
        this.apiManager = new ApiManager({ settingsManager: this.stateManager });
        this.stateManager.apiManager = this.apiManager;
        this.chatStorage = new ChatStorage();

        // Per-tab textarea content storage
        this.tabTextareaContent = new Map();
        this.sharedUIInitialized = false;
        this.openedForReconstruct = false;
        this.deferRestoredTabSwitchLoads = false;
        this.restoredTabLoadTimers = new Map();
        this.pageContextRequests = new Map();
        this.startupAt = Date.now();
        this.startupNewTabId = null;
        this.hostContextReady = false;
        this.hostWindowId = null;
        this.hostTabId = null;
        this.receiverToken = crypto.randomUUID();
        this.receiverReady = false;
        this.popoutTransferPromise = null;

        // Cached DOM elements (reduces repeated queries)
        this.textInput = document.getElementById('textInput');
        this.incognitoToggle = document.getElementById('incognito-toggle');

        // Initialize TabManager
        this.tabManager = new TabManager({
            globalState: this.stateManager,
            apiManager: this.apiManager,
            chatStorage: this.chatStorage,
            tabBarContainer: document.getElementById('tab-bar-container'),
            tabContentContainer: document.getElementById('tab-content-area'),
            onTabSwitch: (newTab, oldTabId) => this.handleTabSwitch(newTab, oldTabId),
            onTabClose: (tabId) => this.handleTabClose(tabId),
            onTabStateReconciled: tabState => this.updateHeaderControls(tabState),
            onNewTabRequested: () => { void this.handleNewChat({ forceNewTab: true }); }
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
        this.stateManager.subscribeToSetting('auto_page_context', (enabled) => {
            if (enabled) {
                void this.attachPageContextToTab(this.getActiveTab()?.id);
            }
        });
        this.initManagers();
        this.initEventListeners();

        this.readyPromise = new Promise(resolve => {
            this.stateManager.runOnReady(() => {
                void this.bootstrapTabs().finally(resolve);
            });
        });
    }

    initManagers() {
        this.voiceManager = new VoiceManager(this.apiManager, this.stateManager, {
            getActiveTabId: () => this.getActiveTab()?.id,
            onTranscript: (id, text) => this.applyTranscription(id, text),
            onError: (msg) => this.getActiveChatUI()?.addErrorMessage(msg)
        });
    }

    ensureSharedUIInitialized() {
        if (this.sharedUIInitialized) return;
        if (this.getActiveChatUI()) {
            this.initSharedUI();
            this.sharedUIInitialized = true;
        }
    }

    ensureActiveTab() {
        if (this.getActiveController()) return;
        const tabs = this.tabManager.getAllTabs();
        if (tabs.length > 0) {
            this.tabManager.switchTab(tabs[0].id);
            this.ensureSharedUIInitialized();
            return;
        }
    }

    async bootstrapTabs() {
        await this.tabManager.restorePersistedTabs();
        // Wait for next frame to ensure UI/state is stable
        await new Promise(resolve => requestAnimationFrame(resolve));

        if (this.tabManager.getAllTabs().length > 0) {
            this.deferRestoredTabSwitchLoads = true;
            try {
                this.ensureActiveTab();
            } finally {
                this.deferRestoredTabSwitchLoads = false;
            }
            this.scheduleRestoredTabLoad(this.getActiveTab()?.id);
            return;
        }

        const tab = this.tabManager.createTab({
            continueFunc: (i, s, m) => this.continueFromCurrent(i, s, m)
        });

        if (!tab) return;
        if (this.startupNewTabId == null && !this.openedForReconstruct) {
            this.startupNewTabId = tab.id;
        }

        this.ensureSharedUIInitialized();
        await this.initializeFreshChatTab(tab.id, { loadPrompt: false });
    }

    async attachPageContextToTab(tabId, webpageContext = undefined) {
        if (!tabId) return;

        const tab = this.tabManager.getTab(tabId);
        if (!tab?.controller) return;
        const requestToken = Symbol('page-context-request');
        this.pageContextRequests.set(tabId, requestToken);

        try {
            if (tab.reconstruction !== null) {
                const ready = await this.ensureTabReady(tabId);
                if (!ready) return;
            }

            await tab.controller.maybeAttachCurrentPageContext(
                'chat',
                webpageContext,
                () => this.canApplyPageContext(tabId, tab, requestToken)
            );
        } finally {
            if (this.pageContextRequests.get(tabId) === requestToken) {
                this.pageContextRequests.delete(tabId);
            }
        }
    }

    canApplyPageContext(tabId, tab, requestToken) {
        if (
            this.pageContextRequests.get(tabId) !== requestToken
            || this.tabManager.getTab(tabId) !== tab
            || tab.reconstruction !== null
        ) return false;

        const chatCore = tab.controller.chatCore;
        const currentText = this.getActiveTab()?.id === tabId
            ? this.textInput?.value
            : this.tabTextareaContent.get(tabId);
        const hasTypedText = !!currentText?.trim();
        const hasPendingMedia = Object.keys(chatCore.pendingMedia || {}).length > 0;
        const hasStarted = chatCore.hasChatStarted();
        const hasContext = chatCore.hasWebpageContext();

        if (hasTypedText || hasPendingMedia || hasStarted || hasContext) {
            return false;
        }
        return true;
    }

    cancelPageContextRequest(tabId) {
        this.pageContextRequests.delete(tabId);
    }

    async initializeFreshChatTab(tabId, options = {}) {
        const tab = this.tabManager.getTab(tabId);
        if (!tab) return false;

        const { controller, chatUI, tabState } = tab;
        if (!controller || !chatUI || !tabState) return false;

        this.cancelPageContextRequest(tab.id);
        const title = options.title || 'New Chat';
        tabState.chatId = null;
        controller.initStates(title);
        chatUI.clearConversation();
        this.tabManager.updateTabTitle(tab.id, title);

        if (options.attachPageContext !== false) {
            void this.attachPageContextToTab(tab.id);
        }

        if (options.loadPrompt) {
            await controller.initPrompt({ mode: 'chat' });
        }

        return true;
    }

    updateInputReconstructionState(tab = this.getActiveTab()) {
        if (this.textInput) {
            this.textInput.disabled = tab?.reconstruction?.status === 'loading';
        }
    }

    setTabDraft(tabId, text) {
        const value = text || '';
        this.tabTextareaContent.set(tabId, value);
        if (this.getActiveTab()?.id !== tabId || !this.textInput) return;

        this.textInput.value = value;
        updateTextfieldHeight(this.textInput);
    }

    ensureTabReady(tabId) {
        this.cancelRestoredTabLoad(tabId);
        const tab = this.tabManager.getTab(tabId);
        if (!tab) return false;
        if (tab.reconstruction === null) return true;
        if (tab.reconstruction.status === 'loading') return tab.reconstruction.promise;

        const options = tab.reconstruction.options;
        const operation = { status: 'loading', options, promise: null };
        tab.reconstruction = operation;
        if (this.getActiveTab()?.id === tabId) this.updateInputReconstructionState(tab);

        operation.promise = this.runReconstruction(tab, operation);
        return operation.promise;
    }

    async runReconstruction(tab, operation) {
        try {
            const prepared = await this.prepareReconstruction(operation.options);
            if (this.tabManager.getTab(tab.id) !== tab || tab.reconstruction !== operation) return false;

            const committed = await this.commitReconstruction(tab, prepared, operation);
            if (committed === false || this.tabManager.getTab(tab.id) !== tab || tab.reconstruction !== operation) return false;
            tab.reconstruction = null;
            if (this.getActiveTab()?.id === tab.id) this.updateInputReconstructionState(tab);
            return true;
        } catch (error) {
            if (this.tabManager.getTab(tab.id) !== tab || tab.reconstruction !== operation) return false;

            console.warn('Failed to reconstruct tab:', error);
            tab.reconstruction = { status: 'pending', options: operation.options };
            tab.chatUI.addErrorMessage(error?.userMessage || 'Failed to load chat');
            if (this.getActiveTab()?.id === tab.id) this.updateInputReconstructionState(tab);
            return false;
        }
    }

    async prepareReconstruction(options) {
        if (!options.chatId) return { options, chat: null, fullChatLength: null };

        const chatId = Number(options.chatId);
        if (!Number.isFinite(chatId)) {
            const error = new Error('Invalid chat ID');
            error.userMessage = 'Invalid chat ID';
            throw error;
        }

        const isContinuation = options.index !== undefined;
        const [chat, fullChatLength] = await Promise.all([
            this.chatStorage.loadChat(chatId, isContinuation ? options.index + 1 : null),
            isContinuation ? this.chatStorage.getChatLength(chatId) : null
        ]);
        if (!chat?.messages) {
            const error = new Error(`Chat ${chatId} not found`);
            error.userMessage = 'Chat not found';
            throw error;
        }

        const selectedMessage = chat.messages.at(-1) || null;
        const secondaryLength = selectedMessage?.contents
            ? selectedMessage.contents.length
            : selectedMessage?.responses?.[options.modelChoice || 'model_a']?.messages?.length;

        return { options, chatId, chat, fullChatLength, selectedMessage, secondaryLength, isContinuation };
    }

    async getReadyActiveTab() {
        const tab = this.getActiveTab();
        if (!tab || !await this.ensureTabReady(tab.id)) return null;
        return this.getActiveTab() === tab && this.tabManager.getTab(tab.id) === tab ? tab : null;
    }

    scheduleRestoredTabLoad(tabId, options = {}) {
        if (tabId == null) return;

        const run = () => {
            this.restoredTabLoadTimers.delete(tabId);
            const tab = this.tabManager.getTab(tabId);
            if (!tab || !tab.reconstruction) return;

            void this.ensureTabReady(tab.id);
        };

        if (options.immediate) {
            this.cancelRestoredTabLoad(tabId);
            run();
            return;
        }

        if (this.restoredTabLoadTimers.has(tabId)) return;

        if (window.requestIdleCallback) {
            const id = window.requestIdleCallback(run, { timeout: 500 });
            this.restoredTabLoadTimers.set(tabId, { type: 'idle', id });
        } else {
            const id = setTimeout(run, 100);
            this.restoredTabLoadTimers.set(tabId, { type: 'timeout', id });
        }
    }

    cancelRestoredTabLoad(tabId) {
        const timer = this.restoredTabLoadTimers.get(tabId);
        if (!timer) return;

        if (timer.type === 'idle') window.cancelIdleCallback?.(timer.id);
        else clearTimeout(timer.id);
        this.restoredTabLoadTimers.delete(tabId);
    }

    getContinuationRenderChat(chat) {
        const messages = chat?.messages || [];
        if (messages.length <= CONTINUATION_RENDER_TAIL_MESSAGES) {
            return { chat, indexOffset: 0 };
        }

        let indexOffset = messages.length - CONTINUATION_RENDER_TAIL_MESSAGES;
        while (indexOffset > 0 && messages[indexOffset]?.role === 'assistant' && messages[indexOffset - 1]?.role === 'assistant') {
            indexOffset--;
        }
        return {
            chat: { ...chat, messages: messages.slice(indexOffset) },
            indexOffset
        };
    }

    isTabReallyEmpty(tabId) {
        const tabs = this.tabManager.getAllTabs();
        const tab = tabs.find(t => t.id === tabId);
        
        if (!tab) {
            return false;
        }
        if (tab.reconstruction !== null) return false;

        const controller = tab.controller;
        const chatCore = controller?.chatCore;
        
        // Get content from active input or stored content
        const isActiveTab = this.getActiveTab()?.id === tabId;
        const currentText = isActiveTab ? this.textInput?.value : this.tabTextareaContent.get(tabId);
        const trimmedText = currentText || '';

        const hasStarted = chatCore?.hasChatStarted();
        const hasPendingMedia = Object.keys(chatCore?.pendingMedia || {}).length > 0;
        const hasChatId = chatCore?.getChatId() || tab.tabState?.chatId;
        const hasInputText = trimmedText.trim().length > 0;

        return !(hasStarted || hasPendingMedia || hasChatId || hasInputText);
    }

    initSharedUI() {
        // Dummy state to handle cases when no tab is active
        const dummyTabState = {
            isArenaModeActive: false,
            getShouldThink: () => false,
            getShouldWebSearch: () => false,
            getReasoningEffort: () => 'medium',
            getReasoningMode: () => 'standard',
            getImageAspectRatio: () => 'auto',
            getImageResolution: () => '2K',
            getCurrentModel: () => this.stateManager.getSetting('current_model'),
            isThinking: () => false,
            isSolving: () => false,
            isInactive: () => true,
            getArenaModel: () => null,
            getArenaModelKey: () => 'model_a',
            getArenaModels: () => [],
        };

        const sharedState = createStateProxy(() => this.getActiveTabState(), this.stateManager, dummyTabState);

        // Configure shared UI instance by properly calling the constructor
        const ui = new SidepanelChatUI({
            stateManager: sharedState,
            textarea: this.textInput,
            // Shared UI uses the main conversation wrapper but should ideally not be used for messaging
            conversationWrapperId: 'tab-content-area'
        });

        ui.initSonnetThinking();
        
        this.stateManager.runOnReady(() => { 
            ui.initWebSearchToggle(); 
            ui.initImageConfigToggles(); 
            ui.initModelPicker(); 
        });

        const footer = document.getElementById('sidepanel-button-footer');
        const toggle = document.getElementById('incognito-toggle');
        
        if (footer && toggle) {
            const getChatStartedStatus = () => {
                return this.getActiveController()?.chatCore?.hasChatStarted() ?? false;
            };

            ui.setupIncognitoButtonHandlers(
                toggle, 
                footer, 
                footer.querySelectorAll('.hover-text'), 
                getChatStartedStatus
            );
            
            ui.updateIncognitoButtonVisuals(toggle);
        }
    }

    // ========== Accessor Methods ========== 

    getActiveController() { return this.tabManager.getActiveController(); }
    getActiveChatUI() { return this.tabManager.getActiveChatUI(); }
    getActiveTabState() { return this.tabManager.getActiveTabState(); }
    getActiveTab() { return this.tabManager.getActiveTab(); }

    createTabIfNeeded() {
        if (this.tabManager.isCurrentTabEmpty()) return true;
        const tab = this.tabManager.createTab({ 
            continueFunc: (i, s, m) => this.continueFromCurrent(i, s, m) 
        });
        if (!tab) this.getActiveChatUI()?.addErrorMessage("Maximum tabs reached. Close a tab first.");
        return !!tab;
    }

    // ========== Event Listeners ========== 

    initEventListeners() {
        autoResizeTextfieldListener('textInput');
        this.textInput.onkeydown = e => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.handleInput(); }
        };
        this.initArenaToggleButton();
        this.initThinkingModeButton();
        this.initFooterButtons();
        this.initTextareaImageHandling();
        this.setupMessageListeners();
        this.stateManager.subscribeToChatReset("chat", () => this.handleNewChat());
    }

    async handleInput() {
        if (!this.stateManager.isOn()) return;

        const activeTab = await this.getReadyActiveTab();
        if (!activeTab) return;

        const { controller: activeController, tabState: activeTabState } = activeTab;
        if (!activeTabState || !activeController) return;
        
        await activeController.awaitPromptReady();

        if (activeController.chatCore.getSystemPrompt() === undefined) {
            await activeController.initPrompt({ mode: "chat" });
        }

        const currentTab = this.getActiveTab();
        if (currentTab?.id !== activeTab.id || currentTab.controller !== activeController) return;
        activeController.sendUserMessage();
    }

    async continueFromCurrent(index, secondaryIndex = null, modelChoice = null) {
        const activeTab = await this.getReadyActiveTab();
        if (!activeTab) return;

        const activeController = activeTab.controller;

        const reconstructOptions = {
            chatId: activeController.chatCore.getChatId(),
            index,
            secondaryIndex,
            modelChoice,
            pendingUserMessage: activeController.collectPendingUserMessage(),
            webpageContext: activeController.chatCore.getWebpageContext(),
            webpageContextDismissed: activeController.chatCore.isWebpageContextDismissed()
        };
        
        if (!reconstructOptions.chatId) {
            reconstructOptions.systemPrompt = activeController.chatCore.getSystemPrompt();
        }
        
        return this.handleReconstructChat(reconstructOptions);
    }

    // ========== Tab Switch Handler ========== 

    handleTabSwitch(activeTab, oldTabId) {
        if (oldTabId && oldTabId !== activeTab.id) {
            this.tabTextareaContent.set(oldTabId, this.textInput.value || '');
            this.voiceManager.handleTabSwitch(activeTab.id, oldTabId);
        }

        this.textInput.value = this.tabTextareaContent.get(activeTab.id) || '';
        updateTextfieldHeight(this.textInput);

        if (activeTab.chatUI) {
            activeTab.chatUI.updateIncognitoButtonVisuals(this.incognitoToggle);
        }
        this.updateInputReconstructionState(activeTab);
        if (!this.deferRestoredTabSwitchLoads) {
            this.scheduleRestoredTabLoad(activeTab.id, { immediate: true });
        }
        
        if (activeTab.tabState) {
            this.updateHeaderControls(activeTab.tabState);
            const currentModelId = activeTab.tabState.getCurrentModel();
            if (currentModelId) {
                this.stateManager.updateSettingsLocal({ current_model: currentModelId });
            }
        }
    }

    updateHeaderControls(tabState) {
        const thinkingModeButton = document.querySelector('.thinking-mode');
        if (thinkingModeButton) {
            thinkingModeButton.classList.toggle('thinking-mode-on', tabState?.pendingThinkingMode);
        }
        
        const arenaToggleButton = document.querySelector('.arena-toggle-button--arena');
        if (arenaToggleButton) {
            const isArenaModeActive = tabState?.isArenaModeActive ?? this.stateManager.getSetting('arena_mode');
            arenaToggleButton.classList.toggle('arena-mode-on', isArenaModeActive);
            arenaToggleButton.textContent = isArenaModeActive ? ICON.ARENA : ICON.CHAT;
        }

        const councilToggleButton = document.querySelector('.council-toggle-button');
        if (councilToggleButton) {
            const isCouncilModeActive = tabState?.isCouncilModeActive ?? this.stateManager.getSetting('council_mode');
            councilToggleButton.classList.toggle('council-mode-on', isCouncilModeActive);
            councilToggleButton.textContent = isCouncilModeActive ? ICON.COUNCIL_ON : ICON.COUNCIL_OFF;
        }

        const webSearchToggle = document.getElementById('web-search-toggle');
        if (webSearchToggle) {
            webSearchToggle.classList.toggle('active', tabState?.getShouldWebSearch());
        }
        
        const aspectLabel = document.querySelector('#image-aspect-toggle .reasoning-label');
        const resolutionLabel = document.querySelector('#image-res-toggle .reasoning-label');
        if (aspectLabel && tabState) aspectLabel.textContent = tabState.getImageAspectRatio();
        if (resolutionLabel && tabState) resolutionLabel.textContent = tabState.getImageResolution();
    }

    handleTabClose(tabId) {
        this.cancelRestoredTabLoad(tabId);
        this.cancelPageContextRequest(tabId);
        this.voiceManager.handleTabClose(tabId); 
        this.tabTextareaContent.delete(tabId); 
    }

    initArenaToggleButton() {
        const arenaToggleButton = document.querySelector('.arena-toggle-button--arena');
        const councilToggleButton = document.querySelector('.council-toggle-button');

        const updateButtonState = () => {
            this.updateHeaderControls(this.getActiveTabState());
        };
        
        this.stateManager.runOnReady(updateButtonState);
        this.stateManager.subscribeToSetting('arena_mode', updateButtonState);
        this.stateManager.subscribeToSetting('council_mode', updateButtonState);
        
        if (arenaToggleButton) {
            arenaToggleButton.onclick = () => { 
                const tabState = this.getActiveTabState();
                if (!tabState) return;
                tabState.toggleArenaMode?.();
                updateButtonState(); 
            };
        }

        if (councilToggleButton) {
            councilToggleButton.onclick = () => {
                const tabState = this.getActiveTabState();
                if (!tabState) return;
                tabState.toggleCouncilMode?.();
                updateButtonState();
            };
        }
    }

    initThinkingModeButton() {
        const thinkingModeButton = document.querySelector('.thinking-mode');
        
        thinkingModeButton.onclick = () => {
            const activeTabState = this.getActiveTabState();
            if (activeTabState) { 
                activeTabState.toggleThinkingMode(); 
                thinkingModeButton.classList.toggle('thinking-mode-on', activeTabState.pendingThinkingMode); 
            }
        };
    }

    applyTranscription(tabId, transcriptText) {
        const cleanedTranscript = String(transcriptText || '').trim();
        if (!cleanedTranscript || !tabId) return;
        
        // Verify tab still exists before proceeding
        const allTabs = this.tabManager.getAllTabs();
        const tabExists = allTabs.some(t => t.id === tabId);
        if (!tabExists) return;
        
        if (this.getActiveTab()?.id === tabId) {
            this.insertTextAtCursor(this.textInput, cleanedTranscript);
            return;
        }
        
        const existingContent = this.tabTextareaContent.get(tabId) || '';
        this.tabTextareaContent.set(tabId, existingContent ? `${existingContent}\n${cleanedTranscript}` : cleanedTranscript);
    }

    insertTextAtCursor(textareaElement, textToInsert) {
        const selectionStart = textareaElement.selectionStart ?? textareaElement.value.length;
        const selectionEnd = textareaElement.selectionEnd ?? textareaElement.value.length;

        const textBefore = textareaElement.value.slice(0, selectionStart);
        const textAfter = textareaElement.value.slice(selectionEnd);
        const needsSpace = textBefore.length > 0 && !/\s$/.test(textBefore) && textToInsert.length > 0 && !/^\s/.test(textToInsert);
        const finalInsertion = `${needsSpace ? ' ' : ''}${textToInsert}`;

        textareaElement.value = `${textBefore}${finalInsertion}${textAfter}`;
        const newCursorPosition = textBefore.length + finalInsertion.length;
        textareaElement.selectionStart = newCursorPosition;
        textareaElement.selectionEnd = newCursorPosition;
        updateTextfieldHeight(textareaElement);
        textareaElement.focus();
    }

    initFooterButtons() {
        document.getElementById('history-button').onclick = () => {
            chrome.tabs.create({ url: chrome.runtime.getURL('src/html/history.html') });
        };
        document.getElementById('settings-button').onclick = () => {
            chrome.runtime.openOptionsPage();
        };
        document.getElementById('pop-out-toggle').onclick = () => {
            this.handlePopoutToggle();
        };
    }

    setupMessageListeners() {
        chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
            if (message.type === 'probe_sidepanel_ready') {
                if (this.receiverReady && this.hostTabId == null && message.windowId === this.hostWindowId) {
                    this.announceReceiverReady();
                }
                return false;
            }

            if (message.type === 'chat_renamed') {
                return this.handleChatRenamed(message.chatId, message.title);
            }

            if (!HANDOFF_TYPES.has(message.type) || !this.isHandoffTarget(message)) return false;
            if (!this.stateManager.isOn()) {
                sendResponse({ ok: false, error: 'Chat mode is off' });
                return false;
            }

            this.processHandoff(message)
                .then(completed => {
                    if (completed === false) {
                        sendResponse({ ok: false, error: 'Side panel rejected the handoff' });
                        return;
                    }
                    sendResponse({ ok: true });
                })
                .catch(error => sendResponse({ ok: false, error: error?.message || String(error) }));
            return true;
        });
    }

    async processHandoff(message) {
        if (message.type === 'new_selection') {
            return this.handleNewSelection(message.text, message.url);
        }
        if (message.type === 'new_chat') {
            return this.handleNewChat();
        }
        return this.handleReconstructChat(message.options);
    }

    setHostContext(windowId, tabId) {
        this.hostWindowId = windowId;
        this.hostTabId = tabId;
        this.hostContextReady = true;
    }

    isHandoffTarget(message) {
        if (!this.receiverReady || message.targetReceiverToken !== this.receiverToken) {
            return false;
        }
        if (message.targetTabId != null) {
            return this.hostContextReady && message.targetTabId === this.hostTabId;
        }
        if (message.targetWindowId != null) {
            return this.hostContextReady && this.hostTabId == null && message.targetWindowId === this.hostWindowId;
        }
        return true;
    }

    announceReceiverReady() {
        chrome.runtime.sendMessage({
            type: 'sidepanel_ready',
            windowId: this.hostWindowId,
            receiverToken: this.receiverToken
        }).catch(() => {});
    }

    async markReceiverReady() {
        if (this.hostTabId == null) {
            const registration = await chrome.runtime.sendMessage({
                type: 'register_sidepanel_receiver',
                windowId: this.hostWindowId,
                receiverToken: this.receiverToken
            });
            if (!registration?.ok || registration.receiverToken !== this.receiverToken) {
                throw new Error('Could not register side panel receiver');
            }
        }
        this.receiverReady = true;
        this.announceReceiverReady();
    }

    handleChatRenamed(chatId, newTitle) {
        const renamedTab = this.tabManager.findTabByChatId(chatId);
        if (renamedTab) { 
            renamedTab.controller.chatCore.miscUpdate({ title: newTitle }); 
            this.tabManager.updateTabTitle(renamedTab.id, newTitle); 
        }
    }

    async handleNewSelection(selectedText, pageUrl) {
        this.ensureActiveTab(); 
        if (!this.createTabIfNeeded()) return false;
        
        const activeController = this.getActiveController();
        const activeChatUI = this.getActiveChatUI();
        const activeTabState = this.getActiveTabState();
        
        if (!activeController || !activeChatUI) return false;
        this.cancelPageContextRequest(this.getActiveTab()?.id);
        if (activeTabState) {
            activeTabState.chatId = null;
        }
        
        this.stateManager.subscribeToChatReset("chat", () => this.handleNewSelection(selectedText, pageUrl));
        
        const hostName = new URL(pageUrl).hostname;
        activeController.initStates(`Selection from ${hostName}`);
        activeChatUI.clearConversation(); 
        activeChatUI.addSystemMessage(selectedText, `Selected Text - site:${hostName}`);
        
        if (this.getActiveTab()) {
            this.tabManager.updateTabTitle(this.getActiveTab().id, `Selection from ${hostName}`);
        }
        
        await activeController.initPrompt({ mode: "selection", text: selectedText, url: pageUrl });
        
        if (this.stateManager.isInstantPromptMode()) { 
            activeController.chatCore.addUserMessage("Please explain!"); 
            activeController.initApiCall(); 
        }
        return true;
    }

    async handleNewChat(options = {}) {
        this.ensureActiveTab(); 
        this.stateManager.subscribeToChatReset("chat", () => this.handleNewChat());

        let targetTab = this.getActiveTab();
        if (!targetTab) {
            targetTab = this.tabManager.createTab({
                continueFunc: (i, s, m) => this.continueFromCurrent(i, s, m)
            });
        } else if (options.forceNewTab || !this.tabManager.isCurrentTabEmpty()) {
            targetTab = this.tabManager.createTab({
                continueFunc: (i, s, m) => this.continueFromCurrent(i, s, m)
            });
        }

        if (!targetTab) {
            this.getActiveChatUI()?.addErrorMessage("Maximum tabs reached. Close a tab first.");
            return false;
        }

        const initialized = await this.initializeFreshChatTab(targetTab.id, { loadPrompt: true });
        if (!initialized) return false;
        
        if (this.stateManager.isInstantPromptMode()) { 
            this.getActiveChatUI()?.addWarningMessage("Warning: Instant prompt mode does not make sense in chat mode and will be ignored."); 
        }
        return true;
    }

    handleReconstructChat(reconstructOptions) {
        this.openedForReconstruct = true;
        this.ensureActiveTab();

        const isFullChat = reconstructOptions?.chatId && reconstructOptions.index === undefined;
        if (isFullChat) {
            const existingTab = this.findFullChatTab(reconstructOptions.chatId);
            if (existingTab) {
                this.cancelPageContextRequest(existingTab.id);
                if (this.startupNewTabId && this.startupNewTabId !== existingTab.id && Date.now() - this.startupAt < STARTUP_WINDOW_MS && this.isTabReallyEmpty(this.startupNewTabId)) {
                    this.tabManager.closeTab(this.startupNewTabId);
                    this.startupNewTabId = null;
                }
                this.tabManager.switchTab(existingTab.id);
                return this.ensureTabReady(existingTab.id);
            }
        }

        let targetTab = this.getActiveTab();
        if (!targetTab || !this.isTabReallyEmpty(targetTab.id)) {
            targetTab = this.tabManager.createTab({
                continueFunc: (i, s, m) => this.continueFromCurrent(i, s, m)
            });
        }
        if (!targetTab) {
            this.getActiveChatUI()?.addErrorMessage("Maximum tabs reached. Close a tab first.");
            return false;
        }

        this.cancelPageContextRequest(targetTab.id);
        const pending = { status: 'pending', options: reconstructOptions };
        targetTab.reconstruction = pending;
        return this.ensureTabReady(targetTab.id);
    }

    findFullChatTab(chatId) {
        const numericChatId = Number(chatId);
        return this.tabManager.getAllTabs().find(tab => {
            if (this.tabManager.getTabChatId(tab) !== numericChatId) return false;
            if (tab.reconstruction) return tab.reconstruction.options?.index === undefined;
            return !tab.controller.chatCore.hasPendingContinuation();
        });
    }

    async commitReconstruction(tab, prepared, operation = null) {
        const { controller, chatUI, tabState } = tab;
        const { options } = prepared;

        controller.initStates(options.chatId ? 'Continued Chat' : 'New Chat');
        tabState.isSidePanel = options.isSidePanel !== false;

        if (!options.chatId) {
            tabState.chatId = null;
            if (options.systemPrompt) controller.chatCore.insertSystemMessage(options.systemPrompt);
            if (options.webpageContext !== undefined) {
                controller.chatCore.setWebpageContext(options.webpageContext);
                controller.chatCore.setWebpageContextDismissed(options.webpageContextDismissed);
            }
            chatUI.clearConversation({ skipTextarea: true });
            controller.syncWebpageContextUI();
            if (options.pendingUserMessage) {
                this.restorePendingUserMessage(tab, options.pendingUserMessage);
                controller.restoreLatestAssistantActions();
            }
            return true;
        }

        const removeTrailingUser = prepared.isContinuation && prepared.selectedMessage?.role === 'user';
        controller.chatCore.buildFromDB(
            prepared.chat,
            null,
            options.secondaryIndex,
            options.modelChoice,
            removeTrailingUser
        );
        if (options.webpageContext !== undefined) {
            controller.chatCore.setWebpageContext(options.webpageContext);
        }
        if (options.webpageContextDismissed !== undefined) {
            controller.chatCore.setWebpageContextDismissed(options.webpageContextDismissed);
        }

        chatUI.updateIncognito(controller.chatCore.hasChatStarted());
        const renderState = prepared.isContinuation
            ? this.getContinuationRenderChat(controller.chatCore.getChat())
            : { chat: controller.chatCore.getChat(), indexOffset: 0 };
        const rendered = await chatUI.buildChat(renderState.chat, { indexOffset: renderState.indexOffset });
        if (rendered === false || this.tabManager.getTab(tab.id) !== tab || (operation && tab.reconstruction !== operation)) {
            return false;
        }
        controller.syncWebpageContextUI();

        if (prepared.isContinuation) {
            controller.chatCore.continuedChatOptions = {
                fullChatLength: prepared.fullChatLength,
                lastMessage: prepared.selectedMessage,
                index: options.index,
                modelChoice: options.modelChoice,
                secondaryIndex: options.secondaryIndex,
                secondaryLength: prepared.secondaryLength
            };
            this.restorePendingUserMessage(
                tab,
                removeTrailingUser ? prepared.selectedMessage : options.pendingUserMessage,
                removeTrailingUser ? options.secondaryIndex : null
            );
        } else {
            controller.chatCore.continuedChatOptions = {};
        }

        if (prepared.chat.title) this.tabManager.updateTabTitle(tab.id, prepared.chat.title);
        tabState.chatId = prepared.chatId;
        this.tabManager.schedulePersist();
        controller.restoreLatestAssistantActions();
        return true;
    }

    restorePendingUserMessage(tab, message, secondaryIndex = null) {
        const { controller } = tab;
        if (message?.role === "user") {
            if (message.images) {
                controller.appendPendingMedia(message.images, 'image');
            }
            if (message.audio) {
                controller.appendPendingMedia(message.audio, 'audio');
            }
            if (message.files) {
                controller.appendPendingMedia(message.files, 'file');
            }

            if (message.contents) {
                const content = secondaryIndex == null ? message.contents.at(-1) : message.contents[secondaryIndex];
                const text = content?.at(-1)?.content || '';
                this.setTabDraft(tab.id, text);
            }
        } else {
            this.setTabDraft(tab.id, '');
        }
    }

    handlePopoutToggle() {
        if (this.popoutTransferPromise) return this.popoutTransferPromise;

        const transfer = this.performPopoutToggle();
        const guardedTransfer = transfer.finally(() => {
            if (this.popoutTransferPromise === guardedTransfer) this.popoutTransferPromise = null;
        });
        this.popoutTransferPromise = guardedTransfer;
        return guardedTransfer;
    }

    async performPopoutToggle() {
        const activeTab = await this.getReadyActiveTab();
        if (!activeTab) return;

        const { controller: activeController, tabState: activeTabState, chatUI: activeChatUI } = activeTab;
        if (!activeController || !activeTabState) {
            return;
        }
        
        // Multi-tab popout safety checks
        const currentTabCount = this.tabManager.getTabCount();
        if (currentTabCount > 1) {
            const isPersistenceEnabled = this.stateManager.getSetting('persist_tabs') !== false;
            if (!isPersistenceEnabled) {
                activeChatUI?.addErrorMessage("Close other tabs before popping out (they would be lost).");
                return;
            }
            
            const currentActiveTabId = activeTab.id;
            const unsavedTabsList = this.tabManager.getAllTabs().filter(tab => {
                const isNotCurrentlyActive = (tab.id !== currentActiveTabId);
                const isNotYetSavedToStorage = !this.tabManager.getTabChatId(tab);
                return isNotCurrentlyActive && isNotYetSavedToStorage;
            });
            
            if (unsavedTabsList.length > 0) {
                const errorMessage = `Close ${unsavedTabsList.length} unsaved tab(s) before popping out (drafts aren't persisted).`;
                activeChatUI?.addErrorMessage(errorMessage);
                return;
            }
        }
        
        const reconstructOptions = { 
            chatId: activeController.chatCore.getChatId(), 
            isSidePanel: !activeTabState.isSidePanel, 
            index: Math.max(activeController.chatCore.getLength() - 1, 0), 
            pendingUserMessage: activeController.collectPendingUserMessage(),
            webpageContext: activeController.chatCore.getWebpageContext(),
            webpageContextDismissed: activeController.chatCore.isWebpageContextDismissed()
        };
        
        // Determine indices for continuation
        const latestMessageInChat = activeController.chatCore.getLatestMessage();
        if (latestMessageInChat?.responses) {
            const modelChoiceKey = (latestMessageInChat.continued_with !== "none") 
                ? latestMessageInChat.continued_with 
                : 'model_a';
                
            reconstructOptions.secondaryIndex = latestMessageInChat.responses[modelChoiceKey].messages.length - 1; 
            reconstructOptions.modelChoice = modelChoiceKey;
            
        } else if (latestMessageInChat?.role === 'assistant') {
            reconstructOptions.secondaryIndex = latestMessageInChat.contents.length - 1;
        }
        
        if (!reconstructOptions.chatId) {
            reconstructOptions.systemPrompt = activeController.chatCore.getSystemPrompt();
        }

        if (activeTabState.isSidePanel) {
            // Panel -> Tab
            const sidePanelUrl = chrome.runtime.getURL('src/html/sidepanel.html');
            let target = null;
            try {
                target = await waitForCreatedTabReceiver(
                    () => chrome.tabs.create({ url: sidePanelUrl }),
                    sidePanelUrl
                );
                const delivery = await chrome.runtime.sendMessage({
                    type: "reconstruct_chat",
                    options: reconstructOptions,
                    targetTabId: target.tab.id,
                    targetReceiverToken: target.receiverToken
                });
                if (!delivery?.ok) throw new Error(delivery?.error || 'Popped-out chat rejected the handoff');
            } catch (error) {
                if (target) await chrome.tabs.remove(target.tab.id).catch(() => {});
                activeChatUI?.addErrorMessage(error?.message || 'Failed to pop out chat.');
                return false;
            }
            window.close();
            return true;
            
        } else {
            // Tab -> Panel
            const openRequest = openSidePanelWithHandoff({
                type: "reconstruct_chat",
                options: reconstructOptions
            });
            const [response, currentWindowTabs] = await Promise.all([
                openRequest,
                chrome.tabs.query({ windowId: chrome.windows.WINDOW_ID_CURRENT })
            ]);
            if (!response.ok) {
                activeChatUI?.addErrorMessage(response.error || 'Failed to open side panel.');
                return false;
            }
            const currentWindowTabCount = currentWindowTabs.length;
            
            // Create fallback tab if this was the last one
            if (currentWindowTabCount === 1) {
                await chrome.tabs.create({ url: NEW_TAB_URL });
            }
            window.close();
            return true;
        }
    }

    initTextareaImageHandling() {
        this.dragDropManager = new DragDropManager(this.textInput, {
            onImage: base64String => { void this.withReadyActiveTab(tab => tab.controller.appendPendingMedia([base64String], 'image')); },
            onAudio: (base64String, fileName) => { void this.withReadyActiveTab(tab => tab.controller.appendPendingMedia([{ data: base64String, name: fileName }], 'audio')); },
            onFile: fileObject => { void this.withReadyActiveTab(tab => tab.controller.appendPendingMedia([fileObject], 'file')); },
            onText: droppedText => { void this.withReadyActiveTab(tab => this.setTabDraft(tab.id, droppedText)); },
            onError: errorMessage => this.getActiveChatUI()?.addErrorMessage(this.apiManager.getUiErrorMessage(errorMessage))
        });
    }

    async withReadyActiveTab(action) {
        const tab = await this.getReadyActiveTab();
        if (!tab) return false;
        action(tab);
        return true;
    }
}


// Initialize the application when the DOM is loaded
if (typeof document !== 'undefined') {
    document.addEventListener('DOMContentLoaded', async () => {
        const app = new SidepanelApp();
        const [currentWindow, currentTab] = await Promise.all([
            chrome.windows.getCurrent(),
            chrome.tabs.getCurrent()
        ]);
        app.setHostContext(currentWindow.id, currentTab?.id ?? null);
        await app.readyPromise;
        await app.markReceiverReady();
    });
}
