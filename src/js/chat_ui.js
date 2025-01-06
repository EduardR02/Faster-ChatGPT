import { Footer, createElementWithClass, add_codeblock_html } from './utils.js';


class ChatUI {
    constructor(options) {
        const {
            conversationWrapperId = 'conversation-wrapper',
            scrollElementId = 'conversation',
            stateManager,
            onContinue = null,
        } = options;

        this.conversationDiv = document.getElementById(conversationWrapperId);
        this.scrollToElement = document.getElementById(scrollElementId);
        this.stateManager = stateManager;
        this.onContinue = onContinue;

        // Scroll behavior
        this.shouldScroll = true;
        this.scrollListenerActive = false;

        // Media handling state
        this.pendingMedia = {
            div: null,
            images: [],
            files: [],
            tempFileId: 0
        };

        // Role labels configuration
        this.roleLabels = {
            user: "You",
            assistant: "Assistant",
            system: "System"
        };
    }

    // Core message creation methods
    createMessage(role, content = '', options = {}) {
        const {
            thinkingState = null,
            model = null,
            isRegeneration = false,
            messageIndex = null,
            images = null,
            files = null,
        } = options;

        // Handle pending media for user messages
        if (role === 'user' && this.pendingMedia.div) {
            this.appendToExistingMessage(content);
            return;
        }

        const messageBlock = this.initMessageBlock(role);
        const messageWrapper = this.createMessageWrapper(role, content, {
            images,
            files,
            model,
            thinkingState,
            isRegeneration,
            messageIndex
        });

        messageBlock.appendChild(messageWrapper);
        this.scrollIntoView();

        // Store reference for assistant messages
        if (role === 'assistant') {
            const contentDiv = messageWrapper.querySelector('.message-content');
            this.stateManager.setCurrentContentDiv(contentDiv);
        }

        return messageBlock;
    }

    createMessageWrapper(role, content, options) {
        const wrapper = createElementWithClass('div', 'message-wrapper');
        const prefixWrapper = this.createPrefixWrapper(role, options);
        wrapper.appendChild(prefixWrapper);

        // Add media content if present
        if (options.images?.length) {
            options.images.forEach(img =>
                wrapper.appendChild(this.createImageContent(img, role))
            );
        }

        if (options.files?.length) {
            options.files.forEach(file =>
                wrapper.appendChild(this.createFileDisplay(file))
            );
        }

        // Add text content
        if (content) {
            const contentDiv = this.createContentDiv(role, content);
            wrapper.appendChild(contentDiv);
        }

        return wrapper;
    }

    createPrefixWrapper(role, options) {
        const {
            model,
            thinkingState,
            messageIndex,
        } = options;

        const wrapper = createElementWithClass('div', 'prefix-wrapper');
        const prefix = createElementWithClass('span', `message-prefix ${role}-prefix`);

        prefix.textContent = this.generatePrefixText(role, {
            model,
            thinkingState
        });

        wrapper.appendChild(prefix);

        // Add continue button for history view
        if (this.onContinue && messageIndex !== null) {
            const continueButton = this.createContinueButton(messageIndex);
            wrapper.appendChild(continueButton);
        }

        return wrapper;
    }

