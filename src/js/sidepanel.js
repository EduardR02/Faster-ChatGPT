import { StreamWriter, ModeEnum, get_mode, set_lifetime_tokens,
    auto_resize_textfield_listener, update_textfield_height, is_on } from "./utils.js";

const ChatRoleDict = {user: "You", assistant: "Assistant", system: "System"};
const RoleEnum = {system: "system", user: "user", assistant: "assistant"};
let openai_models = {"gpt-3.5-turbo": "gpt-3.5-turbo", "gpt-4": "gpt-4", "gpt-4-turbo": "gpt-4-turbo-preview", "gpt-4o": "gpt-4o", "gpt-4o-mini": "gpt-4o-mini"};
let anthropic_models = {"sonnet-3.5": "claude-3-5-sonnet-20240620"};
let gemini_models = {"gemini-1.5-pro-exp": "gemini-1.5-pro-exp-0801", "gemini-1.5-pro": "gemini-1.5-pro" };
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
    init_settings();
    auto_resize_textfield_listener("textInput");
    chrome.runtime.onMessage.addListener(function(msg){
        if (msg.type === 'new_selection') {
            when_new_selection(msg.text, msg.url);
        }
        if (msg.type === 'new_chat') {
            // popup will only send this if sidepanel is closed beforehand. We don't want to override an ongoing session (and won't be handled here)
            when_new_chat();
        }
    });
    // Signal to the background script that we are ready
    chrome.runtime.sendMessage({ type : "sidepanel_ready"});
}


function when_new_selection(text_, url_) {
    remove_added_paragraphs();
    append_to_chat_html(text_, RoleEnum.system, "Selected text");
    init_prompt({mode: "selection", text: text_, url: url_}).then(() => {
        get_mode(function(current_mode) {
            if (current_mode === ModeEnum.InstantPromptMode) {
                api_call();
            }
        });
    });
}


function when_new_chat() {
    get_mode(function(current_mode) {
        if (current_mode === ModeEnum.InstantPromptMode) {
            post_warning_in_chat("Instant prompt mode does not make sense in chat mode and will be ignored.");
        }
        init_prompt({mode: "chat"});
    });
}


function update_settings(changes, namespace) {
    if (namespace !== "sync") {
        return;
    }
    for (let change in changes) {
        if (!(change in settings) || change === "lifetime_tokens" || change === "mode") {
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
    let [api_link, requestOptions] = create_api_request();

    fetch(api_link, requestOptions)
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


function create_api_request() {
    if (settings.model in openai_models) {
        return create_openai_request();
    }
    else if (settings.model in anthropic_models) {
        return create_anthropic_request();
    }
    else if (settings.model in gemini_models) {
        return create_gemini_request();
    }
    else {
        post_error_message_in_chat("model", "Model not found");
    }
}

function create_anthropic_request() {
    let model = anthropic_models[settings.model];
    if (!("anthropic" in settings.api_keys) || settings.api_keys.anthropic === "") {
        post_error_message_in_chat("Anthropic api key", "Anthropic api key is empty, switch to another model or enter a key in the settings");
    }
    let requestOptions = {
        method: 'POST',
        credentials: 'omit',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': settings.api_keys.anthropic,
            'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
            "model": model,
            "system": messages[0].content,
            "messages": messages.slice(1),
            "max_tokens": settings.max_tokens,
            "temperature": settings.temperature,
            "stream": settings.stream_response
        })
    };
    return ['https://api.anthropic.com/v1/messages', requestOptions];
}

function create_openai_request() {
    let model = openai_models[settings.model];
    if (!("openai" in settings.api_keys) || settings.api_keys.openai === "") {
        post_error_message_in_chat("OpenAI api key", "OpenAI api key is empty, switch to another model or enter a key in the settings.");
    }
    let requestOptions = {
        method: 'POST',
        credentials: 'omit',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + settings.api_keys.openai
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
    return ['https://api.openai.com/v1/chat/completions', requestOptions];
}


function create_gemini_request() {
    if (!("gemini" in settings.api_keys) || settings.api_keys.gemini === "") {
        post_error_message_in_chat("Gemini API Key", "Gemini API key is empty, switch to another model or enter a key in the settings.");
    }
    // gemini either has "model" or "user", even the system prompt is classified as "user"
    let mapped_messages = messages.map((message) => ({
        role: message.role === "assistant" ? "model" : "user",
        parts: [{text: message.content}]
    }));
    let requestOptions = {
        method: 'POST',
        credentials: 'omit',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            "contents": mapped_messages.slice(1),
            "systemInstruction": mapped_messages[0],
            "safetySettings": get_gemini_safety_settings(),
            "generationConfig": {
                "temperature": settings.temperature,
                "maxOutputTokens": settings.max_tokens,
                "responseMimeType": "text/plain"
            },
            
        })
    };
    let responseTypeString = settings.stream_response ? "streamGenerateContent" : "generateContent";
    let whenStream = settings.stream_response ? "alt=sse&" : "";
    let requestLink = `https://generativelanguage.googleapis.com/v1beta/models/${gemini_models[settings.model]}:${responseTypeString}?${whenStream}key=${settings.api_keys.gemini}`;
    return [requestLink, requestOptions];
}


