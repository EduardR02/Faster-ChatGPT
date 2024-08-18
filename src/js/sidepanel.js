import { ArenaRatingManager, StreamWriter, StreamWriterSimple, TokenCounter, ModeEnum, get_mode, set_lifetime_tokens,
    auto_resize_textfield_listener, update_textfield_height, is_on } from "./utils.js";


class ChatManager {
    constructor() {
        this.conversationDiv = document.getElementById('conversation');
        this.inputField = document.getElementById('textInput');
        this.isArenaMode = false;
        this.arenaDivs = [];
        this.arenaButtons = [];
        this.hoverOnFunc = null;
        this.hoverOffFunc = null;
        this.arenaFooter = null;
        this.arenaContainer = null;
        this.contentDivs = [];
        this.pendingResponses = 0;
        this.shouldScroll = true;
        this.scrollListenerActive = false;
    }

    initArenaMode() {
        this.isArenaMode = true;
        this.arenaContainer = null;
        this.arenaFooter = null;
        this.arenaDivs = [];
        this.arenaButtons = [];
        this.contentDivs = [];
        this.pendingResponses = 2;
        if (!arenaRatingManager) arenaRatingManager = initArenaRatingManager();
    }

    updatePendingResponses() {
        if (this.isArenaMode) {
            this.pendingResponses--;
            if (this.pendingResponses === 0) {
                this.addArenaFooter();
            }
        }
    }

    initParagraph(role) {
        let paragraph = document.createElement('p');
        paragraph.classList.add(role + "-message");
        this.conversationDiv.insertBefore(paragraph, this.inputField);
        return paragraph;
    }

    onRegenerate(contentDiv) {
        let parentDiv = contentDiv.parentElement;
        let roleString = ChatRoleDict[RoleEnum.assistant] + ' \u{27F3}';
        this.createMessageDiv(parentDiv, RoleEnum.assistant, '', roleString);
    }

    createMessageDiv(parentElement, role, text = '', roleString = null) {
        // unfortunately need this guy in case we want to regenerate a response in arena mode
        let messageWrapper = document.createElement('div');
        messageWrapper.classList.add('message-wrapper');

        let prefixSpan = document.createElement('span');
        prefixSpan.classList.add('message-prefix', role + '-prefix');
        prefixSpan.textContent = roleString || ChatRoleDict[role];
        messageWrapper.appendChild(prefixSpan);

        let contentDiv = document.createElement('div');
        contentDiv.style.whiteSpace = 'pre-wrap';
        contentDiv.classList.add('message-content', role + '-content');
        contentDiv.textContent = text;
        messageWrapper.appendChild(contentDiv);
        if (role === RoleEnum.assistant) {
            this.contentDivs.push(contentDiv);
        }
        parentElement.appendChild(messageWrapper);
        this.scrollIntoView();
        return contentDiv;
    }

    initMessageBlock(role, roleString = null) {
        this.createMessageBlock(role, '', roleString);
    }

    createMessageBlock(role, text, roleString = null) {
        let paragraph = this.initParagraph(role);

        if (this.isArenaMode && role === RoleEnum.assistant) {
            let fullDiv = document.createElement('div');
            fullDiv.classList.add('arena-full-container');
            this.arenaContainer = fullDiv;

            let arenaDiv = document.createElement('div');
            arenaDiv.classList.add('arena-wrapper');

            for (let i = 0; i < 2; i++) {
                let contentDiv = this.createMessageDiv(arenaDiv, role);
                this.arenaDivs.push({ model: null, contentDiv: contentDiv });
            }

            fullDiv.appendChild(arenaDiv);
            paragraph.appendChild(fullDiv);
        }
        else {
            this.createMessageDiv(paragraph, role, text, roleString);
        }
    }

    getContentDivAndSetModel(model) {
        if (this.contentDivs.length === 0) {
            post_error_message_in_chat("Content divs", "No content divs available.");
            return null;
        }
        if (this.isArenaMode) {
            // return random content div to avoid bias (one model api could always be faster for some reason, and would therefore always get the first div)
            const index = Math.floor(Math.random() * this.contentDivs.length);
            // if a response gets regenerated, the find condition won't be met, which we want because we already know the models
            const item = this.arenaDivs.find(item => item.contentDiv.isSameNode(this.contentDivs[index]));
            if (item) {
                item.model = model;
            }
            return this.contentDivs.splice(index, 1)[0];
        }
        return this.contentDivs.shift();
    }

