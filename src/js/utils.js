export function get_mode(callback) {
    chrome.storage.local.get('mode', function (res) {
        callback(res.mode);
    });
}


export function set_mode(new_mode) {
    chrome.storage.local.set({ mode: new_mode });
}


export function is_on(mode) {
    return mode !== ModeEnum.Off;
}


export function get_lifetime_tokens(callback) {
    chrome.storage.local.get(['lifetime_input_tokens', 'lifetime_output_tokens'], function (res) {
        callback({
            input: res.lifetime_input_tokens || 0,
            output: res.lifetime_output_tokens || 0
        });
    });
}


export function set_lifetime_tokens(newInputTokens, newOutputTokens) {
    get_lifetime_tokens(function (currentTokens) {
        chrome.storage.local.set({
            lifetime_input_tokens: currentTokens.input + newInputTokens,
            lifetime_output_tokens: currentTokens.output + newOutputTokens
        });
    });
}


export function get_stored_models() {
    return new Promise((resolve) => {
        chrome.storage.local.get(['models'], function (result) {
            resolve(result.models || {});
        });
    });
}


export function add_model_to_storage(provider, apiString, displayName) {
    return new Promise((resolve) => {
        get_stored_models().then(models => {
            if (!models[provider]) {
                models[provider] = {};
            }
            models[provider][apiString] = displayName;
            chrome.storage.local.set({ models: models }, () => {
                resolve(models);
            });
        });
    });
}


export function remove_model_from_storage(apiString) {
    return new Promise((resolve) => {
        get_stored_models().then(models => {
            for (const provider in models) {
                if (models[provider][apiString]) {
                    delete models[provider][apiString];
                    if (Object.keys(models[provider]).length === 0) {
                        delete models[provider];
                    }
                    chrome.storage.local.set({ models: models }, () => {
                        resolve(models);
                    });
                    return;
                }
            }
            resolve(models); // Model not found
        });
    });
}


// Process code blocks only at the end (poor man's streamed codeblock) (claude magic)
export function add_codeblock_html(message) {
    // First escape ALL HTML
    const escapedMessage = message
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');

    // Then handle code blocks
    const codeBlockRegex = /(\n*)```(\w*)\n([\s\S]*?)```(\n+|$)/g;
    return escapedMessage.replace(codeBlockRegex, (match, preNewlines, lang, code, postNewlines) => {
        const paddingBack = '\n';
        const paddingFront = paddingBack + '\n';
        return `${paddingFront}<div class="code-style"><pre><code class="language-${lang}">${code}</code></pre></div>${paddingBack}`;
    });
}


export function auto_resize_textfield_listener(element_id) {
    let inputField = document.getElementById(element_id);

    inputField.addEventListener('input', () => update_textfield_height(inputField));
    window.addEventListener('resize', () => update_textfield_height(inputField));
    update_textfield_height(inputField);
}


export function update_textfield_height(inputField) {
    inputField.style.height = 'auto';
    let buttonArea = document.querySelector('.chatbox-button-container');
    let buttonAreaHeight = buttonArea ? buttonArea.offsetHeight : 0;
    inputField.style.height = (Math.max(inputField.scrollHeight, buttonAreaHeight)) + 'px';
}


export function loadTextFromFile(filePath) {
    return new Promise((resolve, reject) => {
        let textFileUrl = chrome.runtime.getURL(filePath);
        fetch(textFileUrl)
            .then(response => response.text())
            .then(text => {
                resolve(text);
            })
            .catch(error => {
                reject(error);
            });
    });
}


export function createElementWithClass(type, className, textContent = null) {
    const elem = document.createElement(type);
    if (className) elem.className = className;
    if (textContent) elem.textContent = textContent;
    return elem;
}


export function set_defaults() {
    const MODELS = {
        openai: {
            "gpt-4": "GPT-4",
            "gpt-4-turbo-preview": "GPT-4 Turbo",
            "chatgpt-4o-latest": "GPT-4o latest",
            "gpt-4o-mini": "GPT-4o mini"
        },
        anthropic: {
            "claude-3-5-sonnet-20240620": "Sonnet 3.5",
            "claude-3-5-sonnet-20241022": "Sonnet 3.5 new"
        },
        gemini: {
            "gemini-exp-1206": "Gemini Exp 1206",
            "gemini-2.0-flash-exp": "Gemini Flash 2.0",
        },
        deepseek: {
            "deepseek-chat": "DeepSeek V3",
            "deepseek-reasoner": "DeepSeek R1"
        }
    };
    const anthropic_models = Object.keys(MODELS.anthropic);
    let settings = {
        mode: ModeEnum.PromptMode,
        lifetime_input_tokens: 0,
        lifetime_output_tokens: 0,
        max_tokens: 4000,
        temperature: 1.0,
        loop_threshold: 3,
        current_model: anthropic_models[anthropic_models.length - 1],
        models: MODELS,
        api_keys: {},
        close_on_deselect: false,
        stream_response: true,
        arena_mode: false
    };

    return Promise.all([
        new Promise((resolve) => chrome.storage.local.set(settings, resolve)),
        // for some reason relative path does not work, only full path.
        // possibly because function is called on startup in background worker, and maybe the context is the base dir then.
        loadTextFromFile("src/prompts/prompt.txt").then((text) =>
            new Promise((resolve) => chrome.storage.local.set({ selection_prompt: text.trim() }, resolve))
        ),
        loadTextFromFile("src/prompts/chat_prompt.txt").then((text) =>
            new Promise((resolve) => chrome.storage.local.set({ chat_prompt: text.trim() }, resolve))
        )
    ]);
}


