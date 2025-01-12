import { ChatStorage, auto_resize_textfield_listener } from "./utils.js";
import { ApiManager } from "./api_manager.js";
import { SidepanelStateManager } from './state_manager.js';
import { SidepanelChatUI } from './chat_ui.js';
import { SidepanelController } from './sidepanel_controller.js';

class SidepanelApp {
    constructor() {
        this.stateManager = new SidepanelStateManager('chat_prompt');
        this.apiManager = new ApiManager();
        this.chatStorage = new ChatStorage();
        this.arenaRatingManager = null;

        this.chatUI = new SidepanelChatUI({
            stateManager: this.stateManager
        });

        this.controller = new SidepanelController({
            stateManager: this.stateManager,
            chatUI: this.chatUI,
            apiManager: this.apiManager,
            chatStorage: this.chatStorage
        });

        this.initEventListeners();
        this.initArenaRatingManager();
    }

    initEventListeners() {
        auto_resize_textfield_listener('textInput');
        this.initInputListener();
        this.initArenaToggleButton();
        this.initThinkingModeButton();
        this.initFooterButtons();
        this.initTextareaImageHandling();
        this.setupMessageListeners();
    }

    initArenaRatingManager() {
        if (!this.arenaRatingManager) {
            this.arenaRatingManager = new ArenaRatingManager();
            this.arenaRatingManager.initDB();
        }
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

    handleInput(inputField) {
        const inputText = inputField.value.trim();
        if (inputText.length === 0 || !this.stateManager.isOn()) return;

        this.controller.handleDefaultArenaChoice();
        this.chatUI.addMessage('user', inputText);
        this.controller.resolvePending();
        this.controller.appendContext(inputText, 'user');
        
        if (this.stateManager.isSettingsEmpty() || this.controller.messages[0]?.role !== "system") {
            this.initPrompt("chat").then(() => {
                if (this.stateManager.isOn()) {
                    this.controller.appendContext(inputText, 'user');
                    this.controller.initApiCall();
                }
            });
        } else {
            this.chatUI.removeRegenerateButtons();
            this.controller.initApiCall();
        }

        inputField.value = '';
        this.chatUI.updateTextareaHeight(inputField);
    }

    async initPrompt(mode) {
        const context = { mode };
        return this.controller.initPrompt(context);
    }

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
            this.stateManager.toggleThinkingMode();
            button.classList.toggle('thinking-mode-on', this.stateManager.pendingThinkingMode);
        });
    }

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

        this.setupIncognitoButtonHandlers(incognitoToggle, buttonFooter, hoverText);
        this.updateIncognitoButtonVisuals(incognitoToggle);
    }

    setupIncognitoButtonHandlers(button, footer, hoverText) {
        button.addEventListener('mouseenter', () => {
            this.updateIncognitoHoverText(hoverText);
            footer.classList.add('showing-text');
        });

        button.addEventListener('mouseleave', () => {
            footer.classList.remove('showing-text');
            this.handleIncognitoHoverTextTransition(hoverText);
        });

        button.addEventListener('click', () => {
            const hasChatStarted = this.controller.messages.length > 1;
            this.stateManager.toggleChatState(hasChatStarted);
            this.updateIncognitoHoverText(hoverText);
            this.updateIncognitoButtonVisuals(button);
        });
    }

    initPopoutToggle() {
        const button = document.getElementById('pop-out-toggle');
        button.addEventListener('click', async () => {
            await this.handlePopoutToggle();
        });
    }

    setupMessageListeners() {
        chrome.runtime.onMessage.addListener((msg) => {
            if (!this.stateManager.isOn()) return;
            
            switch (msg.type) {
                case 'new_selection':
                    this.handleNewSelection(msg.text, msg.url);
                    break;
                case 'new_chat':
                    this.handleNewChat();
                    break;
                case 'reconstruct_chat':
                    this.handleReconstructChat(msg.options, msg.isSidePanel);
                    break;
            }
        });
    }

    async handleNewSelection(text, url) {
        await this.controller.initStates(`Selection from ${url}`);
        this.chatUI.createSystemMessage(text, "Selected text");
        
        await this.initPrompt({ mode: "selection", text, url });
        
        if (this.stateManager.isInstantPromptMode()) {
            this.controller.appendContext("Please explain!", 'user');
            this.controller.initApiCall();
        }
    }

    handleNewChat() {
        if (this.stateManager.isInstantPromptMode()) {
            this.chatUI.addWarningMessage("Warning: Instant prompt mode does not make sense in chat mode and will be ignored.");
        }
        this.controller.messages = [];
        this.controller.initStates("New Chat");
        this.initPrompt({ mode: "chat" });
    }

    async handleReconstructChat(options, isSidePanel) {
        if (!options.chatId) return;
        
        await this.controller.initStates("Continued Chat");
        this.stateManager.isSidePanel = isSidePanel === false ? false : true;

        const chat = await this.chatStorage.loadChat(options.chatId);
        this.controller.buildAPIChatFromHistoryFormat(chat, options.index, options.arenaMessageIndex, options.modelChoice);
        this.chatUI.buildChat(chat);
    }

    // Incognito handling methods
    updateIncognitoButtonVisuals(button) {
        button.classList.toggle('active', !this.stateManager.shouldSave);
    }

    updateIncognitoHoverText(hoverText) {
        const [hoverTextLeft, hoverTextRight] = hoverText;
        const hasChatStarted = this.controller.messages.length > 1;

        let leftText = "start new";
        let rightText = "incognito chat";

        if (hasChatStarted && this.stateManager.isChatNormal()) {
            leftText = "continue";
            rightText = "in incognito";
        } else if (!hasChatStarted && this.stateManager.isChatIncognito()) {
            leftText = "leave";
            rightText = "incognito";
        } else if (hasChatStarted && this.stateManager.isChatIncognito()) {
            leftText = "actually,";
            rightText = "save it please";
        }

        hoverTextLeft.textContent = leftText;
        hoverTextRight.textContent = rightText;

        const longestText = Math.max(hoverTextLeft.offsetWidth, hoverTextRight.offsetWidth);
        hoverText.forEach(text => text.style.width = `${longestText}px`);
    }

    handleIncognitoHoverTextTransition(hoverText) {
        hoverText.forEach(label => {
            const handler = (event) => {
                if (!label.parentElement.classList.contains('showing-text')) {
                    label.textContent = "";
                    label.style.width = "auto";
                }
                label.removeEventListener('transitionend', handler);
            };
            label.addEventListener('transitionend', handler);
        });
    }

    // Popout handling methods
    async handlePopoutToggle() {
        this.controller.resolvePending();
        
        if (this.controller.currentChat && this.controller.currentChat.messages.length === 0) {
            this.controller.currentChat.messages = [...this.controller.messages];
        }
        
        if (!this.controller.currentChat) {
            this.controller.currentChat = [];
        }

        if (this.stateManager.isSidePanel) {
            await this.handleSidepanelToTab();
        } else {
            await this.handleTabToSidepanel();
        }
    }

    async handleSidepanelToTab() {
        // Create new tab
        chrome.tabs.create({
            url: chrome.runtime.getURL('src/html/sidepanel.html')
        });

        // Wait for the new tab to be ready
        await new Promise(resolve => {
            chrome.runtime.onMessage.addListener(function listener(message) {
                if (message.type === "sidepanel_ready") {
                    chrome.runtime.onMessage.removeListener(listener);
                    resolve();
                }
            });
        });

        // Send chat data to new tab
        chrome.runtime.sendMessage({
            type: "reconstruct_chat",
            chat: this.controller.currentChat,
            isSidePanel: false
        });

        window.close();
    }

    async handleTabToSidepanel() {
        const response = await chrome.runtime.sendMessage({ type: "is_sidepanel_open" });

        if (!response.isOpen) {
            await chrome.runtime.sendMessage({ type: "open_side_panel" });
        }

        await chrome.runtime.sendMessage({
            type: "reconstruct_chat",
            chat: this.controller.currentChat,
            isSidePanel: true
        });

        window.close();
    }

    // Media handling methods
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
            const items = e.clipboardData.items;
            const imageItem = Array.from(items).find(item => item.type.startsWith('image/'));

            if (imageItem) {
                e.preventDefault();
                const file = imageItem.getAsFile();
                const reader = new FileReader();
                reader.onload = e => this.chatUI.appendImage(e.target.result);
                reader.readAsDataURL(file);
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
                    this.chatUI.appendImage(base64String);
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
                this.chatUI.appendImage(e.target.result);
                resolve();
            };
            reader.readAsDataURL(file);
        });
    }

    handleTextFile(file) {
        return new Promise(resolve => {
            const reader = new FileReader();
            reader.onload = e => {
                const fileData = {
                    tempId: this.controller.tempMediaId++,
                    name: file.name,
                    content: e.target.result
                };
                this.controller.pendingFiles.push(fileData);
                this.chatUI.appendFile(fileData);
                resolve();
            };
            reader.onerror = error => {
                this.chatUI.addErrorMessage(`Error: ${error.message}`);
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
        try {
            const response = await fetch(url);
            const blob = await response.blob();
            return new Promise(resolve => {
                const reader = new FileReader();
                reader.onload = e => resolve(e.target.result);
                reader.readAsDataURL(blob);
            });
        } catch (error) {
            this.chatUI.addErrorMessage(`Error converting image to base64: ${error.message}`);
            return null;
        }
    }

    handleTextDrop(e, textarea) {
        const text = e.dataTransfer.getData('text');
        if (text) {
            const start = textarea.selectionStart;
            textarea.value = textarea.value.slice(0, start) + 
                           text + 
                           textarea.value.slice(textarea.selectionEnd);
            this.chatUI.updateTextareaHeight(textarea);
        }
    }
}


let app = null;

// Initialize the application when the DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    app = new SidepanelApp();
    chrome.runtime.sendMessage({ type: "sidepanel_ready" });
});