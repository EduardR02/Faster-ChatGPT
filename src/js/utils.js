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
        max_tokens: 500,
        temperature: 1.2,
        model : "gpt-4o-mini",
        api_keys: {},
        close_on_deselect: true,
        stream_response: true
    }
    chrome.storage.sync.set(settings);
    // for some reason relative path does not work, only full path.
    // possibly because function is called on startup in background worker, and maybe the context is the base dir then.
    loadTextFromFile("src/prompts/prompt.txt").then((text) => {
        chrome.storage.local.set({selection_prompt: text.trim()})
    });
    loadTextFromFile("src/prompts/chat_prompt.txt").then((text) => {
        chrome.storage.local.set({chat_prompt: text.trim()})
    });
}


export class TokenCounter {
    constructor(provider) {
        this.provider = provider;
        this.inputTokens = 0;
        this.outputTokens = 0;
    }

    update(inputTokens, outputTokens) {
        if (this.provider === 'gemini') {
            // Gemini API returns the total token count up to that point in the stream, so last value is the total.
            this.inputTokens = inputTokens;
            this.outputTokens = outputTokens;
        } else {
            this.inputTokens += inputTokens;
            this.outputTokens += outputTokens;
        }
    }

    updateLifetimeTokens() {
        set_lifetime_tokens(this.inputTokens, this.outputTokens);
    }
}


export class StreamWriterSimple {
    constructor(contentDiv, conversationDiv) {
        this.contentDiv = contentDiv;
        this.conversationDiv = conversationDiv;
        this.message = [];
    }

    processContent(content) {
        this.message.push(content);
        this.contentDiv.textContent += content;
        this.conversationDiv.scrollIntoView(false);
    }
}


export class StreamWriter {
    constructor(contentDiv, conversationDiv, wordsPerMinute = 200) {
        this.contentDiv = contentDiv;
        this.conversationDiv = conversationDiv;
        this.contentQueue = [];
        this.isProcessing = false;
        this.delay = 12000 / wordsPerMinute;    // wpm to ms per char conversion
        this.accumulatedChars = 0;
        this.lastFrameTime = 0;
        this.message = [];
    }

    processContent(content) {
        this.message.push(content);
        this.contentQueue = this.contentQueue.concat(content.split(""));

        if (!this.isProcessing) {
            this.isProcessing = true;
            this.processCharacters();
        }
    }

    processCharacters() {
        requestAnimationFrame((currentTime) => {
            if (this.contentQueue.length > 0) {
                const elapsed = currentTime - this.lastFrameTime;

                this.accumulatedChars += elapsed / this.delay;
                const charsToProcess = Math.floor(this.accumulatedChars);
                this.accumulatedChars -= charsToProcess;

                const chunk = this.contentQueue.splice(0, charsToProcess);

                this.contentDiv.textContent += chunk.join('');
                this.conversationDiv.scrollIntoView(false);

                this.lastFrameTime = currentTime;
                this.processCharacters();
            } else {
                this.isProcessing = false;
            }
        });
    }
}


export const ModeEnum = {"InstantPromptMode": 0, "PromptMode": 1, "Off": 2};