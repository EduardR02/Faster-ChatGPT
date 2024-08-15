import { StreamWriter, StreamWriterSimple, TokenCounter, ModeEnum, get_mode, set_lifetime_tokens,
    auto_resize_textfield_listener, update_textfield_height, is_on } from "./utils.js";

const ChatRoleDict = { user: "You", assistant: "Assistant", system: "System" };
const RoleEnum = { system: "system", user: "user", assistant: "assistant" };

const MODELS = {
    openai: {
        "gpt-3.5-turbo": "gpt-3.5-turbo",
        "gpt-4": "gpt-4",
        "gpt-4-turbo": "gpt-4-turbo-preview",
        "gpt-4o": "chatgpt-4o-latest",
        "gpt-4o-mini": "gpt-4o-mini"
    },
    anthropic: {
        "sonnet-3.5": "claude-3-5-sonnet-20240620"
    },
    gemini: {
        "gemini-1.5-pro-exp": "gemini-1.5-pro-exp-0801",
        "gemini-1.5-pro": "gemini-1.5-pro"
    }
};

// const ARENA_MODELS = ["sonnet-3.5", "gpt-4o", "gemini-1.5-pro-exp"];
const ARENA_MODELS = ["gpt-4o-mini", "gemini-1.5-pro-exp"]; // for testing

const MaxTemp = {
    openai: 2.0,
    anthropic: 1.0,
    gemini: 2.0
}

let settings = {};
let messages = [];
let pending_message = {};


document.addEventListener('DOMContentLoaded', init);


function init() {
    // Panel is now fully loaded, you can initialize your message listeners
    // and other functionality here.
    input_listener();
    init_settings();
    auto_resize_textfield_listener("textInput");
    setup_message_listeners();
    chrome.runtime.sendMessage({ type : "sidepanel_ready"});
}


function setup_message_listeners() {
    chrome.runtime.onMessage.addListener((msg) => {
        if (msg.type === 'new_selection') {
            when_new_selection(msg.text, msg.url);
        } else if (msg.type === 'new_chat') {
            when_new_chat();
        }
    });
}


function when_new_selection(text, url) {
    remove_added_paragraphs();
    append_to_chat_html(text, RoleEnum.system, "Selected text");
    init_prompt({mode: "selection", text: text, url: url}).then(() => {
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
    if (namespace !== "sync") return;
    for (let [key, { newValue }] of Object.entries(changes)) {
        if (key in settings && key !== "lifetime_tokens" && key !== "mode") {
            settings[key] = newValue;
        }
    }
}


function remove_added_paragraphs() {
    const contentDiv = document.getElementById('conversation');
    contentDiv.querySelectorAll('p').forEach(el => el.remove());
}


function api_call(model) {
    if (settings.arena_mode) {
        if (ARENA_MODELS.length < 2) {
            post_error_message_in_chat("Arena mode", "Not enough models enabled for Arena mode.");
            return;
        }
        let [model1, model2] = get_random_arena_models();
        api_call_single(model1);
        api_call_single(model2);
    }
    else {
        model = model || settings.model;
        api_call_single(model);
    }
}


function get_random_arena_models() {
    // ok fk it, by doing it with calculating random indices it seems to be hard to avoid bias, and doing a while loop is stupid
    // so we'll just do shuffle and pick first, ran this in python for 50 mil iterations on 5 length array, seems unbiased
    function shuffleArray() {
        let array = ARENA_MODELS.slice();
        for (let i = array.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [array[i], array[j]] = [array[j], array[i]];
        }
        return array;
    }
    let shuffled = shuffleArray();
    return [shuffled[0], shuffled[1]];

}


function api_call_single(model) {
    const [api_link, requestOptions] = create_api_request(model);
    fetch(api_link, requestOptions)
        .then(response => settings.stream_response ? response_stream(response, model) : get_reponse_no_stream(response, model))
        .catch(error => post_error_message_in_chat("api request (likely incorrect key)", error.message));
}


function create_api_request(model) {
    const provider = get_provider_for_model(model);
    switch (provider) {
        case 'openai':
            return create_openai_request(model);
        case 'anthropic':
            return create_anthropic_request(model);
        case 'gemini':
            return create_gemini_request(model);
        default:
            post_error_message_in_chat("model", "Model not found");
            return [null, null];
    }
}


function get_provider_for_model(model) {
    for (const [provider, models] of Object.entries(MODELS)) {
        if (model in models) return provider;
    }
    return null;
}


function create_anthropic_request(model) {
    check_api_key('anthropic');
    const requestOptions = {
        method: 'POST',
        credentials: 'omit',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': settings.api_keys.anthropic,
            'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
            model: MODELS.anthropic[model],
            system: messages[0].content,
            messages: messages.slice(1),
            max_tokens: settings.max_tokens,
            temperature: settings.temperature > MaxTemp.anthropic ? MaxTemp.anthropic : settings.temperature,
            stream: settings.stream_response
        })
    };
    return ['https://api.anthropic.com/v1/messages', requestOptions];
}


