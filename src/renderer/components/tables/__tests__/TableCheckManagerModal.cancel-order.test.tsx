import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

// Item D1, fix review 30/09/2026. An order that still owes money could not be
// cancelled from its table check: a table released with money owed left it
// open (the server no longer cancels it), payable but never cancellable.
// The check now cancels it explicitly: a reason, then the manager's
// approval, then the table's session ends and the table is freed.

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  patch: vi.fn(),
  invoke: vi.fn(),
  emit: vi.fn(),
  orders: vi.fn(),
  payments: vi.fn(),
  snapshot: vi.fn(),
  cancelWithApproval: vi.fn(),
  confirmPrivilegedAction: vi.fn(),
  t: (_key: string, options: any) =>
    String(options?.defaultValue || _key).replace(/\{\{(\w+)\}\}/g, (_match, name) =>
      String(options?.[name] ?? ''),
    ),
  directory: vi.fn().mockResolvedValue({ staff: [] }),
}));
vi.mock('../../../contexts/i18n-context', () => ({ useI18n: () => ({ t: mocks.t }) }));
vi.mock('../../../utils/api-helpers', () => ({
  posApiGet: mocks.get,
  posApiPatch: mocks.patch,
  posApiPost: vi.fn(),
}));
vi.mock('../../../../lib', () => ({
  getBridge: () => ({
    invoke: mocks.invoke,
    orders: { getAll: mocks.orders, cancelWithApproval: mocks.cancelWithApproval },
    payments: {
      getOrderPayments: mocks.payments,
      getPaidItems: async () => [],
      getSettlementSnapshot: mocks.snapshot,
    },
    staffAuth: { refreshDirectory: mocks.directory },
    auth: { confirmPrivilegedAction: mocks.confirmPrivilegedAction },
  }),
  emitCompatEvent: mocks.emit,
}));
vi.mock('../../../utils/tableSessionOfflineQueue', () => ({
  isRetryableTableServiceError: () => false,
  enqueueTableSessionUpdate: vi.fn(async () => 'queued'),
}));
vi.mock('../../../utils/format', () => ({
  formatCurrency: (amount: number) => `EUR ${amount.toFixed(2)}`,
}));
vi.mock('react-hot-toast', () => ({
  default: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), dismiss: vi.fn() }),
}));
vi.mock('framer-motion', () => ({
  AnimatePresence: ({ children }: any) => children,
  motion: {
    div: React.forwardRef(({ children, initial, animate, exit, transition, ...props }: any, ref: any) => (
      <div ref={ref} {...props}>
        {children}
      </div>
    )),
    button: React.forwardRef(
      ({ children, initial, animate, exit, transition, whileTap, whileHover, ...props }: any, ref: any) => (
        <button ref={ref} {...props}>
          {children}
        </button>
      ),
    ),
  },
}));
import { TableCheckManagerModal } from '../TableCheckManagerModal';

const sessionId = '11111111-1111-4111-8111-111111111111';
const line = { id: 'line-1', menu_item_id: 'menu-1', name: 'Coffee', quantity: 3, unit_price: 10, total_price: 30 };
const order = {
  id: 'local-order',
  supabase_id: 'remote-order',
  table_id: 'T01',
  table_number: 'T01',
  table_session_id: sessionId,
  order_type: 'dine-in',
  status: 'pending',
  total_amount: 30,
  items: [line],
};
const table: any = {
  id: 'T01',
  tableNumber: 'T01',
  tableSessionId: sessionId,
  currentOrderId: 'remote-order',
  status: 'occupied',
  branchId: 'branch',
  organizationId: 'org',
};
const session = {
  id: sessionId,
  primary_table_id: 'T01',
  active_order_id: 'remote-order',
  status: 'open',
  guest_count: 1,
  order: {
    id: 'remote-order',
    table_session_id: sessionId,
    table_id: 'T01',
    table_display_number: 'T01',
    total_amount: 30,
    order_items: [line],
  },
  items: [{ order_item_id: 'line-1', quantity: 3, status: 'open' }],
  balance: { order_total: 30, paid_total: 0, outstanding_balance: 30 },
  payments: [],
};
const onClose = vi.fn();
const refresh = vi.fn();

