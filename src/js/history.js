import { ChatStorage } from './chat_storage.js';
import { HistoryChatUI } from './chat_ui.js';
import { HistoryStateManager } from './state_manager.js';
import { HistoryRenameManager } from './rename_manager.js';
import { ChatCore } from './chat_core.js';
import { createElementWithClass } from './utils.js';


const now = () => (typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now());

const formatDuration = (start, end = now()) => {
    const duration = end - start;
    return duration >= 1000
        ? `${(duration / 1000).toFixed(2)}s`
        : `${duration.toFixed(1)}ms`;
};

const hasWindow = typeof window !== 'undefined';

const runWhenIdle = (callback, timeout = 250) => {
    if (hasWindow && typeof window.requestIdleCallback === 'function') {
        return window.requestIdleCallback(callback, { timeout });
    }
    return setTimeout(() => callback({ didTimeout: true, timeRemaining: () => 0 }), timeout);
};

const waitForIdle = (timeout = 0) => new Promise(resolve => {
    runWhenIdle(() => resolve(), timeout);
});

class PopupMenu {
    constructor(renameManager, chatStorage) {
        this.renameManager = renameManager;
        this.chatStorage = chatStorage;
        this.activePopup = null;
        this.chatUI = null;
        this.init();
    }

    init() {
        this.popup = document.querySelector('.popup-menu');
        this.initRenameLogic();
        document.addEventListener('click', this.handleGlobalClick.bind(this));
        this.popup.addEventListener('click', this.handlePopupClick.bind(this));
    }

    initRenameLogic() {
        const confirmBtn = this.popup.querySelector('.rename-confirm');
        const cancelBtn = this.popup.querySelector('.rename-cancel');

        confirmBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.confirmRename();
        });

        cancelBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.restorePopupMenu();
        });

        const input = this.popup.querySelector('.rename-input');
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                this.confirmRename();
            } else if (e.key === 'Escape') {
                this.hidePopup();
            }
        });
    }

    addHistoryItem(item) {
        const dots = item.querySelector('.action-dots');
        dots.addEventListener('click', (e) => this.handleDotsClick(e, item));
    }

    handleDotsClick(e, item) {
        e.stopPropagation();

        if (this.activePopup === item) {
            this.hidePopup();
            return;
        }

        // Restore popup menu state before showing it for another item
        this.restorePopupMenu();

        const rect = item.getBoundingClientRect();
        this.popup.style.top = `${rect.top}px`;
        this.popup.style.left = `${rect.right + 5}px`;

        this.popup.classList.add('active');
        this.activePopup = item;
    }

    handlePopupClick(e) {
        e.stopPropagation();
        const action = e.target.dataset.action;
        if (!action) return;

        switch (action) {
            case 'rename':
                const renameButton = this.popup.querySelector('[data-action="rename"]');
                const inputWrapper = this.popup.querySelector('.rename-input-wrapper');
                const deleteButton = this.popup.querySelector('[data-action="delete"]');
                const autoRenameButton = this.popup.querySelector('[data-action="auto-rename"]');
                const input = this.popup.querySelector('.rename-input');

                renameButton.style.display = 'none';
                deleteButton.style.display = 'none';
                inputWrapper.style.display = 'flex';
                autoRenameButton.style.display = 'none';
                input.value = this.activePopup.querySelector('.item-text').textContent;
                input.focus();
                break;
            case 'delete':
                this.deleteChat(this.activePopup, e.target);
                break;
            case 'auto-rename':
                this.autoRenameSingleChat(this.activePopup);
                break;
        }
    }

    handleGlobalClick() {
        this.hidePopup();
    }

    restorePopupMenu() {
        this.popup.querySelector('[data-action="rename"]').style.display = 'block';
        this.popup.querySelector('.rename-input-wrapper').style.display = 'none';
        this.popup.querySelector('[data-action="delete"]').style.display = 'block';
        this.popup.querySelector('[data-action="auto-rename"]').style.display = 'block';

        // Reset the delete button state
        const deleteButton = this.popup.querySelector('[data-action="delete"]');
        if (deleteButton) {
            deleteButton.classList.remove('delete-confirm');
            deleteButton.textContent = 'Delete';
        }
    }

    hidePopup() {
        this.restorePopupMenu();
        this.popup.classList.remove('active');
        this.activePopup = null;
    }

    confirmRename() {
        const newName = this.popup.querySelector('.rename-input').value.trim();
        if (newName) {
            const textSpan = this.activePopup.querySelector('.item-text');
            const oldName = textSpan.textContent;
            textSpan.textContent = textSpan.textContent.replace(oldName, newName);
            const currentId = parseInt(this.activePopup.id, 10);
            if (chatCore.getChatId() === currentId)
                chatCore.miscUpdate({ title: chatUI.autoUpdateChatHeader(chatCore.getChatId()) || chatCore.getTitle() });
            this.chatStorage.renameChat(currentId, newName);
        }
        this.hidePopup();
    }

    deleteChat(item, popupItem) {
        if (!popupItem.classList.contains('delete-confirm')) {
            popupItem.classList.add('delete-confirm');
            popupItem.textContent = 'Sure?';
            return;
        }
    
        const chatId = parseInt(item.id, 10);
    
        this.chatUI.handleItemDeletion(item);
    
        this.chatStorage.deleteChat(chatId);
        if (chatCore.getChatId() === chatId) {
            chatCore.reset();
            this.chatUI.clearConversation();
        }
    
        this.hidePopup();
    }

    async autoRenameSingleChat(item) {
        const textSpan = item.querySelector('.item-text');
        const result = await this.renameManager.renameSingleChat(parseInt(item.id, 10), textSpan);
        
        if (result?.tokenCounter) {
            result.tokenCounter.updateLifetimeTokens();
            if (chatCore.getChatId() === parseInt(item.id, 10))
                chatCore.miscUpdate({ title: chatUI.autoUpdateChatHeader(chatCore.getChatId()) || chatCore.getTitle() });
        }
        
        this.hidePopup();
    }
}