export class TokenCounter {
    constructor(provider) {
        this.provider = provider;
        this.inputTokens = 0;
        this.outputTokens = 0;
    }

    update(inputTokens, outputTokens) {
        if (this.provider === 'gemini') {
            // Gemini API returns the total token count up to that point in the stream, so last value is the total.
            this.inputTokens = inputTokens;
            this.outputTokens = outputTokens;
        } else {
            this.inputTokens += inputTokens;
            this.outputTokens += outputTokens;
        }
    }

    updateLifetimeTokens() {
        set_lifetime_tokens(this.inputTokens, this.outputTokens);
    }
}


export class Footer {
    constructor(inputTokens, outputTokens, isArenaMode, isThinkingFunc, regenerate_response) {
        this.inputTokens = inputTokens;
        this.outputTokens = outputTokens;
        this.isArenaMode = isArenaMode;
        this.isThinkingFunc = isThinkingFunc;
        this.regenerate_response = regenerate_response;
    }

    create(contentDiv) {
        let footerDiv = document.createElement("div");
        footerDiv.classList.add("message-footer");
        // need span to be able to calculate the width of the text in css for the centering animation
        let tokensSpan = document.createElement('span');
        tokensSpan.textContent = `${this.isArenaMode ? "~" : this.inputTokens} | ${this.outputTokens}`;
        footerDiv.setAttribute('input-tokens', this.inputTokens);
        footerDiv.appendChild(tokensSpan);
        if (!this.isThinkingFunc()) {
            this.createRegenerateButton(footerDiv);
        }
        else {
            footerDiv.classList.add('centered');
        }
        contentDiv.appendChild(footerDiv);
    }

    createRegenerateButton(footerDiv) {
        let regerateButton = document.createElement("button");
        regerateButton.textContent = '\u{21BB}'; // refresh symbol
        regerateButton.classList.add("button", "regenerate-button");
        regerateButton.addEventListener('click', () => {
            this.regenerate_response();
            regerateButton.classList.add('fade-out');
            const handleTransitionEnd = (event) => {
                if (event.propertyName === 'opacity') {
                    regerateButton.remove();
                    footerDiv.classList.add('centered');
                }
            };

            regerateButton.addEventListener('transitionend', handleTransitionEnd);
        });
        footerDiv.appendChild(regerateButton);
    }
}


export class StreamWriterBase {
    // class for auto renaming history items with streamed response from llm api
    constructor(contentDiv = null) {
        this.contentDiv = contentDiv;
        this.message = [];
        this.fullMessage = "";
        this.isFirstChunk = true;
    }

    setThinkingModel() {
        return; // do nothing for base class
    }

    processContent(content, isThought = false) {
        if (isThought) return;  // simply discard thoughts, as we only care about the final output for renaming here
        this.message.push(content);
        if (this.contentDiv) {
            if (this.isFirstChunk) {
                this.contentDiv.textContent = "";
                this.isFirstChunk = false;
            }
            this.contentDiv.textContent += content;
        }
    }

    done() {
        this.fullMessage = this.message.join('');
        return this.fullMessage;
    }
}


export class StreamWriterSimple {
    constructor(contentDiv, produceNextContentDivFunc, scrollFunc = () => {}) {
        this.contentDiv = contentDiv;
        this.produceNextContentDivFunc = produceNextContentDivFunc;
        this.scrollFunc = scrollFunc;
        this.parts = [ { type: 'text', content: [] } ];
        this.thoughtEndToggle = true;
    }

    setThinkingModel() {
        this.thoughtEndToggle = false;
        this.contentDiv.classList.add('thoughts');
        this.parts = [ { type: 'thought', content: [] } ];
    }

    addThinkingCounter() {
        const span = this.contentDiv.parentElement.parentElement.querySelector('.message-prefix');
        if (!span) return;

        let seconds = 0;
        let intervalId = null;
        let hasProcessed = false;

        // Split and preserve all parts of the text
        const originalText = span.textContent;
        const [firstWord, ...remainingWords] = originalText.split(' ');
        const remainingText = remainingWords.length ? ' ' + remainingWords.join(' ') : '';

        const updateCounter = () => {
            if (hasProcessed) return;
            seconds++;
            span.textContent = `${firstWord} thinking for ${seconds} seconds...${remainingText}`;
        };

        intervalId = setInterval(updateCounter, 1000);

        // Override processContent to catch first content
        const originalProcessContent = this.processContent.bind(this);
        this.processContent = (content) => {
            if (!hasProcessed) {
                hasProcessed = true;
                clearInterval(intervalId);
                span.textContent = `${firstWord} thought for ${seconds} seconds${remainingText}`;
            }
            originalProcessContent(content);
        };
    }

