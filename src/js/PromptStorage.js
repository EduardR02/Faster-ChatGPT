export class PromptStorage {
    constructor() {
        this.dbName = 'llm-prompts';
        this.dbVersion = 1;
    }

    async getDB() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, this.dbVersion);
            
            request.onupgradeneeded = (event) => {
                const database = event.target.result;
                if (!database.objectStoreNames.contains('prompts')) {
                    const store = database.createObjectStore('prompts', { keyPath: ['name', 'type'] });
                    store.createIndex('type', 'type');
                }
            };

            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    async addPrompt(name, type, content, overwrite = false) {
        const database = await this.getDB();
        return new Promise((resolve, reject) => {
            const transaction = database.transaction('prompts', 'readwrite');
            transaction.oncomplete = () => resolve();
            transaction.onerror = () => reject(transaction.error);
            
            const store = transaction.objectStore('prompts');
            const promptData = { name, type, content };
            
            if (overwrite) {
                store.put(promptData);
            } else {
                store.add(promptData);
            }
        });
    }

    async getPrompt(name) {
        const database = await this.getDB();
        return new Promise((resolve, reject) => {
            const transaction = database.transaction('prompts', 'readonly');
            const store = transaction.objectStore('prompts');
            const request = store.get(name);
            
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    async getAllPrompts() {
        const database = await this.getDB();
        return new Promise((resolve, reject) => {
            const transaction = database.transaction('prompts', 'readonly');
            const store = transaction.objectStore('prompts');
            const request = store.getAll();
            
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    async deletePrompt(name) {
        const database = await this.getDB();
        return new Promise((resolve, reject) => {
            const transaction = database.transaction('prompts', 'readwrite');
            const store = transaction.objectStore('prompts');
            const request = store.delete(name);
            
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }
}
