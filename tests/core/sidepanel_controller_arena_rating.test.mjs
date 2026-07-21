import { describe, test, expect } from 'bun:test';
import { SidepanelController } from '../../src/js/sidepanel_controller.js';

describe('SidepanelController arena rating persistence', () => {
  test('waits for the rating update before displaying Elo values', async () => {
    const controller = Object.create(SidepanelController.prototype);
    let finishRatingUpdate;
    let displayedRatings;
    let currentRatings = [1000, 1000];

    controller.chatCore = {
      getLatestMessage: () => ({ continued_with: null }),
      updateArenaMisc: async () => {}
    };
    controller.chatUI = {
      removeArenaFooter: () => {},
      resolveArena: (_choice, _continuedWith, _unused, ratings) => {
        displayedRatings = ratings;
      },
      ensureLatestAssistantRegenerate: () => {}
    };
    controller.state = {
      getArenaModels: () => ['a', 'b'],
      clearArenaState: () => {}
    };
    controller.arenaRating = {
      addMatchAndUpdate: () => new Promise(resolve => {
        finishRatingUpdate = () => {
          currentRatings = [1020, 980];
          resolve();
        };
      }),
      getModelRating: model => currentRatings[model === 'a' ? 0 : 1]
    };
    controller.regenerateArenaMessage = () => {};

    const choice = controller.handleArenaChoice('model_a');
    await Promise.resolve();

    expect(displayedRatings).toBeUndefined();
    finishRatingUpdate();
    await choice;

    expect(displayedRatings).toEqual([1020, 980]);
  });
});