function create_openai_request(model) {
    check_api_key('openai');
    const requestOptions = {
        method: 'POST',
        credentials: 'omit',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + settings.api_keys.openai
        },
        body: JSON.stringify({
            model: MODELS.openai[model],
            messages: messages,
            max_tokens: settings.max_tokens,
            temperature: settings.temperature > MaxTemp.openai ? MaxTemp.openai : settings.temperature,
            stream: settings.stream_response,
            ...(settings.stream_response && {
                stream_options: { include_usage: true }
            })
        })
    };
    return ['https://api.openai.com/v1/chat/completions', requestOptions];
}


function create_gemini_request(model) {
    check_api_key("gemini");
    // gemini either has "model" or "user", even the system prompt is classified as "user"
    const mapped_messages = messages.map(message => ({
        role: message.role === "assistant" ? "model" : "user",
        parts: [{ text: message.content }]
    }));
    const requestOptions = {
        method: 'POST',
        credentials: 'omit',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            contents: mapped_messages.slice(1),
            systemInstruction: mapped_messages[0],
            safetySettings: get_gemini_safety_settings(),
            generationConfig: {
                temperature: settings.temperature > MaxTemp.gemini ? MaxTemp.gemini : settings.temperature,
                maxOutputTokens: settings.max_tokens,
                responseMimeType: "text/plain"
            },
        })
    };
    const responseType = settings.stream_response ? "streamGenerateContent" : "generateContent";
    const streamParam = settings.stream_response ? "alt=sse&" : "";
    const requestLink = `https://generativelanguage.googleapis.com/v1beta/models/${MODELS.gemini[model]}:${responseType}?${streamParam}key=${settings.api_keys.gemini}`;
    return [requestLink, requestOptions];
}


function check_api_key(provider) {
    if (!settings.api_keys[provider] || settings.api_keys[provider] === "") {
        post_error_message_in_chat(`${provider} API Key`, `${provider} API key is empty, switch to another model or enter a key in the settings.`);
    }
}


function get_gemini_safety_settings() {
    return [
        { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
    ];
}


function get_reponse_no_stream(response, model) {
    response.json().then(data => {
        let [contentDiv, conversationDiv] = append_to_chat_html("", RoleEnum.assistant);
        let streamWriter = new StreamWriterSimple(contentDiv, conversationDiv);

        let [response_text, input_tokens, output_tokens] = get_response_data_no_stream(data, model);
        streamWriter.processContent(response_text);
        streamWriter.addFooter(input_tokens, output_tokens, regenerate_response.bind(null, model));

        add_to_pending(response_text, RoleEnum.assistant, model);
        set_lifetime_tokens(input_tokens, output_tokens);
    });
}


function get_response_data_no_stream(data, model) {
    const provider = get_provider_for_model(model);
    try {
        switch (provider) {
            case 'openai':
                return [data.choices[0].message.content, data.usage.prompt_tokens, data.usage.completion_tokens];
            case 'anthropic':
                return [data.content[0].text, data.usage.input_tokens, data.usage.output_tokens];
            case 'gemini':
                return [data.candidates[0].content.parts[0].text,
                        data.usageMetadata.promptTokenCount,
                        data.usageMetadata.candidatesTokenCount];
            default:
                return ['', 0, 0];
        }
    }
    catch (error) {
        post_error_message_in_chat("API response parsing", error.message);
        return ['', 0, 0];
    }
}


// "stolen" from https://umaar.com/dev-tips/269-web-streams-openai/ and https://www.builder.io/blog/stream-ai-javascript
async function response_stream(response_stream, model) {
    // right now you can't "stop generating", too lazy lol
    let [contentDiv, conversationDiv] = append_to_chat_html("", RoleEnum.assistant);
    let api_provider = get_provider_for_model(model);
    let tokenCounter = new TokenCounter(api_provider);
    let streamWriter = api_provider === "gemini" ? new StreamWriter(contentDiv, conversationDiv, 2000) : new StreamWriterSimple(contentDiv, conversationDiv);

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
                    stream_parse(data, api_provider, streamWriter, tokenCounter);
                }
            }
        }
    } catch (error) {
        post_error_message_in_chat("API request error (likely incorrect key)", error.message);
    }
    tokenCounter.updateLifetimeTokens();
    streamWriter.addFooter(tokenCounter.inputTokens, tokenCounter.outputTokens, regenerate_response.bind(null, model));
    add_to_pending(streamWriter.message.join(''), RoleEnum.assistant, model);
}