function get_gemini_safety_settings() {
    return [
        {
            "category": "HARM_CATEGORY_HARASSMENT",
            "threshold": "BLOCK_NONE",
        },
        {
            "category": "HARM_CATEGORY_HATE_SPEECH",
            "threshold": "BLOCK_NONE",
        },
        {
            "category": "HARM_CATEGORY_SEXUALLY_EXPLICIT",
            "threshold": "BLOCK_NONE",
        },
        {
            "category": "HARM_CATEGORY_DANGEROUS_CONTENT",
            "threshold": "BLOCK_NONE",
        },
    ];
}


function get_reponse_no_stream(response) {
    response.json().then(data => {
        let [response_text, input_tokens, output_tokens] = get_response_data_no_stream(data);
        
        append_to_chat_html(response_text, RoleEnum.assistant);
        append_context(response_text, RoleEnum.assistant);
        set_lifetime_tokens(input_tokens, output_tokens);
    });
}

function get_response_data_no_stream(data) {
    let response_text, input_tokens, output_tokens;
    if (settings.model in openai_models) {
        response_text = data.choices[0].message.content;
        input_tokens = data.usage.prompt_tokens;
        output_tokens = data.usage.completion_tokens;
    }
    else if (settings.model in anthropic_models) {
        response_text = data.content[0].text;
        input_tokens = data.usage.input_tokens;
        output_tokens = data.usage.output_tokens;
    }
    else if (settings.model in gemini_models) {
        response_text = data.candidates[0].content.parts[0].text;
        input_tokens = data.usageMetadata.promptTokenCount;
        output_tokens = data.usageMetadata.candidatesTokenCount;
    }
    return [response_text, input_tokens, output_tokens];
}