    generatePrefixText(role, options) {
        const { model, thinkingState } = options;
        let text = model || this.roleLabels[role];

        if (role === 'assistant') {
            if (thinkingState === 'thinking') text += ' 🧠';
            else if (thinkingState === 'solver') text += ' 💡';
        }

        return text;
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

    // UI Component Creation Methods
    createContentDiv(role, content) {
        const div = createElementWithClass('div', `message-content ${role}-content`);
        div.innerHTML = add_codeblock_html(content);
        return div;
    }

    createImageContent(imageUrl, role) {
        const wrapper = createElementWithClass('div', `image-content ${role}-content`);
        const img = document.createElement('img');
        img.src = imageUrl;
        wrapper.appendChild(img);
        return wrapper;
    }

    createFileDisplay(file, options = {}) {
        const { addRemoveButton = false } = options;
        const fileDiv = createElementWithClass('div', 'history-system-message collapsed');
        const buttonsWrapper = createElementWithClass('div', 'file-buttons-wrapper');

        const toggleButton = this.createFileToggleButton(file.name);
        buttonsWrapper.appendChild(toggleButton);

        if (addRemoveButton) {
            const removeButton = this.createRemoveFileButton(file.tempId);
            buttonsWrapper.appendChild(removeButton);
        }

        const contentDiv = createElementWithClass('div', 'history-system-content user-file', file.content);
        fileDiv.append(buttonsWrapper, contentDiv);

        return fileDiv;
    }

    // Arena Mode Methods
    initArenaMode(modelA, modelB) {
        this.stateManager.initArenaResponse(modelA, modelB);
        const container = this.createArenaContainer();

        ['model_a', 'model_b'].forEach((_, index) => {
            const arenaDiv = createElementWithClass('div', 'arena-wrapper');
            const assistantWrapper = createElementWithClass('div', 'assistant-message');
            const contentDiv = this.createMessage('assistant', '', {
                model: this.stateManager.state.activeArenaModels[index]
            });
            arenaDiv.appendChild(assistantWrapper);
            container.appendChild(arenaDiv);
        });

        return container;
    }

    updateArenaResolution(choice, winnerModel = null) {
        const container = this.conversationDiv.querySelector('.arena-full-container');
        if (!container) return;
    
        const arenaWrappers = container.querySelectorAll('.arena-wrapper');
        arenaWrappers.forEach((wrapper, index) => {
            const model = this.stateManager.state.activeArenaModels[index];
            const prefix = wrapper.querySelector('.message-prefix');
            const content = wrapper.querySelector('.message-content');
    
            // Update prefix with choice indicator
            prefix.textContent = this.generateArenaPrefix({
                modelName: prefix.textContent.split(' ')[0], // Keep existing model name
                choice,
                modelKey: `model_${index === 0 ? 'a' : 'b'}`,
                hideModels: !prefix.textContent.includes('gpt') // Preserve current hiding state
            });
    
            // Update content classes
            if (choice === 'draw(bothbad)') {
                content.classList.add('arena-loser');
            } else if (choice === 'draw' || choice === 'reveal' || choice === 'ignored') {
                content.classList.toggle('arena-winner', model === winnerModel);
            } else {
                const isWinner = model === winnerModel;
                content.classList.toggle('arena-winner', isWinner);
                content.classList.toggle('arena-loser', !isWinner);
            }
        });
    }

    createArenaContainer() {
        const messageBlock = this.initMessageBlock('assistant');
        const container = createElementWithClass('div', 'arena-full-container');
        messageBlock.appendChild(container);
        return container;
    }

    addArenaFooter(onChoice) {
        const container = this.conversationDiv.querySelector('.arena-full-container');
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
                onChoice(btn.choice);
            };
            this.setupArenaButtonHover(button);
            footer.appendChild(button);
        });

        container.parentElement.appendChild(footer);
        this.scrollIntoView();
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

    // Media Handling Methods
    initPendingMedia() {
        if (!this.pendingMedia.div) {
            this.pendingMedia.div = this.initMessageBlock('user');
        }
        return this.pendingMedia.div;
    }

    appendImage(imageBase64) {
        const wrapper = this.initPendingMedia().querySelector('.message-wrapper')
            || this.createMessageWrapper('user', '');
        const imgContent = this.createImageContent(imageBase64, 'user');
        wrapper.appendChild(imgContent);
        this.pendingMedia.images.push(imageBase64);
    }

    appendFile(file) {
        const wrapper = this.initPendingMedia().querySelector('.message-wrapper')
            || this.createMessageWrapper('user', '');
        const fileDisplay = this.createFileDisplay(file, {
            addRemoveButton: true
        });
        wrapper.appendChild(fileDisplay);
        this.pendingMedia.files.push(file);
    }

    removeFile(fileId) {
        this.pendingMedia.files = this.pendingMedia.files.filter(f => f.tempId !== fileId);
        const button = document.getElementById(`remove-file-${fileId}`);
        if (button) button.closest('.history-system-message').remove();
    }

    appendToExistingMessage(content) {
        if (!content.trim()) return;
        const wrapper = this.pendingMedia.div.querySelector('.message-wrapper');
        const contentDiv = this.createContentDiv('user', content);
        wrapper.appendChild(contentDiv);
        this.pendingMedia.div = null;
    }

    // Footer and Regeneration Methods
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

    // Utility Methods
    initMessageBlock(role) {
        const block = createElementWithClass('div', `${role}-message`);
        this.conversationDiv.appendChild(block);
        return block;
    }

    createContinueButton(messageIndex) {
        const button = createElementWithClass('button', 'unset-button continue-conversation-button', '\u{2197}');
        button.onclick = () => this.onContinue(messageIndex);
        return button;
    }

    createFileToggleButton(fileName) {
        const button = createElementWithClass('button', 'message-prefix system-toggle system-prefix history-sidebar-item');
        const icon = createElementWithClass('span', 'toggle-icon', '⯈');
        button.append(icon, fileName);
        button.onclick = () => button.closest('.history-system-message').classList.toggle('collapsed');
        return button;
    }

    createRemoveFileButton(fileId) {
        const button = createElementWithClass('button', 'unset-button rename-cancel remove-file-button', '✕');
        button.id = `remove-file-${fileId}`;
        button.onclick = () => this.removeFile(fileId);
        return button;
    }

    clearConversation() {
        this.conversationDiv.innerHTML = '';
        this.pendingMedia = {
            div: null,
            images: [],
            files: [],
            tempFileId: this.pendingMedia.tempFileId
        };
        this.stateManager.setCurrentContentDiv(null);
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

    buildChat(chat, options = {}) {
        const {
            hideModels = false,
            allowContinue = false,
            startIndex = 0,
            endIndex = null
        } = options;
    
        this.clearConversation();
        let previousRole = null;
    
        // Get the slice of messages we want to process
        const messages = chat.messages.slice(
            startIndex, 
            endIndex !== null ? endIndex + 1 : undefined
        );
    
        messages.forEach((message, index) => {
            if (message.role === 'system') {
                const systemMsg = this.createSystemMessage(message.content);
                this.conversationDiv.appendChild(systemMsg);
                return;
            }
    
            if (message.responses) {
                this.buildArenaMessage(message, {
                    messageIndex: index,
                    hideModels,
                    allowContinue
                });
            } else {
                this.buildRegularMessage(message, {
                    messageIndex: index,
                    previousRole,
                    hideModels,
                    allowContinue
                });
                previousRole = message.role;
            }
        });
    
        this.scrollIntoView();
    }
    
    buildRegularMessage(message, options) {
        const {
            messageIndex,
            previousRole,
            hideModels,
            allowContinue
        } = options;
    
        const messageBlock = this.createMessage(message.role, message.content, {
            messageIndex: allowContinue ? messageIndex : null,
            previousRole,
            model: hideModels ? null : message.model,
            images: message.images,
            files: message.files
        });
    
        if (allowContinue) {
            const prefixWrapper = messageBlock.querySelector('.prefix-wrapper');
            const continueButton = this.createContinueButton(messageIndex);
            prefixWrapper.appendChild(continueButton);
        }
    }
    
    generateArenaPrefix(options) {
        const {
            modelName,
            isRegeneration,
            choice,
            modelKey,
            hideModels
        } = options;
    
        let prefix = hideModels ? 'Assistant' : modelName;
        if (isRegeneration) prefix += ' ⟳';
    
        // Add choice indicator - now used in both live chat and history
        if (choice) {
            switch (choice) {
                case modelKey: prefix += ' 🏆'; break;
                case 'draw': prefix += ' 🤝'; break;
                case 'draw(bothbad)': prefix += ' ❌'; break;
                case 'reveal': prefix += ' 👁️'; break;
                case 'ignored': prefix += ' n/a'; break;
                default: 
                    if (modelKey !== choice) prefix += ' ❌';
            }
        }
    
        return prefix;
    }

    handleArenaChoice(choice) {
        this.removeArenaFooter();
        
        // Determine winner model for UI updates
        let winnerModel = null;
        if (choice === 'model_a' || choice === 'model_b') {
            const modelIndex = choice === 'model_a' ? 0 : 1;
            winnerModel = this.stateManager.state.activeArenaModels[modelIndex];
        } else if (['draw', 'reveal', 'ignored'].includes(choice)) {
            // For these cases, randomly select one path to continue with
            const randomIndex = Math.floor(Math.random() * 2);
            winnerModel = this.stateManager.state.activeArenaModels[randomIndex];
        }
    
        this.updateArenaResolution(choice, winnerModel);
        return { choice, winnerModel };
    }
}