describe('cancelling an owing order from its table check', { timeout: 20_000 }, () => {
  afterEach(cleanup);
  beforeEach(() => {
    mocks.invoke.mockResolvedValue({ success: true });
    mocks.orders.mockResolvedValue([order]);
    mocks.payments.mockResolvedValue([]);
    mocks.snapshot.mockReset().mockResolvedValue({ netPaid: 0, outstandingAmount: 30, cancelRefusal: null });
    mocks.get.mockResolvedValue({ success: true, data: { success: true, session } });
    mocks.patch.mockReset().mockResolvedValue({ success: true, data: { success: true } });
    mocks.cancelWithApproval.mockReset().mockResolvedValue({ success: true, orderId: 'local-order', data: { workflow: {
      affected_session_ids: [sessionId, 'sibling-check'], affected_table_ids: ['T01', 'T02'],
    } } });
    mocks.emit.mockClear();
    onClose.mockClear();
  });

  it('asks a reason, runs the approval, cancels the order and frees the table', async () => {
    render(
      <TableCheckManagerModal
        isOpen
        tables={[table]}
        table={table}
        localOrders={[order] as any}
        onClose={onClose}
        onAddItems={vi.fn()}
        onRefreshOrders={refresh}
        onRefreshTables={refresh}
      />,
    );
    await waitFor(() => expect(screen.queryByText('Loading table check...')).not.toBeInTheDocument());

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancel the order' }));
    });
    const sheet = screen.getAllByRole('dialog').at(-1)!;
    const confirm = within(sheet).getByRole('button', { name: 'Cancel the order' });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(within(sheet).getByRole('textbox'), {
      target: { value: 'The customer left without ordering' },
    });
    await act(async () => {
      fireEvent.click(within(sheet).getByRole('button', { name: 'Cancel the order' }));
    });

    await waitFor(() =>
      expect(mocks.cancelWithApproval).toHaveBeenCalledWith(expect.objectContaining({
        orderId: 'remote-order',
        reason: 'The customer left without ordering',
        tableSessionId: sessionId,
      })),
    );
    expect(mocks.patch).not.toHaveBeenCalled();
    expect(mocks.emit).toHaveBeenCalledWith('table-session-settled', expect.objectContaining({ tableId: 'T01', releaseStatus: 'available' }));
    expect(mocks.emit).toHaveBeenCalledWith('table-session-settled', expect.objectContaining({ tableId: 'T02', releaseStatus: 'available' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('keeps the order and the table when the approval is refused', async () => {
    mocks.cancelWithApproval.mockRejectedValue(new Error('Privileged action confirmation cancelled'));
    render(
      <TableCheckManagerModal
        isOpen
        tables={[table]}
        table={table}
        localOrders={[order] as any}
        onClose={onClose}
        onAddItems={vi.fn()}
        onRefreshOrders={refresh}
        onRefreshTables={refresh}
      />,
    );
    await waitFor(() => expect(screen.queryByText('Loading table check...')).not.toBeInTheDocument());
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancel the order' }));
    });
    const sheet = screen.getAllByRole('dialog').at(-1)!;
    fireEvent.change(within(sheet).getByRole('textbox'), { target: { value: 'No show' } });
    await act(async () => {
      fireEvent.click(within(sheet).getByRole('button', { name: 'Cancel the order' }));
    });

    expect(mocks.patch).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('refuses an order money was taken on and says what to do', async () => {
    mocks.cancelWithApproval.mockRejectedValue(
      'ORDER_HAS_PAYMENTS: money was taken on this order. Void or refund it from the order first, or collect the rest.',
    );
    const toast = (await import('react-hot-toast')).default as unknown as {
      error: ReturnType<typeof vi.fn>;
    };
    toast.error.mockClear();
    render(
      <TableCheckManagerModal
        isOpen
        tables={[table]}
        table={table}
        localOrders={[order] as any}
        onClose={onClose}
        onAddItems={vi.fn()}
        onRefreshOrders={refresh}
        onRefreshTables={refresh}
      />,
    );
    await waitFor(() => expect(screen.queryByText('Loading table check...')).not.toBeInTheDocument());
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancel the order' }));
    });
    const sheet = screen.getAllByRole('dialog').at(-1)!;
    fireEvent.change(within(sheet).getByRole('textbox'), { target: { value: 'The customer left' } });
    await act(async () => {
      fireEvent.click(within(sheet).getByRole('button', { name: 'Cancel the order' }));
    });

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        'Money was taken on this order. Void or refund it from the order first, or collect the rest.',
      ),
    );
    expect(mocks.patch).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  // Round 2 review (01/10/2026; founder rule: a refusal comes before any
  // reason or PIN). An order labelled paid with no payment record here is
  // refused when "Cancel the order" is pressed: no reason is asked.
  it('refuses a paid label with no payment record before it asks the reason', async () => {
    mocks.snapshot.mockResolvedValue({
      netPaid: 0,
      outstandingAmount: 30,
      cancelRefusal: 'ORDER_PAYMENT_NOT_RECORDED',
    });
    const toast = (await import('react-hot-toast')).default as unknown as {
      error: ReturnType<typeof vi.fn>;
    };
    toast.error.mockClear();
    render(
      <TableCheckManagerModal
        isOpen
        tables={[table]}
        table={table}
        localOrders={[order] as any}
        onClose={onClose}
        onAddItems={vi.fn()}
        onRefreshOrders={refresh}
        onRefreshTables={refresh}
      />,
    );
    await waitFor(() => expect(screen.queryByText('Loading table check...')).not.toBeInTheDocument());
    const dialogsBefore = screen.getAllByRole('dialog').length;

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancel the order' }));
    });

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        'This order is marked paid, but its payment is not recorded on this till. Restore it from the server with Sync Now, or record the payment from the Z Report, then cancel.',
      ),
    );
    expect(mocks.snapshot).toHaveBeenCalledWith('remote-order');
    expect(screen.getAllByRole('dialog')).toHaveLength(dialogsBefore);
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(mocks.cancelWithApproval).not.toHaveBeenCalled();
  });
});
