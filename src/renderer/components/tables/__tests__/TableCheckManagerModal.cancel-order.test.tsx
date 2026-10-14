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
  toastError: vi.fn(),
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
vi.mock('react-i18next', () => ({ useTranslation: () => ({ i18n: { language: 'en' }, t: (key: string) => ({ 'modals.orderCancellation.confirm': 'Cancel the order', 'modals.orderCancellation.keepOrder': 'Keep order', 'modals.orderCancellation.cashDrawer': 'Cash drawer', 'modals.orderCancellation.bank': 'Bank' }[key] ?? key) }) }));
vi.mock('react-hot-toast', () => ({
  default: Object.assign(vi.fn(), { success: vi.fn(), error: mocks.toastError, dismiss: vi.fn() }),
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
    mocks.invoke.mockReset().mockImplementation(async (_command, args) => ({ success: true, ...args, requiresReturn: false, requiresHandback: false, amountCents: 0, currency: 'EUR', generation: 'generation-1', requestId: 'cancel-event-1' }));
    mocks.orders.mockResolvedValue([order]);
    mocks.payments.mockResolvedValue([]);
    mocks.snapshot.mockReset().mockResolvedValue({ netPaid: 0, outstandingAmount: 30, cancelRefusal: null });
    mocks.get.mockReset().mockResolvedValue({ success: true, data: { success: true, session } });
    mocks.patch.mockReset().mockResolvedValue({ success: true, data: { success: true } });
    mocks.cancelWithApproval.mockReset().mockResolvedValue({ success: true, orderId: 'local-order', data: { workflow: {
      affected_session_ids: [sessionId, 'sibling-check'], affected_table_ids: ['T01', 'T02'],
    } } });
    mocks.emit.mockClear();
    mocks.toastError.mockClear();
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

  it('keeps waiter selection open when the standalone caller omits localOrders', async () => {
    // Bound subsequent reads so the broken reload loop fails through observable UI,
    // rather than leaving the test runner in an unbounded promise/render loop.
    mocks.get.mockResolvedValueOnce({ success: true, data: { success: true, session } })
      .mockImplementation(() => new Promise(() => {}));
    mocks.directory.mockResolvedValue({ staff: [{ id: 'waiter-1', name: 'Alice Waiter', isActive: true, canLoginPos: true }] });
    render(<TableCheckManagerModal isOpen tables={[table]} table={table} onClose={onClose}
      onAddItems={vi.fn()} onRefreshOrders={refresh} onRefreshTables={refresh} />);
    await waitFor(() => expect(screen.getByText('Coffee')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Assign' }));
    const sheet = screen.getAllByRole('dialog').at(-1)!;
    fireEvent.click(within(sheet).getByRole('button', { name: /Alice Waiter/ }));
    expect(within(sheet).getByRole('button', { name: 'Save Waiter' })).toBeInTheDocument();
    expect(screen.getAllByRole('dialog')).toContain(sheet);
    expect(mocks.get).toHaveBeenCalledTimes(1);
  });

  it('preserves a payment draft through a periodic same-check parent snapshot refresh, including the read in flight', async () => {
    const canonical = { ...session, snapshot_revision: 21, order: { ...session.order, version: 7 } };
    mocks.get.mockResolvedValue({ success: true, data: { success: true, session: canonical } });
    const base = { isOpen: true, table, tables: [table], localOrders: [order] as any, onClose,
      onAddItems: vi.fn(), onRefreshOrders: refresh, onRefreshTables: refresh };
    const view = render(<TableCheckManagerModal {...base} />);
    await waitFor(() => expect(screen.getByText('Coffee')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Pay' }));
    const sheet = screen.getAllByRole('dialog').at(-1)!;
    const fields = within(sheet).getAllByRole('textbox');
    fireEvent.change(fields[0], { target: { value: '12.34' } });
    fireEvent.change(fields[1], { target: { value: '1.50' } });
    fireEvent.change(fields[2], { target: { value: '2' } });
    let finishRead!: (value: unknown) => void;
    mocks.get.mockImplementationOnce(() => new Promise(resolve => { finishRead = resolve; }));
    view.rerender(<TableCheckManagerModal {...base} table={{ ...table }} localOrders={[{ ...order }] as any}
      onRefreshTables={vi.fn()} />);
    await waitFor(() => expect(mocks.get).toHaveBeenCalledTimes(2));
    expect(screen.getAllByRole('dialog')).toContain(sheet);
    expect(within(sheet).getAllByRole('textbox').map(field => (field as HTMLInputElement).value)).toEqual(['12,34', '1,50', '2']);
    await act(async () => { finishRead({ success: true, data: { success: true, session: { ...canonical } } }); });
    expect(screen.getAllByRole('dialog')).toContain(sheet);
    expect(within(sheet).getAllByRole('textbox').map(field => (field as HTMLInputElement).value)).toEqual(['12,34', '1,50', '2']);
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it('invalidates a payment draft visibly when the same check has a newer canonical version', async () => {
    const canonical = { ...session, snapshot_revision: 21, order: { ...session.order, version: 7 } };
    mocks.get.mockResolvedValue({ success: true, data: { success: true, session: canonical } });
    const base = { isOpen: true, table, tables: [table], localOrders: [order] as any, onClose,
      onAddItems: vi.fn(), onRefreshOrders: refresh, onRefreshTables: refresh };
    const view = render(<TableCheckManagerModal {...base} />);
    await waitFor(() => expect(screen.getByText('Coffee')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Pay' }));
    mocks.get.mockResolvedValue({ success: true, data: { success: true,
      session: { ...canonical, snapshot_revision: 22, order: { ...canonical.order, version: 8 } } } });
    view.rerender(<TableCheckManagerModal {...base} localOrders={[{ ...order, version: 8 }] as any} />);
    await waitFor(() => expect(mocks.get).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Pay Table' })).not.toBeInTheDocument());
    expect(mocks.toastError).toHaveBeenCalledWith('The check changed. Review its updated items and balance before continuing.');
    expect(mocks.cancelWithApproval).not.toHaveBeenCalled();
  });

  it('does not apply an older response after a newer parent refresh has completed', async () => {
    // Keep this race isolated from local item decoration: both replies carry
    // their own complete canonical items.
    mocks.orders.mockResolvedValue([]);
    const canonical = { ...session, snapshot_revision: 21, order: { ...session.order, version: 7 } };
    mocks.get.mockResolvedValue({ success: true, data: { success: true, session: canonical } });
    const base = { isOpen: true, table, tables: [table], localOrders: [] as any, onClose,
      onAddItems: vi.fn(), onRefreshOrders: refresh, onRefreshTables: refresh };
    const view = render(<TableCheckManagerModal {...base} />);
    await waitFor(() => expect(screen.getByText('Coffee')).toBeInTheDocument());
    let finishOlderRead!: (value: unknown) => void;
    mocks.get.mockImplementationOnce(() => new Promise(resolve => { finishOlderRead = resolve; }));
    view.rerender(<TableCheckManagerModal {...base} localOrders={[] as any} />);
    await waitFor(() => expect(mocks.get).toHaveBeenCalledTimes(2));
    const latest = { ...canonical, snapshot_revision: 22,
      order: { ...canonical.order, version: 8, order_items: [{ ...line, name: 'Fresh Coffee' }] } };
    mocks.get.mockResolvedValue({ success: true, data: { success: true, session: latest } });
    view.rerender(<TableCheckManagerModal {...base} localOrders={[] as any} />);
    await waitFor(() => expect(screen.getByText('Fresh Coffee')).toBeInTheDocument());
    await act(async () => { finishOlderRead({ success: true, data: { success: true, session: canonical } }); });
    expect(screen.getByText('Fresh Coffee')).toBeInTheDocument();
    expect(screen.queryByText('Coffee')).not.toBeInTheDocument();
    expect(mocks.invoke.mock.calls.filter(([command]) => command === 'orders:apply-table-session-snapshot')).toHaveLength(2);
  });

  it('does not persist a pending reply after closing the check', async () => {
    let finishRead!: (value: unknown) => void;
    mocks.get.mockImplementationOnce(() => new Promise(resolve => { finishRead = resolve; }));
    const base = { isOpen: true, table, tables: [table], localOrders: [order] as any, onClose,
      onAddItems: vi.fn(), onRefreshOrders: refresh, onRefreshTables: refresh };
    const view = render(<TableCheckManagerModal {...base} />);
    await waitFor(() => expect(mocks.get).toHaveBeenCalledTimes(1));
    view.rerender(<TableCheckManagerModal {...base} isOpen={false} />);
    await act(async () => { finishRead({ success: true, data: { success: true, session } }); });
    expect(mocks.invoke.mock.calls.filter(([command]) => command === 'orders:apply-table-session-snapshot')).toHaveLength(0);
    expect(mocks.emit).not.toHaveBeenCalled();
  });

  it('does not persist or display a reply belonging to another check', async () => {
    mocks.get.mockResolvedValue({ success: true, data: { success: true, session: { ...session, id: 'another-check' } } });
    render(<TableCheckManagerModal isOpen tables={[table]} table={table} localOrders={[order] as any}
      onClose={onClose} onAddItems={vi.fn()} onRefreshOrders={refresh} onRefreshTables={refresh} />);
    await waitFor(() => expect(screen.queryByText('Loading table check...')).not.toBeInTheDocument());
    expect(screen.queryByText('Coffee')).not.toBeInTheDocument();
    expect(mocks.invoke.mock.calls.filter(([command]) => command === 'orders:apply-table-session-snapshot')).toHaveLength(0);
    expect(mocks.toastError).toHaveBeenCalled();
  });

  it.each([{ organization_id: 'another-org' }, { branch_id: 'another-branch' }])(
    'does not persist a reply with another tenant scope: %j', async foreignScope => {
      mocks.get.mockResolvedValue({ success: true, data: { success: true, session: { ...session, ...foreignScope } } });
      render(<TableCheckManagerModal isOpen tables={[table]} table={table} localOrders={[order] as any}
        onClose={onClose} onAddItems={vi.fn()} onRefreshOrders={refresh} onRefreshTables={refresh} />);
      await waitFor(() => expect(screen.queryByText('Loading table check...')).not.toBeInTheDocument());
      expect(screen.queryByText('Coffee')).not.toBeInTheDocument();
      expect(mocks.invoke.mock.calls.filter(([command]) => command === 'orders:apply-table-session-snapshot')).toHaveLength(0);
      expect(mocks.toastError).toHaveBeenCalled();
    },
  );

  it('retains the newer check as read-only when a subsequent response regresses its revision', async () => {
    const canonical = { ...session, snapshot_revision: 22, order: { ...session.order, version: 8 } };
    mocks.get.mockResolvedValue({ success: true, data: { success: true, session: canonical } });
    const base = { isOpen: true, table, tables: [table], localOrders: [order] as any, onClose,
      onAddItems: vi.fn(), onRefreshOrders: refresh, onRefreshTables: refresh };
    const view = render(<TableCheckManagerModal {...base} />);
    await waitFor(() => expect(screen.getByText('Coffee')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Pay' }));
    const sheet = screen.getAllByRole('dialog').at(-1)!;
    fireEvent.change(within(sheet).getAllByRole('textbox')[0], { target: { value: '12.34' } });
    mocks.get.mockResolvedValue({ success: true, data: { success: true,
      session: { ...canonical, snapshot_revision: 21, order: { ...canonical.order, version: 7 } } } });
    view.rerender(<TableCheckManagerModal {...base} localOrders={[{ ...order }] as any} />);
    await waitFor(() => expect(screen.getByText(/Saved check — amounts may be stale/)).toBeInTheDocument());
    expect(screen.getAllByRole('dialog')).toContain(sheet);
    expect((within(sheet).getAllByRole('textbox')[0] as HTMLInputElement).value).toBe('12,34');
    expect(within(sheet).getByRole('button', { name: 'Cash' })).toBeDisabled();
    expect(mocks.invoke.mock.calls.filter(([command]) => command === 'orders:apply-table-session-snapshot')).toHaveLength(1);
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it('offers the return channel before the reason for a fully paid manual table', async () => {
    mocks.get.mockResolvedValue({ success: true, data: { success: true, session: { ...session,
      balance: { order_total: 30, paid_total: 30, outstanding_balance: 0 } } } });
    mocks.invoke.mockImplementation(async (command, args) => command === 'order_prepare_manual_cancel'
      ? { success: true, ...args, requiresReturn: true, requiresHandback: true, amountCents: 3000,
          currency: 'EUR', generation: 'paid-generation', requestId: 'paid-table-event' }
      : { success: true });
    render(<TableCheckManagerModal isOpen tables={[table]} table={table} localOrders={[order] as any}
      onClose={onClose} onAddItems={vi.fn()} onRefreshOrders={refresh} onRefreshTables={refresh} />);
    await waitFor(() => expect(screen.queryByText('Loading table check...')).not.toBeInTheDocument());
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Cancel the order' })); });
    const sheet = screen.getAllByRole('dialog').at(-1)!;
    expect(within(sheet).queryByRole('textbox')).toBeNull();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Bank' }));
    fireEvent.change(within(sheet).getByRole('textbox'), { target: { value: 'Returned through bank' } });
    await act(async () => { fireEvent.click(within(sheet).getByRole('button', { name: 'Cancel the order' })); });
    expect(mocks.cancelWithApproval).toHaveBeenCalledWith(expect.objectContaining({
      clientEventId: 'paid-table-event', reason: 'Returned through bank',
      manualCancellation: { generation: 'paid-generation', returnChannel: 'bank' }, tableSessionId: sessionId,
    }));
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

  // Review 06/10/2026: a refused attempt is never sent again, and the check
  // manager had no way to clear it, so the table and the Z stayed held.
  it('lets a manager clear a refused attempt from the check, then offers a fresh cancellation', async () => {
    let prepared = 0;
    mocks.invoke.mockImplementation(async (command, args) => {
      if (command !== 'order_prepare_manual_cancel') return { success: true };
      prepared += 1;
      return prepared === 1
        ? { success: true, ...args, requiresReturn: false, requiresHandback: false, amountCents: 0, currency: 'EUR',
            generation: 'generation-1', requestId: 'refused-event', pending: true, refused: true, reason: 'No show' }
        : { success: true, ...args, requiresReturn: false, requiresHandback: false, amountCents: 0, currency: 'EUR',
            generation: 'generation-2', requestId: 'fresh-event' };
    });
    mocks.cancelWithApproval.mockReset().mockResolvedValue({ success: true, released: true });
    render(<TableCheckManagerModal isOpen tables={[table]} table={table} localOrders={[order] as any}
      onClose={onClose} onAddItems={vi.fn()} onRefreshOrders={refresh} onRefreshTables={refresh} />);
    await waitFor(() => expect(screen.queryByText('Loading table check...')).not.toBeInTheDocument());
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Cancel the order' })); });

    const sheet = screen.getAllByRole('dialog').at(-1)!;
    expect(within(sheet).getByTestId('order-cancellation-saved-attempt')).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(within(sheet).getByRole('button', { name: 'modals.orderCancellation.clearRefusedAttempt' }));
    });

    await waitFor(() => expect(mocks.cancelWithApproval).toHaveBeenCalledWith(expect.objectContaining({
      orderId: 'remote-order', tableSessionId: sessionId,
      releaseRefusedCancellation: { clientEventId: 'refused-event' },
    })));
    await waitFor(() => expect(prepared).toBe(2));
    await waitFor(() => expect(screen.queryByTestId('order-cancellation-saved-attempt')).toBeNull());
    expect(mocks.cancelWithApproval).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  // Round 2 review (01/10/2026; founder rule: a refusal comes before any
  // reason or PIN). An order labelled paid with no payment record here is
  // refused when "Cancel the order" is pressed: no reason is asked.
  it('refuses a paid label with no payment record before it asks the reason', async () => {
    mocks.invoke.mockImplementation(async (command) => { if (command === 'order_prepare_manual_cancel') throw new Error('ORDER_PAYMENT_NOT_RECORDED'); return { success: true }; });
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
    expect(mocks.invoke).toHaveBeenCalledWith('order_prepare_manual_cancel', { orderId: 'remote-order', tableSessionId: sessionId });
    expect(screen.getAllByRole('dialog')).toHaveLength(dialogsBefore);
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(mocks.cancelWithApproval).not.toHaveBeenCalled();
  });
});
