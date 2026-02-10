import { createElementWithClass, formatContent, updateTextfieldHeight } from './ui_utils.js';
import { Footer, createRegenerateButton } from './Footer.js';

// UI constants
const SCROLL_BOTTOM_THRESHOLD_PX = 5;   // Pixels from bottom to consider "at bottom"
const SCROLL_REENGAGE_PX = 150;         // Grace area to re-engage autoscroll
const POPUP_OFFSET_PX = 5;              // Offset for popup positioning
const HISTORY_SCROLL_BUFFER = 10;       // Pixels from bottom to trigger loading more history
const KEYBOARD_NAV_HIGHLIGHT_MS = 300;  // Duration for keyboard navigation highlight
const ERROR_FLASH_MS = 1000;            // Duration for error flash animation
const MS_PER_DAY = 86400000;            // Milliseconds in a day

export const getDistanceFromBottom = element => {
    if (!element) return Number.POSITIVE_INFINITY;
    return element.scrollHeight - element.clientHeight - element.scrollTop;
};

export const isWithinBottomGrace = (element, thresholdPx = SCROLL_REENGAGE_PX) => {
    return getDistanceFromBottom(element) <= thresholdPx;
};

// Unicode character constants (for readability)
const UNICODE = {
    REGEN_ARROW: '\u{27F3}',    // ↻ Regeneration indicator
    TRIANGLE: '\u{25B6}',        // ▶ Collapsible toggle
    CONTINUE: '\u{2197}',        // ↗ Continue conversation
    REMOVE: '\u{2715}',          // ✕ Remove/close button
    ELLIPSIS: '\u{22EF}',        // ⋯ Horizontal ellipsis
    HOOK_ARROW: '\u{21AA}'       // ↪ Linked chat indicator
};

/**
 * Base class for handling Chat UI components and rendering.
 */
class ChatUI {
    constructor(options) {
        this.conversationDiv = document.getElementById(options.conversationWrapperId || 'conversation-wrapper');
        this.stateManager = options.stateManager;
        this.pendingMediaDiv = null;
        this.roleLabels = { 
            user: "You", 
            assistant: "Assistant", 
            system: "System" 
        };
        this._renderTarget = null;
        this._isBuildingChat = false;
    }

    appendConversationNode(node) {
        const target = this._renderTarget || this.conversationDiv;
        target.appendChild(node);
    }

    addMessage(role, parts = [], options = {}) {
        if (role === 'user' && this.pendingMediaDiv) {
            this.appendToExistingPendingMessage(parts);
        } else {
            const messageElement = this.createMessage(role, parts, options);
            this.conversationDiv.appendChild(messageElement);
        }
    }

    createMessage(role, parts = [], options = {}) {
        const { files, images, messageId, allowContinue = true, ...prefixOptions } = options;
        
        // Attach model info from the last part if available
        if (parts.length > 0 && parts.at(-1).model) {
            prefixOptions.model = parts.at(-1).model;
        }

        const messageBlock = createElementWithClass('div', `${role}-message`);
        if (messageId != null) {
            messageBlock.dataset.messageId = messageId;
        }

        const prefixWrapper = createElementWithClass('div', 'history-prefix-wrapper');
        const prefixText = this.generatePrefix(role, prefixOptions);
        const prefixSpan = createElementWithClass('span', `message-prefix ${role}-prefix`, prefixText);
        prefixWrapper.appendChild(prefixSpan);

        if (options.continueFunc && allowContinue) {
            prefixWrapper.appendChild(this.createContinueButton(options.continueFunc));
        }

        const messageWrapper = createElementWithClass('div', 'message-wrapper');
        
        // Render images
        if (images) {
            images.forEach(imageSource => {
                messageWrapper.appendChild(this.createImageContent(imageSource, role));
            });
        }
        
        // Render files
        if (files) {
            files.forEach(file => {
                messageWrapper.appendChild(this.createFileDisplay(file));
            });
        }

        // Render content parts
        if (parts.length === 0) {
            messageWrapper.appendChild(this.createContentDiv(role, ''));
        } else {
            parts.forEach(part => {
                const isThought = (part.type === 'thought');
                const contentDiv = this.produceNextContentDiv(role, isThought, part.content, part.type);
                messageWrapper.appendChild(contentDiv);
            });
        }

        messageBlock.append(prefixWrapper, messageWrapper);
        return messageBlock;
    }

    generatePrefix(role, options = {}) {
        const { model, isRegeneration = false, hideModels = true } = options;
        let label = (hideModels || role !== 'assistant') ? this.roleLabels[role] : model;
        
        if (role === 'assistant') {
            if (isRegeneration) label += ` ${UNICODE.REGEN_ARROW}`;
            
            if (this.stateManager.isThinking(model)) {
                label += ' 🧠';
            } else if (this.stateManager.isSolving(model)) {
                label += ' 💡';
            }
        }
        return label;
    }

    createSystemMessage(content, title = 'System Prompt') {
        const systemMessageDiv = createElementWithClass('div', 'history-system-message collapsed');
        const toggleButton = createElementWithClass('button', 'message-prefix system-toggle system-prefix history-sidebar-item');
        const toggleIcon = createElementWithClass('span', 'toggle-icon', UNICODE.TRIANGLE);
        const bodyDiv = createElementWithClass('div', 'message-content history-system-content');

        bodyDiv.innerHTML = formatContent(content);
        
        toggleButton.append(toggleIcon, title);
        toggleButton.onclick = () => systemMessageDiv.classList.toggle('collapsed');
        
        systemMessageDiv.append(toggleButton, bodyDiv);
        return systemMessageDiv;
    }

    addSystemMessage(content, title) {
        const systemMessage = this.createSystemMessage(content, title);
        this.appendConversationNode(systemMessage);
    }

    buildChat(chat, options = {}) {
        this.clearConversation(options);

        const fragment = document.createDocumentFragment();
        this._renderTarget = fragment;
        this._isBuildingChat = true;
        
        try {
            const messages = chat.messages;
            let i = 0;
            let assistantCount = 0;
            while (i < messages.length) {
                const message = messages[i];
                
                if (message.role === 'assistant') {
                    // Determine rendering mode (Council, Arena, or Normal)
                    const isCouncil = !!message.council;
                    const isArena = !!message.responses;
                    const isRegeneration = assistantCount > 0;
                    
                    if (isArena) {
                        this.createArenaWrapper(message, { 
                            continueFunc: options.continueFunc, 
                            messageIndex: i,
                            messageId: message.messageId ?? i,
                            isRegeneration
                        });
                    } else if (isCouncil) {
                        this.createCouncilWrapper(message, {
                            continueFunc: options.continueFunc,
                            messageIndex: i,
                            messageId: message.messageId ?? i,
                            allowContinue: options.allowContinue,
                            isRegeneration
                        });
                    } else {
                        message.contents.forEach((parts, subIndex) => {
                            const runOptions = { 
                                ...message, 
                                hideModels: options.hideModels,
                                isRegeneration: isRegeneration || subIndex !== 0
                            };
                            
                            if (options.continueFunc) {
                                runOptions.continueFunc = () => options.continueFunc(i, subIndex);
                            }
                            
                            const messageBlock = this.createMessageFromParts(parts, runOptions);
                            if (messageBlock) {
                                this.appendConversationNode(messageBlock);
                            }
                        });
                    }
                    assistantCount++;
                    i++;
                } else {
                    // User or System
                    assistantCount = 0; // Reset assistant count on user message
                    if (options.addSystemMsg || message.role !== 'system') {
                        message.contents.forEach((parts, subIndex) => {
                            const runOptions = { 
                                ...message, 
                                hideModels: options.hideModels, 
                                isRegeneration: subIndex !== 0 
                            };
                            
                            if (options.continueFunc) {
                                runOptions.continueFunc = () => options.continueFunc(i, subIndex);
                            }
                            
                            const messageBlock = this.createMessageFromParts(parts, runOptions);
                            if (messageBlock) {
                                this.appendConversationNode(messageBlock);
                            }
                        });
                    }
                    i++;
                }

                if (i !== messages.length) {
                    this.pendingMediaDiv = null;
                }
            }
        } finally {
            this._renderTarget = null;
            this._isBuildingChat = false;
        }

        this.conversationDiv.appendChild(fragment);
    }