    addArenaFooter() {
        const footer = document.createElement('div');
        footer.classList.add('arena-footer');

        const buttons = [
            { text: '\u{2713}', choice: 'model_a' },
            { text: '==', choice: 'draw' },
            { text: '\u{2713}', choice: 'model_b' },
            { text: 'X', choice: 'no_choice(bothbad)' }
        ];
        // add empty div to center the buttons
        footer.appendChild(document.createElement('div'));
        buttons.forEach(btn => {
            const button = document.createElement('button');
            button.classList.add('button', 'arena-button');
            if (btn.choice === 'no_choice(bothbad)') {
                button.classList.add('no-choice');
            }
            else if (btn.choice === 'draw') {
                button.classList.add('draw');
            }
            else {
                button.classList.add('choice');
            }
            button.textContent = btn.text;
            button.onclick = () => this.handleArenaChoice(btn.choice);
            footer.appendChild(button);
            this.arenaButtons.push(button);
        });
        this.hoverOnFunc = this.buttonsHoverEffect.bind(this);
        this.hoverOffFunc = this.buttonsRemoveHoverEffect.bind(this);
        this.arenaButtons.forEach((button) => {
            button.addEventListener('mouseenter', this.hoverOnFunc);
            button.addEventListener('mouseleave', this.hoverOffFunc);
        });
        this.arenaContainer.appendChild(footer);
        this.arenaFooter = footer;
        this.scrollIntoView();
    }

    deleteArenaFooter() {
        const footer = this.arenaFooter;
        // do this so when they slide away they don't trigger the hover effect
        this.arenaButtons.forEach(button => {
            button.removeEventListener('mouseenter', this.hoverOnFunc);
            button.removeEventListener('mouseleave', this.hoverOffFunc);
        });
        this.hoverOnFunc = null;
        this.hoverOffFunc = null;
        this.arenaButtons = [];
        footer.classList.add('slide-left');

        const handleTransitionEnd = (event) => {
            if (event.propertyName === 'opacity') {
                footer.classList.add('slide-up');
            } else if (event.propertyName === 'margin-top') {
                footer.removeEventListener('transitionend', handleTransitionEnd);
                footer.remove();
                this.arenaFooter = null;
            }
        };
    
        footer.addEventListener('transitionend', handleTransitionEnd);
    }

    buttonsHoverEffect(event) {
        const hoveredButton = event.currentTarget;
        if (hoveredButton.classList.contains('choice')) {
            this.arenaButtons.forEach(button => {
                if (button !== hoveredButton) {
                    if (button.classList.contains('choice')) {
                        button.classList.add('choice-not-hovered');
                        button.textContent = 'X';
                    }
                    else {
                        button.classList.add('hovered');
                    }
                }
            });
        }
        else {
            this.arenaButtons.forEach(button => {
                if (button !== hoveredButton) {
                    button.classList.add('hovered');
                    if (button.classList.contains('choice')) {
                        button.textContent = 'X';
                    }
                }
            });
        }
    }

    buttonsRemoveHoverEffect(event) {
        const unhoveredButton = event.currentTarget;
        if (unhoveredButton.classList.contains('choice')) {
            this.arenaButtons.forEach(button => {
                if (button !== unhoveredButton) {
                    if (button.classList.contains('choice')) {
                        button.classList.remove('choice-not-hovered');
                        button.textContent = '\u{2713}';
                    }
                    else {
                        button.classList.remove('hovered');
                    }
                }
            });
        }
        else {
            this.arenaButtons.forEach(button => {
                if (button !== unhoveredButton) {
                    button.classList.remove('hovered');
                    if (button.classList.contains('choice')) {
                        button.textContent = '\u{2713}';
                    }
                }
            });
        }
    }

    handleArenaChoiceDefault() {
        if ((this.arenaDivs.length > 0 || this.arenaButtons.length > 0)) {
            // treated like a draw (one path chosen randomly), without updating the ranking
            this.handleArenaChoice('ignored');
        }
    }

