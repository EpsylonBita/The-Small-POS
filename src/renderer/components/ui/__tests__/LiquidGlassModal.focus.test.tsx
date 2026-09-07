import React from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../contexts/i18n-context', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

vi.mock('../../../hooks/useBlockerRegistration', () => ({
  useBlockerRegistration: () => undefined,
}));

import { LiquidGlassModal, POSGlassModal } from '../pos-glass-components';

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
  it.each([
    ['LiquidGlassModal', LiquidGlassModal],
    ['POSGlassModal', POSGlassModal],
  ] as const)('gives nested %s dialogs distinct, stable accessible names', (_name, Modal) => {
    const Host = ({ innerTitle }: { innerTitle: string }) => (
      <Modal isOpen onClose={vi.fn()} title="Staff">
        <Modal isOpen onClose={vi.fn()} title={innerTitle}>
          <button>Continue</button>
        </Modal>
      </Modal>
    );
    const { rerender } = render(<Host innerTitle="Confirm" />);
    const outer = screen.getByRole('dialog', { name: 'Staff' });
    const inner = screen.getByRole('dialog', { name: 'Confirm' });
    const outerTitleId = outer.getAttribute('aria-labelledby');
    const innerTitleId = inner.getAttribute('aria-labelledby');
    expect(innerTitleId).not.toBe(outerTitleId);

    rerender(<Host innerTitle="Confirm driver" />);
    expect(screen.getByRole('dialog', { name: 'Staff' })).toHaveAttribute('aria-labelledby', outerTitleId);
    expect(screen.getByRole('dialog', { name: 'Confirm driver' })).toHaveAttribute('aria-labelledby', innerTitleId);
  });

  it('keeps custom-header dialogs labelled by ariaLabel rather than a missing default title', () => {
    render(
      <LiquidGlassModal isOpen onClose={vi.fn()} title="Unused default title" header={<h2>Custom header</h2>} ariaLabel="Driver selection">
        <button>Continue</button>
      </LiquidGlassModal>,
    );
    expect(screen.getByRole('dialog', { name: 'Driver selection' })).not.toHaveAttribute('aria-labelledby');
  });

  it('keeps background effects paused until the last nested modal is gone', () => {
    const Host = ({ nested }: { nested: boolean }) => (
      <LiquidGlassModal isOpen onClose={vi.fn()} title="Staff">
        {nested && (
          <LiquidGlassModal isOpen onClose={vi.fn()} title="Confirm">
            <button>Continue</button>
          </LiquidGlassModal>
        )}
      </LiquidGlassModal>
    );
    const { rerender, unmount } = render(<React.StrictMode><Host nested /></React.StrictMode>);
    expect(document.body).toHaveClass('pos-modal-open');
    rerender(<React.StrictMode><Host nested={false} /></React.StrictMode>);
    expect(document.body).toHaveClass('pos-modal-open');
    unmount();
    expect(document.body).not.toHaveClass('pos-modal-open');
  });

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
