import { Footer, createElementWithClass, add_codeblock_html } from './utils.js';


class ChatUI {
    constructor(options) {
        const {
            conversationWrapperId = 'conversation-wrapper',
            stateManager,
        } = options;

        this.conversationDiv = document.getElementById(conversationWrapperId);
        this.stateManager = stateManager;
        this.pendingMediaDiv = null;

        this.roleLabels = {
            user: "You",
            assistant: "Assistant",
            system: "System"
        };
    }

    addMessage(role, content = '', options = {}) {
        if (role === 'user' && this.pendingMediaDiv) this.appendToExistingMessage(content);
        else this.conversationDiv.appendChild(this.createMessage(role, content, options));
    }

    // Core message creation methods
    createMessage(role, content = '', options = {}) {
        const { files, images, ...prefixOptions } = options;
        const messageBlock = createElementWithClass('div', `${role}-message`);

        const prefixWrapper = this.createPrefixWrapper(role, prefixOptions);
        const messageWrapper = this.createMessageWrapper(role, content, { files, images });

        messageBlock.appendChild(prefixWrapper);
        messageBlock.appendChild(messageWrapper);

        return messageBlock;
    }

    createMessageWrapper(role, content, { files, images } = {}) {
        const wrapper = createElementWithClass('div', 'message-wrapper');

        if (images?.length) {
            images.forEach(img => wrapper.appendChild(this.createImageContent(img, role)));
        }

        if (files?.length) {
            files.forEach(file => wrapper.appendChild(this.createFileDisplay(file)));
        }

        wrapper.appendChild(this.createContentDiv(role, content));

        return wrapper;
    }

    createPrefixWrapper(role, options) {
        const wrapper = createElementWithClass('div', 'history-prefix-wrapper');
        const prefix = createElementWithClass('span', `message-prefix ${role}-prefix`);
        prefix.textContent = this.generatePrefixText(role, options);

        wrapper.appendChild(prefix);
        if (options.continueFunc) {
            const button = this.createContinueButton(options.continueFunc);
            wrapper.appendChild(button);
        }
        return wrapper;
    }

    generatePrefixText(role, options) {
        const { model, isRegeneration = false, hideModels = true } = options;
        let prefix = this.roleLabels[role];

        if (role === 'assistant') {
            prefix = hideModels ? prefix : model;
            if (isRegeneration) prefix += ' ⟳';
            if (this.stateManager.isThinking(model)) prefix += ' 🧠';
            else if (this.stateManager.isSolving(model)) prefix += ' 💡';
        }

        return prefix;
    }

    createSystemMessage(content, title = 'System Prompt') {
        const messageDiv = createElementWithClass('div', 'history-system-message collapsed');
        const toggleButton = createElementWithClass('button', 'message-prefix system-toggle system-prefix history-sidebar-item');
        const toggleIcon = createElementWithClass('span', 'toggle-icon', '⯈');
        const contentDiv = createElementWithClass('div', 'message-content history-system-content');

        contentDiv.innerHTML = add_codeblock_html(content);
        toggleButton.append(toggleIcon, title);
        toggleButton.onclick = () => messageDiv.classList.toggle('collapsed');
        messageDiv.append(toggleButton, contentDiv);

        return messageDiv;
    }

    addSystemMessage(content, title = 'System Prompt') {
        this.conversationDiv.appendChild(this.createSystemMessage(content, title));
    }

    // reconstruction of the chat
    buildChat(chat, options = {}) {
        const { hideModels = false, continueFunc = null, startIndex = 0, endIndex = null, addSystemMsg = false, skipLastUserMessage = false } = options;

        this.clearConversation();
        let previousRole = null;

        const messages = chat.messages.slice(
            startIndex,
            endIndex !== null ? endIndex + 1 : undefined
        );

        messages.forEach((message, index) => {
            if (message.role === 'user' && skipLastUserMessage && index === messages.length - 1) return;

            if (message.role === 'system') {
                if (!addSystemMsg) return;
                this.addSystemMessage(message.content);
                return;
            }

            if (message.responses) {
                this.createArenaMessageWrapperFunc(message, { continueFunc, messageIndex: index });
            } else {
                const new_options = { isRegeneration: previousRole === message.role, hideModels };
                if (continueFunc) new_options.continueFunc = () => continueFunc(index);
                const messageBlock = this.createMessageWrapperFunc(message, new_options);
                this.conversationDiv.appendChild(messageBlock);
            }
            previousRole = message.role;
            if (index !== messages.length - 1) this.pendingMediaDiv = null;
        });
    }

