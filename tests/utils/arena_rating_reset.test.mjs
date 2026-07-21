import { describe, test, expect, beforeEach } from 'bun:test';
import { IDBFactory } from 'fake-indexeddb';
import { ArenaRatingManager } from '../../src/js/ArenaRatingManager.js';

describe('ArenaRatingManager cross-context reset', () => {
  let localStorage;

  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
    localStorage = new Map();
    globalThis.chrome = {
      storage: {
        local: {
          get(keys, callback) {
            const result = {};
            keys.forEach(key => {
              if (localStorage.has(key)) result[key] = localStorage.get(key);
            });
            callback(result);
          },
          set(items) {
            Object.entries(items).forEach(([key, value]) => localStorage.set(key, value));
            return Promise.resolve();
          },
          remove(key) {
            localStorage.delete(key);
            return Promise.resolve();
          }
        }
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
    expect(localStorage.get('elo_ratings')).toEqual(ratings);
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
    expect(localStorage.get('elo_ratings')).toEqual(ratings);
  });
});
