import { ChatStorage } from './chat_storage.js';
import { HistoryChatUI, runAfterSuccessfulBuild } from './chat_ui.js';
import { HistoryStateManager } from './state_manager.js';
import { RenameManager } from './rename_manager.js';
import { ChatCore } from './chat_core.js';
import { normaliseForSearch } from './search_utils.js';
import { copyChatMarkdownToClipboard, saveChatMarkdownToFile } from './markdown_export.js';
import { runHistoryMarkdownAction } from './history_markdown_action.js';
import { attachHistoryPopupEscape, attachHistoryPopupTrigger, focusHistoryPopupTrigger } from './history_popup_trigger.js';
import { openSidePanelWithHandoff } from './sidepanel_handoff.js';
import {
    createLiveChatRequest,
    fetchAndApplyAppendedMessages,
    fetchAndApplyMessageUpdate,
    handlePersistedAppend,
    ownsLiveChatRequest
} from './history_live_updates.js';

/**
 * timing and duration formatting helpers.
 */
const now = () => (typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now());

const formatDuration = (start, end = now()) => {
    const duration = end - start;
    return duration >= 1000
        ? `${(duration / 1000).toFixed(2)}s`
        : `${duration.toFixed(1)}ms`;
};

/**
 * background task and frame helpers.
 */
const runWhenIdle = (callback, timeout = 250) => {
    if (typeof window !== 'undefined' && window.requestIdleCallback) {
        return window.requestIdleCallback(callback, { timeout });
    }
    return setTimeout(() => callback({ didTimeout: true, timeRemaining: () => 0 }), timeout);
};

const waitForIdle = (timeout = 0) => new Promise(resolve => runWhenIdle(resolve, timeout));

const nextFrame = () => new Promise(resolve => {
    if (typeof window !== 'undefined' && window.requestAnimationFrame) {
        window.requestAnimationFrame(() => resolve());
    } else {
        setTimeout(resolve, 16);
    }
});

/**
 * Manages the context menu for history items.
 */
class PopupMenu {
    constructor(renameManager, chatStorage) {
        Object.assign(this, { renameManager, chatStorage, activePopup: null, chatUI: null });
        this.init();
    }

    init() {
        this.popup = document.querySelector('.popup-menu');
        this.initRenameLogic();
        document.addEventListener('click', () => this.hide(false));
        this.popup.addEventListener('click', (event) => this.handleAction(event));
        attachHistoryPopupEscape(this.popup, () => this.hide());
    }

