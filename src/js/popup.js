import { ModeEnum, getMode, setMode, isOn, getLifetimeTokens } from "./storage_utils.js";

const getElement = (id) => document.getElementById(id);

document.addEventListener('DOMContentLoaded', () => {
    const modeButton = getElement("buttonMode");
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
    
    getElement("buttonChat").onclick = openSidePanel;
    
    getElement("buttonHistory").onclick = () => {
        const historyUrl = chrome.runtime.getURL('src/html/history.html');
        chrome.tabs.create({ url: historyUrl });
    };

    // Load Initial Data
    getLifetimeTokens((tokens) => {
        tokensDisplay.innerText = `${tokens.input} | ${tokens.output}`;
    });
    
    getMode(updateUI);
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

async function openSidePanel() {
    const modeOn = await new Promise(resolve => getMode(mode => resolve(isOn(mode))));
    if (!modeOn) return;

    const { isOpen } = await chrome.runtime.sendMessage({ type: "is_sidepanel_open" });
    const wasClosed = !isOpen;

    // Open sidepanel via background (which has proper permissions)
    await chrome.runtime.sendMessage({ type: "open_side_panel" });
    
    // Optional: notify of a new chat
    chrome.runtime.sendMessage({ type: "new_chat" }).catch(() => {});
    
    // Close the popup only if we opened the panel
    if (wasClosed) {
        window.close();
    }
}

function toggleMode(callback) {
    chrome.storage.local.get('mode', (result) => {
        const currentMode = result.mode;
        const totalModes = Object.keys(ModeEnum).length;
        
        const nextMode = currentMode !== undefined 
            ? (currentMode + 1) % totalModes 
            : ModeEnum.Off;
            
        setMode(nextMode); 
        callback(nextMode);
    });
}
