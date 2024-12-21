import { ArenaRatingManager, StreamWriter, StreamWriterSimple, Footer, TokenCounter, ModeEnum, get_mode, set_lifetime_tokens,
    auto_resize_textfield_listener, update_textfield_height, is_on, ChatStorage } from "./utils.js";


class ChatManager {
    constructor() {
        this.conversationDiv = document.getElementById('conversation-wrapper');
        this.scrollToElement = document.getElementById('conversation');
        this.inputFieldWrapper = document.querySelector('.textarea-wrapper');
        this.pendingImageDiv = null;
        this.pendingImages = [];
        this.isArenaMode = false;
        this.arenaDivs = [];
        this.arenaButtons = [];
        this.hoverOnFunc = null;
        this.hoverOffFunc = null;
        this.arenaFooter = null;
        this.arenaContainer = null;
        this.contentDiv = null;
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
        let paragraph = document.createElement('div');
        paragraph.classList.add(role + "-message");
        this.conversationDiv.appendChild(paragraph);
        return paragraph;
    }

    initPendingImageDiv() {
        if (this.pendingImageDiv) return;
        this.pendingImageDiv = this.initParagraph(RoleEnum.user);
        this.createMessageDiv(this.pendingImageDiv, RoleEnum.user);
        this.pendingImages = [];
    }

    appendToPendingImageDiv(imagebase64) {
        if (!this.pendingImageDiv) this.initPendingImageDiv();

        const img = document.createElement('img');
        img.src = imagebase64;

        const imgWrapper = this.pendingImageDiv.querySelector('.message-wrapper');
        const insertBeforeDiv = imgWrapper.querySelector('.message-content');
        const imgContainer = document.createElement('div');
        imgContainer.classList.add('image-content', 'user-content');
        imgContainer.appendChild(img);
        imgWrapper.insertBefore(imgContainer, insertBeforeDiv);
        this.pendingImages.push(imagebase64);
    }

    onRegenerate(contentDiv, model, thinkingProcess) {
        let parentDivWrapper = contentDiv.parentElement.parentElement;
        let roleString = ChatRoleDict[RoleEnum.assistant] + ' \u{27F3}';
        const newContentDiv = this.createMessageDiv(parentDivWrapper, RoleEnum.assistant, thinkingProcess, '', roleString);
        // replace the content div in the arenaDivs array with the new one
        if (this.isArenaMode) {
            this.arenaDivs.find(item => item.model === model).contentDiv = newContentDiv;
        }
    }

