export function get_mode(callback) {
    chrome.storage.local.get('mode', function (res) {
        callback(res.mode);
    });
}


export function set_mode(new_mode) {
    chrome.storage.local.set({ mode: new_mode });
}


export function is_on(mode) {
    return mode !== ModeEnum.Off;
}


export function get_lifetime_tokens(callback) {
    chrome.storage.local.get(['lifetime_input_tokens', 'lifetime_output_tokens'], function (res) {
        callback({
            input: res.lifetime_input_tokens || 0,
            output: res.lifetime_output_tokens || 0
        });
    });
}


export function set_lifetime_tokens(newInputTokens, newOutputTokens) {
    get_lifetime_tokens(function (currentTokens) {
        chrome.storage.local.set({
            lifetime_input_tokens: currentTokens.input + newInputTokens,
            lifetime_output_tokens: currentTokens.output + newOutputTokens
        });
    });
}


export function get_stored_models() {
    return new Promise((resolve) => {
        chrome.storage.local.get(['models'], function (result) {
            resolve(result.models || {});
        });
    });
}


export function add_model_to_storage(provider, apiString, displayName) {
    return new Promise((resolve) => {
        get_stored_models().then(models => {
            if (!models[provider]) {
                models[provider] = {};
            }
            models[provider][apiString] = displayName;
            chrome.storage.local.set({ models: models }, () => {
                resolve(models);
            });
        });
    });
}


export function remove_model_from_storage(apiString) {
    return new Promise((resolve) => {
        get_stored_models().then(models => {
            for (const provider in models) {
                if (models[provider][apiString]) {
                    delete models[provider][apiString];
                    if (Object.keys(models[provider]).length === 0) {
                        delete models[provider];
                    }
                    chrome.storage.local.set({ models: models }, () => {
                        resolve(models);
                    });
                    return;
                }
            }
            resolve(models); // Model not found
        });
    });
}


// Process code blocks only at the end (poor man's streamed codeblock) (claude magic)
export function formatContent(message) {
    initializeCodeblockCopyHandler();

    let processedMessage = message
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');

    const codeBlockRegex = /(\n*)```(\w*)\n([\s\S]*?)```(\n+|$)/g;
    processedMessage = processedMessage.replace(codeBlockRegex, (match, preNewlines, lang, code, postNewlines) => {
        const buttonHtml = createCopyButtonHtml();
        return `\n\n<div class="code-container">${buttonHtml}<div class="code-style"><code class="language-${lang}">${code}</code></div></div>\n`;
    });

    const markdownLinkRegex = /\[([^\]]+)\]\((https?:\/\/[^\)\s]+)\)/g;
    processedMessage = processedMessage.replace(markdownLinkRegex, (match, linkText, url) => {
        return `<a href="${url}" target="_blank" rel="noopener noreferrer">${linkText}</a>`;
    });

    return processedMessage;
}


// make sure to include highlight.js in the html file
export function highlightCodeBlocks(contentDiv) {
    const codeBlocks = contentDiv.querySelectorAll('code');
    codeBlocks.forEach(code => {
        hljs.highlightElement(code);
    });
}


const copyButtonSvg = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" class="icon-xs"><path fill-rule="evenodd" clip-rule="evenodd" d="M7 5C7 3.34315 8.34315 2 10 2H19C20.6569 2 22 3.34315 22 5V14C22 15.6569 20.6569 17 19 17H17V19C17 20.6569 15.6569 22 14 22H5C3.34315 22 2 20.6569 2 19V10C2 8.34315 3.34315 7 5 7H7V5ZM9 7H14C15.6569 7 17 8.34315 17 10V15H19C19.5523 15 20 14.5523 20 14V5C20 4.44772 19.5523 4 19 4H10C9.44772 4 9 4.44772 9 5V7ZM5 9C4.44772 9 4 9.44772 4 10V19C4 19.5523 4.44772 20 5 20H14C14.5523 20 15 19.5523 15 19V10C15 9.44772 14.5523 9 14 9H5Z" fill="currentColor"></path></svg>`;
function createCopyButtonHtml() {
    return `<button class="unset-button copy-code-button" aria-label="Copy to clipboard" title="Copy">${copyButtonSvg}</button>`;
}