    handleArenaChoice(choice) {
        this.deleteArenaFooter();
        remove_regenerate_buttons();
        let winnerIndex = 0;
        if (choice === 'model_a' || choice === 'model_b') {
            winnerIndex = choice === 'model_a' ? 0 : 1;
        }
        else if (choice === 'draw' || choice === 'ignored') {
            winnerIndex = Math.floor(Math.random() * 2);
        }
        let isNoChoice = choice === 'no_choice(bothbad)';
        let loserIndex = 1 - winnerIndex;
        if (isNoChoice) {
            resolve_pending(null, true);
            this.arenaDivs.forEach(item => this.arenaResultUIUpdate(item, 'arena-loser'));
        }
        else {
            resolve_pending(this.arenaDivs[winnerIndex].model);
            this.arenaResultUIUpdate(this.arenaDivs[winnerIndex], 'arena-winner');
            this.arenaResultUIUpdate(this.arenaDivs[loserIndex], 'arena-loser');
        }
        let resultString = isNoChoice ? 'draw(bothbad)' : resultString;
        arenaRatingManager.addMatchAndUpdate(this.arenaDivs[winnerIndex].model, this.arenaDivs[loserIndex].model, resultString);
        
        this.arenaDivs = [];
        this.isArenaMode = false;
        this.arenaContainer = null;
        if (isNoChoice) {
            // because we thought both models are bad, we don't want to use either response, so start a new arena block with new models for the last user prompt
            // probably not the best way to handle this because that might not always be desired user behaviour, but ok for now,
            // esp. because I don't know yet what would make sense here, maybe changing the last user prompt and redoing it with the same models makes sense
            // we will see...
            api_call();
        }
    }

    handleArenaChoice(choice) {
        this.deleteArenaFooter();
        remove_regenerate_buttons();
    
        const isNoChoice = choice === 'no_choice(bothbad)';
        const resultString = isNoChoice ? 'draw(bothbad)' : choice;
    
        const [model1, model2] = this.arenaDivs.map(item => get_full_model_name(item.model));
    
        let winnerIndex = 0
        if (choice === 'draw' || choice === 'ignored') {
            // this is for UI purposes, to highlight which output was chosen to continue the conversation, this doesn't modify the actual rating
            winnerIndex = Math.floor(Math.random() * 2);
        } else if (choice === 'model_a' || choice === 'model_b') {
            winnerIndex = choice === 'model_a' ? 0 : 1;
        }
        const loserIndex = 1 - winnerIndex;
    
        // Update ratings
        const updatedRatings = arenaRatingManager.addMatchAndUpdate(model1, model2, resultString);
    
        if (isNoChoice) {
            this.arenaDivs.forEach(item => this.arenaResultUIUpdate(item, 'arena-loser', updatedRatings[get_full_model_name(item.model)].rating));
            resolve_pending(null, true);
        } else {
            this.arenaResultUIUpdate(this.arenaDivs[winnerIndex], 'arena-winner', updatedRatings[get_full_model_name(this.arenaDivs[winnerIndex].model)].rating);
            this.arenaResultUIUpdate(this.arenaDivs[loserIndex], 'arena-loser', updatedRatings[get_full_model_name(this.arenaDivs[loserIndex].model)].rating);
            resolve_pending(this.arenaDivs[winnerIndex].model);
        }
    
        this.arenaDivs = [];
        this.isArenaMode = false;
        this.arenaContainer = null;
        if (isNoChoice) {
            api_call();
        }
    }

    arenaResultUIUpdate(arenaItem, classString, elo_rating) {
        const parent = arenaItem.contentDiv.parentElement;
        const prefixes = parent.querySelectorAll('.message-prefix');
        const contentDivs = parent.querySelectorAll('.message-content');
        const tokenFooters = parent.querySelectorAll('.message-footer');
        const full_model_name = get_full_model_name(arenaItem.model);
        prefixes.forEach(prefix => prefix.textContent = `${prefix.textContent.replace(ChatRoleDict.assistant, full_model_name)} (ELO: ${elo_rating})`);
        contentDivs.forEach(contentDiv => contentDiv.classList.add(classString));
        tokenFooters.forEach(footer => {
            const span = footer.querySelector('span');
            span.textContent = span.textContent.replace('~', footer.getAttribute('input-tokens'))
        });
    }

    scrollIntoView() {
        if (this.shouldScroll) {
            this.conversationDiv.scrollIntoView(false);
        }
    }

    antiScrollListener() {
        if (!this.scrollListenerActive) {
            window.addEventListener('wheel', this.handleScrollEvent.bind(this));
        }
        this.scrollListenerActive = true;
        this.shouldScroll = true;
    }

    handleScrollEvent(event) {
        if (this.shouldScroll && event.deltaY < 0) {
            this.shouldScroll = false;
        }
    }
}


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

const ARENA_MODELS = ["sonnet-3.5", "gpt-4o", "gemini-1.5-pro-exp"];
// const ARENA_MODELS = ["gpt-4o-mini", "gemini-1.5-pro-exp"]; // for testing

const MaxTemp = {
    openai: 2.0,
    anthropic: 1.0,
    gemini: 2.0
}

let settings = {};
let messages = [];
let pending_message = {};
let chatManager = new ChatManager();
let arenaRatingManager = null;


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
    chatManager.createMessageBlock(RoleEnum.system, text, "Selected text");
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


