import { ModeEnum, getMode, setMode, isOn, getLifetimeTokens } from "./storage_utils.js";
import { openSidePanelWithHandoff } from "./sidepanel_handoff.js";

const getElement = (id) => document.getElementById(id);
let currentWindowPromise;
let currentWindowId;
const getCurrentWindowId = () => {
    currentWindowPromise ||= chrome.windows.getCurrent().then(window => {
        currentWindowId = window.id;
        return currentWindowId;
    });
    return currentWindowPromise;
};
let currentMode;
let modeLoaded = false;
let currentModePromise;
const getCurrentMode = () => {
    currentModePromise ||= new Promise(resolve => getMode(mode => {
        currentMode = mode;
        modeLoaded = true;
        resolve(mode);
    }));
    return currentModePromise;
};

void getCurrentWindowId().catch(() => {});
void getCurrentMode();

document.addEventListener('DOMContentLoaded', () => {
    const modeButton = getElement("buttonMode");
    const chatButton = getElement("buttonChat");
    const tokensDisplay = getElement("tokensValue");

    // Mode Toggle
    modeButton.onclick = () => {
        toggleMode((newMode) => {
            updateUI(newMode);
        });
    };

    // Navigation Buttons
    getElement("buttonSettings").onclick = () => {
        chrome.runtime.openOptionsPage();
    };
    
    chatButton.disabled = true;
    chatButton.onclick = openSidePanel;
    void Promise.all([getCurrentWindowId(), getCurrentMode()])
        .then(() => { chatButton.disabled = false; })
        .catch(() => {});
    
    getElement("buttonHistory").onclick = () => {
        const historyUrl = chrome.runtime.getURL('src/html/history.html');
        chrome.tabs.create({ url: historyUrl });
    };

    // Load Initial Data
    getLifetimeTokens((tokens) => {
        tokensDisplay.innerText = `${tokens.input} | ${tokens.output}`;
    });
    
    void getCurrentMode().then(updateUI);
});

function updateUI(mode) {
    const isModeOn = isOn(mode);
    const modeButton = getElement("buttonMode");
    const modeLabels = [
        "Instant Prompt Mode ", 
        "Prompt Mode ", 
        "Off "
    ];
    
    modeButton.innerHTML = `<span>${modeLabels[mode]}</span>`;
    
    // Update button colors based on mode
    const allButtons = document.querySelectorAll('.button');
    allButtons.forEach(button => {
        const primaryColor = isModeOn ? "#61afef" : "#ef596f";
        const secondaryColor = isModeOn ? "#ef596f" : "#61afef";
        
        button.style.setProperty("--check-primary", primaryColor);
        button.style.setProperty("--check-secondary", secondaryColor);
    });
}

export async function openSidePanel() {
    if (!modeLoaded) await getCurrentMode();
    if (!isOn(currentMode)) return false;

    let response;
    try {
        const windowId = currentWindowId ?? await getCurrentWindowId();
        response = await openSidePanelWithHandoff({ type: "new_chat" }, windowId);
    } catch (error) {
        response = { ok: false, error: error?.message || String(error) };
    }
    if (!response.ok) {
        console.error("Failed to open side panel:", response.error || "Unknown error");
        return false;
    }

    window.close();
    return true;
}

function toggleMode(callback) {
    chrome.storage.local.get('mode', (result) => {
        const storedMode = result.mode;
        const totalModes = Object.keys(ModeEnum).length;
        
        const nextMode = storedMode !== undefined
            ? (storedMode + 1) % totalModes
            : ModeEnum.Off;
            
        currentMode = nextMode;
        setMode(nextMode); 
        callback(nextMode);
    });
}