const chatStorage = new ChatStorage();
const chatCore = new ChatCore(chatStorage);
const renameManager = new HistoryRenameManager(chatStorage);
const popupMenu = new PopupMenu(renameManager, chatStorage);
const stateManager = new HistoryStateManager();
const chatUI = new HistoryChatUI({
    stateManager,
    popupMenu,
    continueFunc: (index, secondaryIndex, modelChoice = null) => 
        sendChatToSidepanel({ chatId: chatCore.getChatId(), index, secondaryIndex, modelChoice }),
    loadHistoryItems: chatStorage.getChatMetadata.bind(chatStorage),
    addPopupActions: popupMenu.addHistoryItem.bind(popupMenu),
    loadChat: async (chatId) => { return await chatCore.loadChat(chatId); },
    getChatMeta: async (chatId) => {return await chatStorage.getChatMetadataById(chatId);},
});
popupMenu.chatUI = chatUI;


function initMessageListeners() {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        switch (message.type) {
            case 'new_chat_saved':
                handleNewChatSaved(message.chat);
                break;
            case 'appended_messages_to_saved_chat':
                handleAppendedMessages(message.chatId, message.addedCount, message.startIndex);
                break;
            case 'message_updated':
                handleMessageUpdate(message.chatId, message.messageId);
                break;
            case 'chat_renamed':
                handleChatRenamed(message.chatId, message.title);
                break;
        }
    });
}

async function handleAppendedMessages(chatId, addedCount, startIndex, message = null) {
    handleHistoryItemOnNewMessage(chatId);
    if (chatCore.getChatId() !== chatId) return;
    
    const newMessages = message ? [message] : await chatStorage.getMessages(chatId, startIndex, addedCount);
    if (!newMessages) return;
    
    chatUI.appendMessages(newMessages, chatCore.getLength());
    chatCore.addMultipleFromHistory(newMessages);
}

async function handleHistoryItemOnNewMessage(chatId) {
    // due to updated timestamp, history item order (and dividers) may need to be updated
    if (!chatId) return;
    const chatMeta = await chatStorage.getChatMetadataById(chatId);
    const historyItem = chatUI.getHistoryItem(chatId);
    if (historyItem) {
        chatUI.handleItemDeletion(historyItem);
    }
    chatUI.handleNewChatSaved(chatMeta);
}

function handleNewChatSaved(chatMeta) {
    chatUI.handleNewChatSaved(chatMeta);
    // if no chat is open, open the new chat (might remove if annoying)
    if (chatCore.getChatId() === null) {
        chatUI.buildChat(chatMeta.chatId);
    }
}

async function handleMessageUpdate(chatId, messageId) {
    if (chatCore.getChatId() !== chatId) return;
    
    const updatedMessage = await chatStorage.getMessage(chatId, messageId);
    if (!updatedMessage) return;
    
    const isUpdate = messageId < chatCore.getLength();
    if (!isUpdate) {
        handleAppendedMessages(chatId, 1, chatCore.getLength(), updatedMessage);
        return;
    }
    
    handleHistoryItemOnNewMessage(chatId);
    if (updatedMessage.responses) chatUI.updateArenaMessage(updatedMessage, messageId);
    else chatUI.appendSingleRegeneratedMessage(updatedMessage, messageId);
    chatCore.replaceLastFromHistory(updatedMessage);
}

function handleChatRenamed(chatId, title) {
    chatUI.handleChatRenamed(chatId, title);
    if (chatCore.getChatId() === chatId) {
        chatCore.miscUpdate( { title } );
        chatUI.updateChatHeader(title);
    }
}


function sendChatToSidepanel(options) {
    const message = {
        type: "reconstruct_chat",
        options,
    };
    chrome.runtime.sendMessage({ type: "is_sidepanel_open" })
        .then(response => {
            if (!response.isOpen) {
                return chrome.runtime.sendMessage({ type: "open_side_panel" })
                    .then(() => {
                        return chrome.runtime.sendMessage(message);
                    });
            } else {
                return chrome.runtime.sendMessage(message);
            }
        });
}


