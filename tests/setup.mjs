// Polyfills for Node/Bun environment
if (typeof atob === 'undefined') {
    globalThis.atob = (str) => Buffer.from(str, 'base64').toString('binary');
}
if (typeof btoa === 'undefined') {
    globalThis.btoa = (str) => Buffer.from(str, 'binary').toString('base64');
}

// Mock chrome.storage and chrome.runtime for tests that need it
export function createChromeMock() {
    const storage = new Map();
    return {
        storage: {
            local: {
                get: (keys, callback) => {
                    const result = {};
                    const keyList = Array.isArray(keys) ? keys : [keys];
                    keyList.forEach(k => {
                        if (storage.has(k)) result[k] = storage.get(k);
                    });
                    if (callback) callback(result);
                    return Promise.resolve(result);
                },
                set: (items, callback) => {
                    Object.entries(items).forEach(([k, v]) => storage.set(k, v));
                    if (callback) callback();
                    return Promise.resolve();
                }
            },
            onChanged: {
                addListener: () => {},
                removeListener: () => {}
            }
        },
        runtime: {
            sendMessage: () => Promise.resolve()
        }
    };
}

// Mock for StreamWriter tests (no DOM needed for core logic tests)
export function createMockWriter() {
    return {
        parts: [{ type: 'text', content: [] }],
        isThoughtEnd: true,
        isThinkingModel: false,
        _processedContent: [],
        
        setThinkingModel() {
            this.isThoughtEnd = false;
            this.parts = [{ type: 'thought', content: [] }];
            this.isThinkingModel = true;
        },
        
        processContent(content, isThought = false) {
            if (isThought && this.isThoughtEnd) {
                if (this.parts.length === 1 && this.parts[0].content.length === 0) {
                    this.parts[0].type = 'thought';
                    this.isThoughtEnd = false;
                } else {
                    this.parts.push({ type: 'thought', content: [] });
                    this.isThoughtEnd = false;
                }
            }

            if (!isThought && !this.isThoughtEnd) {
                this.isThoughtEnd = true;
                this.parts.push({ type: 'text', content: [] });
            }
            this.parts.at(-1).content.push(content);
            this._processedContent.push({ content, isThought });
        },
        
        getFinalContent() {
            return this.parts
                .filter(p => p.content.length > 0 || (p.type === 'text' && this.parts.length === 1))
                .map(p => ({
                    type: p.type,
                    content: p.content.join('')
                }));
        },
        
        addThinkingCounter() {},
        stopThinkingCounter() {}
    };
}

// Mock token counter
export function createMockTokenCounter() {
    return {
        inputTokens: 0,
        outputTokens: 0,
        update(input, output) {
            this.inputTokens += input;
            this.outputTokens += output;
        }
    };
}

// Test assertion helpers
export function assertDeepEqual(actual, expected, message = '') {
    const actualStr = JSON.stringify(actual, null, 2);
    const expectedStr = JSON.stringify(expected, null, 2);
    if (actualStr !== expectedStr) {
        throw new Error(`${message}\nExpected:\n${expectedStr}\n\nActual:\n${actualStr}`);
    }
}

export function assertThrows(fn, expectedError = null, message = '') {
    try {
        fn();
        throw new Error(`${message}: Expected function to throw, but it didn't`);
    } catch (e) {
        if (expectedError && !e.message.includes(expectedError)) {
            throw new Error(`${message}: Expected error containing "${expectedError}", got "${e.message}"`);
        }
    }
}


