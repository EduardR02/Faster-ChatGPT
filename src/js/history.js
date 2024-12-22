import { ChatStorage, add_codeblock_html } from './utils.js';


const chatStorage = new ChatStorage();


function populateHistory() {
    const container = document.querySelector('.history-list');
    chatStorage.getChatMetadata(100, 0).then((chats) => {
        for (let i = 0; i < chats.length; i++) {
            const chat = chats[i];
            const div = document.createElement('button');
            div.classList.add('unset-button', 'history-sidebar-item');
            const timestamp = new Date(chat.timestamp);
            div.textContent = `${chat.title} ${timestampToDateString(timestamp)}`;
            div.onclick = () => {
                displayChat(chat.chatId, chat.title, timestamp);
            };
            container.appendChild(div);
        }
    });
}


function createElementWithClass(type, className) {
    const elem = document.createElement(type);
    if (className) elem.className = className;
    return elem;
}


function createSystemMessage(message) {
    const messageDiv = createElementWithClass('div', 'system-message collapsed');
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
        
        const prefix = createElementWithClass('span', 'message-prefix assistant-prefix');
        prefix.textContent = response.name + (index > 0 ? ' ⟳' : '');
        
        const contentDiv = createElementWithClass('div', 'message-content assistant-content');
        contentDiv.innerHTML = add_codeblock_html(msg || "");

        modelWrapper.append(prefix, contentDiv);
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

    const prefix = createElementWithClass('span', `message-prefix ${message.role}-prefix`);
    prefix.textContent = message.role === 'user' ? 'You' : message.model || 'Assistant';
    if (message.role === 'assistant' && message.role === previousRole) prefix.textContent += ' ⟳';
    wrapperDiv.appendChild(prefix);

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