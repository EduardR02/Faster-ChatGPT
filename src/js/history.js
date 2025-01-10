import { ChatStorage } from './utils.js';
import { ApiManager } from './api_manager.js';
import { HistoryChatUI } from './chat_ui.js';
import { HistoryStateManager } from './state_manager.js';
import { HistoryRenameManager } from './rename_manager.js';


class PopupMenu {
    constructor(renameManager, chatStorage) {
        this.renameManager = renameManager;
        this.chatStorage = chatStorage;
        this.activePopup = null;
        this.autoRenameHeaderFunc = null;
        this.init();
    }

    init() {
        this.popup = document.querySelector('.popup-menu');
        this.initRenameLogic();
        document.addEventListener('click', this.handleGlobalClick.bind(this));
        this.popup.addEventListener('click', this.handlePopupClick.bind(this));
    }

    initRenameLogic() {
        const confirmBtn = this.popup.querySelector('.rename-confirm');
        const cancelBtn = this.popup.querySelector('.rename-cancel');

        confirmBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.confirmRename();
        });

        cancelBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.restorePopupMenu();
        });

        const input = this.popup.querySelector('.rename-input');
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                this.confirmRename();
            } else if (e.key === 'Escape') {
                this.hidePopup();
            }
        });
    }

    addHistoryItem(item) {
        const dots = item.querySelector('.action-dots');
        dots.addEventListener('click', (e) => this.handleDotsClick(e, item));
    }

    handleDotsClick(e, item) {
        e.stopPropagation();

        if (this.activePopup === item) {
            this.hidePopup();
            return;
        }

        // Restore popup menu state before showing it for another item
        this.restorePopupMenu();

        const rect = item.getBoundingClientRect();
        this.popup.style.top = `${rect.top}px`;
        this.popup.style.left = `${rect.right + 5}px`;

        this.popup.classList.add('active');
        this.activePopup = item;
    }

    handlePopupClick(e) {
        e.stopPropagation();
        const action = e.target.dataset.action;
        if (!action) return;

        switch (action) {
            case 'rename':
                const renameButton = this.popup.querySelector('[data-action="rename"]');
                const inputWrapper = this.popup.querySelector('.rename-input-wrapper');
                const deleteButton = this.popup.querySelector('[data-action="delete"]');
                const autoRenameButton = this.popup.querySelector('[data-action="auto-rename"]');
                const input = this.popup.querySelector('.rename-input');

                renameButton.style.display = 'none';
                deleteButton.style.display = 'none';
                inputWrapper.style.display = 'flex';
                autoRenameButton.style.display = 'none';
                input.value = this.activePopup.querySelector('.item-text').textContent;
                input.focus();
                break;
            case 'delete':
                this.deleteChat(this.activePopup, e.target);
                break;
            case 'auto-rename':
                this.autoRenameSingleChat(this.activePopup);
                break;
        }
    }

    handleGlobalClick() {
        this.hidePopup();
    }

    restorePopupMenu() {
        this.popup.querySelector('[data-action="rename"]').style.display = 'block';
        this.popup.querySelector('.rename-input-wrapper').style.display = 'none';
        this.popup.querySelector('[data-action="delete"]').style.display = 'block';
        this.popup.querySelector('[data-action="auto-rename"]').style.display = 'block';

        // Reset the delete button state
        const deleteButton = this.popup.querySelector('[data-action="delete"]');
        if (deleteButton) {
            deleteButton.classList.remove('delete-confirm');
            deleteButton.textContent = 'Delete';
        }
    }

    hidePopup() {
        this.restorePopupMenu();
        this.popup.classList.remove('active');
        this.activePopup = null;
    }

    confirmRename() {
        const newName = this.popup.querySelector('.rename-input').value.trim();
        if (newName) {
            const textSpan = this.activePopup.querySelector('.item-text');
            const oldName = textSpan.textContent;
            textSpan.textContent = textSpan.textContent.replace(oldName, newName);
            if (currentChat)
                currentChat.meta.title = this.autoRenameHeaderFunc(currentChat) || currentChat.meta.title;
            this.chatStorage.renameChat(parseInt(this.activePopup.id, 10), newName);
        }
        this.hidePopup();
    }

    deleteChat(item, popupItem) {
        if (popupItem.classList.contains('delete-confirm')) {
            item.remove();
            // clear the conversation-div
            document.getElementById('conversation-wrapper').innerHTML = '';
            document.getElementById('history-chat-footer').textContent = '';

            this.chatStorage.deleteChat(parseInt(item.id, 10));
            this.hidePopup();
        } else {
            popupItem.classList.add('delete-confirm');
            popupItem.textContent = 'Sure?';
        }
    }

    async autoRenameSingleChat(item) {
        const textSpan = item.querySelector('.item-text');
        const result = await this.renameManager.renameSingleChat(parseInt(item.id, 10), textSpan);
        
        if (result?.tokenCounter) {
            result.tokenCounter.updateLifetimeTokens();
            if (currentChat)
                currentChat.meta.title = this.autoRenameHeaderFunc(currentChat) || currentChat.meta.title;
        }
        
        this.hidePopup();
    }
}


let currentChat = null;
const chatStorage = new ChatStorage();
const apiManager = new ApiManager();
const renameManager = new HistoryRenameManager(chatStorage);
const popupMenu = new PopupMenu(renameManager, chatStorage);
const stateManager = new HistoryStateManager();
const chatUI = new HistoryChatUI({
    stateManager,
    popupMenu,
    continueFunc: (index, arenaMessageIndex, modelChoice) => 
        sendChatToSidepanel(buildChat(index, arenaMessageIndex, modelChoice)),
    loadHistoryItems: chatStorage.getChatMetadata.bind(chatStorage),
    addPopupActions: popupMenu.addHistoryItem.bind(popupMenu),
    loadChat: async (chatId) => {
        currentChat = await chatStorage.loadChat(chatId);
        return currentChat;
    },
});
popupMenu.autoRenameHeaderFunc = chatUI.autoUpdateChatHeader.bind(chatUI);


