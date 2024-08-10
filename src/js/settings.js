import {auto_resize_textfield_listener, update_textfield_height} from "./utils.js";


let existing_settings = {};

init()


function init() {
    init_values();
    let saveButton = document.getElementById('buttonSave');
    saveButton.addEventListener('click', function() {
        save();
    });

    let promptSelectButtons = document.querySelectorAll('input[name="prompt-select"]');
    promptSelectButtons.forEach(radio => {
        radio.addEventListener('change', function() {
            if (this.checked) {
                const prompt_string = this.value;
                textarea_update(prompt_string);
            }
        });
    });
}


function save() {
    save_settings();
    save_prompt();
}


function save_prompt() {
    let text = document.getElementById('customize-prompt').value.trim();
    let prompt_string = document.querySelector('input[name="prompt-select"]:checked').value;
    if (text !== existing_settings.prompt && text !== "") {
        chrome.storage.local.set({[prompt_string]: text});
    }
}


function save_settings() {
    let settings = {}
    settings.api_key_openai = document.getElementById('api-key-openai').value.trim();
    settings.api_key_anthropic = document.getElementById('api-key-anthropic').value.trim();
    settings.max_tokens = parseInt(document.getElementById('max-tokens').value.trim());
    settings.temperature = parseFloat(document.getElementById('temperature').value.trim());
    settings.model = document.querySelector('input[name="model-select"]:checked').value;
    settings.close_on_deselect = document.getElementById('close-on-deselect').checked;
    settings.stream_response = document.getElementById('stream-response').checked;
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
}


function init_values() {
    chrome.storage.sync.get(['max_tokens', 'temperature', 'model', 'close_on_deselect', 'stream_response'], function(res) {
        document.getElementById('max-tokens').value = res.max_tokens;
        document.getElementById('temperature').value = res.temperature;
        document.getElementById(res.model).checked = true;
        document.getElementById('close-on-deselect').checked = res.close_on_deselect;
        document.getElementById('stream-response').checked = res.stream_response;
        existing_settings = res;
    });
    textarea_setup();
}


function textarea_update(prompt_string) {
    let textarea = document.getElementById('customize-prompt');
    chrome.storage.local.get(prompt_string).then((result) => {
        let text = result[prompt_string] || '';
        textarea.value = text;
        update_textfield_height(textarea);
        existing_settings.prompt = text;
    });
}

function textarea_setup() {
    let selection_radio = document.getElementById("selection-prompt");
    selection_radio.checked = true;
    
    auto_resize_textfield_listener('customize-prompt');
    textarea_update(selection_radio.value);
}

