import { describe, test, expect } from 'bun:test';
import { SidepanelController } from '../../src/js/sidepanel_controller.js';

describe('SidepanelController arena rating failure', () => {
  test('resolves the arena with cached ratings when the rating update fails', async () => {
    const controller = Object.create(SidepanelController.prototype);
    const calls = { resolved: null, cleared: 0, regenerate: 0 };

    controller.chatCore = {
      getLatestMessage: () => ({ continued_with: null }),
      updateArenaMisc: async () => {}
    };
    controller.chatUI = {
      removeArenaFooter: () => {},
      resolveArena: (choice, _continuedWith, _unused, ratings) => {
        calls.resolved = { choice, ratings };
      },
      ensureLatestAssistantRegenerate: () => {
        calls.regenerate += 1;
      }
    };
    controller.state = {
      getArenaModels: () => ['a', 'b'],
      clearArenaState: () => {
        calls.cleared += 1;
      }
    };
    controller.arenaRating = {
      addMatchAndUpdate: async () => {
        throw new Error('storage write failed');
      },
      getModelRating: model => (model === 'a' ? 1020 : 980)
    };
    controller.regenerateArenaMessage = () => {};

    await controller.handleArenaChoice('model_a');

    expect(calls.resolved).toEqual({ choice: 'model_a', ratings: [1020, 980] });
    expect(calls.cleared).toBe(1);
    expect(calls.regenerate).toBe(1);
  });
});