    onContinue(contentDiv, thinkingProcess) {
        let parentDiv = contentDiv.parentElement.parentElement;
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
            this.contentDiv = contentDiv;
        }
        parentElement.appendChild(messageWrapper);
        this.scrollIntoView();
        return contentDiv;
    }

    initMessageBlock(role, thinkingProcess = "none", roleString = null) {
        this.createMessageBlock(role, '', thinkingProcess, roleString);
    }

    createMessageBlock(role, text, thinkingProcess = "none", roleString = null) {
        if (role === RoleEnum.user && this.pendingImageDiv) {
            this.pendingImageDiv.querySelector('.message-content').textContent = text;
            this.pendingImageDiv = null;
            return;
        }
        let paragraph = this.initParagraph(role);

        if (this.isArenaMode && role === RoleEnum.assistant) {
            let fullDiv = document.createElement('div');
            fullDiv.classList.add('arena-full-container');
            this.arenaContainer = fullDiv;

            for (let i = 0; i < 2; i++) {
                let arenaDiv = document.createElement('div');
                arenaDiv.classList.add('arena-wrapper');
                let contentDiv = this.createMessageDiv(arenaDiv, role, thinkingProcess);
                this.arenaDivs.push({ model: null, contentDiv: contentDiv });
                fullDiv.appendChild(arenaDiv);
            }

            paragraph.appendChild(fullDiv);
        }
        else {
            this.createMessageDiv(paragraph, role, thinkingProcess, text, roleString);
        }
    }

    assignModelsToArenaDivs(modelA, modelB) {
        // at this point the models are already shuffled, so we can just assign them in order
        this.arenaDivs[0].model = modelA;
        this.arenaDivs[1].model = modelB;
        currentChat.messages.push(chatStorage.initArenaMessage(modelA, modelB));
    }

    getContentDiv(model) {
        if (!this.isArenaMode && this.contentDiv === null || this.isArenaMode && this.arenaDivs.length !== 2) {
            post_error_message_in_chat("Content divs", "No content divs available.");
            return null;
        }
        if (this.isArenaMode) {
            // we only need the contentDiv for the singular case anyway, because we have it in the arenaDivs in this case
            return this.arenaDivs.find(item => item.model === model).contentDiv;
        }
        const contentDiv = this.contentDiv;
        this.contentDiv = null;
        return contentDiv;
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
        this.arenaContainer.parentElement.appendChild(footer);
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
        currentChat.messages[currentChat.messages.length - 1].choice = choice;
    
        const isNoChoice = choice === 'no_choice(bothbad)';
        const resultString = isNoChoice ? 'draw(bothbad)' : choice;
    
        const [model1, model2] = this.arenaDivs.map(item => item.model);
    
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
            currentChat.messages[currentChat.messages.length - 1].continued_with = 'none';
            this.arenaDivs.forEach(item => this.arenaResultUIUpdate(item, 'arena-loser', this.getModelRating(item.model, updatedRatings)));
            discard_pending(null);
        } else {
            currentChat.messages[currentChat.messages.length - 1].continued_with = winnerIndex === 0 ? "model_a" : "model_b";
            this.arenaResultUIUpdate(this.arenaDivs[winnerIndex], 'arena-winner', this.getModelRating(this.arenaDivs[winnerIndex].model, updatedRatings));
            this.arenaResultUIUpdate(this.arenaDivs[loserIndex], 'arena-loser', this.getModelRating(this.arenaDivs[loserIndex].model, updatedRatings));
            resolve_pending(this.arenaDivs[winnerIndex].model);
        }

        chatStorage.updateArenaMessage(currentChat.id, currentChat.messages.length - 1, currentChat.messages[currentChat.messages.length - 1]);
    
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
        const parent = arenaItem.contentDiv.parentElement.parentElement;
        const prefixes = parent.querySelectorAll('.message-prefix');
        const contentDivs = parent.querySelectorAll('.message-content');
        const tokenFooters = parent.querySelectorAll('.message-footer');
        const full_model_name = arenaItem.model;
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
            this.scrollToElement.scrollIntoView(false);
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

let chatStorage = new ChatStorage();
let currentChat = null;


document.addEventListener('DOMContentLoaded', init);


function init() {
    // Panel is now fully loaded, you can initialize your message listeners
    // and other functionality here.
    input_listener();
    init_settings();
    init_arena_toggle_button_listener();
    init_thinking_mode_button();
    auto_resize_textfield_listener("textInput");
    init_textarea_image_drag_and_drop();
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
    currentChat = chatStorage.createNewChatTracking(`Selection from ${url}`);

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
        currentChat = chatStorage.createNewChatTracking("New Chat");
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
    const newConversationDiv = document.createElement('div');
    newConversationDiv.classList.add('conversation-wrapper');
    chatManager.conversationDiv.replaceWith(newConversationDiv);
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
        // even if it's just two models selected for arena mode, they are still shuffled every time, meaning no bias in which side they are on
        chatManager.assignModelsToArenaDivs(model1, model2);
        api_call_single(model1, thinkingModeString);
        api_call_single(model2, thinkingModeString);
    }
    else {
        chatManager.initMessageBlock(RoleEnum.assistant, thinkingModeString);
        api_call_single(settings.current_model, thinkingModeString);
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
    for (const [provider, models] of Object.entries(settings.models)) {
        if (model in models) return provider;
    }
    return null;
}


