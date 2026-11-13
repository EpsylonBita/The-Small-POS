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
import {
  ModalBackdropBridge,
  MODAL_BACKDROP_BRIDGE_BUSY_AFTER_MS,
  MODAL_BACKDROP_BRIDGE_GIVE_UP_MS,
} from '../ModalBackdropBridge';
import { resetModalOriginForTests } from '../modal-origin';

// Founder, 11/11/2026: between a window that closes and one whose screen is still loading, the
// page must not show sharp. The bridge holds the backdrop; nothing else.

const bridgeEl = () => document.querySelector<HTMLElement>('[data-modal-backdrop-bridge]');
const pickerBackdrop = () =>
  document.getElementById('picker')?.parentElement?.querySelector<HTMLElement>('.liquid-glass-modal-backdrop') ?? null;

beforeEach(() => {
  resetModalOriginForTests();
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe('ModalBackdropBridge', () => {
  it('renders nothing until it is asked to hold the backdrop', () => {
    render(<ModalBackdropBridge active={false} onGiveUp={vi.fn()} />);
    expect(bridgeEl()).toBeNull();
  });

  it('takes the backdrop over from the window that closes in the same step', () => {
    const Host = ({ picker, pending }: { picker: boolean; pending: boolean }) => (
      <>
        <ModalBackdropBridge active={pending} onGiveUp={vi.fn()} />
        <LiquidGlassModal isOpen={picker} onClose={vi.fn()} title="Picker" modalId="picker">
          <p>picker</p>
        </LiquidGlassModal>
      </>
    );
    const view = render(<Host picker pending={false} />);
    expect(pickerBackdrop()).not.toBeNull();

    act(() => {
      view.rerender(<Host picker={false} pending />);
    });
    const bridge = bridgeEl();
    expect(bridge).not.toBeNull();
    // The backdrop alone, already at full strength: no fade-in, no dialog semantics.
    expect(bridge?.className).toContain('liquid-glass-modal-backdrop--continued');
    expect(bridge?.getAttribute('aria-hidden')).toBe('true');
    expect(bridge?.getAttribute('role')).toBeNull();
    // The closing window's own backdrop is gone at once: the dim never doubles.
    expect(pickerBackdrop()?.style.opacity).toBe('0');
    expect(pickerBackdrop()?.style.animation).toBe('none');

    // The next window is in the page: the bridge goes in that step.
    act(() => {
      view.rerender(<Host picker={false} pending={false} />);
    });
    expect(bridgeEl()).toBeNull();
  });

  it('gives the page back when the next window never comes', () => {
    vi.useFakeTimers();
    const onGiveUp = vi.fn();
    render(<ModalBackdropBridge active onGiveUp={onGiveUp} />);
    expect(bridgeEl()).not.toBeNull();
    act(() => {
      vi.advanceTimersByTime(MODAL_BACKDROP_BRIDGE_GIVE_UP_MS - 1);
    });
    expect(onGiveUp).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(onGiveUp).toHaveBeenCalledTimes(1);
  });

  it('shows a quiet busy mark only when the hand-over is slow', () => {
    vi.useFakeTimers();
    const busy = () => document.querySelector('[data-modal-backdrop-bridge-busy]');
    const view = render(<ModalBackdropBridge active onGiveUp={vi.fn()} />);
    act(() => {
      vi.advanceTimersByTime(MODAL_BACKDROP_BRIDGE_BUSY_AFTER_MS - 1);
    });
    // A quick hand-over shows nothing at all.
    expect(busy()).toBeNull();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(busy()?.getAttribute('role')).toBe('status');
    expect(busy()?.textContent).toBe('common.loading');
    // It never takes a press: the backdrop below still owns the page.
    expect(busy()?.className).toContain('pointer-events-none');

    act(() => {
      view.rerender(<ModalBackdropBridge active={false} onGiveUp={vi.fn()} />);
    });
    expect(busy()).toBeNull();
    // The next hand-over starts quiet again.
    act(() => {
      view.rerender(<ModalBackdropBridge active onGiveUp={vi.fn()} />);
    });
    expect(busy()).toBeNull();
  });

  it('does not give up after it was released', () => {
    vi.useFakeTimers();
    const onGiveUp = vi.fn();
    const view = render(<ModalBackdropBridge active onGiveUp={onGiveUp} />);
    act(() => {
      view.rerender(<ModalBackdropBridge active={false} onGiveUp={onGiveUp} />);
    });
    act(() => {
      vi.advanceTimersByTime(MODAL_BACKDROP_BRIDGE_GIVE_UP_MS * 2);
    });
    expect(onGiveUp).not.toHaveBeenCalled();
  });
});

describe('ModalBackdropBridge on a locked till', () => {
  it('draws nothing while the cashier gate is locked', async () => {
    const { CashierGateContext } = await import('../../../contexts/cashier-gate-context');
    const view = render(
      <CashierGateContext.Provider value={true}>
        <ModalBackdropBridge active onGiveUp={vi.fn()} />
      </CashierGateContext.Provider>,
    );
    // A body portal escapes the locked subtree: nothing full-screen may cover check-in or Health.
    expect(bridgeEl()).toBeNull();
    act(() => {
      view.rerender(
        <CashierGateContext.Provider value={false}>
          <ModalBackdropBridge active onGiveUp={vi.fn()} />
        </CashierGateContext.Provider>,
      );
    });
    expect(bridgeEl()).not.toBeNull();
  });
});