    // Arena Mode Methods
    createArenaMessage(message = {}, options = {}) {
        const { responses, role } = message || {};
        const messageBlock = createElementWithClass('div', `assistant-message`);
        const container = createElementWithClass('div', 'arena-full-container');
        messageBlock.appendChild(container);
        const arenaDivs = [null, null];

        ['model_a', 'model_b'].forEach((model, index) => {
            const arenaDiv = createElementWithClass('div', 'arena-wrapper');
            arenaDivs[index] = arenaDiv;
            container.appendChild(arenaDiv);
            let new_options = {
                model: this.stateManager.getArenaModel(index),
                isRegeneration: false,
                hideModels: true
            };
            if (responses) {
                responses[model].messages.forEach((msg, i) => {
                    new_options.isRegeneration = i !== 0;
                    if (options.continueFunc) new_options.continueFunc = () => options.continueFunc(options.messageIndex, i, model);
                    arenaDiv.appendChild(this.createMessage(role, msg, new_options));
                });
            }
            else {
                if (options.continueFunc) new_options.continueFunc = () => options.continueFunc(options.messageIndex, 0, model);
                arenaDiv.appendChild(this.createMessage('assistant', '', new_options));
            }
        });
        this.conversationDiv.appendChild(messageBlock);
        return arenaDivs;
    }

    resolveArena(choice, continued_with, arenaDivs) {
        // !!! sidepanel child function only has 2 params, uses class internal for arena divs
        const modelKeys = ['model_a', 'model_b'];
        arenaDivs.forEach((wrapper, index) => {
            const className = continued_with === modelKeys[index] ? 'arena-winner' : 'arena-loser';
            wrapper.querySelectorAll('.assistant-message').forEach(message => {
                message.querySelector('.message-content').classList.add(className);
                const prefix = message.querySelector('.message-prefix');
                prefix.textContent = this.formatArenaPrefix(prefix.textContent, this.stateManager.getArenaModel(index), choice, modelKeys[index]);
            });
        });
    }

    formatArenaPrefix(currentText, modelName, choice, modelKey) {
        let suffix = '';
        if (choice) {
            switch (choice) {
                case modelKey: suffix = ' 🏆'; break;
                case 'draw': suffix = ' 🤝'; break;
                case 'reveal': suffix = ' 👁️'; break;
                case 'ignored': suffix = ' n/a'; break;
                default: suffix = ' ❌';    // loser or bothbad
            }
        }
        return currentText.replace(this.roleLabels.assistant, modelName) + suffix;
    }

    // UI Component Creation Methods
    createContentDiv(role, content) {
        const div = createElementWithClass('div', `message-content ${role}-content`);
        if (content) div.innerHTML = add_codeblock_html(content);
        return div;
    }

    createImageContent(imageUrl, role) {
        const wrapper = createElementWithClass('div', `image-content ${role}-content`);
        const img = document.createElement('img');
        img.src = imageUrl;
        wrapper.appendChild(img);
        return wrapper;
    }

    createFileDisplay(file, onRemove) {
        const fileDiv = createElementWithClass('div', 'history-system-message collapsed');
        const buttonsWrapper = createElementWithClass('div', 'file-buttons-wrapper');

        const toggleButton = this.createFileToggleButton(file.name);
        buttonsWrapper.appendChild(toggleButton);

        if (onRemove) {
            const removeButton = this.createRemoveFileButton(() => {
                fileDiv.remove();
                onRemove();  // handle file logic removal
            });
            buttonsWrapper.appendChild(removeButton);
        }

        const contentDiv = createElementWithClass('div', 'history-system-content user-file', file.content);
        fileDiv.append(buttonsWrapper, contentDiv);

        return fileDiv;
    }

    // Media Handling Methods
    initPendingMedia() {
        if (this.pendingMediaDiv) return;
        this.pendingMediaDiv = this.createMessage('user', '');
        this.pendingMediaDiv.querySelector('.message-content').remove();
        this.conversationDiv.appendChild(this.pendingMediaDiv);
    }