function regenerate_response(model) {
    api_call_single(model);
}


function stream_parse(data, api_provider, streamWriter, tokenCounter) {
    try {
        const parsed = JSON.parse(data);
        switch (api_provider) {
            case "openai":
                handle_openai_stream(parsed, streamWriter, tokenCounter);
            case "anthropic":
                handle_anthropic_stream(parsed, streamWriter, tokenCounter);
            case "gemini":
                handle_gemini_stream(parsed, streamWriter, tokenCounter);
        }
    }
    catch (error) {
        post_error_message_in_chat('Error parsing streamed response:', error);
    }
}


function handle_openai_stream(parsed, streamWriter, tokenCounter) {
    if (parsed.choices && parsed.choices.length > 0) {
        const content = parsed.choices[0].delta.content;
        if (content) {
            streamWriter.processContent(content);
        }
    } else if (parsed.usage && parsed.usage.prompt_tokens) {
        tokenCounter.update(parsed.usage.prompt_tokens, parsed.usage.completion_tokens);  
    }
}


function handle_anthropic_stream(parsed, streamWriter, tokenCounter) {
    switch (parsed.type) {
        case 'content_block_delta':
            const content = parsed.delta.text;
            if (content) {
                streamWriter.processContent(content);
            }
            break;
        case 'message_start':
            if (parsed.message && parsed.message.usage && parsed.message.usage.input_tokens) {
                tokenCounter.update(parsed.message.usage.input_tokens, parsed.message.usage.output_tokens);
            }
            break;
        case 'message_delta':
            if (parsed.usage && parsed.usage.output_tokens) {
                tokenCounter.update(0, parsed.usage.output_tokens);  
            }
            break;
        case 'error':
            post_error_message_in_chat('Anthropic stream response (error block received)', parsed.error);
            break;
    }
}


function handle_gemini_stream(parsed, streamWriter, tokenCounter) {
    if (parsed.candidates && parsed.candidates.length > 0) {
        const content = parsed.candidates[0].content.parts[0].text;
        if (content) {
            streamWriter.processContent(content);
        }
    }
    if (parsed.usageMetadata && parsed.usageMetadata.promptTokenCount) {
        tokenCounter.update(parsed.usageMetadata.promptTokenCount, parsed.usageMetadata.candidatesTokenCount);
    }
}


