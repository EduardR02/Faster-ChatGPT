import { get_mode, is_on, set_defaults } from "./utils.js";

// relative path also does not work here
let sidepanel_path = "src/html/sidepanel.html";

chrome.runtime.onInstalled.addListener(function(details) {
    // set default
    set_defaults();
});


chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'open_side_panel') {
        openSidePanelAndSendMessage(msg, sender);
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


async function openSidePanelAndSendMessage(msg, sender) {
    // this is necessary. If enabled was set to false, it won't open without
    // setting it to true first again, meaning .open() doesn't implicitly set it to true
    chrome.sidePanel.setOptions({
        path: sidepanel_path,
        enabled: true
    });
    // use windowid instead of tabid so you can switch tabs and ithe context is preserved
    chrome.sidePanel.open({ windowId: sender.tab.windowId });

    await new Promise(resolve => {
        chrome.runtime.onMessage.addListener(function listener(message) {
            if (message.type === "sidepanel_ready") {
                chrome.runtime.onMessage.removeListener(listener);
                resolve(); // Now you can safely send your message to the side panel
            }
        });
    });
    chrome.runtime.sendMessage({type: "new_selection", text: msg.text, url: msg.url});
}


function isSidePanelOpen() {
    return new Promise(resolve => {
        chrome.runtime.getContexts({ contextTypes: ["SIDE_PANEL"] }, contexts => {
            resolve(contexts.length > 0);
        });
    });
}