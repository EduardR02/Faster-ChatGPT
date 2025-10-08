import { get_mode, is_on, set_defaults } from "./utils.js";

// relative path also does not work here
const sidepanel_path = "src/html/sidepanel.html";
let lastKnownWindowId = chrome.windows.WINDOW_ID_NONE;
const sidepanelReadyWaiters = new Set();

initializeWindowTracking();

chrome.runtime.onInstalled.addListener(function(details) {
    // set default
    if (details.reason === chrome.runtime.OnInstalledReason.INSTALL) {
        set_defaults().then(() => {
            chrome.runtime.openOptionsPage();
        });
    }
});

// Keyboard shortcuts
chrome.commands.onCommand.addListener(async (command, tab) => {
    try {
        switch (command) {
            case 'new-chat':
                await openSidePanelFor(tab);
                await waitForSidepanelReady();
                chrome.runtime.sendMessage({ type: 'new_chat' });
                break;
            case 'open-history':
                chrome.tabs.create({ url: chrome.runtime.getURL('src/html/history.html') });
                break;
        }
    } catch (error) {
        console.error(`Command ${command} failed`, error);
    }
});


chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'sidepanel_ready') {
        sidepanelReadyWaiters.forEach((listener) => listener());
        return;
    }

    if (msg.type === 'open_side_panel') {
        openSidePanelFor(sender?.tab)
            .then(() => sendResponse({ ok: true }))
            .catch((error) => {
                console.error('Failed to open side panel via message', error);
                sendResponse({ ok: false, error: error?.message ?? 'unknown error' });
            });
        return true;
    }
    else if (msg.type === 'is_sidepanel_open') {
        isSidePanelOpen().then(isOpenCurr => {sendResponse({ isOpen: isOpenCurr });});
        return true; // Asynchronous response expected
    }
    else if (msg.type === 'close_side_panel') {
        chrome.sidePanel.setOptions({
            path: sidepanel_path,
            enabled: false
        });
    }
    else if (msg.type === 'is_mode_on') {
        get_mode(function(current_mode) {
            sendResponse({ is_mode_on: is_on(current_mode) });
        });
        return true; // Asynchronous response expected
    }
});
function openSidePanelFor(tab) {
    const windowId = pickWindowId(tab);

    if (windowId !== null) {
        chrome.sidePanel.setOptions({
            path: sidepanel_path,
            enabled: true
        });
        return chrome.sidePanel.open({ windowId });
    }

    return new Promise((resolve, reject) => {
        chrome.windows.getLastFocused({ populate: false }, (window) => {
            if (chrome.runtime.lastError) {
                reject(chrome.runtime.lastError);
                return;
            }

            const resolvedId = pickWindowId(window);
            const targetWindowId = resolvedId ?? chrome.windows.WINDOW_ID_CURRENT;

            chrome.sidePanel.setOptions({
                path: sidepanel_path,
                enabled: true
            });

            chrome.sidePanel.open({ windowId: targetWindowId })
                .then(resolve)
                .catch(reject);
        });
    });
}


function isSidePanelOpen() {
    return new Promise(resolve => {
        chrome.runtime.getContexts({ contextTypes: ["SIDE_PANEL"] }, contexts => {
            resolve(contexts.length > 0);
        });
    });
}

function pickWindowId(source) {
    if (!source) return null;

    const candidates = [];

    if (typeof source === 'number') {
        candidates.push(source);
    } else {
        if (typeof source.windowId === 'number') {
            candidates.push(source.windowId);
        }
        if (typeof source.id === 'number') {
            candidates.push(source.id);
        }
    }

    candidates.push(lastKnownWindowId);

    for (const id of candidates) {
        if (typeof id === 'number' && id !== chrome.windows.WINDOW_ID_NONE) {
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

function waitForSidepanelReady() {
    return new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => {
            sidepanelReadyWaiters.delete(listener);
            reject(new Error('Timed out waiting for side panel'));
        }, 2000);

        const listener = () => {
            clearTimeout(timeoutId);
            sidepanelReadyWaiters.delete(listener);
            resolve();
        };

        sidepanelReadyWaiters.add(listener);
    });
}