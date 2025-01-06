import { Footer } from './utils.js';


class ChatUI {
    constructor(options) {
        const {
            conversationWrapperId = 'conversation-wrapper',
            scrollElementId = 'conversation',
            inputWrapperId = null,  // Optional for sidepanel
        } = options;

        this.conversationDiv = document.getElementById(conversationWrapperId);
        this.scrollToElement = document.getElementById(scrollElementId);
        this.inputFieldWrapper = inputWrapperId ? document.querySelector(inputWrapperId) : null;
        this.stateManager = options.stateManager;

        // UI State Management
        this.contentDiv = null;
        this.shouldScroll = true;
        this.scrollListenerActive = false;
        this.activeArenaUI = null;
        this.pendingMedia = {
            div: null,
            images: [],
            files: [],
            tempFileId: 0
        };

        // Message display configuration
        this.roleLabels = {
            user: "You",
            assistant: "Assistant",
            system: "System"
        };
    }

    // Core message display methods
    rebuildChat(chat) {
        this.clearConversation();
        let previousRole = null;

        chat.messages.forEach((message, index) => {
            if (message.role === 'system') {
                const systemMsg = this.createSystemMessage(message.content);
                this.conversationDiv.appendChild(systemMsg);
            }
            else if (message.responses) {
                const { block, arenaUI } = this.createMessage('assistant', '', {
                    isArena: true,
                    messageIndex: index,
                    responses: message.responses,
                    choice: message.choice,
                    continuedWith: message.continued_with
                });
            }
            else {
                const { block, content } = this.createMessage(message.role, message.content, {
                    messageIndex: index,
                    previousRole,
                    model: message.model,
                    images: message.images,
                    files: message.files
                });
                previousRole = message.role;
            }
        });

        this.scrollIntoView();
    }

    createMessage(role, content = '', options = {}) {
        const {
            messageIndex = null,
            onContinue = null,
            isArenaModeActive = null,
            thinkingState = null,
            previousRole = null,
            model = null,
            images = null,
            files = null
        } = options;

        if (isArenaModeActive) {
            const messageDiv = createElementWithClass('div', 'assistant-message');
            this.conversationDiv.appendChild(messageDiv);

            this.activeArenaUI = new ArenaUI(messageDiv, this);
            this.activeArenaUI.createArenaMessage(options);

            this.scrollIntoView();
            return { block: messageDiv, arenaUI: this.activeArenaUI };
        }

        if (role === 'system') {
            return this.createSystemMessage(content);
        }

        const messageBlock = this.initMessageBlock(role);
        const messageWrapper = createElementWithClass('div', 'message-wrapper');

        // Handle media content first
        if (images?.length) {
            images.forEach(imageUrl => {
                messageWrapper.appendChild(this.createImageContent(imageUrl, role));
            });
        }

        if (files?.length) {
            files.forEach(file => {
                messageWrapper.appendChild(this.createFileDisplay(file));
            });
        }

        // Add text content
        if (content) {
            const contentDiv = this.createContentDiv(role, content);
            messageWrapper.appendChild(contentDiv);

            if (role === 'assistant') {
                this.contentDiv = contentDiv;
            }
        }

        // Create and customize prefix
        const prefixWrapper = this.createPrefixWrapper({
            role,
            model,
            previousRole,
            thinkingState,
            messageIndex,
            onContinue
        });

        messageBlock.append(prefixWrapper, messageWrapper);
        this.scrollIntoView();

        return { block: messageBlock, content: this.contentDiv };
    }

    createPrefixWrapper(options) {
        const {
            role,
            model,
            previousRole,
            thinkingState,
            messageIndex,
            onContinue
        } = options;

        const prefixWrapper = createElementWithClass('div', 'history-prefix-wrapper');
        const prefix = createElementWithClass('span', `message-prefix ${role}-prefix`);

        let prefixText = this.generatePrefixText({
            role,
            model,
            previousRole,
            thinkingState
        });
        prefix.textContent = prefixText;

        prefixWrapper.appendChild(prefix);

        if (messageIndex !== null && onContinue) {
            const continueButton = this.createContinueButton(messageIndex, onContinue);
            prefixWrapper.appendChild(continueButton);
        }

        return prefixWrapper;
    }

    generatePrefixText(options) {
        const { role, model, previousRole, thinkingState } = options;
        let prefix = model || this.roleLabels[role];

        if (role === 'assistant') {
            if (previousRole === 'assistant') {
                prefix += ' ⟳';
            }

            if (thinkingState) {
                switch (thinkingState) {
                    case 'thinking': prefix += ' 🧠'; break;
                    case 'solver': prefix += ' 💡'; break;
                }
            }
        }

        return prefix;
    }

