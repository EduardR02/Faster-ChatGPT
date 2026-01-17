import { SettingsStateManager } from './state_manager.js';
import { createElementWithClass, autoResizeTextfieldListener, updateTextfieldHeight } from "./ui_utils.js";
import { ArenaRatingManager } from "./ArenaRatingManager.js";

const apiDisplayNames = {
    anthropic: 'Anthropic',
    openai: 'OpenAI',
    gemini: 'Gemini',
    deepseek: 'DeepSeek',
    grok: 'Grok',
    kimi: 'Kimi',
    mistral: 'Mistral',
    llamacpp: 'Llamacpp'
};

class SettingsUI {
    constructor() {
        this.stateManager = new SettingsStateManager();
        this.currentApiIndex = 0;
        this.apiProviders = Object.keys(apiDisplayNames);
        this.currentAPIProvider = this.apiProviders[0];
        this.dummyRowsOnInit = 0;
        this.selectModes = ['arena', 'council', 'collector', 'rename', 'transcription'];

        this.config = {
            inputs: { 
                max_tokens: parseInt, 
                temperature: parseFloat, 
                loop_threshold: parseInt 
            },
            checkboxes: [
                'show_model_name', 
                'close_on_deselect', 
                'stream_response', 
                'arena_mode', 
                'auto_rename', 
                'web_search', 
                'persist_tabs',
                'council_mode'
            ]
        };

        this.stateManager.runOnReady(() => {
            const dummyElements = document.getElementsByClassName('models-dummy');
            this.dummyRowsOnInit = dummyElements.length;
            
            this.setupListeners();
            this.initialize();
        });
    }

    setupListeners() {
        const getElement = (id) => document.getElementById(id);
        const addListener = (id, event, callback) => {
            getElement(id)?.addEventListener(event, callback);
        };

        addListener('buttonSave', 'click', () => this.save());
        addListener('button-api-cycle', 'click', () => this.cycleApi());
        
        addListener('button-model-provider-select', 'click', (event) => {
            this.cycleProvider(event.target);
        });
        
        addListener('button-add-model', 'click', () => this.addModel());
        addListener('button-remove-models', 'click', () => this.removeModel());
        
        addListener('arena_mode', 'change', () => this.handleMode('arena'));
        addListener('council_mode', 'change', () => this.handleMode('council'));
        addListener('auto_rename', 'change', () => this.handleMode('rename'));
        
        addListener('arena_select', 'change', () => this.handleSelect('arena'));
        addListener('council_select', 'change', () => this.handleSelect('council'));
        addListener('collector_select', 'change', () => this.handleSelect('collector'));
        addListener('rename_select', 'change', () => this.handleSelect('rename'));
        addListener('transcription_select', 'change', () => this.handleSelect('transcription'));
        
        addListener('api_key_input', 'input', (event) => this.handleApiKey(event));
        
        addListener('button-delete-arena', 'click', (event) => {
            this.handleArenaReset(event.target);
        });
        
        addListener('button-reindex', 'click', (event) => {
            this.handleRequest(event.target, 'history_reindex', 'Reindexed');
        });
        
        addListener('button-repair-images', 'click', (event) => {
            this.handleRequest(event.target, 'history_repair_images', 'Repaired');
        });

        // Prompt selection and Reasoning effort radios
        ['prompt_select', 'reasoning_effort'].forEach(name => {
            document.querySelectorAll(`input[name="${name}"]`).forEach(radio => {
                radio.onchange = (e) => {
                    const value = e.target.value;
                    if (name === 'prompt_select') this.handlePrompt(value);
                    else this.stateManager.queueSettingChange(name, value);
                };
            });
        });

        // Global delegate for model selection
        document.addEventListener('change', (event) => {
            if (event.target.name === 'model_select') {
                this.handleModel(event.target);
            }
        });
        
        this.initMicrophone();
    }

    async initialize() {
        // Initialize numeric inputs
        Object.entries(this.config.inputs).forEach(([id, parser]) => {
            const input = document.getElementById(id);
            const value = this.stateManager.getSetting(id);
            
            if (value !== undefined) {
                input.value = value;
            } else if (id === 'loop_threshold') {
                input.value = 1;
            } else {
                input.value = '';
            }
        });

        // Initialize checkboxes
        this.config.checkboxes.forEach(id => {
            const checkbox = document.getElementById(id);
            if (!checkbox) return;
            const value = this.stateManager.getSetting(id);
            
            if (id === 'persist_tabs') {
                checkbox.checked = (value !== false);
            } else {
                checkbox.checked = !!value;
            }
        });

        // Reset sub-selects
        this.selectModes.forEach(mode => {
            const el = document.getElementById(`${mode}_select`);
            if (el) el.checked = false;
        });

        if (this.stateManager.getSetting('council_mode')) {
            const councilToggle = document.getElementById('council_mode');
            if (councilToggle) councilToggle.checked = true;
        }

        // Initialize models from state
        const storedModels = this.stateManager.state.settings.models || {};
        Object.values(storedModels).forEach(providerMap => {
            Object.entries(providerMap).forEach(([apiName, displayName]) => {
                this.addModelUI(apiName, displayName);
            });
        });
        
        this.setApiLabel();
        this.initPromptUI();
        this.initReasoning();
        this.updateCheckboxes();
    }

