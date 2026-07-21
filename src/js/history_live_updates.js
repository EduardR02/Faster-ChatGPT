export function getMissingMessageRange(currentLength, incomingMessageId) {
    if (!Number.isInteger(currentLength) || currentLength < 0) return null;
    if (!Number.isInteger(incomingMessageId) || incomingMessageId < 0) return null;
    if (incomingMessageId < currentLength) return null;

    return {
        startIndex: currentLength,
        count: (incomingMessageId - currentLength) + 1
    };
}

export function getAppendFetchWindow(currentLength, startIndex, addedCount) {
    if (!Number.isInteger(currentLength) || currentLength < 0) return null;
    if (!Number.isInteger(startIndex) || startIndex < 0) return null;
    if (!Number.isInteger(addedCount) || addedCount <= 0) return null;

    const endIndex = startIndex + addedCount;
    if (endIndex <= currentLength) {
        return null;
    }

    const fetchStart = Math.max(currentLength, startIndex);
    return {
        startIndex: fetchStart,
        count: endIndex - fetchStart
    };
}

export function takeContiguousMessages(messages, startIndex) {
    if (!Array.isArray(messages) || messages.length === 0) return [];
    if (!Number.isInteger(startIndex) || startIndex < 0) return [];

    const contiguous = [];
    let expectedIndex = startIndex;

    for (let i = 0; i < messages.length; i++) {
        const message = messages[i];
        const messageIndex = Number.isInteger(message?.messageId)
            ? message.messageId
            : startIndex + i;

        if (messageIndex !== expectedIndex) {
            break;
        }

        contiguous.push(message);
        expectedIndex++;
    }

    return contiguous;
}

export function createLiveChatRequest(chatId, getChat, getActiveChatId) {
    const chat = getChat();
    if (chat?.chatId !== chatId || getActiveChatId() !== chatId) return null;
    return { chatId, chat };
}

export function ownsLiveChatRequest(request, getChat, getActiveChatId) {
    return !!request
        && getChat() === request.chat
        && getActiveChatId() === request.chatId;
}

export async function fetchAndApplyAppendedMessages({
    request,
    startIndex,
    addedCount,
    getChat,
    getActiveChatId,
    getMessages,
    applyUI,
    applyCore
}) {
    const ownsRequest = () => ownsLiveChatRequest(request, getChat, getActiveChatId);
    if (!ownsRequest()) return false;

    const appendWindow = getAppendFetchWindow(request.chat.messages.length, startIndex, addedCount);
    if (!appendWindow) return false;

    const fetchedMessages = await getMessages(request.chatId, appendWindow.startIndex);
    if (!ownsRequest()) return false;

    const messages = takeContiguousMessages(fetchedMessages, appendWindow.startIndex);
    if (!messages.length) return false;

    if (!ownsRequest()) return false;
    applyUI(messages, appendWindow.startIndex, request.chatId);
    if (!ownsRequest()) return false;
    applyCore(messages);
    return true;
}

export async function fetchAndApplyMessageUpdate({
    request,
    messageId,
    messageData,
    getChat,
    getActiveChatId,
    getMessage,
    acceptMessage,
    beforeRefresh,
    refreshHistory,
    applyMissingRange,
    applyUI,
    applyCore
}) {
    const ownsRequest = () => ownsLiveChatRequest(request, getChat, getActiveChatId);
    if (!ownsRequest()) return false;

    const message = messageData || await getMessage(request.chatId, messageId);
    if (!ownsRequest() || !message) return false;
    if (!acceptMessage(message)) return false;

    const missingRange = getMissingMessageRange(request.chat.messages.length, messageId);
    if (missingRange) {
        return applyMissingRange(request, missingRange, message);
    }

    if (!ownsRequest()) return false;
    beforeRefresh();
    await refreshHistory(message);
    if (!ownsRequest()) return false;

    applyUI(message, messageId, request.chatId);
    if (!ownsRequest()) return false;
    applyCore(message, messageId);
    return true;
}