    createArenaMessage(messageData, options = {}) {
        messageData = messageData || {};
        const arenaMessageBlock = createElementWithClass('div', 'assistant-message');
        const messageId = options.messageId ?? options.messageIndex ?? messageData.messageId;
        if (options.messageIndex != null) {
            arenaMessageBlock.dataset.messageIndex = options.messageIndex;
        }
        if (messageId != null) {
            arenaMessageBlock.dataset.messageId = messageId;
        }

        const arenaFullContainer = createElementWithClass('div', 'arena-full-container');
        const modelKeys = ['model_a', 'model_b'];
        
        const columnDivs = modelKeys.map((modelKey, modelIndex) => {
            const arenaWrapper = createElementWithClass('div', 'arena-wrapper');
            const modelId = messageData.responses ? messageData.responses[modelKey].name : this.stateManager.getArenaModel(modelIndex);
            arenaWrapper.dataset.modelId = modelId;
            arenaWrapper.dataset.modelKey = modelKey;
            
            const baseOptions = { 
                model: modelId, 
                hideModels: true, 
                allowContinue: options.allowContinue 
            };

            if (messageData.responses) {
                messageData.responses[modelKey].messages.forEach((parts, partIndex) => {
                    const runOptions = { ...baseOptions, isRegeneration: partIndex !== 0 };
                    if (options.continueFunc) {
                        runOptions.continueFunc = () => options.continueFunc(options.messageIndex, partIndex, modelKey);
                    }
                    const modelDisplayName = messageData.responses[modelKey].name || (modelKey === 'model_a' ? 'Model A' : 'Model B');
                    arenaWrapper.appendChild(this.createMessage(messageData.role || 'assistant', parts, { ...runOptions, model: modelDisplayName }));
                });
            } else {
                if (options.continueFunc) {
                    baseOptions.continueFunc = () => options.continueFunc(options.messageIndex, 0, modelKey);
                }
                const modelDisplayName = (modelKey === 'model_a' ? 'Model A' : 'Model B');
                arenaWrapper.appendChild(this.createMessage('assistant', [], { ...baseOptions, model: modelDisplayName }));
            }
            
            arenaFullContainer.appendChild(arenaWrapper);
            return arenaWrapper;
        });

        arenaMessageBlock.appendChild(arenaFullContainer);
        this.appendConversationNode(arenaMessageBlock);

        if (messageData.responses) {
            this.resolveArena(messageData.choice, messageData.continued_with, columnDivs);
        }

        return columnDivs;
    }

    createCouncilMessage(messageData, options = {}) {
        messageData = messageData || {};
        const councilBlock = createElementWithClass('div', 'assistant-message council-message');
        const messageId = options.messageId ?? options.messageIndex ?? messageData.messageId;
        if (options.messageIndex != null) {
            councilBlock.dataset.messageIndex = options.messageIndex;
        }
        if (messageId != null) {
            councilBlock.dataset.messageId = messageId;
        }

        const header = createElementWithClass('div', 'council-header');
        const title = createElementWithClass('span', 'council-title', 'Council');
        if (options.isRegeneration) {
            title.textContent += ` ${UNICODE.REGEN_ARROW}`;
        }
        const headerActions = createElementWithClass('div', 'council-header-actions');
        const meta = createElementWithClass('span', 'council-meta');
        headerActions.appendChild(meta);
        header.append(title, headerActions);

        const responses = messageData.council?.responses || {};
        const responseKeys = Object.keys(responses);
        const listWrapper = createElementWithClass('div', 'council-list');

        if (responseKeys.length === 0) {
            const empty = createElementWithClass('div', 'council-empty', 'Awaiting council responses…');
            listWrapper.appendChild(empty);
        } else {
            responseKeys.forEach(modelId => {
                const responseEntry = responses[modelId];
                const displayName = responseEntry?.name || modelId;
                const row = createElementWithClass('div', 'council-row');
                row.dataset.modelId = modelId;

                const rowContent = createElementWithClass('div', 'council-row-content');
                const parts = responseEntry?.parts || [];
                
                const runOptions = { 
                    model: displayName,
                    hideModels: false,
                    allowContinue: false,
                    isCouncilRow: true
                };
                const msg = this.createMessage('assistant', parts, runOptions);
                msg.dataset.model = displayName;
                rowContent.appendChild(msg);

                if (this.mode === 'history') {
                    if (parts.length > 0) {
                        this.appendCouncilStatusPill(msg, 'complete');
                    }
                } else {
                    const status = responseEntry?.status || 'pending';
                    this.appendCouncilStatusPill(msg, status);
                }

                row.appendChild(rowContent);
                listWrapper.appendChild(row);
            });
        }

        const collectorModel = messageData.council?.collector_model || this.stateManager.getCouncilCollectorModel();
        const collectorResponse = messageData.contents?.at(0) || [];
        const collectorWrapper = createElementWithClass('div', 'council-collector');
        
        const collectorOptions = {
            role: 'assistant',
            model: collectorModel,
            hideModels: false,
            allowContinue: false,
            isCouncilRow: true
        };

        const collectorMessage = this.createMessage('assistant', collectorResponse, collectorOptions);
        collectorMessage.dataset.model = collectorModel;
        collectorWrapper.appendChild(collectorMessage);

        if (options.continueFunc && options.allowContinue !== false && collectorResponse.length > 0 && options.messageIndex != null) {
            const continueButton = this.createContinueButton(() => options.continueFunc(options.messageIndex, 0));
            continueButton.classList.add('council-continue-button');
            headerActions.appendChild(continueButton);
        }

        if (this.mode === 'history') {
            if (collectorResponse.length > 0) {
                this.appendCouncilStatusPill(collectorMessage, 'complete');
            }
        } else {
            this.appendCouncilStatusPill(collectorMessage, 'synthesizing');
        }


        const toggle = createElementWithClass('button', 'council-toggle', 'Show council');
        toggle.onclick = () => {
            const expanded = councilBlock.classList.toggle('council-expanded');
            toggle.textContent = expanded ? 'Hide council' : 'Show council';
            if (expanded) {
                listWrapper.scrollIntoView({ block: 'nearest' });
            }
        };

        const totalCount = responseKeys.length;
        const completeCount = responseKeys.filter(k => responses[k]?.status === 'complete').length;
        
        if (this.mode === 'history') {
            meta.textContent = `${totalCount}/${totalCount} complete`;
        } else {
            meta.textContent = totalCount ? `${completeCount}/${totalCount} complete` : 'No responses yet';
        }

        councilBlock.append(header, toggle, listWrapper, collectorWrapper);
        this.appendConversationNode(councilBlock);
        return councilBlock;
    }

    appendCouncilStatusPill(messageElement, status) {
        if (!messageElement || !status) return;
        
        const wrapper = messageElement.querySelector('.history-prefix-wrapper');
        if (!wrapper) return;
        
        wrapper.querySelectorAll('.council-status').forEach(el => el.remove());
        
        // For collector during live streaming: 
        // - show "SYNTHESIZING" while waiting/streaming council
        // - remove pill entirely once it starts streaming or completes (in live mode)
        const isCollector = messageElement.closest('.council-collector');
        if (isCollector && this.mode !== 'history' && (status === 'streaming' || status === 'complete')) return;
        
        const statusPill = createElementWithClass('span', 'council-status', status.toUpperCase());
        statusPill.dataset.status = status;
        const button = wrapper.querySelector('button');
        if (button) {
            wrapper.insertBefore(statusPill, button);
        } else {
            wrapper.appendChild(statusPill);
        }
    }

    updateCouncil(message, index) {
        const oldBlock = this.conversationDiv.querySelector(`.council-message[data-message-id="${index}"]`) || this.conversationDiv.children[index];
        if (!oldBlock) return;

        // If in sidepanel and we're currently streaming this council block
        const isCurrentlyStreaming = this.activeDivs === oldBlock || 
                                   (this.activeDivs?.dataset?.messageIndex === String(index));

        if (isCurrentlyStreaming && !document.hidden) {
            const collectorStatus = message.council?.collector_status;
            const meta = oldBlock.querySelector('.council-meta');
            const responseKeys = Object.keys(message.council?.responses || {});

            // Update row content (status pills removed as per new design)
            responseKeys.forEach(modelId => {
                const row = oldBlock.querySelector(`.council-row[data-model-id="${modelId}"]`);
                if (row) {
                    const assistantMessage = row.querySelector('.assistant-message');
                    if (assistantMessage) {
                        const parts = message.council.responses[modelId].parts || [];
                        const messageWrapper = assistantMessage.querySelector('.message-wrapper');
                        if (messageWrapper) {
                            // Simple update: if content changed, we might need more complex diffing, 
                            // but usually council responses are small and updated once.
                            // For now, let's just ensure the model name is correct.
                        }
                    }
                }
            });

            // Update meta counter
            if (meta) {
                const totalCount = responseKeys.length;
                const completeCount = responseKeys.filter(k => message.council.responses[k]?.status === 'complete').length;
                meta.textContent = totalCount ? `${completeCount}/${totalCount} complete` : 'No responses yet';
            }
        } else {
            const newBlock = this.createCouncilMessage(message, {
                continueFunc: this.continueFunc,
                messageIndex: index,
                messageId: message.messageId ?? index
            });
            this.conversationDiv.replaceChild(newBlock, oldBlock);
            if (this.activeDivs === oldBlock) {
                this.activeDivs = newBlock;
            }
        }
    }

    resolveArena(choice, continuedWith, arenaDivs, eloRatings = null) {
        const modelKeys = ['model_a', 'model_b'];
        
        arenaDivs.forEach((arenaDiv, index) => {
            const isWinner = (continuedWith === modelKeys[index]);
            const assistantMessages = arenaDiv.querySelectorAll('.assistant-message');
            
            assistantMessages.forEach(messageBlock => {
                // Apply winner/loser styles to non-thought content
                messageBlock.querySelectorAll('.message-content:not(.thoughts)').forEach(contentDiv => {
                    contentDiv.classList.add(isWinner ? 'arena-winner' : 'arena-loser');
                });

                // Update the model label with rating and icons
                const prefixSpan = messageBlock.querySelector('.message-prefix');
                const modelId = arenaDiv.dataset.modelId;
                const displayName = arenaDiv.dataset.displayName || (modelId ? this.resolveDisplayNameFromHistory(modelId) : this.stateManager.getArenaModel(index));
                const elo = eloRatings ? eloRatings[index] : null;
                
                prefixSpan.textContent = this.formatArenaPrefix(
                    prefixSpan.textContent, 
                    displayName, 
                    choice, 
                    modelKeys[index], 
                    elo
                );
                
                this.updateTokenLabel(messageBlock.querySelector('.message-footer'));
            });
        });
    }

