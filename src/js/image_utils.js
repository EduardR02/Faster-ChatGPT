export const PNG_TRAILER = 'AElFTkSuQmCC';

const BASE64_INVALID = /[^A-Za-z0-9+/=]/;
const PNG_FILE_SIGNATURE = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];

function hasTailAfterPadding(str) {
    const firstPad = str.indexOf('=');
    if (firstPad === -1) return false;
    for (let i = firstPad; i < str.length; i++) {
        const ch = str[i];
        if (ch === '=') continue;
        return true; // anything after padding block
    }
    return false;
}

function padBase64(str) {
    const remainder = str.length % 4;
    return remainder ? str + '='.repeat(4 - remainder) : str;
}

function decodeBase64Safe(str) {
    try {
        return atob(str);
    } catch {
        return null;
    }
}

function stripInvalid(str) {
    return str.replace(/[^A-Za-z0-9+/=]/g, '');
}

function findPngLogicalEnd(binary) {
    if (!binary || binary.length < 12) return null;

    // Validate file signature
    for (let i = 0; i < PNG_FILE_SIGNATURE.length; i++) {
        if (binary.charCodeAt(i) !== PNG_FILE_SIGNATURE[i]) {
            return null;
        }
    }

    let offset = 8; // Skip signature
    const len = binary.length;

    while (offset + 8 <= len) {
        const length =
            ((binary.charCodeAt(offset) << 24) >>> 0) |
            ((binary.charCodeAt(offset + 1) << 16) >>> 0) |
            ((binary.charCodeAt(offset + 2) << 8) >>> 0) |
            (binary.charCodeAt(offset + 3) >>> 0);

        const type = binary.slice(offset + 4, offset + 8);
        const chunkEnd = offset + 8 + length + 4; // length + type + data + crc

        if (chunkEnd > len) return null;

        if (type === 'IEND') {
            return chunkEnd;
        }

        offset = chunkEnd;
    }

    return null;
}

export function base64NeedsRepair(rawBase64, mimeType = '') {
    if (typeof rawBase64 !== 'string') return true;

    const trimmed = rawBase64.trim();

    if (BASE64_INVALID.test(trimmed)) return true;
    if (hasTailAfterPadding(trimmed)) return true;

    const normalized = padBase64(trimmed);
    if (normalized.length % 4 === 1) return true;

    const decoded = decodeBase64Safe(normalized);
    if (!decoded) return true;

    if (mimeType && mimeType.includes('png')) {
        const logicalEnd = findPngLogicalEnd(decoded);
        if (logicalEnd === null) return true;
        if (logicalEnd < decoded.length) return true;
    }

    return false;
}

export function sanitizeBase64Image(rawBase64, mimeType = '') {
    if (typeof rawBase64 !== 'string') return rawBase64;

    const trimmed = rawBase64.trim().replace(/\s+/g, '');
    const candidates = [];

    if (mimeType && mimeType.includes('png')) {
        const tailIndex = trimmed.lastIndexOf(PNG_TRAILER);
        if (tailIndex !== -1) {
            candidates.push(trimmed.slice(0, tailIndex + PNG_TRAILER.length));
        }
    }

    const invalidIndex = trimmed.search(BASE64_INVALID);
    if (invalidIndex !== -1) {
        candidates.push(trimmed.slice(0, invalidIndex));
    }

    candidates.push(trimmed);

    const tryCandidate = (candidate) => {
        const normalized = padBase64(stripInvalid(candidate));
        if (!normalized || normalized.length % 4 === 1) return null;
        const decoded = decodeBase64Safe(normalized);
        if (!decoded) return null;

        if (mimeType && mimeType.includes('png')) {
            const logicalEnd = findPngLogicalEnd(decoded);
            if (logicalEnd === null) return null;
            if (logicalEnd < decoded.length) {
                return btoa(decoded.slice(0, logicalEnd));
            }
        }
        return normalized;
    };

    for (const candidate of candidates) {
        const result = tryCandidate(candidate);
        if (result) return result;
    }

    const fallback = padBase64(stripInvalid(trimmed));
    const padIdx = trimmed.indexOf('=');
    if (padIdx !== -1) {
        const runEnd = (() => {
            let i = padIdx;
            while (i < trimmed.length && trimmed[i] === '=') i++;
            return i;
        })();
        const cut = trimmed.slice(0, runEnd);
        return padBase64(stripInvalid(cut));
    }

    return fallback || trimmed;
}