    initRenameLogic() {
        const renameInput = this.popup.querySelector('.rename-input');
        this.popup.querySelector('.rename-confirm').onclick = (event) => { 
            event.stopPropagation(); 
            this.confirmRename(); 
        };
        this.popup.querySelector('.rename-cancel').onclick = (event) => { 
            event.stopPropagation(); 
            this.restore();
            this.popup.querySelector('[data-action="rename"]').focus();
        };
        
        renameInput.onkeydown = (event) => {
            if (event.key === 'Enter' && !event.shiftKey) { 
                event.preventDefault(); 
                this.confirmRename(); 
            } else if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                this.hide(); 
            }
        };
    }

    attachToItem(historyItem) {
        attachHistoryPopupTrigger(historyItem.querySelector('.action-dots'), {
            isOpen: () => this.activePopup === historyItem,
            open: () => this.show(historyItem),
            close: () => this.hide(),
            focusTarget: () => this.popup.querySelector('.popup-action')
        });
    }

    show(historyItem) {
        this.restore();
        const itemRect = historyItem.getBoundingClientRect();
        this.popup.classList.add('active');
        const popupRect = this.popup.getBoundingClientRect();
        const gap = 5;
        const margin = 5;
        const right = itemRect.right + gap;
        const left = right + popupRect.width <= window.innerWidth - margin
            ? right
            : Math.max(margin, itemRect.left - popupRect.width - gap);
        const top = Math.min(
            Math.max(margin, itemRect.top),
            Math.max(margin, window.innerHeight - popupRect.height - margin)
        );
        Object.assign(this.popup.style, { top: `${top}px`, left: `${left}px` });
        this.activePopup = historyItem;
    }

    handleAction(event) {
        event.stopPropagation();
        const actionType = event.target.dataset.action;
        if (!actionType) return;

        switch (actionType) {
            case 'rename': 
                this.showRenameInput(); 
                break;
            case 'delete': 
                this.handleDelete(event.target); 
                break;
            case 'auto-rename': 
                this.handleAutoRename(); 
                break;
            case 'copy-markdown':
                this.handleCopyMarkdown(event.target);
                break;
            case 'save-markdown':
                this.handleSaveMarkdown(event.target);
                break;
        }
    }

    showRenameInput() {
        ['rename', 'delete', 'auto-rename', 'copy-markdown', 'save-markdown'].forEach(action => {
            const actionButton = this.popup.querySelector(`[data-action="${action}"]`);
            if (actionButton) {
                actionButton.style.display = 'none';
            }
        });
        this.popup.querySelector('.rename-input-wrapper').style.display = 'flex';
        const renameInput = this.popup.querySelector('.rename-input');
        renameInput.value = this.activePopup.querySelector('.item-text').textContent;
        renameInput.focus();
    }

    restore() {
        this.copyRequest = null;
        this.saveRequest = null;
        ['rename', 'delete', 'auto-rename', 'copy-markdown', 'save-markdown'].forEach(action => {
            const actionButton = this.popup.querySelector(`[data-action="${action}"]`);
            if (actionButton) {
                actionButton.style.display = 'block';
            }
        });
        this.popup.querySelector('.rename-input-wrapper').style.display = 'none';
        const deleteButton = this.popup.querySelector('[data-action="delete"]');
        if (deleteButton) { 
            deleteButton.classList.remove('delete-confirm'); 
            deleteButton.textContent = 'Delete'; 
        }
        const copyButton = this.popup.querySelector('[data-action="copy-markdown"]');
        if (copyButton) copyButton.textContent = 'Copy Markdown';
        const saveButton = this.popup.querySelector('[data-action="save-markdown"]');
        if (saveButton) saveButton.textContent = 'Save Markdown';
    }

    hide(restoreFocus = true) {
        const historyItem = this.activePopup;
        this.restore(); 
        this.popup.classList.remove('active'); 
        this.activePopup = null;
        if (restoreFocus) focusHistoryPopupTrigger(historyItem);
    }

    confirmRename() {
        const renameInput = this.popup.querySelector('.rename-input');
        const newTitle = renameInput.value.trim();
        if (newTitle) {
            const chatId = parseInt(this.activePopup.id, 10);
            this.activePopup.querySelector('.item-text').textContent = newTitle;
            if (chatCore.getChatId() === chatId) {
                const headerTitle = this.chatUI?.autoUpdateHeader?.(chatId);
                chatCore.miscUpdate({ title: headerTitle || newTitle });
            }
            const cachedMeta = chatMetaCache.get(chatId);
            if (cachedMeta) {
                cacheMeta({ ...cachedMeta, title: newTitle, renamed: true }, chatMetaComplete.has(chatId));
            }
            chatSearch?.updateInIndex(chatId, newTitle);
            this.chatStorage.renameChat(chatId, newTitle).catch(error => {
                console.error('Failed to rename chat:', error);
            });
        }
        this.hide();
    }

    handleDelete(deleteButton) {
        if (!deleteButton.classList.contains('delete-confirm')) {
            deleteButton.classList.add('delete-confirm');
            deleteButton.textContent = 'Sure?';
            return;
        }
        const chatId = parseInt(this.activePopup.id, 10);
        this.chatUI.handleItemDeletion(this.activePopup);
        chatMetaCache.delete(chatId);
        chatMetaComplete.delete(chatId);
        this.chatStorage.deleteChat(chatId).then(() => {
            chatSearch?.removeFromIndex(chatId);
        });
        if (chatCore.getChatId() === chatId) { 
            chatCore.reset(); 
            this.chatUI.clearConversation(); 
        }
        this.hide();
    }

    async handleAutoRename() {
        const chatId = parseInt(this.activePopup.id, 10);
        const textSpan = this.activePopup.querySelector('.item-text');
        const renameResult = await this.renameManager.renameSingleChat(chatId, textSpan);
        if (renameResult?.tokenCounter) {
            renameResult.tokenCounter.updateLifetimeTokens();
            if (chatCore.getChatId() === chatId) {
                const headerTitle = this.chatUI?.autoUpdateHeader?.(chatId);
                chatCore.miscUpdate({ title: headerTitle || textSpan.textContent });
            }
        }
        this.hide();
    }

    async handleCopyMarkdown(item) {
        const historyItem = this.activePopup;
        const request = {};
        this.copyRequest = request;
        const chatId = parseInt(historyItem.id, 10);
        const isCurrent = () => this.copyRequest === request && this.activePopup === historyItem;
        await runHistoryMarkdownAction({
            button: item,
            pendingText: 'copying...',
            successText: 'copied!',
            operation: () => copyChatMarkdownToClipboard(this.chatStorage, chatId, isCurrent),
            isCurrent,
            onError: error => console.error('Markdown copy failed:', error),
            scheduleClose: () => setTimeout(() => {
                if (isCurrent()) this.hide();
            }, 1500)
        });
    }

    async handleSaveMarkdown(item) {
        const historyItem = this.activePopup;
        const request = {};
        this.saveRequest = request;
        const chatId = parseInt(historyItem.id, 10);
        const isCurrent = () => this.saveRequest === request && this.activePopup === historyItem;
        await runHistoryMarkdownAction({
            button: item,
            pendingText: 'saving...',
            successText: 'saved!',
            operation: () => saveChatMarkdownToFile(this.chatStorage, chatId, isCurrent),
            isCurrent,
            onError: error => console.error('Markdown save failed:', error),
            scheduleClose: () => setTimeout(() => {
                if (isCurrent()) this.hide();
            }, 1500)
        });
    }
}