async function autoRenameUnmodified() {
    const button = document.getElementById('auto-rename');
    const model = renameManager.getModel();

    // First click confirmation
    if (!button.dataset.confirmed) {
        button.textContent = `use ${model} to rename?`;
        button.dataset.confirmed = "pending";
        setTimeout(() => {
            if (button.dataset.confirmed === "pending") {
                button.textContent = "auto-rename unmodified";
                delete button.dataset.confirmed;
            }
        }, 3000);
        return;
    }
    delete button.dataset.confirmed;
    button.textContent = "renaming...";

    const result = await renameManager.renameAllUnmodified();

    if (result.status === 'no_chats') {
        button.textContent = "no chats to rename";
        setTimeout(() => {
            button.textContent = "auto-rename unmodified";
        }, 2000);
        return;
    }

    result.tokenCounter.updateLifetimeTokens();
    button.textContent = `${result.successCount}/${result.totalCount} renamed (${result.tokenCounter.inputTokens}|${result.tokenCounter.outputTokens} tokens)`;
    if (chatCore.getChatId()) chatCore.miscUpdate({ title: chatUI.autoUpdateChatHeader(chatCore.getChatId()) || chatCore.getTitle() });
    setTimeout(() => {
        button.textContent = "auto-rename unmodified";
    }, 15000);
}


async function initiateChatBackupDownload(element) {
    try {
        element.textContent = "extracting...";
        const chatDataJson = await chatStorage.exportChats({ pretty: true });
        chatStorage.triggerDownload(chatDataJson);
        element.textContent = "success!";
    } catch (error) {
        element.textContent = "failed :(";
        console.error(error);
    }
    setTimeout(() => {
        element.textContent = "export";
    }, 5000);
}


async function initiateChatBackupImport(element) {
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'application/json';

    fileInput.onchange = async (event) => {
        const file = event.target.files[0];
        if (!file) {
            element.textContent = "no file selected";
            setTimeout(() => {
                element.textContent = "import";
            }, 3000);
            return;
        }

        const reader = new FileReader();
        reader.onload = async (e) => {
            try {
                element.textContent = "importing...";
                const importResult = await chatStorage.importChats(e.target.result);
                element.textContent = importResult.success ? `${importResult.count} added` : 'failed :(';
                if (!importResult.success) console.error("Import error:", importResult.error);
                chatUI.reloadHistoryList();
                if (importResult.success && chatSearch) {
                    chatSearch.markIndexStale();
                    await chatSearch.forceRebuild().catch(err => console.error('Search rebuild failed:', err));
                }
            } catch (error) {
                element.textContent = "failed :(";
                console.error("Import error:", error);
            }
            setTimeout(() => { element.textContent = "import"; }, 5000);
        };
        reader.readAsText(file);
    };
    fileInput.click(); // Programmatically trigger file selection
}


const MEDIA_DEFAULT_LIMIT = 500;
const MEDIA_STATE = Object.freeze({
    loading: 'loading',
    migrating: 'migrating',
    ready: 'ready',
    empty: 'empty',
    error: 'error'
});

const MEDIA_STATUS_MESSAGES = Object.freeze({
    [MEDIA_STATE.loading]: {
        title: 'Loading media…',
        subtitle: ''
    },
    [MEDIA_STATE.migrating]: {
        title: 'Indexing existing images…',
        subtitle: 'This will only happen once.'
    },
    [MEDIA_STATE.empty]: {
        title: 'No images found',
        subtitle: 'Images from new chats will appear here.'
    },
    [MEDIA_STATE.error]: {
        title: 'Error loading media',
        subtitle: 'Please try again later.'
    }
});

class MediaTab {
    constructor(chatStorage, chatUI) {
        this.chatStorage = chatStorage;
        this.chatUI = chatUI;
        this.currentFilter = 'all';
        this.currentSort = 'desc';
        this.mediaEntries = [];
        this.isLoading = false;
        this.hasAttemptedInitialLoad = false;
        this.invalidMediaIds = new Set();
        this.pendingRefresh = false;
        this.init();
    }

    init() {
        document.querySelectorAll('.history-tab').forEach(tab => {
            tab.addEventListener('click', () => this.switchTab(tab.dataset.tab));
        });

        document.querySelectorAll('.media-filter-btn').forEach(btn => {
            btn.addEventListener('click', () => this.setFilter(btn.dataset.filter));
        });

        const sortToggle = document.getElementById('media-sort-toggle');
        if (sortToggle) {
            sortToggle.addEventListener('click', () => this.toggleSort(sortToggle));
        }
    }

