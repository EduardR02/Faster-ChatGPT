import {ArenaRatingManager, auto_resize_textfield_listener, update_textfield_height, remove_model_from_storage, add_model_to_storage} from "./utils.js";


let existing_settings = {};
const apiDisplayNames = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  gemini: 'Gemini',
  deepseek: 'DeepSeek'
};
const apiProviders = Object.keys(apiDisplayNames);

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
    let modelProviderButton = document.getElementById('button-model-provider-select');
    modelProviderButton.addEventListener('click', function() {
        set_model_provider_button(modelProviderButton);
    });
    let addModelButton = document.getElementById('button-add-model');
    addModelButton.addEventListener('click', function() {
        add_model();
    });
    let removeModelButton = document.getElementById('button-remove-models');
    removeModelButton.addEventListener('click', function() {
        remove_model();
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


function add_model() {
    const model_api_name = document.getElementById('model-api-name-input').value.trim();
    const model_display_name = document.getElementById('model-display-name-input').value.trim();
    const model_provider = document.getElementById('button-model-provider-select').textContent.split(' ')[0].toLowerCase();
    if (model_api_name === "" || model_display_name === "") 
        return;
    const already_exists = document.getElementById(model_api_name) !== null || Array.from(document.getElementsByClassName('model-label')).find(label => label.textContent.trim() === model_display_name) !== undefined;
    if (!already_exists) {
        add_model_to_html(model_api_name, model_display_name);
    }
    add_model_to_storage(model_provider, model_api_name, model_display_name);
}


function add_model_to_html(model_api_name, model_display_name) {
    // Create new model elements
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.id = model_api_name;
    radio.name = 'model-select';
    radio.value = model_api_name;
    radio.className = 'checkbox';
    
    const label = document.createElement('label');
    label.className = 'model-label';
    label.textContent = model_display_name;

    // Get all dummy divs (rows)
    const dummyDivs = document.getElementsByClassName('models-dummy');
    let lastRow = dummyDivs[dummyDivs.length - 1];
    const insertBefore = lastRow.parentElement;
    let needsNewRow = true;
    if (dummyDivs.length > 1) {
        lastRow = dummyDivs[dummyDivs.length - 2];
        needsNewRow = shouldCreateNewRow(lastRow, radio, label);
    }

    if (needsNewRow) {
        // Create new row
        const newSetting = document.createElement('div');
        newSetting.className = 'setting';
        
        const dummyLabel = document.createElement('label');
        dummyLabel.className = 'setting-label';
        
        const newDummy = document.createElement('div');
        newDummy.className = 'models-dummy';
        
        newSetting.appendChild(dummyLabel);
        newSetting.appendChild(newDummy);
        lastRow.parentElement.parentElement.insertBefore(newSetting, insertBefore);
        
        // Add new model to new row
        newDummy.appendChild(radio);
        newDummy.appendChild(label);
    } else {
        // Add to existing row
        lastRow.appendChild(radio);
        lastRow.appendChild(label);
    }
}

function shouldCreateNewRow(row, radio, label) {
    const originalRowHeight = row.offsetHeight;
    // Add temporarily to measure
    row.appendChild(radio);
    row.appendChild(label);
    
    const newRowWidth = row.scrollWidth;  // Use scrollWidth to get full content width
    const newRowHeight = row.offsetHeight;
    
    row.removeChild(radio);
    row.removeChild(label);
    // get width of arena mode row which is "max width" for the current window size because of its css
    const maxWidthElement = document.getElementsByClassName('add-model-row-align');
    const maxWidth = maxWidthElement[maxWidthElement.length - 1].offsetWidth;
    // 2. If height increased (means wrapping occurred)
    return (
        newRowWidth > maxWidth ||
        newRowHeight > originalRowHeight
    );
}

function remove_model() {
    // Get both the api_name and display_name
    const display_name_input = document.getElementById('model-display-name-input').value.trim();
    if (display_name_input === "") return;
    // Get all labels with class 'setting-label'
    const labels = document.getElementsByClassName('model-label');
    
    // Convert to array and find the label with matching text
    const labelArray = Array.from(labels);
    const targetLabel = labelArray.find(label => label.textContent.trim() === display_name_input);
    
    if (!targetLabel) return;
    
    // Get the associated radio button (previous sibling)
    const radio = targetLabel.previousElementSibling;
    const api_name = radio.id;
    const row = targetLabel.parentElement; // the dummy div
    
    // Remove both the radio and label
    row.removeChild(radio);
    row.removeChild(targetLabel);
    
    if (row.children.length === 0) {
        row.parentElement.remove();
    }
    remove_model_from_storage(api_name);
    if (existing_settings.current_model === api_name) {
        let new_model = document.getElementsByName('model-select')[0];
        existing_settings.current_model = new_model.value;
        new_model.checked = true;
        chrome.storage.local.set({current_model: existing_settings.current_model});
    }
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

function set_model_provider_button(provider_button) {
    let text = provider_button.textContent.split(' ');
    let provider_list = Object.values(apiDisplayNames);
    let index = provider_list.indexOf(text[0]);
    provider_button.textContent = provider_list[(index + 1) % provider_list.length] + " " + text[1];
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
        settings.current_model = arena_models[0].value;
        models_label.classList.remove('settings-error');
    }
}


function init_values() {
    chrome.storage.local.get(['api_keys', 'max_tokens', 'temperature', 'loop_threshold', 'current_model', 'close_on_deselect', 'stream_response', 'arena_mode', 'arena_models', 'models'], function(res) {
        document.getElementById('max-tokens').value = res.max_tokens;
        document.getElementById('temperature').value = res.temperature;
        document.getElementById('loop-threshold').value = res.loop_threshold || 1;
        document.getElementById('close-on-deselect').checked = res.close_on_deselect;
        document.getElementById('stream-response').checked = res.stream_response;
        document.getElementById('arena-mode').checked = res.arena_mode || false;
        res.arena_models = res.arena_models || [];
        res.api_keys = res.api_keys || {};
        init_models(res.models || {});
        delete res.models;
        existing_settings = res;
        set_api_label();
        toggle_model_checkboxes();
    });
    textarea_setup();
}


function init_models(model_dict) {
    Object.entries(model_dict).forEach(([provider, models]) => {
        Object.entries(models).forEach(([apiString, displayName]) => {
            add_model_to_html(apiString, displayName);
        });
    });
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
        document.getElementById(existing_settings.current_model || model_checkboxes[0].value).checked = true;
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

