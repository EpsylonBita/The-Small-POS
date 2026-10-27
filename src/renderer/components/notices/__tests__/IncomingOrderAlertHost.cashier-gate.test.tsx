/** Tomikro 26/10/2026: a live alert was fenced above every cashier recovery path. */
import React from 'react';
import { createPortal } from 'react-dom';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GlobalCashierGate, CashierOperationalBoundary } from '../../GlobalCashierGate';
import { IncomingOrderAlertHost } from '../IncomingOrderAlertHost';
import type { Order } from '../../../types/orders';
import { INCOMING_ORDER_ALERT_TAP_GUARD_MS, INCOMING_ORDER_WATCHDOG_MS } from '../../../services/incomingOrderAlert';

const model = vi.hoisted(() => ({ blocked: true, queue: [] as Order[], ring: vi.fn() }));
vi.mock('react-i18next', async (importOriginal) => ({ ...(await importOriginal<typeof import('react-i18next')>()), useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../contexts/i18n-context', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('../../../hooks/useCashierDayGate', () => ({ useCashierDayGate: () => ({ isBlocked: model.blocked, isResolving: false, branchId: 'branch-1' }) }));
vi.mock('../../../hooks/useFeatures', () => ({ useFeatures: () => ({ isMobileWaiter: false, loading: false }) }));
vi.mock('../../../hooks/useEndOfDayStatus', () => ({ useEndOfDayStatus: () => ({ endOfDayStatus: {}, isPendingLocalSubmit: true }) }));
vi.mock('../../../hooks/useBlockerRegistration', () => ({ useBlockerRegistration: () => undefined }));
vi.mock('../../../services/incomingOrderAlertLoop', () => ({
  useIncomingOrderAlertQueue: () => model.queue,
  incomingOrderHeadlineNumber: (order: Order) => order.order_number,
  logIncomingOrderAlertEvent: vi.fn(),
  markIncomingOrdersEscalated: vi.fn(),
  ringIncomingOrderAlertAgain: model.ring,
}));
vi.mock('../../ShiftManager', async () => {
  const React = await import('react');
  const { LiquidGlassModal } = await import('../../ui/pos-glass-components');
  return { ShiftManager: React.forwardRef((_props, ref) => {
    const [open, setOpen] = React.useState(false);
    React.useImperativeHandle(ref, () => ({ openCheckin: () => setOpen(true) }));
    return <LiquidGlassModal isOpen={open} onClose={() => setOpen(false)} title="cashier check-in"><input aria-label="cashier PIN" /></LiquidGlassModal>;
  }) };
});

const advance = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });
const alertDialog = () => screen.queryByTestId('incoming-order-alert');
const onOpenOrders = vi.fn();
function Till({ recovery }: { recovery?: string }) {
  return <GlobalCashierGate onLogout={() => {}} onOpenSettings={() => {}}>
    <CashierOperationalBoundary><button>Operational page</button></CashierOperationalBoundary>
    {recovery && createPortal(<div data-cashier-recovery="true" data-liquid-glass-modal-viewport>
      <div role="dialog" aria-label={recovery}><input aria-label="recovery input" /></div>
    </div>, document.body)}
    <IncomingOrderAlertHost currentView="tables" onOrdersScreen={false} onOpenOrders={onOpenOrders} />
  </GlobalCashierGate>;
}

beforeEach(() => {
  vi.useFakeTimers();
  model.blocked = true;
  model.queue = [{ id: 'efood-1', order_number: 'EF-1', status: 'pending', plugin: 'efood' } as Order];
  onOpenOrders.mockClear();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('incoming order through the real cashier gate', () => {
  it('coalesces busy-screen mutations into one evaluation per frame and cancels pending work', () => {
    let notify!: MutationCallback;
    vi.stubGlobal('MutationObserver', class {
      constructor(callback: MutationCallback) { notify = callback; }
      observe() {}
      disconnect() {}
    });
    let nextFrame!: FrameRequestCallback;
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => { nextFrame = callback; return 123; });
    const cancel = vi.spyOn(window, 'cancelAnimationFrame');
    const { unmount } = render(<Till recovery="sync recovery" />);
    const queries = vi.spyOn(document, 'querySelectorAll');
    const evaluations = () => queries.mock.calls.filter(([selector]) => selector === '[data-cashier-recovery="true"] [role="dialog"]').length;
    act(() => { for (let i = 0; i < 30; i++) notify([], {} as MutationObserver); });
    expect(evaluations()).toBe(0);
    expect(raf).toHaveBeenCalledTimes(1);
    act(() => nextFrame(16));
    expect(evaluations()).toBe(1);
    act(() => notify([], {} as MutationObserver));
    expect(raf).toHaveBeenCalledTimes(2);
    unmount();
    expect(cancel).toHaveBeenCalledWith(123);
  });

  it('lets Later through the capture fence for one watchdog period and releases isolation', () => {
    const { container } = render(<Till />);
    advance(INCOMING_ORDER_ALERT_TAP_GUARD_MS);
    fireEvent.click(screen.getByTestId('incoming-order-alert-later'));
    expect(alertDialog()).toBeNull();
    expect(container).not.toHaveAttribute('aria-hidden', 'true');
    advance(INCOMING_ORDER_WATCHDOG_MS);
    expect(alertDialog()).toBeInTheDocument();
  });

  it('offers check-in and opens the gate ShiftManager instead of Orders', () => {
    render(<Till />);
    expect(screen.getByTestId('incoming-order-alert-viewport')).toHaveAttribute('data-cashier-recovery', 'true');
    expect(screen.getByTestId('incoming-order-alert-open')).toHaveTextContent('incomingOrderAlert.checkInToAccept');
    expect(screen.getByText('incomingOrderAlert.lockedExplain')).toBeInTheDocument();
    advance(INCOMING_ORDER_ALERT_TAP_GUARD_MS);
    fireEvent.click(screen.getByTestId('incoming-order-alert-open'));
    expect(screen.getByRole('dialog', { name: 'cashier check-in' })).toBeInTheDocument();
    advance(1000);
    expect(alertDialog()).toBeNull();
    expect(onOpenOrders).not.toHaveBeenCalled();
  });

  it('lets Escape through the locked fence after the tap guard', () => {
    render(<Till />);
    fireEvent.keyDown(screen.getByTestId('incoming-order-alert'), { key: 'Escape' });
    expect(alertDialog()).toBeInTheDocument();
    advance(INCOMING_ORDER_ALERT_TAP_GUARD_MS);
    fireEvent.keyDown(screen.getByTestId('incoming-order-alert'), { key: 'Escape' });
    expect(alertDialog()).toBeNull();
  });

  it.each(['cashier check-in', 'pending Z', 'sync recovery', 'support updater'])(
    'yields to an already-open %s, including escalation, and releases its own isolation', (recovery) => {
      const { container, rerender } = render(<Till recovery={recovery} />);
      expect(alertDialog()).toBeNull();
      expect(container).not.toHaveAttribute('aria-hidden', 'true');
      advance(INCOMING_ORDER_WATCHDOG_MS + 1000);
      expect(alertDialog()).toBeNull();
      expect(model.ring).toHaveBeenCalled();
      const input = screen.getByLabelText('recovery input');
      fireEvent.change(input, { target: { value: '1234' } });
      expect(input).toHaveValue('1234');
      rerender(<Till />);
      advance(1000);
      expect(alertDialog()).toHaveAttribute('data-escalated', 'true');
    },
  );

  it('steps aside when recovery opens over an already escalated alert', () => {
    const { rerender, container } = render(<Till />);
    advance(INCOMING_ORDER_WATCHDOG_MS);
    expect(alertDialog()).toHaveAttribute('data-escalated', 'true');
    rerender(<Till recovery="sync recovery" />);
    advance(1000);
    expect(alertDialog()).toBeNull();
    expect(container).not.toHaveAttribute('aria-hidden', 'true');
  });

  it('restores Open the order and removes recovery access after unlocking', () => {
    const { rerender } = render(<Till />);
    model.blocked = false;
    rerender(<Till />);
    expect(screen.getByTestId('incoming-order-alert-viewport')).not.toHaveAttribute('data-cashier-recovery');
    expect(screen.getByTestId('incoming-order-alert-open')).toHaveTextContent('incomingOrderAlert.open');
    advance(INCOMING_ORDER_ALERT_TAP_GUARD_MS);
    fireEvent.click(screen.getByTestId('incoming-order-alert-open'));
    expect(onOpenOrders).toHaveBeenCalledOnce();
    expect(alertDialog()).toBeNull();
  });
});