    appendImage(imageBase64) {
        this.initPendingMedia()
        const wrapper = this.pendingMediaDiv.querySelector('.message-wrapper');
        const imgContent = this.createImageContent(imageBase64, 'user');
        wrapper.appendChild(imgContent);
    }

    appendFile(file, onRemove = null) {
        this.initPendingMedia()
        const wrapper = this.pendingMediaDiv.querySelector('.message-wrapper');
        const fileDisplay = this.createFileDisplay(file, onRemove);
        wrapper.appendChild(fileDisplay);
    }

    removeFile(fileId) {
        const button = document.getElementById(`remove-file-${fileId}`);
        if (button) button.closest('.history-system-message').remove();
    }

    appendToExistingMessage(content) {
        if (!content.trim()) return;
        const wrapper = this.pendingMediaDiv.querySelector('.message-wrapper');
        const contentDiv = this.createContentDiv('user', content);
        wrapper.appendChild(contentDiv);
        this.pendingMediaDiv = null;
    }

    // Utility Methods
    createContinueButton(func) {
        const button = createElementWithClass('button', 'unset-button continue-conversation-button', '\u{2197}');
        button.onclick = func;
        return button;
    }

    createFileToggleButton(fileName) {
        const button = createElementWithClass('button', 'message-prefix system-toggle system-prefix history-sidebar-item');
        const icon = createElementWithClass('span', 'toggle-icon', '⯈');
        button.append(icon, fileName);
        button.onclick = () => button.closest('.history-system-message').classList.toggle('collapsed');
        return button;
    }

    createRemoveFileButton(onClickHandler) {
        const button = createElementWithClass('button', 'unset-button rename-cancel remove-file-button', '✕');
        button.onclick = onClickHandler;
        return button;
    }

    clearConversation() {
        this.conversationDiv.innerHTML = '';
        this.pendingMediaDiv = null;
    }

    createArenaMessageWrapperFunc(message, options = {}) {
        this.stateManager.initArenaResponse(message.responses['model_a'].name, message.responses['model_b'].name);
        const arenaDivs = this.createArenaMessage(message, options);
        this.resolveArena(message.choice, message.continued_with, arenaDivs);
        this.stateManager.clearArenaState();
        return arenaDivs;
    }

    createMessageWrapperFunc(message, options = {}) {
        const { role, content, ...rest } = message;
        return this.createMessage(role, content, { ...rest, ...options});
    }
}


export class SidepanelChatUI extends ChatUI {
    constructor(options) {
        const {
            inputWrapperId = '.textarea-wrapper',
            scrollElementId = 'conversation',
            ...baseOptions
        } = options;

        super(baseOptions);

        // Scroll behavior
        this.scrollToElement = document.getElementById(scrollElementId);
        this.shouldScroll = true;
        this.scrollListenerActive = false;

        this.activeMessageDivs = null;  // Single div for normal mode, array [modelA, modelB] for arena
        this.inputWrapper = document.querySelector(inputWrapperId);
        this.textarea = this.inputWrapper.querySelector('textarea');
        this.initResize();
    }

    initResize() {
        this.textarea.addEventListener('input', () => this.updateTextareaHeight());
    }

    updateTextareaHeight() {
        this.textarea.style.height = 'auto';
        let buttonArea = document.querySelector('.chatbox-button-container');
        let buttonAreaHeight = buttonArea ? buttonArea.offsetHeight : 0;
        this.textarea.style.height = (Math.max(this.textarea.scrollHeight, buttonAreaHeight)) + 'px';
    }

    setTextareaText(text) {
        this.textarea.value = text;
        this.updateTextareaHeight();
    }

    addMessage(role, content = '', options = {}) {
        super.addMessage(role, content, options);
        this.scrollIntoView();
    }

    createMessage(role, content, options = {}) {
        const message = super.createMessage(role, content, options);
        if (!this.stateManager.isArenaModeActive) {
            this.activeMessageDivs = message;
        }
        return message;
    }

    createArenaMessage(message = null, options = {}) {
        this.activeMessageDivs = super.createArenaMessage(message, options);
        this.scrollIntoView();
        return this.activeMessageDivs;
    }

