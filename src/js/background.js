import { get_mode, is_on, set_defaults } from "./utils.js";

// relative path also does not work here
let sidepanel_path = "src/html/sidepanel.html";

chrome.runtime.onInstalled.addListener(function(details) {
    // set default
    if (details.reason === chrome.runtime.OnInstalledReason.INSTALL) {
        set_defaults().then(() => {
            chrome.runtime.openOptionsPage();
        });
    }
});


chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'open_side_panel') {
        openSidePanel(sender).then(() => {sendResponse("dummy");});
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


async function openSidePanel(sender) {
    // this is necessary. If enabled was set to false, it won't open without
    // setting it to true first again, meaning .open() doesn't implicitly set it to true
    chrome.sidePanel.setOptions({
        path: sidepanel_path,
        enabled: true
    });
    if (sender && sender.tab) {
        chrome.sidePanel.open({ windowId: sender.tab.windowId });
    }
    else {
        chrome.windows.getLastFocused((window) => {
            chrome.sidePanel.open({ windowId: window.id });
        });
    }

    return new Promise(resolve => {
        chrome.runtime.onMessage.addListener(function listener(message) {
            if (message.type === "sidepanel_ready") {
                chrome.runtime.onMessage.removeListener(listener);
                resolve(); // Now you can safely send your message to the side panel
            }
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