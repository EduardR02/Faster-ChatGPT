import { createElementWithClass, add_codeblock_html } from './utils.js';


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

    addMessage(role, parts = [], options = {}) {
        if (role === 'user' && this.pendingMediaDiv) this.appendToExistingMessage(parts);
        else this.conversationDiv.appendChild(this.createMessage(role, parts, options));
    }

    // Core message creation methods
    createMessage(role, parts = [], options = {}) {
        const { files, images, ...prefixOptions } = options;
        if (parts.length > 0 && parts.at(-1).model) prefixOptions.model = parts.at(-1).model;
        const messageBlock = createElementWithClass('div', `${role}-message`);

        const prefixWrapper = this.createPrefixWrapper(role, prefixOptions);
        const messageWrapper = this.createMessageWrapper(role, parts, { files, images });

        messageBlock.appendChild(prefixWrapper);
        messageBlock.appendChild(messageWrapper);

        return messageBlock;
    }

    createMessageWrapper(role, parts, { files, images } = {}) {
        const wrapper = createElementWithClass('div', 'message-wrapper');

        if (images?.length) {
            images.forEach(img => wrapper.appendChild(this.createImageContent(img, role)));
        }

        if (files?.length) {
            files.forEach(file => wrapper.appendChild(this.createFileDisplay(file)));
        }
        if (parts.length === 0) wrapper.appendChild(this.createContentDiv(role, ''));
        else parts.forEach(part => wrapper.appendChild(this.produceNextContentDiv(role, part.type === 'thought', part.content)));

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
        const { hideModels = false, continueFunc = null, addSystemMsg = false } = options;
        this.clearConversation();

        chat.messages.forEach((message, index) => {
            if (message.responses) {
                this.createArenaMessageWrapperFunc(message, { continueFunc, messageIndex: index });
            } else {
                if (!addSystemMsg && message.role === 'system') return;
                this.addFullMessage(message, hideModels, index, continueFunc);
            }
            if (index !== chat.messages.length - 1) this.pendingMediaDiv = null;
        });
    }

    addFullMessage(message, hideModels = false, index = null, continueFunc = null) {
        const { contents, timestamp, chatId, messageId, ...rest } = message;
        message.contents.forEach((parts, secIdx) => {
            const new_options = { hideModels, ...rest };
            if (continueFunc) new_options.continueFunc = () => continueFunc(index, secIdx);
            if (secIdx !== 0) new_options.isRegeneration = true;
            const messageBlock = this.createMessageWrapperFunc(parts, new_options);
            // due to system message being directly added / being a "full message"
            if (messageBlock) this.conversationDiv.appendChild(messageBlock);
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
                responses[model].messages.forEach((parts, i) => {
                    new_options.isRegeneration = i !== 0;
                    if (options.continueFunc) new_options.continueFunc = () => options.continueFunc(options.messageIndex, i, model);
                    arenaDiv.appendChild(this.createMessage(role, parts || [], new_options));
                });
            }
            else {
                if (options.continueFunc) new_options.continueFunc = () => options.continueFunc(options.messageIndex, 0, model);
                arenaDiv.appendChild(this.createMessage('assistant', [], new_options));
            }
        });
        this.conversationDiv.appendChild(messageBlock);
        return arenaDivs;
    }

    resolveArena(choice, continued_with, arenaDivs, updatedElo = null) {
        // !!! sidepanel child function only has 2 params, uses class internal for arena divs
        const modelKeys = ['model_a', 'model_b'];
        arenaDivs.forEach((wrapper, index) => {
            const className = continued_with === modelKeys[index] ? 'arena-winner' : 'arena-loser';
            wrapper.querySelectorAll('.assistant-message').forEach(message => {
                message.querySelectorAll('.message-content').forEach(content => {
                    if (!content.classList.contains('thoughts')) content.classList.add(className);
                  });
                const prefix = message.querySelector('.message-prefix');

                const elo = updatedElo ? updatedElo[index] : null;
                prefix.textContent = this.formatArenaPrefix(prefix.textContent, this.stateManager.getArenaModel(index), choice, modelKeys[index], elo);

                this.arenaUpdateTokenFooter(message.querySelector('.message-footer'));
            });
        });
    }

    formatArenaPrefix(currentText, modelName, choice, modelKey, elo) {
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
        if (elo) modelName += ` (${Math.round(elo * 10) / 10})`;    // round to 1 decimal place
        return currentText.replace(this.roleLabels.assistant, modelName) + suffix;
    }

    arenaUpdateTokenFooter(footerDiv) {
        if (!footerDiv) return;
        const span = footerDiv.querySelector('span');
        span.textContent = span.textContent.replace('~', footerDiv.getAttribute('input-tokens'))
    }

    // UI Component Creation Methods
    createContentDiv(role, content) {
        const div = createElementWithClass('div', `message-content ${role}-content`);
        if (content) div.innerHTML = add_codeblock_html(content);
        return div;
    }

    createImageContent(imageBase64, role, onRemove = null) {
        const content = createElementWithClass('div', `image-content ${role}-content`);

        const img = document.createElement('img');
        img.src = imageBase64;
        content.appendChild(img);
    
        if (onRemove) {
            const removeButton = this.createRemoveFileButton(() => {
                content.remove();
                onRemove();
            });
            content.appendChild(removeButton);
        }

        return content;
    }

    createFileDisplay(file, onRemove = null) {
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
        this.pendingMediaDiv = this.createMessage('user');
        this.pendingMediaDiv.querySelector('.message-content').remove();
        this.conversationDiv.appendChild(this.pendingMediaDiv);
    }

    appendImage(imageBase64, onRemove = null) {
        this.initPendingMedia()
        const wrapper = this.pendingMediaDiv.querySelector('.message-wrapper');
        const imgContent = this.createImageContent(imageBase64, 'user', onRemove);
        wrapper.appendChild(imgContent);
    }

    appendFile(file, onRemove = null) {
        this.initPendingMedia()
        const wrapper = this.pendingMediaDiv.querySelector('.message-wrapper');
        const fileDisplay = this.createFileDisplay(file, onRemove);
        wrapper.appendChild(fileDisplay);
    }

    appendToExistingMessage(parts) {
        if (parts?.length === 0) return;
        const wrapper = this.pendingMediaDiv.querySelector('.message-wrapper');
        parts.forEach(part => wrapper.appendChild(this.produceNextContentDiv('user', part.type === 'thought', part.content)));
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

    produceNextContentDiv(role, isThought, content = '') {
        const div = this.createContentDiv(role, content);
        if (isThought) div.classList.add('thoughts');
        return div;
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

    createMessageWrapperFunc(parts, options = {}) {
        if (options.role === 'system') {
            parts.forEach(part => this.addSystemMessage(part.content));
            return;
        }
        return this.createMessage(options.role, parts, options);
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

    getTextareaText() {
        return this.textarea.value;
    }

    addMessage(role, parts = [], options = {}) {
        super.addMessage(role, parts, options);
        this.scrollIntoView();
    }

    createMessage(role, parts = [], options = {}) {
        const message = super.createMessage(role, parts, options);
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

    regenerateResponse(model, isRegeneration = true, hideModels = true) {
        const newMessage = this.createMessage('assistant', [], { model, isRegeneration, hideModels });
        if (this.stateManager.isArenaModeActive) {
            const modelIndex = this.stateManager.getModelIndex(model);
            if (modelIndex === -1) return null;
            this.activeMessageDivs[modelIndex].appendChild(newMessage);
        } else {
            this.conversationDiv.appendChild(newMessage);
        }
    }

    removeCurrentRemoveMediaButtons() {
        const buttons = this.conversationDiv.lastChild.querySelectorAll('.remove-file-button');
        buttons.forEach(button => button.remove());
    }

    buildChat(chat) {
        // Hide models and disable continue buttons for sidepanel
        this.shouldScroll = false;
        super.buildChat(chat, { hideModels: !this.stateManager.getSetting('show_model_name') });
        this.shouldScroll = true;
        this.updateChatHeader(chat.title);
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
                this.removeArenaFooterWithParam(footer);
                this.removeRegenerateButtons();
                onChoice(btn.choice);   // this should also call resolve arena after it's done, because here we don't know continued_with yet
            };
            this.setupArenaButtonHover(button);
            footer.appendChild(button);
        });

        container.appendChild(footer);
    }

    resolveArena(choice, continued_with, _, updatedElo = null) {
        super.resolveArena(choice, continued_with, this.activeMessageDivs, updatedElo);
        this.scrollIntoView();
        this.activeMessageDivs = null;
    }

    setupArenaButtonHover(button) {
        const updateOtherButtons = (isEnter) => {
            const allButtons = button.parentElement.querySelectorAll('button');
            allButtons.forEach(otherBtn => {
                if (otherBtn !== button) {
                    if (isEnter) {
                        if (button.classList.contains('choice') && otherBtn.classList.contains('choice')) {
                            otherBtn.classList.add('choice-not-hovered');
                            otherBtn.textContent = 'X';
                        } else {
                            otherBtn.classList.add('hovered');
                        }
                    } else {
                        if (button.classList.contains('choice') && otherBtn.classList.contains('choice')) {
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

    removeArenaFooter() {
        const footer = this.activeMessageDivs[0].parentElement.parentElement.querySelector('.arena-footer');
        if (footer) {
            this.removeArenaFooterWithParam(footer);
        }
    }

    removeArenaFooterWithParam(footer) {
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

    // Incognito handling methods
    updateIncognitoButtonVisuals(button) {
        button.classList.toggle('active', !this.stateManager.shouldSave);
    }

    setupIncognitoButtonHandlers(button, footer, hoverText, hasChatStarted) {
        button.addEventListener('mouseenter', () => {
            this.updateIncognitoHoverText(hoverText, hasChatStarted());
            footer.classList.add('showing-text');
        });

        button.addEventListener('mouseleave', () => {
            footer.classList.remove('showing-text');
            this.handleIncognitoHoverTextTransition(hoverText);
        });

        button.addEventListener('click', () => {
            this.stateManager.toggleChatState(hasChatStarted());
            this.updateIncognitoHoverText(hoverText);
            this.updateIncognitoButtonVisuals(button);
        });
    }

    updateIncognito(hasChatStarted = false) {
        const buttonFooter = document.getElementById('sidepanel-button-footer');
        const incognitoToggle = document.getElementById('incognito-toggle');
        const hoverText = buttonFooter.querySelectorAll('.hover-text');
        this.updateIncognitoHoverText(hoverText, hasChatStarted);
        this.updateIncognitoButtonVisuals(incognitoToggle);
    }

    updateIncognitoHoverText(hoverText, hasChatStarted) {
        const [hoverTextLeft, hoverTextRight] = hoverText;

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
    }

    handleIncognitoHoverTextTransition(hoverText) {
        hoverText.forEach(label => {
            const handler = (event) => {
                if (!label.parentElement.classList.contains('showing-text')) {
                    label.textContent = "";
                }
                label.removeEventListener('transitionend', handler);
            };
            label.addEventListener('transitionend', handler);
        });
    }

    getContentDiv(model) {
        const container = this.getActiveMessageElement(model);
        if (!container) return null;
        const nodes = container.querySelectorAll('.message-content');
        return nodes[nodes.length - 1];
    }

    updateChatHeader(title) {
        document.getElementById('conversation-title').textContent = title;
    }

    getChatHeader() {
        return document.getElementById('conversation-title');
    }

    clearConversation() {
        super.clearConversation();
        this.activeMessageDivs = null;
        this.updateChatHeader('conversation');
        this.setTextareaText('');
    }

    // Returns the active message container for the given model.
    getActiveMessageElement(model) {
        if (this.stateManager.isArenaModeActive) {
            const index = this.stateManager.getModelIndex(model);
            return (index !== -1 && Array.isArray(this.activeMessageDivs))
                ? this.activeMessageDivs[index]
                : null;
        }
        return this.activeMessageDivs;
    }

    getActiveMessagePrefixElement(model) {
        const container = this.getActiveMessageElement(model);
        if (!container) return null;
        if (this.stateManager.isArenaModeActive) {
            const prefixes = container.querySelectorAll('.history-prefix-wrapper');
            return prefixes.length ? prefixes[prefixes.length - 1] : container;
        }
        return container.querySelector('.history-prefix-wrapper') || container;
    }

    addManualAbortButton(model, manualAbort) {
        const prefixElem = this.getActiveMessagePrefixElement(model);
        if (!prefixElem) return;
        const abortButton = this.createRemoveFileButton(manualAbort);
        abortButton.classList.add('manual-abort-button');
        abortButton.textContent = '\u{23F8}'; // Unicode for a stop button.
        prefixElem.appendChild(abortButton);
    }

    removeManualAbortButton(model) {
        const prefixElem = this.getActiveMessagePrefixElement(model);
        if (!prefixElem) return;
        const abortButton = prefixElem.querySelector('.manual-abort-button');
        if (abortButton) {
            abortButton.disabled = true;
            abortButton.classList.add('fade-out');
            const onTransitionEnd = (event) => {
                if (event.propertyName === "opacity") {
                    abortButton.removeEventListener('transitionend', onTransitionEnd);
                    abortButton.remove();
                }
            };
            abortButton.addEventListener('transitionend', onTransitionEnd);
        }
    }
}


export class HistoryChatUI extends ChatUI {
    constructor(options) {
        const {
            continueFunc = () => {},
            addPopupActions,
            loadHistoryItems,
            loadChat,
            getChatMeta,
            ...baseOptions
        } = options;

        super(baseOptions);
        this.historyList = this.stateManager.historyList;

        this.loadMore = this.loadMore.bind(this);
        this.handleHistoryScroll = this.handleHistoryScroll.bind(this);
        this.continueFunc = continueFunc;
        this.addPopupActions = addPopupActions;
        this.loadHistoryItems = loadHistoryItems;
        this.loadChat = loadChat;
        this.getChatMeta = getChatMeta;

        this.initHistoryListHandling();
    }

    reloadHistoryList() {
        this.stateManager.reset();
        this.historyList.innerHTML = '';
        this.historyList.removeEventListener('scroll', this.handleHistoryScroll);
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
        } catch (error) {
            console.error(error);
            this.stateManager.hasMoreItems = false;
            this.stateManager.isLoading = false;
            return;
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

        if (currentCategory !== this.stateManager.lastDateCategory) {
            const divider = this.createDateDivider(currentCategory);
            this.historyList.appendChild(divider);
            this.stateManager.lastDateCategory = currentCategory;
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
        item.onclick = () => this.buildChat(chat.chatId);
        this.addPopupActions(item);

        return item;
    }

    handleItemDeletion(item) {
        const header = item.previousElementSibling;
        const nextItem = item.nextElementSibling;
        const nextHeader = nextItem?.classList.contains('history-divider') ? nextItem : null;
    
        item.remove();
    
        // If this was the last item under its header
        if (header?.classList.contains('history-divider') && 
            (!nextItem || nextItem.classList.contains('history-divider'))) {
            header.remove();
            if (nextHeader) {
                nextHeader.style.paddingTop = '0';
            }
        }
    
        if (this.historyList.scrollHeight <= this.historyList.clientHeight) {
            this.loadMore();
        }
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

    appendMessages(newMessages, currentMessageIndex) {
        newMessages.forEach(message => {
            const tempIndex = currentMessageIndex;
            if (message.responses) {
                this.createArenaMessageWrapperFunc(message, { continueFunc: this.continueFunc, messageIndex: tempIndex });
            } else {
                this.addFullMessage(message, false, tempIndex, this.continueFunc);
            }
            currentMessageIndex++;
            this.pendingMediaDiv = null;
        });
    }

    appendSingleRegeneratedMessage(message, index) {
        const {contents, role, timestamp, messageId, chatId,  ...options} = message
        const continueFunc = () => this.continueFunc(index, contents.length - 1, role);
        const new_options = { hideModels: false, isRegeneration: true, continueFunc, ...options };
        this.addMessage(role, contents.at(-1), new_options);
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
        if (this.stateManager.lastDateCategory !== null) {
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

    updateChatFooter(footerText) {
        document.getElementById('history-chat-footer').textContent = footerText;
    }

    addLinkedChat(chatId) {
        if (!chatId) return;
        const header = document.getElementById('title-wrapper');
        this.clearLinkedChatFromHeader();
        
        const button = createElementWithClass('button', 'unset-button linked-chat', '\u{21AA}');
        button.onclick = async () => {
            const chat = await this.getChatMeta(chatId);
            if (chat) {
                this.highlightHistoryItem(chatId);
                this.buildChat(chatId);
            } else {
                button.classList.add('settings-error');
                button.addEventListener('animationend', () => {
                    button.classList.remove('settings-error');
                }, { once: true });
            }
        };
        header.appendChild(button);
    }

    clearLinkedChatFromHeader() {
        const header = document.getElementById('title-wrapper').querySelector('.linked-chat');
        if (header) header.remove();
    }

    highlightHistoryItem(chatId) {
        const item = this.getHistoryItem(chatId);
        if (item) {
            item.classList.add('highlight');
            item.addEventListener('transitionend', () => {
                item.classList.remove('highlight');
            }, { once: true });
        }
    }

    getHistoryItem(chatId) {
        return document.getElementById(chatId);
    }

    autoUpdateChatHeader(chatId) {
        if (!chatId) return null;
        const historyItem = document.getElementById(chatId)?.querySelector('.item-text');
        if (historyItem && historyItem.textContent !== "Renaming..." && historyItem.textContent !== "Rename failed") {
            this.updateChatHeader(historyItem.textContent);
            return historyItem.textContent;
        }
    }

    handleChatRenamed(chatId, newName) {
        const historyItem = document.getElementById(chatId)?.querySelector('.item-text');
        if (historyItem) historyItem.textContent = newName;
    }

    updateChatTimestamp(timestamp) {
        const date = new Date(timestamp);
        document.getElementById('history-chat-footer').textContent =
            date.toString().split(' GMT')[0];
    }

    async buildChat(chatId) {
        // Show models and enable continue buttons for history
        const chatFull = await this.loadChat(chatId);
        super.buildChat(chatFull, {
            hideModels: false,
            addSystemMsg: true,
            continueFunc: this.continueFunc
        });

        this.updateChatHeader(chatFull.title);
        this.addLinkedChat(chatFull.continued_from_chat_id);
        this.updateChatTimestamp(chatFull.timestamp);
    }

    clearConversation() {
        super.clearConversation();
        this.updateChatHeader('conversation');
        this.clearLinkedChatFromHeader();
        this.updateChatFooter('');
    }
}