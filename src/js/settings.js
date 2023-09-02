import {auto_resize_textfield_listener, update_textfield_height} from "./utils.js";


let existing_settings = {};

init()


function init() {
    textarea_setup();
    init_values();
    let saveButton = document.getElementById('buttonSave');
    saveButton.addEventListener('click', function() {
        save();
    });
}


function save() {
    let settings = {}
    settings.api_key = document.getElementById('api-key').value.trim();
    settings.max_tokens = parseInt(document.getElementById('max-tokens').value.trim());
    settings.temperature = parseFloat(document.getElementById('temperature').value.trim());
    settings.model = document.querySelector('input[name="model-select"]:checked').value;
    for (let key in settings) {
        if (settings[key] === existing_settings[key] || settings[key] === undefined ||
            settings[key] === NaN || settings[key] === "") {
            delete settings[key];
        }
        else {
            existing_settings[key] = settings[key];
        }
    }
    chrome.storage.sync.set(settings);
    let text = document.getElementById('customize-prompt').value.trim();
    if (text !== existing_settings.prompt && text !== "") {
        chrome.storage.local.set({prompt: text});
    }
}


function init_values() {
    chrome.storage.sync.get(['max_tokens', 'temperature', 'model'], function(res) {
        document.getElementById('max-tokens').value = res.max_tokens;
        document.getElementById('temperature').value = res.temperature;
        document.getElementById(res.model).checked = true;
        existing_settings = res;
    });
}


function textarea_setup() {
    let textarea = document.getElementById('customize-prompt');
    auto_resize_textfield_listener('customize-prompt');
    chrome.storage.local.get("prompt").then((text) => {
        textarea.value = text.prompt;
        update_textfield_height(textarea);
        existing_settings.prompt = text.prompt;
    });
}

