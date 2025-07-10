import { SettingsStateManager } from './state_manager.js';
import { ArenaRatingManager, createElementWithClass, auto_resize_textfield_listener, update_textfield_height } from "./utils.js";

const apiDisplayNames = {
    anthropic: 'Anthropic',
    openai: 'OpenAI',
    gemini: 'Gemini',
    deepseek: 'DeepSeek',
    grok: 'Grok'
};

class SettingsUI {
    constructor() {
        this.stateManager = new SettingsStateManager();
        this.currentApiIndex = 0;
        this.apiProviders = Object.keys(apiDisplayNames);
        this.currentAPIProvider = this.apiProviders[0];
        this.dummyRowsOnInit = document.getElementsByClassName('models-dummy').length;

        this.settingsConfig = {
            inputs: {
                max_tokens: { type: 'number', parser: parseInt },
                temperature: { type: 'number', parser: parseFloat },
                loop_threshold: { type: 'number', parser: parseInt, default: 1 }
            },
            checkboxes: [
                'show_model_name', 'close_on_deselect', 'stream_response',
                'arena_mode', 'auto_rename', 'web_search'
            ]
        };

        this.init();
    }

    init() {
        this.stateManager.runOnReady(() => {
            this.setupEventListeners();
            this.initializeUI();
        });
    }

    setupEventListeners() {
        // Basic buttons
        document.getElementById('buttonSave').addEventListener('click', () => this.save());
        document.getElementById('button-api-cycle').addEventListener('click', () => this.cycleApiKeyInput());
        document.getElementById('button-model-provider-select').addEventListener('click', (e) => this.cycleAPIProvider(e.target));
        document.getElementById('button-add-model').addEventListener('click', () => this.addModel());
        document.getElementById('button-remove-models').addEventListener('click', () => this.removeModel());
        
        // Mode toggles
        document.getElementById('arena_mode').addEventListener('change', () => this.handleModeToggle('arena'));
        document.getElementById('auto_rename').addEventListener('change', () => this.handleModeToggle('rename'));
        document.getElementById('arena_select').addEventListener('change', () => this.handleSelectToggle('arena'));
        document.getElementById('rename_select').addEventListener('change', () => this.handleSelectToggle('rename'));

        // Radio groups
        new Map([
            ['prompt_select', (v) => this.handlePromptSelection(v)],
            ['reasoning_effort', (v) => this.stateManager.queueSettingChange('reasoning_effort', v)]
        ]).forEach((handler, name) => {
            document.querySelectorAll(`input[name="${name}"]`).forEach(radio => {
                radio.addEventListener('change', e => handler(e.target.value));
            });
        });

        document.getElementById('api_key_input').addEventListener('input', (e) => this.handleApiKeyInput(e));

        document.addEventListener('change', (e) => {
            if (e.target.name === 'model_select') {
                this.handleModelSelection(e);
            }
        });
        
        // Arena reset
        const resetButton = document.getElementById('button-delete-arena');
        resetButton.addEventListener('click', () => this.handleArenaReset(resetButton));
    }

    async initializeUI() {
        this.initInputValues();
        this.initModels();
        this.setApiLabel();
        this.initTextArea();
        this.initReasoningEffort();
        this.updateModelCheckboxes();
    }

    initInputValues() {
        Object.entries(this.settingsConfig.inputs).forEach(([id, { parser, default: def }]) => {
            document.getElementById(id).value = this.stateManager.getSetting(id) ?? def;
        });

        this.settingsConfig.checkboxes.forEach(id => {
            document.getElementById(id).checked = this.stateManager.getSetting(id) || false;
        });

        ['arena', 'rename'].forEach(mode => document.getElementById(`${mode}_select`).checked = false);
    }

    initModels() {
        const models = this.stateManager.state.settings.models;
        Object.entries(models).forEach(([provider, modelMap]) => {
            Object.entries(modelMap).forEach(([apiString, displayName]) => {
                this.addModelToUI(apiString, displayName);
            });
        });
    }

    handleArenaReset(button) {
        if (!button.classList.contains('confirm')) {
            button.classList.add('confirm');
            button.textContent = 'Are you sure? This is irreversible. ';
            return;
        }
        new ArenaRatingManager().initDB().then(manager => manager.wipeStoredCacheAndDB());
        button.classList.remove('confirm');
        button.textContent = 'Reset Arena Matches ';
    }