    switchTab(tabName) {
        document.querySelectorAll('.history-tab').forEach(t => {
            const isActive = t.dataset.tab === tabName;
            t.classList.toggle('active', isActive);
        });

        document.querySelectorAll('.history-tab-content').forEach(c => c.style.display = 'none');
        document.querySelectorAll('.history-chat-view, .media-view').forEach(c => c.style.display = 'none');

        const chatContainer = document.getElementById(`${tabName}-tab`);
        const chatView = document.getElementById('chat-view');
        const mediaSidebar = document.getElementById('media-tab');
        const mediaView = document.getElementById('media-view');

        if (tabName === 'media') {
            if (mediaSidebar) mediaSidebar.style.display = 'flex';
            if (mediaView) mediaView.style.display = 'flex';
        } else {
            if (chatContainer) chatContainer.style.display = 'flex';
            if (chatView) chatView.style.display = 'flex';
        }

        if (tabName === 'media' && !this.hasAttemptedInitialLoad) {
            this.hasAttemptedInitialLoad = true;
            runWhenIdle(() => { void this.refreshMedia(); });
        }
    }

    async refreshMedia({ force = false } = {}) {
        if (this.isLoading && !force) return;

        const runLoad = async () => {
            this.pendingRefresh = false;
            if (this.isLoading && !force) return;
            this.isLoading = true;

            const panel = document.getElementById('media-panel');
            const grid = document.getElementById('media-grid');
            this.setMediaState(panel, MEDIA_STATE.loading);
            if (grid) {
                grid.innerHTML = '';
            }

            const loadStart = now();

            try {
                let entries = await this.chatStorage.getAllMedia(MEDIA_DEFAULT_LIMIT, 0);

                entries = await this.handlePotentialMigration(entries, panel, loadStart);

                this.invalidMediaIds = new Set();
                this.mediaEntries = entries;

                if (entries.length === 0) {
                    this.setMediaState(panel, MEDIA_STATE.empty);
                    return;
                }

                this.setMediaState(panel, MEDIA_STATE.ready);
                await this.renderMedia();
                console.log(`Media grid loaded ${entries.length} entries in ${formatDuration(loadStart)}`);
            } catch (error) {
                this.setMediaState(panel, MEDIA_STATE.error);
                console.error('Error loading media:', error);
            } finally {
                this.isLoading = false;
            }
        };

        if (!force) {
            if (this.pendingRefresh) return;
            this.pendingRefresh = true;
            runWhenIdle(() => { void runLoad(); });
            return;
        }

        this.pendingRefresh = false;
        await runLoad();
    }

    async handlePotentialMigration(initialEntries, panel, loadStart) {
        if (initialEntries.length > 0) return initialEntries;

        const migrateStart = now();
        const needsMigration = await this.detectUnindexedImages();

        if (!needsMigration) {
            console.log(`Media grid load found 0 entries and no migration needed (${formatDuration(loadStart)})`);
            return initialEntries;
        }

        this.setMediaState(panel, MEDIA_STATE.migrating);

        try {
            const indexedCount = await this.migrateExistingImages();
            console.log(`Media migration indexed ${indexedCount} images in ${formatDuration(migrateStart)}`);
            if (indexedCount === 0) return initialEntries;
            return await this.chatStorage.getAllMedia(MEDIA_DEFAULT_LIMIT, 0);
        } catch (error) {
            console.error('Media migration failed:', error);
            this.setMediaState(panel, MEDIA_STATE.error);
            throw error;
        }
    }

    setMediaState(panel, state) {
        if (!panel) return;
        panel.setAttribute('data-state', state);

        const { title = '', subtitle = '' } = MEDIA_STATUS_MESSAGES[state] ?? {};

        const status = this.ensureMediaStatus(panel);
        status.title.textContent = title;
        status.subtitle.textContent = subtitle;
    }

    ensureMediaStatus(panel) {
        let container = panel.querySelector('.media-status');
        if (!container) {
            container = createElementWithClass('div', 'media-status');
            const icon = createElementWithClass('div', 'media-status-icon');
            const copy = createElementWithClass('div', 'media-status-copy');
            const title = createElementWithClass('div', 'media-status-title');
            const subtitle = createElementWithClass('div', 'media-status-subtitle');
            copy.append(title, subtitle);
            container.append(icon, copy);
            panel.prepend(container);
        }

        const copy = container.querySelector('.media-status-copy');
        const title = container.querySelector('.media-status-title');
        const subtitle = container.querySelector('.media-status-subtitle');

        return {
            container,
            icon: container.querySelector('.media-status-icon'),
            copy,
            title,
            subtitle
        };
    }

    async detectUnindexedImages(sampleSize = 20) {
        const metas = await this.chatStorage.getChatMetadata(sampleSize, 0);

        for (const meta of metas) {
            const chat = await this.chatStorage.loadChat(meta.chatId, 50);
            if (this.chatContainsImages(chat.messages)) {
                return true;
            }
        }

        return false;
    }

    chatContainsImages(messages) {
        if (!Array.isArray(messages)) return false;

        return messages.some(msg => {
            if (!msg) return false;
            if (Array.isArray(msg.images) && msg.images.length) return true;

            if (Array.isArray(msg.contents)) {
                if (msg.contents.some(group => Array.isArray(group) && group.some(part => part?.type === 'image'))) {
                    return true;
                }
            }

            if (msg.responses) {
                return ['model_a', 'model_b'].some(key =>
                    msg.responses[key]?.messages?.some(group =>
                        Array.isArray(group) && group.some(part => part?.type === 'image')
                    )
                );
            }

            return false;
        });
    }

