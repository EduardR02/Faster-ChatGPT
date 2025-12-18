import { auto_resize_textfield_listener, update_textfield_height } from "./utils.js";
import { ApiManager } from "./api_manager.js";
import { ChatStorage } from './chat_storage.js';
import { SidepanelStateManager } from './state_manager.js';
import { TabManager } from './tab_manager.js';

class SidepanelApp {
    constructor() {
        this.stateManager = new SidepanelStateManager('chat_prompt');
        this.apiManager = new ApiManager();
        this.chatStorage = new ChatStorage();

        // Per-tab textarea content storage
        this.tabTextareaContent = new Map();
        this.sharedUIInitialized = false;
        this.openedForReconstruct = false;
        this.startupAt = Date.now();
        this.startupNewTabId = null;
        this._markNextTabAsStartupNew = false;

        this.voice = {
            recorder: null,
            stream: null,
            chunks: [],
            recordingTabId: null,
            mimeType: null,
            busy: false,
        };

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
        const globalState = this.stateManager;
        const sharedState = new Proxy(globalState, {
            get: (target, prop) => {
                const active = this.tabManager.getActiveTabState();
                if (active && prop in active) {
                    const value = active[prop];
                    return typeof value === 'function' ? value.bind(active) : value;
                }
                const value = target[prop];
                return typeof value === 'function' ? value.bind(target) : value;
            },
            set: (target, prop, value) => {
                const active = this.tabManager.getActiveTabState();
                if (active && prop in active) {
                    active[prop] = value;
                } else {
                    target[prop] = value;
                }
                return true;
            }
        });

        const sharedUI = Object.create(Object.getPrototypeOf(chatUI));
        sharedUI.stateManager = sharedState;
        sharedUI.textarea = document.getElementById('textInput');

        sharedUI.initSonnetThinking();
        globalState.runOnReady(() => {
            sharedUI.initWebSearchToggle();
            sharedUI.initImageConfigToggles();
            sharedUI.initModelPicker();
        });

        const buttonFooter = document.getElementById('sidepanel-button-footer');
        const incognitoToggle = document.getElementById('incognito-toggle');
        if (buttonFooter && incognitoToggle) {
            const hoverText = buttonFooter.querySelectorAll('.hover-text');
            const hasChatStarted = () => this.getActiveController()?.chatCore?.hasChatStarted?.() || false;
            sharedUI.setupIncognitoButtonHandlers(incognitoToggle, buttonFooter, hoverText, hasChatStarted);
            sharedUI.updateIncognitoButtonVisuals(incognitoToggle);
        }
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

    /**
     * Creates a new tab if current isn't empty. Returns false if max tabs reached.
     */
    createTabIfNeeded() {
        if (this.tabManager.isCurrentTabEmpty()) return true;
        const newTab = this.tabManager.createTab({
            continueFunc: (i, si, mc) => this.continueFromCurrent(i, si, mc)
        });
        if (!newTab) {
            this.getActiveChatUI()?.addErrorMessage("Maximum tabs reached. Close a tab first.");
            return false;
        }
        return true;
    }

    // ========== Event Listeners ==========

    initEventListeners() {
        auto_resize_textfield_listener('textInput');
        this.initInputListener();
        this.initArenaToggleButton();
        this.initThinkingModeButton();
        this.initFooterButtons();
        this.initVoiceTranscription();
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
        const { tabState, chatUI } = newTab;

        // Save/restore textarea content
        if (oldTabId && oldTabId !== newTab.id) {
            this.tabTextareaContent.set(oldTabId, textarea.value || '');

            if (this.voice.recorder?.state === 'recording' && this.voice.recordingTabId === oldTabId) {
                void this.stopRecordingAndTranscribe();
            }
        }
        textarea.value = this.tabTextareaContent.get(newTab.id) ?? '';
        update_textfield_height(textarea);

        // Update incognito button
        const incognitoToggle = document.getElementById('incognito-toggle');
        if (incognitoToggle && chatUI) chatUI.updateIncognitoButtonVisuals(incognitoToggle);

        if (!tabState) return;

        // Update thinking mode button
        document.querySelector('.thinking-mode')
            ?.classList.toggle('thinking-mode-on', tabState.pendingThinkingMode);

        // Update arena mode button
        const isArenaMode = this.stateManager.getSetting('arena_mode');
        const arenaButton = document.querySelector('.arena-toggle-button');
        if (arenaButton) {
            arenaButton.textContent = isArenaMode ? '\u{2694}' : '\u{1F916}';
            arenaButton.classList.toggle('arena-mode-on', isArenaMode);
        }

        // Update reasoning toggle
        const sonnetBtn = document.getElementById('sonnet-thinking-toggle');
        if (sonnetBtn) {
            const model = tabState.getCurrentModel() || '';
            const hasReasoningLevels = /o\d/.test(model) || model.includes('gpt-5') ||
                (/gemini-[3-9]\.?\d*|gemini-\d{2,}/.test(model) && !model.includes('image'));
            const label = sonnetBtn.querySelector('.reasoning-label');

            if (hasReasoningLevels) {
                const effort = tabState.getReasoningEffort();
                sonnetBtn.classList.add('active');
                sonnetBtn.title = `Reasoning: ${effort}`;
                if (label) label.textContent = effort;
            } else {
                sonnetBtn.classList.toggle('active', tabState.getShouldThink());
                sonnetBtn.title = 'Reasoning';
                if (label) label.textContent = 'reason';
            }
        }

        // Update web search toggle
        document.getElementById('web-search-toggle')
            ?.classList.toggle('active', tabState.getShouldWebSearch());

        // Update image config labels
        const aspectLabel = document.querySelector('#image-aspect-toggle .reasoning-label');
        const resLabel = document.querySelector('#image-res-toggle .reasoning-label');
        if (aspectLabel) aspectLabel.textContent = tabState.getImageAspectRatio();
        if (resLabel) resLabel.textContent = tabState.getImageResolution();

        // Sync model to global state
        const tabModel = tabState.getCurrentModel();
        if (tabModel && tabModel !== this.stateManager.getSetting('current_model')) {
            this.stateManager.updateSettingsLocal({ current_model: tabModel });
        }
    }

    handleTabClose(tabId) {
        if (this.voice.recorder?.state === 'recording' && this.voice.recordingTabId === tabId) {
            void this.stopVoiceRecording();
        }
        this.tabTextareaContent.delete(tabId);
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

    // ========== Voice Transcription ==========

    initVoiceTranscription() {
        const button = document.getElementById('voice-transcribe-toggle');
        if (!button) return;

        const updateButton = () => {
            const isRecording = this.voice.recorder?.state === 'recording';
            button.classList.toggle('recording', isRecording);
            button.classList.toggle('busy', !!this.voice.busy);
        };

        button.addEventListener('click', () => {
            if (this.voice.busy) return;
            if (this.voice.recorder?.state === 'recording') {
                void this.stopRecordingAndTranscribe();
            } else {
                void this.startVoiceRecording();
            }
            updateButton();
        });

        this._updateVoiceButton = updateButton;
        updateButton();
    }

    getPreferredAudioMimeType() {
        return ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/ogg']
            .find(t => MediaRecorder?.isTypeSupported?.(t)) || '';
    }

    async startVoiceRecording() {
        if (this.voice.recorder?.state === 'recording') return;

        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            const mimeType = this.getPreferredAudioMimeType();
            const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);

            this.voice.stream = stream;
            this.voice.mimeType = recorder.mimeType || mimeType || 'audio/webm';
            this.voice.recorder = recorder;
            this.voice.chunks = [];
            this.voice.recordingTabId = this.getActiveTab()?.id ?? null;

            recorder.addEventListener('dataavailable', (event) => {
                if (event.data?.size > 0) this.voice.chunks.push(event.data);
            });

            recorder.start();
        } catch (error) {
            const msg = error?.name === 'NotAllowedError'
                ? 'Microphone permission denied. Open settings → Microphone access → Enable microphone.'
                : this.apiManager.getUiErrorMessage(error, { prefix: 'Microphone error' });
            this.getActiveChatUI()?.addErrorMessage(msg);
            this.cleanupVoiceRecorder();
        } finally {
            this._updateVoiceButton?.();
        }
    }

