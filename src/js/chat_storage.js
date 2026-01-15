import { base64NeedsRepair, sanitizeBase64Image } from './image_utils.js';
import { Migrations } from './migrations.js';

/**
 * Manages chat persistence using IndexedDB.
 * Handles messages, metadata, blobs (images), and search indexing.
 */
export class ChatStorage {
    constructor() {
        this.dbName = 'llm-chats';
        this.dbVersion = 5;
        this.dbPromise = null;
        this.migrationRun = false;
    }

    async getDB() {
        if (this.dbPromise) return this.dbPromise;

        return this.dbPromise = new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, this.dbVersion);

            request.onupgradeneeded = (event) => {
                Migrations.run(event.target.result, event.oldVersion, event.target.transaction);
            };

            request.onsuccess = () => {
                const db = request.result;
                resolve(db);

                if (!this.migrationRun) {
                    this.migrationRun = true;
                    this.runPendingMigration().catch(error => {
                        console.warn('Background migration failed:', error);
                    });
                }
            };
            request.onerror = () => reject(request.error);
        });
    }

    /**
     * Executes a transaction on the specified stores.
     */
    async dbOp(storeNames, mode, operation) {
        const db = await this.getDB();
        const transaction = db.transaction(storeNames, mode);
        let result;
        try {
            result = await operation(transaction);
        } catch (error) {
            transaction.abort();
            throw error;
        }

        return new Promise((resolve, reject) => {
            transaction.oncomplete = () => resolve(result);
            transaction.onerror = transaction.onabort = () => reject(transaction.error);
        });
    }

    /**
     * Wraps an IDBRequest in a promise.
     */
    req(request) {
        return new Promise((resolve, reject) => {
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    // ==================== MESSAGE PROCESSING ====================

    /**
     * Traverses message parts and applies a function to image content.
     */
    async mapImageParts(message, callback) {
        // 1. Top-level user images
        if (message.images) {
            message.images = await Promise.all(
                message.images.map(img => callback(img))
            );
        }

        const processGroup = async (group) => {
            if (!Array.isArray(group)) return group;
            return Promise.all(group.map(async (part) => {
                if (part?.type === 'image') {
                    return { ...part, content: await callback(part.content) };
                }
                return part;
            }));
        };

        // 2. Standard assistant/user contents
        if (message.contents) {
            message.contents = await Promise.all(message.contents.map(processGroup));
        }

        // 3. Arena responses
        if (message.responses) {
            for (const key of ['model_a', 'model_b']) {
                if (message.responses[key]?.messages) {
                    message.responses[key].messages = await Promise.all(
                        message.responses[key].messages.map(processGroup)
                    );
                }
            }
        }

        return message;
    }

    static isDataUrl(str) {
        return typeof str === 'string' && str.startsWith('data:');
    }

    static async computeHash(str) {
        const encoder = new TextEncoder();
        const data = encoder.encode(str);
        const hashBuffer = await crypto.subtle.digest('SHA-256', data);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    }

    /**
     * Substitutes data URLs with hashes and tracks blob entries to persist later.
     */
    registerBlobEntry(blobEntries, hash, dataUrl, chatId = null) {
        let entry = blobEntries.get(hash);
        if (!entry) {
            entry = { dataUrl, chatIds: new Set() };
            blobEntries.set(hash, entry);
        }
        if (chatId != null) {
            entry.chatIds.add(chatId);
        }
        return entry;
    }

    async prepareMessageForStorage(message, chatId, hashCache, blobEntries) {
        const prepared = { ...message };
        const cache = hashCache ?? new Map();
        const entries = blobEntries ?? new Map();

        const toHash = async (imageData) => {
            if (!ChatStorage.isDataUrl(imageData)) {
                return imageData;
            }

            let hash = cache.get(imageData);
            if (!hash) {
                hash = await ChatStorage.computeHash(imageData);
                cache.set(imageData, hash);
            }

            this.registerBlobEntry(entries, hash, imageData, chatId);
            return hash;
        };

        return this.mapImageParts(prepared, toHash);
    }

    async persistBlobEntries(blobEntries, transaction, chatId = null) {
        if (!blobEntries || blobEntries.size === 0) return;
        const blobStore = transaction.objectStore('blobs');

        for (const [hash, entry] of blobEntries) {
            if (chatId != null) {
                entry.chatIds.add(chatId);
            }

            const existing = await this.req(blobStore.get(hash));
            if (existing) {
                const merged = new Set(existing.chatIds || []);
                entry.chatIds.forEach(id => merged.add(id));
                const next = { ...existing, chatIds: [...merged] };
                if (!next.data && entry.dataUrl) {
                    next.data = entry.dataUrl;
                }
                if (next.data !== existing.data || next.chatIds.length !== (existing.chatIds || []).length) {
                    blobStore.put(next);
                }
            } else {
                blobStore.put({ hash, data: entry.dataUrl, chatIds: [...entry.chatIds] });
            }
        }
    }

    /**
     * Resolves hashes back to data URLs.
     */
    async resolveBlobs(message, transaction) {
        const blobStore = transaction.objectStore('blobs');

        return this.mapImageParts(message, async (hash) => {
            if (ChatStorage.isDataUrl(hash)) {
                return hash;
            }

            const blobResult = await this.req(blobStore.get(hash));
            return blobResult?.data || hash;
        });
    }

    messageHasInlineImages(message) {
        if (message.images?.some(img => ChatStorage.isDataUrl(img))) return true;
        if (message.contents?.some(group =>
            Array.isArray(group) && group.some(part => part?.type === 'image' && ChatStorage.isDataUrl(part.content))
        )) return true;
        if (message.responses) {
            for (const key of ['model_a', 'model_b']) {
                if (message.responses[key]?.messages?.some(group =>
                    Array.isArray(group) && group.some(part => part?.type === 'image' && ChatStorage.isDataUrl(part.content))
                )) {
                    return true;
                }
            }
        }
        return false;
    }

    async runPendingMigration() {
        const db = await this.getDB();
        if (!db.objectStoreNames.contains('blobs')) return;

        const needsMigration = await new Promise(resolve => {
            const tx = db.transaction('messages', 'readonly');
            const store = tx.objectStore('messages');
            const cursor = store.openCursor();
            cursor.onsuccess = (event) => {
                const entry = event.target.result;
                if (!entry) {
                    resolve(false);
                    return;
                }
                if (this.messageHasInlineImages(entry.value)) {
                    resolve(true);
                    return;
                }
                entry.continue();
            };
            cursor.onerror = () => resolve(false);
        });

        if (!needsMigration) return;

        console.log('Migrating images to blob storage...');

        const batchSize = 50;
        let processed = 0;
        const hashCache = new Map();

        while (true) {
            const batch = await new Promise(resolve => {
                const messages = [];
                const tx = db.transaction('messages', 'readonly');
                const store = tx.objectStore('messages');
                const cursor = store.openCursor();
                cursor.onsuccess = (event) => {
                    const entry = event.target.result;
                    if (!entry || messages.length >= batchSize) {
                        resolve(messages);
                        return;
                    }
                    if (this.messageHasInlineImages(entry.value)) {
                        messages.push(entry.value);
                    }
                    entry.continue();
                };
                cursor.onerror = () => resolve([]);
            });

            if (batch.length === 0) break;

            const blobEntries = new Map();
            const preparedBatch = await Promise.all(
                batch.map(message => this.prepareMessageForStorage(message, message.chatId, hashCache, blobEntries))
            );

            await this.dbOp(['messages', 'blobs'], 'readwrite', async (transaction) => {
                const messageStore = transaction.objectStore('messages');
                await this.persistBlobEntries(blobEntries, transaction);
                for (const message of preparedBatch) {
                    messageStore.put(message);
                    processed++;
                }
            });
        }

        console.log(`Blob migration complete. Processed ${processed} messages.`);
    }

    // ==================== CORE CRUD API ====================

    async createChatWithMessages(title, messages, options = {}) {
        const chatMetadata = {
            title,
            timestamp: Date.now(),
            renamed: !!options.renamed,
            continued_from_chat_id: options.continued_from_chat_id || null
        };

        const hashCache = new Map();
        const blobEntries = new Map();
        const preparedMessages = await Promise.all(
            messages.map(message => this.prepareMessageForStorage(message, null, hashCache, blobEntries))
        );

        const storeNames = ['chatMeta', 'messages', 'blobs', 'searchDocs', 'mediaIndex'];
        return this.dbOp(storeNames, 'readwrite', async (transaction) => {
            const chatId = await this.req(transaction.objectStore('chatMeta').add(chatMetadata));
            await this.persistBlobEntries(blobEntries, transaction, chatId);

            const mediaPromises = [];
            const fallbackTimestamp = Date.now();
            for (let index = 0; index < preparedMessages.length; index++) {
                const preparedMessage = preparedMessages[index];
                const messageRecord = {
                    chatId,
                    messageId: index,
                    timestamp: chatMetadata.timestamp,
                    ...preparedMessage
                };
                transaction.objectStore('messages').add(messageRecord);
                mediaPromises.push(this.indexMediaFromMessage(chatId, index, messageRecord, transaction, fallbackTimestamp));
            }
            await Promise.all(mediaPromises);

            const searchDoc = await this.refreshSearchDocInTx(chatId, transaction);

            const result = { chatId, ...chatMetadata };
            this.announce('new_chat_saved', { chat: result, searchDoc });
            return result;
        });
    }

    async addMessages(chatId, messages, startIndex) {
        const timestamp = Date.now();
        const storeNames = ['messages', 'blobs', 'chatMeta', 'searchDocs', 'mediaIndex'];

        const hashCache = new Map();
        const blobEntries = new Map();
        const preparedMessages = await Promise.all(
            messages.map(message => this.prepareMessageForStorage(message, chatId, hashCache, blobEntries))
        );

        await this.dbOp(storeNames, 'readwrite', async (transaction) => {
            await this.persistBlobEntries(blobEntries, transaction);

            const mediaPromises = [];
            const fallbackTimestamp = Date.now();
            for (let index = 0; index < preparedMessages.length; index++) {
                const preparedMessage = preparedMessages[index];
                const messageId = startIndex + index;
                const messageRecord = {
                    chatId,
                    messageId,
                    timestamp,
                    ...preparedMessage
                };
                transaction.objectStore('messages').add(messageRecord);
                mediaPromises.push(this.indexMediaFromMessage(chatId, messageId, messageRecord, transaction, fallbackTimestamp));
            }
            await Promise.all(mediaPromises);

            const metadata = await this.req(transaction.objectStore('chatMeta').get(chatId));
            if (metadata) {
                metadata.timestamp = timestamp;
                transaction.objectStore('chatMeta').put(metadata);
            }

            const searchDelta = ChatStorage.extractTextFromMessages(messages);
            let appended = false;
            if (searchDelta.trim()) {
                appended = await this.appendSearchDocInTx(chatId, searchDelta, timestamp, transaction);
            }
            if (!appended) {
                await this.refreshSearchDocInTx(chatId, transaction);
            }
            
            this.announce('appended_messages_to_saved_chat', {
                chatId,
                addedCount: messages.length,
                startIndex,
                timestamp,
                searchDelta
            });
        });
    }

    async updateMessage(chatId, messageId, message, options = {}) {
        const timestamp = Date.now();
        const storeNames = ['messages', 'blobs', 'chatMeta', 'searchDocs', 'mediaIndex'];

        const hashCache = new Map();
        const blobEntries = new Map();
        const preparedMessage = await this.prepareMessageForStorage(message, chatId, hashCache, blobEntries);

        await this.dbOp(storeNames, 'readwrite', async (transaction) => {
            await this.persistBlobEntries(blobEntries, transaction);
            const messageRecord = {
                chatId,
                messageId,
                timestamp,
                ...preparedMessage
            };
            transaction.objectStore('messages').put(messageRecord);

            const metadata = await this.req(transaction.objectStore('chatMeta').get(chatId));
            if (metadata) {
                metadata.timestamp = timestamp;
                transaction.objectStore('chatMeta').put(metadata);
            }

            await this.clearMediaForMessage(chatId, messageId, transaction);
            await this.indexMediaFromMessage(chatId, messageId, messageRecord, transaction);

            if (!options.skipSearchRefresh) {
                if (options.appendSearch) {
                    const delta = ChatStorage.extractTextFromMessage(message);
                    await this.appendSearchDocInTx(chatId, delta, timestamp, transaction);
                } else {
                    await this.refreshSearchDocInTx(chatId, transaction);
                }
            }
            
            this.announce('message_updated', { chatId, messageId });
        });
    }

    async getChatLength(chatId) {
        return this.dbOp(['messages'], 'readonly', async (transaction) => {
            const store = transaction.objectStore('messages');
            const index = store.index('chatId');
            return this.req(index.count(IDBKeyRange.only(chatId)));
        });
    }

    async loadChat(chatId, messageLimit = null) {
        return this.dbOp(['messages', 'chatMeta', 'blobs'], 'readonly', async (transaction) => {
            const metadata = await this.req(transaction.objectStore('chatMeta').get(chatId));
            if (!metadata) return null;

            const messages = await this.req(transaction.objectStore('messages').index('chatId').getAll(IDBKeyRange.only(chatId), messageLimit));
            const resolvedMessages = await Promise.all(
                messages.map(message => this.resolveBlobs(message, transaction))
            );

            return { ...metadata, messages: resolvedMessages };
        });
    }

    async getChatMetadata(limit = 20, offset = 0) {
        return this.dbOp(['chatMeta'], 'readonly', async (transaction) => {
            const results = [];
            const timestampIndex = transaction.objectStore('chatMeta').index('timestamp');
            const cursorRequest = timestampIndex.openCursor(null, 'prev');
            let skippedCount = 0;

            return new Promise((resolve) => {
                cursorRequest.onsuccess = (event) => {
                    const cursor = event.target.result;
                    if (!cursor || (limit !== Infinity && results.length >= limit)) {
                        return resolve(results);
                    }

                    if (skippedCount < offset) {
                        skippedCount++;
                        return cursor.continue();
                    }

                    results.push(cursor.value);
                    cursor.continue();
                };
            });
        });
    }

    async getChatMetadataById(id) {
        return this.dbOp(['chatMeta'], 'readonly', transaction => this.req(transaction.objectStore('chatMeta').get(id)));
    }

    async getMessage(chatId, messageId) {
        return this.dbOp(['messages', 'blobs'], 'readonly', async (transaction) => {
            const message = await this.req(transaction.objectStore('messages').get([chatId, messageId]));
            return message ? this.resolveBlobs(message, transaction) : null;
        });
    }

    async getMessages(chatId, startIndex = 0, limit) {
        const hasFiniteLimit = Number.isInteger(limit) && limit > 0;
        const hasValidStart = Number.isInteger(startIndex) && startIndex >= 0;
        const effectiveStart = hasValidStart ? startIndex : 0;

        return this.dbOp(['messages', 'blobs'], 'readonly', async (transaction) => {
            const messageStore = transaction.objectStore('messages');
            let messages = [];

            if (hasFiniteLimit && hasValidStart) {
                const requests = [];
                for (let offset = 0; offset < limit; offset++) {
                    const messageId = startIndex + offset;
                    requests.push(this.req(messageStore.get([chatId, messageId])).catch(() => null));
                }
                const results = await Promise.all(requests);
                messages = results.filter(Boolean);
            } else {
                messages = await new Promise(resolve => {
                    const results = [];
                    const index = messageStore.index('chatId');
                    const cursorRequest = index.openCursor(IDBKeyRange.only(chatId), 'next');

                    cursorRequest.onsuccess = (event) => {
                        const cursor = event.target.result;
                        if (!cursor) {
                            return resolve(results);
                        }

                        const messageId = typeof cursor.value?.messageId === 'number' ? cursor.value.messageId : null;
                        if (typeof messageId === 'number' && messageId < effectiveStart) {
                            const skip = effectiveStart - messageId;
                            if (skip > 0) {
                                cursor.advance(skip);
                                return;
                            }
                        }

                        results.push(cursor.value);
                        if (hasFiniteLimit && results.length >= limit) {
                            return resolve(results);
                        }
                        cursor.continue();
                    };

                    cursorRequest.onerror = () => resolve([]);
                });
            }

            return Promise.all(messages.map(message => this.resolveBlobs(message, transaction)));
        });
    }

    async deleteChat(chatId) {
        const storeNames = ['chatMeta', 'messages', 'blobs', 'searchDocs', 'mediaIndex'];
        await this.dbOp(storeNames, 'readwrite', async (transaction) => {
            transaction.objectStore('chatMeta').delete(chatId);
            transaction.objectStore('searchDocs').delete(chatId);

            // Delete messages and collect hashes for cleanup
            const hashSet = new Set();
            const messageStore = transaction.objectStore('messages');
            const messageCursorRequest = messageStore.index('chatId').openCursor(IDBKeyRange.only(chatId));
            
            await new Promise((resolve) => {
                messageCursorRequest.onsuccess = (event) => {
                    const cursor = event.target.result;
                    if (cursor) {
                        this.extractHashesFromMessage(cursor.value).forEach(hash => hashSet.add(hash));
                        cursor.delete();
                        cursor.continue();
                    } else {
                        resolve();
                    }
                };
            });

            // Delete media entries
            const mediaStore = transaction.objectStore('mediaIndex');
            const mediaCursorRequest = mediaStore.index('chatId').openCursor(IDBKeyRange.only(chatId));
            await new Promise(resolve => {
                mediaCursorRequest.onsuccess = event => {
                    const cursor = event.target.result;
                    if (cursor) { 
                        cursor.delete(); 
                        cursor.continue(); 
                    } else {
                        resolve(); 
                    }
                };
            });

            // Clean up blob references
            const blobStore = transaction.objectStore('blobs');
            for (const hash of hashSet) {
                const blobRecord = await this.req(blobStore.get(hash));
                if (blobRecord) {
                    blobRecord.chatIds = blobRecord.chatIds.filter(id => id !== chatId);
                    if (blobRecord.chatIds.length === 0) {
                        blobStore.delete(hash);
                    } else {
                        blobStore.put(blobRecord);
                    }
                }
            }
        });
    }

    async renameChat(id, title, announce = false) {
        return this.dbOp(['chatMeta', 'searchDocs', 'messages'], 'readwrite', async (transaction) => {
            const metadata = await this.req(transaction.objectStore('chatMeta').get(id));
            if (!metadata) return null;

            metadata.title = title;
            metadata.renamed = true;
            transaction.objectStore('chatMeta').put(metadata);

            await this.refreshSearchDocInTx(id, transaction);

            if (announce) {
                this.announce('chat_renamed', { chatId: id, title });
            }
            return metadata;
        });
    }

    // ==================== SEARCH & MEDIA ====================

    static normaliseForSearch(string) {
        if (!string) return '';
        return string.toLowerCase()
            .normalize('NFKD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/\s+/g, ' ')
            .trim();
    }

    static tokenizeForMiniSearch(text) {
        if (!text) return [];
        return text
            .toLowerCase()
            .normalize('NFKD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/[\u0000-\u001f]+/g, ' ')
            .split(/\s+/)
            .map(token => token.replace(/^[^a-z0-9_\-"'=\/:.#]+|[^a-z0-9_\-"'=\/:.#]+$/g, ''))
            .filter(Boolean);
    }


    static extractTextFromMessages(messages) {
        if (!Array.isArray(messages) || messages.length === 0) return '';
        return messages
            .map(message => ChatStorage.extractTextFromMessage(message))
            .filter(Boolean)
            .join(' ')
            .trim();
    }

    static extractTextFromMessage(message) {
        if (!message) return '';

        if (Array.isArray(message.contents)) {
            return message.contents
                .flat()
                .filter(part => part && (part.type === 'text' || part.type === 'thought'))
                .map(part => part.content || '')
                .join(' ');
        }

        // Arena responses: only index 'text' type, not 'thought' (matches old behavior)
        if (message.responses) {
            return ['model_a', 'model_b']
                .map(modelKey => message.responses[modelKey]?.messages || [])
                .flat()
                .flat()
                .filter(part => part && part.type === 'text')
                .map(part => part.content || '')
                .join(' ');
        }

        return '';
    }

    async refreshSearchDoc(chatId) {
        return this.dbOp(['chatMeta', 'messages', 'searchDocs'], 'readwrite', async (transaction) => {
            await this.refreshSearchDocInTx(chatId, transaction);
        });
    }

    async refreshSearchDocInTx(chatId, transaction) {
        const metadata = await this.req(transaction.objectStore('chatMeta').get(chatId));
        const messages = await this.req(transaction.objectStore('messages').index('chatId').getAll(IDBKeyRange.only(chatId)));

        const searchDocument = {
            id: chatId,
            title: metadata.title,
            timestamp: metadata.timestamp,
            content: ChatStorage.normaliseForSearch(ChatStorage.extractTextFromMessages(messages)),
            searchTitle: ChatStorage.normaliseForSearch(metadata.title)
        };
        transaction.objectStore('searchDocs').put(searchDocument);
        return searchDocument;
    }

    async appendSearchDocInTx(chatId, delta, timestamp, transaction) {
        const trimmed = delta?.trim();
        if (!trimmed) return false;
        const store = transaction.objectStore('searchDocs');
        const existing = await this.req(store.get(chatId));
        if (!existing) return false;

        const normalisedDelta = ChatStorage.normaliseForSearch(trimmed);
        if (normalisedDelta) {
            existing.content = existing.content
                ? `${existing.content} ${normalisedDelta}`.trim()
                : normalisedDelta;
        }
        if (timestamp != null) {
            existing.timestamp = timestamp;
        }
        if (typeof existing.searchTitle !== 'string') {
            existing.searchTitle = ChatStorage.normaliseForSearch(existing.title || '');
        }

        store.put(existing);
        return true;
    }

    async getSearchJson() {
        const result = await this.dbOp(['searchIndex'], 'readonly', transaction => this.req(transaction.objectStore('searchIndex').get('search')));
        return result?.json;
    }

    async getSearchMetadata() {
        const result = await this.dbOp(['searchIndex'], 'readonly', transaction => this.req(transaction.objectStore('searchIndex').get('metadata')));
        return result?.value;
    }

    async getSearchDocs() {
        return this.dbOp(['searchDocs'], 'readonly', transaction => this.req(transaction.objectStore('searchDocs').getAll()));
    }

    async putSearchDocs(docs) {
        await this.dbOp(['searchDocs'], 'readwrite', async transaction => {
            const store = transaction.objectStore('searchDocs');
            const existingIds = new Set(await this.req(store.getAllKeys()));
            docs.forEach(doc => {
                existingIds.delete(doc.id);
                store.put(doc);
            });
            existingIds.forEach(id => store.delete(id));
        });
    }

    async deleteSearchDoc(id) {
        await this.dbOp(['searchDocs'], 'readwrite', transaction =>
            this.req(transaction.objectStore('searchDocs').delete(id))
        );
    }

    async setSearchIndex(json, count, metadata) {
        await this.dbOp(['searchIndex'], 'readwrite', transaction => {
            const store = transaction.objectStore('searchIndex');
            store.put({ id: 'search', json });
            store.put({ id: 'count', value: count });
            store.put({ id: 'metadata', value: metadata });
        });
    }

    // ==================== MEDIA INDEXING ====================

    async indexMediaFromMessage(chatId, messageId, message, transaction, fallbackTimestamp = null) {
        const mediaStore = transaction.objectStore('mediaIndex');
        const timestamp = typeof message.timestamp === 'number' ? message.timestamp : ((fallbackTimestamp || Date.now()) + messageId);
        const mediaRecords = [];

        // 1. User images
        if (message.images) {
            message.images.forEach((imageContent, imageIndex) => {
                mediaRecords.push({ chatId, messageId, source: 'user', imageIndex, timestamp, content: imageContent });
            });
        }

        // 2. Assistant parts
        if (message.contents) {
            message.contents.forEach((contentGroup, contentIndex) => {
                if (!Array.isArray(contentGroup)) return;
                contentGroup.forEach((part, partIndex) => {
                    if (part?.type === 'image') {
                        mediaRecords.push({ chatId, messageId, source: 'assistant', contentIndex, partIndex, timestamp, content: part.content });
                    }
                });
            });
        }

        if (message.responses) {
            for (const modelKey of ['model_a', 'model_b']) {
                const modelMessages = message.responses[modelKey]?.messages;
                if (!Array.isArray(modelMessages)) continue;
                modelMessages.forEach((msgGroup, messageIndex) => {
                    if (!Array.isArray(msgGroup)) return;
                    msgGroup.forEach((part, partIndex) => {
                        if (part?.type === 'image') {
                            mediaRecords.push({ chatId, messageId, source: 'assistant', modelKey, messageIndex, partIndex, timestamp, content: part.content });
                        }
                    });
                });
            }
        }

        await Promise.all(mediaRecords.map(record => {
            const { content, ...metaData } = record;
            return this.req(mediaStore.add(metaData)).then(entryId => {
                this.createThumbnail(content).then(thumbnail => {
                    if (thumbnail) this.updateMediaThumbnail(entryId, thumbnail);
                });
            });
        }));

        return mediaRecords.length;
    }

    async clearMediaForMessage(chatId, messageId, transaction) {
        const mediaStore = transaction.objectStore('mediaIndex');
        const cursorRequest = mediaStore.index('chatId').openCursor(IDBKeyRange.only(chatId));
        return new Promise(resolve => {
            cursorRequest.onsuccess = event => {
                const cursor = event.target.result;
                if (cursor) {
                    if (cursor.value.messageId === messageId) {
                        cursor.delete();
                    }
                    cursor.continue();
                } else {
                    resolve();
                }
            };
        });
    }

    async getAllMedia(limit = 100, offset = 0) {
        return this.dbOp(['mediaIndex'], 'readonly', async (transaction) => {
            const results = [];
            const timestampIndex = transaction.objectStore('mediaIndex').index('timestamp');
            const cursorRequest = timestampIndex.openCursor(null, 'prev');
            let skippedCount = 0;

            return new Promise(resolve => {
                cursorRequest.onsuccess = event => {
                    const cursor = event.target.result;
                    if (!cursor || (limit !== Infinity && results.length >= limit)) {
                        return resolve(results);
                    }
                    if (skippedCount++ < offset) {
                        return cursor.continue();
                    }
                    results.push(cursor.value);
                    cursor.continue();
                };
            });
        });
    }

    async deleteMediaEntry(id) {
        await this.dbOp(['mediaIndex'], 'readwrite', transaction => this.req(transaction.objectStore('mediaIndex').delete(id)));
    }

    // ==================== IMAGE PROCESSING ====================

    async createThumbnail(imageData, maxShortEdge = 512) {
        if (typeof document === 'undefined' || typeof Image === 'undefined') return null;
        if (!ChatStorage.isDataUrl(imageData)) {
            // Resolve hash if necessary
            imageData = await this.dbOp(['blobs'], 'readonly', async transaction => {
                const blobResult = await this.req(transaction.objectStore('blobs').get(imageData));
                return blobResult?.data;
            });
        }
        if (!ChatStorage.isDataUrl(imageData)) return null;

        return new Promise((resolve) => {
            const imageElement = new Image();
            imageElement.onload = () => {
                const { naturalWidth: width, naturalHeight: height } = imageElement;
                if (!width || !height) return resolve(null);

                let scaleFactor = 1;
                const shortestEdge = Math.min(width, height);
                if (shortestEdge > maxShortEdge) {
                    scaleFactor = maxShortEdge / shortestEdge;
                }

                if (scaleFactor === 1) {
                    return resolve({ dataUrl: imageData, width, height });
                }

                const canvasElement = document.createElement('canvas');
                canvasElement.width = Math.round(width * scaleFactor);
                canvasElement.height = Math.round(height * scaleFactor);
                const canvasContext = canvasElement.getContext('2d');
                if (!canvasContext) return resolve(null);

                canvasContext.imageSmoothingQuality = 'medium';
                canvasContext.drawImage(imageElement, 0, 0, canvasElement.width, canvasElement.height);
                
                try {
                    const dataUrl = canvasElement.toDataURL('image/webp', 0.82);
                    resolve({ dataUrl, width: canvasElement.width, height: canvasElement.height });
                } catch (error) {
                    resolve({ dataUrl: canvasElement.toDataURL('image/png'), width: canvasElement.width, height: canvasElement.height });
                }
            };
            imageElement.onerror = () => resolve(null);
            imageElement.src = imageData;
        });
    }

    async updateMediaThumbnail(entryId, thumbnail) {
        try {
            await this.dbOp(['mediaIndex'], 'readwrite', async transaction => {
                const mediaStore = transaction.objectStore('mediaIndex');
                const mediaEntry = await this.req(mediaStore.get(entryId));
                if (mediaEntry) {
                    mediaEntry.thumbnail = thumbnail.dataUrl;
                    mediaEntry.thumbnailWidth = thumbnail.width;
                    mediaEntry.thumbnailHeight = thumbnail.height;
                    mediaStore.put(mediaEntry);
                }
            });
        } catch (error) { 
            console.warn('Failed to update thumbnail:', error); 
        }
    }

    async ensureMediaThumbnails(mediaEntries, batchSize = 4) {
        const entriesNeedingThumbnails = mediaEntries.filter(entry => !entry.thumbnail);
        if (entriesNeedingThumbnails.length === 0) return false;

        let isUpdated = false;

        // Process in batches for better performance without overwhelming the system
        for (let i = 0; i < entriesNeedingThumbnails.length; i += batchSize) {
            const batch = entriesNeedingThumbnails.slice(i, i + batchSize);

            const results = await Promise.all(batch.map(async entry => {
                const imageData = await this.dbOp(['messages', 'blobs'], 'readonly', async transaction => {
                    const message = await this.req(transaction.objectStore('messages').get([entry.chatId, entry.messageId]));
                    if (!message) return null;

                    let imageHashOrUrl;
                    if (entry.source === 'user') {
                        imageHashOrUrl = message.images?.[entry.imageIndex];
                    } else if (entry.modelKey) {
                        const modelMessages = message.responses?.[entry.modelKey]?.messages;
                        if (entry.messageIndex != null) {
                            imageHashOrUrl = modelMessages?.[entry.messageIndex]?.[entry.partIndex]?.content;
                        } else {
                            imageHashOrUrl = modelMessages?.flat?.()?.[entry.partIndex]?.content;
                        }
                    } else if (entry.contentIndex != null) {
                        imageHashOrUrl = message.contents?.[entry.contentIndex]?.[entry.partIndex]?.content;
                    } else {
                        imageHashOrUrl = message.contents?.flat?.()?.[entry.partIndex]?.content;
                    }

                    if (ChatStorage.isDataUrl(imageHashOrUrl)) return imageHashOrUrl;
                    const blobResult = await this.req(transaction.objectStore('blobs').get(imageHashOrUrl));
                    return blobResult?.data;
                });

                if (!imageData) return null;

                const thumbnail = await this.createThumbnail(imageData);
                if (!thumbnail) return null;

                await this.updateMediaThumbnail(entry.id, thumbnail);
                entry.thumbnail = thumbnail.dataUrl;
                entry.thumbnailWidth = thumbnail.width;
                entry.thumbnailHeight = thumbnail.height;
                return true;
            }));

            if (results.some(Boolean)) isUpdated = true;
        }

        return isUpdated;
    }

    async indexAllMediaFromExistingMessages() {
        const metadataList = await this.getChatMetadata(Infinity);
        let totalIndexed = 0;
        for (const metadata of metadataList) {
            const chat = await this.loadChat(metadata.chatId);
            if (!chat?.messages) continue;
            await this.dbOp(['mediaIndex'], 'readwrite', async transaction => {
                const fallbackTimestamp = Date.now();
                const promises = chat.messages.map((msg, index) =>
                    this.indexMediaFromMessage(metadata.chatId, index, msg, transaction, fallbackTimestamp)
                );
                const counts = await Promise.all(promises);
                totalIndexed += counts.reduce((a, b) => a + b, 0);
            });
        }
        return totalIndexed;
    }

    // ==================== IMAGE REPAIR ====================

    async repairAllBlobs() {
        return this.dbOp(['blobs'], 'readwrite', async (transaction) => {
            const blobStore = transaction.objectStore('blobs');
            const cursorRequest = blobStore.openCursor();
            let repairCount = 0;

            return new Promise(resolve => {
                cursorRequest.onsuccess = event => {
                    const cursor = event.target.result;
                    if (!cursor) return resolve(repairCount);
                    const { data, hash, chatIds } = cursor.value;
                    if (ChatStorage.isDataUrl(data)) {
                        try {
                            const base64 = data.split('base64,')[1];
                            const mimeType = data.split(':')[1]?.split(';')[0];
                            if (base64 && mimeType && base64NeedsRepair(base64, mimeType)) {
                                const fixedBase64 = sanitizeBase64Image(base64, mimeType);
                                if (fixedBase64 && fixedBase64 !== base64) {
                                    blobStore.put({ hash, chatIds, data: `data:${mimeType};base64,${fixedBase64}` });
                                    repairCount++;
                                }
                            }
                        } catch (_) { /* skip malformed data URLs */ }
                    }
                    cursor.continue();
                };
            });
        });
    }

    async repairBlobByDataUrl(dataUrl) {
        if (!ChatStorage.isDataUrl(dataUrl)) return { repaired: false };
        try {
            var base64 = dataUrl.split('base64,')[1];
            var mimeType = dataUrl.split(':')[1]?.split(';')[0];
        } catch (_) { return { repaired: false }; }
        if (!base64 || !mimeType || !base64NeedsRepair(base64, mimeType)) return { repaired: false };

        const fixedBase64 = sanitizeBase64Image(base64, mimeType);
        if (!fixedBase64 || fixedBase64 === base64) return { repaired: false };

        const fixedDataUrl = `data:${mimeType};base64,${fixedBase64}`;
        const originalHash = await ChatStorage.computeHash(dataUrl);
        
        await this.dbOp(['blobs'], 'readwrite', async (transaction) => {
            const blobStore = transaction.objectStore('blobs');
            const existing = await this.req(blobStore.get(originalHash));

            if (existing) {
                blobStore.put({ ...existing, data: fixedDataUrl });
            } else {
                blobStore.put({ hash: originalHash, data: fixedDataUrl, chatIds: [] });
            }
        });

        return { repaired: true, dataUrl: fixedDataUrl };
    }

    // ==================== IMPORT / EXPORT ====================

    async exportChats(options = {}) {
        const archive = {
            exportedAt: new Date().toISOString(),
            schemaVersion: this.dbVersion,
            chats: {},
            blobs: {}
        };

        await this.dbOp(['chatMeta', 'messages', 'blobs'], 'readonly', async (transaction) => {
            const metadataList = await this.req(transaction.objectStore('chatMeta').getAll());
            const usedHashes = new Set();

            // Collect all chats and their messages, track which hashes are used
            for (const metadata of metadataList) {
                const chatId = metadata.chatId;
                const messages = await this.req(transaction.objectStore('messages').index('chatId').getAll(IDBKeyRange.only(chatId)));
                // Sort by messageId to ensure consistent ordering
                messages.sort((a, b) => a.messageId - b.messageId);
                archive.chats[chatId] = { ...metadata, messages };

                for (const message of messages) {
                    this.extractHashesFromMessage(message).forEach(hash => usedHashes.add(hash));
                }
            }

            // Batch fetch all used blobs in a single cursor pass
            if (usedHashes.size > 0) {
                const blobStore = transaction.objectStore('blobs');
                await new Promise(resolve => {
                    const cursor = blobStore.openCursor();
                    cursor.onsuccess = (event) => {
                        const result = event.target.result;
                        if (result) {
                            if (usedHashes.has(result.value.hash)) {
                                archive.blobs[result.value.hash] = result.value.data;
                            }
                            result.continue();
                        } else {
                            resolve();
                        }
                    };
                    cursor.onerror = () => resolve();
                });
            }
        });

        return JSON.stringify(archive, null, options.pretty ? 2 : 0);
    }

    async importChats(json) {
        const data = JSON.parse(json);
        const archiveBlobs = data.blobs || {};
        const schemaVersion = data.schemaVersion ?? 1;
        const needsV3Migration = schemaVersion < 3;
        const hasBlobs = Object.keys(archiveBlobs).length > 0;
        const needsBlobConversion = schemaVersion < 5 && !hasBlobs;

        // Duplicate detection: build fingerprint → existingChatId map
        const existingChats = await this.getChatMetadata(Infinity);
        const existingIdsByFingerprint = new Map(
            existingChats.map(c => [`${c.title}::${c.timestamp}`, c.chatId])
        );

        const idRemap = new Map();
        const chatsToImport = [];

        // Process all chats, applying migrations and tracking duplicates
        for (const rawChat of Object.values(data.chats)) {
            // Apply v3 message structure migration if needed
            const chat = needsV3Migration ? this.migrateImportedChat(rawChat) : rawChat;
            const fingerprint = `${chat.title}::${chat.timestamp}`;
            const existingChatId = existingIdsByFingerprint.get(fingerprint);

            if (existingChatId !== undefined) {
                // Duplicate: record mapping from old ID to existing ID for link remapping
                if (chat.chatId != null) {
                    idRemap.set(chat.chatId, existingChatId);
                }
                continue;
            }

            chatsToImport.push(chat);
        }

        if (chatsToImport.length === 0) {
            return { success: true, count: 0 };
        }

        return this.dbOp(['chatMeta', 'messages', 'blobs', 'searchDocs', 'mediaIndex'], 'readwrite', async (transaction) => {
            const blobStore = transaction.objectStore('blobs');
            const metaStore = transaction.objectStore('chatMeta');
            const blobEntries = new Map();
            const hashCache = new Map();
            const pendingLinkUpdates = [];

            // Import blobs that don't exist yet
            for (const hash in archiveBlobs) {
                const existing = await this.req(blobStore.get(hash));
                if (!existing) {
                    blobStore.put({ hash, data: archiveBlobs[hash], chatIds: [] });
                }
            }

            for (const chat of chatsToImport) {
                const { messages, chatId: oldChatId, continued_from_chat_id, ...metadata } = chat;
                const newChatId = await this.req(metaStore.add({ ...metadata, continued_from_chat_id }));

                // Track ID mapping for relationship remapping
                if (oldChatId != null) {
                    idRemap.set(oldChatId, newChatId);
                }
                if (continued_from_chat_id != null) {
                    pendingLinkUpdates.push({ targetId: newChatId, originalParentId: continued_from_chat_id });
                }

                const mediaPromises = [];
                const fallbackTimestamp = Date.now();
                for (const message of messages) {
                    // Use stored messageId if present, fallback to 0
                    const messageId = message.messageId ?? 0;
                    let preparedMessage = { ...message };

                    // Convert inline data URLs to blob hashes if v5 migration needed
                    if (needsBlobConversion) {
                        preparedMessage = await this.prepareMessageForStorage(message, newChatId, hashCache, blobEntries);
                    } else if (hasBlobs) {
                        // Track blob references for existing hashes
                        const hashes = this.extractHashesFromMessage(message);
                        for (const hash of hashes) {
                            this.registerBlobEntry(blobEntries, hash, archiveBlobs[hash], newChatId);
                        }
                    }

                    const messageRecord = { ...preparedMessage, chatId: newChatId, messageId };
                    transaction.objectStore('messages').add(messageRecord);
                    mediaPromises.push(this.indexMediaFromMessage(newChatId, messageId, messageRecord, transaction, fallbackTimestamp));
                }
                await Promise.all(mediaPromises);

                await this.refreshSearchDocInTx(newChatId, transaction);
            }

            // Remap continued_from_chat_id references to new/existing IDs
            for (const { targetId, originalParentId } of pendingLinkUpdates) {
                const remappedId = idRemap.get(originalParentId);
                if (remappedId != null) {
                    const record = await this.req(metaStore.get(targetId));
                    if (record) {
                        record.continued_from_chat_id = remappedId;
                        metaStore.put(record);
                    }
                }
            }

            await this.persistBlobEntries(blobEntries, transaction);
            return { success: true, count: chatsToImport.length };
        });
    }

    /**
     * Migrates chat data from v1/v2 message format to v3 structure.
     */
    migrateImportedChat(chatData) {
        if (!chatData.messages || !Array.isArray(chatData.messages)) {
            return chatData;
        }
        return {
            ...chatData,
            messages: Migrations.transformMessages(chatData.messages).map((msg, idx) => ({
                ...msg,
                messageId: idx
            }))
        };
    }

    extractHashesFromMessage(message) {
        const hashes = [];
        if (!message) return hashes;
        if (message.images) {
            message.images.forEach(hashOrUrl => !ChatStorage.isDataUrl(hashOrUrl) && hashes.push(hashOrUrl));
        }
        const collectHash = part => part?.type === 'image' && !ChatStorage.isDataUrl(part.content) && hashes.push(part.content);
        message.contents?.flat().forEach(collectHash);
        if (message.responses) {
            for (const key in message.responses) {
                message.responses[key].messages?.flat().forEach(collectHash);
            }
        }
        return hashes;
    }

    announce(type, payload) {
        chrome.runtime.sendMessage({ type, ...payload }).catch(() => {});
    }

    triggerDownload(json, filename = `chat-backup-${Date.now()}.json`) {
        const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const anchorElement = document.createElement('a');
        Object.assign(anchorElement, { href: url, download: filename });
        anchorElement.click();
        setTimeout(() => URL.revokeObjectURL(url), 100);
    }

    createNewChatTracking(title) { return { chatId: null, title, messages: [] }; }
    initArenaMessage(modelA, modelB) {
        return {
            role: 'assistant', choice: 'ignored', continued_with: '',
            responses: {
                model_a: { name: modelA, messages: [] },
                model_b: { name: modelB, messages: [] }
            }
        };
    }
}
