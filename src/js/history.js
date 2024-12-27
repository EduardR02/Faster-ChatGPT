import { ChatStorage, add_codeblock_html } from './utils.js';


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
                const input = this.popup.querySelector('.rename-input');

                renameButton.style.display = 'none';
                deleteButton.style.display = 'none';
                inputWrapper.style.display = 'flex';

                input.value = this.activePopup.dataset.name;
                input.focus();
                break;
            case 'delete':
                this.deleteChat(this.activePopup, e.target);
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
}


const chatStorage = new ChatStorage();
let popupMenu = null;
let currentChat = null;

let isLoading = false;
let offset = 0;
const limit = 20;
let hasMoreItems = true;
let historyListContainer = null;


function initChatHistory() {
    historyListContainer = document.querySelector('.history-list');
    historyListContainer.addEventListener('scroll', handleHistoryScroll);
    popupMenu = new PopupMenu();
    populateHistory();
}


function createHistoryItem(chat) {
    const button = document.createElement('button');
    button.classList.add('unset-button', 'history-sidebar-item');

    const textSpan = document.createElement('span');
    textSpan.classList.add('item-text');
    textSpan.textContent = `${chat.title} ${timestampToDateString(chat.timestamp)}`;

    const dots = document.createElement('div');
    dots.classList.add('action-dots');
    dots.textContent = '\u{22EF}';

    dots.onclick = (e) => e.stopPropagation();
    button.onclick = () => displayChat(chat.chatId, chat.title, new Date(chat.timestamp));
    button.id = chat.chatId;
    button.dataset.name = chat.title;

    button.appendChild(textSpan);
    button.appendChild(dots);

    popupMenu.addHistoryItem(button);

    return button;
}

async function populateHistory() {
    if (isLoading || !hasMoreItems) return;
    
    isLoading = true;
    
    try {
        const chats = await chatStorage.getChatMetadata(limit, offset);
        
        if (chats.length === 0) {
            hasMoreItems = false;
            historyListContainer.removeEventListener('scroll', handleHistoryScroll);
            return;
        }

        chats.forEach(chat => {
            historyListContainer.appendChild(createHistoryItem(chat));
        });

        offset += chats.length;
    } catch (error) {
        console.error('Error loading chat history:', error);
    } finally {
        isLoading = false;
        
        if (shouldLoadMore()) {
            populateHistory();
        }
    }
}

function shouldLoadMore() {
    const { scrollHeight, clientHeight } = historyListContainer;
    return scrollHeight <= clientHeight && hasMoreItems;
}

function handleHistoryScroll() {
    const { scrollTop, scrollHeight, clientHeight } = historyListContainer;
    
    if (scrollHeight - (scrollTop + clientHeight) < 10 && !isLoading && hasMoreItems) {
        populateHistory();
    }
}