/**
 * Cache and Manager instances.
 */
const chatMetaCache = new Map();
const chatMetaComplete = new Set();
const chatStorage = new ChatStorage();
const chatCore = new ChatCore(chatStorage);
const renameManager = new RenameManager(chatStorage, { timeoutMs: 30000 });
const stateManager = new HistoryStateManager();

const cacheMeta = (meta, complete = false) => {
    if (!meta || meta.chatId == null) return meta;
    const existing = chatMetaCache.get(meta.chatId);
    const merged = existing ? { ...existing, ...meta } : meta;
    chatMetaCache.set(meta.chatId, merged);
    if (complete) chatMetaComplete.add(meta.chatId);
    return merged;
};

const getCachedMeta = async (id) => {
    if (chatMetaCache.has(id) && chatMetaComplete.has(id)) return chatMetaCache.get(id);
    const meta = await chatStorage.getChatMetadataById(id);
    return meta ? cacheMeta(meta, true) : chatMetaCache.get(id) || null;
};

const popupMenu = new PopupMenu(renameManager, chatStorage);

const chatUI = new HistoryChatUI({
    stateManager,
    continueFunc: (index, subIndex, modelChoice) => openSidePanelWithHandoff({
        type: "reconstruct_chat",
        options: { chatId: chatCore.getChatId(), index, secondaryIndex: subIndex, modelChoice }
    }),
    loadHistoryItems: async (limit, offset) => {
        const items = await chatStorage.getChatMetadata(limit, offset);
        items.forEach(item => cacheMeta(item));
        return items;
    },
    addPopupActions: (item) => popupMenu.attachToItem(item),
    loadChat: (id) => chatStorage.loadChat(id),
    activateChat: (chat) => chatCore.setChat(chat),
    getChatMeta: getCachedMeta,
});
popupMenu.chatUI = chatUI;

let liveUpdateQueue = Promise.resolve();
const liveMessageTimestamps = new Map();

const queueLiveUpdate = (operation) => {
    liveUpdateQueue = liveUpdateQueue
        .then(() => operation())
        .catch(error => console.error('Live history update failed:', error));
    return liveUpdateQueue;
};

const getLiveMessageTimestamp = (explicitTimestamp = null, message = null) => {
    const numeric = Number(explicitTimestamp ?? message?.timestamp ?? null);
    return Number.isFinite(numeric) ? numeric : null;
};

const shouldApplyLiveMessage = (chatId, messageId, timestamp = null) => {
    if (timestamp == null) return true;
    const key = `${chatId}:${messageId}`;
    const latestTimestamp = liveMessageTimestamps.get(key);
    if (latestTimestamp != null && timestamp < latestTimestamp) {
        return false;
    }
    liveMessageTimestamps.set(key, timestamp);
    return true;
};

