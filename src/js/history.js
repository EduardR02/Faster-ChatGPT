import { ChatStorage, add_codeblock_html } from './utils.js';


class PopupMenu {
    constructor() {
        this.activePopup = null;
        this.init();
    }

    init() {
        this.popup = document.createElement('div');
        this.popup.className = 'popup-menu';
        this.popup.innerHTML = `
            <div class="popup-item" data-action="rename">Rename</div>
            <div class="popup-item" data-action="delete">Delete</div>
        `;
        document.body.appendChild(this.popup);

        document.addEventListener('click', this.handleGlobalClick.bind(this));
        
        const historyItems = document.querySelectorAll('.history-sidebar-item');
        historyItems.forEach(item => {
            const dots = item.querySelector('.action-dots');
            dots.addEventListener('click', (e) => this.handleDotsClick(e, item));
        });

        this.popup.addEventListener('click', this.handlePopupClick.bind(this));

        document.body.appendChild(this.popup);
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
                this.renameChat(this.activePopup);
                break;
            case 'delete':
                // If deleteChat returns false, don't hide popup
                if (this.deleteChat(this.activePopup, e.target) === false) {
                    return;
                }
                break;
        }
    
        this.hidePopup();
    }

    handleGlobalClick() {
        this.hidePopup();
    }

    hidePopup() {
        // Reset the delete button state
        const deleteButton = this.popup.querySelector('[data-action="delete"]');
        if (deleteButton) {
            deleteButton.classList.remove('delete-confirm');
            deleteButton.textContent = 'Delete';
        }
    
        // Normal hide behavior
        this.popup.classList.remove('active');
        this.activePopup = null;
    }

    renameChat(item) {
        const textSpan = item.querySelector('.item-text');
        const newName = prompt('Enter new name:', textSpan.textContent);
        if (newName) {
            textSpan.textContent = newName;
            // Update backend/storage here
        }
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
            return false;   // Prevent popup from closing on first click
        }
    }
}



const chatStorage = new ChatStorage();
let popupMenu = null;


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


function createModelResponse(modelKey, response) {
    const arenaWrapper = createElementWithClass('div', 'arena-wrapper');
    
    // Create a message wrapper for each message in the history
    response.messages.forEach((msg, index) => {
        const modelWrapper = createElementWithClass('div', 'message-wrapper');
        
        const prefixWrapper = createElementWithClass('div', 'history-prefix-wrapper');
        const prefix = createElementWithClass('span', 'message-prefix assistant-prefix');
        prefix.textContent = response.name + (index > 0 ? ' ⟳' : '');

        const continueConversationButton = createElementWithClass('button', 'unset-button continue-conversation-button');
        continueConversationButton.textContent = '\u{2197}';
        if (modelKey === 'model_a') {
            continueConversationButton.classList.add('arena-left-continue-button');
        }
        
        const contentDiv = createElementWithClass('div', 'message-content assistant-content');
        contentDiv.innerHTML = add_codeblock_html(msg || "");

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
        const modelResponse = createModelResponse(model, message.responses[model]);
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

// Run it when page loads
document.addEventListener('DOMContentLoaded', populateHistory);