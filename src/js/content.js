// handles the case when you click on a selected text and it deselects it,
// as it gets recorded as a new selection
let previous_selection = "";
init();


function init() {
    add_listener();
    chrome.storage.onChanged.addListener(function(changes, namespace) {
        if (changes.mode  && namespace === "local") {
            add_listener();
        }
    });
}


function add_listener() {
    is_mode_on(function(is_mode_on) {
        if (is_mode_on) {
            // remove first to not duplicate listeners
            document.removeEventListener("mouseup", listener);
            document.addEventListener("mouseup", listener);
        }
        else {
            document.removeEventListener("mouseup", listener);
        }
    });
}


// workaround for importing from utils.js, which is delegated to background.js
function is_mode_on(callback) {
    chrome.runtime.sendMessage({type: "is_mode_on"}, function(response) {
        callback(response.is_mode_on);
    });
}


function listener(event) {
    let selection = window.getSelection().toString().trim();
    // only do anything if ctrl is also pressed, to not spam panel when not intended
    if (selection.length > 0 && selection !== previous_selection && (event.ctrlKey || event.metaKey)) {
        (async () => {
            let current_url = window.location.href;
            let response = await chrome.runtime.sendMessage({ type: "is_sidepanel_open" });
            if (!response.isOpen) {
                chrome.runtime.sendMessage({ type: "open_side_panel" });
            }
            chrome.runtime.sendMessage({ type: "new_selection", text: selection, url: current_url });
            previous_selection = selection;
        })();
    }
    else if (selection.length === 0 && previous_selection.length > 0) {
        // previous_selection has to be > 0, otherwise will spam messages on normal mouse clicks
        previous_selection = "";
        chrome.storage.local.get("close_on_deselect").then((res) => {
            if (res.close_on_deselect) {
                chrome.runtime.sendMessage({ type: "close_side_panel" });
            }
        });
    }
}