    initMicrophone() {
        const button = document.getElementById('enable-microphone');
        const statusSpan = button?.querySelector('span');
        if (!button || !statusSpan) return;

        const updateStatus = async () => {
            const permission = await navigator.permissions.query({ name: 'microphone' }).catch(() => null);
            
            if (permission?.state === 'granted') {
                statusSpan.textContent = 'Microphone \u2713 ';
            } else if (permission?.state === 'denied') {
                statusSpan.textContent = 'Microphone Blocked ';
            } else {
                statusSpan.textContent = 'Allow Microphone ';
            }
        };

        updateStatus();

        button.onclick = async () => {
            button.disabled = true;
            statusSpan.textContent = '\u2026';
            
            try {
                const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
                stream.getTracks().forEach(track => track.stop());
                statusSpan.textContent = 'Microphone \u2713 ';
            } catch (error) {
                if (error.name === 'NotAllowedError') {
                    statusSpan.textContent = 'Microphone Blocked ';
                } else {
                    statusSpan.textContent = 'Microphone Error ';
                }
            } finally {
                button.disabled = false;
            }
        };
    }

    handleModel(input) {
        const currentMode = this.getCurrentMode();
        
        if (currentMode === 'arena' || currentMode === 'council') {
            const checkedModels = document.querySelectorAll('input[name="model_select"]:checked');
            const modelsLabel = document.getElementById('models-label');
            
            const hasEnoughModels = checkedModels.length >= 2;
            modelsLabel.classList.toggle('settings-error', !hasEnoughModels);
            
            if (hasEnoughModels) {
                const modelIds = Array.from(checkedModels).map(el => el.id);
                const targetKey = currentMode === 'arena' ? 'arena_models' : 'council_models';
                this.stateManager.queueSettingChange(targetKey, modelIds);
            }
        } else {
            const settingKeys = { 
                rename: 'auto_rename_model',
                transcription: 'transcription_model',
                collector: 'council_collector_model',
                normal: 'current_model' 
            };
            
            const targetKey = settingKeys[currentMode];
            this.stateManager.queueSettingChange(targetKey, input.id);
        }
    }

    handleMode(mode) {
        const checkboxMap = {
            arena: 'arena_mode',
            council: 'council_mode',
            rename: 'auto_rename'
        };
        const checkboxId = checkboxMap[mode];
        const isEnabled = document.getElementById(checkboxId).checked;
        
        if (isEnabled) this.setSelectMode(mode);
        else this.setSelectMode(null); // Clear sub-selects
        
        this.stateManager.queueSettingChange(checkboxId, isEnabled);
        this.updateCheckboxes();
    }

    setSelectMode(mode) {
        this.selectModes.forEach(m => {
            const el = document.getElementById(`${m}_select`);
            if (el) el.checked = (m === mode);
        });
    }

    handleSelect(mode) {
        const toggle = document.getElementById(`${mode}_select`);
        if (toggle?.checked) {
            // Uncheck other selection toggles
            this.selectModes
                .filter(m => m !== mode)
                .forEach(m => {
                    const other = document.getElementById(`${m}_select`);
                    if (other) other.checked = false;
                });
        }
        this.updateCheckboxes();
    }

    handleApiKey(event) {
        const value = event.target.value.trim();
        if (value) {
            const provider = this.apiProviders[this.currentApiIndex];
            this.stateManager.setApiKey(provider, value);
        }
    }

    async handleRequest(button, messageType, successLabel) {
        if (button.disabled) return;
        
        const originalLabel = button.querySelector('span')?.textContent || button.textContent;
        button.disabled = true;
        
        const setLabel = (text) => {
            const span = button.querySelector('span');
            if (span) {
                span.textContent = `${text} `;
            } else {
                button.textContent = text;
            }
        };

        setLabel('Processing...');
        
        try {
            const response = await chrome.runtime.sendMessage({ type: messageType });
            if (response?.ok) {
                if (response.repaired !== undefined) {
                    setLabel(`Repaired ${response.repaired}`);
                } else {
                    setLabel(successLabel);
                }
            } else {
                setLabel('Open history first');
            }
        } catch (error) {
            setLabel('Failed');
        }

        setTimeout(() => {
            setLabel(originalLabel);
            button.disabled = false;
        }, 2500);
    }

