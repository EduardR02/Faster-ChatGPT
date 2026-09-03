const TOKEN_REQUEST_TIMEOUT_MS = 15_000;
const BROWSER_LOGIN_TIMEOUT_MS = 10 * 60_000;
const REFRESH_SKEW_MS = 60_000;

export const CHATGPT_AUTH_CONFIG = Object.freeze({
    clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
    authorizeUrl: 'https://auth.openai.com/oauth/authorize',
    tokenUrl: 'https://auth.openai.com/oauth/token',
    redirectUri: 'http://localhost:1455/auth/callback',
    scope: 'openid profile email offline_access api.connectors.read api.connectors.invoke'
});

const JWT_AUTH_CLAIM = 'https://api.openai.com/auth';
const JWT_PROFILE_CLAIM = 'https://api.openai.com/profile';
let refreshInFlight = null;

function abortError() {
    const error = new Error('ChatGPT authentication cancelled.');
    error.name = 'AbortError';
    return error;
}

function throwIfAborted(signal) {
    if (signal?.aborted) throw abortError();
}

function toBase64Url(bytes) {
    return btoa(String.fromCharCode(...bytes))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/g, '');
}

function randomBase64Url(cryptoImpl, size = 32) {
    return toBase64Url(cryptoImpl.getRandomValues(new Uint8Array(size)));
}

async function createPKCE(cryptoImpl) {
    const verifier = randomBase64Url(cryptoImpl);
    const digest = await cryptoImpl.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    return { verifier, challenge: toBase64Url(new Uint8Array(digest)) };
}

async function fetchWithTimeout(fetchImpl, url, options, signal) {
    throwIfAborted(signal);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TOKEN_REQUEST_TIMEOUT_MS);
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
        return await fetchImpl(url, { ...options, signal: controller.signal });
    } catch (error) {
        if (signal?.aborted) throw abortError();
        if (controller.signal.aborted) throw new Error('ChatGPT authentication request timed out.');
        throw error;
    } finally {
        clearTimeout(timeoutId);
        signal?.removeEventListener('abort', onAbort);
    }
}

function decodeJwt(token) {
    try {
        const payload = token.split('.')[1];
        if (!payload) return null;
        const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
        const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
        const binary = atob(padded);
        const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
        return JSON.parse(new TextDecoder().decode(bytes));
    } catch (_) {
        return null;
    }
}

function getTokenProfile(accessToken, idToken) {
    const accessPayload = decodeJwt(accessToken);
    const idPayload = idToken ? decodeJwt(idToken) : null;
    const accessAuth = accessPayload?.[JWT_AUTH_CLAIM];
    const idAuth = idPayload?.[JWT_AUTH_CLAIM];
    const email = (accessPayload?.[JWT_PROFILE_CLAIM]?.email ?? idPayload?.[JWT_PROFILE_CLAIM]?.email)?.trim().toLowerCase();
    const planType = (accessAuth?.chatgpt_plan_type ?? idAuth?.chatgpt_plan_type)?.trim().toLowerCase();
    const accountId = accessAuth?.chatgpt_account_id ?? idAuth?.chatgpt_account_id;

    return {
        accountId: typeof accountId === 'string' && accountId ? accountId : undefined,
        email: typeof email === 'string' && email ? email : undefined,
        planType: typeof planType === 'string' && planType ? planType : undefined
    };
}

function describeErrorBody(value) {
    if (typeof value === 'string') return value.trim();
    if (!value || typeof value !== 'object') return value == null ? '' : String(value);
    const error = describeErrorBody(value.error);
    const description = describeErrorBody(value.error_description ?? value.message ?? value.description);
    if (error && description && error !== description) return `${error}: ${description}`;
    return error || description || JSON.stringify(value);
}

async function responseError(response) {
    const text = (await response.text()).trim();
    if (!text) return `HTTP ${response.status}`;
    try {
        return `HTTP ${response.status} ${describeErrorBody(JSON.parse(text))}`;
    } catch (_) {
        return `HTTP ${response.status} ${text}`;
    }
}

async function readJsonResponse(response, label) {
    if (!response.ok) throw new Error(`${label}: ${await responseError(response)}`);
    try {
        return await response.json();
    } catch (_) {
        throw new Error(`${label}: invalid JSON response.`);
    }
}

function credentialsFromTokenResponse(tokenData, previous = null) {
    const access = typeof tokenData?.access_token === 'string' ? tokenData.access_token : '';
    const refresh = typeof tokenData?.refresh_token === 'string' ? tokenData.refresh_token : previous?.refresh;
    const expiresIn = tokenData?.expires_in;
    if (!access || !refresh || typeof expiresIn !== 'number' || !Number.isFinite(expiresIn)) {
        throw new Error('ChatGPT token response is missing required fields.');
    }

    const profile = getTokenProfile(access, tokenData.id_token);
    const accountId = profile.accountId ?? previous?.accountId;
    if (!accountId) throw new Error('ChatGPT token does not identify an account.');

    return {
        access,
        refresh,
        expires: Date.now() + expiresIn * 1000,
        accountId,
        email: profile.email ?? previous?.email,
        planType: profile.planType ?? previous?.planType
    };
}

export function isChatGPTCredentials(value) {
    return !!value &&
        typeof value.access === 'string' && value.access.length > 0 &&
        typeof value.refresh === 'string' && value.refresh.length > 0 &&
        typeof value.accountId === 'string' && value.accountId.length > 0 &&
        typeof value.expires === 'number' && Number.isFinite(value.expires);
}

