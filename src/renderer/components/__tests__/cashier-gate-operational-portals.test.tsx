/** Open portals must yield to check-in when a remote checkout locks the till. */
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GlobalCashierGate } from '../GlobalCashierGate';
import { FinancialSyncPanel } from '../FinancialSyncPanel';
import { LoyaltyRedeemModal } from '../modals/LoyaltyRedeemModal';
import { TableCheckManagerModal } from '../tables/TableCheckManagerModal';
import { POSGlassModal } from '../ui/pos-glass-components';

const model = vi.hoisted(() => ({ locked: false, t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue || key }));
vi.mock('react-i18next', async (importOriginal) => ({ ...(await importOriginal<typeof import('react-i18next')>()), useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../contexts/i18n-context', () => ({ useI18n: () => ({
  t: model.t,
}) }));
vi.mock('../../hooks/useCashierDayGate', () => ({ useCashierDayGate: () => ({ isBlocked: model.locked, isResolving: false, branchId: 'branch' }) }));
vi.mock('../../hooks/useFeatures', () => ({ useFeatures: () => ({ isMobileWaiter: false, loading: false }) }));
vi.mock('../../hooks/useEndOfDayStatus', () => ({ useEndOfDayStatus: () => ({ endOfDayStatus: {}, isPendingLocalSubmit: false }) }));
vi.mock('../../hooks/useBlockerRegistration', () => ({ useBlockerRegistration: () => undefined }));
vi.mock('../ShiftManager', () => ({ ShiftManager: React.forwardRef(() => null) }));
vi.mock('../../../lib', () => ({ getBridge: () => ({
  invoke: async () => ({ success: true }),
  sync: { getStatus: async () => ({ unresolvedRemotePayments: 0 }) },
  orders: { getAll: async () => [] },
  staffAuth: { refreshDirectory: async () => ({ staff: [] }) },
}), onEvent: vi.fn(), offEvent: vi.fn(), emitCompatEvent: vi.fn() }));
vi.mock('../../services/SyncQueueBridge', () => ({ getSyncQueueBridge: () => ({ listItems: async () => [] }) }));
vi.mock('../../utils/api-helpers', () => ({ posApiGet: async () => ({ success: true, data: { success: true,
  session: { id: 'session', primary_table_id: 'T1', status: 'open', items: [], payments: [], balance: {} },
} }) }));

const noop = () => {};
function Till({ children }: { children: React.ReactNode }) {
  return <GlobalCashierGate onLogout={noop} onOpenSettings={noop}>
    <button data-cashier-recovery="true">Check in</button>{children}
  </GlobalCashierGate>;
}
beforeEach(() => { model.locked = false; });
afterEach(cleanup);

describe('portals through the real cashier gate', () => {
  it('lets the financial recovery panel close while locked', async () => {
    model.locked = true;
    function Panel() {
      const [open, setOpen] = React.useState(true);
      return <FinancialSyncPanel isOpen={open} onClose={() => setOpen(false)} onRefresh={noop} />;
    }
    await act(async () => { render(<Till><Panel /></Till>); });
    fireEvent.click(screen.getByRole('button', { name: 'common.actions.close' }));
    expect(screen.queryByText('sync.financial.title')).toBeNull();
  });

  it.each(['loyalty', 'table check'] as const)('keeps the %s draft mounted, hidden and inert through a lock', async (kind) => {
    const surface = kind === 'loyalty'
      ? <LoyaltyRedeemModal isOpen onClose={noop} onRedeem={noop} customerId="customer" pointsBalance={100} redemptionRate={0.1} minRedemptionPoints={10} />
      : <TableCheckManagerModal isOpen table={{ id: 'T1', tableNumber: '1', tableSessionId: 'session', status: 'occupied', branchId: 'branch', organizationId: 'org' } as any}
          tables={[]} onClose={noop} onAddItems={noop} onRefreshTables={noop} onRefreshOrders={noop} />;
    const { rerender } = render(<Till>{surface}</Till>);
    await act(async () => {});
    const close = screen.getByRole('button', { name: kind === 'loyalty' ? 'common.actions.close' : 'Close table check' });
    model.locked = true;
    rerender(<Till>{surface}</Till>);
    expect(close).toBeInTheDocument();
    const root = close.closest('[inert]');
    expect(root).not.toBeNull();
    expect(root).toHaveAttribute('aria-hidden', 'true');
    expect(root).toHaveStyle({ visibility: 'hidden' });
    model.locked = false;
    rerender(<Till>{surface}</Till>);
    expect(close).toBeVisible();
    expect(close.closest('[inert]')).toBeNull();
  });

  it('releases legacy modal isolation and Escape while hidden, preserving its draft', () => {
    const onClose = vi.fn();
    const surface = <POSGlassModal isOpen onClose={onClose} title="Legacy draft"><input aria-label="Draft" /></POSGlassModal>;
    const { rerender, container } = render(<Till>{surface}</Till>);
    const input = screen.getByLabelText('Draft');
    fireEvent.change(input, { target: { value: 'saved draft' } });
    model.locked = true;
    rerender(<Till>{surface}</Till>);
    expect(input).toHaveValue('saved draft');
    expect(input.closest('[inert]')).toHaveStyle({ visibility: 'hidden' });
    expect(container).not.toHaveAttribute('aria-hidden', 'true');
    expect(document.body.style.overflow).not.toBe('hidden');
    fireEvent.keyDown(screen.getByRole('button', { name: 'Check in' }), { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    model.locked = false;
    rerender(<Till>{surface}</Till>);
    expect(input).toBeVisible();
    expect(input).toHaveValue('saved draft');
  });
});
