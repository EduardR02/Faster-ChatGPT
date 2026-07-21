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
