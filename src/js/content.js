let lastSelection = "";

const checkIsModeOn = (callback) => {
    chrome.runtime.sendMessage({ type: "is_mode_on" }, response => {
        callback(response.is_mode_on);
    });
};

const updateSelectionListener = () => {
    checkIsModeOn(isOn => {
        document.removeEventListener("mouseup", handleMouseUp);
        if (isOn) {
            document.addEventListener("mouseup", handleMouseUp);
        }
    });
};

async function handleMouseUp(event) {
    const selection = window.getSelection().toString().trim();
    const hasModifierKey = event.ctrlKey || event.metaKey;

    if (selection && selection !== lastSelection && hasModifierKey) {
        lastSelection = selection;
        
        await chrome.runtime.sendMessage({ type: "open_side_panel" });
        chrome.runtime.sendMessage({ 
            type: "new_selection", 
            text: selection, 
            url: window.location.href 
        });
        
    } else if (!selection && lastSelection) {
        lastSelection = "";
        
        chrome.storage.local.get("close_on_deselect", result => {
            if (result.close_on_deselect) {
                chrome.runtime.sendMessage({ type: "close_side_panel" });
            }
        });
    }
}

// Initial initialization
updateSelectionListener();

// Handle settings changes
chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === "local" && changes.mode) {
        updateSelectionListener();
    }
});