    regenerateResponse(model) {
        const newMessage = this.createMessage('assistant', '', { model, isRegeneration: true });
        if (this.stateManager.isArenaModeActive) {
            const modelIndex = this.getArenaIndex(model);
            if (modelIndex === -1) return null;
            this.activeMessageDivs[modelIndex].appendChild(newMessage);
        } else {
            this.conversationDiv.appendChild(newMessage);
        }
        return newMessage.querySelector('.message-content');
    }

    removeCurrentRemoveMediaButtons() {
        const buttons = this.conversationDiv.lastChild.querySelectorAll('.remove-file-button');
        buttons.forEach(button => button.remove());
    }


    addMessageFooter(contentDiv, options) {
        const footer = new Footer(
            options.inputTokens,
            options.outputTokens,
            this.stateManager.isArenaModeActive,
            options.thoughtProcessState,
            () => options.onRegenerate(contentDiv)
        );
        footer.create(contentDiv);
    }

    buildChat(chat) {
        // Hide models and disable continue buttons for sidepanel
        this.shouldScroll = false;
        super.buildChat(chat, {
            hideModels: true,
            skipLastUserMessage: true
        });
        this.shouldScroll = true;
        this.scrollIntoView();
    }

    addErrorMessage(message) {
        this.conversationDiv.appendChild(this.createSystemMessage(message, 'System Message: Error'));
    }

    addWarningMessage(message) {
        this.conversationDiv.appendChild(this.createSystemMessage(message, 'System Message: Warning'));
    }
    
    removeRegenerateButtons() {
        const buttons = document.querySelectorAll('.regenerate-button');
        buttons.forEach(button => {
            const parent = button.parentElement;
            button.remove();
            parent.classList.add('centered');
        });
    }

    // Scroll Handling
    scrollIntoView() {
        if (this.shouldScroll) {
            this.scrollToElement.scrollIntoView(false);
        }
    }

    initScrollListener() {
        if (!this.scrollListenerActive) {
            window.addEventListener('wheel', this.handleScroll.bind(this));
            this.scrollListenerActive = true;
        }
        this.shouldScroll = true;
    }

    handleScroll(event) {
        if (this.shouldScroll && event.deltaY < 0) {
            this.shouldScroll = false;
        }

        const threshold = 100;
        const distanceFromBottom = Math.abs(
            this.scrollToElement.scrollHeight - window.scrollY - window.innerHeight
        );

        if (!this.shouldScroll && event.deltaY > 0 && distanceFromBottom <= threshold) {
            this.shouldScroll = true;
        }
    }

    addArenaFooter(onChoice) {
        const container = this.activeMessageDivs[0].parentElement.parentElement;
        if (!container) return;

        const footer = createElementWithClass('div', 'arena-footer');
        const buttons = [
            { text: '\u{1F441}', choice: 'reveal', class: 'reveal' },
            { text: '\u{2713}', choice: 'model_a', class: 'choice' },
            { text: '==', choice: 'draw', class: 'draw' },
            { text: '\u{2713}', choice: 'model_b', class: 'choice' },
            { text: 'X', choice: 'no_choice(bothbad)', class: 'no-choice' }
        ];

        buttons.forEach(btn => {
            const button = createElementWithClass('button', `button arena-button ${btn.class}`);
            button.textContent = btn.text;
            button.onclick = () => {
                this.removeArenaFooter(footer);
                this.removeRegenerateButtons();
                onChoice(btn.choice);   // this should also call resolve arena after it's done, because here we don't know continued_with yet
            };
            this.setupArenaButtonHover(button);
            footer.appendChild(button);
        });

        container.appendChild(footer);
    }

    resolveArena(choice, continued_with) {
        super.resolveArena(choice, continued_with, this.activeMessageDivs);
        this.scrollIntoView();
        this.activeMessageDivs = null;
    }

