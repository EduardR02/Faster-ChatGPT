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

const nextFrame = () => new Promise(resolve => {
    if (hasWindow && typeof window.requestAnimationFrame === 'function') {
        window.requestAnimationFrame(() => resolve());
    } else {
        setTimeout(resolve, 16);
    }
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
        chatMetaCache.delete(chatId);
        chatMetaComplete.delete(chatId);

        void this.chatStorage.deleteChat(chatId)
            .then(() => {
                if (chatSearch) {
                    return chatSearch.removeFromIndex(chatId);
                }
                return undefined;
            })
            .catch(error => {
                console.error('Failed to delete chat:', error);
            });
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
const chatMetaCache = new Map();
const chatMetaComplete = new Set();

const cacheChatMeta = (meta, { complete = false } = {}) => {
    if (!meta || meta.chatId == null) return meta;
    const existing = chatMetaCache.get(meta.chatId);
    if (existing) {
        const merged = { ...existing, ...meta };
        chatMetaCache.set(meta.chatId, merged);
        if (complete || chatMetaComplete.has(meta.chatId)) {
            chatMetaComplete.add(meta.chatId);
        }
        return merged;
    }
    chatMetaCache.set(meta.chatId, meta);
    if (complete) {
        chatMetaComplete.add(meta.chatId);
    }
    return meta;
};

const loadHistoryItems = async (...args) => {
    const items = await chatStorage.getChatMetadata(...args);
    items.forEach(item => cacheChatMeta(item));
    return items;
};

const getCachedChatMeta = async (chatId) => {
    if (chatMetaCache.has(chatId) && chatMetaComplete.has(chatId)) {
        return chatMetaCache.get(chatId);
    }
    const meta = await chatStorage.getChatMetadataById(chatId);
    if (meta) {
        return cacheChatMeta(meta, { complete: true });
    }
    if (chatMetaCache.has(chatId)) {
        return chatMetaCache.get(chatId);
    }
    return null;
};

const chatUI = new HistoryChatUI({
    stateManager,
    popupMenu,
    continueFunc: (index, secondaryIndex, modelChoice = null) => 
        sendChatToSidepanel({ chatId: chatCore.getChatId(), index, secondaryIndex, modelChoice }),
    loadHistoryItems: loadHistoryItems,
    addPopupActions: popupMenu.addHistoryItem.bind(popupMenu),
    loadChat: async (chatId) => { return await chatCore.loadChat(chatId); },
    getChatMeta: getCachedChatMeta,
});
popupMenu.chatUI = chatUI;


function initMessageListeners() {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        switch (message.type) {
            case 'new_chat_saved':
                handleNewChatSaved(message.chat, message.searchDoc);
                break;
            case 'appended_messages_to_saved_chat':
                handleAppendedMessages(
                    message.chatId,
                    message.addedCount,
                    message.startIndex,
                    undefined,
                    message.searchDelta,
                    message.timestamp
                );
                break;
            case 'message_updated':
                handleMessageUpdate(message.chatId, message.messageId);
                break;
            case 'chat_renamed':
                handleChatRenamed(message.chatId, message.title);
                break;
            case 'history_reindex':
                (async () => {
                    try {
                        const tasks = [];
                        if (chatSearch) tasks.push(chatSearch.reindex());
                        if (mediaTab) tasks.push(mediaTab.reindexMedia());
                        await Promise.all(tasks);
                        sendResponse({ ok: true });
                    } catch (error) {
                        console.error('History reindex failed:', error);
                        sendResponse({ ok: false, error: error?.message ?? 'unknown_error' });
                    }
                })();
                return true;
            case 'history_repair_images':
                (async () => {
                    try {
                        if (!chatStorage) {
                            sendResponse({ ok: false, error: 'history_not_ready' });
                            return;
                        }
                        const repaired = await chatStorage.repairAllBlobs();
                        if (mediaTab && repaired > 0) {
                            await mediaTab.refreshMedia({ force: true });
                        }
                        sendResponse({ ok: true, repaired });
                    } catch (error) {
                        console.error('History repair failed:', error);
                        sendResponse({ ok: false, error: error?.message ?? 'unknown_error' });
                    }
                })();
                return true;
            case 'repair_blob_from_data_url':
                (async () => {
                    try {
                        if (!chatStorage) {
                            sendResponse({ ok: false, error: 'history_not_ready' });
                            return;
                        }
                        const { repaired, dataUrl } = await chatStorage.repairBlobByDataUrl(message.dataUrl);
                        sendResponse({ ok: repaired, dataUrl });
                    } catch (error) {
                        console.error('Blob repair failed:', error);
                        sendResponse({ ok: false, error: error?.message ?? 'unknown_error' });
                    }
                })();
                return true;
        }
    });
}

async function handleAppendedMessages(chatId, addedCount, startIndex, message = null, searchDelta = null, timestamp = null) {
    await handleHistoryItemOnNewMessage(chatId, timestamp != null ? { timestamp } : {});

    if (searchDelta && searchDelta.trim()) {
        const update = {
            chatId,
            delta: searchDelta,
            timestamp
        };
        if (chatSearch) {
            chatSearch.enqueueAppend(update);
        }
    }

    if (mediaTab) {
        mediaTab.deferredForceRefresh = true;
        if (mediaTab.isMediaTabActive()) {
            runWhenIdle(() => { void mediaTab.refreshMedia({ incremental: true }); });
        }
    }

    if (chatCore.getChatId() !== chatId) return;
    
    const newMessages = message ? [message] : await chatStorage.getMessages(chatId, startIndex, addedCount);
    if (!newMessages) return;
    
    chatUI.appendMessages(newMessages, chatCore.getLength());
    chatCore.addMultipleFromHistory(newMessages);
}

async function handleHistoryItemOnNewMessage(chatId, overrides = {}) {
    // due to updated timestamp, history item order (and dividers) may need to be updated
    if (!chatId) return;
    let chatMeta = chatMetaCache.get(chatId);
    let fetched = false;
    if (chatMeta) {
        chatMeta = { ...chatMeta, ...overrides };
    } else {
        const fetchedMeta = await chatStorage.getChatMetadataById(chatId);
        if (!fetchedMeta) return;
        fetched = true;
        chatMeta = overrides && Object.keys(overrides).length
            ? { ...fetchedMeta, ...overrides }
            : fetchedMeta;
    }
    const wasComplete = chatMetaComplete.has(chatId);
    cacheChatMeta(chatMeta, { complete: fetched || wasComplete });
    const historyItem = chatUI.getHistoryItem(chatId);
    if (historyItem) {
        chatUI.handleItemDeletion(historyItem);
    }
    chatUI.handleNewChatSaved(chatMeta);
}

function handleNewChatSaved(chatMeta, searchDoc = null) {
    cacheChatMeta(chatMeta, { complete: true });
    chatUI.handleNewChatSaved(chatMeta);
    // if no chat is open, open the new chat (might remove if annoying)
    if (chatCore.getChatId() === null) {
        chatUI.buildChat(chatMeta.chatId);
    }

    if (searchDoc && chatSearch) {
        chatSearch.enqueueNewDocument(searchDoc);
    }
}

