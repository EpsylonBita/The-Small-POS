import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  get: vi.fn(), patch: vi.fn(), invoke: vi.fn(), emit: vi.fn(), orders: vi.fn(), payments: vi.fn(),
  t: (_key: string, options: any) => String(options?.defaultValue || _key).replace(/\{\{(\w+)\}\}/g, (_match, name) => String(options[name] ?? '')),
  directory: vi.fn().mockResolvedValue({ staff: [] }),
}));
vi.mock('../../../contexts/i18n-context', () => ({ useI18n: () => ({ t: mocks.t }) }));
vi.mock('../../../utils/api-helpers', () => ({ posApiGet: mocks.get, posApiPatch: mocks.patch, posApiPost: vi.fn() }));
vi.mock('../../../../lib', () => ({ getBridge: () => ({
  invoke: mocks.invoke, orders: { getAll: mocks.orders },
  payments: { getOrderPayments: mocks.payments, getPaidItems: async () => [] },
  staffAuth: { refreshDirectory: mocks.directory },
}), emitCompatEvent: mocks.emit }));
vi.mock('../../../utils/tableSessionOfflineQueue', () => ({ isRetryableTableServiceError: () => false }));
vi.mock('../../../utils/format', () => ({ formatCurrency: (amount: number) => `EUR ${amount.toFixed(2)}` }));
vi.mock('framer-motion', () => ({
  AnimatePresence: ({ children }: any) => children,
  motion: {
    div: React.forwardRef(({ children, initial, animate, exit, transition, ...props }: any, ref: any) => <div ref={ref} {...props}>{children}</div>),
    button: React.forwardRef(({ children, initial, animate, exit, transition, whileTap, whileHover, ...props }: any, ref: any) => <button ref={ref} {...props}>{children}</button>),
  },
}));
import { TableCheckManagerModal } from '../TableCheckManagerModal';

const sourceId = '11111111-1111-4111-8111-111111111111';
const targetId = '22222222-2222-4222-8222-222222222222';
const original = { id: 'line-1', menu_item_id: 'menu-1', name: 'Coffee', quantity: 3, unit_price: 10, total_price: 30 };
const order = { id: 'local-order', supabase_id: 'remote-order', table_id: 'T01', table_number: 'T01', table_session_id: sourceId,
  order_type: 'dine-in', status: 'pending', total_amount: 30, items: [original] };
const t1: any = { id: 'T01', tableNumber: 'T01', tableSessionId: sourceId, currentOrderId: 'remote-order', status: 'occupied', branchId: 'branch', organizationId: 'org' };
const t2: any = { ...t1, id: 'T02', tableNumber: 'T02', tableSessionId: null, currentOrderId: undefined, status: 'available' };
const makeSession = (id: string, tableId: string, quantity: number) => ({
  id, primary_table_id: tableId, active_order_id: 'remote-order', status: 'open', guest_count: 1,
  order: { id: 'remote-order', table_session_id: sourceId, table_id: tableId, table_display_number: tableId, total_amount: 30, order_items: [{ ...original, quantity, total_price: quantity * 10 }] },
  items: [{ order_item_id: 'line-1', quantity, status: 'open' }],
  balance: { order_total: quantity * 10, paid_total: 0, outstanding_balance: quantity * 10 }, payments: [],
});
const refresh = vi.fn();
const props = { isOpen: true, tables: [t1, t2], table: t1, localOrders: [order] as any,
  onClose: vi.fn(), onAddItems: vi.fn(), onRefreshOrders: refresh, onRefreshTables: refresh };

describe('table check workflow ownership', () => {
  afterEach(cleanup);
  beforeEach(() => {
    mocks.invoke.mockResolvedValue({ success: true });
    mocks.orders.mockResolvedValue([order]);
    mocks.payments.mockResolvedValue([{ id: 'local-payment', table_session_id: sourceId, status: 'completed', amount: 15 }]);
  });

  it('reopens a partial destination with 1 x 10 and no source receipt despite the stale full local order', async () => {
    const target = { ...t2, tableSessionId: targetId, currentOrderId: 'remote-order', status: 'occupied' };
    mocks.get.mockResolvedValue({ success: true, data: { success: true, session: makeSession(targetId, 'T02', 1) } });
    const first = render(<TableCheckManagerModal {...props} table={target} tables={[t1, target]} />);
    await waitFor(() => expect(screen.queryByText('Loading table check...')).not.toBeInTheDocument());
    expect(screen.getByText('Coffee')).toBeInTheDocument();
    expect(screen.queryByText('EUR 30.00')).not.toBeInTheDocument();
    expect(screen.queryByText('EUR 15.00')).not.toBeInTheDocument();
    expect(mocks.invoke).toHaveBeenCalledWith('orders:apply-table-session-snapshot', expect.objectContaining({ session: expect.objectContaining({ id: targetId }) }));
    first.unmount();
    render(<TableCheckManagerModal {...props} table={target} tables={[t1, target]} />);
    await waitFor(() => expect(screen.queryByText('Loading table check...')).not.toBeInTheDocument());
    expect(screen.getAllByText('EUR 10.00').length).toBeGreaterThan(0);
    expect(screen.queryByText('EUR 30.00')).not.toBeInTheDocument();
  });

  it('updates the whole-move title and releases the old table projection', async () => {
    mocks.payments.mockResolvedValue([]);
    let moved = false;
    mocks.get.mockImplementation(async (url: string) => ({ success: true, data: url.includes('?')
      ? { success: true, sessions: [{ id: sourceId }] }
      : { success: true, session: makeSession(sourceId, moved ? 'T02' : 'T01', 3) } }));
    mocks.patch.mockImplementation(async () => { moved = true; return { success: true, data: { success: true, session: makeSession(sourceId, 'T02', 3) } }; });
    render(<TableCheckManagerModal {...props} />);
    await waitFor(() => expect(screen.queryByText('Loading table check...')).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Move' }));
    const sheet = screen.getAllByRole('dialog').at(-1)!;
    fireEvent.click(within(sheet).getByRole('option', { name: /T02/ }));
    fireEvent.click(within(sheet).getByRole('button', { name: 'Move Check' }));
    await waitFor(() => expect(screen.getByRole('heading', { name: /Table.*T02.*Check/ })).toBeInTheDocument());
    expect(screen.queryByRole('heading', { name: /Table.*T01.*Check/ })).not.toBeInTheDocument();
    expect(mocks.emit).toHaveBeenCalledWith('table-session-settled', expect.objectContaining({ tableId: 'T01', releaseStatus: 'available' }));
    expect(mocks.patch).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ action: 'move_table', target_table_id: 'T02' }));
  });

  it('keeps the authoritative allocated discount when the local full-order prices are stale', async () => {
    const target = { ...t2, tableSessionId: targetId, currentOrderId: 'remote-order', status: 'occupied' };
    const session = makeSession(targetId, 'T02', 1);
    session.balance = { order_total: 9, paid_total: 0, outstanding_balance: 9 };
    mocks.get.mockResolvedValue({ success: true, data: { success: true, session } });
    render(<TableCheckManagerModal {...props} table={target} tables={[t1, target]} />);
    await waitFor(() => expect(screen.getByText('Coffee')).toBeInTheDocument());
    expect(screen.getAllByText('EUR 9.00').length).toBeGreaterThan(0);
    expect(screen.queryByText('EUR 30.00')).not.toBeInTheDocument();
  });
});
