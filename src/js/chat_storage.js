export class ChatStorage {
    constructor() {
        this.dbName = 'llm-chats';
        this.dbVersion = 4;  // Combined media + search index migration
        this.dbPromise = null;
    }

    async getDB() {
        if (!this.dbPromise) {
            this.dbPromise = new Promise((resolve, reject) => {
                const request = indexedDB.open(this.dbName, this.dbVersion);

                request.onerror = () => {
                    this.dbPromise = null;
                    reject(request.error);
                };

                request.onupgradeneeded = (event) => {
                    try {
                        this.upgradeSchema(event);
                    } catch (error) {
                        console.error('Failed to upgrade chat storage schema', error);
                        try {
                            event.target.transaction?.abort();
                        } catch (_) {
                            // no-op
                        }
                        this.dbPromise = null;
                        reject(error);
                    }
                };

                request.onsuccess = () => {
                    const db = request.result;

                    db.onclose = () => {
                        this.dbPromise = null;
                    };

                    db.onversionchange = () => {
                        db.close();
                    };

                    resolve(db);
                };
            });
        }

        return this.dbPromise;
    }

    upgradeSchema(event) {
        const db = event.target.result;
        const oldVersion = event.oldVersion || 0;

        // Version 1: Initial setup (chatMeta, messages)
        if (oldVersion < 1) {
            if (!db.objectStoreNames.contains('chatMeta')) {
                const chatMetaStore = db.createObjectStore('chatMeta', {
                    keyPath: 'chatId',
                    autoIncrement: true,
                });
                chatMetaStore.createIndex('timestamp', 'timestamp');
            }
            if (!db.objectStoreNames.contains('messages')) {
                const messageStore = db.createObjectStore('messages', {
                    keyPath: ['chatId', 'messageId']
                });
                messageStore.createIndex('chatId', 'chatId');
            }
        }

        // Version 2: Timestamp index (already in v1 above)

        // Version 3: Message structure migration
        if (oldVersion < 3) {
            this.migrateToVersion3(event);
        }

        // Version 4: Media + search index
        if (oldVersion < 4) {
            if (!db.objectStoreNames.contains('mediaIndex')) {
                const mediaStore = db.createObjectStore('mediaIndex', { keyPath: 'id', autoIncrement: true });
                mediaStore.createIndex('chatId', 'chatId');
                mediaStore.createIndex('timestamp', 'timestamp');
            }

            if (!db.objectStoreNames.contains('searchIndex')) {
                const searchStore = db.createObjectStore('searchIndex', { keyPath: 'id' });
                searchStore.createIndex('id', 'id', { unique: true });
            }

            if (!db.objectStoreNames.contains('searchDocs')) {
                db.createObjectStore('searchDocs', { keyPath: 'id' });
            }
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
        const tx = db.transaction(['chatMeta', 'messages', 'mediaIndex', 'searchDocs'], 'readwrite');
        const metaStore = tx.objectStore('chatMeta');
        const messageStore = tx.objectStore('messages');
        const mediaStore = tx.objectStore('mediaIndex');
        const searchDocsStore = tx.objectStore('searchDocs');

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
                        // Track images in media index
                        const mediaPromises = this.indexImagesFromMessages(chatId, messages, mediaStore);
                        return Promise.all(mediaPromises);
                    })
                    .then(() => new Promise((resolveDoc, rejectDoc) => {
                        const searchDoc = ChatStorage.buildSearchDocument({
                            chatId,
                            title: chatMeta.title,
                            timestamp: chatMeta.timestamp,
                            messages
                        });
                        const putReq = searchDocsStore.put(searchDoc);
                        putReq.onsuccess = () => resolveDoc(searchDoc);
                        putReq.onerror = () => rejectDoc(putReq.error);
                    }))
                    .then((searchDoc) => {
                        // Send message after successful creation
                        chrome.runtime.sendMessage({
                            type: 'new_chat_saved',
                            chat: {
                                chatId,
                                ...chatMeta,
                            },
                            searchDoc
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
            const tx = db.transaction(['messages', 'mediaIndex'], 'readwrite');
            const store = tx.objectStore('messages');
            const mediaStore = tx.objectStore('mediaIndex');

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
            )).then(() => {
                // Track images in media index
                const mediaPromises = this.indexImagesFromMessages(chatId, messages, mediaStore, startMessageIdIncrementAt);
                return Promise.all(mediaPromises);
            }).then(() => {
                resolve();
            }).catch(reject);
        });

        await this.updateChatOption(chatId, { timestamp });

        const searchDelta = ChatStorage.extractTextFromMessages(messages);
        if (searchDelta.trim()) {
            let appended = false;
            try {
                appended = await this.appendToSearchDoc(chatId, searchDelta, timestamp);
            } catch (error) {
                console.warn('Failed to append search doc:', error);
            }
            if (!appended) {
                await this.refreshSearchDoc(chatId);
            }
        }

        chrome.runtime.sendMessage({
            type: 'appended_messages_to_saved_chat',
            chatId: chatId,
            addedCount: messages.length,
            startIndex: startMessageIdIncrementAt,
            timestamp,
            searchDelta
        });

        return results;
    }

    async updateMessage(chatId, messageId, message) {
        const timestamp = Date.now();
        const db = await this.getDB();

        const result = await new Promise((resolve, reject) => {
            const tx = db.transaction(['messages', 'mediaIndex'], 'readwrite');
            const store = tx.objectStore('messages');
            const mediaStore = tx.objectStore('mediaIndex');

            const request = store.put({
                chatId,
                messageId: messageId,
                timestamp,
                ...message
            });
            request.onsuccess = () => {
                // Track images in media index
                const mediaPromises = this.indexImagesFromMessages(chatId, [message], mediaStore, messageId);
                Promise.all(mediaPromises).then(() => {
                    resolve(request.result);
                }).catch(() => {
                    resolve(request.result); // Don't fail on media index errors
                });
            };
            request.onerror = () => reject(request.error);
        });

        await this.updateChatOption(chatId, { timestamp });

        await this.refreshSearchDoc(chatId);

        chrome.runtime.sendMessage({
            type: 'message_updated',
            chatId: chatId,
            messageId: messageId
        });

        return result;
    }

    async indexAllMediaFromExistingMessages(batchSize = 25) {
        const db = await this.getDB();

        if (!db.objectStoreNames.contains('mediaIndex')) {
            return 0;
        }

        const allMeta = await this.getChatMetadata(Infinity, 0);
        let indexed = 0;

        for (let i = 0; i < allMeta.length; i += batchSize) {
            const batch = allMeta.slice(i, i + batchSize);

            for (const { chatId } of batch) {
                const chat = await this.loadChat(chatId);
                if (!chat?.messages?.length) continue;

                const tx = db.transaction(['mediaIndex'], 'readwrite');
                const mediaStore = tx.objectStore('mediaIndex');

                const completion = new Promise((resolve, reject) => {
                    tx.oncomplete = () => resolve();
                    tx.onerror = () => reject(tx.error);
                    tx.onabort = () => reject(tx.error);
                });

                const requests = this.indexImagesFromMessages(chatId, chat.messages, mediaStore);
                if (requests.length) {
                    await Promise.all(requests);
                }

                if (typeof tx.commit === 'function') {
                    try {
                        tx.commit();
                    } catch (commitError) {
                        // ignore; browsers without commit will throw
                    }
                }

                await completion;

                indexed += requests.length;
            }
        }

        return indexed;
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

    async getMessagesBatch(keys) {
        try {
            if (!Array.isArray(keys) || keys.length === 0) {
                return new Map();
            }

            const normalized = [];
            const seen = new Set();

            for (const rawKey of keys) {
                if (!rawKey) continue;

                let chatId;
                let messageId;

                if (Array.isArray(rawKey)) {
                    [chatId, messageId] = rawKey;
                } else if (typeof rawKey === 'object') {
                    ({ chatId, messageId } = rawKey);
                }

                if (chatId === undefined || messageId === undefined) continue;

                const compositeKey = `${chatId}:${messageId}`;
                if (seen.has(compositeKey)) continue;
                seen.add(compositeKey);
                normalized.push({ chatId, messageId, compositeKey });
            }

            if (!normalized.length) {
                return new Map();
            }

            const db = await this.getDB();
            const tx = db.transaction(['messages'], 'readonly');
            const store = tx.objectStore('messages');

            return await new Promise((resolve, reject) => {
                const results = new Map();

                for (const { chatId, messageId, compositeKey } of normalized) {
                    const request = store.get([chatId, messageId]);
                    request.onsuccess = () => {
                        results.set(compositeKey, request.result ?? null);
                    };
                    request.onerror = () => {
                        results.set(compositeKey, null);
                    };
                }

                tx.oncomplete = () => resolve(results);
                tx.onerror = () => reject(tx.error);
            });
        } catch (error) {
            console.error('Error in getMessagesBatch:', error);
            return new Map();
        }
    }

    async getMessages(chatId, startIndex = 0, limit) {
        const db = await this.getDB();
        const tx = db.transaction(['messages'], 'readonly');
        const messageStore = tx.objectStore('messages');

        const hasFiniteLimit = Number.isInteger(limit) && limit > 0;
        const hasValidStart = Number.isInteger(startIndex) && startIndex >= 0;

        if (hasFiniteLimit && hasValidStart) {
            const requests = [];
            for (let offset = 0; offset < limit; offset++) {
                const messageId = startIndex + offset;
                requests.push(new Promise((resolve) => {
                    const req = messageStore.get([chatId, messageId]);
                    req.onsuccess = () => resolve(req.result || null);
                    req.onerror = () => resolve(null);
                }));
            }
            const results = await Promise.all(requests);
            return results.filter(Boolean);
        }

        return new Promise((resolve) => {
            const messages = [];
            let collected = 0;
            const index = messageStore.index('chatId');
            const cursorRequest = index.openCursor(IDBKeyRange.only(chatId), 'next');

            cursorRequest.onsuccess = (event) => {
                const cursor = event.target.result;
                if (!cursor) {
                    resolve(messages);
                    return;
                }

                const messageId = typeof cursor.value?.messageId === 'number' ? cursor.value.messageId : null;
                if (typeof messageId === 'number' && messageId < startIndex) {
                    const skip = startIndex - messageId;
                    if (skip > 0) {
                        cursor.advance(skip);
                    }
                    return;
                }

                messages.push(cursor.value);
                collected++;
                if (hasFiniteLimit && collected >= limit) {
                    resolve(messages);
                    return;
                }
                cursor.continue();
            };

            cursorRequest.onerror = () => resolve([]);
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

        const metaUpdated = await this.updateSearchDocMeta(chatId, {
            title: newTitle
        });
        if (!metaUpdated) {
            await this.refreshSearchDoc(chatId);
        }

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
        const tx = db.transaction(['messages', 'chatMeta', 'mediaIndex', 'searchDocs'], 'readwrite');

        const messageStore = tx.objectStore('messages');
        const metaStore = tx.objectStore('chatMeta');
        const mediaStore = tx.objectStore('mediaIndex');
        const searchDocsStore = tx.objectStore('searchDocs');

        const messageIndex = messageStore.index('chatId');
        const mediaIndex = mediaStore.index('chatId');

        await Promise.all([
            new Promise((resolve) => {
                const request = messageIndex.openCursor(IDBKeyRange.only(chatId));
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
            new Promise((resolve) => {
                const request = mediaIndex.openCursor(IDBKeyRange.only(chatId));
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
            new Promise((resolve) => {
                const request = metaStore.delete(chatId);
                request.onsuccess = () => resolve();
                request.onerror = () => resolve();
            }),
            new Promise((resolve) => {
                const request = searchDocsStore.delete(chatId);
                request.onsuccess = () => resolve();
                request.onerror = () => resolve();
            })
        ]);
    }

    // FIXED: getChatCount uses 'chatMeta'
    async getChatCount() {
        const db = await this.getDB();
        const tx = db.transaction('chatMeta', 'readonly');
        const metaStore = tx.objectStore('chatMeta');
        const countReq = metaStore.count();
        const count = await new Promise((resolve, reject) => {
            countReq.onsuccess = () => {
                const count = countReq.result;
                resolve(count);
            };
            countReq.onerror = reject;
        });
        return count;
    }

    // FIXED: getChatMetadata uses 'chatMeta'
    async getChatMetadata(limit = 20, offset = 0) {
        const db = await this.getDB();
        const tx = db.transaction('chatMeta', 'readonly');
        const metaStore = tx.objectStore('chatMeta');
        const index = metaStore.index('timestamp');
        const request = index.openCursor(null, 'prev'); // Descending for newest first

        const metadata = [];
        let skipped = 0;
        let fetched = 0;

        return new Promise((resolve, reject) => {
            request.onerror = reject;
            request.onsuccess = (event) => {
                const cursor = event.target.result;
                if (cursor && (limit === Infinity || fetched < limit)) {
                    if (offset > 0 && skipped < offset) {
                        skipped++;
                        cursor.continue();
                        return;
                    }
                    const chatMeta = cursor.value;
                    metadata.push({
                        chatId: chatMeta.chatId,
                        title: chatMeta.title,
                        timestamp: chatMeta.timestamp,
                        continued_from_chat_id: chatMeta.continued_from_chat_id
                    });
                    fetched++;
                    cursor.continue();
                } else {
                    resolve(metadata); // Already newest-first
                }
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
            const existingIdsByFingerprint = new Map(
                existingChats.map(c => [`${c.title}::${c.timestamp}`, c.chatId])
            );

            const idRemap = new Map();
            const chatQueue = [];

            Object.values(archive.chats).forEach(rawChat => {
                const chat = needsMigration ? this.migrateImportedChat(rawChat) : rawChat;
                const fingerprint = `${chat.title}::${chat.timestamp}`;
                const existingId = existingIdsByFingerprint.get(fingerprint);

                if (existingId !== undefined) {
                    if (chat.chatId !== undefined && chat.chatId !== null) {
                        idRemap.set(chat.chatId, existingId);
                    }
                    return; // skip duplicates
                }

                chatQueue.push(chat);
            });

            const tx = db.transaction(['chatMeta', 'messages'], 'readwrite');
            const metaStore = tx.objectStore('chatMeta');
            const messageStore = tx.objectStore('messages');

            let importedCount = 0;
            const pendingLinkUpdates = [];

            while (chatQueue.length) {
                const batch = chatQueue.splice(0, 20);

                await Promise.all(batch.map(async (chatData) => {
                    const { messages, chatId: originalId, continued_from_chat_id, ...chatMeta } = chatData;
                    const metaRecord = {
                        ...chatMeta,
                        continued_from_chat_id,
                    };

                    const newChatId = await new Promise((resolve) => {
                        const request = metaStore.add(metaRecord);
                        request.onsuccess = () => resolve(request.result);
                        request.onerror = () => resolve(null);
                    });

                    if (!newChatId) return;

                    if (originalId !== undefined && originalId !== null) {
                        idRemap.set(originalId, newChatId);
                    }
                    idRemap.set(newChatId, newChatId);
                    pendingLinkUpdates.push({ targetId: newChatId, originalParentId: continued_from_chat_id });

                    await Promise.all(messages.map(msg =>
                        new Promise((resolve) => {
                            messageStore.add({ ...msg, chatId: newChatId }).onsuccess = resolve;
                        })
                    ));

                    importedCount++;
                }));
            }

            await Promise.all(pendingLinkUpdates.map(({ targetId, originalParentId }) => {
                if (originalParentId === undefined || originalParentId === null) return Promise.resolve();
                const resolvedParentId = idRemap.get(originalParentId);
                if (resolvedParentId === undefined || resolvedParentId === originalParentId) return Promise.resolve();

                return new Promise((resolve) => {
                    const getReq = metaStore.get(targetId);
                    getReq.onsuccess = () => {
                        const record = getReq.result;
                        if (!record) {
                            resolve();
                            return;
                        }
                        record.continued_from_chat_id = resolvedParentId;
                        const putReq = metaStore.put(record);
                        putReq.onsuccess = () => resolve();
                        putReq.onerror = () => resolve();
                    };
                    getReq.onerror = () => resolve();
                });
            }));

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

    // Helper to index images from messages into mediaIndex store
    // Returns array of promises for all add operations
    indexImagesFromMessages(chatId, messages, mediaStore, messageIdOffset = 0) {
        const promises = [];
        const fallbackTimestamp = Date.now();

        messages.forEach((message, index) => {
            const messageId = messageIdOffset + index;
            const baseTimestamp = typeof message?.timestamp === 'number' ? message.timestamp : (fallbackTimestamp + index);

            if (message.images && message.images.length > 0) {
                message.images.forEach((imageData, imgIndex) => {
                    promises.push(new Promise((resolve, reject) => {
                        const req = mediaStore.add({
                            chatId,
                            messageId,
                            imageIndex: imgIndex,
                            source: 'user',
                            timestamp: baseTimestamp
                        });
                        req.onsuccess = () => resolve();
                        req.onerror = () => resolve(); // Don't fail the whole transaction on media index errors
                    }));
                });
            }

            if (message.role === 'assistant' && message.contents && Array.isArray(message.contents)) {
                message.contents.forEach((contentGroup, contentIndex) => {
                    if (!contentGroup || !Array.isArray(contentGroup)) return;
                    contentGroup.forEach((part, partIndex) => {
                        if (!part || part.type !== 'image') return;
                        promises.push(new Promise((resolve, reject) => {
                            const req = mediaStore.add({
                                chatId,
                                messageId,
                                contentIndex,
                                partIndex,
                                source: 'assistant',
                                timestamp: baseTimestamp
                            });
                            req.onsuccess = () => resolve();
                            req.onerror = () => resolve();
                        }));
                    });
                });
            }

            if (message.responses) {
                ['model_a', 'model_b'].forEach(modelKey => {
                    const modelResponse = message.responses[modelKey];
                    if (!modelResponse || !modelResponse.messages || !Array.isArray(modelResponse.messages)) return;

                    modelResponse.messages.forEach((msgGroup, msgIndex) => {
                        if (!msgGroup || !Array.isArray(msgGroup)) return;
                        msgGroup.forEach((part, partIndex) => {
                            if (!part || part.type !== 'image') return;
                            promises.push(new Promise((resolve, reject) => {
                                const req = mediaStore.add({
                                    chatId,
                                    messageId,
                                    modelKey,
                                    messageIndex: msgIndex,
                                    partIndex,
                                    source: 'assistant',
                                    timestamp: baseTimestamp
                                });
                                req.onsuccess = () => resolve();
                                req.onerror = () => resolve();
                            }));
                        });
                    });
                });
            }
        });

        return promises;
    }

    // Get all media entries
    async getAllMedia(limit = 100, offset = 0) {
        try {
            const db = await this.getDB();

            // Check if mediaIndex store exists
            if (!db.objectStoreNames.contains('mediaIndex')) {
                console.warn('mediaIndex store does not exist yet, returning empty array');
                return [];
            }

            const tx = db.transaction('mediaIndex', 'readonly');
            const store = tx.objectStore('mediaIndex');
            const index = store.index('timestamp');

            return new Promise((resolve, reject) => {
                const media = [];
                let skipped = 0;

                const request = index.openCursor(null, 'prev'); // Descending by timestamp

                request.onsuccess = (event) => {
                    const cursor = event.target.result;
                    if (!cursor || media.length >= limit) {
                        resolve(media);
                        return;
                    }

                    if (skipped < offset) {
                        skipped++;
                    } else {
                        media.push(cursor.value);
                    }
                    cursor.continue();
                };

                request.onerror = () => {
                    console.error('Error reading media index:', request.error);
                    resolve([]); // Return empty array on error
                };
            });
        } catch (error) {
            console.error('Error in getAllMedia:', error);
            return [];
        }
    }

    // Get image data from a media index entry
    async getImageFromMediaEntry(entry) {
        const message = await this.getMessage(entry.chatId, entry.messageId);
        if (!message) return null;

        if (entry.source === 'user' && message.images) {
            return message.images[entry.imageIndex];
        }

        if (entry.source === 'assistant') {
            if (message.contents && entry.contentIndex !== undefined) {
                const contentGroup = message.contents[entry.contentIndex];
                const part = contentGroup?.[entry.partIndex];
                return part?.type === 'image' ? part.content : null;
            }

            if (message.responses && entry.modelKey) {
                const modelResponse = message.responses[entry.modelKey];
                const msgGroup = modelResponse?.messages?.[entry.messageIndex];
                const part = msgGroup?.[entry.partIndex];
                return part?.type === 'image' ? part.content : null;
            }
        }

        return null;
    }

    // Delete a media entry by ID
    async deleteMediaEntry(entryId) {
        const db = await this.getDB();
        const tx = db.transaction('mediaIndex', 'readwrite');
        const store = tx.objectStore('mediaIndex');

        return new Promise((resolve, reject) => {
            const request = store.delete(entryId);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }

    // Persist search index and document count
    async setSearchIndex(jsonString, count, metadata = []) {
        if (typeof jsonString !== 'string') {
            jsonString = JSON.stringify(jsonString || {});
        }

        const db = await this.getDB();
        const tx = db.transaction('searchIndex', 'readwrite');
        const store = tx.objectStore('searchIndex');

        store.put({ id: 'search', json: jsonString });
        store.put({ id: 'count', value: count });
        store.put({ id: 'metadata', value: metadata });

        return new Promise((resolve, reject) => {
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }

    async getSearchJson() {
        const db = await this.getDB();
        const tx = db.transaction('searchIndex', 'readonly');
        const store = tx.objectStore('searchIndex');
        const req = store.get('search');

        return new Promise((resolve, reject) => {
            req.onsuccess = () => resolve(req.result?.json || null);
            req.onerror = () => reject(req.error);
        });
    }

    async getSearchMetadata() {
        const db = await this.getDB();
        const tx = db.transaction('searchIndex', 'readonly');
        const store = tx.objectStore('searchIndex');
        const req = store.get('metadata');

        return new Promise((resolve, reject) => {
            req.onsuccess = () => resolve(req.result?.value || []);
            req.onerror = () => reject(req.error);
        });
    }

    async getSearchCount() {
        const db = await this.getDB();
        const tx = db.transaction('searchIndex', 'readonly');
        const store = tx.objectStore('searchIndex');
        const req = store.get('count');

        return new Promise((resolve, reject) => {
            req.onsuccess = () => resolve(req.result?.value || 0);
            req.onerror = () => reject(req.error);
        });
    }

    async getSearchDocs() {
        const db = await this.getDB();
        const tx = db.transaction('searchDocs', 'readonly');
        const store = tx.objectStore('searchDocs');

        return new Promise((resolve, reject) => {
            const request = store.getAll();
            request.onsuccess = () => resolve(request.result || []);
            request.onerror = () => reject(request.error);
        });
    }

    async putSearchDoc(doc) {
        if (!doc || doc.id == null) return;
        const db = await this.getDB();
        const tx = db.transaction('searchDocs', 'readwrite');
        const store = tx.objectStore('searchDocs');

        const payload = ChatStorage.applySearchDocFields({
            id: doc.id,
            title: doc.title ?? '',
            content: doc.content ?? '',
            timestamp: doc.timestamp ?? null,
            searchTitle: doc.searchTitle ?? null
        });

        return new Promise((resolve, reject) => {
            const request = store.put(payload);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }

    async appendToSearchDoc(chatId, delta, timestamp = null) {
        if (!delta || !delta.trim()) return false;
        const db = await this.getDB();
        const tx = db.transaction('searchDocs', 'readwrite');
        const store = tx.objectStore('searchDocs');

        return new Promise((resolve, reject) => {
            const getReq = store.get(chatId);
            getReq.onsuccess = () => {
                const existing = getReq.result;
                if (!existing) {
                    resolve(false);
                    return;
                }
                const trimmed = delta.trim();
                if (!trimmed) {
                    resolve(false);
                    return;
                }

                const normalisedDelta = ChatStorage.normaliseForSearch(trimmed);
                if (normalisedDelta) {
                    existing.content = existing.content
                        ? `${existing.content} ${normalisedDelta}`.trim()
                        : normalisedDelta;
                }
                if (timestamp != null) existing.timestamp = timestamp;

                if (typeof existing.searchTitle !== 'string') {
                    existing.searchTitle = ChatStorage.normaliseForSearch(existing.title || '');
                }

                const putReq = store.put(existing);
                putReq.onsuccess = () => resolve(true);
                putReq.onerror = () => reject(putReq.error);
            };
            getReq.onerror = () => reject(getReq.error);
        });
    }

    async putSearchDocs(docs = []) {
        const db = await this.getDB();
        const tx = db.transaction('searchDocs', 'readwrite');
        const store = tx.objectStore('searchDocs');

        return new Promise((resolve, reject) => {
            const keysReq = store.getAllKeys();
            keysReq.onsuccess = () => {
                const existingIds = new Set(keysReq.result || []);
                if (Array.isArray(docs) && docs.length > 0) {
                    docs.forEach(doc => {
                        const payload = ChatStorage.applySearchDocFields({
                            id: doc.id,
                            title: doc.title ?? '',
                            content: doc.content ?? '',
                            timestamp: doc.timestamp ?? null,
                            searchTitle: doc.searchTitle ?? null
                        });
                        existingIds.delete(payload.id);
                        store.put(payload);
                    });
                }

                existingIds.forEach(id => {
                    store.delete(id);
                });
            };
            keysReq.onerror = () => reject(keysReq.error);

            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }

    async deleteSearchDoc(id) {
        if (id == null) return;
        const db = await this.getDB();
        const tx = db.transaction('searchDocs', 'readwrite');
        const store = tx.objectStore('searchDocs');

        return new Promise((resolve, reject) => {
            const request = store.delete(id);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }

    async updateSearchDocMeta(chatId, updates = {}) {
        if (chatId == null) return false;
        const db = await this.getDB();
        const tx = db.transaction('searchDocs', 'readwrite');
        const store = tx.objectStore('searchDocs');

        return new Promise((resolve, reject) => {
            const getReq = store.get(chatId);
            getReq.onsuccess = () => {
                const doc = getReq.result;
                if (!doc) {
                    resolve(false);
                    return;
                }
                const next = { ...doc };
                if (Object.prototype.hasOwnProperty.call(updates, 'title') && updates.title !== undefined) {
                    next.title = updates.title;
                }
                if (Object.prototype.hasOwnProperty.call(updates, 'timestamp') && updates.timestamp !== undefined) {
                    next.timestamp = updates.timestamp;
                }
                if (Object.prototype.hasOwnProperty.call(updates, 'content') && updates.content !== undefined) {
                    next.content = updates.content;
                }
                ChatStorage.applySearchDocFields(next);
                const putReq = store.put(next);
                putReq.onsuccess = () => resolve(true);
                putReq.onerror = () => reject(putReq.error);
            };
            getReq.onerror = () => reject(getReq.error);
        });
    }

    async refreshSearchDoc(chatId) {
        try {
            const chatData = await this.loadChat(chatId);
            if (!chatData) return;
            const searchDoc = ChatStorage.buildSearchDocument({
                chatId,
                title: chatData.title,
                timestamp: chatData.timestamp,
                messages: chatData.messages
            });
            await this.putSearchDoc(searchDoc);
        } catch (error) {
            console.warn('Failed to refresh search doc:', error);
        }
    }

    static normaliseForSearch(input, { collapseWhitespace = true } = {}) {
        if (!input) return '';

        const normalized = `${input}`
            .toLowerCase()
            .normalize('NFKD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/[\u0000-\u001f]+/g, ' ');

        if (!collapseWhitespace) {
            return normalized.trim();
        }

        return normalized.replace(/\s+/g, ' ').trim();
    }

    static applySearchDocFields(doc) {
        if (!doc) return doc;
        
        // Skip re-normalization if already normalized
        if (doc._normalized === true) {
            return doc;
        }
        
        if ('searchTitleCompact' in doc) delete doc.searchTitleCompact;
        if ('searchContentCompact' in doc) delete doc.searchContentCompact;
        doc.searchTitle = ChatStorage.normaliseForSearch(doc.title || '');
        doc.content = ChatStorage.normaliseForSearch(doc.content || '');
        doc._normalized = true;
        return doc;
    }

    static buildSearchDocument({ chatId, title, timestamp, messages }) {
        const doc = {
            id: chatId,
            title: title ?? '',
            timestamp: timestamp ?? null,
            content: ChatStorage.extractTextFromMessages(messages)
        };
        return ChatStorage.applySearchDocFields(doc);
    }

    static extractTextFromMessages(messages) {
        if (!Array.isArray(messages) || messages.length === 0) return '';
        return messages
            .map(ChatStorage.extractTextFromMessage)
            .filter(Boolean)
            .join(' ')
            .trim();
    }

    static extractTextFromMessage(msg) {
        if (!msg) return '';

        if (Array.isArray(msg.contents)) {
            return msg.contents
                .flat()
                .filter(part => part && (part.type === 'text' || part.type === 'thought'))
                .map(part => part.content || '')
                .join(' ');
        }

        if (msg.responses) {
            return ['model_a', 'model_b']
                .map(modelKey => msg.responses[modelKey]?.messages || [])
                .flat()
                .flat()
                .filter(part => part && part.type === 'text')
                .map(part => part.content || '')
                .join(' ');
        }

        return '';
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
