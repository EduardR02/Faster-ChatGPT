import { describe, test, expect, beforeEach } from 'bun:test';
import { ArenaRatingManager } from '../../src/js/ArenaRatingManager.js';

// Mock chrome.storage.local
globalThis.chrome = {
  storage: {
    local: {
      get: (keys, cb) => {
        if (cb) cb({});
        return Promise.resolve({});
      },
      set: (obj, cb) => {
        if (cb) cb();
        return Promise.resolve();
      }
    }
  }
};

describe('Elo rating calculations', () => {
  let manager;

  beforeEach(() => {
    manager = new ArenaRatingManager();
    manager.cachedRatings = {};
  });

  test('single match updates ratings correctly', () => {
    const matches = [
      { model_a: 'gpt-4', model_b: 'claude', result: 'model_a' }
    ];
    
    const ratings = manager.calculateElo(matches);
    
    expect(ratings['gpt-4'].rating).toBeGreaterThan(1000);
    expect(ratings['claude'].rating).toBeLessThan(1000);
    // Sum should be close to 2000 (rating is transferred, not created)
    expect(ratings['gpt-4'].rating + ratings['claude'].rating).toBeCloseTo(2000, 0);
  });
  
  test('draw keeps ratings balanced', () => {
    const matches = [
      { model_a: 'gpt-4', model_b: 'claude', result: 'draw' }
    ];
    
    const ratings = manager.calculateElo(matches);
    
    // Equal starting ratings + draw = no change
    expect(ratings['gpt-4'].rating).toBeCloseTo(1000, 0);
    expect(ratings['claude'].rating).toBeCloseTo(1000, 0);
  });
  
  test('reveal/ignored does not affect ratings', () => {
    const matches = [
      { model_a: 'gpt-4', model_b: 'claude', result: 'reveal' },
      { model_a: 'gpt-4', model_b: 'claude', result: 'ignored' },
      { model_a: 'gpt-4', model_b: 'claude', result: 'draw(bothbad)' }
    ];
    
    const ratings = manager.calculateElo(matches);
    
    expect(ratings['gpt-4'].rating).toBe(1000);
    expect(ratings['claude'].rating).toBe(1000);
  });
  
  test('multiple matches converge ratings', () => {
    // Model A wins consistently
    const matches = Array(10).fill(null).map(() => ({
      model_a: 'gpt-4', model_b: 'claude', result: 'model_a'
    }));
    
    const ratings = manager.calculateElo(matches);
    
    // After 10 wins, GPT-4 should be significantly higher
    expect(ratings['gpt-4'].rating).toBeGreaterThan(1100);
    expect(ratings['claude'].rating).toBeLessThan(900);
    expect(ratings['gpt-4'].count).toBe(10);
    expect(ratings['claude'].count).toBe(10);
  });
  
  test('three-way competition', () => {
    const matches = [
      { model_a: 'gpt-4', model_b: 'claude', result: 'model_a' },
      { model_a: 'claude', model_b: 'gemini', result: 'model_a' },
      { model_a: 'gemini', model_b: 'gpt-4', result: 'model_a' }  // Gemini beats GPT-4!
    ];
    
    const ratings = manager.calculateElo(matches);
    
    // All three should have ratings (cyclic wins)
    expect(Object.keys(ratings)).toHaveLength(3);
  });

  test('exact Elo calculation: 1000 vs 1000, model_a wins', () => {
    const matches = [{ model_a: 'a', model_b: 'b', result: 'model_a' }];
    const ratings = manager.calculateElo(matches);

    // Ra = 1000, Rb = 1000, K = 40
    // Ea = 1 / (1 + 10^((1000-1000)/400)) = 1 / (1 + 1) = 0.5
    // Ra' = 1000 + 40 * (1 - 0.5) = 1000 + 20 = 1020
    // Rb' = 1000 + 40 * (0 - 0.5) = 1000 - 20 = 980
    expect(ratings['a'].rating).toBeCloseTo(1020, 5);
    expect(ratings['b'].rating).toBeCloseTo(980, 5);
  });

  test('exact Elo calculation: 1200 vs 1000, model_a wins', () => {
    manager.cachedRatings = {
      'a': { rating: 1200, count: 0 },
      'b': { rating: 1000, count: 0 }
    };
    const matches = [{ model_a: 'a', model_b: 'b', result: 'model_a' }];
    const ratings = manager.calculateElo(matches);

    // Ra = 1200, Rb = 1000, K = 40
    // Ea = 1 / (1 + 10^((1000-1200)/400)) = 1 / (1 + 10^(-0.5))
    // 10^(-0.5) = 1 / sqrt(10) ≈ 0.316227766
    // Ea = 1 / (1 + 0.316227766) ≈ 1 / 1.316227766 ≈ 0.7597469
    // Ra' = 1200 + 40 * (1 - 0.7597469) = 1200 + 40 * 0.2402531 ≈ 1200 + 9.610124 = 1209.610124
    // Rb' = 1000 + 40 * (0 - 0.2402531) = 1000 - 9.610124 = 990.389876
    expect(ratings['a'].rating).toBeCloseTo(1209.610124, 5);
    expect(ratings['b'].rating).toBeCloseTo(990.389876, 5);
  });

  test('exact Elo calculation: high rating difference (1000 vs 2000), underdog wins', () => {
    manager.cachedRatings = {
      'underdog': { rating: 1000, count: 0 },
      'pro': { rating: 2000, count: 0 }
    };
    const matches = [{ model_a: 'underdog', model_b: 'pro', result: 'model_a' }];
    const ratings = manager.calculateElo(matches);

    // Ra = 1000, Rb = 2000, K = 40
    // Ea = 1 / (1 + 10^((2000-1000)/400)) = 1 / (1 + 10^2.5)
    // 10^2.5 = 10^2 * 10^0.5 = 100 * sqrt(10) ≈ 316.227766
    // Ea = 1 / (1 + 316.227766) = 1 / 317.227766 ≈ 0.0031523
    // Ra' = 1000 + 40 * (1 - 0.0031523) = 1000 + 40 * 0.9968477 ≈ 1000 + 39.873908 = 1039.873908
    // Rb' = 2000 + 40 * (0 - 0.9968477) = 2000 - 39.873908 = 1960.126092
    expect(ratings['underdog'].rating).toBeCloseTo(1039.873908, 5);
    expect(ratings['pro'].rating).toBeCloseTo(1960.126092, 5);
  });

  test('K-factor changes after 30 matches', () => {
    manager.cachedRatings = {
      'veteran': { rating: 1000, count: 30 },
      'newbie': { rating: 1000, count: 0 }
    };
    const matches = [{ model_a: 'veteran', model_b: 'newbie', result: 'model_a' }];
    const ratings = manager.calculateElo(matches);

    // Ra = 1000, Rb = 1000
    // Ea = 0.5
    // veteran count >= 30 -> K = 20
    // newbie count < 30 -> K = 40
    // Ra' = 1000 + 20 * (1 - 0.5) = 1010
    // Rb' = 1000 + 40 * (0 - 0.5) = 980
    expect(ratings['veteran'].rating).toBe(1010);
    expect(ratings['newbie'].rating).toBe(980);
    // Note: In this implementation, ratings are not necessarily zero-sum when K-factors differ!
    // Sum = 1010 + 980 = 1990 (lost 10 points)
  });
});
