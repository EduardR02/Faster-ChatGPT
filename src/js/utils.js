export function get_mode(callback) {
	chrome.storage.sync.get('mode', function(res) {
		callback(res.mode);
	});
}


export function set_mode(new_mode) {
    chrome.storage.sync.set({mode: new_mode});
}


export function is_on(mode) {
	return mode !== ModeEnum.Off;
}


export function get_lifetime_tokens(callback) {
    chrome.storage.sync.get(['lifetime_input_tokens', 'lifetime_output_tokens'], function(res) {
        callback({
            input: res.lifetime_input_tokens || 0,
            output: res.lifetime_output_tokens || 0
        });
    });
}

export function set_lifetime_tokens(newInputTokens, newOutputTokens) {
    get_lifetime_tokens(function(currentTokens) {
        chrome.storage.sync.set({
            lifetime_input_tokens: currentTokens.input + newInputTokens,
            lifetime_output_tokens: currentTokens.output + newOutputTokens
        });
    });
}


export function get_api_key() {
    return new Promise((resolve, reject) => {
        chrome.storage.sync.get('api_key', function(res) {
            if (res.api_key === undefined || res.api_key === "") {
                reject("api_key is undefined or empty");
            }
            else {
                resolve(res.api_key);
            }
        });
    });
}


export function set_api_key(new_api_key) {
    chrome.storage.sync.set({api_key: new_api_key});
}


export function auto_resize_textfield_listener(element_id) {
    let inputField = document.getElementById(element_id);

    inputField.addEventListener('input', function() {
      update_textfield_height(inputField);
    });
}


export function update_textfield_height(inputField) {
    inputField.style.height = 'auto';
    inputField.style.height = (inputField.scrollHeight) + 'px';
}


export function loadTextFromFile(filePath) {
    return new Promise((resolve, reject) => {
        let textFileUrl = chrome.runtime.getURL(filePath);
        fetch(textFileUrl)
            .then(response => response.text())
            .then(text => {
                resolve(text);
            })
            .catch(error => {
                reject(error);
            });
    });
}


export function set_defaults() {
    let settings = {
        mode: ModeEnum.InstantPromptMode,
        lifetime_input_tokens: 0,
        lifetime_output_tokens: 0,
        max_tokens: 380,
        temperature: 1.2,
        model : "gpt-4o-mini",
        api_key: "",
        close_on_deselect: true,
        stream_response: true
    }
    chrome.storage.sync.set(settings);
    // for some reason relative path does not work, only full path.
    // possibly because function is called on startup in background worker, and maybe the context is the base dir then.
    loadTextFromFile("src/prompts/prompt.txt").then((text) => {
        chrome.storage.local.set({prompt: text.trim()})
    });
}


export const ModeEnum = {"InstantPromptMode": 0, "PromptMode": 1, "Off": 2};