    setupArenaButtonHover(button) {
        const updateOtherButtons = (isEnter) => {
            const allButtons = button.parentElement.querySelectorAll('button');
            allButtons.forEach(otherBtn => {
                if (otherBtn !== button) {
                    if (isEnter) {
                        if (otherBtn.classList.contains('choice')) {
                            otherBtn.classList.add('choice-not-hovered');
                            otherBtn.textContent = 'X';
                        } else {
                            otherBtn.classList.add('hovered');
                        }
                    } else {
                        if (otherBtn.classList.contains('choice')) {
                            otherBtn.classList.remove('choice-not-hovered');
                            otherBtn.textContent = '\u{2713}';
                        } else {
                            otherBtn.classList.remove('hovered');
                        }
                    }
                }
            });
        };

        button.addEventListener('mouseenter', () => updateOtherButtons(true));
        button.addEventListener('mouseleave', () => updateOtherButtons(false));
    }

    removeArenaFooter(footer) {
        footer.classList.add('slide-left');

        const handleTransitionEnd = (event) => {
            if (event.propertyName === 'opacity') {
                footer.classList.add('slide-up');
            } else if (event.propertyName === 'margin-top') {
                footer.removeEventListener('transitionend', handleTransitionEnd);
                footer.remove();
            }
        };

        footer.addEventListener('transitionend', handleTransitionEnd);
    }

    getArenaIndex(model) {
        return this.stateManager.state.activeArenaModels.findIndex(m => m === model);
    }

    getContentDivIndex(model) {
        if (!this.stateManager.isArenaModeActive) return 0;
        return this.getArenaIndex(model);
    }

    getContentDiv(model) {
        let nodes = null;
        if (!this.stateManager.isArenaModeActive) {
            nodes = this.activeMessageDivs.querySelectorAll('.message-content');
        } else {
            const modelIndex = this.getArenaIndex(model);
            nodes =  this.activeMessageDivs[modelIndex].querySelectorAll('.message-content');
        }
        return nodes[nodes.length - 1];
    }

    clearConversation() {
        super.clearConversation();
        this.activeMessageDivs = null;
        this.setTextareaText('');
    }
}


export class HistoryChatUI extends ChatUI {
    constructor(options) {
        const {
            continueFunc = () => { },
            addPopupActions,
            loadHistoryItems,
            loadChat,
            ...baseOptions
        } = options;

        super(baseOptions);
        this.historyList = this.stateManager.historyList;
        this.lastDateCategory = null;

        this.loadMore = this.loadMore.bind(this);
        this.handleHistoryScroll = this.handleHistoryScroll.bind(this);
        this.continueFunc = continueFunc;
        this.addPopupActions = addPopupActions;
        this.loadHistoryItems = loadHistoryItems;
        this.loadChat = loadChat;

        this.initHistoryListHandling();
    }

    async loadMore() {
        if (!this.stateManager.canLoadMore()) return;
        this.stateManager.isLoading = true;

        try {
            const items = await this.loadHistoryItems(
                this.stateManager.limit,
                this.stateManager.offset
            );

            if (items.length === 0) {
                this.stateManager.hasMoreItems = false;
                this.historyList.removeEventListener('scroll', this.handleHistoryScroll);
                return;
            }

            items.forEach(item => this.addHistoryItem(item));
            this.stateManager.offset += items.length;
        } finally {
            this.stateManager.isLoading = false;
            if (this.stateManager.shouldLoadMore()) {
                this.loadMore();
            }
        }
    }

    initHistoryListHandling() {
        this.historyList.addEventListener('scroll', this.handleHistoryScroll);
        this.loadMore();
    }

    handleHistoryScroll() {
        const { scrollTop, scrollHeight, clientHeight } = this.historyList;

        if (scrollHeight - (scrollTop + clientHeight) < 10 && this.stateManager.canLoadMore()) {
            this.loadMore();
        }
    }

    addHistoryItem(chat) {
        const currentCategory = this.getDateCategory(chat.timestamp);

        if (currentCategory !== this.lastDateCategory) {
            const divider = this.createDateDivider(currentCategory);
            this.historyList.appendChild(divider);
            this.lastDateCategory = currentCategory;
        }

        const item = this.createHistoryItem(chat);
        this.historyList.appendChild(item);
    }

    createHistoryItem(chat) {
        const item = createElementWithClass('button', 'unset-button history-sidebar-item');
        item.id = chat.chatId;

        const textSpan = createElementWithClass('span', 'item-text', chat.title);
        const dotsSpan = createElementWithClass('div', 'action-dots', '\u{22EF}');

        item.append(textSpan, dotsSpan);
        item.onclick = () => this.buildChat(chat);
        this.addPopupActions(item);

        return item;
    }

