import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  get: vi.fn(), patch: vi.fn(), invoke: vi.fn(), emit: vi.fn(), orders: vi.fn(), payments: vi.fn(),
  updateItems: vi.fn(), toastError: vi.fn(),
  post: vi.fn(), enqueueTransfer: vi.fn(), retryable: vi.fn(),
  recordPayment: vi.fn(), enqueueUpdate: vi.fn(),
  t: (_key: string, options: any) => String(options?.defaultValue || _key).replace(/\{\{(\w+)\}\}/g, (_match, name) => String(options[name] ?? '')),
  directory: vi.fn().mockResolvedValue({ staff: [] }),
}));
vi.mock('../../../contexts/i18n-context', () => ({ useI18n: () => ({ t: mocks.t }) }));
vi.mock('../../../utils/api-helpers', () => ({ posApiGet: mocks.get, posApiPatch: mocks.patch, posApiPost: mocks.post }));
vi.mock('../../../../lib', () => ({ getBridge: () => ({
  invoke: mocks.invoke, orders: { getAll: mocks.orders, updateItems: mocks.updateItems },
  payments: { getOrderPayments: mocks.payments, getPaidItems: async () => [], recordPayment: mocks.recordPayment },
  staffAuth: { refreshDirectory: mocks.directory },
}), emitCompatEvent: mocks.emit }));
vi.mock('../../../utils/tableSessionOfflineQueue', () => ({
  isRetryableTableServiceError: mocks.retryable,
  enqueueTableItemTransfer: mocks.enqueueTransfer,
  enqueueTableSessionUpdate: mocks.enqueueUpdate,
}));
vi.mock('../../../utils/format', () => ({ formatCurrency: (amount: number) => `EUR ${amount.toFixed(2)}` }));
vi.mock('react-hot-toast', () => ({ default: { success: vi.fn(), error: mocks.toastError } }));
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
  order: { id: 'remote-order', version: 1, table_session_id: sourceId, table_id: tableId, table_display_number: tableId, total_amount: 30, order_items: [{ ...original, quantity, total_price: quantity * 10 }] },
  items: [{ order_item_id: 'line-1', quantity, status: 'open' }],
  balance: { order_total: quantity * 10, paid_total: 0, outstanding_balance: quantity * 10 }, payments: [],
});
const refresh = vi.fn();
const props = { isOpen: true, tables: [t1, t2], table: t1, localOrders: [order] as any,
  onClose: vi.fn(), onAddItems: vi.fn(), onRefreshOrders: refresh, onRefreshTables: refresh };

