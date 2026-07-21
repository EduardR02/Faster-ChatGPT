import { describe, test, expect, beforeEach } from 'bun:test';
import { parseHTML } from 'linkedom';
import { computeLeaderboard, renderLeaderboard, resolveDisplayNames } from '../../src/js/arena_leaderboard.js';

describe('resolveDisplayNames', () => {
  test('flattens provider map into apiName -> displayName', () => {
    const models = {
      openai: { 'gpt-5': 'GPT-5' },
      anthropic: { 'claude-opus': 'Claude Opus', 'claude-sonnet': 'Claude Sonnet' }
    };
    expect(resolveDisplayNames(models)).toEqual({
      'gpt-5': 'GPT-5',
      'claude-opus': 'Claude Opus',
      'claude-sonnet': 'Claude Sonnet'
    });
  });

  test('handles empty and missing settings', () => {
    expect(resolveDisplayNames()).toEqual({});
    expect(resolveDisplayNames({})).toEqual({});
  });
});

describe('computeLeaderboard', () => {
  test('returns empty array when there is no data', () => {
    expect(computeLeaderboard([], {})).toEqual([]);
    expect(computeLeaderboard()).toEqual([]);
  });

  test('aggregates wins, draws and losses from rated matches', () => {
    const matches = [
      { model_a: 'a', model_b: 'b', result: 'model_a' },
      { model_a: 'a', model_b: 'b', result: 'model_b' },
      { model_a: 'a', model_b: 'b', result: 'draw' }
    ];
    const entries = computeLeaderboard(matches, {});

    const a = entries.find(e => e.modelId === 'a');
    const b = entries.find(e => e.modelId === 'b');
    expect(a).toMatchObject({ matches: 3, wins: 1, draws: 1, losses: 1 });
    expect(b).toMatchObject({ matches: 3, wins: 1, draws: 1, losses: 1 });
  });

  test('unrated results establish presence but no record', () => {
    const matches = [
      { model_a: 'a', model_b: 'b', result: 'reveal' },
      { model_a: 'a', model_b: 'b', result: 'ignored' },
      { model_a: 'a', model_b: 'b', result: 'draw(bothbad)' }
    ];
    const entries = computeLeaderboard(matches, {});

    expect(entries).toHaveLength(2);
    entries.forEach(entry => {
      expect(entry).toMatchObject({ matches: 0, wins: 0, draws: 0, losses: 0, rating: 1000 });
    });
  });

  test('single model with only a cached rating is listed with an empty record', () => {
    const entries = computeLeaderboard([], { solo: { rating: 1050, count: 0 } });

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ modelId: 'solo', rating: 1050, matches: 0, wins: 0, draws: 0, losses: 0 });
  });

  test('rating comes from the cache, falling back to 1000', () => {
    const matches = [{ model_a: 'a', model_b: 'b', result: 'model_a' }];
    const entries = computeLeaderboard(matches, { a: { rating: 1020, count: 1 } });

    expect(entries.find(e => e.modelId === 'a').rating).toBe(1020);
    expect(entries.find(e => e.modelId === 'b').rating).toBe(1000);
  });

  test('sorts by rating descending, then matches, then model id', () => {
    const ratings = {
      high: { rating: 1200, count: 5 },
      midBusy: { rating: 1100, count: 10 },
      midIdle: { rating: 1100, count: 2 },
      low: { rating: 900, count: 8 }
    };
    const entries = computeLeaderboard([], ratings);

    expect(entries.map(e => e.modelId)).toEqual(['high', 'midBusy', 'midIdle', 'low']);
  });

  test('does not mutate the input matches', () => {
    const matches = [{ model_a: 'a', model_b: 'b', result: 'model_a' }];
    const snapshot = JSON.parse(JSON.stringify(matches));
    computeLeaderboard(matches, {});
    expect(matches).toEqual(snapshot);
  });
});

describe('renderLeaderboard', () => {
  let document;
  let container;

  beforeEach(() => {
    ({ document } = parseHTML('<div id="arena-leaderboard"></div>'));
    globalThis.document = document;
    container = document.getElementById('arena-leaderboard');
  });

  test('empty state shows a message and no table', () => {
    renderLeaderboard(container, [], {});

    expect(container.dataset.state).toBe('empty');
    expect(container.querySelector('table')).toBeNull();
    expect(container.querySelector('.arena-leaderboard-empty').textContent).toContain('No arena matches');
  });

  test('replaces previous content when re-rendered', () => {
    renderLeaderboard(container, [], {});
    const entries = computeLeaderboard([{ model_a: 'a', model_b: 'b', result: 'model_a' }], {});
    renderLeaderboard(container, entries, {});

    expect(container.dataset.state).toBe('populated');
    expect(container.querySelectorAll('.arena-leaderboard-empty')).toHaveLength(0);
    expect(container.querySelectorAll('tbody tr')).toHaveLength(2);
  });

  test('populated state renders ranked rows with display names and formatted values', () => {
    const matches = [
      { model_a: 'gpt-5', model_b: 'claude-opus', result: 'model_a' },
      { model_a: 'gpt-5', model_b: 'claude-opus', result: 'model_a' },
      { model_a: 'gpt-5', model_b: 'claude-opus', result: 'draw' }
    ];
    const ratings = {
      'gpt-5': { rating: 1039.67, count: 3 },
      'claude-opus': { rating: 960.33, count: 3 }
    };
    const entries = computeLeaderboard(matches, ratings);
    renderLeaderboard(container, entries, { 'gpt-5': 'GPT-5' });

    const headerCells = [...container.querySelectorAll('th')].map(th => th.textContent);
    expect(headerCells).toEqual(['#', 'Model', 'Elo', 'Matches', 'W-D-L', 'Win%']);

    const rows = container.querySelectorAll('tbody tr');
    expect(rows).toHaveLength(2);

    const winnerCells = [...rows[0].querySelectorAll('td')].map(td => td.textContent);
    expect(winnerCells).toEqual(['1', 'GPT-5', '1039.7', '3', '2-1-0', '83%']);

    // Unknown model falls back to its API name
    const loserCells = [...rows[1].querySelectorAll('td')].map(td => td.textContent);
    expect(loserCells).toEqual(['2', 'claude-opus', '960.3', '3', '0-1-2', '17%']);
  });

  test('single model renders a single row without a win rate', () => {
    const entries = computeLeaderboard([], { solo: { rating: 1000, count: 0 } });
    renderLeaderboard(container, entries, { solo: 'Solo Model' });

    const rows = container.querySelectorAll('tbody tr');
    expect(rows).toHaveLength(1);
    const cells = [...rows[0].querySelectorAll('td')].map(td => td.textContent);
    expect(cells).toEqual(['1', 'Solo Model', '1000', '0', '0-0-0', '—']);
  });

  test('model names are inserted as text, not HTML', () => {
    const entries = computeLeaderboard([], { '<img src=x onerror=alert(1)>': { rating: 1000, count: 0 } });
    renderLeaderboard(container, entries, {});

    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('.arena-leaderboard-model').textContent).toBe('<img src=x onerror=alert(1)>');
  });
});
