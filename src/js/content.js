let lastSelection = "";
let webpageContextModulePromise = null;
let cachedPageContextKey = '';
let cachedPageContext = null;
let cachedPageContextAt = 0;

const PAGE_CONTEXT_CACHE_TTL_MS = 5000;
let shouldAutoPageContext = false;
let pageContextRequestId = 0;
const PAGE_CONTEXT_REQUEST_NONCE_KEY = 'page_context_request_nonce';

const getWebpageContextModule = () => {
    if (!webpageContextModulePromise) {
        webpageContextModulePromise = import(chrome.runtime.getURL('src/js/webpage_context.js'));
    }
    return webpageContextModulePromise;
};

const getPageContextCacheKey = () => `${window.location.href}::${document.title}`;

const extractCurrentPageContext = async () => {
    const cacheKey = getPageContextCacheKey();
    const isCacheFresh = (Date.now() - cachedPageContextAt) < PAGE_CONTEXT_CACHE_TTL_MS;
    if (cachedPageContextKey === cacheKey && cachedPageContext && isCacheFresh) {
        return cachedPageContext;
    }

    const { extractWebpageContext } = await getWebpageContextModule();
    const nextContext = extractWebpageContext(document, window.location);
    if (nextContext) {
        cachedPageContext = nextContext;
        cachedPageContextKey = cacheKey;
        cachedPageContextAt = Date.now();
    }
    return nextContext;
};

const reportRequestedPageContext = async () => {
    if (!shouldAutoPageContext || document.visibilityState === 'hidden') {
        return;
    }

    const response = await chrome.runtime.sendMessage({ type: 'should_collect_page_context' }).catch(() => null);
    const requestId = response?.requestId;
    if (!requestId) {
        return;
    }

    const localRequestId = ++pageContextRequestId;
    const expectedKey = getPageContextCacheKey();
    const context = await extractCurrentPageContext().catch(() => null);

    if (
        localRequestId !== pageContextRequestId
        || !shouldAutoPageContext
        || document.visibilityState === 'hidden'
        || getPageContextCacheKey() !== expectedKey
    ) {
        return;
    }

    chrome.runtime.sendMessage({
        type: 'report_page_context',
        requestId,
        context
    }).catch(() => {});
};

const initAutoPageContextSetting = () => {
    chrome.storage.local.get('auto_page_context', result => {
        shouldAutoPageContext = !!result.auto_page_context;
    });
};

const checkIsModeOn = (callback) => {
    chrome.runtime.sendMessage({ type: "is_mode_on" }, response => {
        callback(response.is_mode_on);
    });
};

const updateSelectionListener = () => {
    checkIsModeOn(isOn => {
        document.removeEventListener("mouseup", handleMouseUp);
        if (isOn) {
            document.addEventListener("mouseup", handleMouseUp);
        }
    });
};

async function handleMouseUp(event) {
    const selection = window.getSelection().toString().trim();
    const hasModifierKey = event.ctrlKey || event.metaKey;

    if (selection && selection !== lastSelection && hasModifierKey) {
        lastSelection = selection;
        
        await chrome.runtime.sendMessage({ type: "open_side_panel" });
        chrome.runtime.sendMessage({ 
            type: "new_selection", 
            text: selection, 
            url: window.location.href 
        });
        
    } else if (!selection && lastSelection) {
        lastSelection = "";
        
        chrome.storage.local.get("close_on_deselect", result => {
            if (result.close_on_deselect) {
                chrome.runtime.sendMessage({ type: "close_side_panel" });
            }
        });
    }
}

// Initial initialization
updateSelectionListener();
initAutoPageContextSetting();

// Handle settings changes
chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace !== "local") return;

    if (changes.mode) {
        updateSelectionListener();
    }

    if (changes.auto_page_context) {
        shouldAutoPageContext = !!changes.auto_page_context.newValue;
        return;
    }

    if (changes[PAGE_CONTEXT_REQUEST_NONCE_KEY]) {
        void reportRequestedPageContext();
    }
});