    formatArenaPrefix(originalText, modelName, choice, modelKey, elo) {
        let suffix = '';
        if (choice) {
            switch(choice) {
                case modelKey: suffix = ' 🏆'; break;
                case 'draw': suffix = ' 🤝'; break;
                case 'reveal': suffix = ' 👁️'; break;
                case 'ignored': suffix = ' n/a'; break;
                case 'no_choice(bothbad)': suffix = ' ❌'; break;
                default: suffix = ' ❌';
            }
        }
        
        const ratingText = elo ? ` (${Math.round(elo * 10) / 10})` : '';
        const resolvedName = this.resolveDisplayNameFromHistory(modelName);
        return originalText.replace(this.roleLabels.assistant, resolvedName + ratingText) + suffix;
    }

    resolveDisplayNameFromHistory(modelId) {
        if (!modelId || modelId === 'Model A' || modelId === 'Model B') return modelId;
        const models = this.stateManager.getSetting('models') || {};
        for (const provider in models) {
            if (modelId in models[provider]) return models[provider][modelId];
        }
        return modelId;
    }

    updateTokenLabel(footerDiv) {
        if (!footerDiv) return;
        const tokensSpan = footerDiv.querySelector('span');
        if (tokensSpan) {
            tokensSpan.textContent = tokensSpan.textContent.replace('~', footerDiv.getAttribute('input-tokens'));
        }
    }

    createContentDiv(role, content) {
        const contentDiv = createElementWithClass('div', `message-content ${role}-content`);
        if (content) {
            contentDiv.innerHTML = formatContent(content);
            return contentDiv;
        }
        return contentDiv;
    }

    createImageContent(imageSource, role, onRemove = null) {
        const imageContentDiv = createElementWithClass('div', `image-content ${role}-content`);
        const imageElement = document.createElement('img');

        const displayError = (errorMessage) => {
            imageElement.style.display = 'none';
            const errorDiv = createElementWithClass('div', 'image-error', errorMessage);
            Object.assign(errorDiv.style, {
                padding: '1em',
                color: '#e06c75',
                background: '#282c34',
                border: '1px solid #e06c75',
                borderRadius: '4px',
                textAlign: 'center'
            });
            imageContentDiv.appendChild(errorDiv);
        };

        if (!imageSource?.match(/^data:image\/|https?:\/\//)) {
            displayError('Invalid image data');
            if (onRemove) {
                imageContentDiv.appendChild(this.createRemoveButton(() => { 
                    imageContentDiv.remove(); 
                    onRemove(); 
                }));
            }
            return imageContentDiv;
        }

        imageElement.src = imageSource;
        imageElement.onload = () => this.scrollIntoView?.();
        let retried = false;
        imageElement.onerror = async () => {
            // Only attempt repair for data:image/ URLs (not http/https)
            if (!retried && imageSource.startsWith('data:image/')) {
                retried = true;
                const repairResult = await chrome.runtime.sendMessage({
                    type: 'repair_blob_from_data_url',
                    dataUrl: imageSource
                }).catch(() => null);

                if (repairResult?.ok && repairResult.dataUrl) {
                    imageElement.src = repairResult.dataUrl;
                    return;
                }
            }
            displayError('Failed to load image');
        };

        imageContentDiv.appendChild(imageElement);
        
        if (onRemove) {
            imageContentDiv.appendChild(this.createRemoveButton(() => { 
                imageContentDiv.remove(); 
                onRemove(); 
            }));
        }
        return imageContentDiv;
    }

    createFileDisplay(file, onRemove = null) {
        const fileDiv = createElementWithClass('div', 'history-system-message collapsed');
        const buttonsWrapper = createElementWithClass('div', 'file-buttons-wrapper');
        const toggleButton = this.createFileToggleButton(file.name);
        
        buttonsWrapper.appendChild(toggleButton);
        
        if (onRemove) {
            buttonsWrapper.appendChild(this.createRemoveButton(() => { 
                fileDiv.remove(); 
                onRemove(); 
            }));
        }
        
        const contentDiv = createElementWithClass('div', 'history-system-content user-file', file.content);
        fileDiv.append(buttonsWrapper, contentDiv);
        return fileDiv;
    }

    initPendingMediaDiv() {
        if (this.pendingMediaDiv) return;
        this.pendingMediaDiv = this.createMessage('user');
        this.pendingMediaDiv.querySelector('.message-content')?.remove();
        this.conversationDiv.appendChild(this.pendingMediaDiv);
    }

    appendImage(imageSource, onRemove) {
        this.initPendingMediaDiv();
        const messageWrapper = this.pendingMediaDiv.querySelector('.message-wrapper');
        messageWrapper.appendChild(this.createImageContent(imageSource, 'user', onRemove));
        this.scrollIntoView?.();
    }

    appendFile(file, onRemove) {
        this.initPendingMediaDiv();
        const messageWrapper = this.pendingMediaDiv.querySelector('.message-wrapper');
        messageWrapper.appendChild(this.createFileDisplay(file, onRemove));
        this.scrollIntoView?.();
    }

    appendToExistingPendingMessage(parts) {
        if (!parts?.length) return;
        const messageWrapper = this.pendingMediaDiv.querySelector('.message-wrapper');
        
        parts.forEach(part => {
            const isThought = (part.type === 'thought');
            const contentDiv = this.produceNextContentDiv('user', isThought, part.content, part.type);
            messageWrapper.appendChild(contentDiv);
        });
        
        this.pendingMediaDiv = null;
    }

    createContinueButton(callback) {
        const continueButton = createElementWithClass('button', 'unset-button continue-conversation-button', UNICODE.CONTINUE);
        continueButton.onclick = callback;
        return continueButton;
    }

    createFileToggleButton(fileName) {
        const toggleButton = createElementWithClass('button', 'message-prefix system-toggle system-prefix history-sidebar-item');
        const toggleIcon = createElementWithClass('span', 'toggle-icon', UNICODE.TRIANGLE);
        
        toggleButton.append(toggleIcon, fileName);
        toggleButton.onclick = () => toggleButton.closest('.history-system-message').classList.toggle('collapsed');
        return toggleButton;
    }

    createRemoveButton(callback) {
        const removeButton = createElementWithClass('button', 'unset-button rename-cancel remove-file-button', UNICODE.REMOVE);
        removeButton.onclick = callback;
        return removeButton;
    }

    produceNextContentDiv(role, isThought, content = '', type = 'text') {
        if (type === 'image') {
            return this.createImageContent(content, role);
        }
        const contentDiv = this.createContentDiv(role, content);
        if (isThought) {
            contentDiv.classList.add('thoughts');
        }
        return contentDiv;
    }

    clearConversation(options = {}) {
        this.conversationDiv.innerHTML = '';
        this.pendingMediaDiv = null;
    }

    createArenaWrapper(message, options = {}) {
        return this.createArenaMessage(message, options);
    }

    createCouncilWrapper(message, options = {}) {
        return this.createCouncilMessage(message, { ...options, hideModels: !this.stateManager.getSetting('show_model_name') });
    }

    createMessageFromParts(parts, options = {}) {
        if (options.role === 'system') {
            parts.forEach(part => this.addSystemMessage(part.content));
            return null;
        }
        return this.createMessage(options.role, parts, options);
    }

    addLinkedChat(chatId) {
        if (!chatId) return;
        const titleWrapper = document.getElementById('title-wrapper');
        const existingLinkedChat = titleWrapper.querySelector('.linked-chat');
        if (existingLinkedChat) {
            existingLinkedChat.remove();
        }
        
        const linkedChatButton = createElementWithClass('button', 'unset-button linked-chat', '\u{21AA}');
        linkedChatButton.onclick = async () => {
            if (await this.getMeta(chatId)) {
                this.highlightItem(chatId);
                this.buildChat(chatId);
            } else {
                linkedChatButton.classList.add('settings-error');
                setTimeout(() => linkedChatButton.classList.remove('settings-error'), ERROR_FLASH_MS);
            }
        };
        titleWrapper.appendChild(linkedChatButton);
    }

    removeRegenerateButtons() {
        this.conversationDiv.querySelectorAll('.regenerate-button').forEach(btn => {
            const parent = btn.parentElement;
            parent?.classList.add('centered');
            btn.remove();
            if (parent?.classList.contains('arena-actions')) {
                parent.remove();
            }
        });
    }
}

/**
 * UI Controller for the Sidepanel.
 */
export class SidepanelChatUI extends ChatUI {
    constructor(options) {
        super(options);
        Object.assign(this, {
            continueFunc: options.continueFunc,
            scrollToElement: options.scrollElementId ? document.getElementById(options.scrollElementId) : this.conversationDiv,
            shouldScroll: true,
            isScrollActive: false,
            lastScrollTop: 0,
            inputWrapper: document.querySelector(options.inputWrapperId || '.textarea-wrapper'),
            textarea: document.querySelector('.textarea-wrapper textarea'),
            _settingCallbacks: []
        });
    }

    _subscribe(key, callback) {
        this._settingCallbacks.push({ key, callback });
        this.stateManager.subscribeToSetting(key, callback);
    }

    destroy() {
        this._settingCallbacks.forEach(({ key, callback }) => {
            this.stateManager.unsubscribeFromSetting(key, callback);
        });
        this._settingCallbacks = [];
    }