    handleModelSelection(event) {
        const input = event.target;
        const currentMode = this.getCurrentMode();
        
        switch (currentMode) {
            case 'arena':
                const selectedModels = document.querySelectorAll('input[name="model_select"]:checked');
                const hasEnoughModels = selectedModels.length >= 2;
                document.getElementById('models-label').classList.toggle('settings-error', !hasEnoughModels);
                if (hasEnoughModels) {
                    this.stateManager.queueSettingChange('arena_models', 
                        Array.from(selectedModels).map(input => input.id)
                    );
                }
                break;
            case 'rename':
                this.stateManager.queueSettingChange('auto_rename_model', input.id);
                break;
            case 'normal':
                this.stateManager.queueSettingChange('current_model', input.id);
                break;
        }
    }

    handleModeToggle(mode) {
        const isEnabled = document.getElementById(`${mode === 'arena' ? 'arena_mode' : 'auto_rename'}`).checked;
        const selectToggle = document.getElementById(`${mode}_select`);
    
        if (isEnabled) {
            selectToggle.checked = true;
            const otherMode = mode === 'arena' ? 'rename' : 'arena';
            document.getElementById(`${otherMode}_select`).checked = false;
        }
    
        this.stateManager.queueSettingChange(
            mode === 'arena' ? 'arena_mode' : 'auto_rename',
            isEnabled
        );
    
        this.updateModelCheckboxes();
    }
    
    handleSelectToggle(mode) {
        const selectToggle = document.getElementById(`${mode}_select`);
        
        // If enabling this select, disable the other one
        if (selectToggle.checked) {
            const otherMode = mode === 'arena' ? 'rename' : 'arena';
            document.getElementById(`${otherMode}_select`).checked = false;
        }
    
        this.updateModelCheckboxes();
    }
    
    handleApiKeyInput(event) {
        const input = event.target;
        const key = input.value.trim();
        if (key) this.stateManager.setApiKey(this.apiProviders[this.currentApiIndex], key);
    }

    updateModelCheckboxes() {
        const modelCheckboxes = document.getElementsByName('model_select');
        const currentMode = this.getCurrentMode();
    
        modelCheckboxes.forEach(input => {
            input.classList.remove('arena-models', 'rename-model');
    
            // Change input type based on mode
            const newType = currentMode === 'arena' ? 'checkbox' : 'radio';
            if (input.type !== newType) input.type = newType;
    
            // Set checked state based on current mode
            switch (currentMode) {
                case 'arena':
                    input.checked = this.stateManager.getSetting('arena_models')?.includes(input.id) || false;
                    input.classList.add('arena-models');
                    break;
                case 'rename':
                    input.classList.add('rename-model');
                    break;
            }
        });
        if (currentMode !== 'arena') {
            const selectedModel = currentMode === 'rename' ? 
                this.stateManager.getSetting('auto_rename_model') :
                this.stateManager.getSetting('current_model');
            const selectedInput = document.getElementById(selectedModel);
            if (selectedInput) selectedInput.checked = true;
        }
    }

    getCurrentMode() {
        if (document.getElementById('arena_select').checked) return 'arena';
        if (document.getElementById('rename_select').checked) return 'rename';
        return 'normal';
    }

    addModel() {
        const apiName = document.getElementById('model-api-name-input').value.trim();
        const displayName = document.getElementById('model-display-name-input').value.trim();
        
        if (!apiName || !displayName) return;
        
        if (!this.checkModelExists(apiName, displayName)) {
            this.addModelToUI(apiName, displayName);
            this.stateManager.addModel(this.currentAPIProvider, apiName, displayName);
        }
    }

    checkModelExists(apiName, displayName) {
        return document.getElementById(apiName) !== null || 
               Array.from(document.getElementsByClassName('model-label'))
                    .some(label => label.textContent.trim() === displayName);
    }

    addModelToUI(apiName, displayName) {
        const [input, label] = this.createModelElements(apiName, displayName);

        // Get all dummy divs (rows)
        const dummyDivs = document.getElementsByClassName('models-dummy');
        let lastRow = dummyDivs[dummyDivs.length - 1];
        const insertBefore = lastRow.parentElement;
        let needsNewRow = true;

        if (dummyDivs.length > this.dummyRowsOnInit) {
            lastRow = dummyDivs[dummyDivs.length - 2];
            needsNewRow = this.shouldCreateNewRow(lastRow, input, label);
        }

        if (needsNewRow) {
            const newRow = this.createNewModelRow(lastRow, insertBefore);
            newRow.appendChild(input);
            newRow.appendChild(label);
        } else {
            lastRow.appendChild(input);
            lastRow.appendChild(label);
        }
    }

    createNewModelRow(lastRow, modelRow) {
        const newSetting = createElementWithClass('div', 'setting');
        const dummyLabel = createElementWithClass('label', 'setting-label');
        const newDummy = createElementWithClass('div', 'models-dummy');
        
        newSetting.appendChild(dummyLabel);
        newSetting.appendChild(newDummy);
        lastRow.parentElement.parentElement.insertBefore(newSetting, modelRow);
        
        return newDummy;
    }