async function handleMessageUpdate(chatId, messageId) {
    if (chatCore.getChatId() !== chatId) return;
    
    const updatedMessage = await chatStorage.getMessage(chatId, messageId);
    if (!updatedMessage) return;
    
    const isUpdate = messageId < chatCore.getLength();
    if (!isUpdate) {
        const delta = ChatStorage.extractTextFromMessages([updatedMessage]);
        handleAppendedMessages(chatId, 1, chatCore.getLength(), updatedMessage, delta, updatedMessage.timestamp ?? null);
        return;
    }
    
    if (mediaTab) {
        mediaTab.deferredForceRefresh = true;
    }

    await handleHistoryItemOnNewMessage(chatId, { timestamp: updatedMessage.timestamp ?? Date.now() });
    if (updatedMessage.responses) chatUI.updateArenaMessage(updatedMessage, messageId);
    else chatUI.appendSingleRegeneratedMessage(updatedMessage, messageId);
    chatCore.replaceLastFromHistory(updatedMessage);
}

function handleChatRenamed(chatId, title) {
    const cached = chatMetaCache.get(chatId);
    if (cached) {
        cacheChatMeta({ ...cached, title }, { complete: chatMetaComplete.has(chatId) });
    } else {
        void getCachedChatMeta(chatId).then(meta => {
            if (meta) {
                cacheChatMeta({ ...meta, title }, { complete: true });
            }
        });
    }
    chatUI.handleChatRenamed(chatId, title);
    if (chatSearch) {
        void chatSearch.updateInIndex(chatId, title);
    }
    if (chatCore.getChatId() === chatId) {
        chatCore.miscUpdate( { title } );
        chatUI.updateChatHeader(title);
    }
}


async function sendChatToSidepanel(options) {
    // Open sidepanel (returns immediately if already open)
    await chrome.runtime.sendMessage({ type: "open_side_panel" });
    
    // Send the reconstruct message
    chrome.runtime.sendMessage({
        type: "reconstruct_chat",
        options,
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
                chatMetaCache.clear();
                chatMetaComplete.clear();
                chatUI.reloadHistoryList();
                if (importResult.success && chatSearch) {
                    await chatSearch.rebuildIndex().catch(err => console.error('Search rebuild failed:', err));
                }
            } catch (error) {
                element.textContent = "failed :(";
                console.error("Import error:", error);
            }
            setTimeout(() => { element.textContent = "import"; }, 5000);
        };
        reader.readAsText(file, 'UTF-8');
    };
    fileInput.click(); // Programmatically trigger file selection
}


const MEDIA_DEFAULT_LIMIT = 500;
const MEDIA_RENDER_CHUNK_SIZE = 12;
const MEDIA_STATE = Object.freeze({
    loading: 'loading',
    indexing: 'indexing',
    ready: 'ready',
    empty: 'empty',
    error: 'error'
});

