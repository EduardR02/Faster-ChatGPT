export async function requestPageContextForWindow(windowId) {
    if (!Number.isInteger(windowId) || windowId < 0) return undefined;

    const [activeTab] = await chrome.tabs.query({ active: true, windowId }).catch(() => []);
    if (!Number.isInteger(activeTab?.id)) return undefined;

    const response = await chrome.tabs.sendMessage(activeTab.id, { type: 'collect_page_context' }).catch(() => null);
    if (!response?.ok) return undefined;
    return response.context || null;
}