    createContentDiv(role, content) {
        const contentDiv = createElementWithClass('div', `message-content ${role}-content`);
        contentDiv.innerHTML = add_codeblock_html(content);
        return contentDiv;
    }

    createImageContent(imageUrl, role) {
        const imgWrapper = createElementWithClass('div', `image-content ${role}-content`);
        const img = document.createElement('img');
        img.src = imageUrl;
        imgWrapper.appendChild(img);
        return imgWrapper;
    }

    createSystemMessage(content, title = 'System Prompt') {
        const messageDiv = createElementWithClass('div', 'history-system-message collapsed');
        const toggleButton = createElementWithClass('button', 'message-prefix system-toggle system-prefix history-sidebar-item');
        const toggleIcon = createElementWithClass('span', 'toggle-icon', '⯈');
        const contentDiv = createElementWithClass('div', 'history-system-content');

        contentDiv.innerHTML = add_codeblock_html(content);
        toggleButton.append(toggleIcon, title);
        toggleButton.onclick = () => messageDiv.classList.toggle('collapsed');
        messageDiv.append(toggleButton, contentDiv);

        return messageDiv;
    }

    createFileDisplay(file, options = {}) {
        const { addRemoveButton = false, onRemove = null } = options;
        const fileDiv = createElementWithClass('div', 'history-system-message collapsed');
        const buttonsWrapper = createElementWithClass('div', 'file-buttons-wrapper');
        const toggleButton = createElementWithClass('button', 'message-prefix system-toggle system-prefix history-sidebar-item');
        const toggleIcon = createElementWithClass('span', 'toggle-icon', '⯈');
        const contentDiv = createElementWithClass('div', 'history-system-content user-file', file.content);

        toggleButton.append(toggleIcon, file.name);
        toggleButton.onclick = () => fileDiv.classList.toggle('collapsed');
        buttonsWrapper.append(toggleButton);

        if (addRemoveButton && onRemove) {
            const removeButton = this.createRemoveButton(file.tempId, onRemove);
            buttonsWrapper.append(removeButton);
        }

        fileDiv.append(buttonsWrapper, contentDiv);
        return fileDiv;
    }

    addMessageFooter(contentDiv, options) {
        const {
            inputTokens,
            outputTokens,
            isArenaMode,
            thoughtProcessState,
            onRegenerate
        } = options;

        const footer = new Footer(
            inputTokens,
            outputTokens,
            isArenaMode,
            thoughtProcessState,
            onRegenerate
        );
        footer.create(contentDiv);
    }

    createContinueButton(messageIndex, onContinue) {
        const button = createElementWithClass('button', 'unset-button continue-conversation-button', '\u{2197}');
        button.onclick = () => onContinue(messageIndex);
        return button;
    }

    createRemoveButton(fileId, onRemove) {
        const button = createElementWithClass('button', 'unset-button rename-cancel remove-file-button', '✕');
        button.id = `remove-file-button-${fileId}`;
        button.onclick = (e) => onRemove(e.target.parentElement.parentElement, fileId);
        return button;
    }

    // Media handling methods
    initPendingMedia() {
        if (this.pendingMedia.div) return;
        this.pendingMedia.div = this.initMessageBlock('user');
    }

    appendImage(imageBase64) {
        this.initPendingMedia();
        const imgWrapper = this.createImageContent(imageBase64, 'user');
        this.pendingMedia.div.querySelector('.message-wrapper').appendChild(imgWrapper);
        this.pendingMedia.images.push(imageBase64);
    }

    appendFile(file) {
        this.initPendingMedia();
        const fileDisplay = this.createFileDisplay(file, {
            addRemoveButton: true,
            onRemove: this.removeFile.bind(this)
        });
        this.pendingMedia.div.querySelector('.message-wrapper').appendChild(fileDisplay);
        this.pendingMedia.files.push(file);
    }

    removeFile(fileDiv, fileId) {
        fileDiv.remove();
        this.pendingMedia.files = this.pendingMedia.files.filter(f => f.tempId !== fileId);
    }

    clearPendingMedia() {
        this.pendingMedia = {
            div: null,
            images: [],
            files: [],
            tempFileId: this.pendingMedia.tempFileId
        };
    }

    // Utility methods
    initMessageBlock(role) {
        const block = createElementWithClass('div', `${role}-message`);
        this.conversationDiv.appendChild(block);
        return block;
    }

    scrollIntoView() {
        if (this.shouldScroll) {
            this.scrollToElement.scrollIntoView(false);
        }
    }

    clearConversation() {
        this.conversationDiv.innerHTML = '';
        this.clearPendingMedia();
        this.activeArenaUI = null;
        this.contentDiv = null;
    }

    // Scroll handling
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

        const distanceFromBottom = Math.abs(
            this.scrollToElement.scrollHeight - window.scrollY - window.innerHeight
        );

