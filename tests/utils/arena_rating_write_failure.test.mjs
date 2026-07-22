import { describe, test, expect, beforeEach } from 'bun:test';
import { IDBFactory } from 'fake-indexeddb';
import { ArenaRatingManager } from '../../src/js/ArenaRatingManager.js';

describe('ArenaRatingManager recovery after rejected ratings writes', () => {
  let storage;

  const createLockManager = () => {
    const tails = new Map();
    return {
      request(name, callback) {
        const previous = tails.get(name) || Promise.resolve();
        const result = previous.catch(() => {}).then(callback);
        tails.set(name, result);
        return result;
      }
    };
  };

  const createFailableStorage = () => {
    const values = new Map();
    let failSets = false;
    return {
      values,
      setFailSets(value) {
        failSets = value;
      },
      local: {
        get(keys, callback) {
          const result = {};
          const keyList = Array.isArray(keys) ? keys : [keys];
          keyList.forEach(key => {
            if (values.has(key)) result[key] = structuredClone(values.get(key));
          });
          if (callback) callback(result);
          return Promise.resolve(result);
        },
        set(items) {
          if (failSets) return Promise.reject(new Error('storage write failed'));
          const snapshot = structuredClone(items);
          Object.entries(snapshot).forEach(([key, value]) => values.set(key, value));
          return Promise.resolve();
        },
        remove(key) {
          values.delete(key);
          return Promise.resolve();
        }
      }
    };
  };

  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
    storage = createFailableStorage();
    Object.defineProperty(globalThis, 'navigator', {
      value: { locks: createLockManager() },
      configurable: true,
      writable: true
    });
    globalThis.chrome = {
      storage: {
        local: storage.local
      }
    };
  });

  test('a rejected write rejects the triggering add but cached ratings stay usable', async () => {
    const manager = new ArenaRatingManager('WriteFailureCachedDB');
    await manager.initDB();
    storage.setFailSets(true);

    await expect(manager.addMatchAndUpdate('a', 'b', 'model_a')).rejects.toThrow('storage write failed');

    expect(manager.getModelRating('a')).toBe(1020);
    expect(manager.getModelRating('b')).toBe(980);
  });

  test('a later add recovers once storage writes succeed again', async () => {
    const manager = new ArenaRatingManager('WriteFailureAddRecoveryDB');
    await manager.initDB();
    storage.setFailSets(true);
    await expect(manager.addMatchAndUpdate('a', 'b', 'model_a')).rejects.toThrow('storage write failed');

    storage.setFailSets(false);
    const ratings = await manager.addMatchAndUpdate('a', 'b', 'model_a');

    expect(ratings.a.rating).toBe(1020);
    expect(ratings.b.rating).toBe(980);
    expect(storage.values.get('elo_ratings')).toEqual(ratings);
  });

  test('recalculate after a rejected write rebuilds from full match history', async () => {
    const manager = new ArenaRatingManager('WriteFailureRecalculateDB');
    await manager.initDB();
    storage.setFailSets(true);
    await expect(manager.addMatchAndUpdate('a', 'b', 'model_a')).rejects.toThrow('storage write failed');
    await expect(manager.addMatchAndUpdate('a', 'b', 'model_a')).rejects.toThrow('storage write failed');

    storage.setFailSets(false);
    const ratings = await manager.recalculate();

    expect(ratings.a.count).toBe(2);
    expect(ratings.b.count).toBe(2);
    expect(ratings.a.rating).toBeGreaterThan(1020);
    expect(ratings.b.rating).toBeLessThan(980);
    expect(storage.values.get('elo_ratings')).toEqual(ratings);
  });

  test('wipe after a rejected write still clears ratings and matches', async () => {
    const manager = new ArenaRatingManager('WriteFailureWipeDB');
    await manager.initDB();
    storage.setFailSets(true);
    await expect(manager.addMatchAndUpdate('a', 'b', 'model_a')).rejects.toThrow('storage write failed');

    storage.setFailSets(false);
    await manager.wipe();

    expect(manager.cachedRatings).toEqual({});
    expect(storage.values.has('elo_ratings')).toBe(false);
    expect(await manager.getHistory()).toEqual([]);

    const ratings = await manager.addMatchAndUpdate('c', 'd', 'model_b');
    expect(ratings.d.rating).toBe(1020);
    expect(ratings.c.rating).toBe(980);
    expect(storage.values.get('elo_ratings')).toEqual(ratings);
  });
});
