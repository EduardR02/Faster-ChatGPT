export async function openSidePanelWithHandoff(message, windowId = null) {
    try {
        const request = { type: 'open_side_panel' };
        if (windowId != null) request.windowId = windowId;

        const response = await chrome.runtime.sendMessage(request);
        if (!response?.ok) {
            return response || { ok: false, error: 'Side panel did not open' };
        }

        await chrome.runtime.sendMessage({
            ...message,
            targetWindowId: response.windowId
        });
        return response;
    } catch (error) {
        return { ok: false, error: error?.message || String(error) };
    }
}
