import { base64NeedsRepair, sanitizeBase64Image } from './image_utils.js';

export class ChatStorage {
    constructor() {
        this.dbName = 'llm-chats';
        this.dbVersion = 5;  // Blob storage for images
        this.dbPromise = null;
        this.migrationRun = false;
    }

    // ==================== BLOB STORAGE ====================

    static isDataUrl(str) {
        return typeof str === 'string' && str.startsWith('data:');
    }

    static extractBase64Payload(dataUrl) {
        if (typeof dataUrl !== 'string') return '';
        const marker = 'base64,';
        const index = dataUrl.indexOf(marker);
        return index === -1 ? '' : dataUrl.slice(index + marker.length);
    }

    static async computeHash(dataUrl) {
        const encoder = new TextEncoder();
        const data = encoder.encode(dataUrl);
        const hashBuffer = await crypto.subtle.digest('SHA-256', data);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    }

    async getBlobStore(blobStore = null, mode = 'readwrite') {
        if (blobStore) {
            return { store: blobStore, done: Promise.resolve() };
        }

        const db = await this.getDB();
        const tx = db.transaction('blobs', mode);
        return {
            store: tx.objectStore('blobs'),
            done: new Promise((resolve) => {
                tx.oncomplete = () => resolve();
                tx.onerror = () => resolve();
                tx.onabort = () => resolve();
            })
        };
    }

    async storeBlob(blobStore, hash, data, chatId) {
        const { store, done } = await this.getBlobStore(blobStore);
        const getReq = store.get(hash);
        getReq.onsuccess = () => {
            const existing = getReq.result;
            if (existing) {
                if (!existing.chatIds.includes(chatId)) {
                    existing.chatIds.push(chatId);
                    store.put(existing);
                }
            } else {
                store.put({ hash, data, chatIds: [chatId] });
            }
        };
        return done;
    }

    async addBlobRef(blobStore, hash, chatId) {
        const { store, done } = await this.getBlobStore(blobStore);
        const getReq = store.get(hash);
        getReq.onsuccess = () => {
            const blob = getReq.result;
            if (blob && !blob.chatIds.includes(chatId)) {
                blob.chatIds.push(chatId);
                store.put(blob);
            }
        };
        return done;
    }

    async removeBlobRef(blobStore, hash, chatId) {
        const { store, done } = await this.getBlobStore(blobStore);
        const getReq = store.get(hash);
        getReq.onsuccess = () => {
            const blob = getReq.result;
            if (blob) {
                blob.chatIds = blob.chatIds.filter(id => id !== chatId);
                if (blob.chatIds.length === 0) {
                    store.delete(hash);
                } else {
                    store.put(blob);
                }
            }
        };
        return done;
    }

    async getBlobs(hashes) {
        const list = Array.isArray(hashes) ? hashes : [hashes];
        if (!list.length) return new Map();

        const db = await this.getDB();
        const tx = db.transaction('blobs', 'readonly');
        const store = tx.objectStore('blobs');
        const results = new Map();

        await Promise.all(list.map(hash => new Promise((resolve) => {
            const req = store.get(hash);
            req.onsuccess = () => {
                results.set(hash, req.result?.data ?? null);
                resolve();
            };
            req.onerror = () => {
                results.set(hash, null);
                resolve();
            };
        })));

        return results;
    }

    async getBlob(hash) {
        const map = await this.getBlobs(hash);
        return map.get(hash) ?? null;
    }

    async getBlobsBatch(hashes) {
        return this.getBlobs(hashes);
    }

    async overwriteBlobData(hash, dataUrl) {
        const db = await this.getDB();
        const tx = db.transaction('blobs', 'readwrite');
        const store = tx.objectStore('blobs');

        return new Promise((resolve) => {
            const req = store.get(hash);
            req.onsuccess = () => {
                const existing = req.result;
                if (existing) {
                    store.put({ ...existing, data: dataUrl });
                } else {
                    store.put({ hash, data: dataUrl, chatIds: [] });
                }
                resolve();
            };
            req.onerror = () => resolve();
        });
    }

    async repairBlobByDataUrl(dataUrl) {
        if (!ChatStorage.isDataUrl(dataUrl) || !dataUrl.startsWith('data:image/')) {
            return { repaired: false, dataUrl: null };
        }

        const mimeType = this.extractMimeFromDataUrl(dataUrl) || 'image/png';
        const base64 = ChatStorage.extractBase64Payload(dataUrl);
        const hash = await ChatStorage.computeHash(dataUrl);

        if (!base64NeedsRepair(base64, mimeType)) {
            return { repaired: false, dataUrl: null };
        }

        const sanitized = sanitizeBase64Image(base64, mimeType);
        if (!sanitized || sanitized === base64) {
            return { repaired: false, dataUrl: null };
        }

        const cleanedDataUrl = `data:${mimeType};base64,${sanitized}`;
        await this.overwriteBlobData(hash, cleanedDataUrl);
        return { repaired: true, dataUrl: cleanedDataUrl };
    }