    initSonnetThinking() {
        const button = document.getElementById('sonnet-thinking-toggle');
        if (!button) return;

        const updateVisuals = () => {
            const currentModel = this.stateManager.getSetting('current_model') || '';
            const canThink = this.stateManager.apiManager.hasToggleThinking(currentModel) || 
                             this.stateManager.apiManager.hasReasoningLevels(currentModel);
            const hasLevels = this.stateManager.apiManager.hasReasoningLevels(currentModel);
            
            button.style.display = canThink ? 'flex' : 'none';
            
            if (canThink) {
                const effort = this.stateManager.getReasoningEffort();
                button.title = hasLevels ? `Reasoning: ${effort}` : 'Reasoning';
                button.classList.toggle('active', hasLevels || this.stateManager.getShouldThink());
                
                const label = button.querySelector('.reasoning-label');
                if (label) {
                    label.textContent = hasLevels ? effort : 'reason';
                }
            } else {
                this.stateManager.setShouldThink(false);
            }
            updateTextfieldHeight(this.textarea);
        };

        button.onclick = () => {
            const model = this.stateManager.getSetting('current_model') || '';
            if (this.stateManager.apiManager.hasReasoningLevels(model)) {
                this.stateManager.cycleReasoningEffort();
            } else {
                this.stateManager.toggleShouldThink();
            }
            updateVisuals();
        };

        this.stateManager.runOnReady(updateVisuals);
        this.stateManager.apiManager?.settingsManager?.runOnReady?.(updateVisuals);
        this._subscribe('current_model', updateVisuals);
    }

    initWebSearchToggle() {
        const button = document.getElementById('web-search-toggle');
        if (!button) return;

        const updateVisuals = () => {
            const model = this.stateManager.getSetting('current_model') || '';
            const support = this.stateManager.apiManager.hasWebSearchSupport(model);
            
            button.style.display = support ? 'flex' : 'none';
            if (support) {
                this.stateManager.ensureWebSearchInitialized();
                button.classList.toggle('active', this.stateManager.getShouldWebSearch());
            } else {
                this.stateManager.setShouldWebSearch(false);
            }
            updateTextfieldHeight(this.textarea);
        };

        button.onclick = () => {
            this.stateManager.toggleShouldWebSearch();
            button.classList.toggle('active', this.stateManager.getShouldWebSearch());
        };

        this.stateManager.runOnReady(updateVisuals);
        this.stateManager.apiManager?.settingsManager?.runOnReady?.(updateVisuals);
        this._subscribe('current_model', updateVisuals);
    }

    initImageConfigToggles() {
        const aspectButton = document.getElementById('image-aspect-toggle');
        const resButton = document.getElementById('image-res-toggle');
        if (!aspectButton || !resButton) return;

        const setLabel = (btn, value) => {
            btn.querySelector('.reasoning-label').textContent = value;
        };

        aspectButton.onclick = () => setLabel(aspectButton, this.stateManager.cycleImageAspectRatio());
        resButton.onclick = () => setLabel(resButton, this.stateManager.cycleImageResolution());

        const updateVisuals = () => {
            const model = this.stateManager.getSetting('current_model') || '';
            const isImage = model.includes('gemini') && model.includes('image');
            const isG3 = isImage && /gemini-[3-9]|gemini-\d{2,}/.test(model);
            
            aspectButton.style.display = isImage ? 'flex' : 'none';
            resButton.style.display = isG3 ? 'flex' : 'none';
            
            if (isImage) setLabel(aspectButton, this.stateManager.getImageAspectRatio());
            if (isG3) setLabel(resButton, this.stateManager.getImageResolution());
        };

        this.stateManager.runOnReady(updateVisuals);
        this._subscribe('current_model', updateVisuals);
    }

    initModelPicker() {
        const controls = document.querySelector('.textarea-bottom-left-controls');
        const trigger = document.getElementById('model-picker-toggle');
        if (!trigger || !controls) return;

        const controlsStyle = window.getComputedStyle(controls);
        if (controlsStyle.position === 'static') {
            controls.style.position = 'absolute';
        }
        
        const getModelList = () => {
            const models = this.stateManager.getSetting('models') || {};
            return Object.entries(models).flatMap(([provider, map]) => 
                Object.entries(map).map(([api, display]) => ({ api, display }))
            );
        };

        const popup = document.createElement('div');
        popup.id = 'model-picker-popup';
        popup.className = 'model-picker-popup';
        popup.style.display = 'none';
        
        const list = document.createElement('ul');
        const rebuildList = () => {
            list.innerHTML = '';
            getModelList().forEach(model => {
                const item = document.createElement('li');
                item.textContent = model.display;
                item.onclick = (e) => {
                    e.stopPropagation();
                    this.stateManager.updateSettingsLocal({ current_model: model.api });
                    popup.style.display = 'none';
                };
                list.appendChild(item);
            });
        };

        rebuildList();
        popup.appendChild(list);
        controls.appendChild(popup);

        const updateTriggerText = (key) => {
            const models = this.stateManager.getSetting('models') || {};
            let display = key;
            for (const provider in models) {
                if (key in models[provider]) display = models[provider][key];
            }
            trigger.textContent = (key ? display : 'Select model') + ' ▾';
        };

        this.stateManager.runOnReady(() => updateTriggerText(this.stateManager.getSetting('current_model')));
        this._subscribe('current_model', updateTriggerText);
        
        this._subscribe('models', async () => {
            rebuildList();
            const models = getModelList();
            const current = this.stateManager.getSetting('current_model');
            if (!models.some(m => m.api === current)) {
                const stored = await this.stateManager.loadFromStorage(['current_model']);
                if (stored.current_model && models.some(m => m.api === stored.current_model)) {
                    this.stateManager.updateSettingsLocal({ current_model: stored.current_model });
                } else if (models.length > 0) {
                    this.stateManager.updateSettingsLocal({ current_model: models[0].api });
                }
            }
        });

        trigger.onclick = (e) => {
            e.stopPropagation();
            if (popup.style.display === 'flex') {
                popup.style.display = 'none';
                return;
            }
            
            popup.style.visibility = 'hidden';
            popup.style.display = 'flex';
            const height = popup.offsetHeight;
            popup.style.display = 'none';
            popup.style.visibility = 'visible';

            const rect = trigger.getBoundingClientRect();
            const spaceBelow = window.innerHeight - rect.bottom;

            if (spaceBelow >= height || spaceBelow >= rect.top) {
                popup.style.top = `${trigger.offsetTop + trigger.offsetHeight + POPUP_OFFSET_PX}px`;
                popup.style.bottom = 'auto';
            } else {
                popup.style.top = 'auto';
                popup.style.bottom = `${controls.offsetHeight - trigger.offsetTop + POPUP_OFFSET_PX}px`;
            }
            
            popup.style.left = `${trigger.offsetLeft}px`;
            popup.style.display = 'flex';
        };

        document.addEventListener('click', (e) => {
            if (popup.style.display === 'flex' && !popup.contains(e.target) && !trigger.contains(e.target)) {
                popup.style.display = 'none';
            }
        });
    }

    setTextareaText(text) {
        this.textarea.value = text;
        updateTextfieldHeight(this.textarea);
    }

    getTextareaText() {
        return this.textarea.value;
    }

    addMessage(role, parts = [], options = {}) {
        super.addMessage(role, parts, options);
        this.scrollIntoView();
    }

    createMessage(role, parts = [], options = {}) {
        const element = super.createMessage(role, parts, options);
        if (!this.stateManager.isArenaModeActive && !this.stateManager.isCouncilModeActive) {
            this.activeDivs = element;
        }
        return element;
    }

    createArenaMessage(messageData = null, options = {}) {
        this.activeDivs = super.createArenaMessage(messageData, options);
        if (!this._isBuildingChat) {
            this.scrollIntoView();
        }
        return this.activeDivs;
    }

    createCouncilMessage(messageData = null, options = {}) {
        this.activeDivs = super.createCouncilMessage(messageData, options);
        if (!this._isBuildingChat) {
            this.scrollIntoView();
        }
        return this.activeDivs;
    }

    updateCouncilStatus(modelId, status) {
        if (!this.activeDivs?.classList.contains('council-message')) return;

        const row = this.activeDivs.querySelector(`.council-row[data-model-id="${modelId}"]`);
        if (!row) return;

        const assistantMessage = row.querySelector('.assistant-message');
        if (assistantMessage) {
            this.appendCouncilStatusPill(assistantMessage, status);
        }

        // Update meta counter
        const meta = this.activeDivs.querySelector('.council-meta');
        if (meta) {
            const rows = this.activeDivs.querySelectorAll('.council-row');
            const totalCount = rows.length;
            const completeCount = Array.from(rows).filter(r => {
                const pill = r.querySelector('.council-status');
                return pill && pill.dataset.status === 'complete';
            }).length;
            meta.textContent = totalCount ? `${completeCount}/${totalCount} complete` : 'No responses yet';

            // Remove synthesizing pill if all initial models are complete
            if (completeCount === totalCount && totalCount > 0) {
                const collector = this.activeDivs.querySelector('.council-collector .assistant-message');
                if (collector) {
                    const pill = collector.querySelector('.council-status[data-status="synthesizing"]');
                    if (pill) pill.remove();
                }
            }
        }
    }

    updateCouncilCollectorStatus(status) {
        if (!this.activeDivs?.classList.contains('council-message')) return;

        const collector = this.activeDivs.querySelector('.council-collector .assistant-message');
        if (!collector) return;

        this.appendCouncilStatusPill(collector, status);
    }