        if (!this.shouldScroll && event.deltaY > 0 && distanceFromBottom <= 100) {
            this.shouldScroll = true;
        }
    }

    // Methods for managing arena state and interactions
    initArenaMode(onChoice) {
        this.arenaOnChoice = onChoice;  // Store callback for arena choices
        return this.createMessage('assistant', '', { isArena: true });
    }

    updateArenaResponse(model) {
        if (!this.activeArenaUI) return null;
        this.activeArenaUI.updatePendingResponses();
        return this.activeArenaUI.getContentDiv(model);
    }

    getArenaContentDiv(model) {
        if (!this.activeArenaUI) return null;
        return this.activeArenaUI.getContentDiv(model);
    }

    getArenaContentDivIndex(model) {
        if (!this.activeArenaUI) return -1;
        return this.activeArenaUI.getContentDivIndex(model);
    }

    handleArenaDefault() {
        if (this.activeArenaUI) {
            this.activeArenaUI.deleteFooter();
            this.activeArenaUI = null;
        }
    }

    // Optional: Method to handle regeneration in arena context
    regenerateArenaResponse(model, options) {
        if (!this.activeArenaUI) return;

        const contentDiv = this.getArenaContentDiv(model);
        if (!contentDiv) return;

        const { thinkingState = null } = options;
        contentDiv.classList.toggle('thoughts', !!thinkingState);

        // Clear existing content
        contentDiv.innerHTML = '';

        return contentDiv;
    }
}


// Sidepanel-specific UI handling
export class SidepanelChatUI extends ChatUI {
    constructor(options) {
        super(options);
        this.inputFieldWrapper = document.querySelector(options.inputWrapperId);
        this.pendingMediaDiv = null;
        this.pendingImages = [];
        this.pendingFiles = [];
        this.tempFileId = 0;

        this.initTextareaHandling();
    }

    initTextareaHandling() {
        this.initDragDrop();
        this.initPaste();
        this.initInputResize();
    }

    initDragDrop() {
        const textarea = this.inputFieldWrapper.querySelector('textarea');
        ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
            textarea.addEventListener(eventName, e => {
                e.preventDefault();
                e.stopPropagation();
                textarea.classList.toggle('dragging',
                    eventName === 'dragover' || eventName === 'dragenter'
                );
            }, false);
        });

        textarea.addEventListener('drop', this.handleDrop.bind(this));
    }

    handleDrop(e) {
        // ... existing drop handling ...
    }

    initPaste() {
        const textarea = this.inputFieldWrapper.querySelector('textarea');
        textarea.addEventListener('paste', this.handlePaste.bind(this));
    }

    handlePaste(e) {
        // ... existing paste handling ...
    }

    initInputResize() {
        const textarea = this.inputFieldWrapper.querySelector('textarea');
        textarea.addEventListener('input', () => {
            textarea.style.height = 'auto';
            textarea.style.height = textarea.scrollHeight + 'px';
        });
    }
}


// History-specific UI handling
export class HistoryChatUI extends ChatUI {
    constructor(options) {
        super(options);
        this.historyList = document.querySelector(options.historyListId);
        this.initHistoryList();
    }

    initHistoryList() {
        this.historyList.addEventListener('scroll', this.handleHistoryScroll.bind(this));
    }

    updateHistoryItemName(chatId, newName) {
        const historyItem = document.getElementById(chatId);
        if (historyItem) {
            const textSpan = historyItem.querySelector('.item-text');
            historyItem.dataset.name = newName;
            textSpan.textContent = newName;
        }
    }

    addHistoryItem(chat) {
        const currentCategory = this.getDateCategory(chat.timestamp);
        const listItem = this.createHistoryItem(chat);

        // Insert in correct position
        const firstItem = this.historyList.firstElementChild;
        if (firstItem?.classList.contains('history-divider') &&
            firstItem.textContent === currentCategory) {
            this.historyList.insertBefore(listItem, firstItem.nextSibling);
        } else {
            const divider = this.createDateDivider(currentCategory);
            this.historyList.prepend(listItem);
            this.historyList.prepend(divider);
        }
    }

    createHistoryItem(chat) {
        // ... existing history item creation ...
    }

    createDateDivider(category) {
        // ... existing date divider creation ...
    }

    handleHistoryScroll() {
        // ... existing history scroll handling ...
    }

    getDateCategory(timestamp) {
        // ... existing date category logic ...
    }
}


class ArenaUI {
    constructor(parentDiv, chatUI) {
        this.container = createElementWithClass('div', 'arena-full-container');
        this.parentDiv = parentDiv;
        this.chatUI = chatUI;
        this.arenaDivs = [];
        this.footer = null;
        this.buttons = [];
        this.pendingResponses = 2;

        parentDiv.appendChild(this.container);
    }