    updateCheckboxes() {
        const currentMode = this.getCurrentMode();
        document.body?.classList.toggle('alt-model-select', currentMode !== 'normal');
        
        const modelInputs = document.getElementsByName('model_select');
        modelInputs.forEach(input => {
            input.type = (currentMode === 'arena' || currentMode === 'council') ? 'checkbox' : 'radio';
            
            if (currentMode === 'arena') {
                const arenaModels = this.stateManager.getSetting('arena_models') || [];
                input.checked = arenaModels.includes(input.id);
            } else if (currentMode === 'council') {
                const councilModels = this.stateManager.getSetting('council_models') || [];
                input.checked = councilModels.includes(input.id);
            } else {
                input.checked = false;
            }
        });

        if (currentMode !== 'arena' && currentMode !== 'council') {
            let selectedId = null;
            if (currentMode === 'rename') {
                selectedId = this.stateManager.getSetting('auto_rename_model') || 
                             this.stateManager.getSetting('current_model');
            } else if (currentMode === 'transcription') {
                selectedId = this.stateManager.getSetting('transcription_model');
            } else if (currentMode === 'collector') {
                selectedId = this.stateManager.getSetting('council_collector_model') ||
                             this.stateManager.getSetting('current_model');
            } else {
                selectedId = this.stateManager.getSetting('current_model');
            }
            
            if (selectedId) {
                const element = document.getElementById(selectedId);
                if (element) {
                    element.checked = true;
                }
            }
        }
    }

    getCurrentMode() {
        if (document.getElementById('arena_select').checked) return 'arena';
        if (document.getElementById('council_select').checked) return 'council';
        if (document.getElementById('collector_select').checked) return 'collector';
        if (document.getElementById('rename_select').checked) return 'rename';
        if (document.getElementById('transcription_select').checked) return 'transcription';
        return 'normal';
    }

    addModel() {
        const apiNameInput = document.getElementById('model-api-name-input');
        const displayNameInput = document.getElementById('model-display-name-input');
        
        const apiName = apiNameInput.value.trim();
        const displayName = displayNameInput.value.trim();
        
        if (!apiName || !displayName) {
            return;
        }

        const apiExists = document.getElementById(apiName) !== null;
        const labels = document.getElementsByClassName('model-label');
        const displayNameExists = Array.from(labels).some(label => {
            return label.textContent.trim() === displayName;
        });

        if (!apiExists && !displayNameExists) {
            this.addModelUI(apiName, displayName);
            this.stateManager.addModel(this.currentAPIProvider, apiName, displayName);
            
            // Clear inputs
            apiNameInput.value = '';
            displayNameInput.value = '';
        }
    }

    addModelUI(apiName, displayName) {
        const input = document.createElement('input');
        input.className = 'checkbox';
        input.type = 'radio';
        input.id = apiName;
        input.name = 'model_select';
        input.value = apiName;
        
        const label = createElementWithClass('label', 'model-label', displayName);
        label.setAttribute('for', apiName);

        const rows = document.getElementsByClassName('models-dummy');
        let targetRow = rows[rows.length - 1];

        // Try to fit in previous rows if we've added new ones
        if (rows.length > this.dummyRowsOnInit) {
            const previousRow = rows[rows.length - 2];
            const container = document.querySelector('.add-model-row-align');
            const maxWidth = container.offsetWidth;
            const originalHeight = previousRow.offsetHeight;

            previousRow.append(input, label);
            
            // Check for overflow
            const isOverflowing = previousRow.scrollWidth > maxWidth || 
                                 previousRow.offsetHeight > originalHeight;

            if (isOverflowing) {
                previousRow.removeChild(input);
                previousRow.removeChild(label);
            } else {
                targetRow = previousRow;
            }
        }

        // Create new row if needed
        if (targetRow === rows[rows.length - 1]) {
            const settingDiv = createElementWithClass('div', 'setting');
            const dummyDiv = createElementWithClass('div', 'models-dummy');
            const placeholderLabel = createElementWithClass('label', 'setting-label');
            
            settingDiv.append(placeholderLabel, dummyDiv);
            
            const parent = targetRow.parentElement.parentElement;
            parent.insertBefore(settingDiv, targetRow.parentElement);
            targetRow = dummyDiv;
        }

        targetRow.append(input, label);
    }

