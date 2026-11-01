import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installTouchPressFeedback, MIN_PRESSED_MS } from '../press-feedback';

const pointer = (target: Element, type: string, pointerType = 'touch') => {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'pointerType', { value: pointerType });
  target.dispatchEvent(event);
  return event;
};

describe('installTouchPressFeedback', () => {
  let clock = 0;
  let uninstall: () => void;

  beforeEach(() => {
    vi.useFakeTimers();
    clock = 0;
    document.body.innerHTML = `
      <button id="pay"><span id="label">Pay</span></button>
      <button id="off" disabled>Off</button>
      <div id="plain">Text</div>`;
    uninstall = installTouchPressFeedback(document, () => clock);
  });

  afterEach(() => {
    uninstall();
    vi.useRealTimers();
  });

  const pay = () => document.getElementById('pay')!;

  it('marks the touched control from touch-down until release, without cancelling the event', () => {
    const down = pointer(document.getElementById('label')!, 'pointerdown');
    expect(pay().hasAttribute('data-pressed')).toBe(true);
    expect(down.defaultPrevented).toBe(false);

    clock = MIN_PRESSED_MS + 20;
    const up = pointer(pay(), 'pointerup');
    expect(pay().hasAttribute('data-pressed')).toBe(false);
    expect(up.defaultPrevented).toBe(false);
  });

  it('keeps a quick tap visible for the minimum time, then clears it', () => {
    pointer(pay(), 'pointerdown');
    clock = 30;
    pointer(pay(), 'pointerup');
    expect(pay().hasAttribute('data-pressed')).toBe(true);
    vi.advanceTimersByTime(MIN_PRESSED_MS - 30);
    expect(pay().hasAttribute('data-pressed')).toBe(false);
  });

  it('clears on pointercancel, when the touch turns into a scroll', () => {
    pointer(pay(), 'pointerdown');
    clock = 500;
    pointer(pay(), 'pointercancel');
    expect(pay().hasAttribute('data-pressed')).toBe(false);
  });

  it('leaves mouse presses to :active and ignores disabled controls and non-controls', () => {
    pointer(pay(), 'pointerdown', 'mouse');
    expect(pay().hasAttribute('data-pressed')).toBe(false);
    pointer(document.getElementById('off')!, 'pointerdown');
    expect(document.getElementById('off')!.hasAttribute('data-pressed')).toBe(false);
    pointer(document.getElementById('plain')!, 'pointerdown');
    expect(document.querySelectorAll('[data-pressed]')).toHaveLength(0);
  });

  it('moves the pressed look to the next control at once and removes everything on uninstall', () => {
    pointer(pay(), 'pointerdown');
    clock = 10;
    pointer(pay(), 'pointerup');
    const other = document.createElement('button');
    document.body.appendChild(other);
    pointer(other, 'pointerdown');
    expect(pay().hasAttribute('data-pressed')).toBe(false);
    expect(other.hasAttribute('data-pressed')).toBe(true);

    uninstall();
    expect(document.querySelectorAll('[data-pressed]')).toHaveLength(0);
    pointer(pay(), 'pointerdown');
    expect(pay().hasAttribute('data-pressed')).toBe(false);
    uninstall = () => {};
  });
});