    updateCouncilModelName(modelId, displayName) {
        if (!this.activeDivs?.classList.contains('council-message')) return;
        const row = this.activeDivs.querySelector(`.council-row[data-model-id="${modelId}"]`);
        if (!row) return;

        const assistantMessage = row.querySelector('.assistant-message');
        if (assistantMessage) {
            assistantMessage.dataset.model = displayName;
            const prefixSpan = assistantMessage.querySelector('.message-prefix');
            if (prefixSpan) {
                prefixSpan.textContent = this.generatePrefix('assistant', {
                    model: displayName,
                    hideModels: false
                });
            }
        }
    }

    removeCurrentRemoveMediaButtons() {
        this.conversationDiv.lastChild?.querySelectorAll('.remove-file-button').forEach(btn => btn.remove());
    }

    regenerateResponse(modelId, isRegeneration = true, hideModelName = true, continueFunc, allowContinue = true) {
        const options = { 
            model: modelId, 
            isRegeneration, 
            hideModels: hideModelName, 
            continueFunc, 
            allowContinue 
        };
        
        const block = this.createMessage('assistant', [], options);
        
        if (this.stateManager.isArenaModeActive) {
            const index = this.stateManager.getModelIndex(modelId);
            if (index !== -1) {
                this.activeDivs[index].appendChild(block);
            }
        } else {
            this.conversationDiv.appendChild(block);
        }
        this.scrollIntoView();
    }

    buildChat(chat) {
        this.shouldScroll = false;
        const options = { 
            hideModels: !this.stateManager.getSetting('show_model_name'), 
            continueFunc: this.continueFunc,
            skipTextarea: true
        };
        super.buildChat(chat, options);
        this.resetAutoScroll();
        this.updateChatHeader(chat.title);
        this.scrollIntoView(true);
    }

    addErrorMessage(text) {
        this.conversationDiv.appendChild(this.createSystemMessage(text, 'System Message: Error'));
    }

    addWarningMessage(text) {
        this.conversationDiv.appendChild(this.createSystemMessage(text, 'System Message: Warning'));
    }

    getTopLevelAssistantBlocks() {
        return Array.from(this.conversationDiv.children).filter(child => child.classList?.contains('assistant-message'));
    }

    getLatestAssistantBlock() {
        return this.getTopLevelAssistantBlocks().at(-1) || null;
    }

    isNearBottom(thresholdPx = SCROLL_REENGAGE_PX) {
        return isWithinBottomGrace(this.scrollToElement, thresholdPx);
    }

    resetAutoScroll() {
        this.shouldScroll = true;
        this.lastScrollTop = this.scrollToElement?.scrollTop || 0;
    }

    addCouncilRegenerateFooter(inputTokens, outputTokens, onRegenerate, councilBlockOverride = null) {
        const councilBlock = councilBlockOverride || this.activeDivs;
        if (!councilBlock || !councilBlock.classList.contains('council-message')) return;
        
        // Find the collector's last content div to attach footer (like normal messages)
        const collector = councilBlock.querySelector('.council-collector .assistant-message');
        if (!collector) return;
        
        const contentDivs = collector.querySelectorAll('.message-content');
        const content = contentDivs.length ? contentDivs[contentDivs.length - 1] : collector.querySelector('.message-wrapper');
        if (!content) return;
        
        const existingFooter = content.querySelector('.message-footer');
        if (existingFooter) existingFooter.remove();
        
        new Footer(inputTokens, outputTokens, false, () => false, onRegenerate).create(content);
        this.scrollIntoView();
    }

    addArenaRegenerateButton(arenaBlock, onRegenerate) {
        if (!arenaBlock) return;
        let actionRow = arenaBlock.querySelector('.arena-actions');
        if (!actionRow) {
            actionRow = createElementWithClass('div', 'arena-actions');
            arenaBlock.appendChild(actionRow);
        }
        actionRow.innerHTML = '';
        actionRow.appendChild(createRegenerateButton(onRegenerate, () => actionRow.remove()));
    }

    removeRegenerateButtonsOutside(latestAssistantBlock) {
        this.conversationDiv.querySelectorAll('.regenerate-button').forEach(button => {
            if (!latestAssistantBlock?.contains(button)) {
                const parent = button.parentElement;
                parent?.classList.add('centered');
                button.remove();
                if (parent?.classList.contains('arena-actions')) {
                    parent.remove();
                }
            }
        });
    }

    ensureLatestAssistantRegenerate(handler, options = {}) {
        const latest = this.getLatestAssistantBlock();
        if (!latest || typeof handler !== 'function') return;

        this.removeRegenerateButtonsOutside(latest);
        if (latest.querySelector('.regenerate-button')) return;

        if (latest.classList.contains('council-message')) {
            this.addCouncilRegenerateFooter(options.inputTokens ?? 0, options.outputTokens ?? 0, handler, latest);
            return;
        }

        if (latest.querySelector('.arena-full-container')) {
            const arenaFooter = latest.querySelector('.arena-footer');
            if (arenaFooter && !arenaFooter.classList.contains('slide-left')) {
                return;
            }
            this.addArenaRegenerateButton(latest, handler);
            this.scrollIntoView();
            return;
        }

        this.addRegenerateFooterToMessage(latest, handler);
    }

    addRegenerateFooterToMessage(messageBlock, handler) {
        if (!messageBlock || messageBlock.classList.contains('council-message')) return;

        const candidates = messageBlock.querySelectorAll('.message-content, .image-content');
        const content = candidates.length ? candidates[candidates.length - 1] : messageBlock.querySelector('.message-wrapper');
        if (!content || content.querySelector('.message-footer')) return;

        new Footer(0, 0, false, () => false, handler).create(content);
        this.scrollIntoView();
    }

    scrollIntoView(force = false) {
        if (!this.scrollToElement) return;
        if (!force && !this.shouldScroll) return;

        const element = this.scrollToElement;
        const target = element.scrollHeight - element.clientHeight;

        if (Math.abs(element.scrollTop - target) <= 1) return;

        element.scrollTop = target;
    }

    addContinueToLatestAssistant(index, subIndex = 0, modelKey = null) {
        if (!this.continueFunc) return;

        const latest = this.getLatestAssistantBlock();
        if (!latest || latest.classList.contains('council-message') || latest.querySelector('.arena-full-container')) return;

        const wrapper = latest.querySelector('.history-prefix-wrapper');
        if (wrapper && !wrapper.querySelector('.continue-conversation-button')) {
            wrapper.appendChild(this.createContinueButton(() => this.continueFunc(index, subIndex, modelKey)));
        }
    }

    renderContinueForAssistant(index, subIndex = 0, modelKey = null) {
        this.addContinueToLatestAssistant(index, subIndex, modelKey);
    }

    addCouncilContinueButton(messageIndex = null) {
        if (!this.continueFunc) return;

        const councilBlock = messageIndex == null ? this.activeDivs : this.conversationDiv.children[messageIndex];
        if (!councilBlock?.classList?.contains('council-message')) return;

        const resolvedIndex = Number.isFinite(messageIndex) ? messageIndex : Number(councilBlock.dataset.messageIndex);
        if (!Number.isFinite(resolvedIndex)) return;

        const actions = councilBlock.querySelector('.council-header-actions');
        if (!actions || actions.querySelector('.continue-conversation-button')) return;

        const continueButton = this.createContinueButton(() => this.continueFunc(resolvedIndex, 0));
        continueButton.classList.add('council-continue-button');
        actions.appendChild(continueButton);
    }

    addRegenerateFooterToLastMessage(handler) {
        this.ensureLatestAssistantRegenerate(handler);
    }

    initScrollListener() {
        if (this.isScrollActive || !this.scrollToElement) return;
        
        this.lastScrollTop = this.scrollToElement.scrollTop;
        this.scrollToElement.addEventListener('scroll', () => {
            const current = this.scrollToElement.scrollTop;
            const previous = this.lastScrollTop;
            this.lastScrollTop = current;

            if (current < previous) {
                this.shouldScroll = false;
                return;
            }

            if (this.isNearBottom()) {
                this.shouldScroll = true;
            }
        }, { passive: true });

        this.isScrollActive = true;
        if (this.isNearBottom(SCROLL_BOTTOM_THRESHOLD_PX)) {
            this.shouldScroll = true;
        }
    }

    addArenaFooter(onChoice) {
        const footer = createElementWithClass('div', 'arena-footer');
        const buttons = [
            { text: '👁', choice: 'reveal', style: 'reveal' },
            { text: '✓', choice: 'model_a', style: 'choice' },
            { text: '==', choice: 'draw', style: 'draw' },
            { text: '✓', choice: 'model_b', style: 'choice' },
            { text: 'X', choice: 'no_choice(bothbad)', style: 'no-choice' }
        ];

        buttons.forEach(btnConfig => {
            const button = createElementWithClass('button', `button arena-button ${btnConfig.style}`, btnConfig.text);
            button.onclick = () => {
                this.removeArenaFooter();
                this.removeRegenerateButtons();
                onChoice(btnConfig.choice);
            };
            this.setupArenaButtonHover(button);
            footer.appendChild(button);
        });

        this.activeDivs[0].parentElement.parentElement.appendChild(footer);
        this.scrollIntoView();
    }

