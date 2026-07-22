export const attachHistoryPopupTrigger = (trigger, { isOpen, open, close, focusTarget }) => {
    const toggle = (event, focusPopup) => {
        event.stopPropagation();
        if (isOpen()) {
            close();
            return;
        }
        open();
        if (focusPopup) focusTarget()?.focus();
    };

    trigger.addEventListener('click', event => toggle(event, false));
    trigger.addEventListener('keydown', event => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        toggle(event, true);
    });
};

export const attachHistoryPopupEscape = (popup, close) => {
    popup.addEventListener('keydown', event => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        close();
    });
    // Mouse-opened popups keep focus outside the popup, so Escape only reaches the document.
    popup.ownerDocument.addEventListener('keydown', event => {
        if (event.key !== 'Escape' || !popup.classList.contains('active')) return;
        event.preventDefault();
        close();
    });
};

export const focusHistoryPopupTrigger = (historyItem) => {
    const trigger = historyItem?.querySelector('.action-dots');
    if (trigger?.isConnected) trigger.focus();
};
