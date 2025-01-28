import { ApiManager } from './api_manager.js';
import { SettingsManager } from './state_manager.js';
import { TokenCounter, StreamWriterBase } from './utils.js';

const RENAME_PROMPT = `Condense the input into a minimal title that captures the core action and intent. Focus on the essential elements—what is being done and why—while stripping all unnecessary details, filler words, and redundancy. Ensure the title is concise, descriptive, and reflects the purpose without explicitly stating it unless absolutely necessary.\n
Examples:\n
- User prompt: Can you help me debug this Python script? → Python Script Debugging\n
- User prompt: The impact of climate change on polar bears → Climate Change and Polar Bears\n
- User prompt: Write a short story about a robot discovering emotions → Robot Emotion Story\n\n
Your task is to condense the user input that will follow. Only output the title, as specified, and nothing else.`;


class RenameManagerBase {
    constructor(timeoutDuration = 15000) {
        this.apiManager = new ApiManager();
        this.stateManager = new SettingsManager(['current_model', 'auto_rename_model', 'auto_rename']);
        this.timeoutDuration = timeoutDuration;
    }

    async generateNewName(messages, streamWriter) {
        const model = this.getModel();
        const tokenCounter = new TokenCounter(this.apiManager.getProviderForModel(model));
        // simply let it throw the error if it times out
        await this.timeoutPromise(this.apiManager.callApi(model, messages, tokenCounter, streamWriter));
        return { newName: streamWriter.done(), tokenCounter };
    }

    async renameWithContentDiv(contentDiv, messages) {
        const originalContent = contentDiv.textContent;
        const streamWriter = new StreamWriterBase(contentDiv);
        contentDiv.textContent = 'Renaming...';

        try {
            const result = await this.generateNewName(messages, streamWriter);
            return result;
        } catch (error) {
            if (contentDiv) {
                contentDiv.textContent = 'Rename failed';
                setTimeout(() => contentDiv.textContent = originalContent, 2000);
            }
            return null;
        }
    }

    extractSelectionAndUrl(systemMessage) {
        const matches = systemMessage.match(/"""\[(.*?)\]"""\s*"""\[(.*?)\]"""/s);
        return matches ? {
            url: matches[1],
            selection: matches[2]
        } : null;
    }

    prepareMessages(systemMsg, userMsg) {
        const systemMessage = {
            role: "system",
            content: RENAME_PROMPT
        };

        const extracted = this.extractSelectionAndUrl(systemMsg);
        const userMsgContent = userMsg.contents[0].at(-1).content;

        if (extracted !== null) {
            const combinedContent = [
                `Source URL: ${extracted.url}`,
                `Selected text: ${extracted.selection}`,
                `User prompt: ${userMsgContent}`
            ].join('\n\n');

            return [systemMessage, {
                role: "user",
                content: combinedContent,
                ...(userMsg.files?.length > 0 && { files: userMsg.files })
            }];
        }

        const combinedContent = `User prompt: ${userMsgContent}`;
        return [systemMessage, {
            role: "user",
            content: combinedContent,
            ...(userMsg.files?.length > 0 && { files: userMsg.files })
        }];
    }

    timeoutPromise(promise) {
        return Promise.race([
            promise,
            new Promise((_, reject) =>
                setTimeout(() => reject(new Error('Timeout')), this.timeoutDuration)
            )
        ]);
    }

    getModel() {
        return this.stateManager.getSetting('auto_rename_model') || this.stateManager.getSetting('current_model');
    }
}


class StorageRenameManager extends RenameManagerBase {
    constructor(chatStorage, timeoutDuration = 15000) {
        super(timeoutDuration);
        this.chatStorage = chatStorage;
        this.announceUpdate = false;
    }

    async renameSingleChat(chatId, contentDiv = null) {
        const chatData = await this.chatStorage.loadChat(chatId, 2);
        if (!chatData?.messages?.length || chatData.messages.length < 2) return null;

        const [systemMsg, userMsg] = chatData.messages;
        if (systemMsg.role !== 'system' || userMsg.role !== 'user') return null;

        const messages = this.prepareMessages(systemMsg.contents[0].at(-1).content, userMsg);
        if (!messages) return null;

        let result = null;
        try {
            if (contentDiv) {
                result = await this.renameWithContentDiv(contentDiv, messages);
            } else {
                result = await this.generateNewName(messages, new StreamWriterBase(null));
            }
        } catch {
            return null;
        }

        if (result) {
            await this.chatStorage.renameChat(chatId, result.newName, this.announceUpdate);
        }
        return result;
    }
}


export class SidepanelRenameManager extends StorageRenameManager {
    constructor(chatStorage, timeoutDuration = 15000) {
        super(chatStorage, timeoutDuration);
        this.announceUpdate = true;
    }

    autoRename(chatId, contentDiv) {
        if (!this.stateManager.getSetting('auto_rename')) return;
        this.renameSingleChat(chatId, contentDiv);
    }
}


export class HistoryRenameManager extends StorageRenameManager {
    constructor(chatStorage, timeoutDuration = 30000) {
        super(chatStorage, timeoutDuration);
    }

    async renameAllUnmodified() {
        const allChats = await this.chatStorage.getChatMetadata(Infinity, 0);
        const unnamedChats = allChats.filter(chat => !chat.hasOwnProperty('renamed') || !chat.renamed);

        const finalTokenCounter = new TokenCounter(this.apiManager.getProviderForModel(this.getModel()));
        if (unnamedChats.length === 0) return { status: 'no_chats', tokenCounter: finalTokenCounter };

        let successCount = 0;
        await Promise.all(unnamedChats.map(async chat => {
            const contentDiv = document.getElementById(chat.chatId)?.querySelector('.item-text');
            const result = await this.renameSingleChat(chat.chatId, contentDiv);

            if (result) {
                successCount++;
                finalTokenCounter.inputTokens += result.tokenCounter.inputTokens;
                finalTokenCounter.outputTokens += result.tokenCounter.outputTokens;
            }
        }));

        return {
            status: 'success',
            tokenCounter: finalTokenCounter,
            successCount,
            totalCount: unnamedChats.length
        };
    }
}