function buildChat(continueFromIndex, arenaMessageIndex = null, modelChoice = null) {
    const workingMessages = currentChat.messages.slice(0, continueFromIndex + 1);

    const simplifiedChat = [];
    for (let i = 0; i < workingMessages.length; i++) {
        const msg = workingMessages[i];
        const isLastMessage = i === continueFromIndex;

        // If it's not an assistant message, add it
        if (msg.role !== 'assistant') {
            const simplifiedMsg = {
                role: msg.role,
                content: msg.content
            };
            if (msg.images?.length) simplifiedMsg.images = msg.images;
            simplifiedChat.push(simplifiedMsg);
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


function createElementWithClass(type, className) {
    const elem = document.createElement(type);
    if (className) elem.className = className;
    return elem;
}


function createSystemMessage(message) {
    const messageDiv = createElementWithClass('div', 'history-system-message collapsed');
    const wrapperDiv = createElementWithClass('div', 'message-wrapper');

    const toggleButton = createElementWithClass('button', 'message-prefix system-toggle system-prefix history-sidebar-item');
    const toggleIcon = createElementWithClass('span', 'toggle-icon');
    toggleIcon.textContent = '⯈';

    const contentDiv = createElementWithClass('div', 'message-content history-system-content');
    contentDiv.innerHTML = add_codeblock_html(message?.content || "");

    toggleButton.append(toggleIcon, 'System Prompt');
    toggleButton.onclick = () => messageDiv.classList.toggle('collapsed');
    wrapperDiv.append(toggleButton, contentDiv);
    messageDiv.appendChild(wrapperDiv);

    return messageDiv;
}


function createModelResponse(modelKey, message, msgIndex) {
    const arenaWrapper = createElementWithClass('div', 'arena-wrapper history-arena-wrapper');
    const response = message.responses[modelKey];
    const choice = message.choice;
    const continuedWith = message.continued_with;

    // Create a message wrapper for each message in the history
    response.messages.forEach((msg, index) => {
        const modelWrapper = createElementWithClass('div', 'message-wrapper');

        const prefixWrapper = createElementWithClass('div', 'history-prefix-wrapper');
        const prefix = createElementWithClass('span', 'message-prefix assistant-prefix');

        // Determine symbol based on choice and model
        let symbol = '';
        switch (choice) {
            case modelKey:
                symbol = ' 🏆'; // Winner
                break;
            case 'draw':
                symbol = ' 🤝'; // Draw
                break;
            case 'draw(bothbad)':
                symbol = ' ❌'; // Both bad
                break;
            case 'reveal':
                symbol = ' 👁️'; // Reveal
                break;
            case 'ignored':
                symbol = ' n/a'; // Ignored
                break;
            default:
                symbol = ' ❌'; // Loser
        }

        prefix.textContent = response.name + (index > 0 ? ' ⟳' : '') + symbol;

        const continueConversationButton = createElementWithClass('button', 'unset-button continue-conversation-button');
        continueConversationButton.textContent = '\u{2197}';
        if (modelKey === 'model_a') {
            continueConversationButton.classList.add('arena-left-continue-button');
        }

        continueConversationButton.onclick = () => {
            sendChatToSidepanel(buildChat(msgIndex, index, modelKey));
        };

        const contentDiv = createElementWithClass('div', 'message-content assistant-content');
        contentDiv.innerHTML = add_codeblock_html(msg || "");

        // Handle winner/loser classes
        if (continuedWith === modelKey) {
            contentDiv.classList.add('arena-winner');
        } else {
            contentDiv.classList.add('arena-loser');
        }

        prefixWrapper.append(prefix, continueConversationButton);
        modelWrapper.append(prefixWrapper, contentDiv);
        arenaWrapper.appendChild(modelWrapper);
    });

    return arenaWrapper;
}


function createArenaMessage(message, index) {
    const messageDiv = createElementWithClass('div', 'assistant-message');
    const arenaContainer = createElementWithClass('div', 'arena-full-container');

    ['model_a', 'model_b'].forEach(model => {
        const modelResponse = createModelResponse(model, message, index);
        arenaContainer.appendChild(modelResponse);
    });

    messageDiv.appendChild(arenaContainer);
    return messageDiv;
}


function createRegularMessage(message, index, previousRole) {
    const messageDiv = createElementWithClass('div', `${message.role}-message`);
    const wrapperDiv = createElementWithClass('div', 'message-wrapper');

    const prefixWrapper = createElementWithClass('div', 'history-prefix-wrapper');
    const prefix = createElementWithClass('span', `message-prefix ${message.role}-prefix`);
    prefix.textContent = message.role === 'user' ? 'You' : message.model || 'Assistant';
    if (message.role === 'assistant' && message.role === previousRole) prefix.textContent += ' ⟳';

    const continueConversationButton = createElementWithClass('button', 'unset-button continue-conversation-button');
    continueConversationButton.textContent = '\u{2197}';

    continueConversationButton.onclick = () => {
        sendChatToSidepanel(buildChat(index));
    };

    prefixWrapper.append(prefix, continueConversationButton);
    wrapperDiv.appendChild(prefixWrapper);

    if (message.images?.length) {
        message.images.forEach(imageUrl => {
            const imgWrapper = createElementWithClass('div', `image-content ${message.role}-content`);
            const img = createElementWithClass('img');
            img.src = imageUrl;
            imgWrapper.appendChild(img);
            wrapperDiv.appendChild(imgWrapper);
        });
    }

    const contentDiv = createElementWithClass('div', `message-content ${message.role}-content`);
    contentDiv.innerHTML = add_codeblock_html(message?.content || "");
    wrapperDiv.appendChild(contentDiv);
    messageDiv.appendChild(wrapperDiv);

    return messageDiv;
}


function displayChat(chatId, title, timestamp) {
    chatStorage.loadChat(chatId).then((chat) => {
        currentChat = chat;
        const conversationWrapper = document.getElementById('conversation-wrapper');
        conversationWrapper.innerHTML = '';
        let previousRole = null;
        chat.messages.forEach((message, index) => {
            let messageElement;

            if (message.role === 'system') {
                messageElement = createSystemMessage(message);
            } else if (message.responses) {
                messageElement = createArenaMessage(message, index);
            } else {
                messageElement = createRegularMessage(message, index, previousRole);
                previousRole = message.role;
            }

            conversationWrapper.appendChild(messageElement);
        });

        document.getElementById('history-chat-footer').textContent =
            `${title} - ${timestamp.toString().split(' GMT')[0]}`;
    });
}


function timestampToDateString(timestamp) {
    const date = new Date(timestamp);
    return date.toISOString().split('T')[0];
}


function populateDummyHistory() {
    const topics = ['AI Discussion', 'Gaming Session', 'Code Review', 'Movie Analysis', 'Book Chat', 'Project Planning', 'Debug Help', 'Random Thoughts'];
    const times = ['AM', 'PM'];
    const container = document.querySelector('.history-list');

    for (let i = 0; i < 100; i++) {
        const hour = Math.floor(Math.random() * 12) + 1;
        const minute = String(Math.floor(Math.random() * 60)).padStart(2, '0');
        const ampm = times[Math.floor(Math.random() * 2)];

        const div = document.createElement('div');
        div.className = 'history-sidebar-item';
        div.textContent = `${topics[Math.floor(Math.random() * topics.length)]} ${hour}:${minute} ${ampm}`;

        container.appendChild(div);
    }
}


document.addEventListener('DOMContentLoaded', initChatHistory);