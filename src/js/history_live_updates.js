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
