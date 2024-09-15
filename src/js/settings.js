import {ArenaRatingManager, auto_resize_textfield_listener, update_textfield_height} from "./utils.js";


let existing_settings = {};
const apiProviders = ['anthropic', 'openai', 'gemini'];
const apiDisplayNames = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  gemini: 'Gemini'
};

let currentApiIndex = 0;

init();


function init() {
    init_values();
    let saveButton = document.getElementById('buttonSave');
    saveButton.addEventListener('click', function() {
        save();
    });
    let apiCycleButton = document.getElementById('button-api-cycle');
    apiCycleButton.addEventListener('click', function() {
        cycle_api_key_input();
    });
    let promptSelectButtons = document.querySelectorAll('input[name="prompt-select"]');
    promptSelectButtons.forEach(radio => {
        radio.addEventListener('change', function() {
            if (this.checked) {
                const prompt_string = this.value;
                textarea_update(prompt_string);
            }
        });
    });

    let arenaModeRadio = document.getElementById('arena-mode');
    arenaModeRadio.addEventListener('change', toggle_model_checkboxes);

    let button = document.querySelector('#button-delete-arena');
    button.addEventListener('click', arenaDeleteConfirm);
}


function arenaDeleteConfirm(event) {
    const button = event.target;
    button.classList.add('confirm');
    button.textContent = 'Are you sure? This is irreversable. ';
    
    button.removeEventListener('click', arenaDeleteConfirm);
    button.addEventListener('click', arenaDeleteHistory);
}


function arenaDeleteHistory(event) {
    const arenaRatingManager = new ArenaRatingManager();
    arenaRatingManager.initDB().then(() => arenaRatingManager.wipeStoredCacheAndDB());
    const button = event.target;
    button.classList.remove('confirm');
    button.textContent = 'Reset Arena Matches ';
    
    button.removeEventListener('click', arenaDeleteHistory);
    button.addEventListener('click', arenaDeleteConfirm);
}


function save() {
    save_settings();
    save_api_key();
    save_prompt();
}


function cycle_api_key_input() {
    currentApiIndex = (currentApiIndex + 1) % apiProviders.length;
    set_api_label();
}


function set_api_label() {
    let input_field = document.getElementById('api-key-input');
    let label = input_field.labels[0];
    label.textContent = `Your ${apiDisplayNames[apiProviders[currentApiIndex]]} API Key:`;
    let placeholder = existing_settings.api_keys[apiProviders[currentApiIndex]] ? "Existing key (hidden)" : "Enter your API key here";
    input_field.placeholder = placeholder;
    input_field.value = "";
}


function save_prompt() {
    let text = document.getElementById('customize-prompt').value.trim();
    let prompt_string = document.querySelector('input[name="prompt-select"]:checked').value;
    if (text !== existing_settings.prompt && text !== "") {
        chrome.storage.local.set({[prompt_string]: text});
    }
}


function save_api_key() {
    let input_field = document.getElementById('api-key-input');
    let key = input_field.value.trim();
    if (key !== "" && key !== existing_settings.api_keys[apiProviders[currentApiIndex]]) {
        let api_keys = existing_settings.api_keys;
        api_keys[apiProviders[currentApiIndex]] = key;
        chrome.storage.local.set({api_keys: api_keys});
    }
}


function save_settings() {
    let settings = {};
    settings.max_tokens = parseInt(document.getElementById('max-tokens').value.trim());
    settings.temperature = parseFloat(document.getElementById('temperature').value.trim());
    settings.loop_threshold = parseInt(document.getElementById('loop-threshold').value.trim());
    settings.close_on_deselect = document.getElementById('close-on-deselect').checked;
    settings.stream_response = document.getElementById('stream-response').checked;
    settings.arena_mode = document.getElementById('arena-mode').checked;
    save_model_or_arena_models(settings, settings.arena_mode);
    for (let key in settings) {
        if (settings[key] === existing_settings[key] || settings[key] === undefined ||
            settings[key] === NaN || settings[key] === "") {
            delete settings[key];
        }
        else {
            existing_settings[key] = settings[key];
        }
    }
    chrome.storage.local.set(settings);
}


function save_model_or_arena_models(settings, arena_mode) {
    const models_label = document.getElementById('models-label');
    const arena_models = document.querySelectorAll('input[name="model-select"]:checked');
    if (arena_mode) {
        if (arena_models.length < 2) {
            models_label.classList.remove('settings-error');
            // sucks but whatever
            setTimeout(() => models_label.classList.add('settings-error'), 10);
        }
        else {
            settings.arena_models = Array.from(arena_models).map(checkbox => checkbox.id);
            models_label.classList.remove('settings-error');
        }
    }
    else {
        settings.model = arena_models[0].value;
        models_label.classList.remove('settings-error');
    }
}


function init_values() {
    chrome.storage.local.get(['api_keys', 'max_tokens', 'temperature', 'loop_threshold', 'model', 'close_on_deselect', 'stream_response', 'arena_mode', 'arena_models'], function(res) {
        document.getElementById('max-tokens').value = res.max_tokens;
        document.getElementById('temperature').value = res.temperature;
        document.getElementById('loop-threshold').value = res.loop_threshold || 1;
        document.getElementById('close-on-deselect').checked = res.close_on_deselect;
        document.getElementById('stream-response').checked = res.stream_response;
        document.getElementById('arena-mode').checked = res.arena_mode || false;
        res.arena_models = res.arena_models || [];
        res.api_keys = res.api_keys || {};
        existing_settings = res;
        set_api_label();
        toggle_model_checkboxes();
    });
    textarea_setup();
}


function toggle_model_checkboxes() {
    const model_checkboxes = document.getElementsByName('model-select');
    const arena_mode_val = document.getElementById('arena-mode').checked;
    const models_label = document.getElementById('models-label');
    const swapToType = arena_mode_val ? 'checkbox' : 'radio';
    models_label.innerText = arena_mode_val ? 'Arena Models:' : 'Model:';
    models_label.classList.remove('settings-error');
    model_checkboxes.forEach(input => {
        input.type = swapToType;
        if (swapToType === 'checkbox') {
            input.classList.add('arena-models');
            input.checked = existing_settings.arena_models.includes(input.id);
        }
        else {
            input.classList.remove('arena-models');
        }
    });
    if (!arena_mode_val) {
        document.getElementById(existing_settings.model).checked = true;
    }
}


function textarea_update(prompt_string) {
    let textarea = document.getElementById('customize-prompt');
    set_text_area_placeholder(textarea, prompt_string);
    chrome.storage.local.get(prompt_string).then((result) => {
        let text = result[prompt_string] || '';
        textarea.value = text;
        update_textfield_height(textarea);
        existing_settings.prompt = text;
    });
}


function set_text_area_placeholder(textarea, prompt_string) {
    textarea.placeholder = "Type your prompt here...";
    if (prompt_string === "thinking_prompt") {
        textarea.placeholder = "Type your prompt here... (You must indicate that if the model wants to continue thinking, it must include *continue* in it's output. This prompt will be appended to the system prompt)";
    }
    else if (prompt_string === "solver_prompt") {
        textarea.placeholder = "Type your prompt here... (You should make it clear that the model should use the previously generated thinking to now solve the problem. This prompt will be appended to the system prompt)";
    }
}


function textarea_setup() {
    let selection_radio = document.getElementById("selection-prompt");
    selection_radio.checked = true;
    
    auto_resize_textfield_listener('customize-prompt');
    textarea_update(selection_radio.value);
}

