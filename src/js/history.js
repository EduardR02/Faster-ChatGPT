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

        const historyItems = document.querySelectorAll('.history-sidebar-item');
        historyItems.forEach(item => {
            const dots = item.querySelector('.action-dots');
            dots.addEventListener('click', (e) => this.handleDotsClick(e, item));
        });

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
        } else {
            popupItem.classList.add('delete-confirm');
            popupItem.textContent = 'Sure?';
        }
    }
}


const chatStorage = new ChatStorage();
let popupMenu = null;
let currentChat = null;


function populateHistory() {
    const container = document.querySelector('.history-list');
    chatStorage.getChatMetadata(100, 0).then((chats) => {
        for (let i = 0; i < chats.length; i++) {
            const chat = chats[i];
            const button = document.createElement('button');
            button.classList.add('unset-button', 'history-sidebar-item');

            const textSpan = document.createElement('span');
            textSpan.classList.add('item-text');
            textSpan.textContent = `${chat.title} ${timestampToDateString(chat.timestamp)}`;

            const dots = document.createElement('div');
            dots.classList.add('action-dots');
            dots.textContent = '\u{22EF}';

            // Prevent dots from triggering chat display
            dots.onclick = (e) => {
                e.stopPropagation();
            };

            // Add main click handler to the button
            button.onclick = () => {
                displayChat(chat.chatId, chat.title, new Date(chat.timestamp));
            };

            button.id = chat.chatId;
            button.dataset.name = chat.title;

            button.appendChild(textSpan);
            button.appendChild(dots);
            container.appendChild(button);
        }
        popupMenu = new PopupMenu();
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


function createModelResponse(modelKey, message) {
    const arenaWrapper = createElementWithClass('div', 'arena-wrapper');
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


function createArenaMessage(message) {
    const messageDiv = createElementWithClass('div', 'assistant-message');
    const arenaContainer = createElementWithClass('div', 'arena-full-container');

    ['model_a', 'model_b'].forEach(model => {
        const modelResponse = createModelResponse(model, message);
        arenaContainer.appendChild(modelResponse);
    });

    messageDiv.appendChild(arenaContainer);
    return messageDiv;
}


function createRegularMessage(message, previousRole) {
    const messageDiv = createElementWithClass('div', `${message.role}-message`);
    const wrapperDiv = createElementWithClass('div', 'message-wrapper');

    const prefixWrapper = createElementWithClass('div', 'history-prefix-wrapper');
    const prefix = createElementWithClass('span', `message-prefix ${message.role}-prefix`);
    prefix.textContent = message.role === 'user' ? 'You' : message.model || 'Assistant';
    if (message.role === 'assistant' && message.role === previousRole) prefix.textContent += ' ⟳';

    const continueConversationButton = createElementWithClass('button', 'unset-button continue-conversation-button');
    continueConversationButton.textContent = '\u{2197}';

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
        chat.messages.forEach(message => {
            let messageElement;

            if (message.role === 'system') {
                messageElement = createSystemMessage(message);
            } else if (message.responses) {
                messageElement = createArenaMessage(message);
            } else {
                messageElement = createRegularMessage(message, previousRole);
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


document.addEventListener('DOMContentLoaded', populateHistory);