    async repairAllBlobs() {
        try {
            const db = await this.getDB();
            if (!db.objectStoreNames.contains('blobs')) return 0;

            const tx = db.transaction('blobs', 'readwrite');
            const store = tx.objectStore('blobs');
            let repaired = 0;

            await new Promise((resolve) => {
                const cursor = store.openCursor();
                cursor.onsuccess = (e) => {
                    const c = e.target.result;
                    if (!c) {
                        resolve();
                        return;
                    }
                    const blob = c.value;
                    if (!ChatStorage.isDataUrl(blob.data)) {
                        c.continue();
                        return;
                    }
                    const mimeType = this.extractMimeFromDataUrl(blob.data) || 'image/png';
                    const base64 = ChatStorage.extractBase64Payload(blob.data);
                    if (!base64NeedsRepair(base64, mimeType)) {
                        c.continue();
                        return;
                    }
                    const sanitized = sanitizeBase64Image(base64, mimeType);
                    if (sanitized && sanitized !== base64) {
                        const cleanedDataUrl = `data:${mimeType};base64,${sanitized}`;
                        c.update({ ...blob, data: cleanedDataUrl });
                        repaired++;
                    }
                    c.continue();
                };
                cursor.onerror = () => resolve();
            });

            return repaired;
        } catch (error) {
            console.warn('Failed to repair blobs:', error);
            return 0;
        }
    }

    async prepareMessageForStorage(message, chatId, blobStore) {
        const prepared = { ...message };
        const hashCache = new Map();
        const toHash = async (dataUrl) => {
            if (!ChatStorage.isDataUrl(dataUrl)) return { ref: dataUrl, hashed: false };
            if (hashCache.has(dataUrl)) return hashCache.get(dataUrl);
            const hash = await ChatStorage.computeHash(dataUrl);
            await this.storeBlob(blobStore, hash, dataUrl, chatId);
            const entry = { ref: hash, hashed: true };
            hashCache.set(dataUrl, entry);
            return entry;
        };

        if (prepared.images?.length) {
            prepared.images = await Promise.all(prepared.images.map(async (img) => {
                const { ref } = await toHash(img);
                return ref;
            }));
        }

        if (prepared.contents?.length) {
            prepared.contents = await Promise.all(prepared.contents.map(async (group) => {
                if (!Array.isArray(group)) return group;
                return Promise.all(group.map(async (part) => {
                    if (part?.type === 'image') {
                        const { ref, hashed } = await toHash(part.content);
                        return hashed ? { ...part, content: ref } : part;
                    }
                    return part;
                }));
            }));
        }

        if (prepared.responses) {
            prepared.responses = { ...prepared.responses };
            for (const modelKey of ['model_a', 'model_b']) {
                const modelResp = prepared.responses[modelKey];
                if (!modelResp?.messages) continue;
                prepared.responses[modelKey] = {
                    ...modelResp,
                    messages: await Promise.all(modelResp.messages.map(async (group) => {
                        if (!Array.isArray(group)) return group;
                        return Promise.all(group.map(async (part) => {
                            if (part?.type === 'image') {
                                const { ref, hashed } = await toHash(part.content);
                                return hashed ? { ...part, content: ref } : part;
                            }
                            return part;
                        }));
                    }))
                };
            }
        }

        return prepared;
    }

    // Core resolution logic - lookup can be a Map or plain object
    resolveMessageImagesWithLookup(message, lookup) {
        if (!message || !lookup) return message;

        const get = (hash) => lookup instanceof Map ? lookup.get(hash) : lookup[hash];
        const resolved = { ...message };

        if (resolved.images?.length) {
            resolved.images = resolved.images.map(ref => 
                ChatStorage.isDataUrl(ref) ? ref : (get(ref) ?? ref)
            );
        }

        if (resolved.contents?.length) {
            resolved.contents = resolved.contents.map(group => {
                if (!Array.isArray(group)) return group;
                return group.map(part => {
                    if (part?.type === 'image' && !ChatStorage.isDataUrl(part.content)) {
                        return { ...part, content: get(part.content) ?? part.content };
                    }
                    return part;
                });
            });
        }

        if (resolved.responses) {
            resolved.responses = { ...resolved.responses };
            for (const modelKey of ['model_a', 'model_b']) {
                const modelResp = resolved.responses[modelKey];
                if (!modelResp?.messages) continue;
                resolved.responses[modelKey] = {
                    ...modelResp,
                    messages: modelResp.messages.map(group => {
                        if (!Array.isArray(group)) return group;
                        return group.map(part => {
                            if (part?.type === 'image' && !ChatStorage.isDataUrl(part.content)) {
                                return { ...part, content: get(part.content) ?? part.content };
                            }
                            return part;
                        });
                    })
                };
            }
        }

        return resolved;
    }

    // Async version for normal reads (fetches from DB)
    async resolveMessageImages(message) {
        if (!message) return message;
        const hashes = [...new Set(this.extractImageHashes(message))];
        if (!hashes.length) return message;
        const blobData = await this.getBlobs(hashes);
        return this.resolveMessageImagesWithLookup(message, blobData);
    }

