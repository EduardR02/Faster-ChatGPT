import { auto_resize_textfield_listener, update_textfield_height } from "./utils.js";
import { ApiManager } from "./api_manager.js";
import { ChatStorage } from './chat_storage.js';
import { SidepanelStateManager } from './state_manager.js';
import { SidepanelChatUI } from './chat_ui.js';
import { SidepanelController } from './sidepanel_controller.js';

class SidepanelApp {
    constructor() {
        this.stateManager = new SidepanelStateManager('chat_prompt');
        this.apiManager = new ApiManager();
        this.chatStorage = new ChatStorage();

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
    }

    initEventListeners() {
        auto_resize_textfield_listener('textInput');
        this.initInputListener();
        this.initArenaToggleButton();
        this.initThinkingModeButton();
        this.initFooterButtons();
        this.initTextareaImageHandling();
        this.setupMessageListeners();
        this.stateManager.subscribeToChatReset("chat", () => {this.handleNewChat()});
        this.initSonnetThinking();
        this.stateManager.runOnReady(() => {this.initModelPicker()});
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
        if (!this.stateManager.isOn()) return;
        
        if (this.controller.chatCore.getSystemPrompt() === undefined) {
            await this.initPrompt({ mode: "chat" });
        }
        this.controller.sendUserMessage();
    }