    createModelElements(apiName, displayName) {
        const input = document.createElement('input');
        input.className = 'checkbox';
        input.type = 'radio';
        input.id = apiName;
        input.name = 'model_select';
        input.value = apiName;
        
        const label = createElementWithClass('label', 'model-label', displayName);
        
        return [input, label];
    }

    shouldCreateNewRow(row, input, label) {
        const originalHeight = row.offsetHeight;
        row.appendChild(input);
        row.appendChild(label);
        
        const newWidth = row.scrollWidth;
        const newHeight = row.offsetHeight;
        
        row.removeChild(input);
        row.removeChild(label);
        
        const maxWidth = document.querySelector('.add-model-row-align').offsetWidth;
        return newWidth > maxWidth || newHeight > originalHeight;
    }

    async removeModel() {
        const displayName = document.getElementById('model-display-name-input').value.trim();
        if (!displayName) return;

        const targetLabel = Array.from(document.getElementsByClassName('model-label'))
            .find(label => label.textContent.trim() === displayName);
        
        if (!targetLabel) return;

        const radio = targetLabel.previousElementSibling;
        const apiName = radio.id;
        const row = targetLabel.parentElement;

        this.stateManager.removeModel(apiName);
        
        row.removeChild(radio);
        row.removeChild(targetLabel);

        if (row.children.length === 0) {
            row.parentElement.remove();
        }
    }

    save() {
        if (this.validateSettings()) {
            this.saveSettings();
            this.stateManager.commitChanges();
        }
    }

    validateSettings() {
        const currentMode = this.getCurrentMode();
        if (currentMode === 'arena_mode') {
            const selectedCount = document.querySelectorAll('input[name="model_select"]:checked').length;
            if (selectedCount < 2) {
                document.getElementById('models-label').classList.add('settings-error');
                return false;
            }
        }
        return true;
    }

    saveSettings() {
        const settings = {};

        Object.entries(this.settingsConfig.inputs).forEach(([id, { parser }]) => {
            settings[id] = parser(document.getElementById(id).value);
        });

        this.settingsConfig.checkboxes.forEach(id => {
            settings[id] = document.getElementById(id).checked;
        });

        this.stateManager.queueSettingChange(settings);
    }

    cycleApiKeyInput() {
        this.currentApiIndex = (this.currentApiIndex + 1) % this.apiProviders.length;
        this.setApiLabel();
    }

    setApiLabel() {
        const input = document.getElementById('api_key_input');
        const label = input.labels[0];
        const currentProvider = this.apiProviders[this.currentApiIndex];
        
        label.textContent = `Your ${apiDisplayNames[currentProvider]} API Key:`;
        const hasKey = this.stateManager.getSetting('api_keys')?.[currentProvider];
        input.placeholder = hasKey ? "Existing key (hidden)" : "Enter your API key here";
        input.value = "";
    }

    cycleAPIProvider(button) {
        this.currentAPIProvider = this.apiProviders[(this.apiProviders.indexOf(this.currentAPIProvider) + 1) % this.apiProviders.length];
        button.textContent = `${apiDisplayNames[this.currentAPIProvider]} ⟳`;
    }

    async handlePromptSelection(promptType) {
        const textarea = document.getElementById('customize_prompt');
        this.setTextAreaPlaceholder(textarea, promptType);
        const promptValue = await this.stateManager.getPrompt(promptType);
        textarea.value = promptValue || '';
        update_textfield_height(textarea);

        textarea.onchange = (e) => {
            this.stateManager.setPrompt(promptType, e.target.value);
        };
    }

    setTextAreaPlaceholder(textarea, promptType) {
        let placeholder = "Type your prompt here...";
        if (promptType === "thinking_prompt") {
            placeholder += " (This prompt will be appended to the system prompt)";
        } else if (promptType === "solver_prompt") {
            placeholder += " (You should make it clear that the model should use the previously generated thinking to now solve the problem. This prompt will be appended to the system prompt)";
        }
        textarea.placeholder = placeholder;
    }

    initTextArea() {
        document.getElementById("chat-prompt").checked = true;
        auto_resize_textfield_listener('customize_prompt');
        this.handlePromptSelection('chat_prompt');
    }

    initReasoningEffort() {
        const reasoningEffort = this.stateManager.getSetting('reasoning_effort') || 'medium';
        if (reasoningEffort) {
            document.getElementById('reasoning_' + reasoningEffort).checked = true;
        }
    }
}


function init() {
    new SettingsUI();
}


document.addEventListener('DOMContentLoaded', init);