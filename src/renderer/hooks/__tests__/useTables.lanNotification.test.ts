import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  reservationsEnabled: true,
  listeners: new Map<string, (payload: unknown) => void>(),
  bridge: { tables: { list: vi.fn() } },
}));
vi.mock('../../../lib', () => ({
  getBridge: () => mocks.bridge,
  isBrowser: () => false,
  onEvent: (channel: string, handler: (payload: unknown) => void) => mocks.listeners.set(channel, handler),
  offEvent: (channel: string, handler: (payload: unknown) => void) => {
    if (mocks.listeners.get(channel) === handler) mocks.listeners.delete(channel);
  },
}));
vi.mock('../../services/ReservationsService', () => ({
  reservationsService: { setContext: vi.fn(), projectArrivalTables: vi.fn(async tables => tables), syncTableStatusesForToday: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock('../../utils/api-helpers', () => ({ posApiGet: vi.fn(), posApiPatch: vi.fn() }));

vi.mock('../useAcquiredModules', () => ({ useAcquiredModules: () => ({ hasModule: () => mocks.reservationsEnabled }) }));
import { reservationsService } from '../../services/ReservationsService';
import { useTables } from '../useTables';

const available = {
  id: 'table-p02', organization_id: 'org-qa', branch_id: 'branch-qa', table_number: 2,
  capacity: 4, status: 'available', position_x: 0, position_y: 0, shape: 'rectangle', notes: null,
  created_at: '2026-10-09T10:00:00Z', updated_at: '2026-10-09T10:00:00Z',
};
const occupied = {
  ...available, status: 'occupied', current_order_id: 'canonical-p02', table_session_id: 'session-p02',
  guest_count: 2, unpaid_balance: 21, updated_at: '2026-10-10T00:01:34Z',
};
const options = { branchId: 'branch-qa', organizationId: 'org-qa' };
const hint = { source: 'lan', request_id: 'committed-receipt-1' };
const emit = (payload: unknown) => mocks.listeners.get('order-realtime-update')?.(payload);
const tick = () => act(async () => { await vi.advanceTimersByTimeAsync(150); });

beforeEach(() => {
  vi.useFakeTimers();
  mocks.reservationsEnabled = true;
  mocks.listeners.clear();
  mocks.bridge.tables.list.mockReset().mockResolvedValue({ success: true, data: { tables: [available] } });
  vi.mocked(reservationsService.projectArrivalTables).mockReset().mockImplementation(async tables => tables);
});
afterEach(() => { vi.useRealTimers(); });

async function mount(overrides: Partial<typeof options & { enabled: boolean }> = {}) {
  const hook = renderHook(() => useTables({ ...options, ...overrides }));
  await act(async () => { await Promise.resolve(); });
  mocks.bridge.tables.list.mockClear();
  return hook;
}

describe('committed LAN table notification', () => {
  it('retains previous arrivals through pending/incomplete reads, then clears only on a complete read', async () => {
    vi.mocked(reservationsService.projectArrivalTables).mockImplementationOnce(async tables =>
      tables.map(table => ({ ...table, status: 'reserved', reservationCanonicalStatus: table.status })));
    const { result } = await mount();
    expect(result.current.tables[0].status).toBe('reserved');
    let finish!: (tables: any[]) => void;
    let pendingTables!: any[];
    vi.mocked(reservationsService.projectArrivalTables).mockImplementationOnce(tables => {
      pendingTables = tables;
      return new Promise(resolve => { finish = resolve; });
    });
    await act(async () => { await result.current.refetch(); });
    expect(result.current.tables[0].status).toBe('reserved');
    await act(async () => { finish(pendingTables); }); // incomplete reads return input unchanged
    expect(result.current.tables[0].status).toBe('reserved');
    vi.mocked(reservationsService.projectArrivalTables).mockImplementationOnce(async tables =>
      tables.map(table => ({ ...table, status: 'available' })));
    await act(async () => { await result.current.refetch(); });
    expect(result.current.tables[0].status).toBe('available');
  });
  it('renders local tables before booking decoration and ignores decoration older than a new check', async () => {
    let finish!: (tables: any[]) => void;
    vi.mocked(reservationsService.projectArrivalTables).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const { result } = await mount();
    expect(result.current.tables[0].id).toBe(available.id);
    expect(result.current.isLoading).toBe(false);
    mocks.bridge.tables.list.mockResolvedValue({ success: true, data: { tables: [occupied] } });
    await act(async () => { await result.current.refetch(); });
    await act(async () => { finish([{ ...result.current.tables[0], status: 'reserved', currentOrderId: undefined, tableSessionId: null }]); });
    expect(result.current.tables[0].status).toBe('occupied');
    expect(result.current.tables[0].currentOrderId).toBe(occupied.current_order_id);
  });

  it('loads ordinary tables without requiring reservation data when Reservations is absent', async () => {
    mocks.reservationsEnabled = false;
    const { result } = await mount();
    expect(result.current.tables[0].id).toBe(available.id);
    expect(result.current.error).toBeNull();
  });

  it.each(['newer server', 'new check', 'expired hint'])('does not pin an obsolete balance after %s', async scenario => {
    vi.setSystemTime(new Date('2026-10-12T03:00:00Z'));
    mocks.bridge.tables.list.mockResolvedValue({ success: true, data: { tables: [occupied] } });
    const { result } = await mount();
    act(() => mocks.listeners.get('table-session-balance-updated')?.({
      tableId: occupied.id, orderId: occupied.current_order_id,
      tableSessionId: occupied.table_session_id, orderTotal: 21, paidTotal: 0,
    }));
    const next = { ...occupied, unpaid_balance: 10.5,
      balance: { order_total: 10.5, paid_total: 0, outstanding_balance: 10.5, payment_status: 'pending' },
      ...(scenario === 'newer server' ? { updated_at: '2026-10-12T03:00:01Z' } : {}),
      ...(scenario === 'new check' ? { table_session_id: 'new-session', current_order_id: 'new-order' } : {}),
    };
    if (scenario === 'expired hint') vi.setSystemTime(new Date('2026-10-12T03:00:31Z'));
    mocks.bridge.tables.list.mockResolvedValue({ success: true, data: { tables: [next] } });
    await tick();
    expect(result.current.tables[0].unpaidBalance).toBe(10.5);
    expect(result.current.tables[0].tableSessionId).toBe(next.table_session_id);
  });

  it('keeps a recent balance hint over a stale read, then removes it after convergence', async () => {
    vi.setSystemTime(new Date('2026-10-12T03:00:00Z'));
    mocks.bridge.tables.list.mockResolvedValue({ success: true, data: { tables: [occupied] } });
    const { result } = await mount();
    act(() => mocks.listeners.get('table-session-balance-updated')?.({
      tableId: occupied.id, orderId: occupied.current_order_id,
      tableSessionId: occupied.table_session_id, orderTotal: 10.5, paidTotal: 0,
    }));
    await tick();
    expect(result.current.tables[0].unpaidBalance).toBe(10.5);
    const converged = { ...occupied, unpaid_balance: 10.5,
      balance: { order_total: 10.5, paid_total: 0, outstanding_balance: 10.5, payment_status: 'pending' } };
    mocks.bridge.tables.list.mockResolvedValue({ success: true, data: { tables: [converged] } });
    await act(async () => { await result.current.refetch(); });
    mocks.bridge.tables.list.mockResolvedValue({ success: true, data: { tables: [{ ...converged,
      unpaid_balance: 7, balance: { ...converged.balance, order_total: 7, outstanding_balance: 7 } }] } });
    await act(async () => { await result.current.refetch(); });
    expect(result.current.tables[0].unpaidBalance).toBe(7);
  });

  it('rereads occupied table identity and balance and coalesces notification bursts', async () => {
    const { result } = await mount();
    expect(result.current.tables[0].status).toBe('available');
    mocks.bridge.tables.list.mockResolvedValue({ success: true, data: { tables: [occupied] } });
    act(() => { emit(hint); emit({ ...hint, request_id: 'committed-receipt-2' }); });
    await tick();
    expect(result.current.tables.map(table => [table.status, table.tableSessionId, table.guestCount, table.unpaidBalance]))
      .toEqual([['occupied', 'session-p02', 2, 21]]);
    expect(mocks.bridge.tables.list).toHaveBeenCalledTimes(1);
  });

  it('does not reread for malformed or row-bearing order payloads', async () => {
    const { result } = await mount();
    act(() => {
      for (const payload of [null, {}, { source: 'lan' }, { ...hint, request_id: ' ' }, { ...hint, source: 'other' }, { ...hint, id: 'order-row' }]) emit(payload);
    });
    await tick();
    expect(result.current.tables[0].status).toBe('available');
    expect(mocks.bridge.tables.list).not.toHaveBeenCalled();
  });

  it('removes the listener and cancels a pending refresh on unmount', async () => {
    const { unmount } = await mount();
    act(() => { emit(hint); });
    unmount();
    await tick();
    expect(mocks.listeners.has('order-realtime-update')).toBe(false);
    expect(mocks.bridge.tables.list).not.toHaveBeenCalled();
  });

  it.each([{ enabled: false }, { branchId: '' }, { organizationId: '' }])('keeps reads scoped when %j', async overrides => {
    const { result } = await mount(overrides);
    act(() => { emit(hint); });
    await tick();
    expect(result.current.tables).toEqual([]);
    expect(mocks.bridge.tables.list).not.toHaveBeenCalled();
  });
});
