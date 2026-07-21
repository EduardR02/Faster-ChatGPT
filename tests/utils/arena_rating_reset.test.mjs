import { describe, test, expect, beforeEach } from 'bun:test';
import { IDBFactory } from 'fake-indexeddb';
import { ArenaRatingManager } from '../../src/js/ArenaRatingManager.js';

describe('ArenaRatingManager cross-context reset', () => {
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

  const waitFor = async (condition) => {
    for (let attempt = 0; attempt < 50; attempt++) {
      if (condition()) return;
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    throw new Error('Timed out waiting for asynchronous operation');
  };

  const createDelayedStorage = () => {
    const values = new Map();
    const pendingSets = [];
    const pendingRemoves = [];
    let delaySets = false;
    let delayRemoves = false;

    return {
      values,
      pendingSets,
      pendingRemoves,
      setDelaySets(value) {
        delaySets = value;
      },
      setDelayRemoves(value) {
        delayRemoves = value;
      },
      releaseSet() {
        pendingSets.shift()?.();
      },
      releaseRemove() {
        pendingRemoves.shift()?.();
      },
      local: {
        get(keys, callback) {
          const result = {};
          const keyList = Array.isArray(keys) ? keys : [keys];
          keyList.forEach(key => {
            if (values.has(key)) result[key] = structuredClone(values.get(key));
          });
          callback(result);
        },
        set(items) {
          const snapshot = structuredClone(items);
          const apply = () => Object.entries(snapshot).forEach(([key, value]) => values.set(key, value));
          if (!delaySets) {
            apply();
            return Promise.resolve();
          }
          return new Promise(resolve => pendingSets.push(() => {
            apply();
            resolve();
          }));
        },
        remove(key) {
          const apply = () => values.delete(key);
          if (!delayRemoves) {
            apply();
            return Promise.resolve();
          }
          return new Promise(resolve => pendingRemoves.push(() => {
            apply();
            resolve();
          }));
        }
      }
    };
  };

  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
    storage = createDelayedStorage();
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

  test('an open manager does not resurrect ratings wiped by another context', async () => {
    const activeManager = new ArenaRatingManager('ResetTestDB');
    await activeManager.initDB();
    activeManager.calculateElo([{ model_a: 'old-a', model_b: 'old-b', result: 'model_a' }]);

    const resetManager = new ArenaRatingManager('ResetTestDB');
    await resetManager.initDB();
    await resetManager.wipe();

    expect(activeManager.cachedRatings).toHaveProperty('old-a');

    const ratings = await activeManager.addMatchAndUpdate('new-a', 'new-b', 'model_a');

    expect(ratings).not.toHaveProperty('old-a');
    expect(ratings).not.toHaveProperty('old-b');
    expect(ratings['new-a'].rating).toBe(1020);
    expect(ratings['new-b'].rating).toBe(980);
    expect(storage.values.get('elo_ratings')).toEqual(ratings);
    expect(await activeManager.getHistory()).toEqual([
      expect.objectContaining({ model_a: 'new-a', model_b: 'new-b', result: 'model_a' })
    ]);
  });

  test('refreshing the cache preserves consecutive match updates', async () => {
    const manager = new ArenaRatingManager('ConsecutiveMatchesDB');
    await manager.initDB();

    await manager.addMatchAndUpdate('a', 'b', 'model_a');
    const ratings = await manager.addMatchAndUpdate('a', 'b', 'model_a');

    expect(ratings.a.count).toBe(2);
    expect(ratings.b.count).toBe(2);
    expect(ratings.a.rating).toBeGreaterThan(1020);
    expect(ratings.b.rating).toBeLessThan(980);
    expect(storage.values.get('elo_ratings')).toEqual(ratings);
  });

  test('sequential updates wait for durable ratings writes before reloading', async () => {
    const manager = new ArenaRatingManager('DelayedWritesDB');
    await manager.initDB();
    storage.setDelaySets(true);

    let firstResolved = false;
    const first = manager.addMatchAndUpdate('a', 'b', 'model_a').then(ratings => {
      firstResolved = true;
      return ratings;
    });
    await waitFor(() => storage.pendingSets.length === 1);

    const second = manager.addMatchAndUpdate('a', 'b', 'model_a');
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(firstResolved).toBe(false);
    expect(storage.pendingSets).toHaveLength(1);

    storage.releaseSet();
    await waitFor(() => storage.pendingSets.length === 1);
    storage.releaseSet();

    await first;
    const ratings = await second;
    expect(ratings.a.count).toBe(2);
    expect(ratings.b.count).toBe(2);
    expect(storage.values.get('elo_ratings')).toEqual(ratings);
  });

  test('wipe queued behind an update cannot leave resurrected ratings', async () => {
    const activeManager = new ArenaRatingManager('AddThenWipeDB');
    const resetManager = new ArenaRatingManager('AddThenWipeDB');
    await Promise.all([activeManager.initDB(), resetManager.initDB()]);
    storage.setDelaySets(true);

    const add = activeManager.addMatchAndUpdate('a', 'b', 'model_a');
    await waitFor(() => storage.pendingSets.length === 1);
    const wipe = resetManager.wipe();

    storage.releaseSet();
    await Promise.all([add, wipe]);

    expect(storage.values.has('elo_ratings')).toBe(false);
    expect(await activeManager.getHistory()).toEqual([]);
  });

  test('update queued behind a wipe is retained as the new first match', async () => {
    const activeManager = new ArenaRatingManager('WipeThenAddDB');
    const resetManager = new ArenaRatingManager('WipeThenAddDB');
    await Promise.all([activeManager.initDB(), resetManager.initDB()]);
    await activeManager.addMatchAndUpdate('old-a', 'old-b', 'model_a');
    storage.setDelayRemoves(true);

    const wipe = resetManager.wipe();
    await waitFor(() => storage.pendingRemoves.length === 1);
    const add = activeManager.addMatchAndUpdate('new-a', 'new-b', 'model_a');

    storage.releaseRemove();
    await wipe;
    const ratings = await add;

    expect(ratings).not.toHaveProperty('old-a');
    expect(ratings['new-a'].count).toBe(1);
    expect(storage.values.get('elo_ratings')).toEqual(ratings);
    expect(await activeManager.getHistory()).toEqual([
      expect.objectContaining({ model_a: 'new-a', model_b: 'new-b', result: 'model_a' })
    ]);
  });
});
