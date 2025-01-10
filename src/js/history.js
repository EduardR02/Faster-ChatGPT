import { ChatStorage, TokenCounter, StreamWriterBase } from './utils.js';
import { ApiManager } from './api_manager.js';
import { HistoryChatUI } from './chat_ui.js';
import { HistoryStateManager } from './state_manager.js';


class PopupMenu {
    constructor() {
        this.activePopup = null;
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

                input.value = this.activePopup.dataset.name;
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
            const oldName = this.activePopup.dataset.name;
            this.activePopup.dataset.name = newName;
            const textSpan = this.activePopup.querySelector('.item-text');
            textSpan.textContent = textSpan.textContent.replace(oldName, newName);

            chatStorage.renameChat(parseInt(this.activePopup.id, 10), newName);
        }
        this.hidePopup();
    }

    deleteChat(item, popupItem) {
        if (popupItem.classList.contains('delete-confirm')) {
            item.remove();
            // clear the conversation-div
            document.getElementById('conversation-wrapper').innerHTML = '';
            document.getElementById('history-chat-footer').textContent = '';

            chatStorage.deleteChat(parseInt(item.id, 10));
            this.hidePopup();
        } else {
            popupItem.classList.add('delete-confirm');
            popupItem.textContent = 'Sure?';
        }
    }

    async autoRenameSingleChat(item) {
        const chat = {
            chatId: parseInt(item.id, 10),
            title: item.dataset.name
        };

        const timeoutPromise = (promise, timeout = 15000) => {
            return Promise.race([
                promise,
                new Promise((_, reject) =>
                    setTimeout(() => reject(new Error('Timeout')), timeout)
                )
            ]);
        };

        const tokenCounter = await renameSingleChat(chat, apiManager.getCurrentModel(), 
            await prepareMessages(chat, customPromptForRename), timeoutPromise
        );

        if (tokenCounter) {
            tokenCounter.updateLifetimeTokens();
        }

        this.hidePopup();
    }
}


let currentChat = null;
const chatStorage = new ChatStorage();
const apiManager = new ApiManager();
const popupMenu = new PopupMenu();
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


const customPromptForRename = `Condense the input into a minimal title that captures the core action and intent. Focus on the essential elements—what is being done and why—while stripping all unnecessary details, filler words, and redundancy. Ensure the title is concise, descriptive, and reflects the purpose without explicitly stating it unless absolutely necessary.\n
Examples:\n
- User prompt: Can you help me debug this Python script? → Python Script Debugging\n
- User prompt: The impact of climate change on polar bears → Climate Change and Polar Bears\n
- User prompt: Write a short story about a robot discovering emotions → Robot Emotion Story\n\n
Your task is to condense the user input that will follow. Only output the title, as specified, and nothing else.`;


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


function extractSelectionAndUrl(systemMessage) {
    const matches = systemMessage.match(/"""\[(.*?)\]"""\s*"""\[(.*?)\]"""/s);
    if (!matches) return null;
    return {
        url: matches[1],
        selection: matches[2]
    };
}


async function prepareMessages(chat, customPrompt) {
    const chatData = await chatStorage.loadChat(chat.chatId, 2);
    if (!chatData?.messages?.length || chatData.messages.length < 2) return null;

    const [systemMsg, userMsg] = chatData.messages;
    if (systemMsg.role !== 'system' || userMsg.role !== 'user') return null;

    const systemMessage = {
        role: "system",
        content: customPrompt
    };

    const extracted = extractSelectionAndUrl(systemMsg.content);

    if (chat.title.startsWith("Selection from") || extracted !== null) {
        if (!extracted) return null;
        
        const combinedContent = [
            `Source URL: ${extracted.url}`,
            `Selected text: ${extracted.selection}`,
            `User prompt: ${userMsg.content}`
        ].join('\n\n');

        return [systemMessage, {
            role: "user",
            content: combinedContent,
            ...(userMsg.files?.length > 0 && {files: userMsg.files})
        }];
    }

    const combinedContent = `User prompt: ${userMsg.content}`;

    return [systemMessage, {role: "user", content: combinedContent, ...(userMsg.files?.length > 0 && {files: userMsg.files})}];
}


async function renameSingleChat(chat, model, messages, timeoutPromise) {
    const historyItem = document.getElementById(chat.chatId);
    const contentDiv = historyItem?.querySelector('.item-text');
    const streamWriter = new StreamWriterBase(contentDiv);
    
    if (contentDiv) {
        contentDiv.textContent = 'Renaming...';
    }

    const tokenCounter = new TokenCounter(apiManager.getProviderForModel(model));

    try {
        await timeoutPromise(
            apiManager.callApi(model, messages, tokenCounter, streamWriter)
        );

        const newName = streamWriter.done();
        await chatStorage.renameChat(chat.chatId, newName);
        if (historyItem?.dataset?.name) historyItem.dataset.name = newName;
        return tokenCounter;
    } catch (error) {
        if (error.message === 'Timeout') {
            console.warn(`Rename timeout for chat ${chat.chatId}`);
        } else {
            console.error(`Error renaming chat ${chat.chatId}:`, error);
        }
        if (contentDiv) {
            contentDiv.textContent = chat.title;
        }
        return null;
    }
}


async function autoRenameUnmodified() {
    // if there are a lot of chats this will currently hit rate limits because we're trying to do every request at the same time...
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

    const allChats = await chatStorage.getChatMetadata(Infinity, 0);
    const unnamedChats = allChats.filter(chat => !chat.hasOwnProperty('renamed') || !chat.renamed);

    if (unnamedChats.length === 0) {
        button.textContent = "no chats to rename";
        setTimeout(() => {
            button.textContent = "auto-rename unmodified";
        }, 2000);
        return;
    }

    const timeoutPromise = (promise, timeout = 30000) => {
        return Promise.race([
            promise,
            new Promise((_, reject) =>
                setTimeout(() => reject(new Error('Timeout')), timeout)
            )
        ]);
    };

    const renameResults = await Promise.all(
        await Promise.all(unnamedChats.map(async chat => {
            const messages = await prepareMessages(chat, customPromptForRename);
            if (!messages) return null;
            return renameSingleChat(chat, model, messages, timeoutPromise);
        }))
    );

    // Aggregate tokens
    const finalTokenCounter = new TokenCounter(apiManager.getProviderForModel(model));
    const validResults = renameResults.filter(counter => counter !== null);
    
    finalTokenCounter.inputTokens = validResults.reduce((sum, counter) => sum + counter.inputTokens, 0);
    finalTokenCounter.outputTokens = validResults.reduce((sum, counter) => sum + counter.outputTokens, 0);
    
    finalTokenCounter.updateLifetimeTokens();
    button.textContent = `${finalTokenCounter.inputTokens} | ${finalTokenCounter.outputTokens} tokens`;

    setTimeout(() => {
        button.textContent = "auto-rename unmodified";
    }, 15000);
}


function init() {
    initMessageListeners();
    document.getElementById('auto-rename').onclick = autoRenameUnmodified;
}


document.addEventListener('DOMContentLoaded', init);