    async migrateExistingImages(batchSize = 50) {
        const allMeta = await this.chatStorage.getChatMetadata(Infinity, 0);
        const db = await this.chatStorage.getDB();
        let totalImages = 0;

        for (let i = 0; i < allMeta.length; i += batchSize) {
            const batch = allMeta.slice(i, i + batchSize);

            await Promise.all(batch.map(async (meta) => {
                const chat = await this.chatStorage.loadChat(meta.chatId);
                const tx = db.transaction(['mediaIndex'], 'readwrite');
                const mediaStore = tx.objectStore('mediaIndex');
                const promises = this.chatStorage.indexImagesFromMessages(meta.chatId, chat.messages, mediaStore);
                await Promise.all(promises);
                totalImages += promises.length;
            }));
        }

        return totalImages;
    }

    setFilter(filter) {
        if (this.currentFilter === filter) return;
        this.currentFilter = filter;
        document.querySelectorAll('.media-filter-btn').forEach(b => b.classList.remove('is-active', 'active'));
        const target = document.querySelector(`[data-filter="${filter}"]`);
        if (target) target.classList.add('is-active');
        void this.renderMedia();
    }

    async renderMedia() {
        const panel = document.getElementById('media-panel');
        const grid = document.getElementById('media-grid');
        if (!panel || !grid) return;

        const filteredEntries = this.mediaEntries
            .filter(entry => this.currentFilter === 'all' || entry.source === this.currentFilter)
            .filter(entry => !this.invalidMediaIds?.has(entry.id));

        const sortedEntries = [...filteredEntries].sort((a, b) => {
            if (this.currentSort === 'asc') {
                return (a.timestamp ?? 0) - (b.timestamp ?? 0);
            }
            return (b.timestamp ?? 0) - (a.timestamp ?? 0);
        });

        grid.innerHTML = '';

        if (sortedEntries.length === 0) {
            this.setMediaState(panel, MEDIA_STATE.empty);
            return;
        }

        this.setMediaState(panel, MEDIA_STATE.ready);
        await Promise.all(sortedEntries.map(entry => this.renderMediaItem(entry, grid)));

        if (!grid.children.length) {
            this.setMediaState(panel, MEDIA_STATE.empty);
        }
    }

    async renderMediaItem(entry, grid) {
        const imageData = await this.chatStorage.getImageFromMediaEntry(entry);

        if (!this.isValidImage(imageData)) {
            await this.handleInvalidMedia(entry.id);
            return;
        }

        const mediaElement = this.createMediaElement(entry, imageData);
        if (mediaElement) {
            grid.appendChild(mediaElement);
        }
    }

    createMediaElement(entry, imageData) {
        const item = document.createElement('div');
        item.className = 'media-item';

        const content = this.createMediaContent(entry, imageData, item);
        if (!content) {
            return null;
        }
        item.appendChild(content);

        item.appendChild(this.createBadge(entry.source));

        item.addEventListener('click', () => this.handleMediaClick(entry));

        return item;
    }

    createMediaContent(entry, imageData, item) {
        const img = document.createElement('img');
        img.src = imageData;
        img.alt = 'Media item';
        img.onerror = () => {
            this.handleInvalidMedia(entry.id, item);
        };
        return img;
    }

    createBadge(source) {
        const badge = document.createElement('div');
        const isUser = source === 'user';
        badge.className = `media-item-badge ${isUser ? 'media-item-badge-user' : 'media-item-badge-ai'}`;
        badge.textContent = isUser ? 'USER' : 'AI';
        return badge;
    }

    handleMediaClick(entry) {
        this.chatUI.buildChat(entry.chatId).then(() => {
            document.querySelector('[data-tab="chats"]').click();
            const messageElement = document.querySelector(`[data-message-id="${entry.messageId}"]`);
            if (messageElement) {
                messageElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
        });
    }

    isValidImage(imageData) {
        if (!imageData) return false;
        return (
            imageData.startsWith('data:image/') ||
            imageData.startsWith('http://') ||
            imageData.startsWith('https://')
        );
    }

    markEntryInvalid(entryId) {
        if (!this.invalidMediaIds) {
            this.invalidMediaIds = new Set();
        }
        this.invalidMediaIds.add(entryId);
        this.mediaEntries = this.mediaEntries.filter(entry => entry.id !== entryId);
    }

    toggleSort(button) {
        this.currentSort = this.currentSort === 'desc' ? 'asc' : 'desc';
        button.dataset.order = this.currentSort;
        button.textContent = this.currentSort === 'desc' ? 'Newest first' : 'Oldest first';
        button.classList.toggle('is-active', this.currentSort === 'asc');
        void this.renderMedia();
    }

    async handleInvalidMedia(entryId, item = null) {
        this.markEntryInvalid(entryId);
        try {
            await this.chatStorage.deleteMediaEntry(entryId);
        } catch (error) {
            console.warn('Failed to delete invalid media entry', error);
        }

        if (item?.parentNode) {
            item.remove();
        }

        const grid = document.getElementById('media-grid');
        const panel = document.getElementById('media-panel');
        if (grid && grid.children.length === 0) {
            this.setMediaState(panel, MEDIA_STATE.empty);
        }
    }
}

const MINI_SEARCH_OPTIONS = Object.freeze({
    fields: ['title', 'content'],
    storeFields: ['id', 'title'],
    searchOptions: {
        boost: { title: 2 },
        fuzzy: 0.2,
        prefix: true
    }
});

class ChatSearch {
    constructor(chatUI) {
        this.chatUI = chatUI;
        this.miniSearch = null;
        this.allChats = [];
        this.indexDirty = false;
        this.indexStale = false;
        this.persistDelayMs = 750;
        this.persistTimeout = null;
        this.persistInFlight = null;
        this.handleVisibilityChange = this.handleVisibilityChange.bind(this);
        this.beforeUnloadHandler = () => { void this.flushPersist(true); };
        document.addEventListener('visibilitychange', this.handleVisibilityChange);
        window.addEventListener('pagehide', this.beforeUnloadHandler, { once: false });
        this.init();
    }

