export function get_mode(callback) {
	chrome.storage.local.get('mode', function(res) {
		callback(res.mode);
	});
}


export function set_mode(new_mode) {
    chrome.storage.local.set({mode: new_mode});
}


export function is_on(mode) {
	return mode !== ModeEnum.Off;
}


export function get_lifetime_tokens(callback) {
    chrome.storage.local.get(['lifetime_input_tokens', 'lifetime_output_tokens'], function(res) {
        callback({
            input: res.lifetime_input_tokens || 0,
            output: res.lifetime_output_tokens || 0
        });
    });
}


export function set_lifetime_tokens(newInputTokens, newOutputTokens) {
    get_lifetime_tokens(function(currentTokens) {
        chrome.storage.local.set({
            lifetime_input_tokens: currentTokens.input + newInputTokens,
            lifetime_output_tokens: currentTokens.output + newOutputTokens
        });
    });
}


export function get_stored_models() {
    return new Promise((resolve) => {
        chrome.storage.local.get(['models'], function(result) {
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
        }
    };
    const anthropic_models = Object.keys(MODELS.anthropic);
    let settings = {
        mode: ModeEnum.InstantPromptMode,
        lifetime_input_tokens: 0,
        lifetime_output_tokens: 0,
        max_tokens: 500,
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
            new Promise((resolve) => chrome.storage.local.set({selection_prompt: text.trim()}, resolve))
        ),
        loadTextFromFile("src/prompts/chat_prompt.txt").then((text) => 
            new Promise((resolve) => chrome.storage.local.set({chat_prompt: text.trim()}, resolve))
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
    constructor(inputTokens, outputTokens, isArenaMode, thoughtProcessState, regenerate_response) {
        this.inputTokens = inputTokens;
        this.outputTokens = outputTokens;
        this.isArenaMode = isArenaMode;
        this.thoughtProcessState = thoughtProcessState;
        this.regenerate_response = regenerate_response;
    }

    create(contentDiv) {
        let footerDiv = document.createElement("div");
        footerDiv.classList.add("message-footer");
        // need span to be able to calculate the width of the text in css for the centering animation
        let tokensSpan = document.createElement('span');
        tokensSpan.textContent = `${ this.isArenaMode ? "~": this.inputTokens} | ${this.outputTokens}`;
        footerDiv.setAttribute('input-tokens', this.inputTokens);
        footerDiv.appendChild(tokensSpan);
        if (this.thoughtProcessState !== "thinking") {
            this.createRegenerateButton(footerDiv, contentDiv);
        }
        else {
            footerDiv.classList.add('centered');
        }
        contentDiv.appendChild(footerDiv);
    }

    createRegenerateButton(footerDiv, contentDiv) {
        let regerateButton = document.createElement("button");
        regerateButton.textContent = '\u{21BB}'; // refresh symbol
        regerateButton.classList.add("button", "regenerate-button");
        regerateButton.addEventListener('click', () => {
            this.regenerate_response(contentDiv);
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
    constructor(contentDiv, scrollFunc = () => {}) {
        this.contentDiv = contentDiv;
        this.scrollFunc = scrollFunc;
        this.message = [];
        this.responseMessage = []; // Add this for non-thought content
        this.fullMessage = "";
        this.thoughtEndToggle = true;
    }

    setThinkingModel() {
        this.thoughtEndToggle = false;
        this.contentDiv.classList.add('thoughts');
    }

    addThinkingCounter() {
        const span = this.contentDiv.parentElement.querySelector('.message-prefix');
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
            this.responseMessage.push(content);
            if (!this.thoughtEndToggle) {
                this.thoughtEndToggle = true;
                this.switchContentDiv();
            }
        }
        this.message.push(content);
        this.contentDiv.textContent += content;
        this.scrollFunc();
    }

    switchContentDiv() {
        const newContentDiv = this.contentDiv.cloneNode(true);
        newContentDiv.textContent = '';
        newContentDiv.classList.remove('thoughts');
        this.contentDiv.parentElement.appendChild(newContentDiv);
        this.contentDiv.innerHTML = add_codeblock_html(this.message.join(''));
        this.contentDiv = newContentDiv;
    }

    addFooter(footer, add_pending) {
        // Use responseMessage for context, don't include model "thinking" in context
        this.fullMessage = this.responseMessage.join('');
        
        // still show everything, even the thinking part
        this.contentDiv.innerHTML = add_codeblock_html(this.responseMessage.join(''));

        footer.create(this.contentDiv);
        this.scrollFunc();
        const done = footer.thoughtProcessState !== "thinking";
        add_pending(this.fullMessage, done);
        return new Promise((resolve) => resolve());
    }
}


export class StreamWriter extends StreamWriterSimple {
    constructor(contentDiv, scrollFunc, wordsPerMinute = 200) {
        super(contentDiv, scrollFunc);
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
            this.responseMessage.push(content);
            if (!this.thoughtEndToggle) {
                this.thoughtEndToggle = true;
                this.pendingSwitch = true;
            }
        }
        
        if (this.pendingSwitch) {
            this.pendingQueue.push(...content.split(""));
        }
        else {
            this.message.push(content);
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
                    this.switchContentDiv();
                }

                this.lastFrameTime = currentTime;
                this.processCharacters();
            } else {
                this.isProcessing = false;
                if (this.pendingFooter) {
                    const {footer, add_pending, resolve} = this.pendingFooter;
                    super.addFooter(footer, add_pending).then(resolve);  // Resolve the promise after processing the footer
                    this.pendingFooter = null;
                }
            }
        });
    }

    addFooter(footer, add_pending) {
        if (this.isProcessing) {
            return new Promise((resolve) => {
                this.pendingFooter = {footer, add_pending, resolve}; // Save the resolve function to call later
            });
        } else {
            return super.addFooter(footer, add_pending);
        }
    }
}


export class ChatStorage {
    constructor() {
        this.dbName = 'llm-chats';
        this.dbVersion = 1;
    }

    async getDB() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, this.dbVersion);
            
            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve(request.result);
            
            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                
                if (!db.objectStoreNames.contains('messages')) {
                    const messageStore = db.createObjectStore('messages', { 
                        keyPath: ['chatId', 'messageId']
                    });
                    messageStore.createIndex('chatId', 'chatId');
                }
                
                if (!db.objectStoreNames.contains('chatMeta')) {
                    const metaStore = db.createObjectStore('chatMeta', { 
                        keyPath: 'chatId',
                        autoIncrement: true 
                    });
                }
            };
        });
    }

    async createChatWithMessages(title, messages) {
        const db = await this.getDB();
        const tx = db.transaction(['chatMeta', 'messages'], 'readwrite');
        const metaStore = tx.objectStore('chatMeta');
        const messageStore = tx.objectStore('messages');

        return new Promise((resolve, reject) => {
            const chatMeta = {
                title,
                timestamp: Date.now(),
                renamed: false
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
        const db = await this.getDB();
        const tx = db.transaction(['messages'], 'readwrite');
        const store = tx.objectStore('messages');

        return Promise.all(messages.map((message, index) =>
            new Promise((resolve, reject) => {
                const request = store.add({
                    chatId,
                    messageId: startMessageIdIncrementAt + index,
                    timestamp: Date.now(),
                    ...message
                });
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error);
            })
        )).then(results => {
            chrome.runtime.sendMessage({
                type: 'appended_messages_to_saved_chat',
                chatId: chatId,
                addedCount: messages.length
            });
            return results;
        });
    }

    async updateArenaMessage(chatId, messageId, message) {
        const db = await this.getDB();
        const tx = db.transaction(['messages'], 'readwrite');
        const store = tx.objectStore('messages');
        
        return new Promise((resolve, reject) => {
            const request = store.put({
                chatId,
                messageId: messageId,
                timestamp: Date.now(),
                ...message
            });
            request.onsuccess = () => {
                chrome.runtime.sendMessage({
                    type: 'saved_arena_message_updated',
                    chatId: chatId,
                    messageId: messageId
                });
                resolve(request.result);
            };
            request.onerror = () => reject(request.error);
        });
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
                            meta: event.target.result,
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
                resolve({ meta: null, messages: [] });
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

    async renameChat(chatId, newTitle) {
        const db = await this.getDB();
        const tx = db.transaction('chatMeta', 'readwrite');
        const store = tx.objectStore('chatMeta');

        const chatMeta = await new Promise((resolve, reject) => {
            const request = store.get(chatId);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });

        if (!chatMeta) {
            throw new Error(`Chat with ID ${chatId} not found`);
        }

        chatMeta.title = newTitle;
        chatMeta.renamed = true;
        await new Promise((resolve, reject) => {
            const request = store.put(chatMeta);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });

        return chatMeta;
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
            
            const request = index.openCursor(null, 'prev');  // newest first
            
            request.onsuccess = (event) => {
                const cursor = event.target.result;
                if (!cursor) {
                    resolve(metadata);
                    return;
                }

                if (skipped < offset) {
                    skipped++;
                    cursor.continue();
                    return;
                }

                if (metadata.length < limit) {
                    metadata.push(cursor.value);
                    cursor.continue();
                } else {
                    resolve(metadata);
                }
            };
        });
    }

    createNewChatTracking(title) {
        return {
            id: null,
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
        model?: string,  // For assistant messages
        content: string,
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
                messages: string[]  // Latest is current, previous are regenerations
            },
            model_b: {
                name: string,
                messages: string[]
            },
        }
    }
}
*/


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


export const ModeEnum = {"InstantPromptMode": 0, "PromptMode": 1, "Off": 2};