    resolveArena(choice, continuedWith, _, eloRatings = null) {
        super.resolveArena(choice, continuedWith, this.activeDivs, eloRatings);
        this.addArenaContinueButtons();
        this.scrollIntoView();
        this.activeDivs = null;
    }

    addArenaContinueButtons() {
        if (!this.continueFunc || !Array.isArray(this.activeDivs)) return;
        
        const index = Number(this.activeDivs[0]?.closest('.assistant-message')?.dataset?.messageIndex);
        if (!Number.isFinite(index)) return;

        this.activeDivs.forEach(wrapper => {
            const modelKey = wrapper.dataset.modelKey;
            wrapper.querySelectorAll('.assistant-message').forEach((msg, subIdx) => {
                const prefix = msg.querySelector('.history-prefix-wrapper');
                if (prefix && !prefix.querySelector('.continue-conversation-button')) {
                    prefix.appendChild(this.createContinueButton(() => this.continueFunc(index, subIdx, modelKey)));
                }
            });
        });
    }

    setupArenaButtonHover(button) {
        const updateOthers = (isEntering) => {
            const all = button.parentElement.querySelectorAll('button');
            all.forEach(other => {
                if (other === button) return;
                
                if (isEntering && button.classList.contains('choice') && other.classList.contains('choice')) {
                    other.classList.add('choice-not-hovered');
                    other.textContent = 'X';
                } else {
                    other.classList.toggle('hovered', isEntering);
                    if (!isEntering && other.classList.contains('choice')) {
                        other.classList.remove('choice-not-hovered');
                        other.textContent = '✓';
                    }
                }
            });
        };
        
        button.onmouseenter = () => updateOthers(true);
        button.onmouseleave = () => updateOthers(false);
    }

    removeArenaFooter() {
        const footer = this.activeDivs[0].parentElement.parentElement.querySelector('.arena-footer');
        if (footer) {
            footer.classList.add('slide-left');
            footer.ontransitionend = (e) => {
                if (e.propertyName === 'opacity') {
                    footer.classList.add('slide-up');
                } else if (e.propertyName === 'margin-top') {
                    footer.remove();
                }
            };
        }
    }

    updateIncognitoButtonVisuals(button) {
        button?.classList.toggle('active', !this.stateManager.shouldSave);
    }

    setupIncognitoButtonHandlers(button, footer, hoverLabels, hasChatStarted) {
        const updateHoverText = () => {
            const started = hasChatStarted();
            const normal = this.stateManager.isChatNormal();
            const incognito = this.stateManager.isChatIncognito();
            
            hoverLabels[0].textContent = (started && normal) ? "continue" : (!started && incognito) ? "leave" : (started && incognito) ? "actually," : "start new";
            hoverLabels[1].textContent = (started && normal) ? "in incognito" : (!started && incognito) ? "incognito" : (started && incognito) ? "save it please" : "incognito chat";
        };

        button.onmouseenter = () => {
            updateHoverText();
            footer.classList.add('showing-text');
        };

        button.onmouseleave = () => {
            footer.classList.remove('showing-text');
            hoverLabels.forEach(label => {
                label.ontransitionend = () => {
                    if (!footer.classList.contains('showing-text')) label.textContent = "";
                };
            });
        };

        button.onclick = () => {
            this.stateManager.toggleChatState(hasChatStarted());
            updateHoverText();
            this.updateIncognitoButtonVisuals(button);
        };
    }

    updateIncognito(started = false) {
        // Prevent updates if tab is not active
        if (this.conversationDiv.closest('.tab-content-container:not(.active)')) return;
        this.updateIncognitoButtonVisuals(document.getElementById('incognito-toggle'));
    }

    getContentDiv(modelId) {
        const element = this.getActiveMessageElement(modelId);
        if (!element) return null;
        
        const candidates = element.querySelectorAll('.message-content, .image-content');
        return candidates.length ? candidates[candidates.length - 1] : element.querySelector('.message-wrapper');
    }

    updateChatHeader(title) {
        const element = this.conversationDiv.querySelector('.conversation-title');
        if (element) element.textContent = title;
    }

    updateLastMessageModelName(actualModelName) {
        if (!this.stateManager.getSetting('show_model_name') || this.stateManager.isArenaModeActive) return;
        
        const assistantMessages = this.conversationDiv.querySelectorAll('.assistant-message');
        const lastAssistantMessage = assistantMessages[assistantMessages.length - 1];
        if (!lastAssistantMessage) return;

        const prefixSpan = lastAssistantMessage.querySelector('.message-prefix');
        if (!prefixSpan) return;

        let newPrefixText = actualModelName;
        if (prefixSpan.textContent.includes('💡')) newPrefixText += ' 💡';
        if (prefixSpan.textContent.includes('\u{27F3}')) newPrefixText += ' \u{27F3}';
        prefixSpan.textContent = newPrefixText;
    }

    getChatHeader() {
        return this.conversationDiv.querySelector('.conversation-title');
    }

    clearConversation(options = {}) {
        const titleWrapper = this.conversationDiv.querySelector('.title-wrapper');
        super.clearConversation(options);
        if (titleWrapper) this.conversationDiv.prepend(titleWrapper);
        this.activeDivs = null;
        this.resetAutoScroll();
        this.updateChatHeader('conversation');
        if (!options.skipTextarea) {
            this.setTextareaText('');
        }
    }

    getActiveMessageElement(modelId) {
        if (this.stateManager.isCouncilModeActive && this.activeDivs) {
            // If modelId is the collector model, we stream to the collector area
            if (modelId === this.stateManager.getCouncilCollectorModel()) {
                const collector = this.activeDivs.querySelector('.council-collector .assistant-message');
                if (collector) return collector;
                
                const contents = this.activeDivs.querySelectorAll('.council-collector .message-content');
                return contents.length ? contents[contents.length - 1] : this.activeDivs;
            }
            const row = this.activeDivs.querySelector(`.council-row[data-model-id="${modelId}"] .council-row-content`);
            if (row) return row;
            
            const contents = this.activeDivs.querySelectorAll('.council-row-content .message-content');
            return contents.length ? contents[contents.length - 1] : this.activeDivs;
        }
        if (!this.stateManager.isArenaModeActive) return this.activeDivs;
        const index = this.stateManager.getModelIndex(modelId);
        return (index !== -1 && Array.isArray(this.activeDivs)) ? this.activeDivs[index] : null;
    }

    getActiveMessagePrefixElement(modelId) {
        const element = this.getActiveMessageElement(modelId);
        if (!element) return null;
        
        const wrappers = element.querySelectorAll('.history-prefix-wrapper');
        return wrappers.length ? wrappers[wrappers.length - 1] : element;
    }

    setArenaModelDisplayName(id, name) {
        const element = this.getActiveMessageElement(id);
        if (element) element.dataset.displayName = name;
    }

    addManualAbortButton(modelId, onAbort) {
        const element = this.getActiveMessagePrefixElement(modelId);
        if (!element) return;
        
        const button = this.createRemoveButton(onAbort);
        button.classList.add('manual-abort-button');
        button.textContent = '⏸';
        element.appendChild(button);
    }

    removeManualAbortButton(modelId) {
        const button = this.getActiveMessagePrefixElement(modelId)?.querySelector('.manual-abort-button');
        if (button) button.remove();
    }
}

/**
 * UI Controller for the History page.
 */
export class HistoryChatUI extends ChatUI {
    constructor(options) {
        super(options);
        Object.assign(this, {
            historyList: this.stateManager.historyList,
            continueFunc: options.continueFunc,
            addPopup: options.addPopupActions,
            loadHistory: options.loadHistoryItems,
            loadChat: options.loadChat,
            getMeta: options.getChatMeta,
            mode: 'history',
            inSearch: false,
            requestMoreSearch: null,
            paginator: this.createPaginator(),
            renderedIds: new Set(),
            resultCategories: new Map(),
            activeHighlights: []
        });

        this.historyList.onscroll = () => {
            const { scrollTop, scrollHeight, clientHeight } = this.historyList;
            if (scrollHeight - (scrollTop + clientHeight) < HISTORY_SCROLL_BUFFER) {
                this.paginator.requestMore({ reason: 'scroll' });
            }
        };

        this.initKeyboardNav();
        this.paginator.requestMore({ reason: 'initial' });
    }

    createCouncilMessage(messageData, options = {}) {
        return super.createCouncilMessage(messageData, { ...options, hideModels: false });
    }

    createPaginator() {
        let pending = null;
        let offset = 0;
        let hasMore = true;

        const requestMore = async ({ reason = 'manual' } = {}) => {
            const hasSearchLoader = typeof this.requestMoreSearch === 'function';
            if (pending || (this.mode !== 'search' && !hasMore) || (this.mode === 'search' && !hasSearchLoader)) {
                return false;
            }

            this.stateManager.isLoading = true;
            pending = (async () => {
                try {
                    if (this.mode === 'search') {
                        const beforeCount = this.getVisibleCount();
                        await this.requestMoreSearch(reason);
                        return this.getVisibleCount() > beforeCount;
                    }

                    const items = await this.loadHistory(this.stateManager.limit, offset);
                    if (!items.length) {
                        hasMore = false;
                        return false;
                    }

                    items.forEach(item => this.addHistoryItem(item));
                    offset += items.length;
                    this.stateManager.offset = offset;
                    return true;
                } finally {
                    this.stateManager.isLoading = false;
                    pending = null;
                    if (hasMore && this.mode === 'history' && this.stateManager.shouldLoadMore()) {
                        requestMore({ reason: 'auto' });
                    }
                }
            })();
            return pending;
        };

        return {
            requestMore,
            reset: (modeOrOptions = 'history', options = {}) => {
                let mode = modeOrOptions;
                let preserveOffset = options?.preserveOffset ?? false;
                if (modeOrOptions && typeof modeOrOptions === 'object') {
                    mode = modeOrOptions.mode ?? 'history';
                    preserveOffset = modeOrOptions.preserveOffset ?? false;
                }
                pending = null;
                hasMore = true;
                this.mode = mode;
                if (!preserveOffset) {
                    offset = 0;
                    this.stateManager.offset = 0;
                }
            }
        };
    }