    cleanupVoiceRecorder() {
        this.voice.recorder = null;
        this.voice.chunks = [];
        this.voice.mimeType = null;
        this.voice.recordingTabId = null;

        if (this.voice.stream) {
            this.voice.stream.getTracks().forEach(track => track.stop());
            this.voice.stream = null;
        }
        this._updateVoiceButton?.();
    }

    async stopVoiceRecording() {
        const recorder = this.voice.recorder;
        if (!recorder) return null;

        const stopped = new Promise(resolve => recorder.addEventListener('stop', resolve, { once: true }));
        recorder.stop();
        await stopped;

        const blob = new Blob(this.voice.chunks, { type: this.voice.mimeType || 'audio/webm' });
        this.cleanupVoiceRecorder();
        return blob;
    }

    async stopRecordingAndTranscribe() {
        const tabId = this.voice.recordingTabId;
        const audioBlob = await this.stopVoiceRecording();
        if (!audioBlob || audioBlob.size === 0) return;

        const model = this.stateManager.getSetting('transcription_model');
        if (!model) {
            this.getActiveChatUI()?.addErrorMessage('Select a transcription model in settings first.');
            return;
        }

        this.voice.busy = true;
        this._updateVoiceButton?.();

        try {
            const ext = ['ogg', 'webm', 'wav'].find(e => audioBlob.type.includes(e)) || 'webm';
            const text = await this.apiManager.transcribeAudio(model, audioBlob, { filename: `audio.${ext}` });
            if (text) this.applyTranscriptionText(tabId, text);
        } catch (error) {
            this.getActiveChatUI()?.addErrorMessage(this.apiManager.getUiErrorMessage(error, { prefix: 'Transcription error' }));
        } finally {
            this.voice.busy = false;
            this._updateVoiceButton?.();
        }
    }

