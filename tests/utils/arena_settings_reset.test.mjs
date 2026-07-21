import { describe, test, expect } from 'bun:test';
import { parseHTML } from 'linkedom';

describe('SettingsUI arena reset', () => {
  test('replaces stale leaderboard rows when refresh fails after a successful wipe', async () => {
    const { document } = parseHTML(`
      <button id="reset" class="confirm">Reset Arena Matches</button>
      <div id="arena-leaderboard"><table><tr><td>Stale Model</td></tr></table></div>
    `);
    globalThis.document = document;
    globalThis.chrome = {
      storage: {
        local: { get: () => {} },
        onChanged: { addListener: () => {} }
      }
    };

    const { SettingsUI } = await import('../../src/js/settings.js');
    const settings = Object.create(SettingsUI.prototype);
    settings.arenaReady = Promise.resolve();
    settings.arenaRatingManager = { wipe: async () => {} };
    settings.renderArenaLeaderboard = async () => {
      throw new Error('read failed');
    };

    const button = document.getElementById('reset');
    await settings.handleArenaReset(button);

    const leaderboard = document.getElementById('arena-leaderboard');
    expect(leaderboard.dataset.state).toBe('error');
    expect(leaderboard.textContent).toContain('Could not load');
    expect(leaderboard.textContent).not.toContain('Stale Model');
    expect(button.textContent).toContain('Reset Arena Matches');
  });
});
