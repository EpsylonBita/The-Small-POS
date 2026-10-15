/**
 * The Main notices each phone shift that closes, once (founder rule
 * 13/10/2026: phones always hand over to the Main).
 */
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PHONE_SHIFT_NOTIFIED_CAP,
  PHONE_SHIFT_NOTIFIED_STORAGE_KEY,
  PHONE_SHIFT_POLL_WITH_PHONES_MS,
  PHONE_SHIFT_POLL_WITHOUT_PHONES_MS,
  usePhoneShiftNotices,
} from '../usePhoneShiftNotices';

const mocks = vi.hoisted(() => ({
  features: { isMainTerminal: true, isMobileWaiter: false, parentTerminalId: null as string | null, loading: false },
  unitReadiness: vi.fn(),
}));
vi.mock('../useFeatures', () => ({ useFeatures: () => mocks.features }));
vi.mock('../../../lib', () => ({ getBridge: () => ({ shifts: { unitReadiness: mocks.unitReadiness } }) }));

const START = new Date('2026-10-14T12:00:00.000Z');
const phone = { terminal_id: 'phone-1', name: 'Phone 1', is_active: true, terminal_type: 'mobile_waiter' };

function closed(id: string, checkOut: string | null, overrides: Record<string, unknown> = {}) {
  return {
    id, staff_id: `staff-${id}`, staff_name: 'Maria', role_type: 'waiter', terminal_id: 'phone-1', terminal_name: 'Phone 1',
    terminal_active: true, check_in_time: '2026-10-14T08:00:00.000Z', currency: 'EUR', opening_cash_amount: 0,
    status: 'closed', check_out_time: checkOut, closing_cash_amount: 42.5, expected_cash_amount: 42.5, cash_variance: 0,
    total_orders_count: 7, total_sales_amount: 120.4, total_cash_sales: 42.5, total_card_sales: 77.9,
    handover: 'pending', closed_by: 'phone', received_at: null, receivable: true, ...overrides,
  };
}

function ready(closedShifts: unknown[], terminals: unknown[] = [phone]) {
  return {
    success: true,
    data: {
      success: true, main_terminal_id: 'main-1', checked_at: START.toISOString(), since: null,
      open_shifts: [], closed_shifts: closedShifts, pending_returns: [], terminals,
    },
  };
}