    init() {
        const searchInput = document.getElementById('history-search');
        const clearBtn = document.getElementById('search-clear');

        searchInput.addEventListener('input', (e) => this.handleSearch(e.target.value));
        clearBtn.addEventListener('click', () => {
            searchInput.value = '';
            this.clearSearch();
        });

        const scheduleInit = () => runWhenIdle(() => { void this.initSearch(); });

        if (document.readyState === 'complete' || document.readyState === 'interactive') {
            scheduleInit();
        } else {
            document.addEventListener('DOMContentLoaded', scheduleInit, { once: true });
        }
    }

    async initSearch() {
        if (typeof window.MiniSearch === 'undefined') {
            console.warn('MiniSearch library not loaded, search will be disabled');
            return;
        }

        const initStart = now();

        await waitForIdle(0);

        const [metadata, jsonStr, storedDocsSnapshot, storedCount] = await Promise.all([
            chatStorage.getChatMetadata(Infinity, 0),
            chatStorage.getSearchJson(),
            chatStorage.getSearchDocs(),
            chatStorage.getSearchCount()
        ]);

        await waitForIdle(0);

        const currentCount = metadata.length;

        if (currentCount === 0) {
            this.miniSearch = this.createMiniSearch();
            this.allChats = [];
            await this.persistIndex(true);
            console.log(`Search initialised for empty chat history in ${formatDuration(initStart)}`);
            return;
        }

        let successfullyLoadedFromCache = false;

        if (jsonStr) {
            try {
                const data = JSON.parse(jsonStr);
                const storedDocs = this.rehydrateDocuments(data, storedDocsSnapshot);

                if (storedDocs) {
                    this.miniSearch = this.loadMiniSearch(jsonStr);
                    this.allChats = storedDocs;
                    successfullyLoadedFromCache = true;
                }
            } catch (error) {
                console.error('Invalid stored index, clearing and rebuilding:', error);
            }
        }

        if (!successfullyLoadedFromCache || this.indexStale) {
            await this.rebuildIndex(metadata, initStart);
            this.indexStale = false;
            return;
        }

        const { changed, summary } = await this.syncIndexWithMetadata(metadata);
        const shouldPersist = changed || storedCount !== currentCount;

        if (shouldPersist) {
            await this.persistIndex();
            console.log(`Search index synchronised (${summary}) in ${formatDuration(initStart)}`);
        } else {
            console.log(`Search loaded from storage with ${currentCount} chats (no changes) in ${formatDuration(initStart)}`);
        }
    }

    createMiniSearch() {
        return new window.MiniSearch(MINI_SEARCH_OPTIONS);
    }

    loadMiniSearch(json) {
        return window.MiniSearch.loadJSON(json, MINI_SEARCH_OPTIONS);
    }

    normaliseId(rawId) {
        const idString = `${rawId}`;
        return idString.match(/^\d+$/) ? Number(idString) : rawId;
    }

    rehydrateDocuments(indexData, storedDocsSnapshot) {
        const docsFromIndex = indexData?.documentStore?.docs;

        if (Array.isArray(storedDocsSnapshot) && storedDocsSnapshot.length) {
            return storedDocsSnapshot.map(doc => ({
                id: this.normaliseId(doc.id),
                title: doc.title ?? '',
                content: doc.content ?? '',
                timestamp: doc.timestamp ?? null
            }));
        }

        if (!docsFromIndex) {
            console.warn('Stored search index missing document payload, rebuilding');
            return null;
        }

        return Object.keys(docsFromIndex).map(key => {
            const docPayload = docsFromIndex[key];
            return {
                id: this.normaliseId(docPayload?.id ?? key),
                title: docPayload?.title ?? '',
                content: docPayload?.content ?? '',
                timestamp: docPayload?.timestamp ?? null
            };
        });
    }