export class SidepanelChatUI extends ChatUI {
    constructor(options) {
        const {
            inputWrapperId = '.textarea-wrapper',
            ...baseOptions
        } = options;

        super(baseOptions);
        this.inputWrapper = document.querySelector(inputWrapperId);
        this.initInputHandling();
    }

    initInputHandling() {
        const textarea = this.inputWrapper.querySelector('textarea');

        // Initialize all input-related handlers
        this.initDragDrop(textarea);
        this.initPaste(textarea);
        this.initResize(textarea);
        this.initKeyboardHandler(textarea);
    }

    initDragDrop(textarea) {
        ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
            textarea.addEventListener(eventName, e => {
                e.preventDefault();
                e.stopPropagation();
                textarea.classList.toggle('dragging',
                    eventName === 'dragover' || eventName === 'dragenter'
                );
            });
        });

        textarea.addEventListener('drop', this.handleDrop.bind(this));
    }

    async handleDrop(e) {
        const files = Array.from(e.dataTransfer.files);

        // Handle local files
        for (const file of files) {
            if (file.type.match('image.*')) {
                await this.handleImageFile(file);
            } else if (!file.type.match('video.*')) {
                await this.handleTextFile(file);
            }
        }

        // Handle web images
        const imgSrc = new DOMParser()
            .parseFromString(e.dataTransfer.getData('text/html'), 'text/html')
            .querySelector('img')?.src;

        if (imgSrc) {
            try {
                const response = await fetch(imgSrc);
                const blob = await response.blob();
                await this.handleImageFile(blob);
            } catch (error) {
                console.error('Failed to load web image:', error);
            }
        }

        // Handle text drops
        const text = e.dataTransfer.getData('text');
        if (text) {
            const textarea = e.target;
            const start = textarea.selectionStart;
            textarea.value = textarea.value.slice(0, start) + text +
                textarea.value.slice(textarea.selectionEnd);
            this.updateTextareaHeight(textarea);
        }
    }

    async handleImageFile(file) {
        const reader = new FileReader();
        reader.onload = e => this.appendImage(e.target.result);
        reader.readAsDataURL(file);
    }

    async handleTextFile(file) {
        const reader = new FileReader();
        reader.onload = e => {
            const fileData = {
                tempId: this.pendingMedia.tempFileId++,
                name: file.name,
                content: e.target.result
            };
            this.appendFile(fileData);
        };
        reader.readAsText(file);
    }

    initPaste(textarea) {
        textarea.addEventListener('paste', async e => {
            const items = Array.from(e.clipboardData.items);
            const imageItem = items.find(item => item.type.startsWith('image/'));

            if (imageItem) {
                e.preventDefault();
                await this.handleImageFile(imageItem.getAsFile());
            }
        });
    }

    initResize(textarea) {
        textarea.addEventListener('input', () => this.updateTextareaHeight(textarea));
    }

    updateTextareaHeight(textarea) {
        textarea.style.height = 'auto';
        textarea.style.height = `${textarea.scrollHeight}px`;
    }

    initKeyboardHandler(textarea) {
        textarea.addEventListener('keydown', e => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                const text = textarea.value.trim();

                if (text) {
                    this.handleUserInput(text);
                }

                textarea.value = '';
                this.updateTextareaHeight(textarea);
            }
        });
    }

    handleUserInput(text) {
        // Handle any pending arena choices before new input
        this.handleArenaDefault();

        // Create the message and handle pending media
        this.createMessage('user', text);

        // Clear media state after message is created
        this.clearPendingMedia();

        return text;
    }

    regenerateResponse(contentDiv, model, options = {}) {
        const parentMessage = contentDiv.closest('.assistant-message');
        const isArenaMessage = parentMessage.querySelector('.arena-full-container');

        if (isArenaMessage) {
            return this.regenerateArenaResponse(model, contentDiv, options);
        }

        // Create new message with regeneration indicator
        const newMessage = this.createMessage('assistant', '', {
            ...options,
            model,
            isRegeneration: true
        });

        // Replace old message
        parentMessage.replaceWith(newMessage);
        return newMessage.querySelector('.message-content');
    }

    regenerateArenaResponse(model, contentDiv, options) {
        const modelIndex = this.stateManager.state.activeArenaModels.findIndex(m => m === model);

        if (modelIndex === -1) return null;

        const arenaWrapper = contentDiv.closest('.arena-wrapper');
        const newContentDiv = this.createContentDiv('assistant', '');

        // Update content div with thinking state if needed
        if (options.thinkingState) {
            newContentDiv.classList.add('thoughts');
        }

        // Replace old content
        contentDiv.replaceWith(newContentDiv);
        return newContentDiv;
    }

    buildChat(chat) {
        // Hide models and disable continue buttons for sidepanel
        super.buildChat(chat, { 
            hideModels: true, 
            allowContinue: false 
        });
    }
}


