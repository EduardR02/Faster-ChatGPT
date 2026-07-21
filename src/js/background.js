import { getMode, isOn, mergeNewDefaultModels, setDefaults } from "./storage_utils.js";

const PANEL_PATH = chrome.runtime.getURL("src/html/sidepanel.html");
const getPageContextRequestKey = (windowId) => `page_context_request_window_${windowId}`;
const PAGE_CONTEXT_REQUEST_NONCE_KEY = 'page_context_request_nonce';
const PAGE_CONTEXT_REQUEST_TTL_MS = 10000;
const PAGE_CONTEXT_RESPONSE_TIMEOUT_MS = 4000;
const PANEL_READY_TIMEOUT_MS = 5000;

const pendingPageContextRequests = new Map();

const getPendingPageContextToken = (windowId, requestId) => `${windowId}:${requestId}`;

const resolvePendingPageContextRequest = (windowId, requestId, context) => {
    const token = getPendingPageContextToken(windowId, requestId);
    const pending = pendingPageContextRequests.get(token);
    if (!pending) {
        return false;
    }

    clearTimeout(pending.timeoutId);
    pendingPageContextRequests.delete(token);
    pending.sendResponse({ ok: true, context: context || null });
    return true;
};

const createPendingPageContextRequest = (windowId, requestId, sendResponse) => {
    const token = getPendingPageContextToken(windowId, requestId);
    const timeoutId = setTimeout(() => {
        pendingPageContextRequests.delete(token);
        chrome.storage.session.remove(getPageContextRequestKey(windowId)).catch(() => {});
        sendResponse({ ok: false, timedOut: true });
    }, PAGE_CONTEXT_RESPONSE_TIMEOUT_MS);

    pendingPageContextRequests.set(token, { sendResponse, timeoutId });
};

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
    } else if (details.reason === chrome.runtime.OnInstalledReason.UPDATE) {
        await mergeNewDefaultModels();
    }
});

chrome.commands.onCommand.addListener(async (command, tab) => {
    if (command === "new-chat") {
        try {
            const windowId = await openPanel(tab);
            chrome.runtime.sendMessage({ type: "new_chat", targetWindowId: windowId }).catch(() => {});
        } catch (error) {
            console.error("Failed to open side panel:", error);
        }
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
            openPanel(sender?.tab, message.windowId)
                .then(windowId => sendResponse({ ok: true, windowId }))
                .catch(error => sendResponse({ ok: false, error: error?.message || String(error) }));
            return true;

        case "is_sidepanel_open":
            resolveTargetWindowId(sender?.tab, message.windowId)
                .then(isSidePanelOpen)
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

            chrome.storage.session.get(requestKey)
                .then(result => {
                    const request = result[requestKey];
                    if (!request || request.id !== message.requestId || request.expiresAt < Date.now()) {
                        sendResponse({ ok: false, ignored: true });
                        return null;
                    }

                    return chrome.storage.session.remove(requestKey).then(() => {
                        resolvePendingPageContextRequest(windowId, message.requestId, message.context || null);
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
                [getPageContextRequestKey(windowId)]: {
                    id: requestId,
                    expiresAt: Date.now() + PAGE_CONTEXT_REQUEST_TTL_MS
                }
            }).then(() => chrome.storage.local.set({
                [PAGE_CONTEXT_REQUEST_NONCE_KEY]: Date.now()
            })).then(() => createPendingPageContextRequest(windowId, requestId, sendResponse))
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
    Array.from(pendingPageContextRequests.keys())
        .filter(token => token.startsWith(`${windowId}:`))
        .forEach(token => {
            const pending = pendingPageContextRequests.get(token);
            if (!pending) return;
            clearTimeout(pending.timeoutId);
            pendingPageContextRequests.delete(token);
            pending.sendResponse({ ok: false, cancelled: true });
        });

    chrome.storage.session.remove([
        getPageContextRequestKey(windowId)
    ]).catch(() => {});
});

const isConcreteWindowId = windowId => Number.isInteger(windowId) && windowId >= 0;
const getConcreteWindowId = (tab, requestedWindowId) => {
    if (isConcreteWindowId(requestedWindowId)) return requestedWindowId;
    if (isConcreteWindowId(tab?.windowId)) return tab.windowId;
    return null;
};

async function resolveTargetWindowId(tab, requestedWindowId) {
    const windowId = getConcreteWindowId(tab, requestedWindowId);
    if (windowId != null) return windowId;

    const focusedWindow = await chrome.windows.getLastFocused();
    if (!isConcreteWindowId(focusedWindow?.id)) {
        throw new Error("No target window is available");
    }
    return focusedWindow.id;
}

const getPanelContexts = windowId => chrome.runtime.getContexts({
    contextTypes: ["SIDE_PANEL"],
    documentUrls: [PANEL_PATH],
    windowIds: [windowId]
});

async function isReadyMessageFromTarget(message, sender, windowId) {
    if (message.type !== "sidepanel_ready" || message.windowId !== windowId || !sender?.documentId) {
        return false;
    }

    const contexts = await getPanelContexts(windowId);
    return contexts.some(context => context.documentId === sender.documentId);
}

function createPanelReadyWaiter(windowId, timeoutMs) {
    let settled = false;
    let timeoutId;
    let finish;

    const cleanup = () => {
        chrome.runtime.onMessage.removeListener(listener);
        clearTimeout(timeoutId);
    };
    const complete = callback => {
        if (settled) return;
        settled = true;
        cleanup();
        callback();
    };
    const promise = new Promise((resolve, reject) => {
        finish = resolve;
        timeoutId = setTimeout(() => complete(() => reject(new Error(`Side panel in window ${windowId} did not become ready`))), timeoutMs);
    });
    const listener = (message, sender) => {
        if (message.type !== "sidepanel_ready" || message.windowId !== windowId) return;
        void isReadyMessageFromTarget(message, sender, windowId).then(isTarget => {
            if (isTarget) complete(() => finish(true));
        });
    };

    chrome.runtime.onMessage.addListener(listener);
    return {
        promise,
        cancel: () => complete(() => finish(false))
    };
}

async function openPanelInWindow(windowId, timeoutMs) {
    const readiness = createPanelReadyWaiter(windowId, timeoutMs);

    try {
        const enableRequest = chrome.sidePanel.setOptions({
            path: PANEL_PATH,
            enabled: true
        });
        const openRequest = chrome.sidePanel.open({ windowId });

        chrome.runtime.sendMessage({
            type: "probe_sidepanel_ready",
            windowId
        }).catch(() => {});

        await Promise.all([enableRequest, openRequest, readiness.promise]);
        return windowId;
    } catch (error) {
        readiness.cancel();
        throw error;
    }
}

export function openPanel(tab, requestedWindowId, timeoutMs = PANEL_READY_TIMEOUT_MS) {
    const windowId = getConcreteWindowId(tab, requestedWindowId);
    if (windowId != null) {
        return openPanelInWindow(windowId, timeoutMs);
    }
    return resolveTargetWindowId(tab, requestedWindowId)
        .then(resolvedWindowId => openPanelInWindow(resolvedWindowId, timeoutMs));
}

async function isSidePanelOpen(windowId) {
    const contexts = await getPanelContexts(windowId);
    return contexts.length > 0;
}