function initMessageListeners() {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        switch (message.type) {
            case 'new_chat_saved':
                chatUI.handleNewChatSaved(message.chat);
                break;
            case 'appended_messages_to_saved_chat':
                handleAppendedMessages(message.chatId, message.addedCount);
                break;
            case 'saved_arena_message_updated':
                handleArenaMessageUpdate(message.chatId, message.messageId);
                break;
        }
    });
}

async function handleAppendedMessages(chatId, addedCount) {
    if (!currentChat || currentChat.meta.chatId !== chatId) return;
    
    const newMessages = await chatStorage.getLatestMessages(chatId, addedCount);
    if (!newMessages) return;
    
    const len = currentChat.messages.length;
    chatUI.appendMessages(newMessages, len, currentChat.messages[len - 1]?.role);
    currentChat.messages.push(...newMessages);
}

async function handleArenaMessageUpdate(chatId, messageId) {
    if (!currentChat || currentChat.meta.chatId !== chatId) return;
    
    const updatedMessage = await chatStorage.getMessage(chatId, messageId);
    if (!updatedMessage) return;
    
    const messageIndex = currentChat.messages.findIndex(m => m.messageId === messageId);
    if (messageIndex === -1) {
        if (messageId === currentChat.messages[currentChat.messages.length - 1].messageId + 1) {
            handleAppendedMessages(chatId, 1);
        }
        return;
    }
    
    chatUI.updateArenaMessage(updatedMessage, messageIndex);
    currentChat.messages[messageIndex] = updatedMessage;
}


function buildChat(continueFromIndex, arenaMessageIndex = null, modelChoice = null) {
    const workingMessages = currentChat.messages.slice(0, continueFromIndex + 1);

    const simplifiedChat = [];
    for (let i = 0; i < workingMessages.length; i++) {
        const msg = workingMessages[i];
        const isLastMessage = i === continueFromIndex;

        // If it's not an assistant message, add it
        if (msg.role !== 'assistant') {
            const { chatId, messageId, timestamp, ...rest } = msg;
            simplifiedChat.push(rest);
            continue;
        }

        // Find next user message
        let nextUserIndex = workingMessages.findIndex((m, idx) =>
            idx > i && ('content' in m && m.role === 'user')
        );

        // For assistant messages (both regular and arena), 
        // take if it's the last one before next user (or end of messages)
        if (nextUserIndex === -1 ? (i === workingMessages.length - 1) : (i === nextUserIndex - 1)) {
            if ('content' in msg) {
                simplifiedChat.push({
                    role: 'assistant',
                    content: msg.content,
                    ...(msg.model && {model: msg.model})
                });
            } else {  // arena message
                // If it's the last message and we're continuing from it, use modelChoice and arenaMessageIndex
                const model = (isLastMessage ? modelChoice : msg.continued_with) || 'model_a';
                // this case should actually not be possible, because 'none' means draw(bothbad), which means the arena is full regenerated,
                // which means this can't be the last message before a user message
                if (!isLastMessage && model === 'none') continue;
                const messages = msg.responses[model].messages;
                const modelString = msg.responses[model].name;
                const index = (isLastMessage && arenaMessageIndex !== null) ? arenaMessageIndex : messages.length - 1;

                simplifiedChat.push({
                    role: 'assistant',
                    content: messages[index],
                    ...(modelString && {model: modelString})
                });
            }
            // Skip to the next user message to avoid duplicates
            i = nextUserIndex !== -1 ? nextUserIndex - 1 : i;
        }
    }

    return simplifiedChat;
}

function sendChatToSidepanel(chat) {
    chrome.runtime.sendMessage({ type: "is_sidepanel_open" })
        .then(response => {
            if (!response.isOpen) {
                return chrome.runtime.sendMessage({ type: "open_side_panel" })
                    .then(() => {
                        return chrome.runtime.sendMessage({
                            type: "reconstruct_chat",
                            chat: chat,
                        });
                    });
            } else {
                return chrome.runtime.sendMessage({
                    type: "reconstruct_chat",
                    chat: chat,
                });
            }
        });
}


async function autoRenameUnmodified() {
    const button = document.getElementById('auto-rename');
    const model = apiManager.getCurrentModel();

    // First click confirmation
    if (!button.dataset.confirmed) {
        button.textContent = `use ${model} to rename?`;
        button.dataset.confirmed = "pending";
        setTimeout(() => {
            if (button.dataset.confirmed === "pending") {
                button.textContent = "auto-rename unmodified";
                delete button.dataset.confirmed;
            }
        }, 3000);
        return;
    }
    delete button.dataset.confirmed;
    button.textContent = "renaming...";

    const result = await renameManager.renameAllUnmodified();

    if (result.status === 'no_chats') {
        button.textContent = "no chats to rename";
        setTimeout(() => {
            button.textContent = "auto-rename unmodified";
        }, 2000);
        return;
    }

    result.tokenCounter.updateLifetimeTokens();
    button.textContent = `${result.successCount}/${result.totalCount} renamed (${result.tokenCounter.inputTokens}|${result.tokenCounter.outputTokens} tokens)`;
    if (currentChat) currentChat.meta.title = chatUI.autoUpdateChatHeader(currentChat) || currentChat.meta.title;
    setTimeout(() => {
        button.textContent = "auto-rename unmodified";
    }, 15000);
}


function init() {
    initMessageListeners();
    document.getElementById('auto-rename').onclick = autoRenameUnmodified;
}


document.addEventListener('DOMContentLoaded', init);