const flush = () => act(async () => { await vi.advanceTimersByTimeAsync(0); });
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const noticedIds = (onClosed: ReturnType<typeof vi.fn>) => onClosed.mock.calls.map(([shift]) => shift.id);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(START);
  localStorage.clear();
  mocks.features = { isMainTerminal: true, isMobileWaiter: false, parentTerminalId: null, loading: false };
  mocks.unitReadiness.mockReset();
  mocks.unitReadiness.mockResolvedValue(ready([]));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('usePhoneShiftNotices', () => {
  it('takes shifts closed before start as seen, and notices one that closed after start even when the first read is late', async () => {
    const onClosed = vi.fn();
    mocks.unitReadiness
      .mockResolvedValueOnce({ success: false, status: 503, code: 'UNIT_READINESS_UNAVAILABLE', error: 'down' })
      .mockResolvedValue(ready([
        closed('before-start', '2026-10-14T11:30:00.000Z'),
        closed('unknown-time', null),
        closed('after-start', '2026-10-14T12:00:10.000Z'),
      ]));
    renderHook(() => usePhoneShiftNotices(true, onClosed));
    await flush();
    expect(mocks.unitReadiness).toHaveBeenCalledTimes(1);
    expect(onClosed).not.toHaveBeenCalled();

    await advance(PHONE_SHIFT_POLL_WITH_PHONES_MS);
    expect(mocks.unitReadiness).toHaveBeenCalledTimes(2);
    expect(noticedIds(onClosed)).toEqual(['after-start']);
    expect(JSON.parse(localStorage.getItem(PHONE_SHIFT_NOTIFIED_STORAGE_KEY) || '[]'))
      .toEqual(['before-start', 'unknown-time', 'after-start']);
  });

  it('on the seeding read, notices a till received after start even though it closed before (re-review 15/10/2026)', async () => {
    const onClosed = vi.fn();
    mocks.unitReadiness.mockResolvedValue(ready([
      closed('closed-and-received-before', '2026-10-14T09:00:00.000Z', {
        handover: 'received', closed_by: 'main', received_at: '2026-10-14T10:00:00.000Z' }),
      closed('received-after-start', '2026-10-14T09:00:00.000Z', {
        handover: 'received', closed_by: 'main', received_at: '2026-10-14T12:00:05.000Z' }),
    ]));
    renderHook(() => usePhoneShiftNotices(true, onClosed));
    await flush();
    expect(noticedIds(onClosed)).toEqual(['received-after-start']);
  });

  it('notices a newly closed shift once, and not again after a reload', async () => {
    const onClosed = vi.fn();
    const shift = closed('new-close', '2026-10-14T12:00:20.000Z');
    const first = renderHook(() => usePhoneShiftNotices(true, onClosed));
    await flush();
    expect(onClosed).not.toHaveBeenCalled();

    mocks.unitReadiness.mockResolvedValue(ready([shift]));
    await advance(PHONE_SHIFT_POLL_WITH_PHONES_MS);
    expect(noticedIds(onClosed)).toEqual(['new-close']);
    expect(onClosed.mock.calls[0][0]).toMatchObject({ staff_name: 'Maria', handover: 'pending', total_orders_count: 7 });
    await advance(PHONE_SHIFT_POLL_WITH_PHONES_MS);
    expect(onClosed).toHaveBeenCalledTimes(1);
    first.unmount();

    // A reload whose clock is before the close: only the stored id holds it back.
    vi.setSystemTime(START);
    const reloaded = vi.fn();
    const second = renderHook(() => usePhoneShiftNotices(true, reloaded));
    await flush();
    expect(reloaded).not.toHaveBeenCalled();
    second.unmount();

    localStorage.clear();
    vi.setSystemTime(START);
    const withoutStorage = vi.fn();
    renderHook(() => usePhoneShiftNotices(true, withoutStorage));
    await flush();
    expect(noticedIds(withoutStorage)).toEqual(['new-close']);
  });

  it('keeps only the last 200 noticed ids', async () => {
    const old = Array.from({ length: 250 }, (_, index) => `old-${index}`);
    localStorage.setItem(PHONE_SHIFT_NOTIFIED_STORAGE_KEY, JSON.stringify(old));
    const onClosed = vi.fn();
    mocks.unitReadiness.mockResolvedValue(ready([closed('old-249', '2026-10-14T12:01:00.000Z'), closed('fresh', '2026-10-14T12:01:00.000Z')]));
    renderHook(() => usePhoneShiftNotices(true, onClosed));
    await flush();
    expect(noticedIds(onClosed)).toEqual(['fresh']);
    const stored = JSON.parse(localStorage.getItem(PHONE_SHIFT_NOTIFIED_STORAGE_KEY) || '[]');
    expect(stored).toHaveLength(PHONE_SHIFT_NOTIFIED_CAP);
    expect(stored.at(-1)).toBe('fresh');
    expect(stored).not.toContain('old-0');
  });

  it('works without storage and notices each shift once in memory', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
    const onClosed = vi.fn();
    mocks.unitReadiness.mockResolvedValue(ready([closed('memory', '2026-10-14T12:00:30.000Z')]));
    renderHook(() => usePhoneShiftNotices(true, onClosed));
    await flush();
    await advance(PHONE_SHIFT_POLL_WITH_PHONES_MS);
    expect(noticedIds(onClosed)).toEqual(['memory']);
  });

  it.each([
    ['a phone', { isMainTerminal: false, isMobileWaiter: true, parentTerminalId: 'main-1', loading: false }, true],
    ['a kiosk or other child terminal', { isMainTerminal: false, isMobileWaiter: false, parentTerminalId: 'main-db-1', loading: false }, true],
    ['a terminal whose type is still loading', { isMainTerminal: false, isMobileWaiter: false, parentTerminalId: null, loading: true }, true],
    ['a Main without a logged-in user', { isMainTerminal: true, isMobileWaiter: false, parentTerminalId: null, loading: false }, false],
  ])('never asks on %s', async (_label, features, enabled) => {
    mocks.features = features;
    renderHook(() => usePhoneShiftNotices(enabled, vi.fn()));
    await flush();
    await advance(PHONE_SHIFT_POLL_WITHOUT_PHONES_MS * 2);
    window.dispatchEvent(new Event('focus'));
    await flush();
    expect(mocks.unitReadiness).not.toHaveBeenCalled();
  });

  it('asks on a legacy terminal with no type and no parent, as the Z does', async () => {
    mocks.features = { isMainTerminal: false, isMobileWaiter: false, parentTerminalId: null, loading: false };
    renderHook(() => usePhoneShiftNotices(true, vi.fn()));
    await flush();
    expect(mocks.unitReadiness).toHaveBeenCalledTimes(1);
  });

  it('a failed read is silent, keeps what was seen and keeps the cadence', async () => {
    const onClosed = vi.fn();
    const shift = closed('seen', '2026-10-14T12:00:20.000Z');
    renderHook(() => usePhoneShiftNotices(true, onClosed));
    await flush();
    mocks.unitReadiness.mockResolvedValueOnce(ready([shift]));
    await advance(PHONE_SHIFT_POLL_WITH_PHONES_MS);
    expect(noticedIds(onClosed)).toEqual(['seen']);

    mocks.unitReadiness
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ success: false, status: 503, code: 'UNIT_READINESS_UNAVAILABLE', error: 'down' })
      .mockResolvedValueOnce({ success: true, data: { success: true, closed_shifts: 'garbage' } })
      .mockResolvedValue(ready([shift]));
    await advance(PHONE_SHIFT_POLL_WITH_PHONES_MS);
    await advance(PHONE_SHIFT_POLL_WITH_PHONES_MS);
    await advance(PHONE_SHIFT_POLL_WITH_PHONES_MS);
    await advance(PHONE_SHIFT_POLL_WITH_PHONES_MS);
    expect(mocks.unitReadiness).toHaveBeenCalledTimes(6);
    expect(onClosed).toHaveBeenCalledTimes(1);
  });

  it('asks every 30 s while the unit has phones and every 5 min without', async () => {
    renderHook(() => usePhoneShiftNotices(true, vi.fn()));
    await flush();
    expect(mocks.unitReadiness).toHaveBeenCalledTimes(1);
    await advance(PHONE_SHIFT_POLL_WITH_PHONES_MS - 1);
    expect(mocks.unitReadiness).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(mocks.unitReadiness).toHaveBeenCalledTimes(2);

    // The phones are gone from the unit: the next read comes 5 minutes later.
    mocks.unitReadiness.mockResolvedValue(ready([], []));
    await advance(PHONE_SHIFT_POLL_WITH_PHONES_MS);
    expect(mocks.unitReadiness).toHaveBeenCalledTimes(3);
    await advance(PHONE_SHIFT_POLL_WITHOUT_PHONES_MS - 1);
    expect(mocks.unitReadiness).toHaveBeenCalledTimes(3);
    await advance(1);
    expect(mocks.unitReadiness).toHaveBeenCalledTimes(4);
  });

  it('a kiosk is not a phone: a unit with only a kiosk is asked every 5 min (review 14/10/2026)', async () => {
    const kiosk = { terminal_id: 'kiosk-1', name: 'Kiosk', is_active: true, terminal_type: 'kiosk' };
    mocks.unitReadiness.mockResolvedValue(ready([], [kiosk]));
    renderHook(() => usePhoneShiftNotices(true, vi.fn()));
    await flush();
    expect(mocks.unitReadiness).toHaveBeenCalledTimes(1);
    await advance(PHONE_SHIFT_POLL_WITH_PHONES_MS);
    expect(mocks.unitReadiness).toHaveBeenCalledTimes(1);
    await advance(PHONE_SHIFT_POLL_WITHOUT_PHONES_MS - PHONE_SHIFT_POLL_WITH_PHONES_MS);
    expect(mocks.unitReadiness).toHaveBeenCalledTimes(2);
    // A phone joins next to the kiosk: back to 30 s.
    mocks.unitReadiness.mockResolvedValue(ready([], [kiosk, phone]));
    await advance(PHONE_SHIFT_POLL_WITHOUT_PHONES_MS);
    expect(mocks.unitReadiness).toHaveBeenCalledTimes(3);
    await advance(PHONE_SHIFT_POLL_WITH_PHONES_MS);
    expect(mocks.unitReadiness).toHaveBeenCalledTimes(4);
  });

  it('remembers a good read on this device for the offline cashier close', async () => {
    renderHook(() => usePhoneShiftNotices(true, vi.fn()));
    await flush();
    const { lastGoodUnitReadiness } = await import('../../utils/unit-shift-readiness');
    expect(lastGoodUnitReadiness('main-1')?.readiness.terminals).toHaveLength(1);
  });

  it('asks again when the window regains focus', async () => {
    mocks.unitReadiness.mockResolvedValue(ready([], []));
    const onClosed = vi.fn();
    renderHook(() => usePhoneShiftNotices(true, onClosed));
    await flush();
    mocks.unitReadiness.mockResolvedValue(ready([closed('on-focus', '2026-10-14T12:00:05.000Z')], []));
    await act(async () => { window.dispatchEvent(new Event('focus')); await vi.advanceTimersByTimeAsync(0); });
    expect(mocks.unitReadiness).toHaveBeenCalledTimes(2);
    expect(noticedIds(onClosed)).toEqual(['on-focus']);
  });

  it.each([
    ['an older server without the endpoint', { success: false, status: 404, error: 'Not found' }],
    ['a till the server says is not a Main', { success: false, status: 403, code: 'UNIT_READINESS_MAIN_ONLY', error: 'Main only' }],
  ])('stops asking for %s', async (_label, answer) => {
    mocks.unitReadiness.mockResolvedValue(answer);
    renderHook(() => usePhoneShiftNotices(true, vi.fn()));
    await flush();
    await advance(PHONE_SHIFT_POLL_WITHOUT_PHONES_MS * 3);
    await act(async () => { window.dispatchEvent(new Event('focus')); await vi.advanceTimersByTimeAsync(0); });
    expect(mocks.unitReadiness).toHaveBeenCalledTimes(1);
  });

  it('stops asking at logout', async () => {
    const { rerender } = renderHook(({ enabled }) => usePhoneShiftNotices(enabled, vi.fn()), { initialProps: { enabled: true } });
    await flush();
    rerender({ enabled: false });
    await advance(PHONE_SHIFT_POLL_WITHOUT_PHONES_MS);
    expect(mocks.unitReadiness).toHaveBeenCalledTimes(1);
  });
});
