import { ModeEnum, get_mode, set_lifetime_tokens,
    auto_resize_textfield_listener, update_textfield_height, is_on } from "./utils.js";

let selection_string = "Selected text"
let user_prompt_string = "You";
let assistant_prompt_string = "Assistant";
const RoleEnum = {system: "system", user: "user", assistant: "assistant"};
let models = {"gpt-3.5-turbo": "gpt-3.5-turbo", "gpt-4": "gpt-4", "gpt-4-turbo": "gpt-4-turbo-preview", "gpt-4o": "gpt-4o", "gpt-4o-mini": "gpt-4o-mini"};
let settings = {};
// stores the current conversation
let messages = [];



document.addEventListener('DOMContentLoaded', function () {
    init();
});


function init() {
    // Panel is now fully loaded, you can initialize your message listeners
    // and other functionality here.
    input_listener();
    auto_resize_textfield_listener("textInput");
    chrome.runtime.onMessage.addListener(function(msg){
        if (msg.type === 'new_selection') {
            when_new_selection(msg.text, msg.url);
        }
    });
    // Signal to the background script that we are ready
    chrome.runtime.sendMessage({ type : "sidepanel_ready"});
}


function when_new_selection(text, url) {
    remove_added_paragraphs();
    append_to_chat_html(text, RoleEnum.system, selection_string);
    init_context(text, url).then(() => {
        get_mode(function(current_mode) {
            if (current_mode === ModeEnum.InstantPromptMode) {
                api_call();
            }
        });
    });
}


function update_settings(changes, namespace) {
    if (namespace !== "sync") {
        return;
    }
    for (let change in changes) {
        if (change === "lifetime_tokens" || change === "mode") {
            continue;
        }
        settings[change] = changes[change].newValue;
    }
}


function remove_added_paragraphs() {
    const contentDiv = document.getElementById('conversation');
    // Get a list of all <p> elements within the <div>
    const pElements = contentDiv.querySelectorAll('p');
    for (const element of pElements) {
        contentDiv.removeChild(element);
    }
}


function api_call() {
    // increase context length if necessary
    let model = models[settings.model];
    let requestOptions = {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + settings.api_key
        },
        body: JSON.stringify({
            "model": model,
            "messages": messages,
            "max_tokens": settings.max_tokens,
            "temperature": settings.temperature,
            "stream": settings.stream_response,
            ...(settings.stream_response && {
                "stream_options": {
                    "include_usage": true
                }
            })
        })
    };

    fetch('https://api.openai.com/v1/chat/completions', requestOptions)
        .then(response => {
            if (settings.stream_response) {
                response_stream(response);
            }
            else {
                get_reponse_no_stream(response);
            }
        })
        .catch(error => {
            post_error_message_in_chat("api request (likely incorrect key)", error.message);
        });
}


function get_reponse_no_stream(response) {
    response.json().then(data => {
        let response_text = data.choices[0].message.content;
        append_to_chat_html(response_text, RoleEnum.assistant);
        append_context(response_text, RoleEnum.assistant);
        set_lifetime_tokens(data.usage.prompt_tokens, data.usage.completion_tokens);
    });
}


// "stolen" from https://umaar.com/dev-tips/269-web-streams-openai/ and https://www.builder.io/blog/stream-ai-javascript
async function response_stream(response_stream) {
    // right now you can't "stop generating", too lazy lol
    let contentDiv = append_to_chat_html("", RoleEnum.assistant);
    let message = [];

    const reader = response_stream.body.getReader();
    const decoder = new TextDecoder("utf-8");

    try {
        let buffer = '';
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop();

            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    const data = line.slice(6);
                    if (data === '[DONE]') continue;

                    try {
                        const parsed = JSON.parse(data);
                        if (parsed.choices && parsed.choices.length > 0) {
                            const content = parsed.choices[0].delta.content;
                            if (content) {
                                message.push(content);
                                contentDiv.innerHTML += content.replace(/\n/g, '<br>');
                            }
                        } else if (parsed.usage && parsed.usage.prompt_tokens) {
                            set_lifetime_tokens(parsed.usage.prompt_tokens, parsed.usage.completion_tokens);  
                        }
                    } catch (err) {
                        post_error_message_in_chat('Error parsing JSON:', err);
                    }
                }
            }
        }
    } catch (error) {
        post_error_message_in_chat("API request error (likely incorrect key)", error.message);
    }
    append_context(message.join(''), RoleEnum.assistant);
}


