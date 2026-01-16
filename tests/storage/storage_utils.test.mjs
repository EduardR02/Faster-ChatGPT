import { describe, test, expect, beforeEach, spyOn } from 'bun:test';
import { setLifetimeTokens, getLifetimeTokens } from '../../src/js/storage_utils.js';

describe('storage_utils lifetime tokens', () => {
    let storage = {};
    
    beforeEach(() => {
        storage = {};
        global.chrome = {
            storage: {
                local: {
                    get: (keys, cb) => {
                        const res = {};
                        if (Array.isArray(keys)) {
                            keys.forEach(k => res[k] = storage[k]);
                        } else {
                            res[keys] = storage[keys];
                        }
                        cb(res);
                    },
                    set: (data, cb) => {
                        Object.assign(storage, data);
                        if (cb) cb();
                    }
                }
            },
            runtime: {
                // Mock sendMessage to fail to force applyLifetimeTokensDelta
                sendMessage: () => Promise.reject(new Error('no background'))
            }
        };
    });

    test('applyLifetimeTokensDelta serialization and queueing', async () => {
        // We call setLifetimeTokens multiple times rapidly.
        // We delete chrome.runtime.sendMessage to force it to use applyLifetimeTokensDelta
        delete global.chrome.runtime.sendMessage;
        
        const p1 = setLifetimeTokens(10, 20);
        const p2 = setLifetimeTokens(5, 5);
        const p3 = setLifetimeTokens(1, 1);
        
        // setLifetimeTokens doesn't return a promise, it's fire-and-forget.
        // But it updates the internal 'lifetimeTokensUpdate' promise.
        // We need to wait for the storage to actually reflect the changes.
        // Since we can't access the internal promise directly easily, 
        // we can poll or use a small delay if deterministic logic is hard.
        // Actually, let's just mock storage.local.set to track calls.

        let totalSets = 0;
        const originalSet = global.chrome.storage.local.set;
        global.chrome.storage.local.set = (data, cb) => {
            originalSet(data, () => {
                totalSets++;
                if (cb) cb();
            });
        };

        // We need to wait for 3 sets to happen.
        for (let i = 0; i < 20; i++) {
            if (totalSets === 3) break;
            await new Promise(r => setTimeout(r, 10));
        }
        
        return new Promise(resolve => {
            getLifetimeTokens(current => {
                expect(current.input).toBe(16);
                expect(current.output).toBe(26);
                resolve();
            });
        });
    });
});
