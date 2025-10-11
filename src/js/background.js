import { get_mode, is_on, set_defaults } from "./utils.js";

const SIDE_PANEL_PATH = chrome.runtime.getURL("src/html/sidepanel.html");
let lastKnownWindowId = chrome.windows.WINDOW_ID_NONE;
let sidepanelReady = false;
let isOpeningSidepanel = false;
const sidepanelReadyWaiters = new Set();
const pendingSidepanelMessages = [];
const SIDE_PANEL_MESSAGE_FLAG = "__bgSidepanelDispatch__";

initializeWindowTracking();

chrome.runtime.onInstalled.addListener((details) => {
    if (details.reason === chrome.runtime.OnInstalledReason.INSTALL) {
        set_defaults().then(() => {
            chrome.runtime.openOptionsPage();
        });
    }
});

chrome.commands.onCommand.addListener(async (command, tab) => {
    try {
        switch (command) {
            case "new-chat": {
                triggerSidepanelOpen(tab);
                await waitForSidepanelReady();
                chrome.runtime.sendMessage({ type: "new_chat" });
                break;
            }
            case "open-history":
                chrome.tabs.create({ url: chrome.runtime.getURL("src/html/history.html") });
                break;
        }
    } catch (error) {
        console.error(`Command ${command} failed`, error);
    }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    switch (msg.type) {
        case "sidepanel_ready":
            handleSidepanelReady();
            return;
        case "open_side_panel":
            handleSidepanelOpenRequest(sender?.tab, sendResponse);
            return true;
        case "close_side_panel":
            handleSidepanelClosed();
            return;
        case "is_sidepanel_open":
            isSidePanelOpen().then((isOpenCurr) => {
                if (!isOpenCurr) {
                    sidepanelReady = false;
                }
                sendResponse({ isOpen: isOpenCurr });
            });
            return true;
        case "new_selection":
        case "reconstruct_chat":
        case "new_chat":
            queueSidepanelDispatch(msg);
            return true;
        case "is_mode_on":
            get_mode((current_mode) => {
                sendResponse({ is_mode_on: is_on(current_mode) });
            });
            return true;
        default:
            break;
    }
});

function handleSidepanelOpenRequest(tab, sendResponse) {
    triggerSidepanelOpen(tab);

    waitForSidepanelReady()
        .then(() => sendResponse?.({ ok: true }))
        .catch((error) => {
            console.error("Failed to open side panel via message", error);
            sendResponse?.({ ok: false, error: error?.message ?? "unknown error" });
        });
}

function handleSidepanelReady() {
    sidepanelReady = true;
    isOpeningSidepanel = false;

    if (sidepanelReadyWaiters.size) {
        const waiters = Array.from(sidepanelReadyWaiters);
        sidepanelReadyWaiters.clear();
        waiters.forEach((waiter) => waiter.resolve());
    }

    flushPendingSidepanelMessages();
}

function handleSidepanelClosed() {
    sidepanelReady = false;
    isOpeningSidepanel = false;
    pendingSidepanelMessages.length = 0;

    chrome.sidePanel.setOptions({
        path: SIDE_PANEL_PATH,
        enabled: false,
    });
}

function queueSidepanelDispatch(message) {
    if (message?.[SIDE_PANEL_MESSAGE_FLAG]) {
        return;
    }

    if (sidepanelReady) {
        deliverToSidepanel(message);
        return;
    }

    pendingSidepanelMessages.push(message);

    waitForSidepanelReady().catch((error) => {
        console.error("Failed to wait for side panel readiness", error);
        pendingSidepanelMessages.length = 0;
    });
}

function triggerSidepanelOpen(tab) {
    if (sidepanelReady || isOpeningSidepanel) {
        return;
    }

    isOpeningSidepanel = true;
    sidepanelReady = false;

    const windowId = resolveWindowId(tab);

    chrome.sidePanel.setOptions({
        path: SIDE_PANEL_PATH,
        enabled: true,
    });

    try {
        const maybePromise = chrome.sidePanel.open({ windowId });
        if (maybePromise && typeof maybePromise.catch === "function") {
            maybePromise.catch(handleSidepanelOpenFailure);
        }
    } catch (error) {
        handleSidepanelOpenFailure(error);
    }
}

function handleSidepanelOpenFailure(error) {
    console.error("chrome.sidePanel.open failed", error);
    isOpeningSidepanel = false;
    rejectAllWaiters(error);
}

function waitForSidepanelReady(timeout = 2000) {
    if (sidepanelReady) {
        return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
        const waiter = {
            resolve: () => {
                clearTimeout(waiter.timerId);
                sidepanelReadyWaiters.delete(waiter);
                resolve();
            },
            reject: (error) => {
                clearTimeout(waiter.timerId);
                sidepanelReadyWaiters.delete(waiter);
                reject(error);
            },
        };

        waiter.timerId = setTimeout(() => {
            waiter.reject(new Error("Timed out waiting for side panel"));
        }, timeout);

        sidepanelReadyWaiters.add(waiter);
    });
}

function flushPendingSidepanelMessages() {
    if (!sidepanelReady || pendingSidepanelMessages.length === 0) {
        return;
    }

    const messages = pendingSidepanelMessages.splice(0, pendingSidepanelMessages.length);
    messages.forEach((message) => deliverToSidepanel(message));
}

function deliverToSidepanel(message) {
    const payload = { ...message, [SIDE_PANEL_MESSAGE_FLAG]: true };
    const result = chrome.runtime.sendMessage(payload);
    if (result && typeof result.catch === "function") {
        result.catch((error) => {
            console.error("Failed to deliver message to sidepanel", error);
        });
    }
}

function rejectAllWaiters(error) {
    if (!sidepanelReadyWaiters.size) {
        return;
    }

    const waiters = Array.from(sidepanelReadyWaiters);
    sidepanelReadyWaiters.clear();
    waiters.forEach((waiter) => waiter.reject(error));
}

function isSidePanelOpen() {
    return new Promise((resolve) => {
        chrome.runtime.getContexts({ contextTypes: ["SIDE_PANEL"] }, (contexts) => {
            resolve(contexts.length > 0);
        });
    });
}

function resolveWindowId(source) {
    const candidate = pickWindowId(source);
    if (candidate !== null) {
        return candidate;
    }
    if (lastKnownWindowId !== chrome.windows.WINDOW_ID_NONE) {
        return lastKnownWindowId;
    }
    return chrome.windows.WINDOW_ID_CURRENT;
}

function pickWindowId(source) {
    if (!source) return null;

    const candidates = [];

    if (typeof source === "number") {
        candidates.push(source);
    } else {
        if (typeof source.windowId === "number") {
            candidates.push(source.windowId);
        }
        if (typeof source.id === "number") {
            candidates.push(source.id);
        }
    }

    candidates.push(lastKnownWindowId);

    for (const id of candidates) {
        if (typeof id === "number" && id !== chrome.windows.WINDOW_ID_NONE) {
            return id;
        }
    }

    return null;
}

function initializeWindowTracking() {
    chrome.windows.getLastFocused({ populate: false }, (window) => {
        const id = pickWindowId(window);
        if (id !== null) {
            lastKnownWindowId = id;
        }
    });

    chrome.windows.onFocusChanged.addListener((windowId) => {
        if (windowId !== chrome.windows.WINDOW_ID_NONE) {
            lastKnownWindowId = windowId;
        }
    });

    chrome.tabs.onActivated.addListener((activeInfo) => {
        const id = pickWindowId(activeInfo);
        if (id !== null) {
            lastKnownWindowId = id;
        }
    });
}