// "stolen" from https://umaar.com/dev-tips/269-web-streams-openai/ and https://www.builder.io/blog/stream-ai-javascript
async function response_stream(response_stream) {
    // right now you can't "stop generating", too lazy lol
    let [contentDiv, conversationDiv] = append_to_chat_html("", RoleEnum.assistant);
    let message = [];
    let api_provider = settings.model in openai_models ? "openai" : settings.model in anthropic_models ? "anthropic" : "gemini";
    let input_tokens = 0, output_tokens = 0;
    let streamWriter = api_provider === "gemini" ? new StreamWriter(contentDiv, conversationDiv, 2000) : null;

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
                        let [in_tok, out_tok] = stream_parse(data, message, contentDiv, conversationDiv, api_provider, streamWriter);
                        if (api_provider === "gemini") {
                            input_tokens = Math.max(input_tokens, in_tok);
                            output_tokens = Math.max(output_tokens, out_tok);
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
    if (api_provider === "gemini") {
        set_lifetime_tokens(input_tokens, output_tokens);
    }
    append_context(message.join(''), RoleEnum.assistant);
}

function stream_parse(data, message, contentDiv, conversationDiv, api_provider, streamWriter) {
    const parsed = JSON.parse(data);
    switch (api_provider) {
        case "openai":
            if (parsed.choices && parsed.choices.length > 0) {
                const content = parsed.choices[0].delta.content;
                if (content) {
                    add_content_streaming(content, message, contentDiv, conversationDiv);
                }
            } else if (parsed.usage && parsed.usage.prompt_tokens) {
                set_lifetime_tokens(parsed.usage.prompt_tokens, parsed.usage.completion_tokens);  
            }
            break;

        case "anthropic":
            // Anthropic specific streaming handling
            switch (parsed.type) {
                case 'content_block_delta':
                    const content = parsed.delta.text;
                    if (content) {
                        add_content_streaming(content, message, contentDiv, conversationDiv);
                    }
                    break;
    
                case 'message_start':
                    if (parsed.message && parsed.message.usage && parsed.message.usage.input_tokens) {
                        // for some reason api returns output tokens in the beginning also, but only like 1 or 2 (in docs)
                        // so maybe it counts the first block separately or smth idk
                        set_lifetime_tokens(parsed.message.usage.input_tokens, parsed.message.usage.output_tokens);
                    }
                    break;
    
                case 'message_delta':
                    if (parsed.usage && parsed.usage.output_tokens) {
                        set_lifetime_tokens(0, parsed.usage.output_tokens);  
                    }
                    break;
                case 'error':
                    // in api they mention high traffic as an example
                    post_error_message_in_chat('Anthropic stream response (error block received)', parsed.error);
                    break;
    
                default:
                    // stuff like ping, message_end, and other things we don't care about
                    break;
            }
            break;
        
        case "gemini":
            if (parsed.candidates && parsed.candidates.length > 0) {
                const content = parsed.candidates[0].content.parts[0].text;
                if (content) {
                    message.push(content);
                    streamWriter.processContent(content);
                }
            }
            if (parsed.usageMetadata && parsed.usageMetadata.promptTokenCount) {
                return [parsed.usageMetadata.promptTokenCount, parsed.usageMetadata.candidatesTokenCount];
            }
            break;
        
        default:
            break;
    }
    return [0, 0];
}

function add_content_streaming(content, message, contentDiv, conversationDiv) {
    message.push(content);
    contentDiv.textContent += content;
    conversationDiv.scrollIntoView(false);
}


function init_prompt(context) {
    let prompt_string = context.mode + "_prompt";

    return new Promise((resolve, reject) => {
        chrome.storage.local.get(prompt_string)
            .then(res => {
                messages = [];
                let prompt = res[prompt_string];
                if (context.mode === "selection") {
                    let selectionWithQuotes = '"""[' + context.text + ']"""';
                    let url_with_quotes = '"""[' + context.url + ']"""';
                    prompt = prompt + "\n" + url_with_quotes + "\n" + selectionWithQuotes;
                }
                append_context(prompt, RoleEnum.system);
                resolve();
            })
            .catch(error => {
                post_error_message_in_chat(`loading ${context.mode} prompt file`, error.message);
                reject(error);
            });
    });
}


function init_settings() {
    chrome.storage.sync.get(['api_keys', 'max_tokens', 'temperature', 'model', 'stream_response'])
    .then(res => {
        settings.api_keys = res.api_keys || {};
        settings.max_tokens = res.max_tokens;
        settings.temperature = res.temperature;
        settings.model = res.model;
        settings.stream_response = res.stream_response;
        chrome.storage.onChanged.addListener(update_settings);
        if (Object.keys(settings.api_keys).length === 0) {
            post_error_message_in_chat("api keys", "Please enter an api key in the settings, all are currently empty.");
        }
    });
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
        roleString = ChatRoleDict[role];
    prefixSpan.textContent = roleString;
    newParagraph.appendChild(prefixSpan);

    // Create a container for the message content
    let contentDiv = document.createElement('div');
    // this is nice, we don't have to bother with the <br>s now, much simpler
    contentDiv.style.whiteSpace = 'pre-wrap';
    contentDiv.classList.add('message-content', role + '-content');
    newParagraph.appendChild(contentDiv);

    contentDiv.textContent = text;
  
    targetDiv.insertBefore(newParagraph, inputField);
    targetDiv.scrollIntoView(false);
    return [contentDiv, targetDiv];
}


function post_error_message_in_chat(error_occurred, error_message) {
    append_to_chat_html("Error occurred here: " + error_occurred +  "\nHere is the error message:\n" + error_message, RoleEnum.system);
}

function post_warning_in_chat(warning_message) {
    append_to_chat_html("Warning: " + warning_message, RoleEnum.system);
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
                    // if panel is manually opened without selection
                    init_prompt({mode: "chat"}).then(() => {
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