function create_anthropic_request(model, msgs) {
    check_api_key('anthropic');
    msgs = map_msges_to_anthropic_format(msgs);
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
            model: model,
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
    msgs = map_msges_to_openai_format(msgs);
    const requestOptions = {
        method: 'POST',
        credentials: 'omit',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + settings.api_keys.openai
        },
        body: JSON.stringify({
            model: model,
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
    msgs = map_msges_to_gemini_format(msgs);
    // to use images with gemini we need to use file api and im too lazy for that rn, i use sonnet anyway so whatever
    const requestOptions = {
        method: 'POST',
        credentials: 'omit',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            contents: msgs.slice(1),
            systemInstruction: msgs[0],
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
    const requestLink = `https://generativelanguage.googleapis.com/v1beta/models/${model}:${responseType}?${streamParam}key=${settings.api_keys.gemini}`;
    return [requestLink, requestOptions];
}


function map_msges_to_anthropic_format(msgs) {
    return msgs.map(msg => {
        if (msg.role === RoleEnum.user && 'images' in msg) {
            let img_dict = msg.images.map(img => ({ type: 'image', source: 
                {type: 'base64', media_type: get_base64_media_type(img), data: simple_base64_splitter(img)}}));
            return { role: msg.role, content: [{type: 'text', text: msg.content}, ...img_dict] };
        }
        return { role: msg.role, content: msg.content };
    });
}


function map_msges_to_openai_format(msgs) {
    return msgs.map(msg => {
        if (msg.role === RoleEnum.user && 'images' in msg) {
            let img_dict = msg.images.map(img => ({ type: 'image_url', image_url: {url: img}}));
            return { role: msg.role, content: [{type: 'text', text: msg.content}, ...img_dict] };
        }
        return { role: msg.role, content: msg.content };
    });
}


function map_msges_to_gemini_format(msgs) {
    return msgs.map(message => {
        let parts = [];

        // Handle text part
        if (message.content) {
            parts.push({ text: message.content });
        }

        // Handle image parts
        if (message.role === RoleEnum.user && message.images) {
            message.images.forEach(img => {
                parts.push({
                    inline_data: {
                        mime_type: get_base64_media_type(img),
                        data: simple_base64_splitter(img)
                    }
                });
            });
        }
        
        return {
            role: message.role === "assistant" ? "model" : "user",
            parts: parts
        };
    });
}


function simple_base64_splitter(base64_string) {
    return base64_string.split('base64,')[1];
}


function get_base64_media_type(base64_string) {
    return base64_string.split(':')[1].split(';')[0];
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
        let contentDiv = chatManager.getContentDiv(model);
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
    let contentDiv = chatManager.getContentDiv(model);
    let api_provider = get_provider_for_model(model);
    let tokenCounter = new TokenCounter(api_provider);
    let streamWriter;
    const writerSpeed = chatManager.isArenaMode ? 1500 : 2000;
    // problem is that stream speed and how "clunky" it is is a dead giveaway in arena mode for which model/provider it is, so we try to even it out by fixing the speed.
    // unfortunately currently gemini stream still "stutters" for the first few seconds, so it's obvious, but for the other models you can't tell anymore
    // might make sense to add random startup delay, like 2-3 sec
    if (api_provider.trim() === "gemini" || chatManager.isArenaMode) {
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
    chatManager.onRegenerate(contentDiv, model, thinkingProcessString);
    discard_pending(model);
    chatManager.antiScrollListener();
    if (!chatManager.isArenaMode) model = settings.current_model;
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
    chrome.storage.local.get(['api_keys', 'max_tokens', 'loop_threshold', 'temperature', 'current_model', 'stream_response', 'arena_mode', 'arena_models', 'models'])
    .then(res => {
        settings = {
            api_keys: res.api_keys || {},
            max_tokens: res.max_tokens,
            temperature: res.temperature,
            loop_threshold: res.loop_threshold,
            current_model: res.current_model,
            stream_response: res.stream_response,
            arena_mode: res.arena_mode,
            arena_models: res.arena_models || [],
            models: res.models || {}
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
    if (role === RoleEnum.user && chatManager.pendingImages.length > 0) {
        messages[messages.length - 1].images = chatManager.pendingImages;
        chatManager.pendingImages = [];
    }

    // Save to chat history after each message, this function isn't used for assistant messages (pending does that) so we just focus on user messages
    if (currentChat && role === RoleEnum.user) {
        if (currentChat.id === null) {
            currentChat.messages = [...messages];
            chatStorage.createChatWithMessages(currentChat.title, messages).then(res => currentChat.id = res.chatId);
        } else {
            const newMsg = messages[messages.length - 1];
            currentChat.messages.push(newMsg);
            chatStorage.addMessages(currentChat.id, [newMsg], currentChat.messages.length - 1);
        }
    }
}


function add_to_pending(message, model, done = true, role = RoleEnum.assistant) {
    if (!chatManager.isArenaMode) {
        const historyMsg = {role: role, content: message, model: model};
        currentChat.messages.push(historyMsg);
        chatStorage.addMessages(currentChat.id, [historyMsg], currentChat.messages.length - 1);
    }
    else {
        // the arena type message is already instantiated at this point, so all we need to do is to add it,
        // and it doesnt even matter if it's regenerated, because we just push it
        const currentChatMessage = currentChat.messages[currentChat.messages.length - 1];
        const matchingModelKey = Object.keys(currentChatMessage.responses).find(
            key => currentChatMessage.responses[key].name === model
        );
        currentChatMessage.responses[matchingModelKey].messages.push(message);
        chatStorage.updateArenaMessage(currentChat.id, currentChat.messages.length - 1, currentChatMessage);
    }
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
    // "function parameter: model" -> "settings.current_model" -> "random" message that is pending (potentially multiple if arena mode was on).
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
    else if (settings.current_model in pending_message) {
        return pending_message[settings.current_model];
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


function init_textarea_image_drag_and_drop() {
    const textarea = document.getElementById('textInput');
 
    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
        textarea.addEventListener(eventName, e => {
            e.preventDefault();
            e.stopPropagation();
            if (eventName === 'dragover' || eventName === 'dragenter') {
                textarea.classList.add('dragging');
            } 
            else {
                textarea.classList.remove('dragging');
            }
        }, false);
    });
 
    async function urlToBase64(url) {
        try {
            const blob = await (await fetch(url)).blob();
            return new Promise(resolve => {
                const reader = new FileReader();
                reader.onload = e => resolve(e.target.result);
                reader.readAsDataURL(blob);
            });
        } catch (error) {
            post_error_message_in_chat(error, 'Error converting image to base64');
            return null;
        }
    }

    textarea.addEventListener('paste', async function(e) {
        const items = e.clipboardData.items;
        const imageItem = Array.from(items).find(item => item.type.startsWith('image/'));
        
        if (imageItem) {
            e.preventDefault();
            const file = imageItem.getAsFile();
            const reader = new FileReader();
            reader.onload = e => chatManager.appendToPendingImageDiv(e.target.result);
            reader.readAsDataURL(file);
        }
        // If no image found, let default paste behavior happen
    });
 
    textarea.addEventListener('drop', async function(e) {
        // Handle local file drops
        if (e.dataTransfer.files.length > 0) {
            const file = e.dataTransfer.files[0];
            if (file.type.match('image.*')) {
                const reader = new FileReader();
                reader.onload = e => chatManager.appendToPendingImageDiv(e.target.result);
                reader.readAsDataURL(file);
                return;
            }
        }
 
        // Handle web image drops
        const imgSrc = new DOMParser()
            .parseFromString(e.dataTransfer.getData('text/html'), 'text/html')
            .querySelector('img')?.src;
            
        if (imgSrc) {
            const base64String = await urlToBase64(imgSrc);
            if (base64String) {
                chatManager.appendToPendingImageDiv(base64String);
                return;
            }
        }
 
        // Handle text drops
        const text = e.dataTransfer.getData('text');
        if (text) {
            const start = this.selectionStart;
            this.value = this.value.slice(0, start) + text + this.value.slice(this.selectionEnd);
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