    extractImageHashes(message) {
        const hashes = [];
        if (!message) return hashes;

        if (message.images?.length) {
            for (const ref of message.images) {
                if (!ChatStorage.isDataUrl(ref)) hashes.push(ref);
            }
        }

        if (message.contents?.length) {
            for (const group of message.contents) {
                if (!Array.isArray(group)) continue;
                for (const part of group) {
                    if (part?.type === 'image' && !ChatStorage.isDataUrl(part.content)) {
                        hashes.push(part.content);
                    }
                }
            }
        }

        if (message.responses) {
            for (const modelKey of ['model_a', 'model_b']) {
                const modelResp = message.responses[modelKey];
                if (!modelResp?.messages) continue;
                for (const group of modelResp.messages) {
                    if (!Array.isArray(group)) continue;
                    for (const part of group) {
                        if (part?.type === 'image' && !ChatStorage.isDataUrl(part.content)) {
                            hashes.push(part.content);
                        }
                    }
                }
            }
        }

        return hashes;
    }

    async cleanupOrphanedBlobs() {
        const db = await this.getDB();
        if (!db.objectStoreNames.contains('blobs')) return { cleaned: 0 };

        const tx = db.transaction(['blobs', 'chatMeta'], 'readwrite');
        const blobStore = tx.objectStore('blobs');
        const metaStore = tx.objectStore('chatMeta');

        const existingChatIds = new Set();
        await new Promise((resolve) => {
            const req = metaStore.getAllKeys();
            req.onsuccess = () => {
                (req.result || []).forEach(id => existingChatIds.add(id));
                resolve();
            };
            req.onerror = () => resolve();
        });

        let cleaned = 0;
        await new Promise((resolve) => {
            const cursor = blobStore.openCursor();
            cursor.onsuccess = (e) => {
                const c = e.target.result;
                if (!c) {
                    resolve();
                    return;
                }
                const blob = c.value;
                const validIds = blob.chatIds.filter(id => existingChatIds.has(id));
                if (validIds.length === 0) {
                    c.delete();
                    cleaned++;
                } else if (validIds.length !== blob.chatIds.length) {
                    blob.chatIds = validIds;
                    c.update(blob);
                }
                c.continue();
            };
            cursor.onerror = () => resolve();
        });

        return { cleaned };
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
                        this.migrationRun = false;
                    };

                    db.onversionchange = () => {
                        db.close();
                    };

                    resolve(db);

                    // Run pending migration in background (non-blocking)
                    if (!this.migrationRun) {
                        this.migrationRun = true;
                        this.runPendingMigration().catch(err => {
                            console.warn('Background migration failed:', err);
                        });
                    }
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

