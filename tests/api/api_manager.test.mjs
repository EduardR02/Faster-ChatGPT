import { ApiManager } from '../../src/js/api_manager.js';
import { 
    createChromeMock, 
    createMockWriter, 
    createMockTokenCounter, 
    assertDeepEqual 
} from '../setup.mjs';
import { describe, it, test, expect, beforeEach, jest } from "bun:test";

// --- Mocks & Test Helpers ---

let fetchCalls = [];
let mockResponse = null;

globalThis.fetch = async (url, options) => {
    fetchCalls.push({ url, options });
    if (mockResponse instanceof Error) throw mockResponse;
    return mockResponse;
};

function createJsonResponse(data, status = 200, ok = true) {
    return {
        ok,
        status,
        statusText: ok ? 'OK' : 'Error',
        headers: new Headers({ 'Content-Type': 'application/json' }),
        json: async () => data,
        text: async () => JSON.stringify(data),
        body: null
    };
}

function createStreamResponse(chunks) {
    const encoder = new TextEncoder();
    return {
        ok: true,
        status: 200,
        headers: new Headers({ 'Content-Type': 'text/event-stream' }),
        body: {
            getReader() {
                let index = 0;
                return {
                    read: async () => {
                        if (index >= chunks.length) return { done: true, value: undefined };
                        const value = encoder.encode(chunks[index++]);
                        return { done: false, value };
                    },
                    releaseLock: () => {}
                };
            }
        }
    };
}

// --- Test Suite ---