const MEDIA_STATUS_MESSAGES = Object.freeze({
    [MEDIA_STATE.loading]: {
        title: 'Loading media…',
        subtitle: ''
    },
    [MEDIA_STATE.indexing]: {
        title: 'Indexing existing images…',
        subtitle: 'This may take a moment.'
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
        this.mediaLoadContext = null;
        this.renderToken = null;
        this.renderScheduled = false;
        this.mediaItemElements = new Map();
        this.mediaEntryMap = new Map();
        this.initialHydrateBudget = 0;
        this.mediaObserver = null;
        this.mediaObserverRoot = null;
        this.deferredForceRefresh = false;
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

    ensureMediaObserver() {
        const panel = document.getElementById('media-panel');
        const root = panel ?? null;

        if (this.mediaObserver && this.mediaObserverRoot === root) {
            return this.mediaObserver;
        }

        if (this.mediaObserver) {
            this.mediaObserver.disconnect();
        }

        this.mediaObserverRoot = root;
        this.mediaObserver = new IntersectionObserver(
            (entries) => this.handleMediaIntersection(entries),
            {
                root,
                rootMargin: '200px 0px',
                threshold: 0.1
            }
        );

        return this.mediaObserver;
    }

    handleMediaIntersection(entries) {
        for (const observerEntry of entries) {
            if (!observerEntry.isIntersecting) continue;
            const element = observerEntry.target;
            const mediaId = Number(element.dataset.entryId);
            if (!Number.isFinite(mediaId)) continue;
            const mediaEntry = this.mediaEntryMap.get(mediaId);
            if (!mediaEntry) {
                if (this.mediaObserver) {
                    this.mediaObserver.unobserve(element);
                }
                continue;
            }
            void this.hydrateMediaEntry(mediaEntry).catch(() => {});
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
            if (!this.hasAttemptedInitialLoad) {
                this.hasAttemptedInitialLoad = true;
                const shouldForce = this.deferredForceRefresh;
                if (shouldForce) this.deferredForceRefresh = false;
                runWhenIdle(() => { void this.refreshMedia({ force: shouldForce }); });
            } else if (this.deferredForceRefresh) {
                this.deferredForceRefresh = false;
                runWhenIdle(() => { void this.refreshMedia({ force: true }); });
            } else if (this.pendingRefresh) {
                runWhenIdle(() => { void this.refreshMedia({ force: true }); });
            }
        } else {
            if (chatContainer) chatContainer.style.display = 'flex';
            if (chatView) chatView.style.display = 'flex';
        }

    }

    async refreshMedia({ force = false, incremental = false } = {}) {
        if (force) {
            this.deferredForceRefresh = false;
        }

        if (incremental && this.isMediaTabActive() && this.mediaEntries.length && !force && !this.isLoading) {
            return this.refreshMediaIncremental();
        }

        if (this.isLoading && !force) return;

        const runLoad = async () => {
            this.pendingRefresh = false;
            if (this.isLoading && !force) return;
            this.isLoading = true;
            if (this.mediaLoadContext) {
                this.mediaLoadContext.aborted = true;
            }
            const loadContext = { aborted: false };
            this.mediaLoadContext = loadContext;

            const panel = document.getElementById('media-panel');
            const grid = document.getElementById('media-grid');

            if (this.mediaObserver) {
                this.mediaObserver.disconnect();
            }
            this.ensureMediaObserver();

            this.setMediaState(panel, MEDIA_STATE.loading);
            if (grid) {
                grid.replaceChildren();
            }

            const loadStart = now();

            try {
                let entries = await this.chatStorage.getAllMedia(MEDIA_DEFAULT_LIMIT, 0);

                if (entries.length === 0) {
                    const indexedCount = await this.maybeIndexExistingMedia(panel, loadContext);
                    if (indexedCount > 0) {
                        entries = await this.chatStorage.getAllMedia(MEDIA_DEFAULT_LIMIT, 0);
                    }
                }

                if (entries.some(entry => !entry.thumbnail)) {
                    await this.chatStorage.ensureMediaThumbnails(entries);
                }

                this.invalidMediaIds = new Set();
                this.mediaEntries = entries;
                this.mediaEntryMap.clear();
                entries.forEach(entry => this.mediaEntryMap.set(entry.id, entry));
                this.initialHydrateBudget = Math.min(entries.length, MEDIA_RENDER_CHUNK_SIZE * 2);
                this.syncMediaCache(entries);

                if (entries.length === 0) {
                    this.setMediaState(panel, MEDIA_STATE.empty);
                    return;
                }

                this.setMediaState(panel, MEDIA_STATE.ready);
                await this.renderMedia(loadContext);
                console.log(`Media grid loaded ${entries.length} entries in ${formatDuration(loadStart)}`);
            } catch (error) {
                this.setMediaState(panel, MEDIA_STATE.error);
                console.error('Error loading media:', error);
            } finally {
                this.isLoading = false;
                if (this.mediaLoadContext === loadContext) {
                    this.mediaLoadContext = null;
                }
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

    async refreshMediaIncremental() {
        try {
            const latest = await this.chatStorage.getAllMedia(MEDIA_DEFAULT_LIMIT, 0);
            if (!Array.isArray(latest) || latest.length === 0) return;

            const knownIds = new Set(this.mediaEntryMap.keys());
            const newEntries = latest.filter(e => !knownIds.has(e.id));
            if (!newEntries.length) return;

            if (newEntries.some(entry => !entry.thumbnail)) {
                await this.chatStorage.ensureMediaThumbnails(newEntries);
            }

            newEntries.forEach(entry => this.mediaEntryMap.set(entry.id, entry));
            const existing = this.mediaEntries.filter(entry => this.mediaEntryMap.has(entry.id) && !newEntries.some(ne => ne.id === entry.id));
            this.mediaEntries = [...newEntries, ...existing];

            const panel = document.getElementById('media-panel');
            const grid = document.getElementById('media-grid');
            if (!panel || !grid) return;

            const filtered = newEntries
                .filter(entry => this.currentFilter === 'all' || entry.source === this.currentFilter)
                .filter(entry => !this.invalidMediaIds?.has(entry.id));

            if (!filtered.length) return;

            const sorted = [...filtered].sort((a, b) => {
                if (this.currentSort === 'asc') {
                    return (a.timestamp ?? 0) - (b.timestamp ?? 0);
                }
                return (b.timestamp ?? 0) - (a.timestamp ?? 0);
            });

            this.setMediaState(panel, MEDIA_STATE.ready);
            await this.renderNewMediaEntries(sorted, grid);
        } catch (error) {
            console.error('Incremental media refresh failed:', error);
            this.pendingRefresh = true;
        }
    }

    async reindexMedia() {
        const db = await this.chatStorage.getDB();

        if (!db.objectStoreNames.contains('mediaIndex')) {
            const mediaActive = this.isMediaTabActive();
            if (mediaActive) {
                this.deferredForceRefresh = false;
                await this.refreshMedia({ force: true });
            } else {
                this.deferredForceRefresh = true;
                this.mediaEntries = [];
                this.mediaEntryMap.clear();
                this.mediaItemElements.clear();
                this.invalidMediaIds = new Set();
                this.mediaLoadContext = null;
                this.isLoading = false;
                this.pendingRefresh = false;
                if (this.mediaObserver) {
                    this.mediaObserver.disconnect();
                }
            }
            return 0;
        }

        try {
            await new Promise((resolve, reject) => {
                const tx = db.transaction(['mediaIndex'], 'readwrite');
                tx.objectStore('mediaIndex').clear();
                const fail = () => reject(tx.error || new Error('Failed to clear media index'));
                tx.oncomplete = () => resolve();
                tx.onabort = fail;
                tx.onerror = fail;
            });

            const indexedCount = await this.chatStorage.indexAllMediaFromExistingMessages();
            const mediaActive = this.isMediaTabActive();
            if (mediaActive) {
                this.deferredForceRefresh = false;
                await this.refreshMedia({ force: true });
            } else {
                this.deferredForceRefresh = true;
                this.mediaEntries = [];
                this.mediaEntryMap.clear();
                this.mediaItemElements.clear();
                this.invalidMediaIds = new Set();
                this.mediaLoadContext = null;
                this.isLoading = false;
                this.pendingRefresh = false;
                if (this.mediaObserver) {
                    this.mediaObserver.disconnect();
                }
            }
            return indexedCount;
        } catch (error) {
            if (this.isMediaTabActive()) {
                await this.refreshMedia({ force: true }).catch(() => {});
            } else {
                this.deferredForceRefresh = true;
            }
            throw error;
        }
    }

    isMediaTabActive() {
        const tab = document.querySelector('.history-tab[data-tab="media"]');
        return !!tab && tab.classList.contains('active');
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

    setFilter(filter) {
        if (this.currentFilter === filter) return;
        this.currentFilter = filter;
        document.querySelectorAll('.media-filter-btn').forEach(b => b.classList.remove('is-active', 'active'));
        const target = document.querySelector(`[data-filter="${filter}"]`);
        if (target) target.classList.add('is-active');
        this.scheduleMediaRender();
    }

    async renderMedia(loadContext = this.mediaLoadContext) {
        const panel = document.getElementById('media-panel');
        const grid = document.getElementById('media-grid');
        if (!panel || !grid) return;

        if (this.mediaObserver) {
            this.mediaObserver.disconnect();
        }
        this.ensureMediaObserver();

        const filteredEntries = this.mediaEntries
            .filter(entry => this.currentFilter === 'all' || entry.source === this.currentFilter)
            .filter(entry => !this.invalidMediaIds?.has(entry.id));

        const sortedEntries = [...filteredEntries].sort((a, b) => {
            if (this.currentSort === 'asc') {
                return (a.timestamp ?? 0) - (b.timestamp ?? 0);
            }
            return (b.timestamp ?? 0) - (a.timestamp ?? 0);
        });

        grid.replaceChildren();

        if (sortedEntries.length === 0) {
            this.setMediaState(panel, MEDIA_STATE.empty);
            return;
        }

        this.setMediaState(panel, MEDIA_STATE.ready);
        this.initialHydrateBudget = Math.min(sortedEntries.length, MEDIA_RENDER_CHUNK_SIZE * 2);
        await this.renderMediaInBatches(sortedEntries, grid, loadContext);

        if (!grid.children.length) {
            this.setMediaState(panel, MEDIA_STATE.empty);
        }
    }

    scheduleMediaRender(immediate = false) {
        const token = Symbol('media-render');
        this.renderToken = token;

        const run = async () => {
            if (this.renderToken !== token) return;
            this.renderScheduled = false;
            await this.renderMedia();
        };

        if (immediate) {
            void run();
            return;
        }

        if (this.renderScheduled) {
            return;
        }

        this.renderScheduled = true;
        runWhenIdle(() => { void run(); }, 48);
    }

    createPlaceholderLoader() {
        const loader = document.createElement('div');
        loader.className = 'media-placeholder-loader';
        loader.textContent = 'Loading...';
        return loader;
    }

    getOrCreateMediaPlaceholder(entry) {
        let element = this.mediaItemElements.get(entry.id);
        if (!element) {
            element = document.createElement('div');
            element.className = 'media-item media-placeholder';
            element.dataset.entryId = String(entry.id);
            element.dataset.hydrated = 'false';
            element.appendChild(this.createPlaceholderLoader());
            this.mediaItemElements.set(entry.id, element);
        }

        element.dataset.entryId = String(entry.id);
        if (element.dataset.hydrated === 'true') {
            return element;
        }

        if (!element.classList.contains('media-placeholder')) {
            element.classList.add('media-placeholder');
        }

        if (!element.firstChild || !element.firstChild.classList || !element.firstChild.classList.contains('media-placeholder-loader')) {
            element.replaceChildren(this.createPlaceholderLoader());
        }

        element.dataset.hydrated = 'false';
        delete element.dataset.observing;
        delete element.dataset.hydrating;
        if (entry.thumbnailWidth && entry.thumbnailHeight) {
            element.dataset.thumbWidth = String(entry.thumbnailWidth);
            element.dataset.thumbHeight = String(entry.thumbnailHeight);
        } else {
            delete element.dataset.thumbWidth;
            delete element.dataset.thumbHeight;
        }
        this.applyMediaDimensions(element, entry);
        return element;
    }

    async renderNewMediaEntries(entries, grid) {
        for (const entry of entries) {
            const element = this.getOrCreateMediaPlaceholder(entry);
            element.dataset.hydrated = 'false';
            element.classList.add('media-placeholder');
            if (entry.thumbnailWidth && entry.thumbnailHeight) {
                element.dataset.thumbWidth = String(entry.thumbnailWidth);
                element.dataset.thumbHeight = String(entry.thumbnailHeight);
            }
            this.applyMediaDimensions(element, entry);
            grid.prepend(element);
            this.scheduleMediaHydration(entry, this.mediaLoadContext);
        }
    }

    scheduleMediaHydration(entry, loadContext = null) {
        const element = this.mediaItemElements.get(entry.id);
        if (!element || element.dataset.hydrated === 'true' || element.dataset.hydrating === 'true') {
            return;
        }

        if (this.initialHydrateBudget > 0) {
            this.initialHydrateBudget -= 1;
            void this.hydrateMediaEntry(entry, loadContext).catch(() => {});
            return;
        }

        if (element.dataset.observing === 'true') {
            return;
        }

        const observer = this.ensureMediaObserver();
        element.dataset.observing = 'true';
        observer.observe(element);
    }

    async hydrateMediaEntry(entry, loadContext = null) {
        const element = this.mediaItemElements.get(entry.id);
        if (!element || element.dataset.hydrated === 'true' || element.dataset.hydrating === 'true') {
            return;
        }

        element.dataset.hydrating = 'true';

        let imageData = entry.thumbnail ?? null;

        try {
            if (entry.thumbnailWidth && entry.thumbnailHeight) {
                element.dataset.thumbWidth = String(entry.thumbnailWidth);
                element.dataset.thumbHeight = String(entry.thumbnailHeight);
            }

            if (!this.isValidImage(imageData)) {
                await this.handleInvalidMedia(entry.id, element);
                return;
            }

            const hydratedElement = this.createMediaElement(entry, imageData);
            if (!hydratedElement) return;

            hydratedElement.dataset.entryId = String(entry.id);
            hydratedElement.dataset.hydrated = 'true';

            this.mediaItemElements.set(entry.id, hydratedElement);

            this.applyMediaDimensions(hydratedElement, entry);

            if (element.parentNode) {
                element.parentNode.replaceChild(hydratedElement, element);
            }

            if (this.mediaObserver) {
                this.mediaObserver.unobserve(element);
            }

        } catch (error) {
            if (!loadContext?.aborted) {
                console.warn('Failed to hydrate media entry', error);
                const observer = this.ensureMediaObserver();
                element.dataset.observing = 'true';
                observer.observe(element);
            }
        } finally {
            delete element.dataset.hydrating;
            delete element.dataset.observing;
        }
    }

    async renderMediaInBatches(entries, grid, loadContext = null, batchSize = 24) {
        const allHydrated = entries.every(entry => {
            const element = this.mediaItemElements.get(entry.id);
            return element && element.dataset.hydrated === 'true';
        });

        if (allHydrated) {
            const fragment = document.createDocumentFragment();
            for (const entry of entries) {
                const element = this.mediaItemElements.get(entry.id);
                if (element) {
                    fragment.appendChild(element);
                }
            }
            if (fragment.childNodes.length) {
                grid.appendChild(fragment);
            }
            return;
        }

        for (let i = 0; i < entries.length; i += batchSize) {
            if (loadContext?.aborted) return;

            const batch = entries.slice(i, i + batchSize);
            const fragment = document.createDocumentFragment();

            for (const entry of batch) {
                const element = this.getOrCreateMediaPlaceholder(entry);
                fragment.appendChild(element);
                this.scheduleMediaHydration(entry, loadContext);
            }

            if (fragment.childNodes.length) {
                grid.appendChild(fragment);
            }

            await nextFrame();
        }
    }

    async maybeIndexExistingMedia(panel, loadContext) {
        this.setMediaState(panel, MEDIA_STATE.indexing);

        try {
            return await this.chatStorage.indexAllMediaFromExistingMessages();
        } catch (error) {
            if (!loadContext?.aborted) {
                console.error('Failed to index existing media:', error);
            }
            return 0;
        }
    }

    createMediaElement(entry, imageData) {
        const item = document.createElement('div');
        item.className = 'media-item';
        if (entry?.id != null) {
            item.dataset.entryId = String(entry.id);
        }
        item.dataset.hydrated = 'true';

        const content = this.createMediaContent(entry, imageData, item);
        if (!content) {
            return null;
        }
        item.appendChild(content);

        item.appendChild(this.createBadge(entry.source));

        item.addEventListener('click', () => this.handleMediaClick(entry));

        if (entry.thumbnailWidth && entry.thumbnailHeight) {
            item.dataset.thumbWidth = String(entry.thumbnailWidth);
            item.dataset.thumbHeight = String(entry.thumbnailHeight);
        }

        this.applyMediaDimensions(item, entry);

        return item;
    }

    applyMediaDimensions(element, entry) {
        if (!element) return;
        if (entry?.thumbnailWidth && entry?.thumbnailHeight) {
            const ratio = `${Math.max(entry.thumbnailWidth, 1)} / ${Math.max(entry.thumbnailHeight, 1)}`;
            element.style.aspectRatio = ratio;
        } else {
            element.style.removeProperty('aspect-ratio');
        }
    }

    createMediaContent(entry, imageData, item) {
        const img = document.createElement('img');
        img.decoding = 'async';
        img.loading = 'lazy';
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
            requestAnimationFrame(() => {
                const targetImage = this.findImageInMessage(entry);
                const fallback = document.querySelector(`[data-message-id="${entry.messageId}"]`);
                (targetImage || fallback)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
            });
        });
    }

    findImageInMessage(entry) {
        const messageElements = document.querySelectorAll(`[data-message-id="${entry.messageId}"]`);
        if (!messageElements.length) return null;

        if (entry.source === 'user') {
            const images = messageElements[0].querySelectorAll('.user-content.image-content img');
            return images[entry.imageIndex] || images[0] || null;
        }

        // For assistant images: contentIndex = which regeneration, partIndex = which image within it
        const msgElement = messageElements[entry.contentIndex] || messageElements[messageElements.length - 1];
        const images = msgElement.querySelectorAll('.assistant-content.image-content img');
        const imgIndex = entry.partIndex ?? 0;
        return images[imgIndex] || images[0] || null;
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
        this.mediaEntryMap.delete(entryId);
    }

    syncMediaCache(entries) {
        const activeIds = new Set(entries.map(entry => entry.id));

        for (const [id] of this.mediaItemElements.entries()) {
            if (!activeIds.has(id)) {
                this.mediaItemElements.delete(id);
            }
        }
    }

    toggleSort(button) {
        this.currentSort = this.currentSort === 'desc' ? 'asc' : 'desc';
        button.dataset.order = this.currentSort;
        button.textContent = this.currentSort === 'desc' ? 'Newest first' : 'Oldest first';
        button.classList.toggle('is-active', this.currentSort === 'asc');
        this.scheduleMediaRender();
    }

    async handleInvalidMedia(entryId, item = null) {
        this.markEntryInvalid(entryId);
        
        this.mediaItemElements.delete(entryId);
        
        try {
            await this.chatStorage.deleteMediaEntry(entryId);
        } catch (error) {
            console.warn('Failed to delete invalid media entry', error);
        }

        if (this.mediaObserver && item) {
            this.mediaObserver.unobserve(item);
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

const tokenizeForMiniSearch = (text) => {
    if (!text) return [];
    return text
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[\u0000-\u001f]+/g, ' ')
        .split(/\s+/)
        .map(token => token.replace(/^[^a-z0-9_\-"'=\/:.#]+|[^a-z0-9_\-"'=\/:.#]+$/g, ''))
        .filter(Boolean);
};

const MINI_SEARCH_OPTIONS = Object.freeze({
    fields: ['title', 'content'],
    storeFields: ['id'],
    tokenize: tokenizeForMiniSearch,
    searchOptions: {
        boost: { title: 2.25 },
        prefix: false,
        combineWith: 'AND'
    }
});

class ChatSearch {
    constructor(chatUI) {
        this.chatUI = chatUI;
        this.miniSearch = null;
        this.allChats = [];
        this.docIndex = new Map();
        this.lastQuery = '';
        this.lastNormalizedQuery = '';
        this.lastMatchingIds = null;
        this.initialised = false;
        this.pendingDocs = [];
        this.pendingAppends = [];
        this.searchResultsLimit = 40;
        this.searchDisplayOffset = 0;
        this.currentDisplayItems = [];
        this.handleResultsScroll = this.handleResultsScroll.bind(this);
        this.searchInput = null;
        this.clearBtn = null;
        this.defaultPlaceholder = 'Search chats...';
        this.loadingPlaceholder = 'Loading search...';
        this.initPromise = null;
        this.initializing = false;
        this.readyResolvers = [];
        this.init();
    }

    init() {
        this.searchInput = document.getElementById('history-search');
        this.clearBtn = document.getElementById('search-clear');

        if (!this.searchInput || !this.clearBtn) return;

        this.defaultPlaceholder = this.searchInput.placeholder || 'Search chats...';
        const triggerInit = () => { void this.ensureSearchInitialized(); };

        this.searchInput.addEventListener('focus', triggerInit);
        this.searchInput.addEventListener('click', triggerInit);
        this.searchInput.addEventListener('input', (e) => this.handleSearch(e.target.value));

        this.clearBtn.addEventListener('click', () => {
            this.searchInput.value = '';
            this.clearSearch();
        });
    }

    async ensureSearchInitialized() {
        if (this.initialised || this.initializing) return this.initPromise;

        const input = this.searchInput || document.getElementById('history-search');
        const previousPlaceholder = input?.placeholder || this.defaultPlaceholder;
        this.initializing = true;
        if (input) input.placeholder = this.loadingPlaceholder;

        const onReady = this.waitUntilReady().then(() => {
            if (input) input.placeholder = previousPlaceholder;
            const pendingQuery = input?.value ?? '';
            if (pendingQuery.trim() && this.miniSearch) {
                this.handleSearch(pendingQuery);
            }
        });

        this.initPromise = (async () => {
            try {
                await this.initSearch();
            } catch (error) {
                console.error('Search initialization failed:', error);
            } finally {
                this.initializing = false;
                if (input) input.placeholder = previousPlaceholder;
            }
        })();

        return Promise.race([this.initPromise, onReady]);
    }

    signalReady() {
        if (this.initialised) return;
        this.initialised = true;
        if (this.readyResolvers.length) {
            this.readyResolvers.forEach(resolver => resolver());
            this.readyResolvers = [];
        }
    }

    waitUntilReady() {
        if (this.initialised) return Promise.resolve();
        return new Promise(resolve => this.readyResolvers.push(resolve));
    }

    async initSearch() {
        if (typeof window.MiniSearch === 'undefined') {
            console.warn('MiniSearch library not loaded, search will be disabled');
            this.signalReady();
            await this.processPendingOperations();
            return;
        }
        
        await waitForIdle(0);
        const initStart = now();
        const fetchStart = initStart;        

        const [jsonStr, docsSnapshot, storedMetadata] = await Promise.all([
            chatStorage.getSearchJson(),
            chatStorage.getSearchDocs(),
            chatStorage.getSearchMetadata()
        ]);
        const fetchDuration = formatDuration(fetchStart);
        await nextFrame();
        await waitForIdle(0);

        const snapshotCount = docsSnapshot.length;
        let successfullyLoadedFromCache = false;
        let hydrateDuration = '0ms';

        this.docIndex.clear();
        this.allChats = [];

        const hydrateStart = now();
        let indexMetadata = [];
        try {
            const hydratedDocs = snapshotCount ? this.rehydrateDocuments(docsSnapshot) : [];

            if (jsonStr && Array.isArray(hydratedDocs) && hydratedDocs.length) {
                this.allChats = this.sortDocsByTimestamp(hydratedDocs);
                this.miniSearch = this.loadMiniSearch(jsonStr);
                indexMetadata = Array.isArray(storedMetadata) && storedMetadata.length ? storedMetadata : [];
                successfullyLoadedFromCache = true;
            }

            if (!successfullyLoadedFromCache && Array.isArray(hydratedDocs) && hydratedDocs.length) {
                this.allChats = this.sortDocsByTimestamp(hydratedDocs);
                this.miniSearch = this.createMiniSearch();
                this.miniSearch.addAll(this.allChats);
                successfullyLoadedFromCache = true;
            }
        } catch (error) {
            console.error('Invalid stored index, clearing and rebuilding:', error);
            this.docIndex.clear();
            this.allChats = [];
            this.miniSearch = null;
            indexMetadata = [];
        }

        hydrateDuration = formatDuration(hydrateStart);

        try {
            if (!successfullyLoadedFromCache || !this.miniSearch) {
                const rebuildStart = now();
                await this.rebuildIndex(null, initStart, { persist: false });
                const rebuildDuration = formatDuration(rebuildStart);
                this.indexStale = false;
                this.signalReady();
                await this.processPendingOperations();
                const persistStart = now();
                void Promise.all([
                    chatStorage.putSearchDocs(this.allChats),
                    this.persistIndex()
                ]).then(() => {
                    console.log(`Search index rebuilt (load=${fetchDuration}, hydrate=${hydrateDuration}, rebuild=${rebuildDuration}, persist=${formatDuration(persistStart)})`);
                }).catch((error) => {
                    console.error('Search persistence after rebuild failed:', error);
                });
                return;
            }

            const syncStart = now();
            const { changed, summary } = await this.syncIndexWithDocs(indexMetadata);
            const syncDuration = formatDuration(syncStart);

            this.signalReady();
            await this.processPendingOperations();

            if (changed) {
                const persistStart = now();
                void this.persistIndex().then(() => {
                    console.log(`Search index synchronised (${summary}) load=${fetchDuration}, hydrate=${hydrateDuration}, sync=${syncDuration}, persist=${formatDuration(persistStart)}`);
                }).catch(error => {
                    console.error('Search index persist failed after sync:', error);
                });
            } else {
                console.log(`Search loaded from storage with ${snapshotCount} chats (no changes) load=${fetchDuration}, hydrate=${hydrateDuration}, sync=${syncDuration}`);
            }
        } catch (error) {
            console.error('Search initialization failed:', error);
            throw error;
        }
    }

    createMiniSearch() {
        return new window.MiniSearch(MINI_SEARCH_OPTIONS);
    }

    loadMiniSearch(json) {
        return window.MiniSearch.loadJSON(json, MINI_SEARCH_OPTIONS);
    }

    buildIndexMetadataFromDocs(docs) {
        return docs.map(doc => ({
            id: doc.id,
            title: doc.title,
            timestamp: doc.timestamp ?? null
        }));
    }

    enqueueNewDocument(doc) {
        if (!doc) return;
        if (this.initialised && this.miniSearch) {
            void (async () => {
                try {
                    await this.insertDocument(doc);
                    if (this.pendingAppends.length) {
                        await this.processPendingAppends();
                    }
                } catch (error) {
                    console.error('Failed to insert search document:', error);
                }
            })();
        } else {
            const normalisedId = this.normaliseId(doc.id);
            const exists = this.pendingDocs.some(existing => this.normaliseId(existing.id) === normalisedId);
            if (!exists) this.pendingDocs.push(doc);
        }
    }

    enqueueAppend(update) {
        if (!update || !update.delta || !update.delta.trim()) return;
        const payload = {
            chatId: this.normaliseId(update.chatId),
            delta: update.delta.trim(),
            timestamp: update.timestamp ?? null
        };
        if (typeof payload.timestamp !== 'number') {
            payload.timestamp = null;
        }
        if (this.initialised && this.miniSearch) {
            void (async () => {
                try {
                    await this.applyAppendDelta(payload);
                } catch (error) {
                    console.error('Failed to apply search delta:', error);
                }
            })();
        } else {
            const exists = this.pendingAppends.some(item =>
                item.chatId === payload.chatId &&
                item.delta === payload.delta &&
                item.timestamp === payload.timestamp
            );
            if (!exists) this.pendingAppends.push(payload);
        }
    }

    async processPendingOperations() {
        if (!this.miniSearch) return;
        const processedDocs = await this.processPendingDocs();
        const processedAppends = await this.processPendingAppends();
        if (processedDocs && this.pendingAppends.length) {
            await this.processPendingAppends();
        } else if (!processedDocs && !processedAppends && this.pendingAppends.length > 0) {
            // If append updates are waiting for corresponding docs, leave them queued.
        }
    }

    async processPendingDocs() {
        if (!this.pendingDocs.length || !this.miniSearch) return false;
        let processed = false;
        while (this.pendingDocs.length) {
            const doc = this.pendingDocs.shift();
            if (!doc) continue;
            processed = (await this.insertDocument(doc)) || processed;
        }
        return processed;
    }

    async processPendingAppends() {
        if (!this.pendingAppends.length || !this.miniSearch) return false;
        let applied = false;
        const remaining = [];
        while (this.pendingAppends.length) {
            const update = this.pendingAppends.shift();
            if (!update) continue;
            const doc = this.docIndex.get(update.chatId);
            if (!doc) {
                remaining.push(update);
                continue;
            }
            await this.applyAppendDelta(update);
            applied = true;
        }
        this.pendingAppends = remaining;
        return applied;
    }

    async insertDocument(rawDoc) {
        if (!rawDoc) return;

        const id = this.normaliseId(rawDoc.id);
        const prepared = this.decorateDocument({
            id,
            title: rawDoc.title ?? '',
            content: rawDoc.content ?? '',
            timestamp: (typeof rawDoc.timestamp === 'number')
                ? rawDoc.timestamp
                : (Number(rawDoc.timestamp) || null)
        });

        const existing = this.docIndex.get(id);
        if (existing) {
            if (this.isDocumentIndexed(id)) {
                try {
                    if (typeof this.miniSearch.discard === 'function') {
                        this.miniSearch.discard(id);
                    } else {
                        this.miniSearch.remove(existing);
                    }
                } catch (error) {
                    console.warn('Search removal failed during insert, scheduling rebuild:', error);
                    this.indexStale = true;
                }
            }
            this.removeFromAllChats(id);
        }

        this.ensureDocumentIndexed(prepared);
        this.docIndex.set(id, prepared);
        this.insertIntoAllChats(prepared);
        this.resetQueryCache();
    }

    async applyAppendDelta(update) {
        if (!update || !update.delta) return;
        const doc = this.docIndex.get(update.chatId);
        if (!doc) {
            const exists = this.pendingAppends.some(item =>
                item.chatId === update.chatId &&
                item.delta === update.delta &&
                item.timestamp === update.timestamp
            );
            if (!exists) this.pendingAppends.push(update);
            return;
        }

        const trimmed = update.delta.trim();
        if (!trimmed) return;

        if (update.timestamp != null) {
            doc.timestamp = update.timestamp;
        }

        if (typeof doc.searchTitle !== 'string') {
            doc.searchTitle = this.normaliseForSearch(doc.title || '');
        }

        const normalisedDelta = this.normaliseForSearch(trimmed);
        if (normalisedDelta) {
            const base = typeof doc.content === 'string' ? doc.content : '';
            doc.content = base ? `${base} ${normalisedDelta}`.trim() : normalisedDelta;
            doc._normalized = true;
        } else if (typeof doc.content !== 'string') {
            doc.content = this.normaliseForSearch('');
            doc._normalized = true;
        }

        this.replaceDocumentInIndex(doc);
        if (update.timestamp != null) {
            this.insertIntoAllChats(doc);
        }
        this.resetQueryCache();
    }

    normaliseId(rawId) {
        const idString = `${rawId}`;
        return idString.match(/^\d+$/) ? Number(idString) : rawId;
    }

    normaliseForSearch(input, { collapseWhitespace = true } = {}) {
        if (!input) return '';

        const normalized = input
            .toLowerCase()
            .normalize('NFKD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/[\u0000-\u001f]+/g, ' ');

        if (!collapseWhitespace) {
            return normalized.trim();
        }

        return normalized
            .replace(/\s+/g, ' ')
            .trim();
    }

    decorateDocument(doc) {
        if (!doc) return doc;

        doc.searchTitle = this.normaliseForSearch(doc.title || '');

        if (doc._normalized !== true) {
            doc.content = this.normaliseForSearch(doc.content || '');
            doc._normalized = true;
        }

        return doc;
    }

    ensureDocumentSearchText(doc) {
        if (!doc) return '';
        if (typeof doc.searchTitle !== 'string' ||
            typeof doc.content !== 'string') {
            this.decorateDocument(doc);
        }
        return doc;
    }

    documentContainsQuery(doc, normalisedQuery) {
        if (!doc || !normalisedQuery) return false;
        const decorated = this.ensureDocumentSearchText(doc);
        return (
            (decorated.searchTitle && decorated.searchTitle.includes(normalisedQuery)) ||
            (decorated.content && decorated.content.includes(normalisedQuery))
        );
    }

    resetQueryCache() {
        this.lastQuery = '';
        this.lastNormalizedQuery = '';
        this.lastMatchingIds = null;
    }

    getTimestampValue(doc) {
        const value = Number(doc?.timestamp ?? 0);
        return Number.isFinite(value) ? value : 0;
    }

    findAllChatsIndex(id) {
        if (!Array.isArray(this.allChats)) return -1;
        return this.allChats.findIndex(doc => doc?.id === id);
    }

    removeFromAllChats(id) {
        const index = this.findAllChatsIndex(id);
        if (index === -1) return false;
        this.allChats.splice(index, 1);
        return true;
    }

    findInsertPositionByTimestamp(doc) {
        if (!Array.isArray(this.allChats) || this.allChats.length === 0) return 0;
        const target = this.getTimestampValue(doc);
        let low = 0;
        let high = this.allChats.length;

        while (low < high) {
            const mid = Math.floor((low + high) / 2);
            const midValue = this.getTimestampValue(this.allChats[mid]);
            if (midValue > target) {
                low = mid + 1;
            } else {
                high = mid;
            }
        }

        return low;
    }

    insertIntoAllChats(doc) {
        if (!Array.isArray(this.allChats)) {
            this.allChats = doc ? [doc] : [];
            return;
        }

        if (!doc) return;

        const existingIndex = this.findAllChatsIndex(doc.id);
        if (existingIndex !== -1) {
            this.allChats.splice(existingIndex, 1);
        }

        const position = this.findInsertPositionByTimestamp(doc);
        this.allChats.splice(position, 0, doc);
    }

    sortDocsByTimestamp(docs = []) {
        docs.sort((a, b) => this.getTimestampValue(b) - this.getTimestampValue(a));
        return docs;
    }

    isDocumentIndexed(id) {
        if (!this.miniSearch) return false;
        const targetId = this.normaliseId(id);

        if (typeof this.miniSearch.has === 'function') {
            try {
                return this.miniSearch.has(targetId);
            } catch (error) {
                // ignore and fall back to internal map
            }
        }

        const docIds = this.miniSearch._documentIds;
        if (docIds instanceof Map) {
            return docIds.has(targetId);
        }

        if (docIds && typeof docIds === 'object') {
            return Boolean(docIds[targetId]);
        }

        return false;
    }

    ensureDocumentIndexed(doc) {
        if (!this.miniSearch || !doc || doc.id == null) return false;
        const prepared = this.ensureDocumentSearchText(doc);
        const id = this.normaliseId(prepared.id);
        if (this.isDocumentIndexed(id)) return false;

        try {
            this.miniSearch.add(prepared);
            return true;
        } catch (error) {
            console.warn('Search add failed, scheduling rebuild:', error);
            this.indexStale = true;
            return false;
        }
    }

    replaceDocumentInIndex(doc) {
        if (!this.miniSearch || !doc || doc.id == null) return false;
        const prepared = this.ensureDocumentSearchText(doc);
        const id = this.normaliseId(prepared.id);

        if (!this.isDocumentIndexed(id)) {
            return this.ensureDocumentIndexed(prepared);
        }

        try {
            this.miniSearch.replace(prepared);
            return true;
        } catch (error) {
            console.warn('Search replace failed, re-indexing:', error);
            this.indexStale = true;
            return this.ensureDocumentIndexed(prepared);
        }
    }

    rehydrateDocuments(storedDocsSnapshot) {
        if (!Array.isArray(storedDocsSnapshot) || storedDocsSnapshot.length === 0) {
            console.warn('Stored search documents missing, rebuilding index');
            return null;
        }

        // Trust the stored format - it's already correct. Avoid creating new objects.
        // Just normalize IDs in-place and populate the index.
        for (const doc of storedDocsSnapshot) {
            const id = this.normaliseId(doc.id);
            doc.id = id;
            doc._normalized = true;
            this.docIndex.set(id, doc);
        }
        
        return storedDocsSnapshot;
    }

    async rebuildIndex(metadata = null, startOverride = null, { persist = true } = {}) {
        const buildStart = startOverride ?? now();
        const metaList = metadata || await chatStorage.getChatMetadata(Infinity, 0);

        const documents = await Promise.all(metaList.map(async meta => {
            const chat = await chatStorage.loadChat(meta.chatId);
            const document = {
                id: this.normaliseId(meta.chatId),
                title: meta.title ?? '',
                content: ChatStorage.extractTextFromMessages(chat?.messages),
                timestamp: meta.timestamp ?? null
            };
            return this.decorateDocument(document);
        }));

        this.allChats = this.sortDocsByTimestamp(documents);
        this.docIndex.clear();
        this.allChats.forEach(doc => this.docIndex.set(doc.id, doc));

        this.miniSearch = this.createMiniSearch();
        this.miniSearch.addAll(this.allChats);

        if (persist) {
            await chatStorage.putSearchDocs(this.allChats);
            await this.persistIndex();
        }

        console.log(`Search built with ${this.allChats.length} chats in ${formatDuration(buildStart)}`);
    }

    async removeFromIndex(chatId) {
        if (!this.miniSearch) return;
        const normalisedId = this.normaliseId(chatId);
        this.pendingDocs = this.pendingDocs.filter(doc => this.normaliseId(doc?.id) !== normalisedId);
        this.pendingAppends = this.pendingAppends.filter(update => update?.chatId !== normalisedId);
        const doc = this.docIndex.get(normalisedId);
        if (!doc) return;

        const isIndexed = this.isDocumentIndexed(normalisedId);
        let removed = false;
        if (isIndexed) {
            try {
                if (typeof this.miniSearch.discard === 'function') {
                    this.miniSearch.discard(normalisedId);
                } else {
                    this.miniSearch.remove(doc);
                }
                removed = true;
            } catch (error) {
                console.warn('Search index removal failed; marking index stale:', error);
            }
        }

        this.docIndex.delete(normalisedId);
        this.allChats = this.allChats.filter(d => d.id !== normalisedId);
        this.resetQueryCache();
        await chatStorage.deleteSearchDoc(normalisedId);

        if (!removed) {
            this.indexStale = true;
        }
    }

    async updateInIndex(chatId, newTitle) {
        if (!this.miniSearch) return;
        const doc = this.docIndex.get(chatId);
        if (!doc) return;

        doc.title = newTitle;
        this.decorateDocument(doc);
        this.replaceDocumentInIndex(doc);
        this.allChats = this.sortDocsByTimestamp(Array.from(this.docIndex.values()));
        this.resetQueryCache();
    }

    async persistIndex(force = false) {
        if (!this.miniSearch && !force) return;
        const jsonStr = JSON.stringify(this.miniSearch ? this.miniSearch.toJSON() : {});
        const metadata = this.buildIndexMetadataFromDocs(this.allChats);
        await chatStorage.setSearchIndex(jsonStr, this.allChats.length, metadata);
    }

    async syncIndexWithDocs(indexMetadata = []) {
        const snapshot = new Map(indexMetadata.map(entry => [entry.id, entry]));
        let added = 0;
        let updated = 0;
        let removed = 0;

        for (const [id, doc] of this.docIndex.entries()) {
            const meta = snapshot.get(id);
            if (!meta) {
                this.ensureDocumentIndexed(doc);
                this.insertIntoAllChats(doc);
                added++;
                continue;
            }

            snapshot.delete(id);

            if (meta.title !== doc.title || meta.timestamp !== doc.timestamp) {
                this.replaceDocumentInIndex(doc);
                this.insertIntoAllChats(doc);
                updated++;
            }
        }

        for (const [id] of snapshot) {
            try {
                if (typeof this.miniSearch.discard === 'function') {
                    this.miniSearch.discard(id);
                } else {
                    const stored = snapshot.get(id);
                    if (stored) {
                        this.miniSearch.remove(stored);
                    }
                }
                removed++;
            } catch (error) {
                this.indexStale = true;
                console.warn('Search removal failed during sync, scheduling rebuild:', error);
            }
        }

        if (added || updated || removed) {
            this.resetQueryCache();
        }
        return {
            changed: Boolean(added || updated || removed),
            summary: `${added} added, ${updated} updated, ${removed} removed`
        };
    }

    handleSearch(query) {
        const clearBtn = document.getElementById('search-clear');
        const trimmed = query.trim();

        if (!trimmed) {
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
            const hasTrailingSpace = /\s$/.test(query);
            const normalisedQuery = this.normaliseForSearch(trimmed);
            const needsLiteralCheck = /[^a-z0-9]/i.test(trimmed);
            const cacheKey = `${normalisedQuery}__${hasTrailingSpace ? '1' : '0'}`;

            let finalIds;

            if (this.lastQuery === cacheKey && Array.isArray(this.lastMatchingIds)) {
                finalIds = this.lastMatchingIds;
            } else {
                const miniSearchResults = this.miniSearch.search(trimmed, {
                    prefix: !hasTrailingSpace,
                    combineWith: 'AND'
                });

                const exactMatches = [];
                const partialMatches = [];
                const seen = new Set();

                for (const result of miniSearchResults) {
                    const normalisedId = this.normaliseId(result.id);
                    if (seen.has(normalisedId)) continue;
                    const doc = this.docIndex.get(normalisedId);
                    if (!doc) continue;
                    seen.add(normalisedId);
                    if (needsLiteralCheck && normalisedQuery && this.documentContainsQuery(doc, normalisedQuery)) {
                        exactMatches.push(normalisedId);
                    } else {
                        partialMatches.push(normalisedId);
                    }
                }

                if (needsLiteralCheck && exactMatches.length > 0) {
                    finalIds = exactMatches.concat(partialMatches);
                } else {
                    finalIds = partialMatches;
                }

                this.lastMatchingIds = finalIds;
                this.lastQuery = cacheKey;
                this.lastNormalizedQuery = normalisedQuery;
            }

            this.currentDisplayItems = this.buildSearchResults(finalIds);
            this.searchDisplayOffset = 0;
            this.renderNextSearchBatch(true);

            const highlightAllowed = trimmed.length >= 3;
            this.chatUI.setSearchHighlight({
                rawQuery: trimmed,
                resultIds: finalIds,
                normalizedQuery: normalisedQuery,
                highlightAllowed
            });
        } catch (error) {
            console.error('Search error:', error);
        }
    }

    buildSearchResults(resultIds) {
        return resultIds
            .map(id => ({
                id,
                doc: this.docIndex.get(id)
            }))
            .filter(result => !!result.doc);
    }

    renderNextSearchBatch(reset = false) {
        if (reset) {
            this.chatUI.exitSearchMode();
            this.chatUI.paginator.reset({ mode: 'search' });
            this.chatUI.startSearchMode();
            this.searchDisplayOffset = 0;
            this.chatUI.updateSearchCounter(this.currentDisplayItems.length, 0);
            this.attachSearchScrollListener();
        }

        const slice = this.currentDisplayItems.slice(
            this.searchDisplayOffset,
            this.searchDisplayOffset + this.searchResultsLimit
        );

        const reachedEnd = slice.length === 0;

        if (reset && reachedEnd) {
            this.chatUI.renderSearchResults([]);
            this.chatUI.updateSearchCounter(0, 0);
            this.detachSearchScrollListener();
            this.chatUI.paginator.reset({ mode: 'search' });
            return;
        }

        if (reachedEnd) {
            this.detachSearchScrollListener();
            this.chatUI.paginator.reset({ mode: 'search' });
            return;
        }

        this.searchDisplayOffset += slice.length;

        this.chatUI.renderSearchResults(slice, {
            totalCount: this.currentDisplayItems.length,
            append: !reset,
            showCounter: true
        });

        if (this.searchDisplayOffset >= this.currentDisplayItems.length) {
            this.detachSearchScrollListener();
            this.chatUI.paginator.reset({ mode: 'search' });
        }
    }

    attachSearchScrollListener() {
        const container = this.chatUI.getSearchContainer();
        if (!container) return;
        container.removeEventListener('scroll', this.handleResultsScroll);
        container.addEventListener('scroll', this.handleResultsScroll);
    }

    detachSearchScrollListener() {
        const container = this.chatUI.getSearchContainer();
        if (!container) return;
        container.removeEventListener('scroll', this.handleResultsScroll);
    }

    handleResultsScroll() {
        const container = this.chatUI.getSearchContainer();
        if (!container || this.currentDisplayItems.length === 0) return;

        const { scrollTop, scrollHeight, clientHeight } = container;
        const nearBottom = scrollHeight - (scrollTop + clientHeight) < 100;

        if (nearBottom) {
            this.renderNextSearchBatch();
        }
    }

    clearSearch() {
        const historyList = document.querySelector('.history-list');
        const allItems = historyList.querySelectorAll('.history-sidebar-item');
        const allDividers = historyList.querySelectorAll('.history-divider');

        const noResultsMsg = historyList.querySelector('.search-no-results');
        if (noResultsMsg) noResultsMsg.remove();

        this.currentDisplayItems = [];
        this.searchDisplayOffset = 0;
        this.chatUI.renderSearchResults([]);
        this.chatUI.exitSearchMode();
        this.chatUI.setSearchHighlight(null);

        allItems.forEach(item => {
            item.classList.remove('search-hidden');
        });

        allDividers.forEach(divider => divider.classList.remove('search-hidden'));

        document.getElementById('search-clear').style.display = 'none';
        this.resetQueryCache();
    }

    async reindex() {
        await this.rebuildIndex();
    }
}

let mediaTab;
let chatSearch;

document.addEventListener('DOMContentLoaded', () => {
    initMessageListeners();
    document.getElementById('auto-rename').onclick = autoRenameUnmodified;
    document.getElementById('export').onclick = (e) => initiateChatBackupDownload(e.target);
    document.getElementById('import').onclick = (e) => initiateChatBackupImport(e.target);

    mediaTab = new MediaTab(chatStorage, chatUI);
    chatSearch = new ChatSearch(chatUI);
});