function init_prompt(context) {
    let prompt_string = context.mode + "_prompt";

    return new Promise((resolve, reject) => {
        chrome.storage.local.get(prompt_string)
            .then(res => {
                messages = [];
                let prompt = res[prompt_string];
                if (context.mode === "selection") {
                    prompt += `\n"""[${context.url}]"""\n"""[${context.text}]"""`;
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
    chrome.storage.sync.get(['api_keys', 'max_tokens', 'temperature', 'model', 'stream_response', 'arena_mode'])
    .then(res => {
        settings = {
            api_keys: res.api_keys || {},
            max_tokens: res.max_tokens,
            temperature: res.temperature,
            model: res.model,
            stream_response: res.stream_response,
            arena_mode: res.arena_mode
        };
        chrome.storage.onChanged.addListener(update_settings);
        if (Object.keys(settings.api_keys).length === 0) {
            post_error_message_in_chat("api keys", "Please enter an api key in the settings, all are currently empty.");
        }
    });
}


function append_context(message, role) {
    // allowed roles are 'user', 'assistant' or system. System is only on init for the prompt.
    messages.push({role: role, content: message});
}


function add_to_pending(message, role, model) {
    // this is neat because we can only have one "latest" message per model, so if we regenerate many times we just overwrite.
    pending_message[model] = {role: role, content: message};
}


function resolve_pending(model) {
    // because of possible weirdness with toggling arena mode on or off while there are pending messages, we prioritize messages like this:
    // "function parameter: model" -> "settings.model" -> "random" message that is pending (potentially multiple if arena mode was on).
    // We care about this at all because the convo is actually supposed to be useful, and we want to pass the best output to continue.
    if (Object.keys(pending_message).length === 0) return;
    if (model && model in pending_message) {
        messages.push(pending_message[model]);
    }
    else if (settings.model in pending_message) {
        messages.push(pending_message[settings.model]);
    }
    else {
        messages.push(pending_message[Object.keys(pending_message)[0]]);
    }

    pending_message = {};
}


function append_to_chat_html(text, role, roleString = null) {
    let targetDiv = document.getElementById('conversation');
    let inputField = document.getElementById('textInput');

    let newParagraph = document.createElement('p');
    newParagraph.classList.add(role + "-message");

    // Create and style the prefix span
    let prefixSpan = document.createElement('span');
    prefixSpan.classList.add('message-prefix', role + '-prefix');
    prefixSpan.textContent = roleString || ChatRoleDict[role];
    newParagraph.appendChild(prefixSpan);

    // Create a container for the message content
    let contentDiv = document.createElement('div');
    // this is nice, we don't have to bother with the <br>s now, much simpler
    contentDiv.style.whiteSpace = 'pre-wrap';
    contentDiv.classList.add('message-content', role + '-content');
    contentDiv.textContent = text;
    newParagraph.appendChild(contentDiv);
  
    targetDiv.insertBefore(newParagraph, inputField);
    targetDiv.scrollIntoView(false);
    return [contentDiv, targetDiv];
}


function post_error_message_in_chat(error_occurred, error_message) {
    return append_to_chat_html("Error occurred here: " + error_occurred +  "\nHere is the error message:\n" + error_message, RoleEnum.system);
}

function post_warning_in_chat(warning_message) {
    return append_to_chat_html("Warning: " + warning_message, RoleEnum.system);
}


function input_listener() {
    let inputField = document.getElementById('textInput');

    inputField.addEventListener('keydown', function(event) {
        if (inputField === document.activeElement && event.key === 'Enter' && !event.shiftKey) {
            // prevents new line from being added after the field is cleared (because it prolly triggers on keyup also)
            event.preventDefault();
            let inputText = inputField.value;
            if (inputText.trim().length !== 0) {
                append_to_chat_html(inputText, RoleEnum.user);
                append_context(inputText, RoleEnum.user);
                handle_input(inputText);
            }
            inputField.value = '';
            update_textfield_height(inputField);
        }
    });
}


function remove_regenerate_buttons() {
    let buttons = document.querySelectorAll('.regenerate-button');
    buttons.forEach(button => {
        let parent = button.parentElement;
        button.remove();
        parent.classList.add('centered');
    });
}


function handle_input(inputText) {
    // previously it was possible to open the sidepanel manually from above the bookmarks bar, but seems to not be possible anymore.
    if (Object.keys(settings).length === 0 || messages[0].role !== "system") {
        init_prompt({mode: "chat"}).then(() => {
            get_mode(function(current_mode) {
                if (is_on(current_mode)) {
                    append_context(inputText, RoleEnum.user);
                    api_call();
                }
            });
        });
    } else {
        remove_regenerate_buttons();
        resolve_pending();
        api_call();
    }
}
