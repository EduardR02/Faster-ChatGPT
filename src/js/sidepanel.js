import {
    ArenaRatingManager, StreamWriter, StreamWriterSimple, Footer, TokenCounter, createElementWithClass,
    auto_resize_textfield_listener, update_textfield_height, ChatStorage, add_codeblock_html } from "./utils.js";
import { ApiManager } from "./api_manager.js";
import { SidepanelStateManager, CHAT_STATE } from './state_manager.js';


class ChatManager {
    constructor() {
        this.conversationDiv = document.getElementById('conversation-wrapper');
        this.scrollToElement = document.getElementById('conversation');
        this.inputFieldWrapper = document.querySelector('.textarea-wrapper');
        this.pendingMediaDiv = null;
        this.pendingImages = [];
        this.pendingFiles = [];
        this.tempFileId = 0;
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
    }

    initArenaMode() {
        stateManager.isArenaModeActive = true;
        this.arenaContainer = null;
        this.arenaFooter = null;
        this.arenaDivs = [];
        this.arenaButtons = [];
        this.pendingResponses = 2;
        if (!arenaRatingManager) arenaRatingManager = initArenaRatingManager();
    }

    updatePendingResponses() {
        if (stateManager.isArenaModeActive) {
            this.pendingResponses--;
            if (this.pendingResponses === 0) {
                this.addArenaFooter();
            }
        }
    }

    initParagraph(role) {
        let paragraph = createElementWithClass('div', role + '-message');
        this.conversationDiv.appendChild(paragraph);
        return paragraph;
    }

    initPendingMediaDiv() {
        if (this.pendingMediaDiv) return;
        this.pendingMediaDiv = this.initParagraph(RoleEnum.user);
        const contentDiv = this.createMessageDiv(this.pendingMediaDiv, RoleEnum.user);
        contentDiv.remove();    // otherwise css gap will account for empty div (it's only pending)
    }

    appendToPendingImages(imagebase64) {
        this.initPendingMediaDiv();

        const img = document.createElement('img');
        img.src = imagebase64;

        const imgWrapper = this.pendingMediaDiv.querySelector('.message-wrapper');
        const imgContainer = createElementWithClass('div', 'image-content');
        imgContainer.appendChild(img);
        if (this.pendingFiles?.length > 0) {
            imgWrapper.insertBefore(imgContainer, imgWrapper.querySelector('.history-system-message'));  // insert before the first file
        } else {
            imgWrapper.appendChild(imgContainer);
        }
        this.pendingImages.push(imagebase64);
    }

    createFileDisplay(file, addRemoveButton = true) {
        this.initPendingMediaDiv();
        const fileDiv = createElementWithClass('div', 'history-system-message collapsed');

        const buttonsWrapper = createElementWithClass('div', 'file-buttons-wrapper');
        const toggleButton = createElementWithClass('button', 'message-prefix system-toggle system-prefix history-sidebar-item');
        const toggleIcon = createElementWithClass('span', 'toggle-icon', '⯈');
        const contentDiv = createElementWithClass('div', 'history-system-content user-file', file.content);

        toggleButton.append(toggleIcon, file.name);
        toggleButton.onclick = () => fileDiv.classList.toggle('collapsed');

        buttonsWrapper.append(toggleButton);
        if (addRemoveButton) {
            const removeFileButton = createElementWithClass('button', 'unset-button rename-cancel remove-file-button', '✕');
            removeFileButton.id = `remove-file-button-${file.tempId}`;
            removeFileButton.onclick = () => this.removeFileFromPrompt(fileDiv, file.tempId);
            buttonsWrapper.append(removeFileButton);
        }
        fileDiv.append(buttonsWrapper, contentDiv);
        return fileDiv;
    }

    addFileToPrompt(file, addRemoveButton = true) {
        const fileDisplay = this.createFileDisplay(file, addRemoveButton);
        this.pendingMediaDiv.querySelector('.message-wrapper').appendChild(fileDisplay);
    }

