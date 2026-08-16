import React from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../contexts/i18n-context', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

vi.mock('../../../hooks/useBlockerRegistration', () => ({
  useBlockerRegistration: () => undefined,
}));

import { LiquidGlassModal } from '../pos-glass-components';

// jsdom performs no layout, so every element reports `offsetParent === null` and the
// shell's visibility filter would drop all of them. Treat attached elements as visible
// so getFocusableElements resolves the close button exactly as it does in the webview.
let restoreOffsetParent: (() => void) | null = null;

beforeEach(() => {
  const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetParent');
  Object.defineProperty(HTMLElement.prototype, 'offsetParent', {
    configurable: true,
    get(this: HTMLElement) {
      return this.isConnected ? this.parentElement : null;
    },
  });
  restoreOffsetParent = () => {
    if (original) {
      Object.defineProperty(HTMLElement.prototype, 'offsetParent', original);
    } else {
      delete (HTMLElement.prototype as unknown as Record<string, unknown>).offsetParent;
    }
  };
  vi.useFakeTimers();
});

afterEach(() => {
  // This suite runs without vitest `globals`, so RTL never registers its auto-cleanup
  // and portaled modals would pile up on document.body across tests.
  cleanup();
  vi.useRealTimers();
  restoreOffsetParent?.();
  restoreOffsetParent = null;
});

const settleFocusTimer = () => {
  act(() => {
    vi.advanceTimersByTime(100);
  });
};

describe('LiquidGlassModal focus handover', () => {
  it('leaves a self-focused field alone instead of jumping to the close button', () => {
    render(
      <LiquidGlassModal isOpen onClose={vi.fn()} title="Starting amount">
        <input aria-label="amount" autoFocus />
      </LiquidGlassModal>,
    );

    const amount = screen.getByLabelText('amount');
    expect(document.activeElement).toBe(amount);

    // The shell's 50ms claim used to fire unconditionally here, so the operator's first
    // keystroke landed and everything after it went to the close button.
    settleFocusTimer();

    expect(document.activeElement).toBe(amount);
  });

  it('still claims focus when nothing inside the modal took it', () => {
    render(
      <LiquidGlassModal isOpen onClose={vi.fn()} title="Starting amount">
        <input aria-label="amount" />
      </LiquidGlassModal>,
    );

    settleFocusTimer();

    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'common.actions.close' }),
    );
  });

  it('keeps the caret put while the parent re-renders with a fresh onClose', () => {
    // Every caller passes an inline `onClose` arrow, so its identity changes on each
    // parent render. That must not re-arm the shell's focus timer underneath a field
    // the operator is typing into.
    const Host = ({ tick }: { tick: number }) => (
      <LiquidGlassModal isOpen onClose={() => undefined} title="Starting amount">
        <input aria-label="amount" autoFocus />
        <span>{tick}</span>
      </LiquidGlassModal>
    );

    const { rerender } = render(<Host tick={0} />);
    settleFocusTimer();

    const amount = screen.getByLabelText('amount');
    expect(document.activeElement).toBe(amount);

    for (let tick = 1; tick <= 3; tick += 1) {
      rerender(<Host tick={tick} />);
      settleFocusTimer();
      expect(document.activeElement).toBe(amount);
    }
  });

  it('parks escaped focus on the dialog rather than arming the close button', () => {
    const { rerender } = render(
      <LiquidGlassModal isOpen onClose={vi.fn()} title="Starting amount">
        <input aria-label="amount" autoFocus />
        <button type="button">Continue</button>
      </LiquidGlassModal>,
    );

    settleFocusTimer();
    expect(document.activeElement).toBe(screen.getByLabelText('amount'));

    // A step swap removes the focused field; the browser then reports focus on <body>.
    rerender(
      <LiquidGlassModal isOpen onClose={vi.fn()} title="Starting amount">
        <button type="button">Continue</button>
      </LiquidGlassModal>,
    );

    act(() => {
      document.body.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    });

    const dialog = screen.getByRole('dialog');
    expect(document.activeElement).toBe(dialog);
    expect(document.activeElement).not.toBe(
      screen.getByRole('button', { name: 'common.actions.close' }),
    );
  });
});
