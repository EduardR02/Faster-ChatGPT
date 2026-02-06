import { ApiManager } from './api_manager.js';
import { TokenCounter } from './TokenCounter.js';
import { StreamWriterBase } from './StreamWriter.js';

const SYSTEM_PROMPT = `Condense the input into a minimal title that captures the core action and intent. Focus on the essential elements—what is being done and why—while stripping all unnecessary details, filler words, and redundancy. Ensure the title is concise, descriptive, and reflects the purpose without explicitly stating it unless absolutely necessary.

Examples:

- User prompt: Can you help me debug this Python script? → Python Script Debugging
- User prompt: The impact of climate change on polar bears → Climate Change and Polar Bears
- User prompt: Write a short story about a robot discovering emotions → Robot Emotion Story

Your task is to condense the user input that will follow. Only output the title, as specified, and nothing else.`;

export class RenameManager {
    constructor(chatStorage, options = {}) {
        const {
            timeoutMs = 15000,
            announceUpdate = false,
            allowAutoRename = false,
            apiManager = null
        } = options;

        this.chatStorage = chatStorage;
        this.api = apiManager || new ApiManager();
        this.state = this.api.settingsManager;
        this.timeout = timeoutMs;
        this.announceUpdate = announceUpdate;
        this.allowAutoRename = allowAutoRename;
    }

    getModel() {
        return this.state.getSetting('auto_rename_model') ||
            this.state.getSetting('current_model');
    }

    async generate(messages, writer) {
        const modelId = this.getModel();
        const providerName = this.api.getProviderName(modelId);
        const tokenCounter = new TokenCounter(providerName);

        const apiCall = this.api.callApi(modelId, messages, tokenCounter, writer);
        const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Rename generation timed out')), this.timeout)
        );

        await Promise.race([apiCall, timeoutPromise]);

        return {
            newName: writer.done(),
            tokenCounter
        };
    }

    async renameUI(displayElement, messages) {
        const originalText = displayElement.textContent;
        const writer = new StreamWriterBase(displayElement);

        displayElement.textContent = 'Renaming...';

        try {
            return await this.generate(messages, writer);
        } catch (error) {
            displayElement.textContent = 'Rename failed';
            setTimeout(() => { displayElement.textContent = originalText; }, 2000);
            return null;
        }
    }

    prepareMessages(systemContext, userMessage) {
        const contextMatch = systemContext.match(/"""\[(.*?)\]"""\s*"""\[(.*?)\]"""/s);
        const lastContentVersion = userMessage.contents[0] || [];
        const textPart = lastContentVersion.find(p => p.type === 'text') || lastContentVersion.at(-1);
        const userContent = textPart?.content || '';

        const body = contextMatch
            ? [
                `Source URL: ${contextMatch[1]}`,
                `Selected text: ${contextMatch[2]}`,
                `User prompt: ${userContent}`
            ].join('\n\n')
            : `User prompt: ${userContent}`;

        return [
            { role: 'system', parts: [{ type: 'text', content: SYSTEM_PROMPT }] },
            {
                role: 'user',
                parts: [{ type: 'text', content: body }],
                ...(userMessage.files?.length && { files: userMessage.files })
            }
        ];
    }

    async renameSingleChat(chatId, displayElement = null) {
        const chat = await this.chatStorage.loadChat(chatId, 2);
        if (!chat || chat.messages.length < 2) return null;

        const [systemMessage, userMessage] = chat.messages;
        if (systemMessage.role !== 'system' || userMessage.role !== 'user') return null;

        const systemContent = systemMessage.contents?.[0]?.at(-1)?.content || '';
        const messages = this.prepareMessages(systemContent, userMessage);

        const result = displayElement
            ? await this.renameUI(displayElement, messages)
            : await this.generate(messages, new StreamWriterBase(null));

        if (result?.newName) {
            await this.chatStorage.renameChat(chatId, result.newName, this.announceUpdate);
        }

        return result;
    }

    autoRename(chatId, displayElement) {
        if (!this.allowAutoRename || !this.state.getSetting('auto_rename')) {
            return null;
        }
        return this.renameSingleChat(chatId, displayElement);
    }

    async renameAllUnmodified() {
        const metadataList = await this.chatStorage.getChatMetadata(Infinity);
        const unmodified = metadataList.filter(chat => !chat.renamed);

        const modelId = this.getModel();
        const tokenCounter = new TokenCounter(this.api.getProviderName(modelId));

        if (!unmodified.length) return { status: 'no_chats', tokenCounter };

        let successCount = 0;
        await Promise.all(unmodified.map(async chat => {
            const chatElement = document.getElementById(chat.chatId);
            const titleElement = chatElement?.querySelector('.item-text');

            const result = await this.renameSingleChat(chat.chatId, titleElement);
            if (result) {
                successCount++;
                tokenCounter.inputTokens += result.tokenCounter.inputTokens;
                tokenCounter.outputTokens += result.tokenCounter.outputTokens;
            }
        }));

        return {
            status: 'success',
            tokenCounter,
            successCount,
            totalCount: unmodified.length
        };
    }
}