describe('ApiManager', () => {
    let apiManager;
    let chromeMock;

    beforeEach(async () => {
        fetchCalls = [];
        mockResponse = createJsonResponse({ output: [] }); // Default mock
        chromeMock = createChromeMock();
        globalThis.chrome = chromeMock;
        
        // Mock default settings
        await chromeMock.storage.local.set({
            'api_keys': { 'openai': 'test-openai-key', 'anthropic': 'test-anthropic-key', 'gemini': 'test-gemini-key' },
            'models': {
                'openai': { 'gpt-5.2': 'GPT-5.2' },
                'anthropic': { 'claude-4.5-opus': 'Claude 4.5 Opus' },
                'gemini': { 'gemini-3-pro-image-preview': 'Nano Banana Pro' }
            },
            'max_tokens': 1000,
            'temperature': 0.7
        });

        apiManager = new ApiManager();
        await new Promise(resolve => apiManager.settingsManager.runOnReady(resolve));

        // Disable timeout for normal tests
        apiManager._fetchWithTimeout = async (url, requestOptions, timeoutMs, errorContext, externalAbort = null) => {
            const response = await fetch(url, requestOptions);
            if (!response.ok) {
                const errorDetail = await apiManager.readErrorResponse(response);
                throw apiManager.createApiError(errorContext.prefix, { 
                    ...errorContext, 
                    status: response.status, 
                    detail: errorDetail 
                });
            }
            return response;
        };
    });

    test('can instantiate ApiManager', async () => {
        expect(apiManager).toBeDefined();
    });

    describe('Request Orchestration', () => {
        it('calls the correct provider and passes right parameters', async () => {
            mockResponse = createJsonResponse({
                output: [{ type: 'message', content: [{ type: 'output_text', text: 'Hello!' }] }],
                usage: { input_tokens: 10, output_tokens: 5 }
            });

            const messages = [{ role: 'user', parts: [{ type: 'text', content: 'Hi' }] }];
            const tokenCounter = createMockTokenCounter();
            
            const result = await apiManager.callApi('gpt-5.2', messages, tokenCounter);

            // Verify result
            assertDeepEqual(result, [{ type: 'text', content: 'Hello!' }]);
            assertDeepEqual(tokenCounter.inputTokens, 10);
            assertDeepEqual(tokenCounter.outputTokens, 5);

            // Verify fetch call
            const call = fetchCalls[0];
            expect(call.url).toBe('https://api.openai.com/v1/responses');
            expect(call.options.method).toBe('POST');
            expect(call.options.headers['Authorization']).toBe('Bearer test-openai-key');
            
            const body = JSON.parse(call.options.body);
            expect(body.model).toBe('gpt-5.2');
            expect(body.input[0].role).toBe('user');
            expect(body.max_output_tokens).toBe(1000);
        });

        it('handles file processing in messages', async () => {
            mockResponse = createJsonResponse({ output: [] });
            const messages = [{ 
                role: 'user', 
                parts: [{ type: 'text', content: 'See files.' }],
                files: [{ name: 'test.js', content: 'console.log("hi");' }]
            }];

            await apiManager.callApi('gpt-5.2', messages, createMockTokenCounter());

            const body = JSON.parse(fetchCalls[0].options.body);
            const content = body.input[0].content[0].text;
            expect(content).toContain('test.js:');
            expect(content).toContain('<|file_start|>console.log("hi");<|file_end|>');
        });
    });

    describe('Timeout handling', () => {
        it('uses AbortController with correct timeout', async () => {
            const originalFetch = globalThis.fetch;
            const originalSetTimeout = globalThis.setTimeout;
            
            let capturedTimeout = null;
            let capturedSignal = null;

            globalThis.setTimeout = (fn, ms) => {
                capturedTimeout = ms;
                return 123;
            };

            globalThis.fetch = async (url, options) => {
                capturedSignal = options.signal;
                return createJsonResponse({});
            };

            try {
                // Restore real _fetchWithTimeout for this test
                const realFetchWithTimeout = ApiManager.prototype._fetchWithTimeout;
                await realFetchWithTimeout.call(apiManager, 'http://test', {}, 5000, { prefix: 'Fail' });

                expect(capturedTimeout).toBe(5000);
                expect(capturedSignal).toBeDefined();
                expect(capturedSignal instanceof AbortSignal).toBe(true);
            } finally {
                globalThis.fetch = originalFetch;
                globalThis.setTimeout = originalSetTimeout;
            }
        });
    });

    describe('Streaming setup', () => {
        it('passes streaming flag correctly', async () => {
            mockResponse = createJsonResponse({});
            const streamWriter = createMockWriter();
            
            try { await apiManager.callApi('gpt-5.2', [], createMockTokenCounter(), streamWriter); } catch(e){}

            const body = JSON.parse(fetchCalls[0].options.body);
            expect(body.stream).toBe(true);
        });

        it('sets up stream reader and processes chunks', async () => {
            const chunks = [
                'data: {"type": "response.output_text.delta", "delta": "Hel"}\n',
                'data: {"type": "response.output_text.delta", "delta": "lo"}\n',
                'data: [DONE]\n'
            ];
            mockResponse = createStreamResponse(chunks);
            
            const streamWriter = createMockWriter();
            const tokenCounter = createMockTokenCounter();

            await apiManager.callApi('gpt-5.2', [], tokenCounter, streamWriter);

            expect(streamWriter._processedContent.length).toBeGreaterThan(0);
            expect(streamWriter._processedContent[0].content).toBe('Hel');
            expect(streamWriter._processedContent[1].content).toBe('lo');
        });
    });

    describe('Error handling', () => {
        it('handles HTTP 401 (Invalid API key)', async () => {
            mockResponse = createJsonResponse({
                error: { message: 'Invalid API key' }
            }, 401, false);

            await expect(apiManager.callApi('gpt-5.2', [], createMockTokenCounter()))
                .rejects.toThrow(/Invalid API key/);
        });

        it('handles HTTP 429 (Rate limit)', async () => {
            mockResponse = createJsonResponse({
                error: { message: 'Rate limit exceeded' }
            }, 429, false);

            await expect(apiManager.callApi('gpt-5.2', [], createMockTokenCounter()))
                .rejects.toThrow(/Rate limit exceeded/);
        });

        it('handles HTTP 500 (Server error)', async () => {
            mockResponse = createJsonResponse({
                error: { message: 'Internal server error' }
            }, 500, false);

            await expect(apiManager.callApi('gpt-5.2', [], createMockTokenCounter()))
                .rejects.toThrow(/Internal server error/);
        });

        it('handles network failure (fetch throws)', async () => {
            mockResponse = new Error('Network failure');

            await expect(apiManager.callApi('gpt-5.2', [], createMockTokenCounter()))
                .rejects.toThrow(/Network failure/);
        });
    });

    describe('Local Model Support', () => {
        it('detects local model via port pinging', async () => {
            const originalFetch = globalThis.fetch;
            try {
                fetchCalls = [];
                globalThis.fetch = async (url) => {
                    if (url.includes(':8080/v1/models')) {
                        return createJsonResponse({ data: [{ id: 'local-mistral' }] });
                    }
                    throw new Error('Connect failed');
                };

                const config = await apiManager.getLocalModelConfig();
                expect(config.raw).toBe('local-mistral');
                expect(config.display).toBe('Local Mistral');
                expect(config.port).toBe(8080);
            } finally {
                globalThis.fetch = originalFetch;
            }
        });
    });

    describe('Image Generation', () => {
        it('routes to createImageRequest for image models', async () => {
            const originalFetch = globalThis.fetch;
            try {
                mockResponse = createJsonResponse({
                    candidates: [{ content: { parts: [{ text: 'Generated image explanation' }] } }]
                });

                const messages = [{ role: 'user', parts: [{ type: 'text', content: 'Generate a cat' }] }];
                
                await apiManager.callApi('gemini-3-pro-image-preview', messages, createMockTokenCounter());

                expect(fetchCalls[0].url).toContain('generateContent');
                expect(fetchCalls[0].url).not.toContain('streamGenerateContent');
            } finally {
                globalThis.fetch = originalFetch;
            }
        });
    });
});