export function createChatGPTAuthorizationUrl({ state, challenge }) {
    const params = new URLSearchParams({
        response_type: 'code',
        client_id: CHATGPT_AUTH_CONFIG.clientId,
        redirect_uri: CHATGPT_AUTH_CONFIG.redirectUri,
        scope: CHATGPT_AUTH_CONFIG.scope,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state,
        id_token_add_organizations: 'true',
        codex_cli_simplified_flow: 'true',
        originator: 'pi'
    });
    return `${CHATGPT_AUTH_CONFIG.authorizeUrl}?${params}`;
}

function waitForChatGPTCallback(tabId, state, { tabs, signal, timeoutMs }) {
    return new Promise((resolve, reject) => {
        let settled = false;
        const timeoutId = setTimeout(() => finish(new Error('ChatGPT sign-in timed out.')), timeoutMs);

        const cleanup = () => {
            clearTimeout(timeoutId);
            tabs.onUpdated.removeListener(onUpdated);
            tabs.onRemoved?.removeListener(onRemoved);
            signal?.removeEventListener('abort', onAbort);
        };

        const finish = (error, code, closeTab = true) => {
            if (settled) return;
            settled = true;
            cleanup();
            if (closeTab) Promise.resolve(tabs.remove(tabId)).catch(() => {});
            if (error) reject(error);
            else resolve(code);
        };

        const onUpdated = (updatedTabId, changeInfo, tab) => {
            if (updatedTabId !== tabId) return;
            const rawUrl = changeInfo.url ?? tab?.url;
            if (!rawUrl) return;

            let callbackUrl;
            try {
                callbackUrl = new URL(rawUrl);
            } catch (_) {
                return;
            }
            const redirectUrl = new URL(CHATGPT_AUTH_CONFIG.redirectUri);
            if (callbackUrl.origin !== redirectUrl.origin || callbackUrl.pathname !== redirectUrl.pathname) return;

            const returnedState = callbackUrl.searchParams.get('state');
            if (returnedState !== state) {
                finish(new Error('ChatGPT sign-in returned an invalid state.'));
                return;
            }
            const oauthError = callbackUrl.searchParams.get('error');
            if (oauthError) {
                const description = callbackUrl.searchParams.get('error_description');
                finish(new Error(`ChatGPT sign-in was rejected: ${description || oauthError}`));
                return;
            }
            const code = callbackUrl.searchParams.get('code');
            if (!code) {
                finish(new Error('ChatGPT sign-in did not return an authorization code.'));
                return;
            }
            finish(null, code);
        };

        const onRemoved = removedTabId => {
            if (removedTabId === tabId) finish(new Error('ChatGPT sign-in tab was closed.'), null, false);
        };
        const onAbort = () => finish(abortError());

        tabs.onUpdated.addListener(onUpdated);
        tabs.onRemoved?.addListener(onRemoved);
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted) onAbort();
    });
}

async function exchangeAuthorizationCode(code, verifier, { fetchImpl, signal }) {
    const response = await fetchWithTimeout(fetchImpl, CHATGPT_AUTH_CONFIG.tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'authorization_code',
            client_id: CHATGPT_AUTH_CONFIG.clientId,
            code,
            code_verifier: verifier,
            redirect_uri: CHATGPT_AUTH_CONFIG.redirectUri
        })
    }, signal);
    const data = await readJsonResponse(response, 'Could not complete ChatGPT authentication');
    return credentialsFromTokenResponse(data);
}

export async function loginWithChatGPT({
    fetchImpl = fetch,
    tabs = chrome.tabs,
    cryptoImpl = crypto,
    signal,
    timeoutMs = BROWSER_LOGIN_TIMEOUT_MS
} = {}) {
    throwIfAborted(signal);
    const [{ verifier, challenge }, state] = await Promise.all([
        createPKCE(cryptoImpl),
        Promise.resolve(randomBase64Url(cryptoImpl))
    ]);
    const url = createChatGPTAuthorizationUrl({ state, challenge });
    const tab = await tabs.create({ url, active: true });
    if (!Number.isInteger(tab?.id)) throw new Error('Could not open the ChatGPT sign-in tab.');

    const code = await waitForChatGPTCallback(tab.id, state, { tabs, signal, timeoutMs });
    return exchangeAuthorizationCode(code, verifier, { fetchImpl, signal });
}

async function refreshChatGPTCredentials(credentials, fetchImpl, signal) {
    const response = await fetchWithTimeout(fetchImpl, CHATGPT_AUTH_CONFIG.tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'refresh_token',
            client_id: CHATGPT_AUTH_CONFIG.clientId,
            refresh_token: credentials.refresh
        })
    }, signal);
    const data = await readJsonResponse(response, 'Could not refresh ChatGPT authentication');
    return credentialsFromTokenResponse(data, credentials);
}

export async function ensureFreshChatGPTCredentials(credentials, {
    fetchImpl = fetch,
    signal,
    now = Date.now()
} = {}) {
    if (!isChatGPTCredentials(credentials)) {
        throw new Error('ChatGPT connection is invalid. Sign in again.');
    }
    if (credentials.expires - now > REFRESH_SKEW_MS) return credentials;

    if (refreshInFlight?.refresh === credentials.refresh) return refreshInFlight.promise;

    const promise = refreshChatGPTCredentials(credentials, fetchImpl, signal);
    refreshInFlight = { refresh: credentials.refresh, promise };
    try {
        return await promise;
    } finally {
        if (refreshInFlight?.promise === promise) refreshInFlight = null;
    }
}