let isCopyHandlerInitialized = false;   // make sure only one listener per script
function initializeCodeblockCopyHandler() {
    if (isCopyHandlerInitialized) return;

    document.addEventListener('click', (event) => {
        // Use closest to find a relevant button ancestor from the clicked target
        const copyButton = event.target.closest('.copy-code-button');

        // If a non-disabled button was clicked, handle it
        if (copyButton && !copyButton.disabled) {
            handleCopyClick(copyButton);
        }
    });

    isCopyHandlerInitialized = true;
}


function handleCopyClick(buttonElement) {
    const container = buttonElement.closest('.code-container');
    const codeElement = container?.querySelector('.code-style code');

    if (!codeElement) return;

    const codeToCopy = codeElement.textContent.trim();

    navigator.clipboard.writeText(codeToCopy).then(() => {
        buttonElement.classList.add('copied');

        const handleTransitionEnd = () => {
            buttonElement.classList.remove('copied');
            buttonElement.removeEventListener('transitionend', handleTransitionEnd);
        };
        
        buttonElement.addEventListener('transitionend', handleTransitionEnd);
    });
}


export function auto_resize_textfield_listener(element_id) {
    let inputField = document.getElementById(element_id);

    inputField.addEventListener('input', () => update_textfield_height(inputField));
    window.addEventListener('resize', () => update_textfield_height(inputField));
    update_textfield_height(inputField);
}


