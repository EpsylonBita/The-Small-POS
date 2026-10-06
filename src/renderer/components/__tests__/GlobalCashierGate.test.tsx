import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { MemoryRouter } from 'react-router-dom';
import { AppRoutes } from '../../AppRoutes';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GlobalCashierGate, CashierOperationalBoundary } from '../GlobalCashierGate';
import { LiquidGlassModal } from '../ui/pos-glass-components';
import { CashierRecovery } from '../../contexts/cashier-gate-context';
vi.mock('../../pages/NewOrderPage', () => ({ default: Draft }));
vi.mock('../ui/PageLoadMotion', () => ({ default: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
const model = vi.hoisted(() => ({ blocked: false, resolving: false, disposed: vi.fn(), collect: vi.fn() }));
vi.mock('react-i18next', async (importOriginal) => ({ ...(await importOriginal<typeof import('react-i18next')>()), useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../contexts/i18n-context', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('../../hooks/useCashierDayGate', () => ({ useCashierDayGate: () => ({ isBlocked: model.blocked, isResolving: model.resolving, branchId: 'branch-1', recheck: vi.fn() }) }));
vi.mock('../../hooks/useFeatures', () => ({ useFeatures: () => ({ isMobileWaiter: false, loading: false }) }));
vi.mock('../../hooks/useEndOfDayStatus', () => ({ useEndOfDayStatus: () => ({ endOfDayStatus: {}, isPendingLocalSubmit: true }) }));
vi.mock('../../hooks/useBlockerRegistration', () => ({ useBlockerRegistration: () => undefined }));
vi.mock('../ShiftManager', async () => {
  const React = await import('react');
  const { LiquidGlassModal } = await import('../ui/pos-glass-components');
  return { ShiftManager: React.forwardRef((_props, ref) => {
    const [open, setOpen] = React.useState(false);
    React.useImperativeHandle(ref, () => ({ openCheckin: () => setOpen(true) }));
    return <LiquidGlassModal isOpen={open} onClose={() => setOpen(false)} title="cashier check-in"><input aria-label="cashier PIN" /><button>verify cashier</button></LiquidGlassModal>;
  }) };
});
vi.mock('../modals/ZReportModal', () => ({ default: ({ isOpen }: any) => isOpen ? <LiquidGlassModal isOpen onClose={() => {}} title="pending Z"><button>complete Z</button></LiquidGlassModal> : null }));
function Draft() {
  const [draft, setDraft] = useState('original draft');
  useEffect(() => () => model.disposed(), []);
  return <><input aria-label="cart draft" value={draft} onChange={event => setDraft(event.target.value)} />
    <LiquidGlassModal isOpen onClose={() => {}} title="incoming payment"><button onClick={model.collect}>collect money</button></LiquidGlassModal></>;
}
beforeEach(() => { model.blocked = false; model.resolving = false; model.disposed.mockClear(); model.collect.mockClear(); });
afterEach(() => cleanup());
describe('GlobalCashierGate', () => {
  it('keeps login verification neutral while blocking operational portals and shortcuts', () => {
    model.blocked = true;
    model.resolving = true;
    const { rerender } = render(<GlobalCashierGate onLogout={() => {}} onOpenSettings={() => {}}><CashierOperationalBoundary><Draft /></CashierOperationalBoundary></GlobalCashierGate>);
    expect(screen.getByRole('status')).toHaveTextContent('cashierGate.checking');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText('cashierGate.body')).toBeNull();
    expect(screen.queryByText('navigation.checkIn')).toBeNull();
    expect(document.querySelector('[data-cashier-operational="true"]')).toHaveAttribute('inert');
    fireEvent.click(screen.getByText('collect money'));
    expect(model.collect).not.toHaveBeenCalled();
    model.resolving = false;
    rerender(<GlobalCashierGate onLogout={() => {}} onOpenSettings={() => {}}><CashierOperationalBoundary><Draft /></CashierOperationalBoundary></GlobalCashierGate>);
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByText('navigation.checkIn'));
  });

  it('retains the direct-route draft and portal state while blocking sale clicks and window shortcuts', () => {
    const host = <GlobalCashierGate onLogout={() => {}} onOpenSettings={() => {}}><CashierOperationalBoundary><Draft /></CashierOperationalBoundary></GlobalCashierGate>;
    const { rerender } = render(host);
    fireEvent.click(screen.getByText('collect money'));
    expect(model.collect).toHaveBeenCalledOnce();
    model.collect.mockClear();
    fireEvent.change(screen.getByLabelText('cart draft'), { target: { value: 'unsaved payment original' } });
    const shortcut = vi.fn();
    window.addEventListener('keydown', shortcut);
    model.blocked = true;
    rerender(<GlobalCashierGate onLogout={() => {}} onOpenSettings={() => {}}><CashierOperationalBoundary><Draft /></CashierOperationalBoundary></GlobalCashierGate>);
    expect(model.disposed).not.toHaveBeenCalled();
    const operational = document.querySelector('[data-cashier-operational="true"]');
    expect(operational).toHaveAttribute('inert');
    const portal = document.querySelector('[aria-label="incoming payment"], [role="dialog"]')?.closest('[data-liquid-glass-modal-viewport]');
    expect(portal).toHaveStyle({ visibility: 'hidden' });
    fireEvent.click(screen.getByText('collect money'));
    expect(model.collect).not.toHaveBeenCalled();
    fireEvent.keyDown(document.body, { key: 'F2' });
    expect(shortcut).not.toHaveBeenCalled();
    window.removeEventListener('keydown', shortcut);
    model.blocked = false;
    rerender(<GlobalCashierGate onLogout={() => {}} onOpenSettings={() => {}}><CashierOperationalBoundary><Draft /></CashierOperationalBoundary></GlobalCashierGate>);
    expect(screen.getByLabelText('cart draft')).toHaveValue('unsaved payment original');
  });

  it('keeps recovery check-in visibly above an already-open payment portal and exposes pending Z', async () => {
    model.blocked = true;
    render(<GlobalCashierGate onLogout={() => {}} onOpenSettings={() => {}}><CashierOperationalBoundary><Draft /></CashierOperationalBoundary></GlobalCashierGate>);
    const gate = screen.getByRole('alert');
    expect(gate.closest('[data-cashier-recovery="true"]')).toHaveClass('absolute');
    expect(gate.closest('[data-cashier-recovery="true"]')).not.toHaveClass('fixed');
    expect(gate).not.toHaveAttribute('inert');
    fireEvent.click(screen.getByText('navigation.checkIn'));
    const checkin = screen.getByRole('dialog', { name: 'cashier check-in' });
    expect(checkin.closest('[data-cashier-recovery="true"]')).toHaveStyle({ zIndex: '2147483100' });
    const pin = screen.getByLabelText('cashier PIN');
    const shortcut = vi.fn();
    window.addEventListener('keydown', shortcut);
    fireEvent.keyDown(pin, { key: 's', ctrlKey: true });
    fireEvent.keyDown(pin, { key: 'F2' });
    expect(shortcut).not.toHaveBeenCalled();
    expect(fireEvent.keyDown(pin, { key: 'v', ctrlKey: true })).toBe(true);
    expect(fireEvent.keyDown(pin, { key: '1' })).toBe(true);
    fireEvent.change(pin, { target: { value: '1234' } });
    expect(pin).toHaveValue('1234');
    expect(shortcut).toHaveBeenCalledTimes(2);
    window.removeEventListener('keydown', shortcut);
    fireEvent.click(screen.getByText('shift.actions.completeZReport'));
    await act(async () => {});
    expect(await screen.findByRole('dialog', { name: 'pending Z' })).toBeVisible();
  });

  it('focuses check-in on last checkout without trapping navigation behind a global alert', () => {
    const { rerender } = render(<GlobalCashierGate onLogout={() => {}} onOpenSettings={() => {}}><CashierOperationalBoundary><Draft /></CashierOperationalBoundary></GlobalCashierGate>);
    screen.getByLabelText('cart draft').focus();
    model.blocked = true;
    rerender(<GlobalCashierGate onLogout={() => {}} onOpenSettings={() => {}}><CashierOperationalBoundary><Draft /></CashierOperationalBoundary></GlobalCashierGate>);
    const checkin = screen.getByText('navigation.checkIn');
    expect(document.activeElement).toBe(checkin);
    // The browser can now tab from the scoped prompt to shell support controls.
    expect(fireEvent.keyDown(checkin, { key: 'Tab' })).toBe(true);
    fireEvent.click(checkin);
    expect(screen.getByRole('dialog', { name: 'cashier check-in' })).toBeVisible();
  });

  it('permits the support updater portal through explicit recovery access outside the operational subtree', () => {
    model.blocked = true;
    const support = vi.fn();
    render(<>
      <GlobalCashierGate onLogout={() => {}} onOpenSettings={() => {}}><CashierOperationalBoundary><Draft /></CashierOperationalBoundary></GlobalCashierGate>
      <CashierRecovery><LiquidGlassModal isOpen onClose={() => {}} title="support updater">
        <button onClick={support}>support action</button>
      </LiquidGlassModal></CashierRecovery>
    </>);
    const dialog = screen.getByRole('dialog', { name: 'support updater' });
    expect(dialog.closest('[data-cashier-recovery="true"]')).toHaveStyle({ zIndex: '2147483100' });
    fireEvent.click(screen.getByText('support action'));
    expect(support).toHaveBeenCalledOnce();
  });

  it('keeps settings navigation and health accessible while the cashier day is closed', () => {
    model.blocked = true;
    const settings = vi.fn(), health = vi.fn();
    render(<>
      <div data-cashier-recovery="true"><button onClick={health}>Health</button></div>
      <GlobalCashierGate onLogout={() => {}} onOpenSettings={settings}>
        <nav data-cashier-navigation="true"><button onClick={settings}>Settings navigation</button></nav>
        <CashierOperationalBoundary><Draft /></CashierOperationalBoundary>
      </GlobalCashierGate>
    </>);
    expect(screen.getByRole('button', { name: 'Settings navigation' })).toBeVisible();
    expect(screen.getByText('Settings navigation').closest('[inert]')).toBeNull();
    fireEvent.click(screen.getByText('Settings navigation'));
    fireEvent.click(screen.getByText('Health'));
    expect(settings).toHaveBeenCalledOnce();
    expect(health).toHaveBeenCalledOnce();
  });


  it('still fences an unmarked operational portal and shortcuts from otherwise safe navigation', () => {
    model.blocked = true;
    const unsafe = vi.fn(), windowAction = vi.fn(), shortcut = vi.fn();
    render(<>
      <div data-app-window-frame><button onClick={windowAction}>Window action</button></div>
      <GlobalCashierGate onLogout={() => {}} onOpenSettings={() => {}}>
        <nav data-cashier-navigation="true"><button>Navigation item</button></nav>
        <CashierOperationalBoundary><Draft /></CashierOperationalBoundary>
        {createPortal(<button onClick={unsafe}>raw sale portal</button>, document.body)}
      </GlobalCashierGate>
    </>);
    window.addEventListener('keydown', shortcut);
    fireEvent.click(screen.getByText('raw sale portal'));
    fireEvent.click(screen.getByText('Window action'));
    fireEvent.keyDown(screen.getByText('Navigation item'), { key: 'F2' });
    expect(unsafe).not.toHaveBeenCalled();
    expect(windowAction).toHaveBeenCalledOnce();
    expect(shortcut).not.toHaveBeenCalled();
    window.removeEventListener('keydown', shortcut);
  });


  it('keeps a direct new-order route mounted and unavailable until the cashier day reopens', async () => {
    const host = () => <MemoryRouter initialEntries={['/new-order']}><GlobalCashierGate onLogout={() => {}} onOpenSettings={() => {}}>
      <React.Suspense fallback={null}><AppRoutes onLogout={() => {}} onOpenConnectionSettings={() => {}} /></React.Suspense>
    </GlobalCashierGate></MemoryRouter>;
    const { rerender } = render(host());
    await screen.findByLabelText('cart draft');
    fireEvent.change(screen.getByLabelText('cart draft'), { target: { value: 'unsaved direct-route order' } });
    model.blocked = true;
    rerender(host());
    expect(screen.getByLabelText('cart draft').closest('[data-cashier-operational="true"]')).toHaveAttribute('inert');
    fireEvent.click(screen.getByText('collect money'));
    expect(model.collect).not.toHaveBeenCalled();
    expect(model.disposed).not.toHaveBeenCalled();
    model.blocked = false;
    rerender(host());
    expect(screen.getByLabelText('cart draft')).toHaveValue('unsaved direct-route order');
  });

});
