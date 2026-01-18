import { autoResizeTextfieldListener, updateTextfieldHeight } from "./ui_utils.js";
import { ApiManager } from "./api_manager.js";
import { ChatStorage } from './chat_storage.js';
import { SidepanelStateManager } from './state_manager.js';
import { TabManager } from './tab_manager.js';
import { SidepanelChatUI } from './chat_ui.js';
import { DragDropManager } from './drag_drop_manager.js';
import { VoiceManager } from './voice_manager.js';

// Configuration constants
const STARTUP_WINDOW_MS = 2000;  // Time window to consider closing empty startup tabs
const NEW_TAB_URL = 'chrome://newtab';

// Arena and Council mode toggle icons
const ICON = {
    ARENA: '\u{2694}',       // ⚔️ Crossed swords - arena mode enabled
    CHAT: '\u{1F916}',       // 🤖 Robot - normal chat mode
    COUNCIL: '\u{2042}'      // ⁂ Asterism - council mode
};

class SidepanelApp {
    constructor() {
        this.stateManager = new SidepanelStateManager('chat_prompt');
        this.apiManager = new ApiManager();
        this.stateManager.apiManager = this.apiManager;
        this.chatStorage = new ChatStorage();

        // Per-tab textarea content storage
        this.tabTextareaContent = new Map();
        this.sharedUIInitialized = false;
        this.openedForReconstruct = false;
        this.startupAt = Date.now();
        this.startupNewTabId = null;
        this._markNextTabAsStartupNew = false;

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
            onTabClose: (tabId) => this.handleTabClose(tabId)
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

        this.initManagers();
        this.initEventListeners();

        this.stateManager.runOnReady(() => {
            void this.bootstrapTabs();
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

        const tab = this.tabManager.createTab({ 
            continueFunc: (i, s, m) => this.continueFromCurrent(i, s, m) 
        });
        if (tab) {
            if (this._markNextTabAsStartupNew) this.startupNewTabId = tab.id;
            this.ensureSharedUIInitialized();
        }
    }

    async bootstrapTabs() {
        await this.tabManager.restorePersistedTabs();
        // Wait for next frame to ensure UI/state is stable
        await new Promise(resolve => requestAnimationFrame(resolve));
        
        this._markNextTabAsStartupNew = !this.openedForReconstruct;
        this.ensureActiveTab();
        this._markNextTabAsStartupNew = false;
    }

    isTabReallyEmpty(tabId) {
        const tabs = this.tabManager.getAllTabs();
        const tab = tabs.find(t => t.id === tabId);
        
        if (!tab) {
            return false;
        }

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

        // Create a proxy to delegate property access between global state and active tab state
        const stateProxyHandler = {
            get: (target, prop) => {
                const activeTabState = this.getActiveTabState() || dummyTabState;
                
                // Prioritize active tab state if property exists there
                if (prop in activeTabState) {
                    const value = activeTabState[prop];
                    return typeof value === 'function' ? value.bind(activeTabState) : value;
                }
                
                // Fallback to global state manager
                const globalValue = target[prop];
                return typeof globalValue === 'function' ? globalValue.bind(target) : globalValue;
            },
            set: (target, prop, value) => {
                const activeTabState = this.getActiveTabState();
                
                // Set on active tab state if it exists there
                if (activeTabState && prop in activeTabState) {
                    activeTabState[prop] = value;
                } else {
                    target[prop] = value;
                }
                return true;
            }
        };

        const sharedState = new Proxy(this.stateManager, stateProxyHandler);

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
        const activeTabState = this.getActiveTabState();
        const activeController = this.getActiveController();
        
        if (!activeTabState || !activeController || !this.stateManager.isOn()) {
            return;
        }
        
        if (activeController.chatCore.getSystemPrompt() === undefined) {
            await activeController.initPrompt({ mode: "chat" });
        }
        activeController.sendUserMessage();
    }

    continueFromCurrent(index, secondaryIndex = null, modelChoice = null) {
        const activeController = this.getActiveController();
        if (!activeController) return;

        const reconstructOptions = {
            chatId: activeController.chatCore.getChatId(),
            index,
            secondaryIndex,
            modelChoice,
            pendingUserMessage: activeController.collectPendingUserMessage()
        };
        
        if (!reconstructOptions.chatId) {
            reconstructOptions.systemPrompt = activeController.chatCore.getSystemPrompt();
        }
        
        void this.handleReconstructChat(reconstructOptions);
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
        
        if (activeTab.tabState) {
            this.updateHeaderControls(activeTab.tabState);
            const currentModelId = activeTab.tabState.getCurrentModel();
            if (currentModelId && currentModelId !== this.stateManager.getSetting('current_model')) {
                this.stateManager.updateSettingsLocal({ current_model: currentModelId });
            }
        }
    }

    updateHeaderControls(tabState) {
        const thinkingModeButton = document.querySelector('.thinking-mode');
        if (thinkingModeButton) {
            thinkingModeButton.classList.toggle('thinking-mode-on', tabState.pendingThinkingMode);
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
            councilToggleButton.textContent = ICON.COUNCIL;
        }

        const reasoningToggleButton = document.getElementById('sonnet-thinking-toggle');
        if (reasoningToggleButton) {
            const currentModelId = tabState.getCurrentModel() || '';
            const hasReasoningEffortLevels = this.apiManager.hasReasoningLevels(currentModelId);
            const labelSpan = reasoningToggleButton.querySelector('.reasoning-label');
            
            if (hasReasoningEffortLevels) {
                const effortLevel = tabState.getReasoningEffort();
                reasoningToggleButton.classList.add('active');
                reasoningToggleButton.title = `Reasoning: ${effortLevel}`;
                if (labelSpan) labelSpan.textContent = effortLevel;
            } else {
                reasoningToggleButton.classList.toggle('active', tabState.getShouldThink());
                reasoningToggleButton.title = 'Reasoning';
                if (labelSpan) labelSpan.textContent = 'reason';
            }
        }
        
        const webSearchToggle = document.getElementById('web-search-toggle');
        if (webSearchToggle) {
            webSearchToggle.classList.toggle('active', tabState.getShouldWebSearch());
        }
        
        const aspectLabel = document.querySelector('#image-aspect-toggle .reasoning-label');
        const resolutionLabel = document.querySelector('#image-res-toggle .reasoning-label');
        if (aspectLabel) aspectLabel.textContent = tabState.getImageAspectRatio();
        if (resolutionLabel) resolutionLabel.textContent = tabState.getImageResolution();
    }

    handleTabClose(tabId) { 
        this.voiceManager.handleTabClose(tabId); 
        this.tabTextareaContent.delete(tabId); 
    }

    initArenaToggleButton() {
        const arenaToggleButton = document.querySelector('.arena-toggle-button--arena');
        const councilToggleButton = document.querySelector('.council-toggle-button');

        const updateButtonState = () => {
            const tabState = this.getActiveTabState();
            const isCouncilModeActive = tabState?.isCouncilModeActive ?? this.stateManager.getSetting('council_mode');
            const isArenaModeActive = tabState?.isArenaModeActive ?? this.stateManager.getSetting('arena_mode');
            
            if (arenaToggleButton) {
                arenaToggleButton.classList.toggle('arena-mode-on', isArenaModeActive);
                arenaToggleButton.textContent = isArenaModeActive ? ICON.ARENA : ICON.CHAT;
            }
            if (councilToggleButton) {
                councilToggleButton.classList.toggle('council-mode-on', isCouncilModeActive);
                councilToggleButton.textContent = ICON.COUNCIL;
            }
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
        chrome.runtime.onMessage.addListener(message => {
            if (message.type === 'chat_renamed') {
                return this.handleChatRenamed(message.chatId, message.title);
            }
            
            if (!this.stateManager.isOn()) return;
            
            if (message.type === 'new_selection') {
                this.handleNewSelection(message.text, message.url);
            } else if (message.type === 'new_chat') {
                this.handleNewChat();
            } else if (message.type === 'reconstruct_chat') {
                this.handleReconstructChat(message.options);
            }
        });
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
        if (!this.createTabIfNeeded()) return;
        
        const activeController = this.getActiveController();
        const activeChatUI = this.getActiveChatUI();
        const activeTabState = this.getActiveTabState();
        
        if (!activeController || !activeChatUI) return; 
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
    }

    handleNewChat() {
        this.ensureActiveTab(); 
        if (!this.createTabIfNeeded()) return;
        
        const activeController = this.getActiveController();
        const activeChatUI = this.getActiveChatUI();
        const activeTabState = this.getActiveTabState();
        
        if (!activeController || !activeChatUI || !activeTabState) return;
        this.stateManager.subscribeToChatReset("chat", () => this.handleNewChat());
        
        activeTabState.chatId = null; 
        activeController.initStates("New Chat"); 
        activeChatUI.clearConversation();
        
        if (this.stateManager.isInstantPromptMode()) { 
            activeChatUI.addWarningMessage("Warning: Instant prompt mode does not make sense in chat mode and will be ignored."); 
        }
        activeController.initPrompt({ mode: "chat" });
    }

    async handleReconstructChat(reconstructOptions) {
        this.openedForReconstruct = true; 
        this.ensureActiveTab();
        
        if (reconstructOptions?.chatId && reconstructOptions.index === undefined) {
            const existingTab = this.tabManager.findTabByChatId(reconstructOptions.chatId);
            if (existingTab) {
                if (this.startupNewTabId && this.startupNewTabId !== existingTab.id && Date.now() - this.startupAt < STARTUP_WINDOW_MS && this.isTabReallyEmpty(this.startupNewTabId)) {
                    this.tabManager.closeTab(this.startupNewTabId);
                    this.startupNewTabId = null;
                }
                return this.tabManager.switchTab(existingTab.id);
            }
        }
        
        if (!this.createTabIfNeeded()) return;
        
        const activeController = this.getActiveController();
        const activeChatUI = this.getActiveChatUI();
        const activeTabState = this.getActiveTabState();
        const activeTab = this.getActiveTab();
        
        if (!activeController || !activeChatUI || !activeTabState) return;
        if (!reconstructOptions.chatId) {
            activeTabState.chatId = null;
        }
        
        activeController.initStates(reconstructOptions.chatId ? "Continued Chat" : "New Chat");
        activeTabState.isSidePanel = reconstructOptions.isSidePanel !== false;

        if (!reconstructOptions.chatId && !reconstructOptions.pendingUserMessage) {
            if (reconstructOptions.systemPrompt) {
                activeController.chatCore.insertSystemMessage(reconstructOptions.systemPrompt);
            }
            return activeChatUI.clearConversation();
        }

        let lastHistoryMessage = null;
        if (reconstructOptions.chatId) {
            const numericChatId = Number(reconstructOptions.chatId);
            if (!Number.isFinite(numericChatId)) {
                activeChatUI.addErrorMessage("Invalid chat ID");
                return;
            }

            const messageLimit = reconstructOptions.index !== undefined ? reconstructOptions.index + 1 : null;
            let loadedChat;
            try {
                loadedChat = await this.chatStorage.loadChat(numericChatId, messageLimit);
            } catch (error) {
                console.warn('Failed to load chat:', error);
                activeChatUI.addErrorMessage("Failed to load chat");
                return;
            }
            if (!loadedChat?.messages) return activeChatUI.addErrorMessage("Chat not found");
            
            lastHistoryMessage = loadedChat.messages.at(-1);
            const secondaryLength = lastHistoryMessage?.contents
                ? lastHistoryMessage.contents.length
                : lastHistoryMessage?.responses?.[reconstructOptions.modelChoice || 'model_a']?.messages?.length;
            
            activeController.chatCore.buildFromDB(loadedChat, null, reconstructOptions.secondaryIndex, reconstructOptions.modelChoice);
            
            activeChatUI.updateIncognito(activeController.chatCore.hasChatStarted()); 
            activeChatUI.buildChat(activeController.chatCore.getChat());
            
            if (activeTab?.container) {
                requestAnimationFrame(() => activeTab.container.scrollTop = activeTab.container.scrollHeight);
            }
            
            activeController.chatCore.continuedChatOptions = { 
                fullChatLength: await this.chatStorage.getChatLength(numericChatId), 
                lastMessage: lastHistoryMessage, 
                index: reconstructOptions.index,
                modelChoice: reconstructOptions.modelChoice,
                secondaryIndex: reconstructOptions.secondaryIndex,
                secondaryLength
            };
            
            if (activeTab && loadedChat.title) {
                this.tabManager.updateTabTitle(activeTab.id, loadedChat.title);
            }
            activeTabState.chatId = numericChatId; 
            this.tabManager.schedulePersist();
        }
        
        if (reconstructOptions.systemPrompt) {
            activeController.chatCore.insertSystemMessage(reconstructOptions.systemPrompt);
        }
        
        this.handleLastUserMsg(lastHistoryMessage?.role === 'user' ? lastHistoryMessage : reconstructOptions.pendingUserMessage);
        
        const latestMessage = activeController.chatCore.getLatestMessage();
        if (latestMessage?.role === 'assistant' && !latestMessage.responses) {
            activeChatUI.addRegenerateFooterToLastMessage(() => {
                const lastModelId = latestMessage.contents?.at(-1)?.at(-1)?.model || this.stateManager.getSetting('current_model');
                activeController.regenerateResponse(lastModelId);
            });
        }
    }

    handleLastUserMsg(message) {
        const controller = this.getActiveController();
        const chatUI = this.getActiveChatUI();
        
        if (!controller || !chatUI) {
            return;
        }
        
        if (message?.role === "user") {
            // Restore media
            if (message.images) {
                controller.appendPendingMedia(message.images, 'image');
            }
            if (message.files) {
                controller.appendPendingMedia(message.files, 'file');
            }
            
            // Restore text
            if (message.contents) {
                const text = message.contents.at(-1).at(-1).content;
                chatUI.setTextareaText(text);
            }
        } else {
            chatUI.setTextareaText('');
        }
    }

    async handlePopoutToggle() {
        const activeController = this.getActiveController();
        const activeTabState = this.getActiveTabState();
        const activeChatUI = this.getActiveChatUI();
        
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
            
            const currentActiveTabId = this.getActiveTab()?.id;
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
            pendingUserMessage: activeController.collectPendingUserMessage() 
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
            chrome.tabs.create({ url: sidePanelUrl });
            
            // Wait for new sidepanel instance to signal ready
            await new Promise(resolve => {
                const readyMessageListener = (message) => { 
                    if (message.type === "sidepanel_ready") { 
                        chrome.runtime.onMessage.removeListener(readyMessageListener); 
                        resolve(); 
                    } 
                };
                chrome.runtime.onMessage.addListener(readyMessageListener);
            });
            
            chrome.runtime.sendMessage({ 
                type: "reconstruct_chat", 
                options: reconstructOptions 
            });
            window.close();
            
        } else {
            // Tab -> Panel
            const [{ length: currentWindowTabCount }, { isOpen: isSidepanelCurrentlyOpen }] = await Promise.all([
                chrome.tabs.query({ windowId: chrome.windows.WINDOW_ID_CURRENT }), 
                chrome.runtime.sendMessage({ type: "is_sidepanel_open" })
            ]);
            
            if (!isSidepanelCurrentlyOpen) {
                await chrome.runtime.sendMessage({ type: "open_side_panel" });
            }
            
            chrome.runtime.sendMessage({ 
                type: "reconstruct_chat", 
                options: reconstructOptions 
            });
            
            // Create fallback tab if this was the last one
            if (currentWindowTabCount === 1) {
                await chrome.tabs.create({ url: NEW_TAB_URL });
            }
            window.close();
        }
    }

    initTextareaImageHandling() {
        this.dragDropManager = new DragDropManager(this.textInput, {
            onImage: base64String => this.getActiveController()?.appendPendingMedia([base64String], 'image'),
            onFile: fileObject => this.getActiveController()?.appendPendingMedia([fileObject], 'file'),
            onText: droppedText => this.getActiveChatUI()?.setTextareaText(droppedText),
            onError: errorMessage => this.getActiveChatUI()?.addErrorMessage(this.apiManager.getUiErrorMessage(errorMessage))
        });
    }
}


// Initialize the application when the DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    new SidepanelApp();
    chrome.runtime.sendMessage({ type: "sidepanel_ready" });
});