export function update_textfield_height(inputField) {
    if (!inputField) return;
    inputField.style.height = 'auto'; // Reset height first

    const topButtonArea = document.querySelector('.chatbox-button-container');
    const topButtonHeight = topButtonArea ? topButtonArea.offsetHeight : 0;

    // Get the container for bottom-left controls
    const bottomLeftControls = document.querySelector('.textarea-bottom-left-controls');
    let bottomOffset = 0;

    if (bottomLeftControls) {
        // Temporarily make visible if needed to measure accurately, then hide back if needed
        // This is tricky if the sonnet button visibility logic runs separately.
        // A simpler way is to check if *any* child is visible.
        const isAnyControlVisible = Array.from(bottomLeftControls.children).some(
            child => child.offsetParent !== null // Check if element is rendered
        );

        if (isAnyControlVisible) {
             // Get the actual rendered height of the container
             const controlsHeight = bottomLeftControls.offsetHeight;
             bottomOffset = controlsHeight > 0 ? controlsHeight + 10 : 0; // Use container height + 10px padding
        }
    }

    // Use the larger of the top buttons height or the scroll height + bottom offset
    const requiredHeight = Math.max(inputField.scrollHeight + bottomOffset, topButtonHeight);
    inputField.style.height = requiredHeight + 'px';
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


export function createElementWithClass(type, className, textContent = null) {
    const elem = document.createElement(type);
    if (className) elem.className = className;
    if (textContent) elem.textContent = textContent;
    return elem;
}


export function set_defaults() {
    const MODELS = {
        openai: {
            "gpt-4": "GPT-4",
            "gpt-4-turbo-preview": "GPT-4 Turbo",
            "chatgpt-4o-latest": "GPT-4o latest",
            "gpt-4o-mini": "GPT-4o mini"
        },
        anthropic: {
            "claude-3-5-sonnet-20240620": "Sonnet 3.5",
            "claude-3-5-sonnet-20241022": "Sonnet 3.5 new"
        },
        gemini: {
            "gemini-exp-1206": "Gemini Exp 1206",
            "gemini-2.0-flash-exp": "Gemini Flash 2.0",
        },
        deepseek: {
            "deepseek-chat": "DeepSeek V3",
            "deepseek-reasoner": "DeepSeek R1"
        },
        grok: {
            "grok-3": "Grok 3",
            "grok-3-mini": "Grok 3 Mini",
            "grok-4": "Grok 4"
        }
    };
    const anthropic_models = Object.keys(MODELS.anthropic);
    let settings = {
        mode: ModeEnum.PromptMode,
        lifetime_input_tokens: 0,
        lifetime_output_tokens: 0,
        max_tokens: 4000,
        temperature: 1.0,
        loop_threshold: 3,
        reasoning_effort: 'medium',
        show_model_name: false,     // show model name in chat
        current_model: anthropic_models[anthropic_models.length - 1],
        models: MODELS,
        api_keys: {},
        close_on_deselect: false,
        stream_response: true,
        arena_mode: false
    };

    return Promise.all([
        new Promise((resolve) => chrome.storage.local.set(settings, resolve)),
        // for some reason relative path does not work, only full path.
        // possibly because function is called on startup in background worker, and maybe the context is the base dir then.
        loadTextFromFile("src/prompts/prompt.txt").then((text) =>
            new Promise((resolve) => chrome.storage.local.set({ selection_prompt: text.trim() }, resolve))
        ),
        loadTextFromFile("src/prompts/chat_prompt.txt").then((text) =>
            new Promise((resolve) => chrome.storage.local.set({ chat_prompt: text.trim() }, resolve))
        )
    ]);
}


export class TokenCounter {
    constructor(provider) {
        this.provider = provider;
        this.inputTokens = 0;
        this.outputTokens = 0;
    }

    update(inputTokens, outputTokens) {
        const isGemini = this.provider === 'gemini';
        if (typeof inputTokens === 'number') {
            this.inputTokens = isGemini ? inputTokens : this.inputTokens + inputTokens;
        }
        if (typeof outputTokens === 'number') {
            this.outputTokens = isGemini ? outputTokens : this.outputTokens + outputTokens;
        }
    }

    updateLifetimeTokens() {
        set_lifetime_tokens(this.inputTokens, this.outputTokens);
    }
}


export class Footer {
    constructor(inputTokens, outputTokens, isArenaMode, isThinkingFunc, regenerate_response) {
        this.inputTokens = inputTokens;
        this.outputTokens = outputTokens;
        this.isArenaMode = isArenaMode;
        this.isThinkingFunc = isThinkingFunc;
        this.regenerate_response = regenerate_response;
    }

    create(contentDiv) {
        let footerDiv = document.createElement("div");
        footerDiv.classList.add("message-footer");
        // need span to be able to calculate the width of the text in css for the centering animation
        let tokensSpan = document.createElement('span');
        tokensSpan.textContent = `${this.isArenaMode ? "~" : this.inputTokens} | ${this.outputTokens}`;
        footerDiv.setAttribute('input-tokens', this.inputTokens);
        footerDiv.appendChild(tokensSpan);
        if (!this.isThinkingFunc()) {
            this.createRegenerateButton(footerDiv);
        }
        else {
            footerDiv.classList.add('centered');
        }
        contentDiv.appendChild(footerDiv);
    }

    createRegenerateButton(footerDiv) {
        let regerateButton = document.createElement("button");
        regerateButton.textContent = '\u{21BB}'; // refresh symbol
        regerateButton.classList.add("button", "regenerate-button");
        regerateButton.addEventListener('click', () => {
            this.regenerate_response();
            regerateButton.classList.add('fade-out');
            const handleTransitionEnd = (event) => {
                if (event.propertyName === 'opacity') {
                    regerateButton.remove();
                    footerDiv.classList.add('centered');
                }
            };

            regerateButton.addEventListener('transitionend', handleTransitionEnd);
        });
        footerDiv.appendChild(regerateButton);
    }
}


export class StreamWriterBase {
    // class for auto renaming history items with streamed response from llm api
    constructor(contentDiv = null) {
        this.contentDiv = contentDiv;
        this.message = [];
        this.fullMessage = "";
        this.isFirstChunk = true;
    }

    setThinkingModel() {
        return; // do nothing for base class
    }

    processContent(content, isThought = false) {
        if (isThought) return;  // simply discard thoughts, as we only care about the final output for renaming here
        this.message.push(content);
        if (this.contentDiv) {
            if (this.isFirstChunk) {
                this.contentDiv.textContent = "";
                this.isFirstChunk = false;
            }
            this.contentDiv.append(content);
        }
    }

    done() {
        this.fullMessage = this.message.join('');
        return this.fullMessage;
    }
}


export class StreamWriterSimple {
    constructor(contentDiv, produceNextContentDivFunc, scrollFunc = () => {}) {
        this.contentDiv = contentDiv;
        this.produceNextContentDivFunc = produceNextContentDivFunc;
        this.scrollFunc = scrollFunc;
        this.parts = [ { type: 'text', content: [] } ];
        this.thoughtEndToggle = true;
        this.thinkingModelWithCounter = false;
        this.thinkingIntervalId = null;
    }

    setThinkingModel() {
        this.thoughtEndToggle = false;
        this.contentDiv.classList.add('thoughts');
        this.parts = [ { type: 'thought', content: [] } ];
    }

    addThinkingCounter() {
        const span = this.contentDiv.parentElement.parentElement.querySelector('.message-prefix');
        if (!span) return;
        
        this.thinkingModelWithCounter = true;
        let seconds = 0;
        let hasProcessed = false;

        // Split and preserve all parts of the text
        const originalText = span.textContent;
        const [firstWord, ...remainingWords] = originalText.split(' ');
        const remainingText = remainingWords.length ? ' ' + remainingWords.join(' ') : '';

        const updateCounter = () => {
            if (hasProcessed) return;
            seconds++;
            span.textContent = `${firstWord} thinking for ${seconds} seconds...${remainingText}`;
        };

        this.stopThinkingCounter();
        this.thinkingIntervalId = setInterval(updateCounter, 1000);

        // Override processContent to catch first content
        const originalProcessContent = this.processContent.bind(this);
        this.processContent = (content) => {
            if (!hasProcessed) {
                hasProcessed = true;
                this.stopThinkingCounter();
                if (content) {
                    span.textContent = `${firstWord} thought for ${seconds} seconds${remainingText}`;
                }
            }
            originalProcessContent(content);
        };
    }

    stopThinkingCounter() {
        if (this.thinkingIntervalId) {
            clearInterval(this.thinkingIntervalId);
            this.thinkingIntervalId = null;
        }
    }

    processContent(content, isThought = false) {
        if (!isThought) {
            if (!this.thoughtEndToggle) {
                this.thoughtEndToggle = true;
                this.nextPart();
            }
        }
        this.parts.at(-1).content.push(content);
        this.contentDiv.append(content);
        this.scrollFunc();
    }

    nextPart(isThought = false) {
        this.finalizePart();
        this.parts.push({ type: isThought ? 'thought' : 'text', content: [] });
        this.switchContentDiv(isThought);
    }

    switchContentDiv(isThought = false) {
        const newContentDiv = this.produceNextContentDivFunc('assistant', isThought);
        this.contentDiv.parentElement.appendChild(newContentDiv);
        this.contentDiv = newContentDiv;
    }

    finalizePart() {
        this.parts.at(-1).content = this.parts.at(-1).content.join('');
        this.contentDiv.innerHTML = formatContent(this.parts.at(-1).content);
        highlightCodeBlocks(this.contentDiv);
    }

    addFooter(footer) {
        this.finalizePart();
        footer.create(this.contentDiv);
        this.scrollFunc();
        return new Promise((resolve) => resolve());
    }
}


export class StreamWriter extends StreamWriterSimple {
    constructor(contentDiv, produceNextContentDivFunc, scrollFunc, wordsPerMinute = 200) {
        super(contentDiv, produceNextContentDivFunc, scrollFunc);
        this.contentQueue = [];
        this.isProcessing = false;
        this.delay = 12000 / wordsPerMinute;    // wpm to ms per char conversion
        this.accumulatedChars = 0;
        this.lastFrameTime = 0;
        this.pendingFooter = null;
    }

    setThinkingModel() {
        super.setThinkingModel();
        this.pendingSwitch = false;
        this.pendingQueue = [];
    }

    processContent(content, isThought = false) {
        if (!isThought) {
            if (!this.thoughtEndToggle) {
                this.thoughtEndToggle = true;
                if (this.parts.at(-1).content.length > 0) {
                    this.pendingSwitch = true;
                    this.parts.at(-1).content = this.parts.at(-1).content.join('');
                } else {
                    this.parts.pop();
                    this.contentDiv.classList.remove('thoughts');
                }
                this.parts.push({ type: isThought ? 'thought' : 'text', content: [] });
            }
        }
        this.parts.at(-1).content.push(content);

        if (this.pendingSwitch) {
            this.pendingQueue.push(...content.split(""));
        }
        else {
            this.contentQueue.push(...content.split(""));
        }

        if (!this.isProcessing) {
            this.isProcessing = true;
            this.lastFrameTime = 0;
            this.processCharacters();
        }
    }

    processCharacters() {
        requestAnimationFrame((currentTime) => {
            if (this.contentQueue.length > 0) {
                if (this.lastFrameTime === 0) {
                    this.lastFrameTime = currentTime;
                }
                const elapsed = currentTime - this.lastFrameTime;

                this.accumulatedChars += elapsed / this.delay;
                const charsToProcess = Math.floor(this.accumulatedChars);
                this.accumulatedChars -= charsToProcess;

                const chunk = this.contentQueue.splice(0, charsToProcess);

                this.contentDiv.append(chunk.join(''));
                this.scrollFunc();

                if (this.thoughtEndToggle && this.pendingSwitch && this.contentQueue.length === 0) {
                    this.pendingSwitch = false;
                    this.contentQueue.push(...this.pendingQueue);
                    delete this.pendingQueue;
                    this.contentDiv.innerHTML = formatContent(this.parts.at(-2).content);
                    highlightCodeBlocks(this.contentDiv);
                    this.switchContentDiv(this.parts.at(-1).type === 'thought');
                }

                this.lastFrameTime = currentTime;
                this.processCharacters();
            } else {
                this.isProcessing = false;
                if (this.pendingFooter) {
                    const { footer, resolve } = this.pendingFooter;
                    this.pendingFooter = null;
                    super.addFooter(footer).then(resolve);
                }
            }
        });
    }

    addFooter(footer) {
        if (this.isProcessing) {
            return new Promise((resolve) => {
                this.pendingFooter = { footer, resolve }; // Save the resolve function to call later
            });
        } else {
            return super.addFooter(footer);
        }
    }
}


export class PromptStorage {
    constructor() {
        this.dbName = 'llm-prompts';
        this.dbVersion = 1;
    }

    async getDB() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, this.dbVersion);
            
            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                if (!db.objectStoreNames.contains('prompts')) {
                    const store = db.createObjectStore('prompts', { keyPath: ['name', 'type'] })
                    store.createIndex('type', 'type');
                }
            };

            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    async addPrompt(name, type, content, overwrite = false) {
        const db = await this.getDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction('prompts', 'readwrite');
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
            
            const store = tx.objectStore('prompts');
            if (overwrite) {
                store.put({ name, type, content });
            }
            else {
                store.add({ name, type, content });
            }
        });
    }

    async getPrompt(name) {
        const db = await this.getDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction('prompts', 'readonly');
            const store = tx.objectStore('prompts');
            const request = store.get(name);
            
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    async getAllPrompts() {
        const db = await this.getDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction('prompts', 'readonly');
            const store = tx.objectStore('prompts');
            const request = store.getAll();
            
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    async deletePrompt(name) {
        const db = await this.getDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction('prompts', 'readwrite');
            const store = tx.objectStore('prompts');
            const request = store.delete(name);
            
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }
}


export class ArenaRatingManager {
    constructor(dbName = "MatchesDB", storeName = "matches", ratingsCacheKey = "elo_ratings") {
        this.dbName = dbName;
        this.storeName = storeName;
        this.ratingsCacheKey = ratingsCacheKey;
        this.db = null;
        this.cachedRatings = {};
    }

    initDB() {
        // have to do this manually every time (once per arenamanager) so you can actually chain onto it
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, 1);

            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                if (!db.objectStoreNames.contains(this.storeName)) {
                    db.createObjectStore(this.storeName, { keyPath: "id", autoIncrement: true });
                }
            };

            request.onsuccess = (event) => {
                this.db = event.target.result;
                this.loadLatestRatings(); // Load cached ratings after DB initialization
                resolve(this.db);
            };

            request.onerror = (event) => {
                reject(event.target.errorCode);
            };
        });
    }

    saveMatch(modelA, modelB, result) {
        const validResults = ["model_a", "model_b", "draw", "draw(bothbad)"];
        if (!validResults.includes(result)) {
            throw new Error(`Attempted to save invalid result to DB: ${result}`);
        }
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeName], "readwrite");
            const store = transaction.objectStore(this.storeName);

            const match = { model_a: modelA, model_b: modelB, result: result };
            const request = store.add(match);

            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }

    getMatchHistory() {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeName], "readonly");
            const store = transaction.objectStore(this.storeName);

            const request = store.getAll();
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    expectedScore(ratingA, ratingB, BASE, SCALE) {
        return 1 / (1 + Math.pow(BASE, (ratingB - ratingA) / SCALE));
    }

    calculateElo(matches, K = 40, SCALE = 400, BASE = 10, INIT_RATING = 1000) {
        /* We'll use the chess default of K = 40, and because this is a local arena and our sample size will be low.
        Chatbot arena uses K = 4 because of high sample size. We'll also reduce K to 20 when a model passes 30 matches.*/
        let ratings = this.cachedRatings || {};

        // Initialize ratings for any new models
        matches.forEach(match => {
            const modelA = match.model_a;
            const modelB = match.model_b;

            if (!ratings[modelA]) ratings[modelA] = { rating: INIT_RATING, matches_count: 0 };
            if (!ratings[modelB]) ratings[modelB] = { rating: INIT_RATING, matches_count: 0 };
        });

        // Calculate Elo ratings
        matches.forEach(match => {
            const modelA = match.model_a;
            const modelB = match.model_b;
            const winner = match.result;

            let scoreA;
            switch (winner) {
                case "model_a":
                    scoreA = 1;
                    break;
                case "model_b":
                    scoreA = 0;
                    break;
                case "draw":
                    scoreA = 0.5;
                    break;
                case "draw(bothbad)":
                case "ignored":
                case "reveal":
                    // only want to save these just in case, but not use them for the ratings, bothbad is more supposed to be a "cancel/this sucks" than a draw
                    return;
                default:
                    throw new Error(`Unexpected result: ${winner}`);
            }

            const ratingA = ratings[modelA].rating;
            const ratingB = ratings[modelB].rating;

            const expectedA = this.expectedScore(ratingA, ratingB, BASE, SCALE);
            const expectedB = 1.0 - expectedA;

            const kMatchesThreshold = 30;
            const kFactorA = ratings[modelA].matches_count >= kMatchesThreshold ? 20 : K;
            const kFactorB = ratings[modelB].matches_count >= kMatchesThreshold ? 20 : K;

            ratings[modelA].rating += kFactorA * (scoreA - expectedA);
            ratings[modelB].rating += kFactorB * ((1 - scoreA) - expectedB);

            ratings[modelA].matches_count++;
            ratings[modelB].matches_count++;
        });
        // chatbot arena also anchors the rating 800 to llama13b.
        this.cachedRatings = ratings;
        this.saveLatestRatings(ratings);

        return ratings;
    }

    saveLatestRatings() {
        return new Promise((resolve) => {
            chrome.storage.local.set({ [this.ratingsCacheKey]: this.cachedRatings }, resolve);
        });
    }

    loadLatestRatings() {
        return new Promise((resolve) => {
            chrome.storage.local.get([this.ratingsCacheKey], (result) => {
                this.cachedRatings = result[this.ratingsCacheKey] || {};
                resolve(this.cachedRatings);
            });
        });
    }

    addMatchAndUpdate(modelA, modelB, result) {
        this.saveMatch(modelA, modelB, result);
        const updatedRatings = this.calculateElo([{ model_a: modelA, model_b: modelB, result: result }]);
        return updatedRatings;
    }

    getModelRating(model) {
        return this.cachedRatings[model]?.rating || 1000;
    }

    async recalculateRatingsFromHistory() {
        const matches = await this.getMatchHistory();
        this.cachedRatings = {};
        return this.calculateElo(matches);
    }

    wipeStoredCacheAndDB() {
        this.cachedRatings = {};
        chrome.storage.local.remove(this.ratingsCacheKey);

        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeName], 'readwrite');
            const objectStore = transaction.objectStore(this.storeName);
            const request = objectStore.clear();

            request.onerror = (event) => reject(`Error clearing IndexedDB: ${event.target.error}`);
            request.onsuccess = () => {
                console.log("Match history successfully deleted and rating has been reset.");
                resolve();
            };
        });
    }

    async printMatchHistory() {
        try {
            const matchHistory = await this.getMatchHistory();
            console.log('Match History:');
            matchHistory.forEach((match) => {
                console.log(`Match id:${match.id}:`);
                console.log(`  Model A: ${match.model_a}`);
                console.log(`  Model B: ${match.model_b}`);
                console.log(`  Result: ${match.result}`);
                console.log('---');
            });
            console.log(`Total matches: ${matchHistory.length}`);

            // Also print current ratings
            console.log('Current Ratings:');
            Object.entries(this.cachedRatings).forEach(([model, data]) => {
                console.log(`  ${model}: Rating ${data.rating}, Matches ${data.matches_count}`);
            });
        } catch (error) {
            console.error('Error retrieving match history:', error);
        }
    }
}


export const ModeEnum = { "InstantPromptMode": 0, "PromptMode": 1, "Off": 2 };