    initKeyboardNav() {
        const findNext = (current, direction) => {
            let next = direction === 'up' ? current.previousElementSibling : current.nextElementSibling;
            while (next && (next.classList.contains('history-divider') || next.classList.contains('search-hidden'))) {
                next = direction === 'up' ? next.previousElementSibling : next.nextElementSibling;
            }
            return next?.classList.contains('history-sidebar-item') ? next : null;
        };

        document.addEventListener('keydown', async (e) => {
            if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
            
            const current = document.activeElement;
            if (!current?.classList.contains('history-sidebar-item') || !this.historyList.contains(current)) return;

            e.preventDefault();
            const direction = e.key === 'ArrowUp' ? 'up' : 'down';
            let next = findNext(current, direction);
            
            if (!next && direction === 'down' && await this.paginator.requestMore({ reason: 'keyboard' })) {
                next = findNext(current, direction);
            }

            if (next) {
                next.focus();
                next.click();
                next.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
                next.classList.add('keyboard-navigating');
                setTimeout(() => next.classList.remove('keyboard-navigating'), KEYBOARD_NAV_HIGHLIGHT_MS);
            }
        });
    }

    _setSearchMatch(elements, value) {
        elements.forEach(element => {
            if (value === null) {
                delete element.dataset.searchMatch;
            } else {
                element.dataset.searchMatch = value;
            }
        });
    }

    _toggleSearchHidden(elements, isHidden) {
        elements.forEach(element => element.classList.toggle('search-hidden', isHidden));
    }

    _getHistoryItems() {
        return this.historyList.querySelectorAll('.history-sidebar-item');
    }

    _getDividers() {
        return this.historyList.querySelectorAll('.history-divider');
    }