function init_context(selection, url) {
    // init prompt
    let prompt_promise =  new Promise((resolve, reject) => {
        chrome.storage.local.get("prompt")
            .then(res => {
                // this is to "possibly" improve prompting by surrounding the selection with quotes
                let selectionWithQuotes = '"""[' + selection + ']"""';
                let url_with_quotes = '"""[' + url + ']"""';
                // current prompt states that both in triple quotes, with url preceding selection
                let concat = res.prompt + "\n" + url_with_quotes + "\n" + selectionWithQuotes;
                messages = [];
                append_context(concat, RoleEnum.system);
                resolve();
            })
            .catch(error => {
                post_error_message_in_chat("loading prompt_file", error.message);
                reject(error);
            });
    });
    // init settings
    let settings_promise = new Promise((resolve, reject) => {
        chrome.storage.sync.get(['api_key', 'max_tokens', 'temperature', 'model', 'stream_response'])
        .then(res => {
            settings.api_key = res.api_key;
            settings.max_tokens = res.max_tokens;
            settings.temperature = res.temperature;
            settings.model = res.model;
            settings.stream_response = res.stream_response;
            chrome.storage.onChanged.addListener(update_settings);
            resolve();
            if (settings.api_key === "") {
                post_error_message_in_chat("api key", "Please enter your api key in the settings.");
                reject("api key not set");
            }
        })
        .catch(error => {reject(error)});
    });
    return Promise.all([prompt_promise, settings_promise]);
}





function append_context(message, role_) {
    // allowed roles are 'user', 'assistant' or system. System is only on init for the prompt.
    messages.push({role: role_, content: message});
}


function append_to_chat_html(text, role, roleString = null) {
    let targetDiv = document.getElementById('conversation');
    let inputField = document.getElementById('textInput');

    let newParagraph = document.createElement('p');
    newParagraph.classList.add(role + "-message");

    // Create and style the prefix span
    let prefixSpan = document.createElement('span');
    prefixSpan.classList.add('message-prefix', role + '-prefix');
    if (!roleString)
        roleString = role === RoleEnum.user ? user_prompt_string : assistant_prompt_string;
    prefixSpan.textContent = roleString;
    newParagraph.appendChild(prefixSpan);

    // Create a container for the message content
    let contentDiv = document.createElement('div');
    contentDiv.classList.add('message-content', role + '-content');
    newParagraph.appendChild(contentDiv);

    // Handle new lines in the message content
    text.split('\n').forEach(function(line, index) {
        if (index > 0) {
            contentDiv.appendChild(document.createElement('br'));
        }
        contentDiv.appendChild(document.createTextNode(line));
    });
  
    targetDiv.insertBefore(newParagraph, inputField);
    targetDiv.scrollIntoView(false);
    return contentDiv;
}


function post_error_message_in_chat(error_occurred, error_message) {
    append_to_chat_html("Error occurred here: " + error_occurred +  "\nHere is the error message:\n" + error_message, RoleEnum.system);
}


function input_listener() {
    let inputField = document.getElementById('textInput');

    inputField.addEventListener('keydown', function(event) {
        if (inputField === document.activeElement && event.key === 'Enter' && !event.shiftKey) {
            // prevents new line from being added after the field is cleared (because it prolly triggers on keyup also)
            event.preventDefault();
            //let inputText = escapeHtml(inputField.value);
            let inputText = inputField.value;
            if (inputText.trim().length !== 0) {
                append_to_chat_html(inputText, RoleEnum.user);
                append_context(inputText, RoleEnum.user);
                if (Object.keys(settings).length === 0) {
                    // if the panel is just opened with no selection, have to init first
                    init_context("No context", "No URL").then(() => {
                        get_mode(function(current_mode) {
                            if (is_on(current_mode)) {
                                append_context(inputText, RoleEnum.user);
                                api_call();
                            }
                        });
                    });
                }
                else {
                    api_call();
                }
            }
            inputField.value = '';
            update_textfield_height(inputField);
        }
    });
}


// not needed right now because innerText is used instead of innerHTML
// https://stackoverflow.com/questions/24816/escaping-html-strings-with-jquery
function escapeHtml(string) {
    let entityMap = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
        '/': '&#x2F;',
        '`': '&#x60;',
        '=': '&#x3D;'
    };
    return String(string).replace(/[&<>"'`=\/]/g, function (s) {
        return entityMap[s];
    });
}