export class HistoryChatUI extends ChatUI {
    constructor(options) {
        const {
            historyListId = '.history-list',
            ...baseOptions
        } = options;

        super(baseOptions);
        this.historyList = document.querySelector(historyListId);
        this.lastDateCategory = null;

        this.initHistoryListHandling();
    }

    initHistoryListHandling() {
        // Implement infinite scroll
        let isLoading = false;
        let offset = 0;
        const limit = 20;
        let hasMoreItems = true;

        const loadMore = async () => {
            if (isLoading || !hasMoreItems) return;
            isLoading = true;

            try {
                const items = await this.options.loadHistoryItems(limit, offset);
                if (items.length === 0) {
                    hasMoreItems = false;
                    return;
                }

                items.forEach(item => this.addHistoryItem(item));
                offset += items.length;
            } finally {
                isLoading = false;
            }
        };

        this.historyList.addEventListener('scroll', () => {
            const { scrollTop, scrollHeight, clientHeight } = this.historyList;
            if (scrollHeight - (scrollTop + clientHeight) < 50) {
                loadMore();
            }
        });

        // Initial load
        loadMore();
    }

    addHistoryItem(chat) {
        const currentCategory = this.getDateCategory(chat.timestamp);

        if (currentCategory !== this.lastDateCategory) {
            this.addDateDivider(currentCategory);
            this.lastDateCategory = currentCategory;
        }

        const item = this.createHistoryItem(chat);
        this.historyList.appendChild(item);
    }

