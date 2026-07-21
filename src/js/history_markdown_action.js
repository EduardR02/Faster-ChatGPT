export const runHistoryMarkdownAction = async ({
    button,
    pendingText,
    successText,
    operation,
    isCurrent,
    onError,
    scheduleClose
}) => {
    button.textContent = pendingText;
    try {
        const completed = await operation();
        if (!completed || !isCurrent()) return false;
        button.textContent = successText;
    } catch (error) {
        if (!isCurrent()) return false;
        onError(error);
        button.textContent = 'failed :(';
    }
    scheduleClose();
    return true;
};
