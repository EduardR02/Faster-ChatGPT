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

    async createChatWithMessages(title, messages, bonus_options = {}) {
        const db = await this.getDB();
        const tx = db.transaction(['chatMeta', 'messages'], 'readwrite');
        const metaStore = tx.objectStore('chatMeta');
        const messageStore = tx.objectStore('messages');

        return new Promise((resolve, reject) => {
            const chatMeta = {
                title,
                timestamp: Date.now(),
                renamed: bonus_options.renamed || false,
                continued_from_chat_id: bonus_options.continued_from_chat_id || null
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
            addedCount: messages.length,
            startIndex: startMessageIdIncrementAt
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

    async getMessages(chatId, startIndex = 0, limit) {
        const db = await this.getDB();
        const tx = db.transaction(['messages'], 'readonly');
        const messageStore = tx.objectStore('messages');
    
        return new Promise((resolve) => {
            const messages = [];
            let count = 0;
            let skipped = 0;
    
            const index = messageStore.index('chatId');
            // Using 'next' instead of 'prev' for ascending order
            const cursorRequest = index.openCursor(IDBKeyRange.only(chatId), 'next');
    
            cursorRequest.onsuccess = (event) => {
                const cursor = event.target.result;
    
                if (!cursor || count >= limit) {
                    resolve(messages);
                    return;
                }
    
                // Skip messages until startIndex
                if (skipped < startIndex) {
                    skipped++;
                    cursor.continue();
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
        contents: [ { type: 'text'|'thought'|'image', content: string, model?: string }[] ]  // Latest is current, previous are regenerations. 'image' type for AI-generated images (content is data URI)
        images?: string[] // Optional, user-uploaded images only (stored as data URIs)
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