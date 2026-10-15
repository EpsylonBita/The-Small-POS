/**
 * The Main reads its phone shifts from the server (founder rule 13/10/2026).
 * A failed or malformed answer is "unavailable", never "no phone shifts": an
 * empty list would let a Z or a cashier close through.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  parseUnitReadiness,
  readinessSinceFromPeriodStart,
  readUnitShiftReadiness,
  unitShiftCashToReceive,
  unitShiftPhoneLabel,
  unitShiftPhoneState,
  unitShiftStaffLabel,
} from '../unit-shift-readiness';

const openShift = {
  id: 'shift-open-1',
  staff_id: 'staff-maria',
  staff_name: 'Maria',
  role_type: 'waiter',
  terminal_id: 'phone-1',
  terminal_name: 'Phone 1',
  terminal_active: true,
  check_in_time: '2026-10-14T08:00:00.000Z',
  currency: 'EUR',
  opening_cash_amount: 0,
};

const closedShift = {
  ...openShift,
  id: 'shift-closed-1',
  status: 'closed',
  check_out_time: '2026-10-14T16:00:00.000Z',
  closing_cash_amount: 120.5,
  expected_cash_amount: 120.5,
  cash_variance: 0,
  total_orders_count: 14,
  total_sales_amount: 310,
  total_cash_sales: 120.5,
  total_card_sales: 189.5,
  handover: 'pending',
  closed_by: 'phone',
  received_at: null,
  receivable: true,
};

const body = {
  success: true,
  main_terminal_id: 'main-1',
  checked_at: '2026-10-14T20:00:00.000Z',
  since: '2026-10-14T06:00:00.000Z',
  open_shifts: [openShift],
  closed_shifts: [closedShift],
  pending_returns: [closedShift],
  terminals: [{ terminal_id: 'phone-1', name: 'Phone 1', is_active: true, terminal_type: 'mobile_waiter' }],
};

describe('unit shift readiness', () => {
  it('reads the documented answer through the bridge envelope', async () => {
    const unitReadiness = vi.fn(async () => ({ success: true, data: body, status: 200 }));
    const result = await readUnitShiftReadiness({ unitReadiness }, '2026-10-14T06:00:00.000Z');
    expect(unitReadiness).toHaveBeenCalledWith('2026-10-14T06:00:00.000Z');
    expect(result.kind).toBe('ready');
    if (result.kind !== 'ready') return;
    expect(result.readiness.openShifts).toHaveLength(1);
    expect(result.readiness.openShifts[0].staff_name).toBe('Maria');
    expect(result.readiness.closedShifts[0]).toMatchObject({ handover: 'pending', receivable: true, total_orders_count: 14 });
    expect(result.readiness.pendingReturns).toHaveLength(1);
    expect(result.readiness.terminals[0].terminal_type).toBe('mobile_waiter');
  });

  it('never reads a failure as no phone shifts', async () => {
    for (const response of [
      { success: false, status: 503, code: 'UNIT_READINESS_UNAVAILABLE', error: 'Phone shifts unavailable' },
      { success: false, error: 'Cannot reach admin dashboard' },
      { success: false, status: 401, error: 'Unauthorized' },
      { success: true, data: { success: true, open_shifts: 'none' } },
      { success: true, data: { ...body, open_shifts: [{ staff_name: 'No id' }] } },
      { success: true, data: { ...body, closed_shifts: [{ ...closedShift, handover: 'maybe' }] } },
      null,
    ]) {
      const result = await readUnitShiftReadiness({ unitReadiness: async () => response });
      expect(result.kind, JSON.stringify(response)).toBe('unavailable');
    }
    const thrown = await readUnitShiftReadiness({ unitReadiness: async () => { throw new Error('bridge down'); } });
    expect(thrown).toEqual({ kind: 'unavailable', status: null, code: null, error: 'bridge down' });
  });

  it('skips the check only for a server without the endpoint or a till that is not a Main', async () => {
    expect(await readUnitShiftReadiness({ unitReadiness: async () => ({ success: false, status: 404, error: 'not found' }) }))
      .toEqual({ kind: 'unsupported', reason: 'not_found' });
    expect(await readUnitShiftReadiness({
      unitReadiness: async () => ({ success: false, status: 403, code: 'UNIT_READINESS_MAIN_ONLY', error: 'Only a main terminal' }),
    })).toEqual({ kind: 'unsupported', reason: 'not_main' });
    // Any other 403 stays a failure.
    expect((await readUnitShiftReadiness({ unitReadiness: async () => ({ success: false, status: 403, error: 'denied' }) })).kind)
      .toBe('unavailable');
  });

  it('accepts the bare server body too', () => {
    expect(parseUnitReadiness(body)?.openShifts).toHaveLength(1);
    expect(parseUnitReadiness({ ...body, success: false })).toBeNull();
  });

  it('names the staff member and the phone as received, and marks a deactivated or removed phone', () => {
    expect(unitShiftStaffLabel({ staff_name: ' Maria ', staff_id: 'staff', id: 'shift' })).toBe('Maria');
    expect(unitShiftStaffLabel({ staff_name: null, staff_id: null, id: 'shift' })).toBe('shift');
    expect(unitShiftPhoneLabel({ terminal_name: null, terminal_id: 'phone-9' })).toBe('phone-9');
    expect(unitShiftPhoneState({ terminal_active: true })).toBe('active');
    expect(unitShiftPhoneState({ terminal_active: false })).toBe('deactivated');
    expect(unitShiftPhoneState({ terminal_active: null })).toBe('removed');
  });

  it('takes exactly the recorded count, a count of 0 included, else the float', () => {
    expect(unitShiftCashToReceive({ closing_cash_amount: 42, opening_cash_amount: 10 })).toBe(42);
    // Founder decision 15/10/2026: a counted 0 with a float is valid; the Main receives the count.
    expect(unitShiftCashToReceive({ closing_cash_amount: 0, opening_cash_amount: 10 })).toBe(0);
    expect(unitShiftCashToReceive({ closing_cash_amount: null, opening_cash_amount: 10 })).toBe(10);
    expect(unitShiftCashToReceive({ closing_cash_amount: null, opening_cash_amount: null })).toBe(0);
  });

  it('sends the Z window start, never the epoch of a till without a Z', () => {
    expect(readinessSinceFromPeriodStart('2026-10-14T08:00:00+02:00')).toBe('2026-10-14T06:00:00.000Z');
    expect(readinessSinceFromPeriodStart('1970-01-01T00:00:00Z')).toBeNull();
    expect(readinessSinceFromPeriodStart('')).toBeNull();
    expect(readinessSinceFromPeriodStart(undefined)).toBeNull();
  });
});

describe('the Z refused for phone shifts', () => {
  it('reads the native stage refusal with its named shifts', async () => {
    const { unitShiftsZRefusal } = await import('../unit-shift-readiness');
    expect(unitShiftsZRefusal({
      success: false,
      errorCode: 'Z_REPORT_UNIT_SHIFTS_OPEN',
      stage: 'unit_shifts',
      error: 'Close the phone shifts before the Z: Maria (waiter, Phone 1)',
      openShifts: [openShift, { staff_name: 'unreadable' }],
    })).toEqual({
      kind: 'open',
      openShifts: [expect.objectContaining({ id: 'shift-open-1', staff_name: 'Maria' })],
      error: 'Close the phone shifts before the Z: Maria (waiter, Phone 1)',
    });
    expect(unitShiftsZRefusal({ success: false, errorCode: 'Z_REPORT_UNIT_SHIFTS_UNAVAILABLE', error: 'offline' }))
      .toEqual({ kind: 'unavailable', error: 'offline' });
    expect(unitShiftsZRefusal({ success: false, errorCode: 'SYNC_CLOSEOUT_BLOCKED' })).toBeNull();
    expect(unitShiftsZRefusal('nope')).toBeNull();
  });
});

describe('review 14/10/2026: exact receipt, remembered read, phones and heartbeats', () => {
  it('reads the new contract fields', () => {
    const readiness = parseUnitReadiness({
      ...body,
      open_shifts: [{ ...openShift, terminal_last_seen_at: '2026-10-14T19:58:00.000Z' }],
      pending_returns: [
        { ...closedShift, receiving_cashier_shift_id: 'cashier-1', settle: 'receive' },
        { ...closedShift, id: 'later', receivable: false, settle: 'needs_cashier' },
      ],
      closed_shifts: [{ ...closedShift, receivable: false, settle: 'manager' }],
      terminals: [{ terminal_id: 'phone-1', name: 'Phone 1', is_active: true, terminal_type: 'mobile_waiter', last_seen_at: '2026-10-14T19:58:00.000Z' }],
    });
    expect(readiness?.openShifts[0].terminal_last_seen_at).toBe('2026-10-14T19:58:00.000Z');
    expect(readiness?.pendingReturns[0]).toMatchObject({ receiving_cashier_shift_id: 'cashier-1', settle: 'receive' });
    expect(readiness?.pendingReturns[1].settle).toBe('needs_cashier');
    expect(readiness?.closedShifts[0].settle).toBe('manager');
    expect(readiness?.terminals[0].last_seen_at).toBe('2026-10-14T19:58:00.000Z');
    // An older server sends none of them.
    expect(parseUnitReadiness(body)?.pendingReturns[0]).toMatchObject({ receiving_cashier_shift_id: null, settle: null });
  });

  it('remembers a good read per terminal and never an unavailable one', async () => {
    const {
      lastGoodUnitReadiness,
      readUnitShiftReadinessRemembered,
    } = await import('../unit-shift-readiness');
    localStorage.clear();
    const good = await readUnitShiftReadinessRemembered(
      { unitReadiness: async () => ({ success: true, data: body }) }, 'main-1');
    expect(good.result.kind).toBe('ready');
    expect(good.lastGood?.checkedAt).toBe('2026-10-14T20:00:00.000Z');
    const offline = await readUnitShiftReadinessRemembered(
      { unitReadiness: async () => ({ success: false, error: 'Cannot reach admin dashboard' }) }, 'main-1');
    expect(offline.result.kind).toBe('unavailable');
    expect(offline.lastGood?.readiness.openShifts[0].id).toBe('shift-open-1');
    expect(lastGoodUnitReadiness('main-1')?.readiness.pendingReturns).toHaveLength(1);
    expect(lastGoodUnitReadiness('another-terminal')).toBeNull();
    // Without a terminal id the answer's own Main id keys it.
    localStorage.clear();
    await readUnitShiftReadinessRemembered({ unitReadiness: async () => ({ success: true, data: body }) }, null);
    expect(lastGoodUnitReadiness('main-1')).not.toBeNull();
    // Storage that throws: no memory, no crash.
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    expect((await readUnitShiftReadinessRemembered(
      { unitReadiness: async () => ({ success: true, data: body }) }, 'main-1')).result.kind).toBe('ready');
    expect(lastGoodUnitReadiness('main-1')).toBeNull();
    setItem.mockRestore();
    getItem.mockRestore();
  });

  it('waits only for tills this Main can receive whose claim was not released', async () => {
    const { tillsToReceive, readReleasedPhoneTills } = await import('../unit-shift-readiness');
    const readiness = parseUnitReadiness({
      ...body,
      pending_returns: [
        { ...closedShift, id: 'receivable', receivable: true },
        { ...closedShift, id: 'released', receivable: true },
        { ...closedShift, id: 'manager', receivable: false, settle: 'manager' },
      ],
    })!;
    const invoke = vi.fn(async () => ({ success: true, satelliteShiftIds: ['released'] }));
    const released = await readReleasedPhoneTills(invoke);
    expect(invoke).toHaveBeenCalledWith('shift_satellite_handover_recovery', { action: 'released_sources' });
    expect(tillsToReceive(readiness.pendingReturns, released).map((till) => till.id)).toEqual(['receivable']);
    // Unreadable journal: nothing counts as released.
    expect(await readReleasedPhoneTills(async () => { throw new Error('native'); })).toEqual(new Set());
  });

  it('a kiosk is not a phone; a heartbeat is stale after five minutes or when unknown; non-cash roles', async () => {
    const { unitHasPhones, unitIsQuiet, phoneLastSeenIsStale, isNonCashPhoneRole } = await import('../unit-shift-readiness');
    const kiosk = { terminal_id: 'k', name: 'Kiosk', is_active: true, terminal_type: 'kiosk', last_seen_at: null };
    const phone = { terminal_id: 'p', name: 'Phone', is_active: false, terminal_type: 'mobile_waiter', last_seen_at: null };
    expect(unitHasPhones({ terminals: [kiosk] })).toBe(false);
    expect(unitHasPhones({ terminals: [kiosk, phone] })).toBe(true);
    expect(unitIsQuiet({ openShifts: [], pendingReturns: [] })).toBe(true);
    const now = Date.parse('2026-10-14T20:00:00.000Z');
    expect(phoneLastSeenIsStale('2026-10-14T19:56:00.000Z', now)).toBe(false);
    expect(phoneLastSeenIsStale('2026-10-14T19:54:59.000Z', now)).toBe(true);
    expect(phoneLastSeenIsStale(null, now)).toBe(true);
    expect(phoneLastSeenIsStale('garbage', now)).toBe(true);
    for (const role of ['cashier', 'Manager', 'driver', 'server', 'waiter']) expect(isNonCashPhoneRole(role)).toBe(false);
    expect(isNonCashPhoneRole('kitchen')).toBe(true);
    expect(isNonCashPhoneRole(null)).toBe(false);
  });
});
