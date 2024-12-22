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


function displayChat(chatId, title, timestamp) {
    chatStorage.loadChat(chatId).then((chat) => {
        const conversationWrapper = document.getElementById('conversation-wrapper');
        conversationWrapper.innerHTML = '';

        chat.messages.forEach(message => {
            const messageDiv = document.createElement('div');
            const wrapperDiv = document.createElement('div');
            wrapperDiv.className = 'message-wrapper';

            if (message.role === 'system') {
                messageDiv.className = 'system-message collapsed';
                
                const toggleButton = document.createElement('button');
                toggleButton.className = 'message-prefix system-toggle system-prefix history-sidebar-item';
                
                const toggleIcon = document.createElement('span');
                toggleIcon.className = 'toggle-icon';
                toggleIcon.textContent = '⯈';
                
                const contentDiv = document.createElement('div');
                contentDiv.className = 'message-content history-system-content';
                contentDiv.innerHTML = add_codeblock_html(message?.content || "");
            
                toggleButton.append(toggleIcon, 'System Prompt');
                toggleButton.onclick = () => messageDiv.classList.toggle('collapsed');
                wrapperDiv.append(toggleButton, contentDiv);
            } else {
                messageDiv.className = `${message.role}-message`;

                const prefixSpan = document.createElement('span');
                prefixSpan.className = `message-prefix ${message.role}-prefix`;
                prefixSpan.textContent = message.role === 'user' ? 'You' : 'Assistant';

                const contentDiv = document.createElement('div');
                contentDiv.className = `message-content ${message.role}-content`;
                contentDiv.innerHTML = add_codeblock_html(message?.content || "");

                wrapperDiv.append(prefixSpan, contentDiv);
            }

            messageDiv.appendChild(wrapperDiv);
            conversationWrapper.appendChild(messageDiv);
        });
        const footerDiv = document.getElementById('history-chat-footer');
        footerDiv.textContent = `${title} - ${timestamp.toString().split(' GMT')[0]}`;
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