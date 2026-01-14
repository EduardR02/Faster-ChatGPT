export const PNG_TRAILER = 'AElFTkSuQmCC';
const BASE64_INVALID = /[^A-Za-z0-9+/=]/;
const PNG_SIG = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];

const padBase64 = (str) => {
    const padNeeded = (4 - (str.length % 4)) % 4;
    return str + '='.repeat(padNeeded);
};

const decodeSafe = (str) => { 
    try { 
        return atob(str); 
    } catch { 
        return null; 
    } 
};

const stripInvalidChars = (str) => {
    return str.replace(/[^A-Za-z0-9+/=]/g, '');
};

const hasTailAfterPadding = (str) => {
    const firstPaddingIndex = str.indexOf('=');
    if (firstPaddingIndex === -1) {
        return false;
    }
    
    // Check if there are any non-padding characters after the first padding
    for (let i = firstPaddingIndex; i < str.length; i++) {
        if (str[i] !== '=') {
            return true;
        }
    }
    return false;
};

function findPngEnd(binary) {
    if (!binary || binary.length < 12) {
        return null;
    }
    
    // Check PNG signature
    for (let i = 0; i < PNG_SIG.length; i++) {
        if (binary.charCodeAt(i) !== PNG_SIG[i]) {
            return null;
        }
    }

    let offset = 8;
    while (offset + 8 <= binary.length) {
        // Read 4-byte big-endian length
        const length = ((binary.charCodeAt(offset) << 24) >>> 0) | 
                       ((binary.charCodeAt(offset + 1) << 16) >>> 0) | 
                       ((binary.charCodeAt(offset + 2) << 8) >>> 0) | 
                       (binary.charCodeAt(offset + 3) >>> 0);
                       
        const chunkType = binary.slice(offset + 4, offset + 8);
        const chunkEnd = offset + 8 + length + 4; // 8 (len+type) + length + 4 (crc)
        
        if (chunkEnd > binary.length) {
            return null;
        }
        
        if (chunkType === 'IEND') {
            return chunkEnd;
        }
        
        offset = chunkEnd;
    }
    return null;
}

export function base64NeedsRepair(raw, mime = '') {
    if (typeof raw !== 'string') {
        return true;
    }
    
    const trimmed = raw.trim();
    if (BASE64_INVALID.test(trimmed) || hasTailAfterPadding(trimmed)) {
        return true;
    }
    
    const normalized = padBase64(trimmed);
    // Base64 string length can't be 1 mod 4
    if (normalized.length % 4 === 1) {
        return true;
    }
    
    const decoded = decodeSafe(normalized);
    if (!decoded) {
        return true;
    }

    if (mime.includes('png')) {
        const endPosition = findPngEnd(decoded);
        return endPosition === null || endPosition < decoded.length;
    }
    
    return false;
}

export function sanitizeBase64Image(raw, mime = '') {
    if (typeof raw !== 'string') {
        return raw;
    }
    
    const cleaned = raw.trim().replace(/\s+/g, '');
    const candidates = [];

    // Prioritize PNG trailer truncation
    if (mime.includes('png')) {
        const trailerIndex = cleaned.lastIndexOf(PNG_TRAILER);
        if (trailerIndex !== -1) {
            candidates.push(cleaned.slice(0, trailerIndex + PNG_TRAILER.length));
        }
    }
    
    // Truncate at first invalid character
    const firstInvalid = cleaned.search(BASE64_INVALID);
    if (firstInvalid !== -1) {
        candidates.push(cleaned.slice(0, firstInvalid));
    }
    
    candidates.push(cleaned);

    for (const candidate of candidates) {
        const stripped = stripInvalidChars(candidate);
        const normalized = padBase64(stripped);
        
        if (normalized.length % 4 === 1) {
            continue;
        }
        
        const decoded = decodeSafe(normalized);
        if (!decoded) {
            continue;
        }

        if (mime.includes('png')) {
            const endPosition = findPngEnd(decoded);
            if (endPosition !== null) {
                if (endPosition < decoded.length) {
                    return btoa(decoded.slice(0, endPosition));
                }
                return normalized;
            }
            continue;
        }
        return normalized;
    }

    // Fallback: strip and pad up to first padding block
    const strippedFallback = stripInvalidChars(cleaned);
    const fallback = padBase64(strippedFallback);
    const firstPadding = cleaned.indexOf('=');
    
    if (firstPadding !== -1) {
        let endOfPadding = firstPadding;
        while (endOfPadding < cleaned.length && cleaned[endOfPadding] === '=') {
            endOfPadding++;
        }
        return padBase64(stripInvalidChars(cleaned.slice(0, endOfPadding)));
    }
    
    return fallback || cleaned;
}
