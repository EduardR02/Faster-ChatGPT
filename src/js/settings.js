import { SettingsStateManager } from './state_manager.js';
import { ArenaRatingManager, createElementWithClass, auto_resize_textfield_listener, update_textfield_height } from "./utils.js";

const apiDisplayNames = {
    anthropic: 'Anthropic',
    openai: 'OpenAI',
    gemini: 'Gemini',
    deepseek: 'DeepSeek'
};

class SettingsUI {
    constructor() {
        this.stateManager = new SettingsStateManager();
        this.currentApiIndex = 0;
        this.apiProviders = Object.keys(apiDisplayNames);
        this.dummyRowsOnInit = document.getElementsByClassName('models-dummy').length;
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
        document.getElementById('button-model-provider-select').addEventListener('click', (e) => this.cycleModelProvider(e.target));
        document.getElementById('button-add-model').addEventListener('click', () => this.addModel());
        document.getElementById('button-remove-models').addEventListener('click', () => this.removeModel());
        
        // Mode toggles
        document.getElementById('arena-mode').addEventListener('change', () => this.handleModeToggle('arena'));
        document.getElementById('auto-rename').addEventListener('change', () => this.handleModeToggle('rename'));
        document.getElementById('arena-select').addEventListener('change', () => this.handleSelectToggle('arena'));
        document.getElementById('rename-select').addEventListener('change', () => this.handleSelectToggle('rename'));

        document.querySelectorAll('input[name="prompt-select"]').forEach(radio => {
            radio.addEventListener('change', (e) => {
                this.handlePromptSelection(e.target.value);
            });
        });

        document.getElementById('api-key-input').addEventListener('input', (e) => this.handleApiKeyInput(e));

        document.addEventListener('change', (e) => {
            if (e.target.name === 'model-select') {
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
        this.updateModelCheckboxes();
    }

    initInputValues() {
        document.getElementById('max-tokens').value = this.stateManager.getSetting('max_tokens');
        document.getElementById('temperature').value = this.stateManager.getSetting('temperature');
        document.getElementById('loop-threshold').value = this.stateManager.getSetting('loop_threshold') || 1;
        document.getElementById('close-on-deselect').checked = this.stateManager.getSetting('close_on_deselect');
        document.getElementById('stream-response').checked = this.stateManager.getSetting('stream_response');
        document.getElementById('arena-mode').checked = this.stateManager.getSetting('arena_mode') || false;
        document.getElementById('auto-rename').checked = this.stateManager.getSetting('auto_rename') || false;
        document.getElementById('rename-select').checked = false;
        document.getElementById('arena-select').checked = false;
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
                const selectedModels = document.querySelectorAll('input[name="model-select"]:checked');
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
        const isEnabled = document.getElementById(`${mode === 'arena' ? 'arena-mode' : 'auto-rename'}`).checked;
        const selectToggle = document.getElementById(`${mode}-select`);
    
        if (isEnabled) {
            selectToggle.checked = true;
            const otherMode = mode === 'arena' ? 'rename' : 'arena';
            document.getElementById(`${otherMode}-select`).checked = false;
        }
    
        this.stateManager.queueSettingChange(
            mode === 'arena' ? 'arena_mode' : 'auto_rename',
            isEnabled
        );
    
        this.updateModelCheckboxes();
    }
    
    handleSelectToggle(mode) {
        const selectToggle = document.getElementById(`${mode}-select`);
        
        // If enabling this select, disable the other one
        if (selectToggle.checked) {
            const otherMode = mode === 'arena' ? 'rename' : 'arena';
            document.getElementById(`${otherMode}-select`).checked = false;
        }
    
        this.updateModelCheckboxes();
    }
    
    handleApiKeyInput(event) {
        const input = event.target;
        const key = input.value.trim();
        if (key) this.stateManager.setApiKey(this.apiProviders[this.currentApiIndex], key);
    }

    updateModelCheckboxes() {
        const modelCheckboxes = document.getElementsByName('model-select');
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
        if (document.getElementById('arena-select').checked) return 'arena';
        if (document.getElementById('rename-select').checked) return 'rename';
        return 'normal';
    }

    addModel() {
        const apiName = document.getElementById('model-api-name-input').value.trim();
        const displayName = document.getElementById('model-display-name-input').value.trim();
        const provider = document.getElementById('button-model-provider-select')
            .textContent.split(' ')[0].toLowerCase();
        
        if (!apiName || !displayName) return;
        
        if (!this.checkModelExists(apiName, displayName)) {
            this.addModelToUI(apiName, displayName);
            this.stateManager.addModel(provider, apiName, displayName);
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
        input.name = 'model-select';
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

        await this.stateManager.removeModel(apiName);
        
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
        if (currentMode === 'arena-mode') {
            const selectedCount = document.querySelectorAll('input[name="model-select"]:checked').length;
            if (selectedCount < 2) {
                document.getElementById('models-label').classList.add('settings-error');
                return false;
            }
        }
        return true;
    }

    saveSettings() {
        this.stateManager.queueSettingChange({
            max_tokens: parseInt(document.getElementById('max-tokens').value),
            temperature: parseFloat(document.getElementById('temperature').value),
            loop_threshold: parseInt(document.getElementById('loop-threshold').value),
            close_on_deselect: document.getElementById('close-on-deselect').checked,
            stream_response: document.getElementById('stream-response').checked,
            arena_mode: document.getElementById('arena-mode').checked,
            auto_rename: document.getElementById('auto-rename').checked
        });
    }

    cycleApiKeyInput() {
        this.currentApiIndex = (this.currentApiIndex + 1) % this.apiProviders.length;
        this.setApiLabel();
    }

    setApiLabel() {
        const input = document.getElementById('api-key-input');
        const label = input.labels[0];
        const currentProvider = this.apiProviders[this.currentApiIndex];
        
        label.textContent = `Your ${apiDisplayNames[currentProvider]} API Key:`;
        const hasKey = this.stateManager.getSetting('api_keys')?.[currentProvider];
        input.placeholder = hasKey ? "Existing key (hidden)" : "Enter your API key here";
        input.value = "";
    }

    cycleModelProvider(button) {
        const [currentProvider] = button.textContent.split(' ');
        const providers = Object.values(apiDisplayNames);
        const nextProvider = providers[(providers.indexOf(currentProvider) + 1) % providers.length];
        button.textContent = `${nextProvider} ⟳`;
    }

    async handlePromptSelection(promptType) {
        const textarea = document.getElementById('customize-prompt');
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
            placeholder += " (You must indicate that if the model wants to continue thinking, it must include *continue* in it's output. This prompt will be appended to the system prompt)";
        } else if (promptType === "solver_prompt") {
            placeholder += " (You should make it clear that the model should use the previously generated thinking to now solve the problem. This prompt will be appended to the system prompt)";
        }
        textarea.placeholder = placeholder;
    }

    initTextArea() {
        document.getElementById("selection-prompt").checked = true;
        auto_resize_textfield_listener('customize-prompt');
        this.handlePromptSelection('selection_prompt');
    }
}


function init() {
    new SettingsUI();
}


document.addEventListener('DOMContentLoaded', init);