    removeFileFromPrompt(fileDisplay, fileId) {
        fileDisplay.remove();
        this.pendingFiles = this.pendingFiles.filter(file => file.tempId !== fileId);
    }

    onRegenerate(contentDiv, model, thinkingProcess) {
        let parentDivWrapper = contentDiv.parentElement.parentElement.parentElement;
        let roleString = ChatRoleDict[RoleEnum.assistant] + ' \u{27F3}';
        const paragraph = createElementWithClass('div', `${RoleEnum.assistant}-message`);
        const newContentDiv = this.createMessageDiv(paragraph, RoleEnum.assistant, thinkingProcess, '', roleString);
        parentDivWrapper.appendChild(paragraph);
        // replace the content div in the arenaDivs array with the new one
        if (stateManager.isArenaModeActive) {
            this.arenaDivs.find(item => item.model === model).contentDiv = newContentDiv;
        }
    }

    onContinue(contentDiv, thinkingProcess) {
        let parentDiv = contentDiv.parentElement.parentElement;
        this.createMessageDiv(parentDiv, RoleEnum.assistant, thinkingProcess);
    }

    createMessageDiv(parentElement, role, thinkingProcess = "none", text = '', roleString = null) {
        let thinkingModeString = "";
        if (role === RoleEnum.assistant) {
            if (thinkingProcess === "thinking") thinkingModeString = " 🧠";
            else if (thinkingProcess === "solver") thinkingModeString = " 💡";

            // prepend the regenerate symbol to the thinking process string if it's present in the previous prefix span
            if (!roleString && parentElement.hasChildNodes() && parentElement.querySelector('.message-prefix').textContent.includes('\u{27F3}')) {
                thinkingModeString = ' \u{27F3}' + thinkingModeString
            }
        }
        const prefixSpan = createElementWithClass('span', `message-prefix ${role}-prefix`, (roleString || ChatRoleDict[role]) + thinkingModeString);
        parentElement.appendChild(prefixSpan);

        let contentDiv = createElementWithClass('div', `message-content ${role}-content`, text);
        const messageWrapper = createElementWithClass('div', 'message-wrapper');
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
        if (role === RoleEnum.user && this.pendingMediaDiv) {
            const messageContent = createElementWithClass('div', `message-content ${role}-content`, text);
            this.pendingMediaDiv.querySelector('.message-wrapper').appendChild(messageContent);
            this.pendingMediaDiv = null;
            return;
        }
        const paragraph = this.initParagraph(role);

        if (stateManager.isArenaModeActive && role === RoleEnum.assistant) {
            const fullDiv = createElementWithClass('div', 'arena-full-container');
            this.arenaContainer = fullDiv;

            for (let i = 0; i < 2; i++) {
                const arenaDiv = createElementWithClass('div', 'arena-wrapper');
                const assistantWrapper = createElementWithClass('div', `${RoleEnum.assistant}-message`);
                const contentDiv = this.createMessageDiv(assistantWrapper, role, thinkingProcess);
                this.arenaDivs.push({ model: null, contentDiv: contentDiv });
                arenaDiv.appendChild(assistantWrapper);
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
        if (!stateManager.isArenaModeActive && this.contentDiv === null || stateManager.isArenaModeActive && this.arenaDivs.length !== 2) {
            post_error_message_in_chat("No content divs available.");
            return null;
        }
        if (stateManager.isArenaModeActive) {
            // we only need the contentDiv for the singular case anyway, because we have it in the arenaDivs in this case
            return this.arenaDivs.find(item => item.model === model).contentDiv;
        }
        const contentDiv = this.contentDiv;
        this.contentDiv = null;
        return contentDiv;
    }

    getContentDivIndex(model) {
        if (!stateManager.isArenaModeActive) return 0;
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
        if (currentChat.id !== null && stateManager.shouldSave) {
            chatStorage.updateArenaMessage(currentChat.id, currentChat.messages.length - 1, currentChat.messages[currentChat.messages.length - 1]);
        }

        this.arenaDivs = [];
        stateManager.isArenaModeActive = false;
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
        const parent = arenaItem.contentDiv.parentElement.parentElement.parentElement;
        const prefixes = parent.querySelectorAll('.message-prefix');
        const contentDivs = parent.querySelectorAll('.message-content');
        const tokenFooters = parent.querySelectorAll('.message-footer');
        const full_model_name = arenaItem.model;
        const elo_rounded = Math.round(elo_rating * 10) / 10;   // round to one decimal place
        prefixes.forEach(prefix => prefix.textContent = `${prefix.textContent.replace(ChatRoleDict.assistant, full_model_name)} (ELO: ${elo_rounded})`);
        contentDivs.forEach(contentDiv => {
            if (!contentDiv.classList.contains("thoughts")) contentDiv.classList.add(classString);
        });
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

        const element = this.scrollToElement;
        const threshold = 100;
        const distanceFromBottom = Math.abs(element.scrollHeight - window.scrollY - window.innerHeight);

        if (!this.shouldScroll && event.deltaY > 0 && distanceFromBottom <= threshold) {
            this.shouldScroll = true;
        }
    }
}


const ChatRoleDict = { user: "You", assistant: "Assistant", system: "System" };
const RoleEnum = { system: "system", user: "user", assistant: "assistant" };

let messages = [];
let initial_prompt = "";
let pending_message = {};
const chatManager = new ChatManager();
let arenaRatingManager = null;
let thoughtLoops = [0, 0];

const apiManager = new ApiManager();

const chatStorage = new ChatStorage();
let currentChat = null;

const stateManager = new SidepanelStateManager('chat_prompt');


document.addEventListener('DOMContentLoaded', init);


function init() {
    input_listener();
    init_arena_toggle_button_listener();
    init_thinking_mode_button();
    init_footer_buttons();
    auto_resize_textfield_listener("textInput");
    init_textarea_image_drag_and_drop();
    setup_message_listeners();
    chrome.runtime.sendMessage({ type: "sidepanel_ready" });
}


function setup_message_listeners() {
    chrome.runtime.onMessage.addListener((msg) => {
        if (!stateManager.isOn()) return;
        if (msg.type === 'new_selection') {
            when_new_selection(msg.text, msg.url);
        } else if (msg.type === 'new_chat') {
            when_new_chat();
        } else if (msg.type === 'reconstruct_chat') {
            reconstruct_chat(msg.chat);
            stateManager.isSidePanel = !!msg.isSidePanel;
        }
    });
}

function init_states(chat_name) {
    chatManager.handleArenaChoiceDefault();
    remove_added_paragraphs();
    thoughtLoops = [0, 0];
    stateManager.resetChatState();
    currentChat = chatStorage.createNewChatTracking(chat_name);
    pending_message = {};
    chatManager.pendingMediaDiv = null;
    chatManager.pendingFiles = [];
    chatManager.pendingImages = [];

    document.getElementById("incognito-toggle").classList.remove('active');
    document.getElementById('textInput').value = '';
}


function simple_chat_restart() {
    init_states("New Chat");
    messages = messages.slice(0, 1);    // keep the system message
}


function when_new_selection(text, url) {
    init_states(`Selection from ${url}`);
    chatManager.createMessageBlock(RoleEnum.system, text, 'none', "Selected text");
    init_prompt({ mode: "selection", text: text, url: url }).then(() => {
        if (stateManager.isInstantPromptMode()) {
            append_context("Please explain!", RoleEnum.user);
            api_call();
        }
    });
}


function when_new_chat() {
    if (stateManager.isInstantPromptMode()) {
        post_warning_in_chat("Instant prompt mode does not make sense in chat mode and will be ignored.");
    }
    messages = [];
    init_states("New Chat");
    init_prompt({ mode: "chat" });
}


function reconstruct_chat(chat) {
    if (chat.length === 0 || chat.messages?.length === 0) return;

    messages = [];
    init_states("Continued Chat");
    if (chat.id) {
        currentChat.id = chat.id;
        currentChat.name = chat.name;
    }
    if (chat.messages) chat = chat.messages;
    if (chat[chat.length - 1].responses && !chat[chat.length - 1].continued_with || chat[chat.length - 1].continued_with === "none") {
        chat.pop();     // quick way to deal with unfinished arena messages
    }
    function create_msg_block(msg, isLast) {
        if (msg.role === RoleEnum.user && msg.images) {
            msg.images.forEach(img => chatManager.appendToPendingImages(img));
            if (!isLast) chatManager.pendingImages = [];
        }
        if (msg.role === RoleEnum.user && msg.files) {
            msg.files.forEach(file => {
                if (isLast) file.tempId = chatManager.tempFileId++;
                chatManager.addFileToPrompt(file, isLast);
            });
            if (!isLast) chatManager.pendingFiles = [];
        }
        if (isLast && msg.role === RoleEnum.user) return;
        chatManager.createMessageBlock(msg.role, "");
        const lastMsgHtml = chatManager.conversationDiv.lastChild;
        if (!msg.content) {
            const messages = msg.responses[msg.continued_with].messages;    // continued_with is guaranteed to be proper becuase of earlier check
            msg = { role: RoleEnum.assistant, content: messages[messages.length - 1] };
        }
        lastMsgHtml.querySelector('.message-content').innerHTML = add_codeblock_html(msg.content);
        messages.push(msg);
    }

    // Initialize with system prompt as first message
    if (chat[0].role === RoleEnum.system) {
        initial_prompt = chat[0].content;
        messages.push(chat[0]);
        // don't show the system prompt in the chat
    }

    // Process all messages except the last one
    for (let i = 1; i < chat.length - 1; i++) {
        const msg = chat[i];
        create_msg_block(msg, false);
    }

    // Handle the last message separately
    const lastMsg = chat[chat.length - 1];
    const inputField = document.getElementById('textInput');
    if (chat.length > 1) {
        create_msg_block(lastMsg, true);
    }
    inputField.value = lastMsg.role === RoleEnum.user ? lastMsg.content : '';
    update_textfield_height(inputField);
    currentChat.messages = chat;
    chatManager.scrollIntoView();
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


function remove_added_paragraphs() {
    chatManager.conversationDiv.innerHTML = '';
}


function api_call() {
    chatManager.antiScrollListener();
    stateManager.updateThinkingMode();
    stateManager.updateArenaMode();
    const thinkingModeString = stateManager.thinkingMode ? "thinking" : "none";
    togglePrompt(thinkingModeString);
    thoughtLoops = [0, 0];

    if (stateManager.isArenaModeActive) {
        if (stateManager.getSetting('arena_models').length < 2) {
            post_error_message_in_chat("Not enough models enabled for Arena mode.");
            return;
        }
        let [model1, model2] = get_random_arena_models();
        chatManager.initArenaMode();
        chatManager.initMessageBlock(RoleEnum.assistant, thinkingModeString);
        chatManager.assignModelsToArenaDivs(model1, model2);

        Promise.all([
            makeApiCall(model1, thinkingModeString),
            makeApiCall(model2, thinkingModeString)
        ]).catch(error => {
            post_error_message_in_chat(error.message);
        });
    } else {
        chatManager.initMessageBlock(RoleEnum.assistant, thinkingModeString);
        makeApiCall(stateManager.getSetting('current_model'), thinkingModeString);
    }
}


async function makeApiCall(model, thoughtProcessState) {
    const contentDiv = chatManager.getContentDiv(model);
    const msgs = messages.concat(resolve_pending_handler(model));
    const api_provider = apiManager.getProviderForModel(model);
    const tokenCounter = new TokenCounter(api_provider);
    const isArenaModeActive = stateManager.isArenaModeActive;

    try {
        let streamWriter;
        if (stateManager.getSetting('stream_response') && (isArenaModeActive || api_provider === "gemini")) {
            const writerSpeed = isArenaModeActive ? 2500 : 5000;
            streamWriter = new StreamWriter(contentDiv, chatManager.scrollIntoView.bind(chatManager), writerSpeed);
        } else {
            streamWriter = new StreamWriterSimple(contentDiv, chatManager.scrollIntoView.bind(chatManager));
        }

        const response = await apiManager.callApi(model, msgs, tokenCounter, stateManager.getSetting('stream_response') ? streamWriter : null);

        if (!stateManager.getSetting('stream_response')) {
            if (response?.thoughts !== undefined) {
                streamWriter.setThinkingModel();
                streamWriter.processContent(response.thoughts, true);
                streamWriter.processContent(response.text);
            } else {
                streamWriter.processContent(response);
            }
        }

        const msgFooter = new Footer(tokenCounter.inputTokens, tokenCounter.outputTokens, isArenaModeActive, thoughtProcessState, regenerate_response.bind(null, model));
        const addToPendingWithModel = (msg, done) => add_to_pending(msg, model, done);

        await streamWriter.addFooter(msgFooter, addToPendingWithModel);
        tokenCounter.updateLifetimeTokens();
        handleThinkingMode(streamWriter.fullMessage, thoughtProcessState, model, contentDiv);

    } catch (error) {
        post_error_message_in_chat(error.message);
    }
}


function get_random_arena_models() {
    // ok fk it, by doing it with calculating random indices it seems to be hard to avoid bias, and doing a while loop is stupid
    // so we'll just do shuffle and pick first, ran this in python for 50 mil iterations on 5 length array, seems unbiased
    function shuffleArray() {
        let array = stateManager.getSetting('arena_models').slice();
        for (let i = array.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [array[i], array[j]] = [array[j], array[i]];
        }
        return array;
    }
    let shuffled = shuffleArray();
    return [shuffled[0], shuffled[1]];

}


function regenerate_response(model, contentDiv) {
    stateManager.updateThinkingMode();
    const thinkingProcessString = stateManager.thinkingMode ? "thinking" : "none";
    thoughtLoops[chatManager.getContentDivIndex(model)] = 0;
    chatManager.onRegenerate(contentDiv, model, thinkingProcessString);
    discard_pending(model);
    chatManager.antiScrollListener();
    if (!stateManager.isArenaModeActive) model = stateManager.getSetting('current_model');

    makeApiCall(model, thinkingProcessString);
}


function handleThinkingMode(msg, thoughtProcessState, model, contentDiv) {
    if (thoughtProcessState !== "thinking") return;
    const idx = chatManager.getContentDivIndex(model);
    thoughtLoops[idx]++;
    let thinkMore = msg.includes("*continue*");
    let thinkingProcessString = thinkMore ? "thinking" : "solver";
    const maxItersReached = thoughtLoops[idx] >= stateManager.getSetting('loop_threshold');
    if (maxItersReached) {
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
    makeApiCall(model, thinkingProcessString);
}


function togglePrompt(promptType = "none") {
    if (messages.length === 0) return;
    switch (promptType) {
        case "thinking":
            messages[0].content = initial_prompt + "\n\n" + stateManager.getPrompt('thinking');
            break;
        case "solver":
            messages[0].content = initial_prompt + "\n\n" + stateManager.getPrompt('solver');
            break;
        case "none":
            messages[0].content = initial_prompt;
    }
}


function init_prompt(context) {
    let prompt_string = context.mode + "_prompt";

    return new Promise((resolve, reject) => {
        stateManager.loadPrompt(prompt_string)
            .then(() => {
                messages = [];
                pending_message = {};
                let prompt = stateManager.getPrompt('active_prompt');
                if (context.mode === "selection") {
                    prompt += `\n"""[${context.url}]"""\n"""[${context.text}]"""`;
                }
                append_context(prompt, RoleEnum.system);
                initial_prompt = prompt;
                resolve();
            })
            .catch(error => {
                post_error_message_in_chat(`Error loading ${context.mode} prompt file:\n` + error.message);
                reject(error);
            });
    });
}


function append_context(message, role) {
    // allowed roles are 'user', 'assistant' or system. System is only on init for the prompt.
    messages.push({ role: role, content: message });
    add_pending_files(role);

    // Save to chat history after each message, this function isn't used for assistant messages (pending does that) so we just focus on user messages
    if (currentChat && role === RoleEnum.user) {
        if (currentChat.id === null) {
            currentChat.messages = [...messages];

            if (stateManager.shouldSave) {
                chatStorage.createChatWithMessages(currentChat.title, currentChat.messages).then(res => currentChat.id = res.chatId);
            }
        } else {
            const newMsg = messages[messages.length - 1];
            currentChat.messages.push(newMsg);

            if (currentChat.id !== null && stateManager.shouldSave) {
                chatStorage.addMessages(currentChat.id, [newMsg], currentChat.messages.length - 1);
            }
        }
    }
}


function add_pending_files(role) {
    if (role !== RoleEnum.user) return;
    if (chatManager.pendingImages.length > 0) {
        messages[messages.length - 1].images = chatManager.pendingImages;
    } else if (chatManager.pendingFiles.length > 0) {
        messages[messages.length - 1].files = chatManager.pendingFiles.map(({ tempId, ...rest }) => rest);

        chatManager.pendingFiles.forEach(file => {
            const removeButton = document.getElementById(`remove-file-button-${file.tempId}`);
            if (removeButton) removeButton.remove();
        });
    }
    chatManager.pendingImages = [];
    chatManager.pendingFiles = [];
}


function add_to_pending(message, model, done = true, role = RoleEnum.assistant) {
    if (!stateManager.isArenaModeActive) {
        const historyMsg = { role: role, content: message, model: model };
        currentChat.messages.push(historyMsg);

        if (currentChat.id !== null && stateManager.shouldSave) {
            chatStorage.addMessages(currentChat.id, [historyMsg], currentChat.messages.length - 1);
        }
    }
    else {
        // the arena type message is already instantiated at this point, so all we need to do is to add it,
        // and it doesnt even matter if it's regenerated, because we just push it
        const currentChatMessage = currentChat.messages[currentChat.messages.length - 1];
        const matchingModelKey = Object.keys(currentChatMessage.responses).find(
            key => currentChatMessage.responses[key].name === model
        );
        currentChatMessage.responses[matchingModelKey].messages.push(message);
        if (currentChat.id !== null && stateManager.shouldSave) {
            chatStorage.updateArenaMessage(currentChat.id, currentChat.messages.length - 1, currentChatMessage);
        }
    }
    // this is neat because we can only have one "latest" message per model, so if we regenerate many times we just overwrite.
    if (pending_message[model]) {
        pending_message[model].push({ role: role, content: message });
    }
    else {
        pending_message[model] = [{ role: role, content: message }];
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
    else if (model && stateManager.isArenaModeActive) {
        // case for regenerating, you don't want to accidentally include the other models context
        return [];
    }
    else if (stateManager.getSetting('current_model') in pending_message) {
        return pending_message[stateManager.getSetting('current_model')];
    }
    return pending_message[Object.keys(pending_message)[0]];
}


function adjust_thought_structure(pending_messages) {
    // this actually seems to make it worse, just keep the original convo it's better...
    if (!stateManager.thinkingMode || pending_messages.length === 0) {
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
    let result = [{
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


function post_error_message_in_chat(error_message) {
    return chatManager.createMessageBlock(RoleEnum.system, error_message);
}


function post_warning_in_chat(warning_message) {
    return chatManager.createMessageBlock(RoleEnum.system, "Warning: " + warning_message);
}


function input_listener() {
    let inputField = document.getElementById('textInput');

    inputField.addEventListener('keydown', function (event) {
        if (inputField === document.activeElement && event.key === 'Enter' && !event.shiftKey) {
            // prevents new line from being added after the field is cleared (because it prolly triggers on keyup also)
            event.preventDefault();
            let inputText = inputField.value;
            if (inputText.trim().length !== 0) {
                chatManager.handleArenaChoiceDefault();
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
            post_error_message_in_chat('Error converting image to base64\n' + error.message);
            return null;
        }
    }

    textarea.addEventListener('paste', async function (e) {
        const items = e.clipboardData.items;
        const imageItem = Array.from(items).find(item => item.type.startsWith('image/'));

        if (imageItem) {
            e.preventDefault();
            const file = imageItem.getAsFile();
            const reader = new FileReader();
            reader.onload = e => chatManager.appendToPendingImages(e.target.result);
            reader.readAsDataURL(file);
        }
        // If no image found, let default paste behavior happen
    });

    textarea.addEventListener('drop', async function (e) {
        // Handle local file drops
        if (e.dataTransfer.files.length > 0) {
            const files = Array.from(e.dataTransfer.files);
            for (const file of files) {
                if (file.type.match('image.*')) {
                    const reader = new FileReader();
                    reader.onload = evt => chatManager.appendToPendingImages(evt.target.result);
                    reader.readAsDataURL(file);
                } else if (!file.type.match('video.*')) { // Treat other files as text, except videos
                    const reader = new FileReader();
                    reader.onload = event => {
                        const fileContent = event.target.result;
                        const fileData = { tempId: chatManager.tempFileId, name: file.name, content: fileContent };
                        chatManager.tempFileId++;
                        chatManager.pendingFiles.push(fileData);
                        chatManager.addFileToPrompt(fileData);
                    };
                    reader.onerror = error => post_error_message_in_chat(error.message);
                    reader.readAsText(file);
                }
            }
            return;
        }

        // Handle web image drops
        const imgSrc = new DOMParser()
            .parseFromString(e.dataTransfer.getData('text/html'), 'text/html')
            .querySelector('img')?.src;

        if (imgSrc) {
            const base64String = await urlToBase64(imgSrc);
            if (base64String) {
                chatManager.appendToPendingImages(base64String);
                return;
            }
        }

        // Handle text drops
        const text = e.dataTransfer.getData('text');
        if (text) {
            const start = this.selectionStart;
            this.value = this.value.slice(0, start) + text + this.value.slice(this.selectionEnd);
            update_textfield_height(textarea);
        }
    });
}


function init_arena_toggle_button_listener() {
    const button = document.querySelector('.arena-toggle-button');
    stateManager.runOnReady(arena_toggle_button_update);
    button.addEventListener('click', () => {
        stateManager.toggleArenaMode();
        arena_toggle_button_update();
    });
}


function init_thinking_mode_button() {
    const button = document.querySelector('.thinking-mode');
    button.addEventListener('click', () => {
        stateManager.toggleThinkingMode();
        button.classList.toggle('thinking-mode-on', stateManager.pendingThinkingMode);
    });
}


function init_footer_buttons() {
    const historyButton = document.getElementById('history-button');
    historyButton.addEventListener('click', () => {
        chrome.tabs.create({ url: chrome.runtime.getURL('src/html/history.html') });
    });

    const settingsButton = document.getElementById('settings-button');
    settingsButton.addEventListener('click', () => {
        chrome.runtime.openOptionsPage();
    });

    init_incognito_toggle();
    init_popout_toggle_button();
}


function init_popout_toggle_button() {
    const button = document.getElementById('pop-out-toggle');
    button.addEventListener('click', async () => {
        resolve_pending();
        if (currentChat && currentChat.messages.length === 0)
            currentChat.messages = [...messages];
        if (!currentChat)
            currentChat = [];

        if (stateManager.isSidePanel) {
            // Create new tab and wait for it to be ready
            chrome.tabs.create({
                url: chrome.runtime.getURL('src/html/sidepanel.html')
            });

            // Wait for the "sidepanel ready" message from the new tab
            await new Promise(resolve => {
                chrome.runtime.onMessage.addListener(function listener(message) {
                    if (message.type === "sidepanel_ready") {
                        chrome.runtime.onMessage.removeListener(listener);
                        resolve();
                    }
                });
            });
            chrome.runtime.sendMessage({
                type: "reconstruct_chat",
                chat: currentChat,
                isSidePanel: false
            });

            window.close();
        } else {
            // Using your existing sidepanel logic
            const response = await chrome.runtime.sendMessage({ type: "is_sidepanel_open" });

            if (!response.isOpen) {
                await chrome.runtime.sendMessage({ type: "open_side_panel" });
            }

            await chrome.runtime.sendMessage({
                type: "reconstruct_chat",
                chat: currentChat,
                isSidePanel: true
            });

            window.close();
        }
    });
}


function init_incognito_toggle() {
    const buttonFooter = document.getElementById('sidepanel-button-footer');
    const incognitoToggle = document.getElementById('incognito-toggle');
    const hoverText = buttonFooter.querySelectorAll('.hover-text');

    const updateButtonVisuals = () => {
        incognitoToggle.classList.toggle('active', !stateManager.shouldSave);
    };

    const updateHoverText = (hoverText) => {
        const [hoverTextLeft, hoverTextRight] = hoverText;
        hoverTextLeft.textContent = "start new";
        hoverTextRight.textContent = "incognito chat";
        const hasChatStarted = messages.length > 1;

        if (hasChatStarted && stateManager.isChatNormal()) {
            hoverTextLeft.textContent = "continue";
            hoverTextRight.textContent = "in incognito";
        }
        else if (!hasChatStarted && stateManager.isChatIncognito()) {
            hoverTextLeft.textContent = "leave";
            hoverTextRight.textContent = "incognito";
        }
        else if (hasChatStarted && stateManager.isChatIncognito()) {
            hoverTextLeft.textContent = "actually,";
            hoverTextRight.textContent = "save it please";
        }

        const longestText = Math.max(hoverTextLeft.offsetWidth, hoverTextRight.offsetWidth);
        hoverText.forEach(text => text.style.width = `${longestText}px`);
    };

    incognitoToggle.addEventListener('mouseenter', () => {
        updateHoverText(hoverText);
        buttonFooter.classList.add('showing-text');
    });

    function createTransitionHandler(label) {
        return function handler(event) {
            if (!label.parentElement.classList.contains('showing-text')) {
                label.textContent = "";
                label.style.width = "auto";
            }
            label.removeEventListener('transitionend', handler);
        };
    }

    incognitoToggle.addEventListener('mouseleave', () => {
        buttonFooter.classList.remove('showing-text');
        hoverText.forEach(label => {
            label.addEventListener('transitionend', createTransitionHandler(label));
        });
    });

    stateManager.subscribeToChatReset(simple_chat_restart);

    incognitoToggle.addEventListener('click', () => {
        const hasChatStarted = messages.length > 1;
        stateManager.toggleChatState(hasChatStarted);
        updateHoverText(hoverText);
        updateButtonVisuals();
    });

    updateButtonVisuals();
}


function arena_toggle_button_update() {
    const button = document.querySelector('.arena-toggle-button');
    button.textContent = stateManager.getSetting('arena_mode') ? '\u{2694}' : '\u{1F916}';
    button.classList.toggle('arena-mode-on', stateManager.getSetting('arena_mode'));
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
    if (stateManager.isSettingsEmpty() || messages[0].role !== "system") {
        init_prompt({mode: "chat"}).then(() => {
            if (stateManager.isOn()) {
                append_context(inputText, RoleEnum.user);
                api_call();
            }
        });
    } else {
        remove_regenerate_buttons();
        api_call();
    }
}