    startSearchMode() {
        if (!this.inSearch) {
            this.inSearch = true;
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
        if (!this.inSearch) return;
        this.inSearch = false;
        this.historyList.classList.remove('is-searching');

        this.historyList.querySelectorAll('.history-sidebar-item[data-search-temp="true"]').forEach(item => item.remove());
        
        const items = this._getHistoryItems();
        this._setSearchMatch(items, null);
        this._toggleSearchHidden(items, false);

        const dividers = this._getDividers();
        this._setSearchMatch(dividers, null);
        this._toggleSearchHidden(dividers, false);

        this.clearSearchResults();
        this.requestMoreSearch = null;
        this.paginator.reset();
    }

    clearSearchResults() {
        this.historyList.querySelectorAll('.history-sidebar-item[data-search-temp="true"]').forEach(item => item.remove());
        this.historyList.querySelectorAll('.history-divider[data-search-temp="true"]').forEach(divider => divider.remove());
        this._setSearchMatch(this._getHistoryItems(), null);
        this._setSearchMatch(this._getDividers(), null);
        this.historyList.querySelector('.search-no-results')?.remove();
        this.historyList.querySelector('.search-counter')?.remove();
        this.renderedIds.clear();
        this.resultCategories.clear();
    }

    setSearchLoader(loader) {
        this.requestMoreSearch = typeof loader === 'function' ? loader : null;
    }

    renderSearchResults(results = [], options = {}) {
        return this.renderResults(results, options);
    }

    setSearchHighlight(config) {
        if (!config) {
            this.setHighlight(null);
            return;
        }
        const { rawQuery, resultIds, normalizedQuery, highlightAllowed } = config;
        this.setHighlight({
            raw: rawQuery,
            ids: resultIds,
            norm: normalizedQuery,
            allowed: highlightAllowed
        });
    }

    getSearchContainer() {
        return this.historyList;
    }

    renderResults(results = [], options = {}) {
        const desiredIds = new Set(results.map(result => `${result.id}`));
        const shouldAppend = options?.append === true;

        if (!shouldAppend) {
            this.clearSearchResults();
        }

        results.forEach(({ doc, id }) => {
            const idString = `${id}`;
            let item = this.getHistoryItem(idString);
            const category = this.getDateCategorySafe(doc?.timestamp);

            if (!item && doc) {
                item = this.createSearchTempItem(doc);
            }
            
            if (item) {
                item.dataset.searchMatch = 'true';
                item.classList.remove('search-hidden');
                this.ensureSearchDividerForItem(item, category);
            }
        });

        if (!shouldAppend) {
            this.historyList.querySelectorAll('.history-sidebar-item[data-search-temp="true"]').forEach(item => {
                if (!desiredIds.has(item.id)) {
                    item.remove();
                }
            });
            this.renderedIds = new Set(desiredIds);
        } else {
            results.forEach(({ id }) => this.renderedIds.add(`${id}`));
        }

        this._getHistoryItems().forEach(item => {
            if (item.dataset.searchTemp === 'true') {
                item.classList.remove('search-hidden');
            } else {
                item.classList.toggle('search-hidden', item.dataset.searchMatch !== 'true');
            }
        });

        this._getDividers().forEach(divider => {
            divider.classList.toggle('search-hidden', divider.dataset.searchMatch !== 'true');
        });

        const noResultsMessage = this.historyList.querySelector('.search-no-results');
        if (!results.length && !noResultsMessage) {
            this.historyList.appendChild(createElementWithClass('div', 'search-no-results', 'No results found'));
        } else if (results.length && noResultsMessage) {
            noResultsMessage.remove();
        }

        if (options?.showCounter) {
            this.updateSearchCounter(options.totalCount ?? 0, this.renderedIds.size);
        }
    }

    createSearchTempItem(doc) {
        const historyItem = createElementWithClass('button', 'unset-button history-sidebar-item');
        historyItem.id = `${doc.id}`;
        historyItem.dataset.searchTemp = 'true';

        const titleText = doc?.title || 'Untitled chat';
        const textSpan = createElementWithClass('span', 'item-text', titleText);
        const dotsSpan = createElementWithClass('div', 'action-dots', UNICODE.ELLIPSIS);

        historyItem.append(textSpan, dotsSpan);
        historyItem.onclick = () => this.buildChat(doc.id);
        this.addPopup(historyItem);

        this.historyList.appendChild(historyItem);
        return historyItem;
    }

    updateSearchCounter(total = 0, visible = 0) {
        const existingCounter = this.historyList.querySelector('.search-counter');
        if (total <= 0) {
            if (existingCounter) existingCounter.remove();
            return;
        }

        const counterText = visible >= total ? `${visible} results` : `${visible} of ${total} results`;

        if (existingCounter) {
            existingCounter.textContent = counterText;
            return;
        }

        const counterElement = createElementWithClass('div', 'search-counter', counterText);
        counterElement.setAttribute('role', 'status');
        counterElement.setAttribute('aria-live', 'polite');
        this.historyList.prepend(counterElement);
    }

    ensureSearchDividerForItem(item, category) {
        const targetCategory = category || 'Unknown';
        const cachedDivider = this.resultCategories.get(targetCategory);

        if (cachedDivider && cachedDivider.isConnected) {
            cachedDivider.dataset.searchMatch = 'true';
            cachedDivider.classList.remove('search-hidden');
            return;
        }

        const previousSibling = item.previousElementSibling;
        if (previousSibling?.classList.contains('history-divider') && previousSibling.textContent === targetCategory) {
            previousSibling.dataset.searchMatch = 'true';
            previousSibling.classList.remove('search-hidden');
            this.resultCategories.set(targetCategory, previousSibling);
            return;
        }

        const dateDivider = createElementWithClass('div', 'history-divider', targetCategory);
        dateDivider.dataset.searchTemp = 'true';
        dateDivider.dataset.searchMatch = 'true';
        dateDivider.classList.remove('search-hidden');
        this.resultCategories.set(targetCategory, dateDivider);
        this.historyList.insertBefore(dateDivider, item);
    }

    getDateCategorySafe(timestamp) {
        if (typeof timestamp === 'number' && Number.isFinite(timestamp)) {
            return this.getDateCategory(timestamp);
        }
        const parsedTimestamp = Number(timestamp);
        if (Number.isFinite(parsedTimestamp)) {
            return this.getDateCategory(parsedTimestamp);
        }
        return 'Unknown';
    }

    getVisibleCount() {
        return this.historyList.querySelectorAll('.history-sidebar-item:not(.search-hidden)').length;
    }

    getHistoryItem(id) {
        return document.getElementById(id);
    }

    reloadHistoryList() {
        this.stateManager.reset();
        this.historyList.innerHTML = '';
        this.paginator.reset();
        this.paginator.requestMore({ reason: 'initial' });
    }

    addHistoryItem(chat) {
        const existing = document.getElementById(chat.chatId);
        if (existing) {
            if (existing.dataset.searchTemp) existing.remove();
            else return existing;
        }

        const category = this.getDateCategory(chat.timestamp);
        if (category !== this.stateManager.lastDateCategory) {
            const divider = createElementWithClass('div', 'history-divider', category);
            if (this.inSearch) {
                divider.dataset.searchMatch = 'false';
                divider.classList.add('search-hidden');
            }
            this.historyList.appendChild(divider);
            this.stateManager.lastDateCategory = category;
        }

        const item = this.createHistoryItem(chat);
        this.historyList.appendChild(item);
        
        if (this.inSearch) {
            item.dataset.searchMatch = 'false';
            item.classList.add('search-hidden');
        }
        return item;
    }

    createHistoryItem(chat) {
        const button = createElementWithClass('button', 'unset-button history-sidebar-item');
        button.id = chat.chatId;
        button.append(
            createElementWithClass('span', 'item-text', chat.title), 
            createElementWithClass('div', 'action-dots', '⋯')
        );
        button.onclick = () => this.buildChat(chat.chatId);
        this.addPopup(button);
        return button;
    }

    handleItemDeletion(item) {
        const previous = item.previousElementSibling;
        const next = item.nextElementSibling;
        item.remove();
        
        // Remove divider if it becomes empty
        if (previous?.classList.contains('history-divider') && (!next || next.classList.contains('history-divider'))) {
            previous.remove();
        }
        
        if (this.historyList.scrollHeight <= this.historyList.clientHeight) {
            this.paginator.requestMore({ reason: 'deletion' });
        }
    }

    handleNewChatSaved(chat) {
        const category = this.getDateCategory(chat.timestamp);
        const first = this.historyList.firstElementChild;
        const item = this.createHistoryItem(chat);

        if (this.inSearch) {
            item.dataset.searchMatch = 'false';
            item.classList.add('search-hidden');
        }

        if (first?.classList.contains('history-divider') && first.textContent === category) {
            this.historyList.insertBefore(item, first.nextSibling);
        } else {
            const divider = createElementWithClass('div', 'history-divider', category);
            if (this.inSearch) {
                divider.dataset.searchMatch = 'false';
                divider.classList.add('search-hidden');
            }
            this.historyList.prepend(item);
            this.historyList.prepend(divider);
        }
    }

    appendMessages(messages, start) {
        messages.forEach((msg, i) => {
            const messageId = msg.messageId ?? (start + i);
            if (msg.responses) {
                this.createArenaWrapper(msg, { continueFunc: this.continueFunc, messageIndex: messageId, messageId });
            } else if (msg.council) {
                this.createCouncilWrapper(msg, { continueFunc: this.continueFunc, messageIndex: messageId, messageId });
            } else {
                this.buildFullMessage(msg, messageId);
            }
            this.pendingMediaDiv = null;
        });
    }

    buildFullMessage(message, index) {
        message.contents.forEach((parts, subIndex) => {
            const options = { ...message, hideModels: false, isRegeneration: subIndex !== 0 };
            if (this.continueFunc) {
                options.continueFunc = () => this.continueFunc(index, subIndex);
            }
            const block = this.createMessageFromParts(parts, options);
            if (block) {
                this.conversationDiv.appendChild(block);
            }
        });
    }

    appendSingleRegen(message, index) {
        const callback = () => this.continueFunc(index, message.contents.length - 1, message.role);
        const options = { 
            hideModels: false, 
            isRegeneration: true, 
            continueFunc: callback, 
            messageId: message.messageId, 
            ...message 
        };
        this.addMessage(message.role, message.contents.at(-1), options);
    }

    updateArena(message, index) {
        const oldBlock = this.conversationDiv.querySelector(`.assistant-message[data-message-id="${index}"]`) || this.conversationDiv.children[index];
        if (oldBlock) {
            const divs = this.createArenaWrapper(message, { 
                continueFunc: this.continueFunc, 
                messageIndex: index,
                messageId: message.messageId ?? index
            });
            const newBlock = divs[0].parentElement.parentElement;
            newBlock.remove(); // Prevent duplicate append from createArenaWrapper
            this.conversationDiv.replaceChild(newBlock, oldBlock);
        }
    }

    getDateCategory(timestamp) {
        const date = new Date(timestamp);
        const now = new Date();
        const getMidnight = dateObject => new Date(dateObject.getFullYear(), dateObject.getMonth(), dateObject.getDate()).getTime();
        const dayDifference = (getMidnight(now) - getMidnight(date)) / MS_PER_DAY;
        
        if (dayDifference === 0) return 'Today';
        if (dayDifference === 1) return 'Yesterday';
        if (dayDifference <= 7) return 'Last 7 Days';
        if (dayDifference <= 30) return 'Last 30 Days';
        
        return date.getFullYear() === now.getFullYear() 
            ? date.toLocaleString('default', { month: 'long' }) 
            : `${date.getFullYear()}`;
    }

    updateChatHeader(titleText) {
        const headerElement = document.getElementById('history-chat-header');
        if (headerElement) {
            headerElement.textContent = titleText;
        }
    }

    handleRenamed(chatId, newTitle) {
        const historyItem = document.getElementById(chatId);
        const textSpan = historyItem?.querySelector('.item-text');
        if (textSpan) {
            textSpan.textContent = newTitle;
        }
    }

    autoUpdateHeader(chatId) {
        const historyItem = document.getElementById(chatId);
        const titleText = historyItem?.querySelector('.item-text')?.textContent;
        if (titleText && !['Renaming...', 'Rename failed'].includes(titleText)) {
            this.updateChatHeader(titleText);
            return titleText;
        }
        return null;
    }

    highlightItem(chatId) {
        const historyItem = document.getElementById(chatId);
        if (historyItem) {
            historyItem.classList.add('highlight');
            historyItem.addEventListener('transitionend', () => historyItem.classList.remove('highlight'), { once: true });
        }
    }

    async buildChat(chatId) {
        this.activeId = chatId;
        const fullChatData = await this.loadChat(chatId);
        
        super.buildChat(fullChatData, { 
            hideModels: false, 
            addSystemMsg: true, 
            continueFunc: this.continueFunc 
        });
        
        this.updateChatHeader(fullChatData.title);
        this.addLinkedChat(fullChatData.continued_from_chat_id);
        
        const footerElement = document.getElementById('history-chat-footer');
        if (footerElement) {
            footerElement.textContent = new Date(fullChatData.timestamp).toString().split(' GMT')[0];
        }
        
        this.applyHighlight({ force: true });
    }

    clearConversation() {
        this.clearHighlights();
        super.clearConversation();
        this.updateChatHeader('conversation');
        const titleWrapper = document.getElementById('title-wrapper');
        const linkedChatButton = titleWrapper.querySelector('.linked-chat');
        if (linkedChatButton) {
            linkedChatButton.remove();
        }
        const footerElement = document.getElementById('history-chat-footer');
        if (footerElement) {
            footerElement.textContent = '';
        }
    }

    // --- Search Highlighting ---

    setHighlight(config) {
        this.highlightConfig = config?.raw?.length 
            ? { ...config, allowed: config.allowed !== false } 
            : null;
        this.applyHighlight();
    }

    applyHighlight({ force = false } = {}) {
        this.clearHighlights();
        if (!this.highlightConfig?.raw || this.activeId == null) return;
        
        const { ids, raw, norm, allowed } = this.highlightConfig;
        if ((allowed === false && !force) || (ids?.length && !ids.includes(this.activeId))) return;

        const matches = this.findMatches({ raw, norm });
        this.highlights = matches;
        
        if (matches.length > 0) {
            matches[0].classList.add('is-first');
            if (force) {
                requestAnimationFrame(() => matches[0].scrollIntoView({ behavior: 'smooth', block: 'center' }));
            }
        }
    }

    clearHighlights() {
        if (!this.highlights?.length) return;
        
        const parents = new Set();
        this.highlights.forEach(span => {
            const parent = span.parentNode;
            if (!parent) return;
            while (span.firstChild) parent.insertBefore(span.firstChild, span);
            span.remove();
            parents.add(parent);
        });
        
        parents.forEach(p => p.normalize());
        this.highlights = [];
    }

    findMatches({ raw, norm }) {
        const source = raw?.trim() || norm?.trim();
        if (!source) return [];
        
        const pattern = source.split(/(\s+)/)
            .filter(Boolean)
            .map(p => /^\s+$/.test(p) ? '\\s+' : p.replace(/[.*+?^${}()|[\\]/g, '\\$&'))
            .join('');
            
        const matches = [];
        const regex = new RegExp(pattern, 'gi');
        
        this.conversationDiv.querySelectorAll('.message-content').forEach(element => {
            const text = element.textContent;
            if (!text) return;
            
            const results = [...text.matchAll(regex)];
            const localMatches = [];
            
            for (let i = results.length - 1; i >= 0; i--) {
                const range = this.createRange(element, results[i].index, results[i][0].length);
                if (!range) continue;
                
                const span = document.createElement('span');
                span.className = 'search-highlight';
                try {
                    range.surroundContents(span);
                    localMatches.unshift(span);
                } catch(e) {}
            }
            if (localMatches.length > 0) matches.push(...localMatches);
        });
        
        return matches;
    }

    createRange(element, start, length) {
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        let current = walker.nextNode();
        let remainingOffset = start;
        
        while (current && remainingOffset >= current.textContent.length) {
            remainingOffset -= current.textContent.length;
            current = walker.nextNode();
        }
        
        if (!current) return null;
        
        const range = document.createRange();
        range.setStart(current, remainingOffset);
        
        let endNode = current;
        let endOffset = remainingOffset;
        let remainingLength = length;
        
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
