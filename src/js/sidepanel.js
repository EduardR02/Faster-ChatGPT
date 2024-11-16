import { ArenaRatingManager, StreamWriter, StreamWriterSimple, Footer, TokenCounter, ModeEnum, get_mode, set_lifetime_tokens,
    auto_resize_textfield_listener, update_textfield_height, is_on } from "./utils.js";


class ChatManager {
    constructor() {
        this.conversationDiv = document.getElementById('conversation');
        this.inputFieldWrapper = document.querySelector('.textarea-wrapper');
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
        this.thinkingModeActive = false;
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
        this.conversationDiv.insertBefore(paragraph, this.inputFieldWrapper);
        return paragraph;
    }

    onRegenerate(contentDiv, thinkingProcess) {
        let parentDiv = contentDiv.parentElement;
        let roleString = ChatRoleDict[RoleEnum.assistant] + ' \u{27F3}';
        this.createMessageDiv(parentDiv, RoleEnum.assistant, thinkingProcess, '', roleString);
    }

    onContinue(contentDiv, thinkingProcess) {
        let parentDiv = contentDiv.parentElement;
        this.createMessageDiv(parentDiv, RoleEnum.assistant, thinkingProcess);
    }

    createMessageDiv(parentElement, role, thinkingProcess = "none", text = '', roleString = null) {
        // unfortunately need this guy in case we want to regenerate a response in arena mode
        let messageWrapper = document.createElement('div');
        messageWrapper.classList.add('message-wrapper');

        let prefixSpan = document.createElement('span');
        prefixSpan.classList.add('message-prefix', role + '-prefix');

        let thinkingModeString = "";
        if (role === RoleEnum.assistant) {
            if (thinkingProcess === "thinking") thinkingModeString = " 🧠";
            else if (thinkingProcess === "solver") thinkingModeString = " 💡";

            // prepend the regenerate symbol to the thinking process string if it's present in the previous prefix span
            if (!roleString && parentElement.hasChildNodes() && parentElement.querySelector('.message-prefix').textContent.includes('\u{27F3}')) {
                thinkingModeString = ' \u{27F3}' + thinkingModeString
            }
        }

        prefixSpan.textContent = (roleString || ChatRoleDict[role]) + thinkingModeString;
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

    initMessageBlock(role, thinkingProcess = "none", roleString = null) {
        this.createMessageBlock(role, '', thinkingProcess, roleString);
    }

    createMessageBlock(role, text, thinkingProcess = "none", roleString = null) {
        let paragraph = this.initParagraph(role);

        if (this.isArenaMode && role === RoleEnum.assistant) {
            let fullDiv = document.createElement('div');
            fullDiv.classList.add('arena-full-container');
            this.arenaContainer = fullDiv;

            let arenaDiv = document.createElement('div');
            arenaDiv.classList.add('arena-wrapper');

            for (let i = 0; i < 2; i++) {
                let contentDiv = this.createMessageDiv(arenaDiv, role, thinkingProcess);
                this.arenaDivs.push({ model: null, contentDiv: contentDiv });
            }

            fullDiv.appendChild(arenaDiv);
            paragraph.appendChild(fullDiv);
        }
        else {
            this.createMessageDiv(paragraph, role, thinkingProcess, text, roleString);
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

    getContentDivIndex(model) {
        if (!this.isArenaMode) return 0;
        return this.arenaDivs.findIndex(item => item.model === model);
    }

    addArenaFooter() {
        const footer = document.createElement('div');
        footer.classList.add('arena-footer');

        const buttons = [
            { text: '\u{1F441}', choice: 'reveal' },
            { text: '\u{2713}', choice: 'model_a' },
            { text: '==', choice: 'draw' },
            { text: '\u{2713}', choice: 'model_b' },
            { text: 'X', choice: 'no_choice(bothbad)' }
        ];
        buttons.forEach(btn => {
            const button = document.createElement('button');
            button.classList.add('button', 'arena-button');
            if (btn.choice === 'no_choice(bothbad)') {
                button.classList.add('no-choice');
            }
            else if (btn.choice === 'draw') {
                button.classList.add('draw');
            }
            else if (btn.choice === 'reveal') {
                button.classList.add('reveal');
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
    
        const isNoChoice = choice === 'no_choice(bothbad)';
        const resultString = isNoChoice ? 'draw(bothbad)' : choice;
    
        const [model1, model2] = this.arenaDivs.map(item => get_full_model_name(item.model));
    
        let winnerIndex = 0
        if (['draw', 'reveal', 'ignored'].includes(choice)) {
            // this is for UI purposes, to highlight which output was chosen to continue the conversation, this doesn't modify the actual rating
            winnerIndex = Math.floor(Math.random() * 2);
        } else if (choice === 'model_a' || choice === 'model_b') {
            winnerIndex = choice === 'model_a' ? 0 : 1;
        }
        const loserIndex = 1 - winnerIndex;
    
        // Update ratings, don't think it makes sense to save the "ignored"/"reveal" category
        let updatedRatings;
        if (choice === 'ignored' || choice === 'reveal') {
            updatedRatings = arenaRatingManager.cachedRatings;
        }
        else {
            updatedRatings = arenaRatingManager.addMatchAndUpdate(model1, model2, resultString);
        }
    
        if (isNoChoice) {
            this.arenaDivs.forEach(item => this.arenaResultUIUpdate(item, 'arena-loser', this.getModelRating(get_full_model_name(item.model), updatedRatings)));
            discard_pending(null);
        } else {
            this.arenaResultUIUpdate(this.arenaDivs[winnerIndex], 'arena-winner', this.getModelRating(get_full_model_name(this.arenaDivs[winnerIndex].model), updatedRatings));
            this.arenaResultUIUpdate(this.arenaDivs[loserIndex], 'arena-loser', this.getModelRating(get_full_model_name(this.arenaDivs[loserIndex].model), updatedRatings));
            resolve_pending(this.arenaDivs[winnerIndex].model);
        }
    
        this.arenaDivs = [];
        this.isArenaMode = false;
        this.arenaContainer = null;
        if (isNoChoice) {
            api_call();
        }
    }

    getModelRating(model, ratingsDict) {
        if (ratingsDict[model]) return ratingsDict[model].rating;
        return 1000;
    }

    arenaResultUIUpdate(arenaItem, classString, elo_rating) {
        const parent = arenaItem.contentDiv.parentElement;
        const prefixes = parent.querySelectorAll('.message-prefix');
        const contentDivs = parent.querySelectorAll('.message-content');
        const tokenFooters = parent.querySelectorAll('.message-footer');
        const full_model_name = get_full_model_name(arenaItem.model);
        const elo_rounded = Math.round(elo_rating * 10) / 10;   // round to one decimal place
        prefixes.forEach(prefix => prefix.textContent = `${prefix.textContent.replace(ChatRoleDict.assistant, full_model_name)} (ELO: ${elo_rounded})`);
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
        "sonnet-3.5": "claude-3-5-sonnet-20240620",
        "sonnet-3.5-new": "claude-3-5-sonnet-20241022"
    },
    gemini: {
        "gemini-1.5-pro-exp-2": "gemini-1.5-pro-exp-0827",
        "gemini-1.5-pro-exp-1114": "gemini-exp-1114",
        "gemini-1.5-pro": "gemini-1.5-pro"
    }
};

const MaxTemp = {
    openai: 2.0,
    anthropic: 1.0,
    gemini: 2.0
}

let settings = {};
let messages = [];
let initial_prompt = "";
let pending_message = {};
let chatManager = new ChatManager();
let arenaRatingManager = null;
let thinkingMode = false;
let thoughtLoops = [0, 0];


document.addEventListener('DOMContentLoaded', init);


function init() {
    // Panel is now fully loaded, you can initialize your message listeners
    // and other functionality here.
    input_listener();
    init_settings();
    init_arena_toggle_button_listener();
    init_thinking_mode_button();
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
    thoughtLoops = [0, 0];
    init_prompt({mode: "selection", text: text, url: url}).then(() => {
        get_mode(function(current_mode) {
            if (current_mode === ModeEnum.InstantPromptMode) {
                append_context("Please explain!", RoleEnum.user);
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
    if (namespace !== "local") return;
    for (let [key, { newValue }] of Object.entries(changes)) {
        if (key in settings && key !== "lifetime_tokens" && key !== "mode") {
            settings[key] = newValue;
            if (key === "arena_mode") {
                arena_toggle_button_update();
            }
        }
    }
}


function remove_added_paragraphs() {
    const contentDiv = document.getElementById('conversation');
    contentDiv.querySelectorAll('p').forEach(el => el.remove());
}


function api_call() {
    chatManager.antiScrollListener();
    const thinkingModeString = thinkingMode ? "thinking" : "none";
    chatManager.thinkingModeActive = thinkingMode;
    thoughtLoops = [0, 0];
    if (settings.arena_mode) {
        if (settings.arena_models.length < 2) {
            post_error_message_in_chat("Arena mode", "Not enough models enabled for Arena mode.");
            return;
        }
        let [model1, model2] = get_random_arena_models();
        chatManager.initArenaMode();
        chatManager.initMessageBlock(RoleEnum.assistant, thinkingModeString);
        api_call_single(model1, thinkingModeString);
        api_call_single(model2, thinkingModeString);
    }
    else {
        chatManager.initMessageBlock(RoleEnum.assistant, thinkingModeString);
        api_call_single(settings.model, thinkingModeString);
    }
}


function get_random_arena_models() {
    // ok fk it, by doing it with calculating random indices it seems to be hard to avoid bias, and doing a while loop is stupid
    // so we'll just do shuffle and pick first, ran this in python for 50 mil iterations on 5 length array, seems unbiased
    function shuffleArray() {
        let array = settings.arena_models.slice();
        for (let i = array.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [array[i], array[j]] = [array[j], array[i]];
        }
        return array;
    }
    let shuffled = shuffleArray();
    return [shuffled[0], shuffled[1]];

}


function api_call_single(model, thoughtProcessState = "none") {
    const [api_link, requestOptions] = create_api_request(model);
    fetch(api_link, requestOptions)
        .then(response => settings.stream_response ? response_stream(response, model, thoughtProcessState) : get_reponse_no_stream(response, model, thoughtProcessState))
        .catch(error => post_error_message_in_chat("api request (likely incorrect key)", error.message));
}


function create_api_request(model) {
    const provider = get_provider_for_model(model);
    const messages_temp = messages.concat(resolve_pending_handler(model));
    switch (provider) {
        case 'openai':
            return create_openai_request(model, messages_temp);
        case 'anthropic':
            return create_anthropic_request(model, messages_temp);
        case 'gemini':
            return create_gemini_request(model, messages_temp);
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


function create_anthropic_request(model, msgs) {
    check_api_key('anthropic');
    const requestOptions = {
        method: 'POST',
        credentials: 'omit',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': settings.api_keys.anthropic,
            'anthropic-version': '2023-06-01',
            'anthropic-dangerous-direct-browser-access': 'true'
        },
        body: JSON.stringify({
            model: MODELS.anthropic[model],
            system: msgs[0].content,
            messages: msgs.slice(1),
            max_tokens: settings.max_tokens,
            temperature: settings.temperature > MaxTemp.anthropic ? MaxTemp.anthropic : settings.temperature,
            stream: settings.stream_response
        })
    };
    return ['https://api.anthropic.com/v1/messages', requestOptions];
}


function create_openai_request(model, msgs) {
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
            messages: msgs,
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


function create_gemini_request(model, msgs) {
    check_api_key("gemini");
    // gemini either has "model" or "user", even the system prompt is classified as "user"
    const mapped_messages = msgs.map(message => ({
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


function get_reponse_no_stream(response, model, thoughtProcessState) {
    response.json().then(data => {
        let contentDiv = chatManager.getContentDivAndSetModel(model);
        let streamWriter = new StreamWriterSimple(contentDiv, chatManager.scrollIntoView.bind(chatManager));
        let response_text, input_tokens, output_tokens;
        try {
            [response_text, input_tokens, output_tokens] = get_response_data_no_stream(data, model);
        }
        catch (error) {
            post_error_message_in_chat("API request error (likely incorrect key)", error.message);
            hadError = true;
        }
        streamWriter.processContent(response_text);
        let msgFooter = new Footer(input_tokens, output_tokens, chatManager.isArenaMode, thoughtProcessState, regenerate_response.bind(null, model));
        const add_to_pending_with_model = (msg, done) => add_to_pending(msg, model, done);
        streamWriter.addFooter(msgFooter, add_to_pending_with_model).then(() => {
            if (!hadError) handleThinkingMode(streamWriter.fullMessage, thoughtProcessState, model, contentDiv);
        });
        set_lifetime_tokens(input_tokens, output_tokens);
    });
}


function get_response_data_no_stream(data, model) {
    const provider = get_provider_for_model(model);
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


// "stolen" from https://umaar.com/dev-tips/269-web-streams-openai/ and https://www.builder.io/blog/stream-ai-javascript
async function response_stream(response_stream, model, thoughtProcessState) {
    // right now you can't "stop generating", too lazy lol
    let contentDiv= chatManager.getContentDivAndSetModel(model);
    let api_provider = get_provider_for_model(model);
    let tokenCounter = new TokenCounter(api_provider);
    let streamWriter;
    const writerSpeed = chatManager.isArenaMode ? 1500 : 2000;
    // problem is that stream speed and how "clunky" it is is a dead giveaway in arena mode for which model/provider it is, so we try to even it out by fixing the speed.
    // unfortunately currently gemini stream still "stutters" for the first few seconds, so it's obvious, but for the other models you can't tell anymore
    // might make sense to add random startup delay, like 2-3 sec
    if (api_provider === "gemini" || chatManager.isArenaMode) {
        streamWriter = new StreamWriter(contentDiv, chatManager.scrollIntoView.bind(chatManager), writerSpeed);
    }
    else {
        streamWriter = new StreamWriterSimple(contentDiv, chatManager.scrollIntoView.bind(chatManager));
    }

    const reader = response_stream.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let hadError = false;

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
        hadError = true;
    }
    tokenCounter.updateLifetimeTokens();
    let msgFooter = new Footer(tokenCounter.inputTokens, tokenCounter.outputTokens, chatManager.isArenaMode, thoughtProcessState, regenerate_response.bind(null, model));
    const add_to_pending_with_model = (msg, done) => add_to_pending(msg, model, done);
    streamWriter.addFooter(msgFooter, add_to_pending_with_model).then(() => {
        if (!hadError) handleThinkingMode(streamWriter.fullMessage, thoughtProcessState, model, contentDiv);
    });
}


function regenerate_response(model, contentDiv) {
    const thinkingProcessString = thinkingMode ? "thinking" : "none";
    chatManager.thinkingModeActive = thinkingMode;
    thoughtLoops[chatManager.getContentDivIndex(model)] = 0;
    chatManager.onRegenerate(contentDiv, thinkingProcessString);
    discard_pending(model);
    chatManager.antiScrollListener();
    if (!chatManager.isArenaMode) model = settings.model;
    togglePrompt(thinkingProcessString);
    api_call_single(model, thinkingProcessString);
}


function handleThinkingMode(msg, thoughtProcessState, model, contentDiv) {
    if (thoughtProcessState !== "thinking") return;
    const idx = chatManager.getContentDivIndex(model);
    thoughtLoops[idx]++;
    let thinkMore = msg.includes("*continue*");
    let thinkingProcessString = thinkMore ? "thinking" : "solver";
    const maxItersReached = thoughtLoops[idx] >= settings.loop_threshold;
    if (thoughtLoops[idx] >= settings.loop_threshold) {
        thinkingProcessString = "solver";
        thinkMore = false;
        thoughtLoops[idx] = 0;
    }
    if (thinkMore) {
        add_to_pending("*System message: continue thinking*", model, false, RoleEnum.user);
    }
    else {
        const system_message = maxItersReached ? "*System message: max iterations reached, solve now*" : "*System message: solve now*";
        add_to_pending(system_message, model, false, RoleEnum.user);
        togglePrompt("solver");
    }
    chatManager.onContinue(contentDiv, thinkingProcessString);
    api_call_single(model, thinkingProcessString);
}


function togglePrompt(promptType = "none") {
    if (messages.length === 0) return;
    switch (promptType) {
        case "thinking":
            messages[0].content = initial_prompt + "\n\n" + settings.thinking_prompt;
            break;
        case "solver":
            messages[0].content = initial_prompt + "\n\n" + settings.solver_prompt;
            break;
        case "none":
            messages[0].content = initial_prompt;
    }
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
        chrome.storage.local.get([prompt_string, 'thinking_prompt', 'solver_prompt'])
            .then(res => {
                if (!res['thinking_prompt'] || !res['solver_prompt']) {
                    post_warning_in_chat("Thinking or solver prompt is empty. If you're not planning to use thinking mode ignore this.");
                }
                messages = [];
                pending_message = {};
                let prompt = res[prompt_string];
                settings.thinking_prompt = res['thinking_prompt'] || "";
                settings.solver_prompt = res['solver_prompt'] || "";
                if (context.mode === "selection") {
                    prompt += `\n"""[${context.url}]"""\n"""[${context.text}]"""`;
                }
                append_context(prompt, RoleEnum.system);
                initial_prompt = prompt;
                resolve();
            })
            .catch(error => {
                post_error_message_in_chat(`loading ${context.mode} prompt file`, error.message);
                reject(error);
            });
    });
}


function init_settings() {
    chrome.storage.local.get(['api_keys', 'max_tokens', 'loop_threshold', 'temperature', 'model', 'stream_response', 'arena_mode', 'arena_models'])
    .then(res => {
        settings = {
            api_keys: res.api_keys || {},
            max_tokens: res.max_tokens,
            temperature: res.temperature,
            loop_threshold: res.loop_threshold,
            model: res.model,
            stream_response: res.stream_response,
            arena_mode: res.arena_mode,
            arena_models: res.arena_models || []
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


function add_to_pending(message, model, done = true, role = RoleEnum.assistant) {
    // this is neat because we can only have one "latest" message per model, so if we regenerate many times we just overwrite.
    if (pending_message[model]) {
        pending_message[model].push({role: role, content: message});
    }
    else {
        pending_message[model] = [{role: role, content: message}];
    }
    if (done) chatManager.updatePendingResponses();
}


function resolve_pending(model = null) {
    // because of possible weirdness with toggling arena mode on or off while there are pending messages, we prioritize messages like this:
    // "function parameter: model" -> "settings.model" -> "random" message that is pending (potentially multiple if arena mode was on).
    // We care about this at all because the convo is actually supposed to be useful, and we want to pass the best output to continue.
    messages.push(...resolve_pending_handler(model));
    pending_message = {};
}


function discard_pending(model = null) {
    if (model && model in pending_message) {
        delete pending_message[model];
    }
    else if (model === null) {
        pending_message = {};
    }
}


function resolve_pending_handler(model = null) {
    if (Object.keys(pending_message).length === 0) return [];
    if (model && model in pending_message) {
        return pending_message[model];
    }
    else if (model && chatManager.isArenaMode) {
        // case for regenerating, you don't want to accidentally include the other models context
        return [];
    }
    else if (settings.model in pending_message) {
        return pending_message[settings.model];
    }
    return pending_message[Object.keys(pending_message)[0]];
}


function adjust_thought_structure(pending_messages) {
    // this actually seems to make it worse, just keep the original convo it's better...
    if (!chatManager.thinkingModeActive || pending_messages.length === 0) {
        return pending_messages;
    }
    let thoughts = [];
    let solution = "";
    let currentState = "thinking";
    let lastUserMessage = "";

    for (let i = 0; i < pending_messages.length; i++) {
        const message = pending_messages[i];
        
        if (message.role === RoleEnum.assistant) {
            if (message.content.includes("*continue*")) {
                thoughts.push(message.content.trim());
            } else if (currentState === "thinking") {
                thoughts.push(message.content);
                currentState = "pre_solution";
            } else {
                solution = message.content;
                currentState = "post_solution";
            }
        }
        else if (message.role === RoleEnum.user) {
            lastUserMessage = message.content;
        }
    }

    let formattedContent = "";
    if (thoughts.length > 0) {
        formattedContent += "Internal Thoughts (user can't see this):\n" + thoughts.join("\n\n") + "\n\n";
    }
    if (solution) {
        formattedContent += "Solution (user can see this):\n" + solution;
    }
    let result =  [{
        role: RoleEnum.assistant,
        content: formattedContent.trim()
    }];
    if (currentState !== "post_solution" && lastUserMessage) {
        result.push({
            role: RoleEnum.user,
            content: lastUserMessage
        });
    }
    return result;
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


function init_arena_toggle_button_listener() {
    const button = document.querySelector('.arena-toggle-button');
    // update button correctly on init
    arena_toggle_button_update();

    button.addEventListener('click', () => {
        settings.arena_mode = !settings.arena_mode;
        arena_toggle_button_update();
    });
}


function init_thinking_mode_button() {
    const button = document.querySelector('.thinking-mode');
    button.addEventListener('click', () => {
        thinkingMode = !thinkingMode;
        if (thinkingMode) button.classList.add('thinking-mode-on');
        else button.classList.remove('thinking-mode-on');
    });
}


function arena_toggle_button_update() {
    const button = document.querySelector('.arena-toggle-button');
    button.textContent = settings.arena_mode ? '\u{2694}' : '\u{1F916}';
    if (settings.arena_mode) button.classList.add('arena-mode-on');
    else button.classList.remove('arena-mode-on');
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
        const lockedThinkingMode = thinkingMode ? "thinking" : "none";
        togglePrompt(lockedThinkingMode);
        api_call();
    }
}