function initMessageListeners() {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message.type === 'new_chat_saved') {
            cacheMeta(message.chat, true);
            chatUI.handleNewChatSaved(message.chat);
            if (chatCore.getChatId() === null) {
                chatUI.buildChat(message.chat.chatId);
            }
            if (message.searchDoc) {
                chatSearch?.enqueueNewDocument(message.searchDoc);
            }
        } else if (message.type === 'appended_messages_to_saved_chat') {
            void queueLiveUpdate(() => handleAppended(message.chatId, message.addedCount, message.startIndex, message.searchDelta, message.timestamp));
        } else if (message.type === 'message_updated') {
            void queueLiveUpdate(() => handleUpdate(message.chatId, message.messageId, message.timestamp, message.message));
        } else if (message.type === 'chat_renamed') {
            handleRenamed(message.chatId, message.title);
        } else if (message.type === 'history_reindex') {
            Promise.all([chatSearch?.reindex(), mediaTab?.reindexMedia()])
                .then(() => sendResponse({ ok: true }))
                .catch(error => sendResponse({ ok: false, error: error?.message || 'Reindex failed' }));
            return true;
        } else if (message.type === 'history_repair_images') {
            chatStorage.repairAllBlobs()
                .then(repairedCount => {
                    if (mediaTab && repairedCount > 0) {
                        mediaTab.refreshMedia({ force: true });
                    }
                    sendResponse({ ok: true, repaired: repairedCount });
                })
                .catch(error => sendResponse({ ok: false, error: error?.message || 'Repair failed' }));
            return true;
        } else if (message.type === 'repair_blob_from_data_url') {
            chatStorage.repairBlobByDataUrl(message.dataUrl)
                .then(result => sendResponse({ ok: result.repaired, dataUrl: result.dataUrl }))
                .catch(error => sendResponse({ ok: false, error: error?.message || 'Blob repair failed' }));
            return true;
        }
    });
}

async function handleAppended(chatId, addedCount, startIndex, searchDelta = null, timestamp = null) {
    const request = createLiveChatRequest(chatId, () => chatCore.getChat(), () => chatUI.activeId);
    return handlePersistedAppend({
        request,
        getChat: () => chatCore.getChat(),
        getActiveChatId: () => chatUI.activeId,
        refreshHistory: () => handleHistoryRefresh(chatId, timestamp ? { timestamp } : {}),
        updateSearch: () => {
            if (searchDelta) chatSearch?.enqueueAppend({ chatId, delta: searchDelta, timestamp });
        },
        invalidateMedia: () => {
            if (!mediaTab) return;
            mediaTab.invalidate();
            if (mediaTab.isMediaTabActive()) {
                runWhenIdle(() => mediaTab.refreshMedia({ incremental: true }));
            }
        },
        applyActiveAppend: ownedRequest => applyAppendedMessages(ownedRequest, addedCount, startIndex)
    });
}

async function handleUpdate(chatId, messageId, timestamp = null, messageData = null) {
    const request = createLiveChatRequest(chatId, () => chatCore.getChat(), () => chatUI.activeId);
    if (!request) return false;
    return fetchAndApplyMessageUpdate({
        request,
        messageId,
        messageData,
        getChat: () => chatCore.getChat(),
        getActiveChatId: () => chatUI.activeId,
        getMessage: (id, index) => chatStorage.getMessage(id, index),
        acceptMessage: message => {
            const effectiveTimestamp = getLiveMessageTimestamp(timestamp, message);
            return shouldApplyLiveMessage(chatId, messageId, effectiveTimestamp);
        },
        beforeRefresh: () => {
            if (mediaTab) mediaTab.invalidate();
        },
        refreshHistory: message => {
            const effectiveTimestamp = getLiveMessageTimestamp(timestamp, message);
            return handleHistoryRefresh(chatId, { timestamp: effectiveTimestamp || Date.now() });
        },
        applyMissingRange: async (ownedRequest, range, message) => {
            const effectiveTimestamp = getLiveMessageTimestamp(timestamp, message);
            await handleHistoryRefresh(chatId, { timestamp: effectiveTimestamp || Date.now() });
            if (!ownsLiveChatRequest(ownedRequest, () => chatCore.getChat(), () => chatUI.activeId)) return false;
            return applyAppendedMessages(ownedRequest, range.count, range.startIndex);
        },
        applyUI: (message, index, id) => chatUI.applyMessageUpdate(message, index, id),
        applyCore: (message, index) => {
            chatCore.miscUpdate({ messages: chatCore.currentChat.messages.map((item, itemIndex) => itemIndex === index ? message : item) });
        }
    });
}

