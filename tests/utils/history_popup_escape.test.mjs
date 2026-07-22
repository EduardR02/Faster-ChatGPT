import { describe, expect, test } from 'bun:test';
import { parseHTML } from 'linkedom';
import { attachHistoryPopupEscape } from '../../src/js/history_popup_trigger.js';

const createHarness = () => {
  const { document, window } = parseHTML(`
    <div class="history-list">
      <div class="history-item"><button class="action-dots"></button></div>
    </div>
    <div class="popup-menu">
      <button type="button" class="popup-action" data-action="rename">Rename</button>
    </div>
  `);
  const popup = document.querySelector('.popup-menu');
  const state = { closes: 0 };
  attachHistoryPopupEscape(popup, () => { state.closes += 1; });
  return { document, window, popup, state };
};

const dispatchKey = (window, target, key) => {
  const event = new window.Event('keydown', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'key', { value: key });
  target.dispatchEvent(event);
  return event;
};

describe('history popup Escape wiring', () => {
  test('closes an active popup when Escape is pressed outside it (mouse-opened)', () => {
    const { document, window, popup, state } = createHarness();
    popup.classList.add('active');

    const event = dispatchKey(window, document.querySelector('.action-dots'), 'Escape');

    expect(state.closes).toBe(1);
    expect(event.defaultPrevented).toBe(true);
  });

  test('closes an active popup when Escape is pressed inside it (keyboard-opened), exactly once', () => {
    const { document, window, popup, state } = createHarness();
    popup.classList.add('active');

    const event = dispatchKey(window, popup.querySelector('.popup-action'), 'Escape');

    expect(state.closes).toBe(1);
    expect(event.defaultPrevented).toBe(true);
  });

  test('ignores Escape when the popup is not open', () => {
    const { document, window, state } = createHarness();

    const event = dispatchKey(window, document.querySelector('.action-dots'), 'Escape');

    expect(state.closes).toBe(0);
    expect(event.defaultPrevented).toBe(false);
  });

  test('ignores non-Escape keys', () => {
    const { document, window, popup, state } = createHarness();
    popup.classList.add('active');

    dispatchKey(window, document.querySelector('.action-dots'), 'Enter');
    dispatchKey(window, popup.querySelector('.popup-action'), 'a');

    expect(state.closes).toBe(0);
  });
});
