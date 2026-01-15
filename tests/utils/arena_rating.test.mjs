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
});