function applyAppendedMessages(request, addedCount, startIndex) {
    if (!request) return false;
    return fetchAndApplyAppendedMessages({
        request,
        startIndex,
        addedCount,
        getChat: () => chatCore.getChat(),
        getActiveChatId: () => chatUI.activeId,
        getMessages: (id, index) => chatStorage.getMessages(id, index),
        applyUI: (messages, index, id) => chatUI.appendMessages(messages, index, id),
        applyCore: messages => chatCore.addMultipleFromHistory(messages)
    });
}

function handleRenamed(chatId, title) {
    const cachedMeta = chatMetaCache.get(chatId);
    if (cachedMeta) {
        cacheMeta({ ...cachedMeta, title }, chatMetaComplete.has(chatId));
    }
    chatUI.handleRenamed(chatId, title);
    chatSearch?.updateInIndex(chatId, title);
    if (chatCore.getChatId() === chatId) { 
        chatCore.miscUpdate({ title }); 
        chatUI.updateChatHeader(title); 
    }
}

async function handleHistoryRefresh(chatId, overrides = {}) {
    if (!chatId) return;
    let meta = chatMetaCache.get(chatId) || await chatStorage.getChatMetadataById(chatId);
    if (!meta) return;
    meta = { ...meta, ...overrides };
    cacheMeta(meta, true);
    const historyItem = chatUI.getHistoryItem(chatId);
    if (historyItem) {
        chatUI.handleItemDeletion(historyItem);
    }
    chatUI.handleNewChatSaved(meta);
}

async function autoRenameUnmodified() {
    const button = document.getElementById('auto-rename');
    if (!button) return;

    const modelId = renameManager.getModel();
    if (!button.dataset.confirmed) {
        button.textContent = `use ${modelId} to rename?`;
        button.dataset.confirmed = 'pending';
        setTimeout(() => {
            if (button.dataset.confirmed === 'pending') {
                button.textContent = 'auto-rename unmodified';
                delete button.dataset.confirmed;
            }
        }, 3000);
        return;
    }

    delete button.dataset.confirmed;
    button.textContent = 'renaming...';

    const result = await renameManager.renameAllUnmodified();
    if (result.status === 'no_chats') {
        button.textContent = 'no chats to rename';
        setTimeout(() => {
            button.textContent = 'auto-rename unmodified';
        }, 2000);
        return;
    }

    result.tokenCounter.updateLifetimeTokens();
    button.textContent = `${result.successCount}/${result.totalCount} renamed (${result.tokenCounter.inputTokens}|${result.tokenCounter.outputTokens} tokens)`;

    if (chatCore.getChatId()) {
        const title = chatUI.autoUpdateHeader(chatCore.getChatId()) || chatCore.getTitle();
        chatCore.miscUpdate({ title });
    }

    setTimeout(() => {
        button.textContent = 'auto-rename unmodified';
    }, 15000);
}

/**
 * Media Tab Management.
 */
const MEDIA_DEFAULT_LIMIT = 500;
const MEDIA_STATE = Object.freeze({
    loading: 'loading',
    indexing: 'indexing',
    ready: 'ready',
    empty: 'empty',
    error: 'error'
});