        // Version 5: Content-addressed blob storage for images
        if (oldVersion < 5) {
            if (!db.objectStoreNames.contains('blobs')) {
                db.createObjectStore('blobs', { keyPath: 'hash' });
            }
            // Migration runs after DB opens via runPendingMigration()
        }
    }

    async runPendingMigration() {
        const db = await this.getDB();
        if (!db.objectStoreNames.contains('blobs')) return;

        // Check if any messages still have inline data URLs (need migration)
        const needsMigration = await new Promise((resolve) => {
            const tx = db.transaction('messages', 'readonly');
            const store = tx.objectStore('messages');
            const cursor = store.openCursor();
            cursor.onsuccess = (e) => {
                const c = e.target.result;
                if (!c) {
                    resolve(false);
                    return;
                }
                const msg = c.value;
                if (this.messageHasInlineImages(msg)) {
                    resolve(true);
                    return;
                }
                c.continue();
            };
            cursor.onerror = () => resolve(false);
        });

        if (!needsMigration) return;

        console.log('Migrating images to blob storage...');

        // Process in batches to avoid memory issues
        const batchSize = 50;
        let processed = 0;

        while (true) {
            // Get a batch of messages with inline images (readonly tx to keep it short-lived)
            const batch = await new Promise((resolve) => {
                const msgs = [];
                const tx = db.transaction('messages', 'readonly');
                const store = tx.objectStore('messages');
                const cursor = store.openCursor();
                cursor.onsuccess = (e) => {
                    const c = e.target.result;
                    if (!c || msgs.length >= batchSize) {
                        resolve(msgs);
                        return;
                    }
                    if (this.messageHasInlineImages(c.value)) {
                        msgs.push(c.value);
                    }
                    c.continue();
                };
                cursor.onerror = () => resolve([]);
            });

            if (batch.length === 0) break;

            const preparedBatch = [];
            for (const msg of batch) {
                preparedBatch.push(await this.prepareMessageForStorage(msg, msg.chatId));
            }

            const writeTx = db.transaction('messages', 'readwrite');
            const messageStore = writeTx.objectStore('messages');
            preparedBatch.forEach((prepared) => {
                messageStore.put(prepared);
                processed++;
            });
            await new Promise((resolve) => {
                writeTx.oncomplete = () => resolve();
                writeTx.onerror = () => resolve();
                writeTx.onabort = () => resolve();
            });
        }

        console.log(`Blob migration complete. Processed ${processed} messages.`);
    }

    messageHasInlineImages(msg) {
        if (msg.images?.some(img => ChatStorage.isDataUrl(img))) return true;
        if (msg.contents?.some(group => 
            Array.isArray(group) && group.some(p => p?.type === 'image' && ChatStorage.isDataUrl(p.content))
        )) return true;
        if (msg.responses) {
            for (const key of ['model_a', 'model_b']) {
                if (msg.responses[key]?.messages?.some(group =>
                    Array.isArray(group) && group.some(p => p?.type === 'image' && ChatStorage.isDataUrl(p.content))
                )) return true;
            }
        }
        return false;
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
        const chatMeta = {
            title,
            timestamp: Date.now(),
            renamed: bonus_options.renamed || false,
            continued_from_chat_id: bonus_options.continued_from_chat_id || null
        };

        const chatId = await new Promise((resolve, reject) => {
            const tx = db.transaction('chatMeta', 'readwrite');
            const metaStore = tx.objectStore('chatMeta');
            const metaRequest = metaStore.add(chatMeta);
            metaRequest.onsuccess = () => resolve(metaRequest.result);
            metaRequest.onerror = () => reject(metaRequest.error);
        });

        const preparedMessages = await Promise.all(
            messages.map(msg => this.prepareMessageForStorage(msg, chatId))
        );

        const messagesTx = db.transaction('messages', 'readwrite');
        const messageStore = messagesTx.objectStore('messages');
        const messagePromises = preparedMessages.map((message, index) => new Promise((res, rej) => {
            const req = messageStore.add({
                chatId,
                messageId: index,
                timestamp: Date.now(),
                ...message
            });
            req.onsuccess = () => res();
            req.onerror = () => rej(req.error);
        }));

        await Promise.all(messagePromises);
        await new Promise((resolve, reject) => {
            messagesTx.oncomplete = () => resolve();
            messagesTx.onerror = () => reject(messagesTx.error);
            messagesTx.onabort = () => reject(messagesTx.error);
        });

        const mediaTx = db.transaction('mediaIndex', 'readwrite');
        const mediaStore = mediaTx.objectStore('mediaIndex');
        const mediaPromises = this.indexImagesFromMessages(chatId, messages, mediaStore);
        if (mediaPromises.length) {
            await Promise.all(mediaPromises);
        }
        await new Promise((resolve) => {
            mediaTx.oncomplete = () => resolve();
            mediaTx.onerror = () => resolve();
            mediaTx.onabort = () => resolve();
        });

        const searchDoc = ChatStorage.buildSearchDocument({
            chatId,
            title: chatMeta.title,
            timestamp: chatMeta.timestamp,
            messages
        });
        await new Promise((res, rej) => {
            const tx = db.transaction('searchDocs', 'readwrite');
            const searchDocsStore = tx.objectStore('searchDocs');
            const putReq = searchDocsStore.put(searchDoc);
            putReq.onsuccess = () => res();
            putReq.onerror = () => rej(putReq.error);
        });

        chrome.runtime.sendMessage({
            type: 'new_chat_saved',
            chat: { chatId, ...chatMeta },
            searchDoc
        });

        return { chatId, ...chatMeta };
    }

    async addMessages(chatId, messages, startMessageIdIncrementAt) {
        const db = await this.getDB();
        const timestamp = Date.now();

        const preparedMessages = await Promise.all(
            messages.map(msg => this.prepareMessageForStorage(msg, chatId))
        );

        const tx = db.transaction('messages', 'readwrite');
        const store = tx.objectStore('messages');

        const results = await Promise.all(preparedMessages.map((message, index) =>
            new Promise((res, rej) => {
                const request = store.add({
                    chatId,
                    messageId: startMessageIdIncrementAt + index,
                    timestamp,
                    ...message
                });
                request.onsuccess = () => res(request.result);
                request.onerror = () => rej(request.error);
            })
        ));

        await new Promise((resolve, reject) => {
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error);
        });

        const mediaTx = db.transaction('mediaIndex', 'readwrite');
        const mediaStore = mediaTx.objectStore('mediaIndex');
        const mediaPromises = this.indexImagesFromMessages(chatId, messages, mediaStore, startMessageIdIncrementAt);
        if (mediaPromises.length) {
            await Promise.all(mediaPromises);
        }
        await new Promise((resolve) => {
            mediaTx.oncomplete = () => resolve();
            mediaTx.onerror = () => resolve();
            mediaTx.onabort = () => resolve();
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

        const prepared = await this.prepareMessageForStorage(message, chatId);

        const tx = db.transaction('messages', 'readwrite');
        const store = tx.objectStore('messages');

        const result = await new Promise((resolve, reject) => {
            const request = store.put({
                chatId,
                messageId: messageId,
                timestamp,
                ...prepared
            });
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });

        await new Promise((resolve, reject) => {
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error);
        });

        await this.replaceMediaEntriesForMessage(null, chatId, messageId, message).catch(() => {});

        await this.updateChatOption(chatId, { timestamp });
        await this.refreshSearchDoc(chatId);

        chrome.runtime.sendMessage({
            type: 'message_updated',
            chatId: chatId,
            messageId: messageId
        });

        return result;
    }

    // Helper to replace media entries for a message (delete old, add new)
    async replaceMediaEntriesForMessage(mediaStore, chatId, messageId, message) {
        let tx = null;
        if (!mediaStore) {
            const db = await this.getDB();
            tx = db.transaction('mediaIndex', 'readwrite');
            mediaStore = tx.objectStore('mediaIndex');
        }

        // Find all existing media entries for this message
        const entriesToDelete = await new Promise((resolve) => {
            const entries = [];
            const cursor = mediaStore.index('chatId').openCursor(IDBKeyRange.only(chatId));
            
            cursor.onsuccess = (e) => {
                const result = e.target.result;
                if (result) {
                    if (result.value.messageId === messageId) {
                        entries.push(result.primaryKey);
                    }
                    result.continue();
                } else {
                    resolve(entries);
                }
            };
            cursor.onerror = () => resolve([]); // Continue even if cursor fails
        });

        // Delete old entries
        await Promise.all(entriesToDelete.map(key =>
            new Promise(resolve => {
                const req = mediaStore.delete(key);
                req.onsuccess = () => resolve();
                req.onerror = () => resolve();
            })
        ));

        // Add new entries
        const mediaPromises = this.indexImagesFromMessages(chatId, [message], mediaStore, messageId);
        if (mediaPromises.length) {
            await Promise.all(mediaPromises);
        }

        if (tx) {
            await new Promise((resolve) => {
                tx.oncomplete = () => resolve();
                tx.onerror = () => resolve();
                tx.onabort = () => resolve();
            });
        }
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

    async getMessage(chatId, messageId, { resolveImages = true } = {}) {
        const db = await this.getDB();
        const tx = db.transaction(['messages'], 'readonly');
        const store = tx.objectStore('messages');

        const msg = await new Promise((resolve, reject) => {
            const request = store.get([chatId, messageId]);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });

        if (msg && resolveImages) {
            return this.resolveMessageImages(msg);
        }
        return msg;
    }

    async getMessagesBatch(keys, { resolveImages = true } = {}) {
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

            const rawResults = await new Promise((resolve, reject) => {
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

            if (resolveImages) {
                const resolved = new Map();
                for (const [key, msg] of rawResults) {
                    resolved.set(key, msg ? await this.resolveMessageImages(msg) : null);
                }
                return resolved;
            }
            return rawResults;
        } catch (error) {
            console.error('Error in getMessagesBatch:', error);
            return new Map();
        }
    }

    async getMessages(chatId, startIndex = 0, limit, { resolveImages = true } = {}) {
        const db = await this.getDB();
        const tx = db.transaction(['messages'], 'readonly');
        const messageStore = tx.objectStore('messages');

        const hasFiniteLimit = Number.isInteger(limit) && limit > 0;
        const hasValidStart = Number.isInteger(startIndex) && startIndex >= 0;

        let messages;
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
            messages = results.filter(Boolean);
        } else {
            messages = await new Promise((resolve) => {
                const msgs = [];
            let collected = 0;
            const index = messageStore.index('chatId');
            const cursorRequest = index.openCursor(IDBKeyRange.only(chatId), 'next');

            cursorRequest.onsuccess = (event) => {
                const cursor = event.target.result;
                if (!cursor) {
                        resolve(msgs);
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

                    msgs.push(cursor.value);
                collected++;
                if (hasFiniteLimit && collected >= limit) {
                        resolve(msgs);
                    return;
                }
                cursor.continue();
            };

            cursorRequest.onerror = () => resolve([]);
        });
        }

        if (resolveImages && messages.length) {
            return Promise.all(messages.map(m => this.resolveMessageImages(m)));
        }
        return messages;
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

    async loadChat(chatId, messageLimit = null, { resolveImages = true } = {}) {
        const db = await this.getDB();
        const tx = db.transaction(['messages', 'chatMeta'], 'readonly');
        const messageStore = tx.objectStore('messages');
        const metaStore = tx.objectStore('chatMeta');

        const result = await new Promise((resolve) => {
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

        if (resolveImages && result.messages?.length) {
            result.messages = await Promise.all(result.messages.map(m => this.resolveMessageImages(m)));
        }
        return result;
    }

    async getLatestMessages(chatId, limit, { resolveImages = true } = {}) {
        const db = await this.getDB();
        const tx = db.transaction(['messages'], 'readonly');
        const messageStore = tx.objectStore('messages');

        const messages = await new Promise((resolve) => {
            const msgs = [];
            let count = 0;

            const index = messageStore.index('chatId');
            const cursorRequest = index.openCursor(IDBKeyRange.only(chatId), 'prev');

            cursorRequest.onsuccess = (event) => {
                const cursor = event.target.result;

                if (!cursor || count >= limit) {
                    resolve(msgs.reverse());
                    return;
                }

                msgs.push(cursor.value);
                count++;
                cursor.continue();
            };

            cursorRequest.onerror = () => {
                resolve([]);
            };
        });

        if (resolveImages && messages.length) {
            return Promise.all(messages.map(m => this.resolveMessageImages(m)));
        }
        return messages;
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

        // Collect hashes AND delete messages in one pass
        const imageHashes = new Set();
        await new Promise((resolve) => {
            const tx = db.transaction('messages', 'readwrite');
            const messageStore = tx.objectStore('messages');
            const messageIndex = messageStore.index('chatId');
            const request = messageIndex.openCursor(IDBKeyRange.only(chatId));
            request.onsuccess = (event) => {
                const cursor = event.target.result;
                if (cursor) {
                    this.extractImageHashes(cursor.value).forEach(h => imageHashes.add(h));
                    cursor.delete();
                    cursor.continue();
                } else {
                    resolve();
                }
            };
            request.onerror = () => resolve();
            tx.onabort = () => resolve();
        });

        // Delete media entries, metadata, search doc in parallel (separate transactions to avoid long-lived tx)
        await Promise.all([
            new Promise((resolve) => {
                const tx = db.transaction('mediaIndex', 'readwrite');
                const mediaStore = tx.objectStore('mediaIndex');
                const mediaIndex = mediaStore.index('chatId');
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
                request.onerror = () => resolve();
                tx.onabort = () => resolve();
            }),
            new Promise((resolve) => {
                const tx = db.transaction('chatMeta', 'readwrite');
                const metaStore = tx.objectStore('chatMeta');
                const req = metaStore.delete(chatId);
                req.onsuccess = () => resolve();
                req.onerror = () => resolve();
                tx.onabort = () => resolve();
            }),
            new Promise((resolve) => {
                const tx = db.transaction('searchDocs', 'readwrite');
                const searchDocsStore = tx.objectStore('searchDocs');
                const req = searchDocsStore.delete(chatId);
                req.onsuccess = () => resolve();
                req.onerror = () => resolve();
                tx.onabort = () => resolve();
            })
        ]);

        // Remove chatId from blob references, delete orphaned blobs
        await Promise.all([...imageHashes].map(hash => this.removeBlobRef(null, hash, chatId)));
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
                        renamed: chatMeta.renamed || false,
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
        const stores = ['chatMeta', 'messages'];
        if (db.objectStoreNames.contains('blobs')) stores.push('blobs');
        const tx = db.transaction(stores, 'readonly');
        const metaStore = tx.objectStore('chatMeta');
        const messageStore = tx.objectStore('messages');
        const blobStore = stores.includes('blobs') ? tx.objectStore('blobs') : null;
    
        const archive = {
            exportedAt: new Date().toISOString(),
            schemaVersion: this.dbVersion,
            blobs: {},
            chats: {}
        };
    
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
                        resolve();
                    }
                };
            });
        };

        // Collect all used hashes
        const usedHashes = new Set();
    
        // 1. Fetch all chat metadata
        await iterateCursor(metaStore, null, null, (chatMeta) => {
            archive.chats[chatMeta.chatId] = {
                ...chatMeta,
                messages: []
            };
        });
    
        // 2. Fetch messages for each chat, collect hashes
        for (const chatId in archive.chats) {
            await iterateCursor(messageStore, 'chatId', IDBKeyRange.only(parseInt(chatId, 10)), (message) => {
                archive.chats[chatId].messages.push(message);
                this.extractImageHashes(message).forEach(h => usedHashes.add(h));
            });
        }

        // 3. Export only used blobs
        if (blobStore && usedHashes.size > 0) {
            await iterateCursor(blobStore, null, null, (blob) => {
                if (usedHashes.has(blob.hash)) {
                    archive.blobs[blob.hash] = blob.data;
                }
            });
        }
    
        return JSON.stringify(archive, null, options.pretty ? 2 : 0);
    }

    async importChats(archiveJson) {
        try {
            const archive = JSON.parse(archiveJson);
            if (!archive?.chats) throw new Error("Invalid archive format");
    
            const db = await this.getDB();
            const needsV3Migration = archive.schemaVersion < 3;
            const hasBlobs = archive.blobs && Object.keys(archive.blobs).length > 0;
            const needsBlobConversion = archive.schemaVersion < 5 && !hasBlobs;
            
            const existingChats = await this.getChatMetadata(Infinity);
            const existingIdsByFingerprint = new Map(
                existingChats.map(c => [`${c.title}::${c.timestamp}`, c.chatId])
            );

            const idRemap = new Map();
            const chatQueue = [];

            Object.values(archive.chats).forEach(rawChat => {
                const chat = needsV3Migration ? this.migrateImportedChat(rawChat) : rawChat;
                const fingerprint = `${chat.title}::${chat.timestamp}`;
                const existingId = existingIdsByFingerprint.get(fingerprint);

                if (existingId !== undefined) {
                    if (chat.chatId !== undefined && chat.chatId !== null) {
                        idRemap.set(chat.chatId, existingId);
                    }
                    return;
                }

                chatQueue.push(chat);
            });

            const tx = db.transaction(['chatMeta', 'messages', 'mediaIndex', 'blobs'], 'readwrite');
            const metaStore = tx.objectStore('chatMeta');
            const messageStore = tx.objectStore('messages');
            const mediaStore = tx.objectStore('mediaIndex');
            const blobStore = tx.objectStore('blobs');

            // Import blobs from archive first (if present)
            if (hasBlobs) {
                for (const [hash, data] of Object.entries(archive.blobs)) {
                    await new Promise((resolve) => {
                        const getReq = blobStore.get(hash);
                        getReq.onsuccess = () => {
                            if (!getReq.result) {
                                blobStore.put({ hash, data, chatIds: [] });
                            }
                            resolve();
                        };
                        getReq.onerror = () => resolve();
                    });
                }
            }

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

                    // Process messages - convert inline images to hashes if needed
                    for (const msg of messages) {
                        let prepared;
                        if (needsBlobConversion) {
                            prepared = await this.prepareMessageForStorage(msg, newChatId, blobStore);
                        } else if (hasBlobs) {
                            // Update blob refs with new chatId
                            const hashes = this.extractImageHashes(msg);
                            for (const hash of hashes) {
                                await this.addBlobRef(blobStore, hash, newChatId);
                            }
                            prepared = msg;
                        } else {
                            prepared = msg;
                        }
                        
                        await new Promise((resolve) => {
                            messageStore.add({ ...prepared, chatId: newChatId }).onsuccess = resolve;
                        });
                    }

                    // Resolve images for media indexing - use archive blobs directly to avoid new transaction
                    const blobLookup = hasBlobs ? archive.blobs : null;
                    const resolvedMessages = messages.map(m => 
                        this.resolveMessageImagesWithLookup({ ...m, chatId: newChatId }, blobLookup)
                    );
                    const mediaPromises = this.indexImagesFromMessages(newChatId, resolvedMessages, mediaStore);
                    await Promise.all(mediaPromises);

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
        // Explicitly specify UTF-8 encoding to ensure consistency across platforms
        const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
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
                    const record = {
                        chatId,
                        messageId,
                        imageIndex: imgIndex,
                        source: 'user',
                        timestamp: baseTimestamp
                    };
                    promises.push(this.storeMediaEntry(mediaStore, record, this.getImageDataForThumbnail(message, {
                        source: 'user',
                        imageIndex: imgIndex
                    })));
                });
            }

            if (message.role === 'assistant' && message.contents && Array.isArray(message.contents)) {
                message.contents.forEach((contentGroup, contentIndex) => {
                    if (!contentGroup || !Array.isArray(contentGroup)) return;
                    contentGroup.forEach((part, partIndex) => {
                        if (!part || part.type !== 'image') return;
                        const record = {
                            chatId,
                            messageId,
                            contentIndex,
                            partIndex,
                            source: 'assistant',
                            timestamp: baseTimestamp
                        };
                        promises.push(this.storeMediaEntry(mediaStore, record, this.getImageDataForThumbnail(message, {
                            source: 'assistant',
                            contentIndex,
                            partIndex
                        })));
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
                            const record = {
                                chatId,
                                messageId,
                                modelKey,
                                messageIndex: msgIndex,
                                partIndex,
                                source: 'assistant',
                                timestamp: baseTimestamp
                            };
                            promises.push(this.storeMediaEntry(mediaStore, record, this.getImageDataForThumbnail(message, {
                                source: 'assistant',
                                modelKey,
                                messageIndex: msgIndex,
                                partIndex
                            })));
                        });
                    });
                });
            }
        });

        return promises;
    }

    getImageDataForThumbnail(message, descriptor) {
        if (!message || !descriptor) return null;

        if (descriptor.source === 'user') {
            return Array.isArray(message.images) ? message.images[descriptor.imageIndex] ?? null : null;
        }

        if (descriptor.source === 'assistant') {
            if (descriptor.contentIndex !== undefined) {
                const group = Array.isArray(message.contents) ? message.contents[descriptor.contentIndex] : null;
                const part = Array.isArray(group) ? group[descriptor.partIndex] : null;
                if (part?.type === 'image' && part.content) return part.content;
            }

            if (descriptor.modelKey) {
                const modelResponse = message.responses?.[descriptor.modelKey];
                const msgGroup = Array.isArray(modelResponse?.messages) ? modelResponse.messages[descriptor.messageIndex] : null;
                const part = Array.isArray(msgGroup) ? msgGroup[descriptor.partIndex] : null;
                if (part?.type === 'image' && part.content) return part.content;
            }
        }

        return null;
    }

    async storeMediaEntry(mediaStore, record, imageData) {
        const entry = { ...record };

        return new Promise((resolve) => {
            const req = mediaStore.add(entry);
            req.onsuccess = async () => {
                resolve();
                if (!imageData) return;
                const entryId = req.result;
                if (entryId == null) return;
                entry.id = entryId;
                try {
                    const thumbnail = await this.createThumbnail(imageData);
                    if (thumbnail?.dataUrl) {
                        entry.thumbnail = thumbnail.dataUrl;
                        entry.thumbnailWidth = thumbnail.width;
                        entry.thumbnailHeight = thumbnail.height;
                        entry.thumbnailFormat = thumbnail.format;
                        await this.updateMediaThumbnail(entryId, entry);
                    }
                } catch (error) {
                    console.warn('Failed to generate media thumbnail:', error);
                }
            };
            req.onerror = () => resolve();
        });
    }

    async createThumbnail(imageData, maxShortEdge = 512) {
        if (typeof document === 'undefined' || typeof Image === 'undefined') {
            return null;
        }

        if (typeof imageData !== 'string' || !imageData.startsWith('data:image/')) {
            return null;
        }

        return new Promise((resolve) => {
            const img = new Image();
            img.decoding = 'async';
            img.crossOrigin = 'anonymous';
            img.onload = () => {
                const width = img.naturalWidth || img.width;
                const height = img.naturalHeight || img.height;

                if (!width || !height) {
                    resolve(null);
                    return;
                }

                const shortestSide = Math.min(width, height);
                let scale = 1;

                if (shortestSide > maxShortEdge) {
                    scale = maxShortEdge / shortestSide;
                }

                const targetWidth = Math.max(1, Math.round(width * scale));
                const targetHeight = Math.max(1, Math.round(height * scale));

                if (scale === 1) {
                    resolve({
                        dataUrl: imageData,
                        width,
                        height,
                        format: this.extractMimeFromDataUrl(imageData)
                    });
                    return;
                }

                const canvas = document.createElement('canvas');
                canvas.width = targetWidth;
                canvas.height = targetHeight;
                const ctx = canvas.getContext('2d');
                if (!ctx) {
                    resolve(null);
                    return;
                }
                ctx.imageSmoothingQuality = 'medium';
                ctx.drawImage(img, 0, 0, targetWidth, targetHeight);

                let dataUrl;
                try {
                    dataUrl = canvas.toDataURL('image/webp', 0.82);
                } catch (error) {
                    try {
                        dataUrl = canvas.toDataURL('image/png');
                    } catch (_) {
                        dataUrl = null;
                    }
                }

                resolve(dataUrl ? {
                    dataUrl,
                    width: targetWidth,
                    height: targetHeight,
                    format: this.extractMimeFromDataUrl(dataUrl)
                } : null);
            };
            img.onerror = () => resolve(null);
            img.src = imageData;
        });
    }

    extractMimeFromDataUrl(dataUrl) {
        if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) return null;
        const mimeSection = dataUrl.slice(5, dataUrl.indexOf(';'));
        return mimeSection || null;
    }

    async updateMediaThumbnail(entryId, partialEntry) {
        if (!partialEntry?.thumbnail) return;
        try {
            const db = await this.getDB();
            const tx = db.transaction('mediaIndex', 'readwrite');
            const store = tx.objectStore('mediaIndex');

            const existing = await new Promise((resolve) => {
                const getReq = store.get(entryId);
                getReq.onsuccess = () => resolve(getReq.result ?? null);
                getReq.onerror = () => resolve(null);
            });

            if (!existing) return;
            existing.thumbnail = partialEntry.thumbnail;
            existing.thumbnailWidth = partialEntry.thumbnailWidth;
            existing.thumbnailHeight = partialEntry.thumbnailHeight;
            existing.thumbnailFormat = partialEntry.thumbnailFormat;

            await new Promise((resolve) => {
                const putReq = store.put(existing);
                putReq.onsuccess = () => resolve();
                putReq.onerror = () => resolve();
            });
        } catch (error) {
            console.warn('Failed to persist media thumbnail:', error);
        }
    }

    async ensureMediaThumbnails(entries, { maxShortEdge = 512 } = {}) {
        if (!Array.isArray(entries) || entries.length === 0) {
            return false;
        }

        const pending = entries.filter(entry => entry && entry.id != null && !entry.thumbnail);
        if (pending.length === 0) {
            return false;
        }

        const updated = [];

        for (const entry of pending) {
            try {
                const imageData = await this.getImageFromMediaEntry(entry);
                if (!imageData) continue;
                const thumbnail = await this.createThumbnail(imageData, maxShortEdge);
                if (!thumbnail?.dataUrl) continue;

                entry.thumbnail = thumbnail.dataUrl;
                entry.thumbnailWidth = thumbnail.width;
                entry.thumbnailHeight = thumbnail.height;
                entry.thumbnailFormat = thumbnail.format;
                updated.push(entry);
            } catch (error) {
                console.warn('Failed to backfill media thumbnail:', error);
            }
        }

        if (updated.length === 0) {
            return false;
        }

        try {
            const db = await this.getDB();
            const tx = db.transaction('mediaIndex', 'readwrite');
            const store = tx.objectStore('mediaIndex');

            await Promise.all(updated.map(entry => new Promise((resolve) => {
                const req = store.put(entry);
                req.onsuccess = () => resolve();
                req.onerror = () => resolve();
            })));

            await new Promise((resolve) => {
                tx.oncomplete = () => resolve();
                tx.onerror = () => resolve();
                tx.onabort = () => resolve();
            });
        } catch (error) {
            console.warn('Failed to persist thumbnail backfill batch:', error);
        }

        return true;
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
        if (entry?.thumbnail) {
            return entry.thumbnail;
        }

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
        chatId: autoincrement,
        timestamp: number,
        title: string,
        renamed: boolean,
        continued_from_chat_id: number | null
    },
    
    blob: {
        hash: string,           // SHA-256 hash of image data (also the key)
        data: string,           // Full data URL (data:image/...)
        chatIds: number[]       // Which chats reference this blob
    },
    
    // In storage: images are hashes. At runtime: resolved to full data URLs.
    regularMessage: {
        chatId: autoincrement,
        messageId: autoincrement,
        timestamp: number,
        role: 'user' | 'assistant' | 'system',
        contents: [ { type: 'text'|'thought'|'image', content: string, model?: string }[] ]  // 'image' content is hash in storage, data URL at runtime
        images?: string[]       // User images: hashes in storage, data URLs at runtime
        files?: {filename: string, content: string}[]
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