    async rebuildIndex(metadata = null, startOverride = null) {
        const buildStart = startOverride ?? now();
        const metaList = metadata || await chatStorage.getChatMetadata(Infinity, 0);

        this.allChats = await this.buildDocumentsInBatches(metaList);

        this.miniSearch = this.createMiniSearch();

        this.miniSearch.addAll(this.allChats);

        await this.persistIndex();

        console.log(`Search built with ${this.allChats.length} chats in ${formatDuration(buildStart)}`);
    }

    async buildDocumentsInBatches(metaList, batchSize = 12) {
        const documents = [];

        for (let i = 0; i < metaList.length; i += batchSize) {
            const batch = metaList.slice(i, i + batchSize);
            const docs = await Promise.all(batch.map(meta => this.buildDocument(meta)));
            documents.push(...docs);

            await waitForIdle(50);
        }

        return documents;
    }

    async forceRebuild() {
        await this.rebuildIndex();
    }

    async addToIndex(chatMeta) {
        if (!this.miniSearch) return;
        const doc = await this.buildDocument(chatMeta);
        this.miniSearch.add(doc);
        this.allChats.push(doc);
        this.markIndexDirty();
        await waitForIdle(10);
    }

    async removeFromIndex(chatId) {
        if (!this.miniSearch) return;
        const doc = this.allChats.find(d => d.id === chatId);
        if (doc) {
            this.miniSearch.remove(doc);
        }
        this.allChats = this.allChats.filter(d => d.id !== chatId);
        this.markIndexDirty();
        await waitForIdle(10);
    }

    async updateInIndex(chatId, newTitle) {
        if (!this.miniSearch) return;
        const doc = this.allChats.find(d => d.id === chatId);
        if (doc) {
            doc.title = newTitle;
            this.miniSearch.replace(doc);
            this.markIndexDirty();
            await waitForIdle(10);
        }
    }

    markIndexDirty() {
        this.indexDirty = true;
        this.clearPersistTimer();
        this.persistTimeout = setTimeout(() => { void this.flushPersist(); }, this.persistDelayMs);
    }

    markIndexStale() {
        this.indexStale = true;
    }

    async flushPersist(force = false) {
        if (!this.indexDirty && !force) return;

        if (this.persistInFlight) {
            await this.persistInFlight;
            if (!this.indexDirty && !force) return;
        }

        await waitForIdle(0);

        const persistPromise = this.persistIndex(force).finally(() => {
            this.persistInFlight = null;
        });

        this.persistInFlight = persistPromise;
        await persistPromise;
    }

    async persistIndex(force = false) {
        if (!this.miniSearch && !force) return;
        const jsonStr = JSON.stringify(this.miniSearch ? this.miniSearch.toJSON() : {});
        await chatStorage.setSearchIndex(jsonStr, this.allChats.length, this.allChats);
        this.indexDirty = false;
        this.clearPersistTimer();
    }

    async buildDocument(meta) {
        const chat = await chatStorage.loadChat(meta.chatId);
        const document = {
            id: this.normaliseId(meta.chatId),
            title: meta.title,
            content: this.extractTextFromMessages(chat.messages),
            timestamp: meta.timestamp
        };
        await waitForIdle(5);
        return document;
    }

    async syncIndexWithMetadata(metadata) {
        const metadataMap = new Map(metadata.map(meta => [this.normaliseId(meta.chatId), meta]));
        const existingDocsMap = new Map(this.allChats.map(doc => [doc.id, doc]));

        let removed = 0;
        let added = 0;
        let updated = 0;

        let processed = 0;

        for (const [id, doc] of existingDocsMap.entries()) {
            if (!metadataMap.has(id)) {
                this.miniSearch.remove(doc);
                existingDocsMap.delete(id);
                removed++;
            }

            processed++;
            if (processed % 50 === 0) {
                await waitForIdle(25);
            }
        }

        const additions = [];
        const renameUpdates = [];
        const contentUpdates = [];

        for (const meta of metadata) {
            const id = this.normaliseId(meta.chatId);
            const existing = existingDocsMap.get(id);

            if (!existing) {
                additions.push(meta);
                continue;
            }

            const titleChanged = existing.title !== meta.title;
            const timestampChanged = existing.timestamp !== meta.timestamp;

            if (!titleChanged && !timestampChanged) continue;

            if (timestampChanged) {
                contentUpdates.push(meta);
            } else if (titleChanged) {
                renameUpdates.push(meta);
            }

            processed++;
            if (processed % 50 === 0) {
                await waitForIdle(25);
            }
        }

        if (additions.length) {
            const newDocs = await Promise.all(additions.map(meta => this.buildDocument(meta)));
            newDocs.forEach(doc => {
                this.miniSearch.add(doc);
                existingDocsMap.set(doc.id, doc);
            });
            added = newDocs.length;
            await waitForIdle(25);
        }

        if (renameUpdates.length) {
            renameUpdates.forEach(meta => {
                const id = this.normaliseId(meta.chatId);
                const existing = existingDocsMap.get(id);
                if (!existing) return;
                existing.title = meta.title;
                existing.timestamp = meta.timestamp;
                this.miniSearch.replace(existing);
            });
            updated += renameUpdates.length;
            await waitForIdle(25);
        }

        if (contentUpdates.length) {
            const updatedDocs = await Promise.all(contentUpdates.map(meta => this.buildDocument(meta)));
            updatedDocs.forEach(doc => {
                this.miniSearch.replace(doc);
                existingDocsMap.set(doc.id, doc);
            });
            updated += updatedDocs.length;
            await waitForIdle(25);
        }

        this.allChats = metadata
            .map(meta => existingDocsMap.get(this.normaliseId(meta.chatId)))
            .filter(Boolean);

        const changed = Boolean(removed || added || updated);
        const summary = `${added} added, ${updated} updated, ${removed} removed`;

        return { changed, summary };
    }