    processContent(content, isThought = false) {
        if (!isThought) {
            if (!this.thoughtEndToggle) {
                this.thoughtEndToggle = true;
                this.nextPart();
            }
        }
        this.parts.at(-1).content.push(content);
        this.contentDiv.textContent += content;
        this.scrollFunc();
    }

    nextPart(isThought = false) {
        this.finalizePart();
        this.parts.push({ type: isThought ? 'thought' : 'text', content: [] });
        this.switchContentDiv(isThought);
    }

    switchContentDiv(isThought = false) {
        const newContentDiv = this.produceNextContentDivFunc('assistant', isThought);
        this.contentDiv.parentElement.appendChild(newContentDiv);
        this.contentDiv = newContentDiv;
    }

    finalizePart() {
        this.parts.at(-1).content = this.parts.at(-1).content.join('');
        this.contentDiv.innerHTML = add_codeblock_html(this.parts.at(-1).content);
    }

    addFooter(footer) {
        this.finalizePart();
        footer.create(this.contentDiv);
        this.scrollFunc();
        return new Promise((resolve) => resolve());
    }
}


export class StreamWriter extends StreamWriterSimple {
    constructor(contentDiv, produceNextContentDivFunc, scrollFunc, wordsPerMinute = 200) {
        super(contentDiv, produceNextContentDivFunc, scrollFunc);
        this.contentQueue = [];
        this.isProcessing = false;
        this.delay = 12000 / wordsPerMinute;    // wpm to ms per char conversion
        this.accumulatedChars = 0;
        this.lastFrameTime = 0;
        this.pendingFooter = null;
    }

    setThinkingModel() {
        super.setThinkingModel();
        this.pendingSwitch = false;
        this.pendingQueue = [];
    }

    processContent(content, isThought = false) {
        if (!isThought) {
            if (!this.thoughtEndToggle) {
                this.thoughtEndToggle = true;
                this.pendingSwitch = true;
                this.parts.at(-1).content = this.parts.at(-1).content.join('');
                this.parts.push({ type: isThought ? 'thought' : 'text', content: [] });
            }
        }
        this.parts.at(-1).content.push(content);

        if (this.pendingSwitch) {
            this.pendingQueue.push(...content.split(""));
        }
        else {
            this.contentQueue.push(...content.split(""));
        }

        if (!this.isProcessing) {
            this.isProcessing = true;
            this.lastFrameTime = 0;
            this.processCharacters();
        }
    }

    processCharacters() {
        requestAnimationFrame((currentTime) => {
            if (this.contentQueue.length > 0) {
                if (this.lastFrameTime === 0) {
                    this.lastFrameTime = currentTime;
                }
                const elapsed = currentTime - this.lastFrameTime;

                this.accumulatedChars += elapsed / this.delay;
                const charsToProcess = Math.floor(this.accumulatedChars);
                this.accumulatedChars -= charsToProcess;

                const chunk = this.contentQueue.splice(0, charsToProcess);

                this.contentDiv.textContent += chunk.join('');
                this.scrollFunc();

                if (this.thoughtEndToggle && this.pendingSwitch && this.contentQueue.length === 0) {
                    this.pendingSwitch = false;
                    this.contentQueue.push(...this.pendingQueue);
                    delete this.pendingQueue;
                    this.contentDiv.innerHTML = add_codeblock_html(this.parts.at(-2).content);
                    this.switchContentDiv(this.parts.at(-1).type === 'thought');
                }

                this.lastFrameTime = currentTime;
                this.processCharacters();
            } else {
                this.isProcessing = false;
                if (this.pendingFooter) {
                    const { footer, resolve } = this.pendingFooter;
                    this.pendingFooter = null;
                    super.addFooter(footer).then(resolve);  // Resolve the promise after processing the footer
                }
            }
        });
    }

    addFooter(footer) {
        if (this.isProcessing) {
            return new Promise((resolve) => {
                this.pendingFooter = { footer, resolve }; // Save the resolve function to call later
            });
        } else {
            return super.addFooter(footer);
        }
    }
}


export class ChatStorage {
    constructor() {
        this.dbName = 'llm-chats';
        this.dbVersion = 3;
    }