    applyTranscriptionText(tabId, text) {
        const cleaned = String(text || '').trim();
        if (!cleaned) return;

        if (this.getActiveTab()?.id === tabId) {
            this.insertTextAtCursor(document.getElementById('textInput'), cleaned);
            return;
        }
        if (!tabId) return;
        const existing = this.tabTextareaContent.get(tabId) || '';
        this.tabTextareaContent.set(tabId, existing ? `${existing}\n${cleaned}` : cleaned);
    }

    insertTextAtCursor(textarea, text) {
        const start = textarea.selectionStart ?? textarea.value.length;
        const end = textarea.selectionEnd ?? textarea.value.length;

        const before = textarea.value.slice(0, start);
        const after = textarea.value.slice(end);

        const needsSpaceBefore = before.length > 0 && !/\s$/.test(before) && text.length > 0 && !/^\s/.test(text);
        const insertion = `${needsSpaceBefore ? ' ' : ''}${text}`;

        textarea.value = `${before}${insertion}${after}`;
        const cursor = before.length + insertion.length;
        textarea.selectionStart = cursor;
        textarea.selectionEnd = cursor;
        update_textfield_height(textarea);
        textarea.focus();
    }

    // ========== Footer Buttons ==========

    initFooterButtons() {
        this.initHistoryButton();
        this.initSettingsButton();
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
        if (!this.createTabIfNeeded()) return;

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

        const tab = this.getActiveTab();
        if (tab) this.tabManager.updateTabTitle(tab.id, `Selection from ${hostname}`);

        await this.initPrompt({ mode: "selection", text, url });

        if (this.stateManager.isInstantPromptMode()) {
            controller.chatCore.addUserMessage("Please explain!");
            controller.initApiCall();
        }
    }

    handleNewChat() {
        this.ensureActiveTab();
        if (!this.createTabIfNeeded()) return;

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

        // For simple "open chat" (no index), switch to existing tab if found
        if (options?.chatId && options.index === undefined) {
            const existing = this.tabManager.findTabByChatId(options.chatId);
            if (existing) {
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
                return;
            }
        }

        if (!this.createTabIfNeeded()) return;

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