function initArenaRatingManager(print_history = false) {
    let arenaManager = new ArenaRatingManager();
    // eh, should probably delete this and do a proper thing
    arenaManager.initDB().then(() => {
        if (print_history) {
            arenaManager.printMatchHistory();
        }
    });
    return arenaManager;
}


function update_settings(changes, namespace) {
    if (namespace !== "sync") return;
    for (let [key, { newValue }] of Object.entries(changes)) {
        if (key in settings && key !== "lifetime_tokens" && key !== "mode") {
            settings[key] = newValue;
        }
        if (key === "arena_mode" && newValue === false) {
            chatManager.isArenaMode = false;
        }
    }
}


function remove_added_paragraphs() {
    const contentDiv = document.getElementById('conversation');
    contentDiv.querySelectorAll('p').forEach(el => el.remove());
}


function api_call(model = null) {
    chatManager.antiScrollListener();
    if (settings.arena_mode) {
        if (ARENA_MODELS.length < 2) {
            post_error_message_in_chat("Arena mode", "Not enough models enabled for Arena mode.");
            return;
        }
        let [model1, model2] = get_random_arena_models();
        chatManager.initArenaMode();
        chatManager.initMessageBlock(RoleEnum.assistant);
        api_call_single(model1);
        api_call_single(model2);
    }
    else {
        model = model || settings.model;
        chatManager.initMessageBlock(RoleEnum.assistant);
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


function get_full_model_name(model) {
    const provider = get_provider_for_model(model);
    return MODELS[provider][model];
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
        let contentDiv = chatManager.getContentDivAndSetModel(model);
        let streamWriter = new StreamWriterSimple(contentDiv, chatManager.scrollIntoView.bind(chatManager));

        let [response_text, input_tokens, output_tokens] = get_response_data_no_stream(data, model);
        streamWriter.processContent(response_text);
        const add_to_pending_with_model = (msg) => add_to_pending(msg, model);
        streamWriter.addFooter(input_tokens, output_tokens, chatManager.isArenaMode, regenerate_response.bind(null, model), add_to_pending_with_model);

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
    let contentDiv = chatManager.getContentDivAndSetModel(model);
    let api_provider = get_provider_for_model(model);
    let tokenCounter = new TokenCounter(api_provider);
    let streamWriter = api_provider === "gemini" ? new StreamWriter(contentDiv, chatManager.scrollIntoView.bind(chatManager), 2000) : new StreamWriterSimple(contentDiv, chatManager.scrollIntoView.bind(chatManager));

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
    const add_to_pending_with_model = (msg) => add_to_pending(msg, model);
    streamWriter.addFooter(tokenCounter.inputTokens, tokenCounter.outputTokens, chatManager.isArenaMode, regenerate_response.bind(null, model), add_to_pending_with_model);
}


function regenerate_response(model, contentDiv) {
    chatManager.onRegenerate(contentDiv);
    chatManager.antiScrollListener();
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


function add_to_pending(message, model) {
    // this is neat because we can only have one "latest" message per model, so if we regenerate many times we just overwrite.
    pending_message[model] = {role: RoleEnum.assistant, content: message};
    chatManager.updatePendingResponses();
}


function resolve_pending(model = null, discard = false) {
    // because of possible weirdness with toggling arena mode on or off while there are pending messages, we prioritize messages like this:
    // "function parameter: model" -> "settings.model" -> "random" message that is pending (potentially multiple if arena mode was on).
    // We care about this at all because the convo is actually supposed to be useful, and we want to pass the best output to continue.
    if (discard) pending_message = {};
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


function post_error_message_in_chat(error_occurred, error_message) {
    return chatManager.createMessageBlock(RoleEnum.system, "Error occurred here: " + error_occurred +  "\nHere is the error message:\n" + error_message);
}


function post_warning_in_chat(warning_message) {
    return chatManager.createMessageBlock(RoleEnum.system, "Warning: " + warning_message);
}


function input_listener() {
    let inputField = document.getElementById('textInput');

    inputField.addEventListener('keydown', function(event) {
        if (inputField === document.activeElement && event.key === 'Enter' && !event.shiftKey) {
            // prevents new line from being added after the field is cleared (because it prolly triggers on keyup also)
            event.preventDefault();
            let inputText = inputField.value;
            if (inputText.trim().length !== 0) {
                chatManager.createMessageBlock(RoleEnum.user, inputText);
                resolve_pending();
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
        chatManager.handleArenaChoiceDefault();
        api_call();
    }
}