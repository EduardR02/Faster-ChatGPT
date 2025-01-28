import { ChatStorage } from './utils.js';
import { HistoryChatUI } from './chat_ui.js';
import { HistoryStateManager } from './state_manager.js';
import { HistoryRenameManager } from './rename_manager.js';
import { ChatCore } from './chat_core.js';


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
            const currentId = parseInt(this.activePopup.id, 10);
            if (chatCore.getChatId() === currentId)
                chatCore.miscUpdate({ title: chatUI.autoUpdateChatHeader(chatCore.getChatId()) || chatCore.getTitle() });
            this.chatStorage.renameChat(currentId, newName);
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
        if (chatCore.getChatId() === chatId) {
            chatCore.reset();
            this.chatUI.clearConversation();
        }
    
        this.hidePopup();
    }

    async autoRenameSingleChat(item) {
        const textSpan = item.querySelector('.item-text');
        const result = await this.renameManager.renameSingleChat(parseInt(item.id, 10), textSpan);
        
        if (result?.tokenCounter) {
            result.tokenCounter.updateLifetimeTokens();
            if (chatCore.getChatId() === parseInt(item.id, 10))
                chatCore.miscUpdate({ title: chatUI.autoUpdateChatHeader(chatCore.getChatId()) || chatCore.getTitle() });
        }
        
        this.hidePopup();
    }
}


const chatStorage = new ChatStorage();
const chatCore = new ChatCore(chatStorage);
const renameManager = new HistoryRenameManager(chatStorage);
const popupMenu = new PopupMenu(renameManager, chatStorage);
const stateManager = new HistoryStateManager();
const chatUI = new HistoryChatUI({
    stateManager,
    popupMenu,
    continueFunc: (index, secondaryIndex, modelChoice = null) => 
        sendChatToSidepanel({ chatId: chatCore.getChatId(), index, secondaryIndex, modelChoice }),
    loadHistoryItems: chatStorage.getChatMetadata.bind(chatStorage),
    addPopupActions: popupMenu.addHistoryItem.bind(popupMenu),
    loadChat: async (chatId) => { return await chatCore.loadChat(chatId); },
    getChatMeta: async (chatId) => {return await chatStorage.getChatMetadataById(chatId);},
});
popupMenu.chatUI = chatUI;


function initMessageListeners() {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        switch (message.type) {
            case 'new_chat_saved':
                handleNewChatSaved(message.chat);
                break;
            case 'appended_messages_to_saved_chat':
                handleAppendedMessages(message.chatId, message.addedCount);
                break;
            case 'message_updated':
                handleMessageUpdate(message.chatId, message.messageId);
                break;
            case 'chat_renamed':
                handleChatRenamed(message.chatId, message.title);
        }
    });
}

async function handleAppendedMessages(chatId, addedCount, message = null) {
    handleHistoryItemOnNewMessage(chatId);
    if (chatCore.getChatId() !== chatId) return;
    
    const newMessages = message ? [message] : await chatStorage.getLatestMessages(chatId, addedCount);
    if (!newMessages) return;
    
    chatUI.appendMessages(newMessages, chatCore.getLength());
    chatCore.addMultipleFromHistory(newMessages);
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

function handleNewChatSaved(chatMeta) {
    chatUI.handleNewChatSaved(chatMeta);
    // if no chat is open, open the new chat (might remove if annoying)
    if (chatCore.getChatId() === null) {
        chatUI.buildChat(chatMeta.chatId);
    }
}

async function handleMessageUpdate(chatId, messageId) {
    if (chatCore.getChatId() !== chatId) return;
    
    const updatedMessage = await chatStorage.getMessage(chatId, messageId);
    if (!updatedMessage) return;
    
    const isUpdate = messageId < chatCore.getLength();
    if (!isUpdate) {
        handleAppendedMessages(chatId, 1, updatedMessage);
        return;
    }
    
    handleHistoryItemOnNewMessage(chatId);
    if (updatedMessage.responses) chatUI.updateArenaMessage(updatedMessage, messageId);
    else chatUI.appendSingleRegeneratedMessage(updatedMessage);
    chatCore.replaceLastFromHistory(updatedMessage);
}

function handleChatRenamed(chatId, title) {
    chatUI.handleChatRenamed(chatId, title);
    if (chatCore.getChatId() === chatId) {
        chatCore.miscUpdate( { title } );
        chatUI.updateChatHeader(title);
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
    const model = renameManager.getModel();

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
    if (chatCore.getChatId()) chatCore.miscUpdate({ title: chatUI.autoUpdateChatHeader(chatCore.getChatId()) || chatCore.getTitle() });
    setTimeout(() => {
        button.textContent = "auto-rename unmodified";
    }, 15000);
}


async function initiateChatBackupDownload(element) {
    try {
        element.textContent = "extracting...";
        const chatDataJson = await chatStorage.exportChats({ pretty: true });
        chatStorage.triggerDownload(chatDataJson);
        element.textContent = "success!";
    } catch (error) {
        element.textContent = "failed :(";
        console.error(error);
    }
    setTimeout(() => {
        element.textContent = "export";
    }, 5000);
}


async function initiateChatBackupImport(element) {
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'application/json';

    fileInput.onchange = async (event) => {
        const file = event.target.files[0];
        if (!file) {
            element.textContent = "no file selected";
            setTimeout(() => {
                element.textContent = "import";
            }, 3000);
            return;
        }

        const reader = new FileReader();
        reader.onload = async (e) => {
            try {
                element.textContent = "importing...";
                const importResult = await chatStorage.importChats(e.target.result);
                element.textContent = importResult.success ? `${importResult.count} added` : 'failed :(';
                if (!importResult.success) console.error("Import error:", importResult.error);
                chatUI.reloadHistoryList();
            } catch (error) {
                element.textContent = "failed :(";
                console.error("Import error:", error);
            }
            setTimeout(() => { element.textContent = "import"; }, 5000);
        };
        reader.readAsText(file);
    };
    fileInput.click(); // Programmatically trigger file selection
}


function init() {
    initMessageListeners();
    document.getElementById('auto-rename').onclick = autoRenameUnmodified;
    document.getElementById('export').onclick = (e) => initiateChatBackupDownload(e.target);
    document.getElementById('import').onclick = (e) => initiateChatBackupImport(e.target);
}


document.addEventListener('DOMContentLoaded', init);