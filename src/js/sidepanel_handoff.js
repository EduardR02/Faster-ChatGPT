export async function openSidePanelWithHandoff(message, windowId = null) {
    try {
        const request = { type: 'open_side_panel' };
        if (windowId != null) request.windowId = windowId;

        const response = await chrome.runtime.sendMessage(request);
        if (!response?.ok) {
            return response || { ok: false, error: 'Side panel did not open' };
        }

        const delivery = await chrome.runtime.sendMessage({
            ...message,
            targetWindowId: response.windowId,
            targetReceiverToken: response.receiverToken
        });
        if (!delivery?.ok) {
            return {
                ok: false,
                error: delivery?.error || 'Side panel did not acknowledge the handoff',
                windowId: response.windowId,
                receiverToken: response.receiverToken
            };
        }
        return response;
    } catch (error) {
        return { ok: false, error: error?.message || String(error) };
    }
}
