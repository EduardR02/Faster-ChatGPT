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
        this.chatUI = null;
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
                currentChat.meta.title = this.chatUI.autoUpdateChatHeader(currentChat) || currentChat.meta.title;
            this.chatStorage.renameChat(parseInt(this.activePopup.id, 10), newName);
        }
        this.hidePopup();
    }

    deleteChat(item, popupItem) {
        if (!popupItem.classList.contains('delete-confirm')) {
            popupItem.classList.add('delete-confirm');
            popupItem.textContent = 'Sure?';
            return;
        }
    
        const chatId = parseInt(item.id, 10);
    
        this.chatUI.handleItemDeletion(item);
    
        this.chatStorage.deleteChat(chatId);
        if (currentChat && currentChat.meta.chatId === chatId) {
            currentChat = null;
            this.chatUI.clearConversation();
        }
    
        this.hidePopup();
    }

    async autoRenameSingleChat(item) {
        const textSpan = item.querySelector('.item-text');
        const result = await this.renameManager.renameSingleChat(parseInt(item.id, 10), textSpan);
        
        if (result?.tokenCounter) {
            result.tokenCounter.updateLifetimeTokens();
            if (currentChat)
                currentChat.meta.title = this.chatUI.autoUpdateChatHeader(currentChat) || currentChat.meta.title;
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
    continueFunc: (index, arenaMessageIndex = null, modelChoice = null) => 
        sendChatToSidepanel({ chatId: currentChat?.meta?.chatId, index, arenaMessageIndex, modelChoice }),
    loadHistoryItems: chatStorage.getChatMetadata.bind(chatStorage),
    addPopupActions: popupMenu.addHistoryItem.bind(popupMenu),
    loadChat: async (chatId) => {
        currentChat = await chatStorage.loadChat(chatId);
        return currentChat;
    },
});
popupMenu.chatUI = chatUI;


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
            case 'chat_renamed':
                handleChatRenamed(message.chatId, message.title);
        }
    });
}

async function handleAppendedMessages(chatId, addedCount) {
    handleHistoryItemOnNewMessage(chatId);
    if (!currentChat || currentChat.meta.chatId !== chatId) return;
    
    const newMessages = await chatStorage.getLatestMessages(chatId, addedCount);
    if (!newMessages) return;
    
    const len = currentChat.messages.length;
    chatUI.appendMessages(newMessages, len, currentChat.messages[len - 1]?.role);
    currentChat.messages.push(...newMessages);
}

async function handleHistoryItemOnNewMessage(chatId) {
    // due to updated timestamp, history item order (and dividers) may need to be updated
    if (!chatId) return;
    const chatMeta = await chatStorage.getChatMetadataById(chatId);
    const historyItem = chatUI.getHistoryItem(chatId);
    if (historyItem) {
        chatUI.handleItemDeletion(historyItem);
    }
    chatUI.handleNewChatSaved(chatMeta);
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
    
    handleHistoryItemOnNewMessage(chatId);
    chatUI.updateArenaMessage(updatedMessage, messageIndex);
    currentChat.messages[messageIndex] = updatedMessage;
}

function handleChatRenamed(chatId, title) {
    chatUI.handleChatRenamed(chatId, title);
    if (currentChat && currentChat.meta.chatId === chatId) {
        currentChat.meta.title = title;
        chatUI.autoUpdateChatHeader(currentChat);
    }
}


function sendChatToSidepanel(options) {
    const message = {
        type: "reconstruct_chat",
        options,
    };
    chrome.runtime.sendMessage({ type: "is_sidepanel_open" })
        .then(response => {
            if (!response.isOpen) {
                return chrome.runtime.sendMessage({ type: "open_side_panel" })
                    .then(() => {
                        return chrome.runtime.sendMessage(message);
                    });
            } else {
                return chrome.runtime.sendMessage(message);
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