    createHistoryItem(chat) {
        const item = createElementWithClass('button', 'unset-button history-sidebar-item');
        item.id = chat.chatId;
        item.dataset.name = chat.title;

        const textSpan = createElementWithClass('span', 'item-text', chat.title);
        const dotsSpan = createElementWithClass('div', 'action-dots', '\u{22EF}');

        item.append(textSpan, dotsSpan);
        item.onclick = () => this.options.onChatSelect(chat);

        return item;
    }

    addDateDivider(category) {
        const divider = createElementWithClass('div', 'history-divider', category);
        if (this.lastDateCategory !== null) {
            divider.style.paddingTop = '1rem';
        }
        this.historyList.appendChild(divider);
    }

    getDateCategory(timestamp) {
        const date = new Date(timestamp);
        const now = new Date();
        const dayDiff = Math.floor((now - date) / (1000 * 60 * 60 * 24));

        if (dayDiff === 0) return 'Today';
        if (dayDiff === 1) return 'Yesterday';
        if (dayDiff <= 7) return 'Last 7 Days';
        if (dayDiff <= 30) return 'Last 30 Days';

        return date.getFullYear() === now.getFullYear()
            ? date.toLocaleString('default', { month: 'long' })
            : date.getFullYear().toString();
    }

    updateHistoryItemName(chatId, newName) {
        const item = document.getElementById(chatId);
        if (item) {
            item.dataset.name = newName;
            item.querySelector('.item-text').textContent = newName;
        }
    }

    displayChat(chat) {
        this.clearConversation();

        chat.messages.forEach((message, index) => {
            if (message.responses) {
                this.displayArenaMessage(message, index);
            } else {
                this.createMessage(message.role, message.content, {
                    messageIndex: index,
                    model: message.model,
                    images: message.images,
                    files: message.files
                });
            }
        });

        this.updateChatHeader(chat.title);
        this.updateChatTimestamp(chat.timestamp);
    }

    displayArenaMessage(message, index) {
        const container = this.createArenaContainer();

        ['model_a', 'model_b'].forEach(modelKey => {
            const response = message.responses[modelKey];
            const wrapper = this.createArenaResponseWrapper(response, {
                choice: message.choice,
                continuedWith: message.continued_with,
                messageIndex: index,
                modelKey
            });
            container.appendChild(wrapper);
        });
    }

    updateChatHeader(title) {
        document.getElementById('history-chat-header').textContent = title;
    }

    updateChatTimestamp(timestamp) {
        const date = new Date(timestamp);
        document.getElementById('history-chat-footer').textContent =
            date.toString().split(' GMT')[0];
    }

    buildChat(chat) {
        // Show models and enable continue buttons for history
        super.buildChat(chat, { 
            hideModels: false, 
            allowContinue: true 
        });
        
        // Additional history-specific updates
        this.updateChatHeader(chat.title);
        this.updateChatTimestamp(chat.timestamp);
    }
}