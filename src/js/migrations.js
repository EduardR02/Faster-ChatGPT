/**
 * Handles IndexedDB schema migrations.
 */
export class Migrations {
    static run(database, oldVersion, transaction) {
        // Version 1: Initial setup
        if (oldVersion < 1) {
            const chatMetaStore = database.createObjectStore('chatMeta', { 
                keyPath: 'chatId', 
                autoIncrement: true 
            });
            chatMetaStore.createIndex('timestamp', 'timestamp');
            
            const messagesStore = database.createObjectStore('messages', { 
                keyPath: ['chatId', 'messageId'] 
            });
            messagesStore.createIndex('chatId', 'chatId');
        }

        // Version 4: Search and Media Indexing
        if (oldVersion < 4) {
            if (!database.objectStoreNames.contains('mediaIndex')) {
                const mediaStore = database.createObjectStore('mediaIndex', { 
                    keyPath: 'id', 
                    autoIncrement: true 
                });
                mediaStore.createIndex('chatId', 'chatId');
                mediaStore.createIndex('timestamp', 'timestamp');
            }
            if (!database.objectStoreNames.contains('searchIndex')) {
                database.createObjectStore('searchIndex', { keyPath: 'id' });
            }
            if (!database.objectStoreNames.contains('searchDocs')) {
                database.createObjectStore('searchDocs', { keyPath: 'id' });
            }
        }

        // Version 5: Blob Storage
        if (oldVersion < 5) {
            if (!database.objectStoreNames.contains('blobs')) {
                database.createObjectStore('blobs', { keyPath: 'hash' });
            }
        }
        
        // Complex structural migrations
        if (oldVersion > 0 && oldVersion < 3) {
            // During onupgradeneeded, use request callbacks to keep the upgrade transaction alive
            Migrations.migrateToVersion3(transaction);
        }
    }

    /**
     * Full original migration logic for the structural change in version 3.
     */
    static migrateToVersion3(transaction) {
        console.log('Migrating messages to version 3 structure...');

        const metaStore = transaction.objectStore('chatMeta');
        const messageStore = transaction.objectStore('messages');

        const chatIdsRequest = metaStore.getAllKeys();
        chatIdsRequest.onsuccess = (event) => {
            const chatIds = event.target.result || [];

            chatIds.forEach(chatId => {
                const messagesReq = messageStore.index('chatId').getAll(IDBKeyRange.only(chatId));
                messagesReq.onsuccess = () => {
                    const messages = messagesReq.result || [];
                    if (!messages.length) return;

                    const transformedMessages = Migrations.transformMessages(messages);

                    const deleteReq = messageStore.index('chatId').openCursor(IDBKeyRange.only(chatId));
                    deleteReq.onsuccess = (deleteEvent) => {
                        const cursor = deleteEvent.target.result;
                        if (cursor) {
                            cursor.delete();
                            cursor.continue();
                            return;
                        }

                        transformedMessages.forEach((message, index) => {
                            messageStore.put({ ...message, messageId: index });
                        });
                    };
                };
            });

            console.log('Version 3 migration complete.');
        };
    }

    static transformMessages(oldMessages) {
        return oldMessages.reduce((accumulator, currentMessage, index) => {
            if (currentMessage._processed) {
                return accumulator;
            }

            // Handle arena messages
            if (currentMessage.responses) {
                accumulator.push(Migrations.transformArenaMessage(currentMessage));
                return accumulator;
            }

            // Handle assistant regenerations
            if (currentMessage.role === 'assistant') {
                const regenerations = Migrations.collectRegenerations(oldMessages, index);
                accumulator.push(Migrations.transformAssistantMessage(currentMessage, regenerations));
                return accumulator;
            }

            // Handle normal messages
            accumulator.push(Migrations.transformNormalMessage(currentMessage));
            return accumulator;
        }, []);
    }

    static collectRegenerations(messages, startIndex) {
        const regenerations = [];
        let index = startIndex + 1;
        while (index < messages.length && 
               messages[index].role === 'assistant' &&
               !messages[index].responses) {
            messages[index]._processed = true;
            regenerations.push(messages[index]);
            index++;
        }
        return regenerations;
    }

    static transformArenaMessage(message) {
        return {
            chatId: message.chatId,
            role: 'assistant',
            choice: message.choice || 'ignored',
            continued_with: message.continued_with || '',
            responses: {
                model_a: {
                    name: message.responses.model_a.name,
                    messages: message.responses.model_a.messages.map(content => ([{ type: 'text', content: content }]))
                },
                model_b: {
                    name: message.responses.model_b.name,
                    messages: message.responses.model_b.messages.map(content => ([{ type: 'text', content: content }]))
                }
            },
            timestamp: message.timestamp
        };
    }

    static transformAssistantMessage(message, regenerations) {
        return {
            chatId: message.chatId,
            role: 'assistant',
            contents: [
                [{ type: 'text', content: message.content, model: message.model }],
                ...regenerations.map(regeneration => ([{ type: 'text', content: regeneration.content, model: regeneration.model }]))
            ],
            timestamp: message.timestamp
        };
    }

    static transformNormalMessage(message) {
        return {
            chatId: message.chatId,
            role: message.role,
            contents: [[{ type: 'text', content: message.content }]],
            ...(message.images && { images: message.images }),
            ...(message.files && { files: message.files }),
            timestamp: message.timestamp
        };
    }
}