describe('table check workflow ownership', () => {
  afterEach(cleanup);
  beforeEach(() => {
    mocks.invoke.mockReset().mockResolvedValue({ success: true });
    mocks.orders.mockResolvedValue([order]);
    mocks.payments.mockResolvedValue([{ id: 'local-payment', table_session_id: sourceId, status: 'completed', amount: 15 }]);
    mocks.updateItems.mockResolvedValue({ success: true });
    mocks.retryable.mockReturnValue(false);
    mocks.enqueueTransfer.mockResolvedValue('queued');
    mocks.recordPayment.mockResolvedValue({ success: true, paymentId: 'recorded-payment' });
    mocks.enqueueUpdate.mockResolvedValue('queued-close');
  });

  it('opens a durable saved split scope offline, retains paid claims, and disables collection and edits', async () => {
    const target = { ...t2, tableSessionId: targetId, currentOrderId: 'remote-order', status: 'occupied' };
    const saved = makeSession(targetId, 'T02', 1);
    saved.balance = { ...saved.balance, paid_total: 5, outstanding_balance: 5 };
    mocks.get.mockRejectedValue(new Error('Offline'));
    mocks.retryable.mockReturnValue(true);
    mocks.invoke.mockImplementation(async (channel: string) => channel === 'orders:get-table-session-snapshot'
      ? { success: true, stale: true, session: saved } : { success: true });
    render(<TableCheckManagerModal {...props} table={target} tables={[t1, target]} />);
    await waitFor(() => expect(screen.queryByText('Loading table check...')).not.toBeInTheDocument());
    expect(screen.getByText('Coffee')).toBeInTheDocument();
    expect(screen.queryByText('EUR 30.00')).not.toBeInTheDocument();
    expect(screen.getAllByText('EUR 5.00').length).toBeGreaterThan(0);
    expect(screen.getByText(/Saved check.*Reconnect/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pay' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Add Items' })).toBeDisabled();
    expect(mocks.recordPayment).not.toHaveBeenCalled();
  });

  it('keeps tipped gross receipts as history while €6 principal remains due and closes only after the second €6', async () => {
    const line = { ...original, quantity: 1, unit_price: 12, total_price: 12 };
    const canonical = { ...order, total_amount: 12, items: [line] };
    const session = { ...makeSession(sourceId, 'T01', 1),
      order: { ...makeSession(sourceId, 'T01', 1).order, total_amount: 12, order_items: [line] },
      balance: { order_total: 12, paid_total: 0, tip_total: 0, outstanding_balance: 12 },
    };
    const receipts: any[] = [];
    mocks.orders.mockResolvedValue([canonical]);
    mocks.payments.mockImplementation(async () => [...receipts]);
    mocks.get.mockResolvedValue({ success: true, data: { success: true, session } });
    mocks.patch.mockResolvedValue({ success: true, data: { success: true } });
    mocks.recordPayment.mockImplementation(async (payload: any) => {
      receipts.push({ ...payload, id: `receipt-${receipts.length}`, status: 'completed' });
      return { success: true, paymentId: receipts.at(-1).id };
    });
    render(<TableCheckManagerModal {...props} localOrders={[canonical] as any} />);
    await waitFor(() => expect(screen.getByText('Coffee')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Pay' }));
    const firstSheet = screen.getAllByRole('dialog').at(-1)!;
    const inputs = within(firstSheet).getAllByRole('textbox');
    fireEvent.change(inputs[0], { target: { value: '6' } });
    fireEvent.change(inputs[1], { target: { value: '8' } });
    fireEvent.click(within(firstSheet).getByRole('button', { name: 'Cash' }));
    await waitFor(() => expect(screen.getByText('Due').nextElementSibling).toHaveTextContent('EUR 6.00'));
    expect(mocks.recordPayment).toHaveBeenCalledWith(expect.objectContaining({ amount: 14, amount_cents: 1400, tip_amount_cents: 800 }));
    // Native branch-country authority chooses the unit; renderer never injects stale EUR.
    expect(mocks.recordPayment.mock.calls.at(-1)?.[0]).not.toHaveProperty('currency');
    expect(screen.getByText('+ EUR 14.00 Cash')).toBeInTheDocument();
    expect(mocks.patch).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'close' }));
    expect(screen.getByRole('button', { name: 'Close Table' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Pay' }));
    const secondSheet = screen.getAllByRole('dialog').at(-1)!;
    fireEvent.change(within(secondSheet).getAllByRole('textbox')[1], { target: { value: '0' } });
    fireEvent.click(within(secondSheet).getByRole('button', { name: 'Cash' }));
    await waitFor(() => expect(mocks.patch).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'close' })));
    expect(mocks.recordPayment).toHaveBeenLastCalledWith(expect.objectContaining({ amount: 6, amount_cents: 600, tip_amount_cents: 0 }));
  });

  it('adds a €2 tip to the full €12 principal and closes after recording €14 gross', async () => {
    const line = { ...original, quantity: 1, unit_price: 12, total_price: 12 };
    const canonical = { ...order, total_amount: 12, items: [line] };
    const session = { ...makeSession(sourceId, 'T01', 1),
      order: { ...makeSession(sourceId, 'T01', 1).order, total_amount: 12, order_items: [line] },
      balance: { order_total: 12, paid_total: 0, tip_total: 0, outstanding_balance: 12 },
    };
    mocks.orders.mockResolvedValue([canonical]);
    mocks.payments.mockResolvedValue([]);
    mocks.get.mockResolvedValue({ success: true, data: { success: true, session } });
    mocks.patch.mockResolvedValue({ success: true, data: { success: true } });
    render(<TableCheckManagerModal {...props} localOrders={[canonical] as any} />);
    await waitFor(() => expect(screen.getByText('Coffee')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Pay' }));
    const sheet = screen.getAllByRole('dialog').at(-1)!;
    fireEvent.change(within(sheet).getAllByRole('textbox')[0], { target: { value: '1' } });
    fireEvent.change(within(sheet).getAllByRole('textbox')[1], { target: { value: '2' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Full Table' }));
    fireEvent.click(within(sheet).getByRole('button', { name: 'Cash' }));
    await waitFor(() => expect(mocks.recordPayment).toHaveBeenCalledWith(expect.objectContaining({
      amount: 14, amount_cents: 1400, tip_amount: 2, tip_amount_cents: 200, cashReceived: 14,
    })));
    await waitFor(() => expect(mocks.patch).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'close' })));
  });

  it('records selected €6 items plus a €2 tip as €8 gross while allocating €6 principal', async () => {
    const lines = [{ ...original, quantity: 1, unit_price: 6, total_price: 6 },
      { ...original, id: 'line-2', name: 'Tea', quantity: 1, unit_price: 6, total_price: 6 }];
    const canonical = { ...order, total_amount: 12, items: lines };
    const session = { ...makeSession(sourceId, 'T01', 1),
      order: { ...makeSession(sourceId, 'T01', 1).order, total_amount: 12, order_items: lines },
      items: lines.map(line => ({ order_item_id: line.id, quantity: 1, status: 'open' })),
      balance: { order_total: 12, paid_total: 0, tip_total: 0, outstanding_balance: 12 },
    };
    const receipts: any[] = [];
    mocks.orders.mockResolvedValue([canonical]);
    mocks.payments.mockImplementation(async () => [...receipts]);
    mocks.get.mockResolvedValue({ success: true, data: { success: true, session } });
    mocks.recordPayment.mockImplementation(async (payload: any) => {
      receipts.push({ ...payload, id: 'selected-receipt', status: 'completed' });
      return { success: true, paymentId: 'selected-receipt' };
    });
    render(<TableCheckManagerModal {...props} localOrders={[canonical] as any} />);
    await waitFor(() => expect(screen.getByText('Coffee')).toBeInTheDocument());
    const coffee = screen.getByText('Coffee').closest('button')!;
    fireEvent(coffee, new MouseEvent('pointerdown', { button: 0, bubbles: true }));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 460)); });
    fireEvent.pointerUp(coffee);
    fireEvent.click(screen.getByRole('button', { name: 'Pay Selected' }));
    const sheet = screen.getAllByRole('dialog').at(-1)!;
    fireEvent.change(within(sheet).getAllByRole('textbox')[0], { target: { value: '2' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Cash' }));
    await waitFor(() => expect(mocks.recordPayment).toHaveBeenCalledWith(expect.objectContaining({
      amount: 8, amount_cents: 800, tip_amount_cents: 200,
      items: [expect.objectContaining({ order_item_id: 'line-1', item_amount: 6, item_amount_cents: 600, item_quantity: 1 })],
    })));
    await waitFor(() => expect(screen.getByText('Due').nextElementSibling).toHaveTextContent('EUR 6.00'));
    expect(mocks.patch).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'close' }));
  });

  it('keeps the tip outside principal after an ordinary refund or proved gift return on reopening', async () => {
    const line = { ...original, quantity: 1, unit_price: 12, total_price: 12 };
    const canonical = { ...order, total_amount: 12, items: [line] };
    const session = { ...makeSession(sourceId, 'T01', 1),
      order: { ...makeSession(sourceId, 'T01', 1).order, total_amount: 12, order_items: [line] },
      balance: { order_total: 12, paid_total: 0, tip_total: 0, outstanding_balance: 12 },
    };
    mocks.orders.mockResolvedValue([canonical]);
    mocks.payments.mockResolvedValue([
      { id: 'ordinary-tip', table_session_id: sourceId, status: 'completed', amount: 14, tipAmount: 8, refundedAmount: 4, remainingRefundable: 10 },
      { id: 'gift-tip', table_session_id: sourceId, status: 'partially_refunded', method: 'gift_card', amount_cents: 1800, tip_amount_cents: 800,
        refunded_amount: 4, metadata: { gift_reversed_amount_cents: 400 } },
    ]);
    mocks.get.mockResolvedValue({ success: true, data: { success: true, session } });
    render(<TableCheckManagerModal {...props} localOrders={[canonical] as any} />);
    await waitFor(() => expect(screen.getByText('Due').nextElementSibling).toHaveTextContent('EUR 4.00'));
    expect(screen.getByRole('button', { name: 'Pay' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Close Table' })).toBeDisabled();
  });

  it('does not substitute a saved check after an authorization denial', async () => {
    mocks.get.mockRejectedValue(new Error('HTTP 403: table permission denied'));
    mocks.retryable.mockReturnValue(false);
    render(<TableCheckManagerModal {...props} />);
    await waitFor(() => expect(screen.queryByText('Loading table check...')).not.toBeInTheDocument());
    expect(screen.queryByText('Coffee')).not.toBeInTheDocument();
    expect(mocks.invoke).not.toHaveBeenCalledWith('orders:get-table-session-snapshot', expect.anything());
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

  const openItemAction = async (action: string) => {
    await waitFor(() => expect(screen.getByText('Coffee')).toBeInTheDocument());
    fireEvent.keyDown(screen.getByText('Coffee').closest('button')!, { key: 'Enter' });
    fireEvent.click(screen.getByRole('button', { name: action }));
  };

  it('does not carry an abandoned table tip into a fresh item payment', async () => {
    mocks.payments.mockResolvedValue([]);
    mocks.get.mockResolvedValue({ success: true, data: { success: true, session: makeSession(sourceId, 'T01', 3) } });
    render(<TableCheckManagerModal {...props} />);
    await waitFor(() => expect(screen.getByText('Coffee')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Pay' }));
    const abandoned = screen.getAllByRole('dialog').at(-1)!;
    fireEvent.change(within(abandoned).getAllByRole('textbox')[1], { target: { value: '8' } });
    fireEvent.click(within(abandoned).getByRole('button', { name: 'Close' }));
    await openItemAction('Pay Item');
    const itemSheet = screen.getAllByRole('dialog').at(-1)!;
    fireEvent.click(within(itemSheet).getByRole('button', { name: 'Cash' }));
    await waitFor(() => expect(mocks.recordPayment).toHaveBeenCalledWith(expect.objectContaining({
      amount: 10, amount_cents: 1000, tip_amount_cents: 0,
      items: [expect.objectContaining({ order_item_id: 'line-1', item_amount: 10 })],
    })));
  });

  it('refuses a destination price edit instead of replacing the full three-coffee order with its one-coffee projection', async () => {
    mocks.payments.mockResolvedValue([]);
    const target = { ...t2, tableSessionId: targetId, currentOrderId: 'remote-order', status: 'occupied' };
    mocks.get.mockResolvedValue({ success: true, data: { success: true, session: makeSession(targetId, 'T02', 1) } });
    render(<TableCheckManagerModal {...props} table={target} tables={[t1, target]} />);
    await openItemAction('Change Price');
    fireEvent.click(screen.getByRole('button', { name: 'Save Price' }));
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalled());
    expect(mocks.updateItems).not.toHaveBeenCalled();
  });

  it('refuses a source discount after a transfer reduced its displayed quantity', async () => {
    mocks.payments.mockResolvedValue([]);
    mocks.get.mockResolvedValue({ success: true, data: { success: true, session: makeSession(sourceId, 'T01', 2) } });
    render(<TableCheckManagerModal {...props} />);
    await openItemAction('Discount');
    fireEvent.click(screen.getByRole('button', { name: 'Apply Discount' }));
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalled());
    expect(mocks.updateItems).not.toHaveBeenCalled();
  });

  it('preserves price editing when this check contains the complete canonical order', async () => {
    mocks.payments.mockResolvedValue([]);
    mocks.get.mockResolvedValue({ success: true, data: { success: true, session: makeSession(sourceId, 'T01', 3) } });
    render(<TableCheckManagerModal {...props} />);
    await openItemAction('Change Price');
    fireEvent.click(screen.getByRole('button', { name: 'Save Price' }));
    await waitFor(() => expect(mocks.updateItems).toHaveBeenCalled());
    expect(mocks.updateItems.mock.calls[0][1][0].quantity).toBe(3);
    expect(mocks.updateItems.mock.calls[0][2]).toEqual({expectedVersion:1,tableSessionId:sourceId});
  });

  it('fails closed when a known split-session read fails instead of offering collection on the full local source order', async () => {
    const target = { ...t2, tableSessionId: targetId, currentOrderId: 'remote-order', status: 'occupied' };
    mocks.get.mockResolvedValue({ success: false, error: 'Offline' });
    render(<TableCheckManagerModal {...props} table={target} tables={[t1, target]} />);
    await waitFor(() => expect(screen.queryByText('Loading table check...')).not.toBeInTheDocument());
    expect(screen.queryByText('Coffee')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Pay$/ })).not.toBeInTheDocument();
    expect(screen.queryByText('EUR 30.00')).not.toBeInTheDocument();
    expect(screen.queryByText('Settled')).not.toBeInTheDocument();
  });

  it('keeps a newly created unsynced unsplit table check usable offline', async () => {
    const local = { ...order, supabase_id: null, table_session_id: null };
    const localTable = { ...t1, tableSessionId: null, currentOrderId: local.id };
    mocks.orders.mockResolvedValue([local]);
    mocks.get.mockResolvedValue({ success: false, error: 'Offline' });
    mocks.payments.mockResolvedValue([]);
    render(<TableCheckManagerModal {...props} localOrders={[local] as any} table={localTable} tables={[localTable, t2]} />);
    await waitFor(() => expect(screen.getByText('Coffee')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /^Pay$/ })).toBeInTheDocument();
  });

  it('refuses whole-order editing when the complete canonical item snapshot is unavailable', async () => {
    mocks.orders.mockResolvedValue([]);
    mocks.payments.mockResolvedValue([]);
    mocks.get.mockResolvedValue({ success: true, data: { success: true, session: makeSession(sourceId, 'T01', 3) } });
    render(<TableCheckManagerModal {...props} localOrders={[]} />);
    await openItemAction('Change Price');
    fireEvent.click(screen.getByRole('button', { name: 'Save Price' }));
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalled());
    expect(mocks.updateItems).not.toHaveBeenCalled();
  });

  it.each(['transferred history', 'another order', 'merged check'])('refuses replacement even when the visible quantity looks complete but the check contains %s', async (scenario) => {
    const session = makeSession(sourceId, 'T01', 3);
    const scopedSession: any = scenario === 'merged check'
      ? { ...session, metadata: { merged_session_ids: [targetId] } }
      : {
          ...session,
          items: scenario === 'another order'
            ? [{ ...session.items[0], order_id: 'another-order' }]
            : [...session.items, { order_item_id: 'line-1', quantity: 1, status: 'transferred' }],
        };
    mocks.payments.mockResolvedValue([]);
    mocks.get.mockResolvedValue({ success: true, data: { success: true, session: scopedSession } });
    render(<TableCheckManagerModal {...props} />);
    await openItemAction('Change Price');
    fireEvent.click(screen.getByRole('button', { name: 'Save Price' }));
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalled());
    expect(mocks.updateItems).not.toHaveBeenCalled();
  });

  it.each(['recorded payment', 'paid status without a receipt', 'paid allocation'])('requires settlement instead of a direct price replacement when the check has %s', async (scenario) => {
    const session: any = makeSession(sourceId, 'T01', 3);
    const canonical = scenario === 'paid status without a receipt'
      ? { ...order, payment_status: 'paid' }
      : order;
    if (scenario === 'paid allocation') session.items[0].paid_quantity = 1;
    mocks.orders.mockResolvedValue([canonical]);
    mocks.payments.mockResolvedValue(scenario === 'recorded payment'
      ? [{ id: 'paid-receipt', table_session_id: sourceId, status: 'completed', amount: 10 }]
      : []);
    mocks.get.mockResolvedValue({ success: true, data: { success: true, session } });
    render(<TableCheckManagerModal {...props} localOrders={[canonical] as any} />);
    await openItemAction('Change Price');
    fireEvent.click(screen.getByRole('button', { name: 'Save Price' }));
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalled());
    expect(mocks.updateItems).not.toHaveBeenCalled();
  });

  it.each(['permanent denial', 'failed durable enqueue'])('keeps a paid check visible without projecting release after %s', async (scenario) => {
    mocks.payments.mockResolvedValue([]);
    mocks.get.mockResolvedValue({ success: true, data: { success: true, session: makeSession(sourceId, 'T01', 3) } });
    mocks.patch.mockResolvedValue({ success: false, error: scenario === 'permanent denial' ? 'Forbidden (HTTP 403)' : 'Offline' });
    mocks.retryable.mockReturnValue(scenario === 'failed durable enqueue');
    mocks.enqueueUpdate.mockRejectedValue(new Error('Sync queue capacity exceeded'));
    render(<TableCheckManagerModal {...props} />);
    await waitFor(() => expect(screen.getByText('Coffee')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /^Pay$/ }));
    fireEvent.click(screen.getByRole('button', { name: /^Cash$/ }));
    await waitFor(() => expect(mocks.recordPayment).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalled());
    expect(mocks.emit.mock.calls.filter(([event]) => event === 'table-session-settled')).toHaveLength(0);
    expect(props.onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /^Pay$/ })).toBeDisabled();
  });

  it('queues only the unacknowledged suffix after a batch transfer partially succeeds', async () => {
    const second = { ...original, id: 'line-2', name: 'Tea', menu_item_id: 'menu-2' };
    const completeOrder = { ...order, total_amount: 60, items: [original, second] };
    const session = makeSession(sourceId, 'T01', 3);
    session.order.order_items = [original, second];
    session.items = [
      { order_item_id: 'line-1', quantity: 3, status: 'open' },
      { order_item_id: 'line-2', quantity: 3, status: 'open' },
    ];
    session.balance = { order_total: 60, paid_total: 0, outstanding_balance: 60 };
    mocks.orders.mockResolvedValue([completeOrder]);
    mocks.payments.mockResolvedValue([]);
    mocks.get.mockResolvedValue({ success: true, data: { success: true, session } });
    mocks.post.mockResolvedValueOnce({ success: true, data: { success: true, source_session: session } })
      .mockResolvedValueOnce({ success: false, error: 'Offline' });
    mocks.retryable.mockReturnValue(true);
    render(<TableCheckManagerModal {...props} localOrders={[completeOrder] as any} />);
    await waitFor(() => expect(screen.getByText('Coffee')).toBeInTheDocument());
    const coffee = screen.getByText('Coffee').closest('button')!;
    fireEvent(coffee, new MouseEvent('pointerdown', { button: 0, bubbles: true }));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 460)); });
    fireEvent.pointerUp(coffee);
    fireEvent.pointerUp(screen.getByText('Tea').closest('button')!);
    fireEvent.click(screen.getByRole('button', { name: 'Transfer' }));
    const sheet = screen.getAllByRole('dialog').at(-1)!;
    fireEvent.click(within(sheet).getByRole('option', { name: /T02/ }));
    fireEvent.click(within(sheet).getByRole('button', { name: 'Move Selected Quantities' }));
    await waitFor(() => expect(mocks.enqueueTransfer).toHaveBeenCalled());
    expect(mocks.enqueueTransfer).toHaveBeenCalledTimes(1);
    expect(mocks.enqueueTransfer.mock.calls[0][0].payload.order_item_id).toBe('line-2');
  });
});