const MEDIA_STATUS_MESSAGES = Object.freeze({
    [MEDIA_STATE.loading]: { title: 'Loading media…', subtitle: '' },
    [MEDIA_STATE.indexing]: { title: 'Indexing existing images…', subtitle: 'This may take a moment.' },
    [MEDIA_STATE.empty]: { title: 'No images found', subtitle: 'Images from new chats will appear here.' },
    [MEDIA_STATE.error]: { title: 'Error loading media', subtitle: 'Please try again later.' }
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
        this.refreshPending = false;
        this.loadContext = null;

        // The static HTML owns every required media node; cache them once and trust them.
        this.mediaPanel = document.getElementById('media-panel');
        this.mediaGrid = document.getElementById('media-grid');
        this.mediaView = document.getElementById('media-view');
        this.mediaSidebar = document.getElementById('media-tab');
        this.chatView = document.getElementById('chat-view');
        this.mediaTabButton = document.querySelector('.history-tab[data-tab="media"]');
        this.historyTabs = document.querySelectorAll('.history-tab');
        this.filterButtons = [...document.querySelectorAll('.media-filter-btn')];
        this.sortToggle = document.getElementById('media-sort-toggle');
        this.mediaStatusTitle = this.mediaPanel.querySelector('.media-status-title');
        this.mediaStatusSubtitle = this.mediaPanel.querySelector('.media-status-subtitle');

        for (const tab of this.historyTabs) {
            tab.addEventListener('click', () => this.switchTab(tab.dataset.tab));
        }
        for (const btn of this.filterButtons) {
            btn.addEventListener('click', () => this.setFilter(btn.dataset.filter));
        }
        this.sortToggle.addEventListener('click', () => this.toggleSort());
    }

    invalidate() {
        this.refreshPending = true;
    }

    isMediaTabActive() {
        return this.mediaTabButton.classList.contains('active');
    }

    switchTab(tabName) {
        for (const tab of this.historyTabs) {
            tab.classList.toggle('active', tab.dataset.tab === tabName);
        }
        document.querySelectorAll('.history-tab-content').forEach(c => c.style.display = 'none');
        document.querySelectorAll('.history-chat-view, .media-view').forEach(c => c.style.display = 'none');
        if (tabName === 'media') {
            this.mediaSidebar.style.display = 'flex';
            this.mediaView.style.display = 'flex';
            if (!this.hasAttemptedInitialLoad) {
                this.hasAttemptedInitialLoad = true;
            } else if (!this.refreshPending) {
                return;
            }
            this.refreshPending = false;
            runWhenIdle(() => { void this.refreshMedia({ force: true }); });
        } else {
            document.getElementById(`${tabName}-tab`).style.display = 'flex';
            this.chatView.style.display = 'flex';
        }
    }

    setFilter(filter) {
        if (this.currentFilter === filter) return;
        this.currentFilter = filter;
        this.filterButtons.forEach(btn => btn.classList.remove('is-active', 'active'));
        this.filterButtons.find(btn => btn.dataset.filter === filter)?.classList.add('is-active');
        this.renderMedia();
    }

    toggleSort() {
        this.currentSort = this.currentSort === 'desc' ? 'asc' : 'desc';
        this.sortToggle.dataset.order = this.currentSort;
        this.sortToggle.textContent = this.currentSort === 'desc' ? 'Newest first' : 'Oldest first';
        this.sortToggle.classList.toggle('is-active', this.currentSort === 'asc');
        this.renderMedia();
    }

    async refreshMedia({ force = false, incremental = false } = {}) {
        if (incremental && !force && !this.isLoading && this.isMediaTabActive() && this.mediaEntries.length) {
            return this.refreshMediaIncremental();
        }
        if (force) return this.runLoad(true);
        if (this.isLoading) return;
        runWhenIdle(() => { void this.runLoad(); });
    }

    async refreshMediaIncremental() {
        try {
            const latest = await this.chatStorage.getAllMedia(MEDIA_DEFAULT_LIMIT, 0);
            if (!Array.isArray(latest) || latest.length === 0) return;

            const knownIds = new Set(this.mediaEntries.map(entry => entry.id));
            const newEntries = latest.filter(entry => !knownIds.has(entry.id));
            if (newEntries.length === 0) return;

            if (newEntries.some(entry => !entry.thumbnail)) {
                await this.chatStorage.ensureMediaThumbnails(newEntries);
            }
            this.mediaEntries = [...newEntries, ...this.mediaEntries];
            this._showEntries(this._filterAndSortMedia(newEntries));
        } catch (error) {
            console.error('Incremental media refresh failed:', error);
            this.refreshPending = true;
        }
    }

    async runLoad(force = false) {
        if (this.isLoading && !force) return;
        if (this.loadContext) {
            this.loadContext.aborted = true;
        }

        const loadContext = { aborted: false };
        this.loadContext = loadContext;
        this.isLoading = true;
        this.refreshPending = false;

        this.setMediaState(MEDIA_STATE.loading);
        this.mediaGrid.replaceChildren();

        const loadStart = now();
        try {
            const entries = await this.fetchMediaEntries(loadContext);
            if (loadContext.aborted) return;

            this.invalidMediaIds = new Set();
            this.mediaEntries = entries;

            if (entries.length === 0) {
                this.setMediaState(MEDIA_STATE.empty);
                return;
            }

            this.renderMedia();
            console.log(`Media grid loaded ${entries.length} entries in ${formatDuration(loadStart)}`);
        } catch (error) {
            if (!loadContext.aborted) {
                this.setMediaState(MEDIA_STATE.error);
                console.error('Error loading media:', error);
            }
        } finally {
            if (this.loadContext === loadContext) {
                this.loadContext = null;
                this.isLoading = false;
            }
        }
    }

    // Fetches entries from storage, bootstrapping the media index and thumbnails when missing.
    async fetchMediaEntries(loadContext) {
        let entries = await this.chatStorage.getAllMedia(MEDIA_DEFAULT_LIMIT, 0);
        if (entries.length === 0 && !loadContext.aborted) {
            const indexedCount = await this.maybeIndexExistingMedia(loadContext);
            if (indexedCount > 0) {
                entries = await this.chatStorage.getAllMedia(MEDIA_DEFAULT_LIMIT, 0);
            }
        }
        if (!loadContext.aborted && entries.some(entry => !entry.thumbnail)) {
            await this.chatStorage.ensureMediaThumbnails(entries);
        }
        return entries;
    }

    async maybeIndexExistingMedia(loadContext) {
        this.setMediaState(MEDIA_STATE.indexing);
        try {
            return await this.chatStorage.indexAllMediaFromExistingMessages();
        } catch (error) {
            if (!loadContext.aborted) {
                console.error('Failed to index existing media:', error);
            }
            return 0;
        }
    }

    renderMedia() {
        this._showEntries(this._filterAndSortMedia(this.mediaEntries), { replace: true });
    }

    // A replace pass clears the grid and may fall back to the empty state; an incremental pass
    // only touches the grid when it has items to insert.
    _showEntries(entries, { replace = false } = {}) {
        const items = this.createMediaItems(entries);
        if (items.length === 0 && !replace) return;

        const fragment = document.createDocumentFragment();
        for (const item of items) fragment.appendChild(item);
        if (replace) {
            this.mediaGrid.replaceChildren(fragment);
        } else if (this.currentSort === 'asc') {
            this.mediaGrid.append(fragment);
        } else {
            this.mediaGrid.prepend(fragment);
        }
        this.setMediaState(items.length ? MEDIA_STATE.ready : MEDIA_STATE.empty);
    }

    _filterAndSortMedia(entries) {
        const filtered = entries
            .filter(entry => this.currentFilter === 'all' || entry.source === this.currentFilter)
            .filter(entry => !this.invalidMediaIds.has(entry.id));
        const order = this.currentSort === 'asc' ? 1 : -1;
        return filtered.sort((a, b) => order * ((a.timestamp ?? 0) - (b.timestamp ?? 0)));
    }

    createMediaItems(entries) {
        const items = [];
        for (const entry of entries) {
            if (this.isValidImage(entry.thumbnail)) {
                items.push(this.createMediaItem(entry));
            } else {
                void this.handleInvalidMedia(entry.id);
            }
        }
        return items;
    }

    createMediaItem(entry) {
        const item = document.createElement('div');
        item.className = 'media-item';

        const img = document.createElement('img');
        img.loading = 'lazy';
        img.decoding = 'async';
        img.src = entry.thumbnail;
        img.alt = 'Media item';
        img.onerror = () => this.handleInvalidMedia(entry.id, item);
        item.appendChild(img);

        item.appendChild(this.createBadge(entry.source));
        item.addEventListener('click', () => this.handleMediaClick(entry));
        if (entry.thumbnailWidth && entry.thumbnailHeight) {
            item.style.aspectRatio = `${Math.max(entry.thumbnailWidth, 1)} / ${Math.max(entry.thumbnailHeight, 1)}`;
        } else {
            item.style.removeProperty('aspect-ratio');
        }
        return item;
    }

    createBadge(source) {
        const badge = document.createElement('div');
        const isUser = source === 'user';
        badge.className = `media-item-badge ${isUser ? 'media-item-badge-user' : 'media-item-badge-ai'}`;
        badge.textContent = isUser ? 'USER' : 'AI';
        return badge;
    }

    handleMediaClick(entry) {
        void runAfterSuccessfulBuild(this.chatUI.buildChat(entry.chatId), () => {
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
        if (messageElements.length === 0) return null;

        if (entry.source === 'user') {
            const images = messageElements[0].querySelectorAll('.user-content.image-content img');
            return images[entry.imageIndex] || images[0] || null;
        }

        // For assistant images: contentIndex = which regeneration, partIndex = which image within it
        const msgElement = messageElements[entry.contentIndex] || messageElements[messageElements.length - 1];
        const images = msgElement.querySelectorAll('.assistant-content.image-content img');
        return images[entry.partIndex ?? 0] || images[0] || null;
    }

    async handleInvalidMedia(entryId, item = null) {
        this.markEntryInvalid(entryId);

        try {
            await this.chatStorage.deleteMediaEntry(entryId);
        } catch (error) {
            console.warn('Failed to delete invalid media entry', error);
        }

        item?.remove();

        if (this.mediaGrid.children.length === 0) {
            this.setMediaState(MEDIA_STATE.empty);
        }
    }

    markEntryInvalid(entryId) {
        this.invalidMediaIds.add(entryId);
        this.mediaEntries = this.mediaEntries.filter(entry => entry.id !== entryId);
    }

    isValidImage(imageData) {
        if (!imageData) return false;
        return imageData.startsWith('data:image/') || imageData.startsWith('http://') || imageData.startsWith('https://');
    }

    async reindexMedia() {
        const db = await this.chatStorage.getDB();
        if (!db.objectStoreNames.contains('mediaIndex')) {
            await this._settleAfterReindex();
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
            await this._settleAfterReindex();
            return indexedCount;
        } catch (error) {
            await this._settleAfterReindex(false).catch(() => {});
            throw error;
        }
    }

    // Force a refresh on the active tab; on a hidden tab, clear state or just mark it stale.
    async _settleAfterReindex(clearState = true) {
        if (this.isMediaTabActive()) {
            await this.refreshMedia({ force: true });
        } else if (clearState) {
            this._resetMediaState();
        } else {
            this.invalidate();
        }
    }

    _resetMediaState() {
        this.invalidate();
        this.mediaEntries = [];
        this.invalidMediaIds = new Set();
        if (this.loadContext) {
            this.loadContext.aborted = true;
        }
        this.loadContext = null;
        this.isLoading = false;
    }

    setMediaState(state) {
        this.mediaPanel.dataset.state = state;

        const { title = '', subtitle = '' } = MEDIA_STATUS_MESSAGES[state] ?? {};
        this.mediaStatusTitle.textContent = title;
        this.mediaStatusSubtitle.textContent = subtitle;
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
            doc.searchTitle = normaliseForSearch(doc.title || '');
        }

        const normalisedDelta = normaliseForSearch(trimmed);
        if (normalisedDelta) {
            const base = typeof doc.content === 'string' ? doc.content : '';
            doc.content = base ? `${base} ${normalisedDelta}`.trim() : normalisedDelta;
            doc._normalized = true;
        } else if (typeof doc.content !== 'string') {
            doc.content = normaliseForSearch('');
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

    decorateDocument(doc) {
        if (!doc) return doc;

        doc.searchTitle = normaliseForSearch(doc.title || '');

        if (doc._normalized !== true) {
            doc.content = normaliseForSearch(doc.content || '');
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
            const chat = await chatStorage.loadChat(meta.chatId, null, { resolveBlobs: false });
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
        const normalisedId = this.normaliseId(chatId);
        const doc = this.docIndex.get(normalisedId);
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
            const normalisedQuery = normaliseForSearch(trimmed);
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

async function initiateChatBackupDownload(element) {
    element.textContent = "extracting...";
    try {
        const backupJson = await chatStorage.exportChats({ pretty: true });
        chatStorage.triggerDownload(backupJson);
        element.textContent = "success!";
    } catch (error) {
        console.error('Export failed:', error);
        element.textContent = "failed :(";
    }
    setTimeout(() => element.textContent = "export", 5000);
}

async function initiateChatBackupImport(element) {
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'application/json';
    fileInput.onchange = (event) => {
        const selectedFile = event.target.files[0];
        if (!selectedFile) return;
        const fileReader = new FileReader();
        fileReader.onload = async (fileEvent) => {
            element.textContent = "importing...";
            try {
                const importResult = await chatStorage.importChats(fileEvent.target.result);
                element.textContent = importResult.success ? `${importResult.count} added` : 'failed :(';
                chatUI.reloadHistoryList();
                chatSearch?.reindex();
            } catch (error) {
                console.error('Import failed:', error);
                element.textContent = 'failed :(';
            }
        };
        fileReader.readAsText(selectedFile);
    };
    fileInput.click();
}