    handleVisibilityChange() {
        if (document.visibilityState === 'hidden') {
            void this.flushPersist(true);
        }
    }

    clearPersistTimer() {
        if (this.persistTimeout) {
            clearTimeout(this.persistTimeout);
            this.persistTimeout = null;
        }
    }

    extractTextFromMessages(messages) {
        if (!messages || !Array.isArray(messages)) return '';

        return messages.map(msg => this.extractMessageText(msg)).join(' ');
    }

    extractMessageText(msg) {
        if (!msg) return '';

        if (Array.isArray(msg.contents)) {
            return msg.contents
                .flat()
                .filter(part => part && (part.type === 'text' || part.type === 'thought'))
                .map(part => part.content || '')
                .join(' ');
        }

        if (msg.responses) {
            return ['model_a', 'model_b']
                .map(modelKey => msg.responses[modelKey]?.messages || [])
                .flat()
                .flat()
                .filter(part => part && part.type === 'text')
                .map(part => part.content || '')
                .join(' ');
        }

        return '';
    }

    handleSearch(query) {
        const clearBtn = document.getElementById('search-clear');

        if (!query.trim()) {
            this.clearSearch();
            clearBtn.style.display = 'none';
            return;
        }

        clearBtn.style.display = 'block';

        if (!this.miniSearch) {
            console.warn('Search not initialized, waiting for index...');
            return;
        }

        try {
            const results = this.miniSearch.search(query).map(result => ({
                ...result,
                id: this.normaliseId(result.id)
            }));
            this.displayResults(results);
        } catch (error) {
            console.error('Search error:', error);
        }
    }

    displayResults(results) {
        const historyList = document.querySelector('.history-list');
        const allItems = historyList.querySelectorAll('.history-sidebar-item');
        const allDividers = historyList.querySelectorAll('.history-divider');

        if (results.length === 0) {
            allItems.forEach(item => item.classList.add('search-hidden'));
            allDividers.forEach(divider => divider.classList.add('search-hidden'));

            if (!historyList.querySelector('.search-no-results')) {
                const noResults = createElementWithClass('div', 'search-no-results', 'No results found');
                historyList.appendChild(noResults);
            }
            return;
        }

        const noResultsMsg = historyList.querySelector('.search-no-results');
        if (noResultsMsg) noResultsMsg.remove();

        const resultIds = new Set(results.map(r => r.id));
        allItems.forEach(item => {
            const chatId = parseInt(item.id, 10);
            if (resultIds.has(chatId)) {
                item.classList.remove('search-hidden');
            } else {
                item.classList.add('search-hidden');
            }
        });

        allDividers.forEach(divider => {
            let sibling = divider.nextElementSibling;
            let hasVisibleItem = false;

            while (sibling && !sibling.classList.contains('history-divider')) {
                if (!sibling.classList.contains('search-hidden')) {
                    hasVisibleItem = true;
                    break;
                }
                sibling = sibling.nextElementSibling;
            }

            if (hasVisibleItem) {
                divider.classList.remove('search-hidden');
            } else {
                divider.classList.add('search-hidden');
            }
        });
    }

    clearSearch() {
        const historyList = document.querySelector('.history-list');
        const allItems = historyList.querySelectorAll('.history-sidebar-item');
        const allDividers = historyList.querySelectorAll('.history-divider');

        const noResultsMsg = historyList.querySelector('.search-no-results');
        if (noResultsMsg) noResultsMsg.remove();

        allItems.forEach(item => {
            item.classList.remove('search-hidden');
        });

        allDividers.forEach(divider => divider.classList.remove('search-hidden'));

        document.getElementById('search-clear').style.display = 'none';
    }

    async reindex() {
        const currentCount = await chatStorage.getChatCount();
        await this.rebuildIndex();
    }
}

let mediaTab;
let chatSearch;

function init() {
    initMessageListeners();
    document.getElementById('auto-rename').onclick = autoRenameUnmodified;
    document.getElementById('export').onclick = (e) => initiateChatBackupDownload(e.target);
    document.getElementById('import').onclick = (e) => initiateChatBackupImport(e.target);

    // Initialize media tab and search
    mediaTab = new MediaTab(chatStorage, chatUI);
    chatSearch = new ChatSearch(chatUI);
}


document.addEventListener('DOMContentLoaded', init);