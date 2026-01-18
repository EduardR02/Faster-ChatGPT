import { DEFAULT_MODELS } from './LLMProviders.js';

export const ModeEnum = { InstantPromptMode: 0, PromptMode: 1, Off: 2 };

/**
 * Gets the current mode from local storage.
 */
export const getMode = (callback) => {
    chrome.storage.local.get('mode', result => callback(result.mode));
};

/**
 * Sets the current mode in local storage.
 */
export const setMode = (mode) => {
    chrome.storage.local.set({ mode });
};

/**
 * Checks if the mode is not 'Off'.
 */
export const isOn = (mode) => mode !== ModeEnum.Off;

/**
 * Retrieves lifetime token usage statistics.
 */
export const getLifetimeTokens = (callback) => {
    chrome.storage.local.get(['lifetime_input_tokens', 'lifetime_output_tokens'], result => {
        callback({
            input: result.lifetime_input_tokens || 0, 
            output: result.lifetime_output_tokens || 0 
        });
    });
};

let lifetimeTokensUpdate = Promise.resolve();

const applyLifetimeTokensDelta = (inputDelta, outputDelta) => {
    lifetimeTokensUpdate = lifetimeTokensUpdate
        .then(() => new Promise(resolve => {
            getLifetimeTokens(current => {
                chrome.storage.local.set({
                    lifetime_input_tokens: current.input + inputDelta, 
                    lifetime_output_tokens: current.output + outputDelta 
                }, resolve);
            });
        }))
        .catch(() => {});
};

const LIFETIME_TOKEN_RETRY_DELAYS_MS = [100, 250];
const sendLifetimeTokensDelta = (inputDelta, outputDelta, attempt = 0) => {
    chrome.runtime.sendMessage({
        type: 'increment_lifetime_tokens',
        inputDelta,
        outputDelta
    }).catch(() => {
        const delay = LIFETIME_TOKEN_RETRY_DELAYS_MS[attempt];
        if (delay == null) {
            applyLifetimeTokensDelta(inputDelta, outputDelta);
            return;
        }
        setTimeout(() => sendLifetimeTokensDelta(inputDelta, outputDelta, attempt + 1), delay);
    });
};

/**
 * Increments lifetime token usage statistics.
 */
export const setLifetimeTokens = (inputDelta, outputDelta) => {
    if (chrome?.runtime?.sendMessage) {
        sendLifetimeTokensDelta(inputDelta, outputDelta);
    } else {
        applyLifetimeTokensDelta(inputDelta, outputDelta);
    }
};

/**
 * Retrieves the map of stored model IDs to display names.
 */
export const getStoredModels = () => {
    return new Promise(resolve => {
        chrome.storage.local.get(['models'], result => {
            resolve(result.models || {});
        });
    });
};

/**
 * Adds a custom model to storage.
 */
export const addModelToStorage = async (provider, apiName, displayName) => {
    const models = await getStoredModels();
    
    if (!models[provider]) models[provider] = {};
    models[provider][apiName] = displayName;
    
    await chrome.storage.local.set({ models });
    return models;
};

/**
 * Removes a model from storage and cleans up the provider if empty.
 */
export const removeModelFromStorage = async (apiName) => {
    const models = await getStoredModels();
    let removed = false;
    
    for (const provider in models) {
        if (models[provider][apiName]) {
            delete models[provider][apiName];
            if (Object.keys(models[provider]).length === 0) {
                delete models[provider];
            }
            removed = true;
            break;
        }
    }
    
    if (removed) {
        await chrome.storage.local.set({ models });
    }
    return models;
};

/**
 * Utility to load text content from an extension file.
 */
export const loadTextFromFile = (filePath) => {
    const url = chrome.runtime.getURL(filePath);
    return fetch(url).then(response => {
        if (!response.ok) throw new Error(`Failed to load ${filePath}: ${response.statusText}`);
        return response.text();
    });
};

/**
 * Initializes the extension with default settings and prompts.
 */
export const setDefaults = async () => {
    const models = DEFAULT_MODELS;
    const defaultModel = Object.keys(models.anthropic).at(-1);
    const settings = {
        mode: ModeEnum.PromptMode,
        lifetime_input_tokens: 0,
        lifetime_output_tokens: 0,
        max_tokens: 16000,
        temperature: 1.0,
        loop_threshold: 2,
        reasoning_effort: 'medium',
        show_model_name: true,
        current_model: defaultModel,
        transcription_model: null,
        models,
        api_keys: {},
        close_on_deselect: false,
        stream_response: true,
        arena_mode: false,
        council_mode: false,
        council_models: [],
        council_collector_model: defaultModel
    };

    const loadPrompt = async (path, storageKey, fallback = '') => {
        try {
            const text = await loadTextFromFile(path);
            await chrome.storage.local.set({ [storageKey]: text.trim() });
        } catch (_) {
            await chrome.storage.local.set({ [storageKey]: fallback });
        }
    };

    await chrome.storage.local.set(settings);
    
    // Default appended prompts for multi-turn thinking/solving
    const thinkingPrompt = `[APPENDED INSTRUCTION: This modifies response behavior for this turn only, layering on the core system prompt.]\n\nIn this response, skip any direct answer, solution, or conclusion to the user's query. Instead, devote your entire output to building a robust thought process that will enable an optimal, accurate, and comprehensive response in the next turn—whether that's answering, advising, creating, or acting on the user's request.\n\nTo maximize value for the future:\n- Start by rephrasing the query to ensure full grasp, then dissect it into key elements (assumptions, goals, nuances).\n- Freely explore relevant ideas: Draw on knowledge, first principles, potential angles, risks, or alternatives. Think aloud step-by-step, noting connections, gaps, or insights that could shape the final output.\n- Wrap up by highlighting the strongest threads or "building blocks" you've assembled, explicitly linking how they'll power a superior next response.\n\nStay focused, insightful, and unfiltered—aim to arm yourself (and the conversation) with everything needed to nail it later. No finals here; this is all setup.`;
    
    const solverPrompt = `[APPENDED INSTRUCTION: This shifts response mode for this turn only, building directly on the core system prompt and your prior thoughts.]\n\nYou've now received the detailed thought process from the previous turn—use it to its full extent as the foundation for your response. Synthesize those insights, breakdowns, and building blocks to craft a complete, direct, and high-quality reply to the original user query or statement, whatever it may be (question, observation, casual remark, or anything else).\n\nRespond appropriately and engagingly: Draw deeply from the prep to ensure accuracy, depth, creativity, or humor as fits the context. Cover all key angles without deferring or recapping the thoughts themselves—deliver the polished, final output that resolves or advances the conversation.\n\nKeep it natural, insightful, and on-point; this is where it all comes together.`;

    await Promise.all([
        loadPrompt("src/prompts/prompt.txt", "selection_prompt"),
        loadPrompt("src/prompts/chat_prompt.txt", "chat_prompt"),
        loadPrompt("src/prompts/council_collector_prompt.txt", "council_collector_prompt", "You are acting as The Arbiter. Your role is to evaluate and synthesize the provided council responses into a single, definitive, and high-quality final answer."),
        chrome.storage.local.set({
            thinking_prompt: thinkingPrompt.trim(),
            solver_prompt: solverPrompt.trim()
        })
    ]);
};

