import { getMode, isOn, mergeNewDefaultModels, setDefaults } from "./storage_utils.js";
import { requestPageContextForWindow } from './page_context_request.js';

const PANEL_PATH = chrome.runtime.getURL("src/html/sidepanel.html");
const PANEL_READY_TIMEOUT_MS = 5000;

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
            const target = await openPanel(tab);
            const response = await chrome.runtime.sendMessage({
                type: "new_chat",
                targetWindowId: target.windowId,
                targetReceiverToken: target.receiverToken
            });
            if (!response?.ok) throw new Error(response?.error || "Side panel rejected new chat");
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
                .then(target => sendResponse({ ok: true, ...target }))
                .catch(error => sendResponse({ ok: false, error: error?.message || String(error) }));
            return true;

        case "register_sidepanel_receiver":
            if (
                !isSidepanelPage(sender)
                || sender.tab != null
                || !isConcreteWindowId(message.windowId)
                || !isReceiverToken(message.receiverToken)
            ) {
                sendResponse({ ok: false });
                return false;
            }
            sendResponse({ ok: true, receiverToken: message.receiverToken });
            return false;

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

        case 'request_page_context_for_window': {
            const windowId = message.windowId;
            if (!isConcreteWindowId(windowId)) {
                sendResponse({ ok: false });
                return false;
            }

            requestPageContextForWindow(windowId).then(context => {
                if (context === undefined) {
                    sendResponse({ ok: false });
                    return;
                }
                sendResponse({ ok: true, context });
            });
            return true;
        }
    }
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

const isSidepanelPage = sender => sender?.url === PANEL_PATH;
const isReceiverToken = token => typeof token === "string" && token.length >= 32;
const isReadyMessageFromTarget = (message, sender, windowId) => (
    message.type === "sidepanel_ready"
    && message.windowId === windowId
    && isReceiverToken(message.receiverToken)
    && isSidepanelPage(sender)
    && sender.tab == null
);

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
        if (isReadyMessageFromTarget(message, sender, windowId)) {
            complete(() => finish(message.receiverToken));
        }
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

        const [, , receiverToken] = await Promise.all([enableRequest, openRequest, readiness.promise]);
        return { windowId, receiverToken };
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
