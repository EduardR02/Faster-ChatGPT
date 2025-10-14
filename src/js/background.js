import { get_mode, is_on, set_defaults } from "./utils.js";

const SIDE_PANEL_PATH = chrome.runtime.getURL("src/html/sidepanel.html");

chrome.runtime.onInstalled.addListener((details) => {
    if (details.reason === chrome.runtime.OnInstalledReason.INSTALL) {
        set_defaults().then(() => {
            chrome.runtime.openOptionsPage();
        });
    }
});

// Handle keyboard shortcuts
chrome.commands.onCommand.addListener(async (command, tab) => {
    if (command === "new-chat") {
        await openSidePanel(tab);
        // Broadcast the message - sidepanel will receive it
        chrome.runtime.sendMessage({ type: "new_chat" }).catch(() => {});
    } else if (command === "open-history") {
        chrome.tabs.create({ url: chrome.runtime.getURL("src/html/history.html") });
    }
});

// Handle messages
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    switch (msg.type) {
        case "open_side_panel":
            openSidePanel(sender?.tab).then(() => sendResponse({ ok: true }));
            return true;

        case "is_sidepanel_open":
            isSidePanelOpen().then((isOpen) => sendResponse({ isOpen }));
            return true;

        case "close_side_panel":
            chrome.sidePanel.setOptions({
                path: SIDE_PANEL_PATH,
                enabled: false,
            });
            return;

        case "is_mode_on":
            get_mode((current_mode) => {
                sendResponse({ is_mode_on: is_on(current_mode) });
            });
            return true;
    }
});

/**
 * Opens the sidepanel and waits for it to be ready
 * Returns immediately if already open (fast path)
 */
async function openSidePanel(tab) {
    // Enable the sidepanel
    chrome.sidePanel.setOptions({
        path: SIDE_PANEL_PATH,
        enabled: true,
    });

    // Start checking if already open (don't await yet - run in parallel)
    const alreadyOpenPromise = isSidePanelOpen();

    // Open sidepanel immediately (MUST be synchronous to preserve user gesture)
    if (tab?.windowId) {
        chrome.sidePanel.open({ windowId: tab.windowId });
    } else {
        chrome.windows.getLastFocused((window) => {
            chrome.sidePanel.open({ windowId: window.id });
        });
    }

    // Now await to see if it was already open
    const alreadyOpen = await alreadyOpenPromise;
    if (alreadyOpen) {
        // Already open - return immediately (instant!)
        return;
    }

    // Was closed - wait for ready signal from newly opened panel
    return new Promise((resolve) => {
        const listener = (message) => {
            if (message.type === "sidepanel_ready") {
                chrome.runtime.onMessage.removeListener(listener);
                resolve();
            }
        };
        chrome.runtime.onMessage.addListener(listener);

        // Timeout after 3 seconds
        setTimeout(() => {
            chrome.runtime.onMessage.removeListener(listener);
            resolve();
        }, 3000);
    });
}

/**
 * Check if sidepanel is currently open
 */
function isSidePanelOpen() {
    return new Promise((resolve) => {
        chrome.runtime.getContexts({ contextTypes: ["SIDE_PANEL"] }, (contexts) => {
            resolve(contexts.length > 0);
        });
    });
}
