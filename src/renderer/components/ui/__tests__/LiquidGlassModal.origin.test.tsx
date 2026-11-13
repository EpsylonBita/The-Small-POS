import React from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../contexts/i18n-context', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

vi.mock('../../../hooks/useBlockerRegistration', () => ({
  useBlockerRegistration: () => undefined,
}));

import { LiquidGlassModal } from '../pos-glass-components';
import { notePressForTests, resetModalOriginForTests } from '../modal-origin';

// Founder, 11/11/2026: a window grows out of the control that was pressed, and a window that
// replaces a closing one keeps the blurred backdrop (the page behind flashed sharp in between).

let restoreRect: (() => void) | null = null;

beforeEach(() => {
  resetModalOriginForTests();
  // jsdom performs no layout: give every shell a real box so the origin can be measured.
  const originalRect = HTMLElement.prototype.getBoundingClientRect;
  const originalWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth');
  const originalHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
  HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
    return { left: 400, top: 150, width: 800, height: 500, right: 1200, bottom: 650, x: 400, y: 150, toJSON: () => ({}) } as DOMRect;
  };
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 800 });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => 500 });
  restoreRect = () => {
    HTMLElement.prototype.getBoundingClientRect = originalRect;
    if (originalWidth) Object.defineProperty(HTMLElement.prototype, 'offsetWidth', originalWidth);
    if (originalHeight) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', originalHeight);
  };
});

afterEach(() => {
  cleanup();
  restoreRect?.();
  restoreRect = null;
});

const shellOf = (id: string) => document.getElementById(id) as HTMLElement;
const backdropOf = (id: string) =>
  shellOf(id).parentElement?.querySelector('.liquid-glass-modal-backdrop') as HTMLElement;

describe('LiquidGlassModal opening', () => {
  it('points the shell at the press that opened it', () => {
    notePressForTests(1500, 900);
    render(
      <LiquidGlassModal isOpen onClose={vi.fn()} title="Picker" modalId="picker">
        <p>content</p>
      </LiquidGlassModal>,
    );
    const shell = shellOf('picker');
    expect(shell.style.getPropertyValue('--modal-origin-x')).toBe('1100px');
    expect(shell.style.getPropertyValue('--modal-origin-y')).toBe('750px');
  });

  it('keeps the backdrop when one window replaces another, and fades it in over a window that stays', async () => {
    const Host = ({ picker, next, onTop }: { picker: boolean; next: boolean; onTop: boolean }) => (
      <>
        <LiquidGlassModal isOpen={picker} onClose={vi.fn()} title="Picker" modalId="picker">
          <p>picker</p>
        </LiquidGlassModal>
        <LiquidGlassModal isOpen={next} onClose={vi.fn()} title="Next" modalId="next">
          <p>next</p>
        </LiquidGlassModal>
        <LiquidGlassModal isOpen={onTop} onClose={vi.fn()} title="On top" modalId="on-top">
          <p>on top</p>
        </LiquidGlassModal>
      </>
    );
    const view = render(<Host picker next={false} onTop={false} />);
    // The first window fades its own backdrop in.
    expect(backdropOf('picker').className).not.toContain('liquid-glass-modal-backdrop--continued');

    // The cashier picks an option: the picker closes and the next window opens in one step.
    act(() => {
      view.rerender(<Host picker={false} next onTop={false} />);
    });
    expect(backdropOf('next').className).toContain('liquid-glass-modal-backdrop--continued');
    // The closing window's backdrop is gone at once: the dim never doubles and never dips.
    expect(backdropOf('picker').style.opacity).toBe('0');
    expect(backdropOf('picker').style.animation).toBe('none');

    // The picker's close settles (its exit animation never ends in jsdom: the fallback timer does).
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 320));
    });
    expect(document.getElementById('picker')).toBeNull();

    // A window opened ON TOP of one that stays open is not a replacement.
    act(() => {
      view.rerender(<Host picker={false} next onTop />);
    });
    expect(backdropOf('on-top').className).not.toContain('liquid-glass-modal-backdrop--continued');
    expect(backdropOf('next').style.opacity).toBe('');
  });
});
