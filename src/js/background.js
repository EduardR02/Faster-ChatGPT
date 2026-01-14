import { getMode, isOn, setDefaults } from "./storage_utils.js";

const PANEL_PATH = chrome.runtime.getURL("src/html/sidepanel.html");

let lifetimeTokensUpdate = Promise.resolve();
const applyLifetimeTokensDelta = (inputDelta = 0, outputDelta = 0) => {
    lifetimeTokensUpdate = lifetimeTokensUpdate
        .then(() => new Promise(resolve => {
            chrome.storage.local.get(['lifetime_input_tokens', 'lifetime_output_tokens'], result => {
                chrome.storage.local.set({
                    lifetime_input_tokens: (result.lifetime_input_tokens || 0) + inputDelta,
                    lifetime_output_tokens: (result.lifetime_output_tokens || 0) + outputDelta
                }, resolve);
            });
        }))
        .catch(() => {});
    return lifetimeTokensUpdate;
};

chrome.runtime.onInstalled.addListener(async (details) => {
    if (details.reason === chrome.runtime.OnInstalledReason.INSTALL) {
        await setDefaults();
        chrome.runtime.openOptionsPage();
    }
});

chrome.commands.onCommand.addListener(async (command, tab) => {
    if (command === "new-chat") {
        await openPanel(tab);
        // Fire and forget, but catch errors if no one is listening
        chrome.runtime.sendMessage({ type: "new_chat" }).catch(() => {});
    } else if (command === "open-history") {
        const historyUrl = chrome.runtime.getURL("src/html/history.html");
        chrome.tabs.create({ url: historyUrl });
    }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    switch (message.type) {
        case "increment_lifetime_tokens":
            applyLifetimeTokensDelta(message.inputDelta || 0, message.outputDelta || 0)
                .then(() => sendResponse({ ok: true }))
                .catch(() => sendResponse({ ok: false }));
            return true;
        case "open_side_panel":
            openPanel(sender?.tab)
                .then(() => sendResponse({ ok: true }))
                .catch(() => sendResponse({ ok: false }));
            return true;

        case "is_sidepanel_open":
            isSidePanelOpen()
                .then(isOpen => sendResponse({ isOpen }))
                .catch(() => sendResponse({ isOpen: false }));
            return true;

        case "close_side_panel":
            chrome.sidePanel.setOptions({ 
                path: PANEL_PATH, 
                enabled: false 
            }).catch(() => {});
            break;

        case "is_mode_on":
            getMode(mode => {
                sendResponse({ is_mode_on: isOn(mode) });
            });
            return true;
    }
});

async function openPanel(tab) {
    // Ensure sidepanel is enabled
    chrome.sidePanel.setOptions({
        path: PANEL_PATH,
        enabled: true
    }).catch(() => {});

    // Check if already open BEFORE calling open() to avoid race condition
    const alreadyOpenPromise = isSidePanelOpen();

    // Open sidepanel immediately (MUST be synchronous to preserve user gesture context)
    if (tab?.windowId) {
        chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
    } else {
        chrome.windows.getLastFocused(window => {
            if (window?.id) {
                chrome.sidePanel.open({ windowId: window.id }).catch(() => {});
            }
        });
    }

    // Now check if it was already open
    if (await alreadyOpenPromise) {
        return; // Already open - no need to wait
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
        // Timeout after 3 seconds to avoid hanging
        setTimeout(() => {
            chrome.runtime.onMessage.removeListener(listener);
            resolve();
        }, 3000);
    });
}

async function isSidePanelOpen() {
    const contexts = await new Promise(resolve => {
        chrome.runtime.getContexts({ contextTypes: ["SIDE_PANEL"] }, resolve);
    });
    return contexts.length > 0;
}