    handleNewChatSaved(chat) {
        const currentCategory = this.getDateCategory(chat.timestamp);
        const firstItem = this.historyList.firstElementChild;

        if (firstItem?.classList.contains('history-divider') &&
            firstItem.textContent === currentCategory) {
            const newItem = this.createHistoryItem(chat);
            this.historyList.insertBefore(newItem, firstItem.nextSibling);
        } else {
            const newItem = this.createHistoryItem(chat);
            const newDivider = this.createDateDivider(currentCategory, false);

            this.historyList.prepend(newItem);
            this.historyList.prepend(newDivider);

            if (firstItem?.classList.contains('history-divider')) {
                firstItem.style.paddingTop = '1rem';
            }
        }
    }

    appendMessages(newMessages, currentMessageIndex, lastRole) {
        let previousRole = lastRole;

        newMessages.forEach(message => {
            if (message.responses) {
                this.createArenaMessageWrapperFunc(message, { continueFunc: this.continueFunc, messageIndex: currentMessageIndex });
            } else {
                const options = { isRegeneration: previousRole === message.role, hideModels: false, continueFunc: () => this.continueFunc(currentMessageIndex) };
                const messageBlock = this.createMessageWrapperFunc(message, options);
                this.conversationDiv.appendChild(messageBlock);
            }
            currentMessageIndex++;
            previousRole = message.role;
            this.pendingMediaDiv = null;
        });
    }

    updateArenaMessage(updatedMessage, messageIndex) {
        const oldMessageElement = this.conversationDiv.children[messageIndex];

        if (oldMessageElement) {
            const newMessageElement = this.createArenaMessageWrapperFunc(updatedMessage, { continueFunc: this.continueFunc, messageIndex })[0].parentElement.parentElement;
            newMessageElement.remove(); // because createArenaMessage adds to conversationDiv
            this.conversationDiv.replaceChild(newMessageElement, oldMessageElement);
        }
    }

    createDateDivider(category, paddingTop = true) {
        const divider = createElementWithClass('div', 'history-divider', category);
        if (this.lastDateCategory !== null) {
            divider.style.paddingTop = '1rem';
        }
        if (!paddingTop) divider.style.paddingTop = '0';
        return divider;
    }


    getDateCategory(timestamp) {
        const date = new Date(timestamp);
        const now = new Date();
        
        // Get timestamps for midnights
        const dateMidnight = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
        const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
        const dayDiff = (todayMidnight - dateMidnight) / (1000 * 60 * 60 * 24);
        
        if (dayDiff === 0) return 'Today';
        if (dayDiff === 1) return 'Yesterday';
        if (dayDiff <= 7) return 'Last 7 Days';
        if (dayDiff <= 30) return 'Last 30 Days';
        
        if (date.getFullYear() === now.getFullYear()) {
            return date.toLocaleString('default', { month: 'long' });
        }
        
        return `${date.getFullYear()}`;
    }

    updateChatHeader(title) {
        document.getElementById('history-chat-header').textContent = title;
    }

    autoUpdateChatHeader(currentChat) {
        if (!currentChat) return null;
        const historyItem = document.getElementById(currentChat.meta.chatId)?.querySelector('.item-text');
        if (historyItem && historyItem.textContent !== "Renaming..." && historyItem.textContent !== "Rename failed") {
            this.updateChatHeader(historyItem.textContent);
            return historyItem.textContent;
        }
    }

    updateChatTimestamp(timestamp) {
        const date = new Date(timestamp);
        document.getElementById('history-chat-footer').textContent =
            date.toString().split(' GMT')[0];
    }

    async buildChat(chat) {
        // Show models and enable continue buttons for history
        const chatFull = await this.loadChat(chat.chatId);
        super.buildChat(chatFull, {
            hideModels: false,
            addSystemMsg: true,
            continueFunc: this.continueFunc
        });

        // Additional history-specific updates
        this.updateChatHeader(chatFull.meta.title);
        this.updateChatTimestamp(chat.timestamp);
    }
}