    async initPrompt(context) {
        await this.controller.initPrompt(context);
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
        const hasChatStarted = () => this.controller.chatCore.hasChatStarted();
        this.chatUI.setupIncognitoButtonHandlers(incognitoToggle, buttonFooter, hoverText, hasChatStarted);
        this.chatUI.updateIncognitoButtonVisuals(incognitoToggle);
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
                    this.handleReconstructChat(msg.options);
                    break;
            }
        });
    }

    async handleNewSelection(text, url) {
        this.stateManager.subscribeToChatReset("chat", () => {this.handleNewSelection(text, url)});
        const hostname = new URL(url).hostname;
        this.controller.initStates(`Selection from ${hostname}`);
        this.chatUI.clearConversation();
        this.chatUI.addSystemMessage(text, `Selected Text - site:${hostname}`);
        
        await this.initPrompt({ mode: "selection", text, url });
        
        if (this.stateManager.isInstantPromptMode()) {
            this.controller.chatCore.addUserMessage("Please explain!");
            this.controller.initApiCall();
        }
    }

    handleNewChat() {
        this.stateManager.subscribeToChatReset("chat", () => {this.handleNewChat()});
        this.controller.initStates("New Chat");
        this.chatUI.clearConversation();
        if (this.stateManager.isInstantPromptMode()) {
            this.chatUI.addWarningMessage("Warning: Instant prompt mode does not make sense in chat mode and will be ignored.");
        }
        this.initPrompt({ mode: "chat" });
    }

    async handleReconstructChat(options) {
        const newChatName = options.chatId ? "Continued Chat" : "New Chat";
        // no clearConversation here because it's handled in buildChat, and we want to do it as late as possible to avoid a flicker
        this.controller.initStates(newChatName);
        this.stateManager.isSidePanel = options.isSidePanel === false ? false : true;
        if (!options.chatId && !options.pendingUserMessage) {
            if (options.systemPrompt) this.controller.chatCore.insertSystemMessage(options.systemPrompt);
            this.chatUI.clearConversation();
            return;
        }

        let lastMessage = null;
        if (options.chatId) {
            const messageLimit = options.index !== undefined ? options.index + 1 : null;
            const chat = await this.chatStorage.loadChat(options.chatId, messageLimit);
            const fullChatLength = await this.chatStorage.getChatLength(options.chatId);
            lastMessage = chat.messages.at(-1);
            const secondaryLength = lastMessage?.contents ? lastMessage.contents.length : lastMessage?.responses[options.modelChoice || 'model_a']?.messages?.length;
            this.controller.chatCore.buildFromDB(chat, null, options.secondaryIndex, options.modelChoice);
            this.chatUI.updateIncognito(this.controller.chatCore.hasChatStarted());
            this.chatUI.buildChat(this.controller.chatCore.getChat());
            const continueOptions = { fullChatLength, lastMessage, index: options.index, modelChoice: options.modelChoice, secondaryIndex: options.secondaryIndex, secondaryLength };
            this.controller.chatCore.continuedChatOptions = continueOptions;
        }

        if (options.systemPrompt) this.controller.chatCore.insertSystemMessage(options.systemPrompt);
        // the case where the user clicks to continue from a user message, but has something typed in the textarea is ambiguous...
        // here i decided to prioritize the clicked message, but it could be changed to prioritize the "pending" message
        if (lastMessage?.role !== "user") lastMessage = options.pendingUserMessage;  // important
        this.handleIfLastUserMessage(lastMessage || options.pendingUserMessage);
    }

    handleIfLastUserMessage(lastMessage) {
        if (lastMessage && lastMessage.role === "user") {
            if (lastMessage.images) this.controller.appendPendingMedia(lastMessage.images, 'image');
            if (lastMessage.files) this.controller.appendPendingMedia(lastMessage.files, 'file');
            if (lastMessage.contents) this.chatUI.setTextareaText(lastMessage.contents.at(-1).at(-1).content);
        }
        else {
            this.chatUI.setTextareaText('');
        }
    }

    // Popout handling methods
    async handlePopoutToggle() {
        const index = Math.max(this.controller.chatCore.getLength() - 1, 0);
        const options = {
            chatId: this.controller.chatCore.getChatId(),
            isSidePanel: !this.stateManager.isSidePanel,
            index,
            pendingUserMessage: this.controller.collectPendingUserMessage()
        };
        // check for arena message
        const latestMessage = this.controller.chatCore.getLatestMessage();
        if (latestMessage?.responses) {
            const modelChoice = latestMessage.continued_with && latestMessage.continued_with !== "none" ? latestMessage.continued_with : 'model_a';
            options.secondaryIndex = latestMessage.responses[modelChoice].messages.length - 1;
            options.modelChoice = modelChoice;
        }
        if (latestMessage?.role === 'assistant') options.secondaryIndex = latestMessage.contents.length - 1;
        if (!options.chatId) options.systemPrompt = this.controller.chatCore.getSystemPrompt();

        if (this.stateManager.isSidePanel) {
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
            const items = Array.from(e.clipboardData.items);
    
            // Extract all files from the paste event
            const files = items
                .filter(item => item.kind === 'file') // Ensure it's a file
                .map(item => item.getAsFile())        // Convert to File objects
                .filter(file => file !== null);       // Filter out null values

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
                    this.controller.appendPendingMedia([base64String], 'image');
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
                this.controller.appendPendingMedia([e.target.result], 'image');
                resolve();
            };
            reader.readAsDataURL(file);
        });
    }

    handleTextFile(file) {
        return new Promise(resolve => {
            const reader = new FileReader();
            reader.onload = e => {
                this.controller.appendPendingMedia([{ name: file.name, content: e.target.result }], 'file');
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
            const value = textarea.value.slice(0, start) + 
                           text + 
                           textarea.value.slice(textarea.selectionEnd);
            this.chatUI.setTextareaText(value);
        }
    }

    initSonnetThinking() {
        const sonnetThinkButton = document.getElementById('sonnet-thinking-toggle');
        if (!sonnetThinkButton) return;

        sonnetThinkButton.style.display = 'none'; // Start hidden

        sonnetThinkButton.addEventListener('click', () => {
            this.apiManager.shouldSonnetThink = !this.apiManager.shouldSonnetThink;
            sonnetThinkButton.classList.toggle('active', this.apiManager.shouldSonnetThink);
        });

        const updateSonnetThinkingButton = () => {
            let model = this.stateManager.getSetting('current_model');
            const isSonnet = model && model.includes('3-7-sonnet', 'sonnet-4', 'opus-4');
            
            if (isSonnet) {
                sonnetThinkButton.style.display = 'flex'; // Use flex to show
                sonnetThinkButton.classList.toggle('active', this.apiManager.shouldSonnetThink);
            } else {
                sonnetThinkButton.style.display = 'none'; // Hide
                this.apiManager.shouldSonnetThink = false; // Reset flag if not Sonnet
            }
            // Trigger height update when visibility changes
            update_textfield_height(document.getElementById('textInput'));
        };

        this.stateManager.runOnReady(updateSonnetThinkingButton);
        this.stateManager.subscribeToSetting('current_model', updateSonnetThinkingButton);
    }

    initModelPicker() {
        // Container div for the popup, now positioning context
        const controlsContainer = document.querySelector('.textarea-bottom-left-controls');
        const pickerBtn = document.getElementById('model-picker-toggle');
        // Popup will be created and appended later

        if (!pickerBtn || !controlsContainer) return;

        // --- Ensure container is positioned for relative absolute positioning ---
        // This makes controlsContainer the reference for the popup's position.
        const containerStyle = window.getComputedStyle(controlsContainer);
        if (containerStyle.position === 'static') {
            controlsContainer.style.position = 'relative';
        }


        // --- Build Model List ---
        const modelsObj = this.stateManager.getSetting('models') || {};
        const modelArr = [];
        for (const provider in modelsObj) {
            for (const apiName in modelsObj[provider]) {
                modelArr.push({ apiName, display: modelsObj[provider][apiName] });
            }
        }

        // --- Create Popup DOM ---
        const popup = document.createElement('div');
        popup.id = 'model-picker-popup';
        // Ensure CSS for .model-picker-popup includes 'position: absolute;'
        popup.className = 'model-picker-popup';
        const ul = document.createElement('ul');
        modelArr.forEach(m => {
            const li = document.createElement('li');
            li.textContent = m.display;
            li.addEventListener('click', (e) => {
                e.stopPropagation();
                this.stateManager.updateSettingsLocal({ current_model: m.apiName });
                popup.style.display = 'none'; // Hide on selection
            });
            ul.appendChild(li);
        });
        popup.appendChild(ul);
        // --- Append popup to the CONTROLS CONTAINER ---
        // This anchors the popup's position relative to the controls near the button.
        controlsContainer.appendChild(popup);
        popup.style.display = 'none'; // Start hidden


        // --- Button Text Update --- (No changes needed here)
        const updateButtonText = (key) => {
             const currentDisp = modelArr.find(x => x.apiName === key)?.display || key;
             // Ensure the down arrow symbol is consistently applied
             pickerBtn.textContent = `${currentDisp} \u25BE`; // Using unicode for down arrow
        }
        this.stateManager.runOnReady(() => {
             updateButtonText(this.stateManager.getSetting('current_model'));
        });
         this.stateManager.subscribeToSetting('current_model', updateButtonText);


        // --- Toggle Popup Visibility & Position (Revised Logic) ---
        pickerBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const isOpen = popup.style.display === 'flex';

            if (isOpen) {
                popup.style.display = 'none';
            } else {
                // --- Calculate necessary dimensions ---
                // Use offset properties for positioning relative to the container
                const buttonTopRelContainer = pickerBtn.offsetTop;
                const buttonHeight = pickerBtn.offsetHeight;

                // Temporarily display off-screen to measure its height accurately
                popup.style.visibility = 'hidden';
                popup.style.display = 'flex'; // Use 'flex' as per original code/CSS
                const popupHeight = popup.offsetHeight;
                popup.style.display = 'none'; // Hide again before positioning
                popup.style.visibility = 'visible';

                // --- Determine direction based on viewport space ---
                // Use viewport rect just to decide up/down direction
                const buttonRectViewport = pickerBtn.getBoundingClientRect();
                const spaceBelowViewport = window.innerHeight - buttonRectViewport.bottom;
                const spaceAboveViewport = buttonRectViewport.top;

                let popupTopStyle = 'auto';
                let popupBottomStyle = 'auto';

                // Prefer positioning below the button
                if (spaceBelowViewport >= popupHeight || spaceBelowViewport >= spaceAboveViewport) {
                    // Set top relative to container: button's top + button's height + gap
                    popupTopStyle = `${buttonTopRelContainer + buttonHeight + 5}px`;
                }
                // Position above the button
                else {
                    // Set bottom relative to container: container height - button's top + gap
                    // This positions the popup's bottom edge 5px above the button's top edge.
                    popupBottomStyle = `${controlsContainer.offsetHeight - buttonTopRelContainer + 5}px`;
                }

                // --- Apply styles ---
                popup.style.top = popupTopStyle;
                popup.style.bottom = popupBottomStyle;
                // Align left edge of popup with left edge of button (relative to container)
                popup.style.left = `${pickerBtn.offsetLeft}px`;
                // Ensure width constraints if needed (e.g., via CSS max-width or min-width)
                // popup.style.minWidth = `${pickerBtn.offsetWidth}px`; // Optional: Match button width

                popup.style.display = 'flex'; // Show the popup
            }
        });

        // --- Close Popup on Outside Click --- (No changes needed here)
        document.addEventListener('click', (e) => {
            // Check if the click is outside the popup AND outside the toggle button
            if (popup.style.display === 'flex' && !popup.contains(e.target) && !pickerBtn.contains(e.target)) {
                popup.style.display = 'none';
            }
        });
    }
}


// Initialize the application when the DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    new SidepanelApp();
    chrome.runtime.sendMessage({ type: "sidepanel_ready" });
});