    async removeModel() {
        const nameInput = document.getElementById('model-display-name-input');
        const nameToRemove = nameInput.value.trim();
        
        const labels = document.getElementsByClassName('model-label');
        const targetLabel = Array.from(labels).find(label => {
            return label.textContent.trim() === nameToRemove;
        });
        
        if (targetLabel) {
            const input = targetLabel.previousElementSibling;
            const apiName = input.id;
            const row = targetLabel.parentElement;
            
            this.stateManager.removeModel(apiName);
            
            row.removeChild(input);
            row.removeChild(targetLabel);
            
            // Cleanup empty rows
            if (row.children.length === 0) {
                row.parentElement.remove();
            }
            
            this.updateCheckboxes();
            nameInput.value = '';
        }
    }

    save() {
        const currentMode = this.getCurrentMode();
        if (currentMode === 'arena' || currentMode === 'council') {
            const checkedCount = document.querySelectorAll('input[name="model_select"]:checked').length;
            if (checkedCount < 2) {
                document.getElementById('models-label').classList.add('settings-error');
                return;
            }
        }
        
        const updates = {};

        // Parse and collect input values (skip empty/invalid to preserve existing)
        Object.entries(this.config.inputs).forEach(([id, parser]) => {
            const element = document.getElementById(id);
            const value = element.value.trim();
            if (value === '') return; // Keep existing value if cleared
            const parsed = parser(value);
            if (!Number.isNaN(parsed)) {
                updates[id] = parsed;
            }
        });
        
        // Collect checkbox states
        this.config.checkboxes.forEach(id => {
            const element = document.getElementById(id);
            updates[id] = element.checked;
        });
        
        this.stateManager.queueSettingChange(updates);
        this.stateManager.commitChanges();
    }

    cycleApi() { 
        this.currentApiIndex = (this.currentApiIndex + 1) % this.apiProviders.length; 
        this.setApiLabel(); 
    }
    
    setApiLabel() {
        const input = document.getElementById('api_key_input');
        const provider = this.apiProviders[this.currentApiIndex];
        const displayName = apiDisplayNames[provider];
        
        const label = input.labels[0];
        if (label) {
            label.textContent = `Your ${displayName} API Key:`;
        }
        
        const existingKey = this.stateManager.getSetting('api_keys')?.[provider];
        input.placeholder = existingKey ? "Existing key (hidden)" : "Enter your API key here";
        input.value = "";
    }

    cycleProvider(button) { 
        const currentIndex = this.apiProviders.indexOf(this.currentAPIProvider);
        const nextIndex = (currentIndex + 1) % this.apiProviders.length;
        this.currentAPIProvider = this.apiProviders[nextIndex];
        
        const displayName = apiDisplayNames[this.currentAPIProvider];
        button.textContent = `${displayName} \u21B3`; 
    }

    async handlePrompt(type) {
        const area = document.getElementById('customize_prompt');
        const basePlaceholder = "Type your prompt here...";
        
        const extraInfo = {
            thinking_prompt: " (This prompt will be appended to the system prompt)",
            solver_prompt: " (You should make it clear that the model should use the previously generated thinking to now solve the problem. This prompt will be appended to the system prompt)",
            council_collector_prompt: " (Appended to system prompt for council synthesis)"
        };
        
        area.placeholder = basePlaceholder + (extraInfo[type] || '');
        
        const promptValue = await this.stateManager.getPrompt(type);
        area.value = promptValue || '';
        
        updateTextfieldHeight(area);
        
        area.onchange = (event) => {
            this.stateManager.setPrompt(type, event.target.value);
        };
    }

    handleArenaReset(button) {
        if (!button.classList.contains('confirm')) { 
            button.classList.add('confirm'); 
            button.textContent = 'Are you sure? '; 
            return; 
        }
        
        const ratingManager = new ArenaRatingManager();
        ratingManager.initDB().then(() => ratingManager.wipe());
        
        button.classList.remove('confirm'); 
        button.textContent = 'Reset Arena Matches ';
    }

    initPromptUI() { 
        autoResizeTextfieldListener('customize_prompt'); 
        document.getElementById('chat-prompt').checked = true; 
        this.handlePrompt('chat_prompt'); 
    }
    
    initReasoning() { 
        const effort = this.stateManager.getSetting('reasoning_effort') || 'medium'; 
        const radio = document.getElementById('reasoning_' + effort);
        if (radio) {
            radio.checked = true; 
        }
    }
}


function init() {
    new SettingsUI();
}


document.addEventListener('DOMContentLoaded', init);
