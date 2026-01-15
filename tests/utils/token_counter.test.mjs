import { TokenCounter } from '../../src/js/TokenCounter.js';
import { createChromeMock, assertDeepEqual } from '../setup.mjs';
import { describe, test, beforeEach } from 'bun:test';

// Setup chrome mock globally for these tests as storage_utils depends on it
const chromeMock = createChromeMock();
globalThis.chrome = chromeMock;

/**
 * Tests for TokenCounter class.
 * 
 * TokenCounter is responsible for:
 * 1. Maintaining a running count of input and output tokens for a session.
 * 2. Handling provider-specific counting logic (e.g., Gemini's cumulative counts vs others' deltas).
 * 3. Persisting lifetime token usage.
 */

describe('TokenCounter', () => {
    
    describe('Basic counting', () => {
        test('initializes with zero tokens', () => {
            const counter = new TokenCounter('openai');
            assertDeepEqual(counter.inputTokens, 0);
            assertDeepEqual(counter.outputTokens, 0);
        });

        test('accumulates tokens for delta-based providers (openai)', () => {
            const counter = new TokenCounter('openai');
            
            counter.update(10, 5);
            assertDeepEqual(counter.inputTokens, 10);
            assertDeepEqual(counter.outputTokens, 5);

            counter.update(20, 15);
            assertDeepEqual(counter.inputTokens, 30);
            assertDeepEqual(counter.outputTokens, 20);
        });

        test('handles partial updates (only input)', () => {
            const counter = new TokenCounter('anthropic');
            counter.update(100, undefined);
            assertDeepEqual(counter.inputTokens, 100);
            assertDeepEqual(counter.outputTokens, 0);
        });

        test('handles partial updates (only output)', () => {
            const counter = new TokenCounter('anthropic');
            counter.update(undefined, 50);
            assertDeepEqual(counter.inputTokens, 0);
            assertDeepEqual(counter.outputTokens, 50);
        });

        test('verify counting is deterministic', () => {
            const counter1 = new TokenCounter('openai');
            const counter2 = new TokenCounter('openai');
            
            const inputs = [[10, 5], [20, 30], [5, 5]];
            
            inputs.forEach(([i, o]) => {
                counter1.update(i, o);
                counter2.update(i, o);
            });

            assertDeepEqual(counter1.inputTokens, counter2.inputTokens);
            assertDeepEqual(counter1.outputTokens, counter2.outputTokens);
            assertDeepEqual(counter1.inputTokens, 35);
            assertDeepEqual(counter1.outputTokens, 40);
        });
    });

    describe('Provider-specific counting (Gemini)', () => {
        test('uses cumulative counts for Gemini', () => {
            const counter = new TokenCounter('gemini');
            
            // First update
            counter.update(10, 5);
            assertDeepEqual(counter.inputTokens, 10);
            assertDeepEqual(counter.outputTokens, 5);

            // Second update provides total count so far, not delta
            counter.update(25, 12);
            assertDeepEqual(counter.inputTokens, 25);
            assertDeepEqual(counter.outputTokens, 12);
            
            // Third update
            counter.update(30, 20);
            assertDeepEqual(counter.inputTokens, 30);
            assertDeepEqual(counter.outputTokens, 20);
        });

        test('gemini handles updates that decrease', () => {
            const counter = new TokenCounter('gemini');
            counter.update(100, 100);
            counter.update(50, 50);
            assertDeepEqual(counter.inputTokens, 50);
            assertDeepEqual(counter.outputTokens, 50);
        });
    });

    describe('Lifetime token persistence', () => {
        beforeEach(() => {
            // Reset storage before each test
            const newMock = createChromeMock();
            globalThis.chrome.storage = newMock.storage;
            globalThis.chrome.runtime = newMock.runtime;
        });

        test('updates lifetime tokens via storage', async () => {
            const counter = new TokenCounter('openai');
            counter.update(100, 50);
            
            // Bypass sendMessage and the retry delays by mocking chrome.runtime.sendMessage to be undefined
            // This makes setLifetimeTokens use applyLifetimeTokensDelta directly.
            const originalSendMessage = chrome.runtime.sendMessage;
            chrome.runtime.sendMessage = undefined;

            try {
                counter.updateLifetimeTokens();
                
                // wait for the storage update promise chain to resolve
                await new Promise(resolve => setTimeout(resolve, 0));
                
                const storage = await chrome.storage.local.get(['lifetime_input_tokens', 'lifetime_output_tokens']);
                assertDeepEqual(storage.lifetime_input_tokens, 100);
                assertDeepEqual(storage.lifetime_output_tokens, 50);
            } finally {
                chrome.runtime.sendMessage = originalSendMessage;
            }
        });
    });

    describe('Edge cases', () => {
        test('handles zero tokens', () => {
            const counter = new TokenCounter('openai');
            counter.update(0, 0);
            assertDeepEqual(counter.inputTokens, 0);
            assertDeepEqual(counter.outputTokens, 0);
        });

        test('handles large token counts', () => {
            const counter = new TokenCounter('openai');
            const large = 1_000_000_000;
            counter.update(large, large);
            assertDeepEqual(counter.inputTokens, large);
            assertDeepEqual(counter.outputTokens, large);
        });

        test('ignores non-numeric inputs', () => {
            const counter = new TokenCounter('openai');
            counter.update('10', { count: 5 });
            assertDeepEqual(counter.inputTokens, 0);
            assertDeepEqual(counter.outputTokens, 0);
        });
    });
});