    async getDB() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, this.dbVersion);
            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve(request.result);
            request.onupgradeneeded = (event) => this.onUpgrade(event);
        });
    }

    onUpgrade(event) {
        const db = event.target.result;
        const oldVersion = event.oldVersion;

        // Version 0 → 1 (initial setup)
        if (oldVersion < 1) {
            if (!db.objectStoreNames.contains('messages')) {
                const messageStore = db.createObjectStore('messages', {
                    keyPath: ['chatId', 'messageId']
                });
                messageStore.createIndex('chatId', 'chatId');
            }
            
            if (!db.objectStoreNames.contains('chatMeta')) {
                db.createObjectStore('chatMeta', {
                    keyPath: 'chatId',
                    autoIncrement: true
                });
            }
        }

        // Version 1 → 2 (timestamp index)
        if (oldVersion < 2) {
            const metaStore = event.currentTarget.transaction.objectStore('chatMeta');
            if (!metaStore.indexNames.contains('timestamp')) {
                metaStore.createIndex('timestamp', 'timestamp');
            }
        }

        // Version 2 → 3 (message structure migration)
        if (oldVersion < 3) {
            this.migrateToVersion3(event);
        }
    }

    // FIXED: Proper migration using upgrade transaction
    migrateToVersion3(upgradeEvent) {
        console.log('Migrating messages to version 3...');
        const transaction = upgradeEvent.currentTarget.transaction;
        const metaStore = transaction.objectStore('chatMeta');
        const messageStore = transaction.objectStore('messages');

        // 1. Collect all chat IDs
        metaStore.getAllKeys().onsuccess = (e) => {
            const chatIds = e.target.result;
            
            chatIds.forEach((chatId) => {
                // 2. Process messages per chat
                const messagesReq = messageStore.index('chatId').getAll(IDBKeyRange.only(chatId));
                
                messagesReq.onsuccess = () => {
                    const oldMessages = messagesReq.result;
                    const newMessages = this.transformMessages(oldMessages);

                    // 3. Delete old messages
                    const deleteReq = messageStore.index('chatId').openCursor(IDBKeyRange.only(chatId));
                    deleteReq.onsuccess = (delEvent) => {
                        const cursor = delEvent.target.result;
                        if (cursor) {
                            cursor.delete();
                            cursor.continue();
                        } else {
                            // 4. Insert transformed messages
                            newMessages.forEach((msg, idx) => {
                                messageStore.put({ ...msg, messageId: idx });
                            });
                        }
                    };
                };
            });

            console.log('Migration complete.');
        };
    }

    // Helper: Message structure transformation
    transformMessages(oldMessages) {
        return oldMessages.reduce((acc, currentMsg, index) => {
            // Skip processed regenerations
            if (currentMsg._processed) return acc;

            // Handle arena messages
            if (currentMsg.responses) {
                acc.push(this.transformArenaMessage(currentMsg));
                return acc;
            }

            // Handle assistant regenerations
            if (currentMsg.role === 'assistant') {
                const regenerations = this.collectRegenerations(oldMessages, index);
                acc.push(this.transformAssistantMessage(currentMsg, regenerations));
                return acc;
            }

            // Handle normal messages
            acc.push(this.transformNormalMessage(currentMsg));
            return acc;
        }, []);
    }

    // Helper: Collect consecutive regenerations
    collectRegenerations(messages, startIndex) {
        const regenerations = [];
        let i = startIndex + 1;
        
        while (i < messages.length && 
               messages[i].role === 'assistant' &&
               !messages[i].responses) {
            messages[i]._processed = true; // Mark as processed
            regenerations.push(messages[i]);
            i++;
        }
        
        return regenerations;
    }

    // Transformation logic for each message type
    transformArenaMessage(msg) {
        return {
            chatId: msg.chatId,
            role: 'assistant',
            choice: msg.choice || 'ignored',
            continued_with: msg.continued_with || '',
            responses: {
                model_a: {
                    name: msg.responses.model_a.name,
                    messages: msg.responses.model_a.messages.map(m => ([{
                        type: 'text',
                        content: m
                    }]))
                },
                model_b: {
                    name: msg.responses.model_b.name,
                    messages: msg.responses.model_b.messages.map(m => ([{
                        type: 'text',
                        content: m
                    }]))
                }
            },
            timestamp: msg.timestamp
        };
    }

    transformAssistantMessage(msg, regenerations) {
        return {
            chatId: msg.chatId,
            role: 'assistant',
            contents: [
                [{
                    type: 'text',
                    content: msg.content,
                    model: msg.model
                }],
                ...regenerations.map(r => ([{
                    type: 'text',
                    content: r.content,
                    model: r.model
                }]))
            ],
            timestamp: msg.timestamp
        };
    }

    transformNormalMessage(msg) {
        return {
            chatId: msg.chatId,
            role: msg.role,
            contents: [[{
                type: 'text',
                content: msg.content
            }]],
            ...(msg.images && { images: msg.images }),
            ...(msg.files && { files: msg.files }),
            timestamp: msg.timestamp
        };
    }

    async createChatWithMessages(title, messages, continuedFromChatId = null) {
        const db = await this.getDB();
        const tx = db.transaction(['chatMeta', 'messages'], 'readwrite');
        const metaStore = tx.objectStore('chatMeta');
        const messageStore = tx.objectStore('messages');

        return new Promise((resolve, reject) => {
            const chatMeta = {
                title,
                timestamp: Date.now(),
                renamed: false,
                continued_from_chat_id: continuedFromChatId || null
            };

            const metaRequest = metaStore.add(chatMeta);

            metaRequest.onsuccess = () => {
                const chatId = metaRequest.result;
                const messagePromises = messages.map((message, index) =>
                    messageStore.add({
                        chatId,
                        messageId: index,
                        timestamp: Date.now(),
                        ...message
                    })
                );

                Promise.all(messagePromises)
                    .then(() => {
                        // Send message after successful creation
                        chrome.runtime.sendMessage({
                            type: 'new_chat_saved',
                            chat: {
                                chatId,
                                ...chatMeta,
                            }
                        });

                        resolve({
                            chatId,
                            ...chatMeta
                        });
                    })
                    .catch(reject);
            };

            metaRequest.onerror = () => reject(metaRequest.error);
        });
    }

    async addMessages(chatId, messages, startMessageIdIncrementAt) {
        const timestamp = Date.now();
        const db = await this.getDB();
        
        const results = await new Promise((resolve, reject) => {
            const tx = db.transaction(['messages'], 'readwrite');
            const store = tx.objectStore('messages');
    
            Promise.all(messages.map((message, index) =>
                new Promise((resolve, reject) => {
                    const request = store.add({
                        chatId,
                        messageId: startMessageIdIncrementAt + index,
                        timestamp,
                        ...message
                    });
                    request.onsuccess = () => resolve(request.result);
                    request.onerror = () => reject(request.error);
                })
            )).then(resolve).catch(reject);
        });
    
        await this.updateChatOption(chatId, { timestamp });
    
        chrome.runtime.sendMessage({
            type: 'appended_messages_to_saved_chat',
            chatId: chatId,
            addedCount: messages.length
        });
    
        return results;
    }

    async updateMessage(chatId, messageId, message) {
        const timestamp = Date.now();
        const db = await this.getDB();
    
        const result = await new Promise((resolve, reject) => {
            const tx = db.transaction(['messages'], 'readwrite');
            const store = tx.objectStore('messages');
    
            const request = store.put({
                chatId,
                messageId: messageId,
                timestamp,
                ...message
            });
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    
        await this.updateChatOption(chatId, { timestamp });
    
        chrome.runtime.sendMessage({
            type: 'message_updated',
            chatId: chatId,
            messageId: messageId
        });
    
        return result;
    }

    async getMessage(chatId, messageId) {
        const db = await this.getDB();
        const tx = db.transaction(['messages'], 'readonly');
        const store = tx.objectStore('messages');

        return new Promise((resolve, reject) => {
            const request = store.get([chatId, messageId]);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    async getChatLength(chatId) {
        const db = await this.getDB();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(['messages'], 'readonly');
            const store = transaction.objectStore('messages');
            const index = store.index('chatId');
            const request = index.count(chatId);
    
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    async loadChat(chatId, messageLimit = null) {
        const db = await this.getDB();
        const tx = db.transaction(['messages', 'chatMeta'], 'readonly');
        const messageStore = tx.objectStore('messages');
        const metaStore = tx.objectStore('chatMeta');

        return new Promise((resolve) => {
            const messages = [];
            let count = 0;

            const index = messageStore.index('chatId');
            const request = index.openCursor(IDBKeyRange.only(chatId));

            request.onsuccess = (event) => {
                const cursor = event.target.result;

                if (!cursor || (messageLimit !== null && count >= messageLimit)) {
                    metaStore.get(chatId).onsuccess = (event) => {
                        resolve({
                            ...event.target.result,
                            messages
                        });
                    };
                    return;
                }

                messages.push(cursor.value);
                count++;
                cursor.continue();
            };

            request.onerror = () => {
                resolve({ messages: [] });
            };
        });
    }

    async getLatestMessages(chatId, limit) {
        const db = await this.getDB();
        const tx = db.transaction(['messages'], 'readonly');
        const messageStore = tx.objectStore('messages');

        return new Promise((resolve) => {
            const messages = [];
            let count = 0;

            const index = messageStore.index('chatId');
            const cursorRequest = index.openCursor(IDBKeyRange.only(chatId), 'prev');

            cursorRequest.onsuccess = (event) => {
                const cursor = event.target.result;

                if (!cursor || count >= limit) {
                    // Reverse to maintain chronological order
                    resolve(messages.reverse());
                    return;
                }

                messages.push(cursor.value);
                count++;
                cursor.continue();
            };

            cursorRequest.onerror = () => {
                resolve([]);
            };
        });
    }

    async renameChat(chatId, newTitle, announceUpdate = false) {
        const chatMeta = await this.updateChatOption(chatId, {
            title: newTitle,
            renamed: true
        });
    
        if (announceUpdate) {
            chrome.runtime.sendMessage({
                type: 'chat_renamed',
                chatId: chatId,
                title: newTitle
            });
        }
    
        return chatMeta;
    }

    async updateChatOption(chatId, option = {}) {
        const db = await this.getDB();
        const tx = db.transaction('chatMeta', 'readwrite');
        const store = tx.objectStore('chatMeta');
        
        return new Promise((resolve, reject) => {
            const getRequest = store.get(chatId);
            getRequest.onsuccess = () => {
                const chat = getRequest.result;
                const putRequest = store.put({
                    ...chat,
                    ...option
                });
                putRequest.onsuccess = () => resolve(putRequest.result);
                putRequest.onerror = () => reject(putRequest.error);
            };
            getRequest.onerror = () => reject(getRequest.error);
        });
    }

    async deleteChat(chatId) {
        const db = await this.getDB();
        const tx = db.transaction(['messages', 'chatMeta'], 'readwrite');

        const messageStore = tx.objectStore('messages');
        const metaStore = tx.objectStore('chatMeta');

        const index = messageStore.index('chatId');
        await Promise.all([
            new Promise((resolve) => {
                const request = index.openCursor(IDBKeyRange.only(chatId));
                request.onsuccess = (event) => {
                    const cursor = event.target.result;
                    if (cursor) {
                        cursor.delete();
                        cursor.continue();
                    } else {
                        resolve();
                    }
                };
            }),
            metaStore.delete(chatId)
        ]);
    }

    async getChatMetadata(limit = 20, offset = 0) {
        const db = await this.getDB();
        const tx = db.transaction('chatMeta', 'readonly');
        const store = tx.objectStore('chatMeta');
        const index = store.index('timestamp');
    
        return new Promise((resolve) => {
            const metadata = [];
            let skipped = 0;
            
            const request = index.openCursor(null, 'prev');  // 'prev' gives us descending order
    
            request.onsuccess = (event) => {
                const cursor = event.target.result;
                if (!cursor || metadata.length >= limit) {
                    resolve(metadata);
                    return;
                }
    
                if (skipped < offset) {
                    skipped++;
                } else {
                    metadata.push(cursor.value);
                }
                cursor.continue();
            };
        });
    }

    async getChatMetadataById(chatId) {
        const db = await this.getDB();
        const tx = db.transaction('chatMeta', 'readonly');
        const store = tx.objectStore('chatMeta');

        return new Promise((resolve, reject) => {
            const request = store.get(chatId);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    async exportChats(options = { pretty: false }) {
        const db = await this.getDB();
        const tx = db.transaction(['chatMeta', 'messages'], 'readonly');
        const metaStore = tx.objectStore('chatMeta');
        const messageStore = tx.objectStore('messages');
    
        const archive = {
            exportedAt: new Date().toISOString(),
            schemaVersion: this.dbVersion,
            chats: {}
        };
    
        // Function to iterate through a cursor and return a Promise
        const iterateCursor = (store, indexName, keyRange, processItem) => {
            return new Promise((resolve, reject) => {
                const request = indexName
                    ? store.index(indexName).openCursor(keyRange)
                    : store.openCursor();
    
                request.onerror = () => reject(request.error);
    
                request.onsuccess = function (event) {
                    const cursor = event.target.result;
                    if (cursor) {
                        processItem(cursor.value);
                        cursor.continue();
                    } else {
                        resolve(); // No more items
                    }
                };
            });
        };
    
        // 1. Fetch all chat metadata
        await iterateCursor(metaStore, null, null, (chatMeta) => {
            archive.chats[chatMeta.chatId] = {
                ...chatMeta,
                messages: []
            };
        });
    
        // 2. Fetch messages for each chat
        for (const chatId in archive.chats) {
            await iterateCursor(messageStore, 'chatId', IDBKeyRange.only(parseInt(chatId, 10)), (message) => { // Parse chatId to number
                archive.chats[chatId].messages.push(message);
            });
        }
    
        return JSON.stringify(archive, null, options.pretty ? 2 : 0);
    }

    async importChats(archiveJson) {
        try {
            const archive = JSON.parse(archiveJson);
            if (!archive?.chats) throw new Error("Invalid archive format");
    
            const db = await this.getDB();
            const needsMigration = archive.schemaVersion < 3; // NEW: Version check
            
            // Fingerprint check outside transaction to avoid version contention
            const existingChats = await this.getChatMetadata(Infinity);
            const existingFingerprints = new Set(
                existingChats.map(c => `${c.title}::${c.timestamp}`)
            );
            const chatQueue = Object.values(archive.chats)
                .filter(chat => !existingFingerprints.has(`${chat.title}::${chat.timestamp}`))
                .map(chat => needsMigration ? this.migrateImportedChat(chat) : chat);
    
            const tx = db.transaction(['chatMeta', 'messages'], 'readwrite');
            const metaStore = tx.objectStore('chatMeta');
            const messageStore = tx.objectStore('messages');
    
            let importedCount = 0;
            // Batch processing with controlled parallelism
            while (chatQueue.length) {
                const batch = chatQueue.splice(0, 20);
                
                await Promise.all(batch.map(async (chatData) => {
                    // Atomic per-chat sequence
                    const { messages, chatId, ...chatMeta } = chatData;
                    
                    const newChatId = await new Promise(resolve => {
                        const req = metaStore.add(chatMeta);
                        req.onsuccess = () => resolve(req.result);
                        req.onerror = () => resolve(null);
                    });
    
                    if (!newChatId) return;
    
                    // Parallel message insertion WITHIN chat context
                    await Promise.all(messages.map(msg => 
                        new Promise((resolve, reject) => {
                            messageStore.add({ ...msg, chatId: newChatId }).onsuccess = resolve;
                        })
                    ));
    
                    importedCount++;
                }));
            }
    
            // Transaction finalization
            await new Promise((resolve, reject) => {
                tx.oncomplete = resolve;
                tx.onerror = () => reject(tx.error);
            });
    
            return { success: true, count: importedCount };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    migrateImportedChat(chatData) {
        chatData.messages = this.transformMessages(chatData.messages).map((msg, idx) => ({ ...msg, messageId: idx }));
        return chatData;
    }

    triggerDownload(json, filename = `chat-backup-${Date.now()}.json`) {
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);

        const a = document.createElement('a');
        a.style.display = 'none';
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();

        setTimeout(() => {
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        }, 100);
    }

    createNewChatTracking(title) {
        return {
            chatId: null,
            title,
            messages: []
        };
    }

    initArenaMessage(modelA, modelB) {
        return {
            role: 'assistant',
            choice: 'ignored',
            continued_with: '',
            responses: {
                model_a: {
                    name: modelA,
                    messages: []
                },
                model_b: {
                    name: modelB,
                    messages: []
                },
            }
        };
    }
}

/* Expected object shapes for reference:
{
    chatMeta: {
        id: string,
        timestamp: number,
        title: string,
    },
    
    regularMessage: {
        chatId: autoincrement,
        messageId: autoincrement,
        timestamp: number,
        role: 'user' | 'assistant' | 'system',
        contents: [ { type: string, content: string, model?: string }[] ]  // Latest is current, previous are regenerations
        images?: string[] // Optional, user only
        files?: {filename: string, content: string}[]   // Optional, user only (array of objects in case duplicate filenames)
    },
    
    arenaMessage: {
        chatId: autoincrement,
        messageId: autoincrement,
        timestamp: number,
        role: 'assistant',
        choice: 'model_a' | 'model_b' | 'draw' | 'draw(bothbad)' | 'ignored' | 'reveal',
        continued_with: string  // model_a | model_b | none (in case of draw(bothbad), because the whole arena gets regenerated),
        responses: {
            model_a: {
                name: string,
                messages: [ { type: string, content: string }[] ]  // Latest is current, previous are regenerations
            },
            model_b: {
                name: string,
                messages: [ { type: string, content: string }[] ]
            },
        }
    }
}
*/


export class PromptStorage {
    constructor() {
        this.dbName = 'llm-prompts';
        this.dbVersion = 1;
    }

    async getDB() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, this.dbVersion);
            
            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                if (!db.objectStoreNames.contains('prompts')) {
                    const store = db.createObjectStore('prompts', { keyPath: ['name', 'type'] })
                    store.createIndex('type', 'type');
                }
            };

            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    async addPrompt(name, type, content, overwrite = false) {
        const db = await this.getDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction('prompts', 'readwrite');
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
            
            const store = tx.objectStore('prompts');
            if (overwrite) {
                store.put({ name, type, content });
            }
            else {
                store.add({ name, type, content });
            }
        });
    }

    async getPrompt(name) {
        const db = await this.getDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction('prompts', 'readonly');
            const store = tx.objectStore('prompts');
            const request = store.get(name);
            
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    async getAllPrompts() {
        const db = await this.getDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction('prompts', 'readonly');
            const store = tx.objectStore('prompts');
            const request = store.getAll();
            
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    async deletePrompt(name) {
        const db = await this.getDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction('prompts', 'readwrite');
            const store = tx.objectStore('prompts');
            const request = store.delete(name);
            
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }
}


export class ArenaRatingManager {
    constructor(dbName = "MatchesDB", storeName = "matches", ratingsCacheKey = "elo_ratings") {
        this.dbName = dbName;
        this.storeName = storeName;
        this.ratingsCacheKey = ratingsCacheKey;
        this.db = null;
        this.cachedRatings = {};
    }

    initDB() {
        // have to do this manually every time (once per arenamanager) so you can actually chain onto it
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, 1);

            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                if (!db.objectStoreNames.contains(this.storeName)) {
                    db.createObjectStore(this.storeName, { keyPath: "id", autoIncrement: true });
                }
            };

            request.onsuccess = (event) => {
                this.db = event.target.result;
                this.loadLatestRatings(); // Load cached ratings after DB initialization
                resolve(this.db);
            };

            request.onerror = (event) => {
                reject(event.target.errorCode);
            };
        });
    }

    saveMatch(modelA, modelB, result) {
        const validResults = ["model_a", "model_b", "draw", "draw(bothbad)"];
        if (!validResults.includes(result)) {
            throw new Error(`Attempted to save invalid result to DB: ${result}`);
        }
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeName], "readwrite");
            const store = transaction.objectStore(this.storeName);

            const match = { model_a: modelA, model_b: modelB, result: result };
            const request = store.add(match);

            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }

    getMatchHistory() {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeName], "readonly");
            const store = transaction.objectStore(this.storeName);

            const request = store.getAll();
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    expectedScore(ratingA, ratingB, BASE, SCALE) {
        return 1 / (1 + Math.pow(BASE, (ratingB - ratingA) / SCALE));
    }

    calculateElo(matches, K = 40, SCALE = 400, BASE = 10, INIT_RATING = 1000) {
        /* We'll use the chess default of K = 40, and because this is a local arena and our sample size will be low.
        Chatbot arena uses K = 4 because of high sample size. We'll also reduce K to 20 when a model passes 30 matches.*/
        let ratings = this.cachedRatings || {};

        // Initialize ratings for any new models
        matches.forEach(match => {
            const modelA = match.model_a;
            const modelB = match.model_b;

            if (!ratings[modelA]) ratings[modelA] = { rating: INIT_RATING, matches_count: 0 };
            if (!ratings[modelB]) ratings[modelB] = { rating: INIT_RATING, matches_count: 0 };
        });

        // Calculate Elo ratings
        matches.forEach(match => {
            const modelA = match.model_a;
            const modelB = match.model_b;
            const winner = match.result;

            let scoreA;
            switch (winner) {
                case "model_a":
                    scoreA = 1;
                    break;
                case "model_b":
                    scoreA = 0;
                    break;
                case "draw":
                    scoreA = 0.5;
                    break;
                case "draw(bothbad)":
                case "ignored":
                case "reveal":
                    // only want to save these just in case, but not use them for the ratings, bothbad is more supposed to be a "cancel/this sucks" than a draw
                    return;
                default:
                    throw new Error(`Unexpected result: ${winner}`);
            }

            const ratingA = ratings[modelA].rating;
            const ratingB = ratings[modelB].rating;

            const expectedA = this.expectedScore(ratingA, ratingB, BASE, SCALE);
            const expectedB = 1.0 - expectedA;

            const kMatchesThreshold = 30;
            const kFactorA = ratings[modelA].matches_count >= kMatchesThreshold ? 20 : K;
            const kFactorB = ratings[modelB].matches_count >= kMatchesThreshold ? 20 : K;

            ratings[modelA].rating += kFactorA * (scoreA - expectedA);
            ratings[modelB].rating += kFactorB * ((1 - scoreA) - expectedB);

            ratings[modelA].matches_count++;
            ratings[modelB].matches_count++;
        });
        // chatbot arena also anchors the rating 800 to llama13b.
        this.cachedRatings = ratings;
        this.saveLatestRatings(ratings);

        return ratings;
    }

    saveLatestRatings() {
        return new Promise((resolve) => {
            chrome.storage.local.set({ [this.ratingsCacheKey]: this.cachedRatings }, resolve);
        });
    }

    loadLatestRatings() {
        return new Promise((resolve) => {
            chrome.storage.local.get([this.ratingsCacheKey], (result) => {
                this.cachedRatings = result[this.ratingsCacheKey] || {};
                resolve(this.cachedRatings);
            });
        });
    }

    addMatchAndUpdate(modelA, modelB, result) {
        this.saveMatch(modelA, modelB, result);
        const updatedRatings = this.calculateElo([{ model_a: modelA, model_b: modelB, result: result }]);
        return updatedRatings;
    }

    getModelRating(model) {
        return this.cachedRatings[model]?.rating || 1000;
    }

    async recalculateRatingsFromHistory() {
        const matches = await this.getMatchHistory();
        this.cachedRatings = {};
        return this.calculateElo(matches);
    }

    wipeStoredCacheAndDB() {
        this.cachedRatings = {};
        chrome.storage.local.remove(this.ratingsCacheKey);

        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeName], 'readwrite');
            const objectStore = transaction.objectStore(this.storeName);
            const request = objectStore.clear();

            request.onerror = (event) => reject(`Error clearing IndexedDB: ${event.target.error}`);
            request.onsuccess = () => {
                console.log("Match history successfully deleted and rating has been reset.");
                resolve();
            };
        });
    }

    async printMatchHistory() {
        try {
            const matchHistory = await this.getMatchHistory();
            console.log('Match History:');
            matchHistory.forEach((match) => {
                console.log(`Match id:${match.id}:`);
                console.log(`  Model A: ${match.model_a}`);
                console.log(`  Model B: ${match.model_b}`);
                console.log(`  Result: ${match.result}`);
                console.log('---');
            });
            console.log(`Total matches: ${matchHistory.length}`);

            // Also print current ratings
            console.log('Current Ratings:');
            Object.entries(this.cachedRatings).forEach(([model, data]) => {
                console.log(`  ${model}: Rating ${data.rating}, Matches ${data.matches_count}`);
            });
        } catch (error) {
            console.error('Error retrieving match history:', error);
        }
    }
}


export const ModeEnum = { "InstantPromptMode": 0, "PromptMode": 1, "Off": 2 };