    createArenaMessage(options) {
        const {
            messageIndex,
            onContinue,
            responses,
            choice,
            continuedWith
        } = options;

        ['model_a', 'model_b'].forEach(modelKey => {
            const arenaWrapper = this.createModelResponse({
                modelKey,
                response: responses[modelKey],
                choice,
                continuedWith,
                messageIndex,
                onContinue
            });
            this.container.appendChild(arenaWrapper);
            this.arenaDivs.push({
                model: responses[modelKey].name,
                contentDiv: arenaWrapper.querySelector('.message-content')
            });
        });

        return this.container;
    }

    createModelResponse(options) {
        const {
            modelKey,
            response,
            choice,
            continuedWith,
            messageIndex,
            onContinue
        } = options;

        const arenaWrapper = createElementWithClass('div', 'arena-wrapper');
        const roleWrapper = createElementWithClass('div', 'assistant-message');
        const modelWrapper = createElementWithClass('div', 'message-wrapper');
        const prefixWrapper = createElementWithClass('div', 'history-prefix-wrapper');

        response.messages.forEach((msg, index) => {
            const prefix = this.createPrefix(response.name, choice, modelKey, index);
            const contentDiv = this.createContentDiv(msg, continuedWith === modelKey);

            if (onContinue) {
                const continueButton = this.chatUI.createContinueButton(
                    messageIndex,
                    () => onContinue(messageIndex, index, modelKey)
                );
                prefixWrapper.appendChild(continueButton);
            }

            prefixWrapper.appendChild(prefix);
            modelWrapper.appendChild(contentDiv);
        });

        roleWrapper.append(prefixWrapper, modelWrapper);
        arenaWrapper.appendChild(roleWrapper);
        return arenaWrapper;
    }

    createPrefix(modelName, choice, modelKey, messageIndex) {
        const symbol = this.getChoiceSymbol(choice, modelKey);
        return createElementWithClass(
            'span',
            'message-prefix assistant-prefix',
            modelName + (messageIndex > 0 ? ' ⟳' : '') + symbol
        );
    }

    createContentDiv(content, isWinner) {
        const contentDiv = createElementWithClass(
            'div',
            `message-content assistant-content ${isWinner ? 'arena-winner' : 'arena-loser'}`
        );
        contentDiv.innerHTML = add_codeblock_html(content || "");
        return contentDiv;
    }

    getChoiceSymbol(choice, modelKey) {
        switch (choice) {
            case modelKey: return ' 🏆';
            case 'draw': return ' 🤝';
            case 'draw(bothbad)': return ' ❌';
            case 'reveal': return ' 👁️';
            case 'ignored': return ' n/a';
            default: return ' ❌';
        }
    }

    createFooter(onChoice) {
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
                this.deleteFooter();
                onChoice(btn.choice);
            };
            footer.appendChild(button);
            this.buttons.push(button);
        });

        this.setupHoverEffects();
        this.container.parentElement.appendChild(footer);
        this.footer = footer;
        this.chatUI.scrollIntoView();
    }

    setupHoverEffects() {
        this.buttons.forEach(button => {
            button.addEventListener('mouseenter', () => this.handleHover(button, true));
            button.addEventListener('mouseleave', () => this.handleHover(button, false));
        });
    }

    handleHover(hoveredButton, isEnter) {
        this.buttons.forEach(button => {
            if (button !== hoveredButton) {
                if (isEnter) {
                    if (button.classList.contains('choice')) {
                        button.classList.add('choice-not-hovered');
                        button.textContent = 'X';
                    } else {
                        button.classList.add('hovered');
                    }
                } else {
                    if (button.classList.contains('choice')) {
                        button.classList.remove('choice-not-hovered');
                        button.textContent = '\u{2713}';
                    } else {
                        button.classList.remove('hovered');
                    }
                }
            }
        });
    }

    deleteFooter() {
        if (!this.footer) return;

        const footer = this.footer;
        footer.classList.add('slide-left');

        const handleTransitionEnd = (event) => {
            if (event.propertyName === 'opacity') {
                footer.classList.add('slide-up');
            } else if (event.propertyName === 'margin-top') {
                footer.removeEventListener('transitionend', handleTransitionEnd);
                footer.remove();
                this.footer = null;
            }
        };

        footer.addEventListener('transitionend', handleTransitionEnd);
    }

    updatePendingResponses() {
        this.pendingResponses--;
        if (this.pendingResponses === 0) {
            this.createFooter();
        }
    }

    getContentDiv(model) {
        const arenaDiv = this.arenaDivs.find(div => div.model === model);
        return arenaDiv ? arenaDiv.contentDiv : null;
    }

    getContentDivIndex(model) {
        return this.arenaDivs.findIndex(div => div.model === model);
    }
}