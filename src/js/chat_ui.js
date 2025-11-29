import { createElementWithClass, formatContent, update_textfield_height, highlightCodeBlocks } from './utils.js';


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
        const { files, images, messageId, ...prefixOptions } = options;
        if (parts.length > 0 && parts.at(-1).model) prefixOptions.model = parts.at(-1).model;
        const messageBlock = createElementWithClass('div', `${role}-message`);
        
        // Add data-message-id if available
        if (messageId !== undefined && messageId !== null) {
            messageBlock.dataset.messageId = messageId;
        }

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
        else parts.forEach(part => wrapper.appendChild(this.produceNextContentDiv(role, part.type === 'thought', part.content, part.type)));

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
            if (isRegeneration) prefix += ' \u{27F3}';
            if (this.stateManager.isThinking(model)) prefix += ' 🧠';
            else if (this.stateManager.isSolving(model)) prefix += ' 💡';
        }

        return prefix;
    }

    createSystemMessage(content, title = 'System Prompt') {
        const messageDiv = createElementWithClass('div', 'history-system-message collapsed');
        const toggleButton = createElementWithClass('button', 'message-prefix system-toggle system-prefix history-sidebar-item');
        const toggleIcon = createElementWithClass('span', 'toggle-icon', '\u{25B6}');
        const contentDiv = createElementWithClass('div', 'message-content history-system-content');

        contentDiv.innerHTML = formatContent(content);
        highlightCodeBlocks(contentDiv);
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
            const new_options = { hideModels, messageId, ...rest };
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
        
        // Add data-message-id if available
        if (message.messageId !== undefined && message.messageId !== null) {
            messageBlock.dataset.messageId = message.messageId;
        }
        
        const container = createElementWithClass('div', 'arena-full-container');
        messageBlock.appendChild(container);
        const arenaDivs = [null, null];
        ['model_a', 'model_b'].forEach((model, index) => {
            const arenaDiv = createElementWithClass('div', 'arena-wrapper');
            // Track logical model id for later lookups (e.g., reveal names)
            arenaDiv.dataset.modelId = this.stateManager.getArenaModel(index);
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
                const displayName = wrapper.dataset.displayName || this.stateManager.getArenaModel(index);
                prefix.textContent = this.formatArenaPrefix(prefix.textContent, displayName, choice, modelKeys[index], elo);

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
        if (content) div.innerHTML = formatContent(content);
        highlightCodeBlocks(div);
        return div;
    }

    createImageContent(imageBase64, role, onRemove = null) {
        const content = createElementWithClass('div', `image-content ${role}-content`);

        const img = document.createElement('img');

        // Validate that we have a proper image data URI or URL
        const isValidImage = imageBase64 && (
            imageBase64.startsWith('data:image/') ||
            imageBase64.startsWith('http://') ||
            imageBase64.startsWith('https://')
        );

        if (!isValidImage) {
            // Show error message instead of broken image
            const errorDiv = createElementWithClass('div', 'image-error');
            errorDiv.textContent = 'Invalid image data';
            errorDiv.style.cssText = 'padding: 1em; color: #e06c75; background: #282c34; border: 1px solid #e06c75; border-radius: 4px; text-align: center;';
            content.appendChild(errorDiv);
        } else {
            img.src = imageBase64;

            // Handle image load errors
            img.onerror = () => {
                img.style.display = 'none';
                const errorDiv = createElementWithClass('div', 'image-error');
                errorDiv.textContent = 'Failed to load image';
                errorDiv.style.cssText = 'padding: 1em; color: #e06c75; background: #282c34; border: 1px solid #e06c75; border-radius: 4px; text-align: center;';
                content.appendChild(errorDiv);
            };

            content.appendChild(img);
        }

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
        parts.forEach(part => wrapper.appendChild(this.produceNextContentDiv('user', part.type === 'thought', part.content, part.type)));
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
        const icon = createElementWithClass('span', 'toggle-icon', '\u{25B6}');
        button.append(icon, fileName);
        button.onclick = () => button.closest('.history-system-message').classList.toggle('collapsed');
        return button;
    }

    createRemoveFileButton(onClickHandler) {
        const button = createElementWithClass('button', 'unset-button rename-cancel remove-file-button', '\u{2715}');
        button.onclick = onClickHandler;
        return button;
    }

    produceNextContentDiv(role, isThought, content = '', type = 'text') {
        // Handle image content differently
        if (type === 'image') {
            return this.createImageContent(content, role);
        }
        
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
        update_textfield_height(this.textarea);
    }

    // Thinking/reasoning toggle for Sonnet/Grok and OpenAI reasoners
    initSonnetThinking() {
        const sonnetThinkButton = document.getElementById('sonnet-thinking-toggle');
        if (!sonnetThinkButton) return;

        sonnetThinkButton.style.display = 'none';

        const isGeminiImage = (model) => model.includes('gemini') && model.includes('image');
        const hasReasoningLevels = (model) => (
            /o\d/.test(model) || model.includes('gpt-5') ||
            (/gemini-[3-9]\.?\d*|gemini-\d{2,}/.test(model) && !isGeminiImage(model))
        );
        const isGemini25Flash = (model) => model.includes('gemini-2.5') && model.includes('flash') && !isGeminiImage(model);
        const hasToggleThinking = (model) => (
            ['3-7-sonnet', 'sonnet-4', 'opus-4'].some(sub => model.includes(sub)) ||
            isGemini25Flash(model)
        );
        
        const setReasoningLabel = (model) => {
            const span = sonnetThinkButton.querySelector('.reasoning-label');
            if (!span) return;
            span.textContent = hasReasoningLevels(model)
                ? this.stateManager.getReasoningEffort()
                : 'reason';
        };

        sonnetThinkButton.addEventListener('click', () => {
            const model = this.stateManager.getSetting('current_model') || '';
            if (hasReasoningLevels(model)) {
                const next = this.stateManager.cycleReasoningEffort();
                sonnetThinkButton.title = `Reasoning: ${next}`;
                setReasoningLabel(model);
                sonnetThinkButton.classList.add('active');
            } else {
                this.stateManager.toggleShouldThink();
                sonnetThinkButton.classList.toggle('active', this.stateManager.getShouldThink());
                setReasoningLabel(model);
            }
        });

        const updateSonnetThinkingButton = () => {
            const model = this.stateManager.getSetting('current_model') || '';
            const canThink = hasToggleThinking(model) || hasReasoningLevels(model);

            if (canThink) {
                sonnetThinkButton.style.display = 'flex';
                if (hasReasoningLevels(model)) {
                    const effort = this.stateManager.getReasoningEffort();
                    sonnetThinkButton.title = `Reasoning: ${effort}`;
                    sonnetThinkButton.classList.add('active');
                } else {
                    sonnetThinkButton.title = 'Reasoning';
                    sonnetThinkButton.classList.toggle('active', this.stateManager.getShouldThink());
                }
                setReasoningLabel(model);
            } else {
                sonnetThinkButton.style.display = 'none';
                this.stateManager.setShouldThink(false);
            }
            update_textfield_height(this.textarea);
        };

        this.stateManager.runOnReady(updateSonnetThinkingButton);
        this.stateManager.subscribeToSetting('current_model', updateSonnetThinkingButton);
    }

    // Web search toggle (per-chat, init from global setting)
    initWebSearchToggle() {
        const webButton = document.getElementById('web-search-toggle');
        if (!webButton) return;

        webButton.style.display = 'none';

        const openaiSupport = (model) => {
            const include = ['gpt-4.1', 'gpt-5'];
            const exclude = ['gpt-4.1-nano', 'gpt-5-nano'];
            return include.some(s => model.includes(s)) && !exclude.some(s => model.includes(s));
        };
        const anthropicSupport = (model) => {
            const subs = ['claude-3-7-sonnet', 'claude-3-5-sonnet-latest', 'claude-3-5-haiku-latest', 'sonnet-4', 'opus-4'];
            return subs.some(s => model.includes(s));
        };
        const grokSupport = (model) => {
            const subs = ['grok-4'];
            return subs.some(s => model.includes(s));
        };

        const hasSupport = (model) => openaiSupport(model) || anthropicSupport(model) || grokSupport(model);

        webButton.addEventListener('click', () => {
            this.stateManager.toggleShouldWebSearch();
            webButton.classList.toggle('active', this.stateManager.getShouldWebSearch());
        });

        const updateWebButton = () => {
            const model = this.stateManager.getSetting('current_model') || '';
            if (hasSupport(model)) {
                this.stateManager.ensureWebSearchInitialized();
                webButton.style.display = 'flex';
                webButton.classList.toggle('active', this.stateManager.getShouldWebSearch());
            } else {
                webButton.style.display = 'none';
                this.stateManager.setShouldWebSearch(false);
            }
            update_textfield_height(this.textarea);
        };

        this.stateManager.runOnReady(updateWebButton);
        this.stateManager.subscribeToSetting('current_model', updateWebButton);
    }

    // Model picker popup next to the textarea controls
    initModelPicker() {
        const controlsContainer = document.querySelector('.textarea-bottom-left-controls');
        const pickerBtn = document.getElementById('model-picker-toggle');
        if (!pickerBtn || !controlsContainer) return;

        const containerStyle = window.getComputedStyle(controlsContainer);
        if (containerStyle.position === 'static') {
            controlsContainer.style.position = 'relative';
        }

		const getModelArr = () => {
			const modelsObj = this.stateManager.getSetting('models') || {};
			const arr = [];
			for (const provider in modelsObj) {
				for (const apiName in modelsObj[provider]) {
					arr.push({ apiName, display: modelsObj[provider][apiName] });
				}
			}
			return arr;
		};

		const getDisplayName = (apiName) => {
			const modelsObj = this.stateManager.getSetting('models') || {};
			for (const provider in modelsObj) {
				if (apiName in modelsObj[provider]) return modelsObj[provider][apiName];
			}
			return apiName;
		};

		const getFirstApiName = () => {
			const arr = getModelArr();
			return arr.length ? arr[0].apiName : null;
		};

        const popup = document.createElement('div');
        popup.id = 'model-picker-popup';
        popup.className = 'model-picker-popup';
		const ul = document.createElement('ul');
		const rebuildList = () => {
			ul.innerHTML = '';
			getModelArr().forEach(m => {
				const li = document.createElement('li');
				li.textContent = m.display;
				li.addEventListener('click', (e) => {
					e.stopPropagation();
					this.stateManager.updateSettingsLocal({ current_model: m.apiName });
					popup.style.display = 'none';
				});
				ul.appendChild(li);
			});
		};
		rebuildList();
        popup.appendChild(ul);
        controlsContainer.appendChild(popup);
        popup.style.display = 'none';

		const updateButtonText = (key) => {
			if (!key) {
				pickerBtn.textContent = `Select model \u25BE`;
				return;
			}
			const currentDisp = getDisplayName(key);
			pickerBtn.textContent = `${currentDisp} \u25BE`;
		};
        this.stateManager.runOnReady(() => updateButtonText(this.stateManager.getSetting('current_model')));
        this.stateManager.subscribeToSetting('current_model', updateButtonText);
		this.stateManager.subscribeToSetting('models', async () => {
			rebuildList();
			const models = getModelArr();
			const currentLocal = this.stateManager.getSetting('current_model');
			const localValid = models.some(m => m.apiName === currentLocal);
			if (!localValid) {
				try {
					const stored = await this.stateManager.loadFromStorage(['current_model']);
					const persisted = stored.current_model;
					if (persisted && models.some(m => m.apiName === persisted)) {
						this.stateManager.updateSettingsLocal({ current_model: persisted });
						return;
					}
				} catch (_) {}
				const fallback = getFirstApiName();
				this.stateManager.updateSettingsLocal({ current_model: fallback });
			}
		});

        pickerBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const isOpen = popup.style.display === 'flex';
            if (isOpen) {
                popup.style.display = 'none';
            } else {
                const buttonTopRelContainer = pickerBtn.offsetTop;
                const buttonHeight = pickerBtn.offsetHeight;

                popup.style.visibility = 'hidden';
                popup.style.display = 'flex';
                const popupHeight = popup.offsetHeight;
                popup.style.display = 'none';
                popup.style.visibility = 'visible';

                const buttonRectViewport = pickerBtn.getBoundingClientRect();
                const spaceBelowViewport = window.innerHeight - buttonRectViewport.bottom;
                const spaceAboveViewport = buttonRectViewport.top;

                let popupTopStyle = 'auto';
                let popupBottomStyle = 'auto';

                if (spaceBelowViewport >= popupHeight || spaceBelowViewport >= spaceAboveViewport) {
                    popupTopStyle = `${buttonTopRelContainer + buttonHeight + 5}px`;
                } else {
                    popupBottomStyle = `${controlsContainer.offsetHeight - buttonTopRelContainer + 5}px`;
                }

                popup.style.top = popupTopStyle;
                popup.style.bottom = popupBottomStyle;
                popup.style.left = `${pickerBtn.offsetLeft}px`;
                popup.style.display = 'flex';
            }
        });

        document.addEventListener('click', (e) => {
            if (popup.style.display === 'flex' && !popup.contains(e.target) && !pickerBtn.contains(e.target)) {
                popup.style.display = 'none';
            }
        });
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

    updateLastMessageModelName(actualModelName) {
        // Only update if show_model_name is enabled and not in arena mode
        if (!this.stateManager.getSetting('show_model_name') || this.stateManager.isArenaModeActive) {
            return;
        }
        
        // Find the last assistant message
        const messages = this.conversationDiv.querySelectorAll('.assistant-message');
        const lastMessage = messages[messages.length - 1];
        
        if (lastMessage) {
            const prefixElement = lastMessage.querySelector('.message-prefix');
            if (prefixElement) {
                // Update with actual model name, preserving any existing icons
                let newText = actualModelName;
                if (prefixElement.textContent.includes('🧠')) newText += ' 🧠';
                if (prefixElement.textContent.includes('💡')) newText += ' 💡';
                if (prefixElement.textContent.includes('\u{27F3}')) newText += ' \u{27F3}';
                
                prefixElement.textContent = newText;
            }
        }
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

    // Store display name for a given logical arena model id (used when revealing)
    setArenaModelDisplayName(logicalModelId, displayName) {
        if (!this.stateManager.isArenaModeActive) return;
        const container = this.getActiveMessageElement(logicalModelId);
        if (!container) return;
        container.dataset.displayName = displayName;
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

        this.continueFunc = continueFunc;
        this.addPopupActions = addPopupActions;
        this.loadHistoryItems = loadHistoryItems;
        this.loadChat = loadChat;
        this.getChatMeta = getChatMeta;

        this.handleHistoryScroll = this.handleHistoryScroll.bind(this);

        this.activeChatId = null;
        this.searchHighlightConfig = null;
        this.activeHighlights = [];

        this.mode = 'history';
        this.searchRenderedIds = new Set();
        this.requestMoreSearchResults = null;

        this.paginator = this.createPaginator();

        this.initHistoryListHandling();
        this.initKeyboardNavigation();
    }

    createPaginator() {
        let pending = null;
        let offset = 0;
        let hasMore = true;

        const loadHistory = async (reason) => {
            if (!this.stateManager.canLoadMore() || pending) return false;

            pending = (async () => {
                this.stateManager.isLoading = true;
                try {
                    const items = await this.loadHistoryItems(this.stateManager.limit, offset);
                    if (!items.length) {
                        hasMore = false;
                        return false;
                    }

                    items.forEach(item => this.addHistoryItem(item));
                    offset += items.length;
                    this.stateManager.offset = offset;
                    return true;
                } catch (error) {
                    console.error(error);
                    hasMore = false;
                    return false;
                } finally {
                    this.stateManager.isLoading = false;
                    pending = null;
                    if (hasMore && this.mode === 'history' && this.stateManager.shouldLoadMore()) {
                        void requestMore({ reason: 'auto' });
                    }
                }
            })();

            return pending;
        };

        const loadSearch = async (reason) => {
            if (typeof this.requestMoreSearchResults !== 'function' || pending) return false;

            const before = this.getVisibleHistoryItemCount();
            pending = Promise.resolve(this.requestMoreSearchResults(reason))
                .then(() => this.getVisibleHistoryItemCount() > before)
                .finally(() => {
                    pending = null;
                });

            return pending;
        };

        const requestMore = ({ reason = 'manual' } = {}) => {
            if (this.mode === 'search') {
                return loadSearch(reason);
            }
            if (!hasMore) return false;
            return loadHistory(reason);
        };

        const reset = ({ mode = 'history' } = {}) => {
            pending = null;
            offset = 0;
            hasMore = true;
            this.mode = mode;
            this.stateManager.offset = 0;
            this.stateManager.hasMoreItems = true;
        };

        return {
            requestMore,
            reset,
            get pending() {
                return pending;
            }
        };
    }

    initKeyboardNavigation() {
        const navState = { targetItem: null, transitionHandler: null, timeoutId: null };

        const cleanup = (item) => {
            if (!item) return;
            item.classList.remove('keyboard-navigating');
            if (navState.targetItem === item) {
                if (navState.transitionHandler) item.removeEventListener('transitionend', navState.transitionHandler);
                if (navState.timeoutId) clearTimeout(navState.timeoutId);
                navState.targetItem = navState.transitionHandler = navState.timeoutId = null;
            }
        };

        const isItem = (el) => el?.classList?.contains('history-sidebar-item');
        const isDivider = (el) => el?.classList?.contains('history-divider');
        const isHidden = (el) => el?.classList?.contains('search-hidden');

        const findNext = (current, dir) => {
            const prop = dir === 'up' ? 'previousElementSibling' : 'nextElementSibling';
            let candidate = current[prop];
            while (candidate && (isDivider(candidate) || !isItem(candidate) || isHidden(candidate))) {
                candidate = candidate[prop];
            }
            return isItem(candidate) ? candidate : null;
        };

        document.addEventListener('keydown', async (e) => {
            if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;

            const current = document.activeElement;
            if (!current || !current.classList.contains('history-sidebar-item') || !this.historyList.contains(current)) {
                return;
            }

            e.preventDefault();

            const direction = e.key === 'ArrowUp' ? 'up' : 'down';
            let next = findNext(current, direction);

            if (!next && direction === 'down') {
                const loaded = await this.paginator.requestMore({ reason: 'keyboard' });
                if (loaded) next = findNext(current, direction);
            }

            if (next) {
                cleanup(navState.targetItem);
                cleanup(next);

                next.focus();
                next.click();
                next.scrollIntoView({ block: 'nearest', behavior: 'smooth' });

                const onTransitionEnd = (event) => {
                    if (event.target === next && event.propertyName === 'transform') {
                        if (navState.targetItem === next) {
                            if (navState.timeoutId) clearTimeout(navState.timeoutId);
                            cleanup(next);
                        } else {
                            next.removeEventListener('transitionend', onTransitionEnd);
                        }
                    }
                };

                next.classList.add('keyboard-navigating');
                next.addEventListener('transitionend', onTransitionEnd);
                navState.targetItem = next;
                navState.transitionHandler = onTransitionEnd;

                const duration = parseFloat(getComputedStyle(next).transitionDuration) * 1000;
                const delay = isNaN(duration) ? 300 : duration + 100;

                if (navState.timeoutId) clearTimeout(navState.timeoutId);
                navState.timeoutId = setTimeout(() => {
                    if (navState.targetItem === next) cleanup(next);
                    else navState.timeoutId = null;
                }, delay);
            }
        });
    }

    getVisibleHistoryItemCount() {
        return this.historyList.querySelectorAll('.history-sidebar-item:not(.search-hidden)').length;
    }

    _setSearchMatch(elements, value) {
        elements.forEach(el => {
            if (value === null) delete el.dataset.searchMatch;
            else el.dataset.searchMatch = value;
        });
    }

    _toggleSearchHidden(elements, hidden) {
        elements.forEach(el => el.classList.toggle('search-hidden', hidden));
    }

    _getHistoryItems() {
        return this.historyList.querySelectorAll('.history-sidebar-item');
    }

    _getDividers() {
        return this.historyList.querySelectorAll('.history-divider');
    }

    reloadHistoryList() {
        this.stateManager.reset();
        this.historyList.innerHTML = '';
        this.paginator.reset({ mode: 'history' });
        this.initHistoryListHandling();
    }

    initHistoryListHandling() {
        this.historyList.addEventListener('scroll', this.handleHistoryScroll);
        void this.paginator.requestMore({ reason: 'initial' });
    }

    handleHistoryScroll() {
        const { scrollTop, scrollHeight, clientHeight } = this.historyList;

        if (scrollHeight - (scrollTop + clientHeight) < 10) {
            void this.paginator.requestMore({ reason: 'scroll' });
        }
    }

    addHistoryItem(chat) {
        const existing = this.getHistoryItem(`${chat.chatId}`);
        if (existing) {
            if (existing.dataset.searchTemp === 'true') {
                existing.remove();
            } else {
                return existing;
            }
        }

        const currentCategory = this.getDateCategory(chat.timestamp);

        if (currentCategory !== this.stateManager.lastDateCategory) {
            const divider = this.createDateDivider(currentCategory);
            this.historyList.appendChild(divider);
            this.stateManager.lastDateCategory = currentCategory;
        }

        const item = this.createHistoryItem(chat);
        this.historyList.appendChild(item);
        if (this.inSearchMode) {
            item.dataset.searchMatch = 'false';
        }
        return item;
    }

    ensureSearchResults(results = []) {
        const desiredIds = new Set(results.map(r => `${r.id}`));

        results.forEach(({ doc, id }) => {
            const idStr = `${id}`;
            let item = this.getHistoryItem(idStr);
            if (!item) {
                if (!doc) return;
                item = this.createSearchTempItem(doc);
            }
            if (item) {
                item.classList.remove('search-hidden');
            }
        });

        const tempItems = this.historyList.querySelectorAll('.history-sidebar-item[data-search-temp="true"]');
        tempItems.forEach(item => {
            if (!desiredIds.has(item.id)) {
                item.remove();
            }
        });

        this.searchRenderedIds = desiredIds;
    }

    createSearchTempItem(doc) {
        const normalizedId = `${doc.id}`;
        const item = createElementWithClass('button', 'unset-button history-sidebar-item');
        item.id = normalizedId;
        item.dataset.searchTemp = 'true';

        const title = doc?.title || 'Untitled chat';
        const textSpan = createElementWithClass('span', 'item-text', title);
        const dotsSpan = createElementWithClass('div', 'action-dots', '\u{22EF}');

        item.append(textSpan, dotsSpan);
        item.onclick = () => this.buildChat(doc.id);
        this.addPopupActions(item);

        this.historyList.appendChild(item);
        return item;
    }

    clearSearchResults() {
        this.historyList.querySelectorAll('.history-sidebar-item[data-search-temp="true"]').forEach(item => item.remove());
        this._setSearchMatch(this._getHistoryItems(), null);
        this._setSearchMatch(this._getDividers(), null);
        this.historyList.querySelector('.search-no-results')?.remove();
        this.historyList.querySelector('.search-counter')?.remove();
        this.searchRenderedIds.clear();
    }

    setSearchLoader(loader) {
        this.requestMoreSearchResults = typeof loader === 'function' ? loader : null;
    }

    startSearchMode() {
        if (!this.inSearchMode) {
            this.inSearchMode = true;
            this.historyList.classList.add('is-searching');
        }

        this.historyList.querySelectorAll('.history-sidebar-item[data-search-temp="true"]').forEach(item => item.remove());
        const items = this._getHistoryItems();
        this._setSearchMatch(items, 'false');
        this._toggleSearchHidden(items, true);

        const dividers = this._getDividers();
        this._setSearchMatch(dividers, 'false');
        this._toggleSearchHidden(dividers, true);

        void this.paginator.requestMore({ reason: 'search-init' });
    }

    exitSearchMode() {
        if (!this.inSearchMode) return;
        this.inSearchMode = false;
        this.historyList.classList.remove('is-searching');

        this.historyList.querySelectorAll('.history-sidebar-item[data-search-temp="true"]').forEach(item => item.remove());
        const items = this._getHistoryItems();
        this._setSearchMatch(items, null);
        this._toggleSearchHidden(items, false);

        const dividers = this._getDividers();
        this._setSearchMatch(dividers, null);
        this._toggleSearchHidden(dividers, false);

        this.clearSearchResults();
        this.setSearchLoader(null);
        this.paginator.reset({ mode: 'history' });
    }

    renderSearchResults(results = [], options = {}) {
        const desiredIds = new Set(results.map(r => `${r.id}`));
        const shouldAppend = options?.append === true;

        if (!shouldAppend) this.clearSearchResults();

        results.forEach(({ doc, id }) => {
            const idStr = `${id}`;
            let item = this.getHistoryItem(idStr);
            if (!item && doc) item = this.createSearchTempItem(doc);
            if (item) {
                item.dataset.searchMatch = 'true';
                item.classList.remove('search-hidden');
                if (item.dataset.searchTemp !== 'true') this.revealDividerForItem(item);
            }
        });

        if (!shouldAppend) {
            this.historyList.querySelectorAll('.history-sidebar-item[data-search-temp="true"]').forEach(item => {
                if (!desiredIds.has(item.id)) item.remove();
            });
            this.searchRenderedIds = new Set(desiredIds);
        } else {
            results.forEach(({ id }) => this.searchRenderedIds.add(`${id}`));
        }

        this._getHistoryItems().forEach(item => {
            if (item.dataset.searchTemp === 'true') item.classList.remove('search-hidden');
            else item.classList.toggle('search-hidden', item.dataset.searchMatch !== 'true');
        });

        this._getDividers().forEach(divider => {
            divider.classList.toggle('search-hidden', divider.dataset.searchMatch !== 'true');
        });

        const noResultsMsg = this.historyList.querySelector('.search-no-results');
        if (!results.length && !noResultsMsg) {
            this.historyList.appendChild(createElementWithClass('div', 'search-no-results', 'No results found'));
        } else if (results.length && noResultsMsg) {
            noResultsMsg.remove();
        }

        if (options?.showCounter) {
            this.updateSearchCounter(options.totalCount ?? 0, this.searchRenderedIds.size);
        }
    }

    updateSearchCounter(total = 0, visible = 0) {
        const existingCounter = this.historyList.querySelector('.search-counter');
        if (total <= 0) {
            if (existingCounter) existingCounter.remove();
            return;
        }

        const text = visible >= total ? `${visible} results` : `${visible} of ${total} results`;

        if (existingCounter) {
            existingCounter.textContent = text;
            return;
        }

        const counter = createElementWithClass('div', 'search-counter', text);
        this.historyList.prepend(counter);
    }

    getSearchContainer() {
        return this.historyList;
    }

    revealDividerForItem(item) {
        let previous = item.previousElementSibling;
        while (previous) {
            if (previous.classList.contains('history-divider')) {
                previous.dataset.searchMatch = 'true';
                break;
            }
            previous = previous.previousElementSibling;
        }
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

        item.remove();

        if (header?.classList.contains('history-divider') && 
            (!nextItem || nextItem.classList.contains('history-divider'))) {
            header.remove();
        }

        if (this.historyList.scrollHeight <= this.historyList.clientHeight) {
            void this.paginator.requestMore({ reason: 'deletion' });
        }
    }

    handleNewChatSaved(chat) {
        const currentCategory = this.getDateCategory(chat.timestamp);
        const firstItem = this.historyList.firstElementChild;
        const newItem = this.createHistoryItem(chat);

        if (firstItem?.classList.contains('history-divider') && firstItem.textContent === currentCategory) {
            this.historyList.insertBefore(newItem, firstItem.nextSibling);
        } else {
            this.historyList.prepend(newItem);
            this.historyList.prepend(this.createDateDivider(currentCategory));
        }
    }

    appendMessages(newMessages, currentMessageIndex) {
        newMessages.forEach(message => {
            if (message.responses) {
                this.createArenaMessageWrapperFunc(message, { continueFunc: this.continueFunc, messageIndex: currentMessageIndex });
            } else {
                this.addFullMessage(message, false, currentMessageIndex, this.continueFunc);
            }
            currentMessageIndex++;
            this.pendingMediaDiv = null;
        });
    }

    appendSingleRegeneratedMessage(message, index) {
        const {contents, role, timestamp, messageId, chatId,  ...options} = message
        const continueFunc = () => this.continueFunc(index, contents.length - 1, role);
        const new_options = { hideModels: false, isRegeneration: true, continueFunc, messageId, ...options };
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

    createDateDivider(category) {
        return createElementWithClass('div', 'history-divider', category);
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
        document.getElementById('title-wrapper').querySelector('.linked-chat')?.remove();
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
        const historyItem = this.getHistoryItem(chatId)?.querySelector('.item-text');
        if (historyItem && historyItem.textContent !== "Renaming..." && historyItem.textContent !== "Rename failed") {
            this.updateChatHeader(historyItem.textContent);
            return historyItem.textContent;
        }
    }

    handleChatRenamed(chatId, newName) {
        const historyItem = this.getHistoryItem(chatId)?.querySelector('.item-text');
        if (historyItem) historyItem.textContent = newName;
    }

    updateChatTimestamp(timestamp) {
        const date = new Date(timestamp);
        document.getElementById('history-chat-footer').textContent =
            date.toString().split(' GMT')[0];
    }

    async buildChat(chatId) {
        // Show models and enable continue buttons for history
        this.activeChatId = chatId;
        const chatFull = await this.loadChat(chatId);
        super.buildChat(chatFull, {
            hideModels: false,
            addSystemMsg: true,
            continueFunc: this.continueFunc
        });

        this.updateChatHeader(chatFull.title);
        this.addLinkedChat(chatFull.continued_from_chat_id);
        this.updateChatTimestamp(chatFull.timestamp);

        this.applySearchHighlight({ forceScroll: true });
    }

    clearConversation() {
        this.clearSearchHighlights();
        super.clearConversation();
        this.updateChatHeader('conversation');
        this.clearLinkedChatFromHeader();
        this.updateChatFooter('');
    }

    setSearchHighlight(config) {
        this.searchHighlightConfig = (config?.rawQuery?.length) ? {
            rawQuery: config.rawQuery,
            normalizedQuery: config.normalizedQuery ?? null,
            resultIds: Array.isArray(config.resultIds) ? config.resultIds : null,
            highlightAllowed: config.highlightAllowed !== false
        } : null;

        this.applySearchHighlight();
    }

    applySearchHighlight({ forceScroll = false } = {}) {
        this.clearSearchHighlights();

        if (!this.searchHighlightConfig || !this.searchHighlightConfig.rawQuery || !this.conversationDiv) {
            return;
        }

        if (this.activeChatId == null) return;

        const { resultIds, rawQuery, normalizedQuery, highlightAllowed } = this.searchHighlightConfig;
        if (highlightAllowed === false && !forceScroll) {
            return;
        }

        if (Array.isArray(resultIds) && resultIds.length > 0 && !resultIds.includes(this.activeChatId)) {
            return;
        }

        const highlights = this.highlightMatchesInConversation({ rawQuery, normalizedQuery });
        this.activeHighlights = highlights;

        if (highlights.length) {
            highlights[0].classList.add('is-first');
            if (forceScroll) {
                requestAnimationFrame(() => {
                    highlights[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
                });
            }
        }
    }

    clearSearchHighlights() {
        if (!this.activeHighlights?.length) {
            this.activeHighlights = [];
            return;
        }

        const parentsToNormalize = new Set();

        this.activeHighlights.forEach(span => {
            if (!(span instanceof HTMLElement) || !span.parentNode) return;
            span.classList.remove('is-first');
            const parent = span.parentNode;
            const fragment = document.createDocumentFragment();
            while (span.firstChild) {
                fragment.appendChild(span.firstChild);
            }
            parent.replaceChild(fragment, span);
            parentsToNormalize.add(parent);
        });

        parentsToNormalize.forEach(parent => parent.normalize());
        this.activeHighlights = [];
    }

    highlightMatchesInConversation({ rawQuery, normalizedQuery }) {
        const pattern = this.buildHighlightPattern(rawQuery, normalizedQuery);
        if (!pattern) return [];
        const highlights = [];
        const elements = this.conversationDiv?.querySelectorAll('.message-content');
        if (!elements) return highlights;

        elements.forEach(element => {
            const text = element.textContent;
            if (!text) return;
            const regex = new RegExp(pattern, 'gi');
            const matches = [...text.matchAll(regex)];
            if (!matches.length) return;
            const elementHighlights = [];
            for (let i = matches.length - 1; i >= 0; i--) {
                const match = matches[i];
                const startIndex = match.index ?? 0;
                const matchText = match[0] ?? '';
                const range = this.createRangeForSubstring(element, startIndex, matchText.length);
                if (!range) continue;
                const span = document.createElement('span');
                span.className = 'search-highlight';
                try {
                    range.surroundContents(span);
                    elementHighlights.push(span);
                } catch (error) {
                    // Silently skip matches that span across element boundaries
                }
            }

            elementHighlights.reverse();
            highlights.push(...elementHighlights);
        });

        return highlights;
    }

    buildHighlightPattern(rawQuery, normalizedQuery) {
        const source = rawQuery?.trim() || normalizedQuery?.trim();
        if (!source) return null;
        return source.split(/(\s+)/).filter(Boolean).map(part => 
            /^\s+$/.test(part) ? '\\s+' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        ).join('');
    }

    createRangeForSubstring(container, start, length) {
        if (!container) return null;
        const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null);

        let currentNode = walker.nextNode();
        let remainingStart = start;

        while (currentNode) {
            const nodeLength = currentNode.textContent.length;
            if (remainingStart < nodeLength) break;
            remainingStart -= nodeLength;
            currentNode = walker.nextNode();
        }

        if (!currentNode) return null;

        const range = document.createRange();
        range.setStart(currentNode, remainingStart);

        let remainingLength = length;
        let endNode = currentNode;
        let endOffset = remainingStart;

        while (endNode && remainingLength > 0) {
            const available = endNode.textContent.length - endOffset;
            if (remainingLength <= available) {
                range.setEnd(endNode, endOffset + remainingLength);
                return range;
            }

            remainingLength -= available;
            endNode = walker.nextNode();
            endOffset = 0;
        }

        return null;
    }
}
