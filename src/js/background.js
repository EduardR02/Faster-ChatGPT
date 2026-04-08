import { getMode, isOn, setDefaults } from "./storage_utils.js";

const PANEL_PATH = chrome.runtime.getURL("src/html/sidepanel.html");
const getPageContextStorageKey = (windowId) => `page_context_window_${windowId}`;
const getPageContextRequestKey = (windowId) => `page_context_request_window_${windowId}`;
const PAGE_CONTEXT_REQUEST_NONCE_KEY = 'page_context_request_nonce';
const PAGE_CONTEXT_REQUEST_TTL_MS = 10000;

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

        case "report_page_context": {
            const windowId = sender?.tab?.windowId;
            if (windowId == null) {
                sendResponse({ ok: false });
                return false;
            }

            const requestKey = getPageContextRequestKey(windowId);
            const contextKey = getPageContextStorageKey(windowId);

            chrome.storage.session.get(requestKey)
                .then(result => {
                    const request = result[requestKey];
                    if (!request || request.id !== message.requestId || request.expiresAt < Date.now()) {
                        sendResponse({ ok: false, ignored: true });
                        return null;
                    }

                    return chrome.storage.session.remove(requestKey)
                        .then(() => chrome.storage.session.set({ [contextKey]: message.context || null }))
                        .then(() => {
                            chrome.runtime.sendMessage({
                                type: 'page_context_updated',
                                windowId,
                                context: message.context || null
                            }).catch(() => {});

                            sendResponse({ ok: true });
                        });
                })
                .catch(() => sendResponse({ ok: false }));
            return true;
        }

        case 'request_page_context_for_window': {
            const requestId = `${Date.now()}_${Math.random()}`;
            const windowId = message.windowId;
            if (windowId == null) {
                sendResponse({ ok: false });
                return false;
            }

            chrome.storage.session.set({
                [getPageContextStorageKey(windowId)]: null,
                [getPageContextRequestKey(windowId)]: {
                    id: requestId,
                    expiresAt: Date.now() + PAGE_CONTEXT_REQUEST_TTL_MS
                }
            }).then(() => chrome.storage.local.set({
                [PAGE_CONTEXT_REQUEST_NONCE_KEY]: Date.now()
            })).then(() => sendResponse({ ok: true, requestId }))
                .catch(() => sendResponse({ ok: false }));
            return true;
        }

        case 'should_collect_page_context': {
            const windowId = sender?.tab?.windowId;
            if (windowId == null) {
                sendResponse({ requestId: null });
                return false;
            }

            const requestKey = getPageContextRequestKey(windowId);
            chrome.storage.session.get(requestKey)
                .then(result => {
                    const request = result[requestKey];
                    if (!request || request.expiresAt < Date.now()) {
                        if (request) {
                            chrome.storage.session.remove(requestKey).catch(() => {});
                        }
                        sendResponse({ requestId: null });
                        return;
                    }

                    sendResponse({ requestId: request.id });
                })
                .catch(() => sendResponse({ requestId: null }));
            return true;
        }
    }
});

chrome.windows.onRemoved.addListener(windowId => {
    chrome.storage.session.remove([
        getPageContextStorageKey(windowId),
        getPageContextRequestKey(windowId)
    ]).catch(() => {});
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
