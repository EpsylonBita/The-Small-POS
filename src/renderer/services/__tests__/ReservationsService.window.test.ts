import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const bridge = vi.hoisted(() => ({ settings: { get: vi.fn() }, reservations: { list: vi.fn(), update: vi.fn() } }));
vi.mock('../../../lib', () => ({ getBridge: () => bridge, isBrowser: () => false }));
vi.mock('../../utils/api-helpers', () => ({ posApiGet: vi.fn(), posApiPost: vi.fn(), posApiPatch: vi.fn() }));
import { reservationArrivalWindow, reservationsService, type Reservation } from '../ReservationsService';
import { branchWallTimeToIso } from '../../utils/branch-time';

const raw = { id: 'booking', organization_id: 'org', branch_id: 'branch', table_id: 'table', status: 'confirmed', reservation_date: '2026-10-20', reservation_time: '20:00', duration_minutes: 90 };
const reservation = { reservationDate: raw.reservation_date, reservationTime: raw.reservation_time, durationMinutes: 90 } as Reservation;
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-20T09:00:00Z'));
  bridge.settings.get.mockImplementation(async (_category, key) => key === 'hotel_timezone' ? 'Europe/Athens' : 'branch');
  bridge.reservations.list.mockResolvedValue({ success: true, data: { reservations: [raw] } });
  reservationsService.setContext('branch', 'org');
});
afterEach(() => vi.useRealTimers());

it('reserves only from sixty minutes before arrival until the end of its duration in branch time', () => {
  for (const [instant, expected] of [['2026-10-20T15:59:59Z', false], ['2026-10-20T16:00:00Z', true], ['2026-10-20T18:29:59Z', true], ['2026-10-20T18:30:00Z', false]] as const) {
    expect(reservationArrivalWindow(reservation, 'Europe/Athens', new Date(instant)).active).toBe(expected);
  }
});
it('keeps a lunchtime walk-in available without seating or changing canonical occupancy', async () => {
  const tables = [{ id: 'table', status: 'reserved' }, { id: 'occupied', status: 'occupied', tableSessionId: 'session' }] as any;
  expect(await reservationsService.projectArrivalTables(tables)).toEqual([{ id: 'table', status: 'available', reservationCanonicalStatus: 'reserved' }, tables[1]]);
  expect(bridge.reservations.update).not.toHaveBeenCalled();
  expect(await reservationsService.getTodayReservationForTable('table')).toMatchObject({ id: 'booking' });
});
it('uses the branch calendar date across device/UTC midnight and refuses an unavailable zone', async () => {
  vi.setSystemTime(new Date('2026-10-20T22:30:00Z'));
  bridge.reservations.list.mockResolvedValue({ success: true, data: { reservations: [{ ...raw, reservation_date: '2026-10-21', reservation_time: '20:00' }] } });
  expect(await reservationsService.getTodayReservationForTable('table')).toMatchObject({ reservationDate: '2026-10-21' });
  bridge.settings.get.mockResolvedValue('');
  await expect(reservationsService.getTodayReservationForTable('table')).rejects.toThrow('TIMEZONE_UNAVAILABLE');
});
it('keeps an arrival window across branch midnight and excludes already ended bookings', async () => {
  vi.setSystemTime(new Date('2026-10-20T21:30:00Z'));
  bridge.reservations.list.mockResolvedValue({ success: true, data: { reservations: [{ ...raw, reservation_time: '23:30' }] } });
  expect(await reservationsService.getTodayReservationForTable('table')).toMatchObject({ id: 'booking' });
});
it('converts staff wall times independently of the PC and rejects nonexistent DST times', () => {
  expect(branchWallTimeToIso('2026-10-20T09:00:00', 'Europe/Athens')).toBe('2026-10-20T06:00:00.000Z');
  expect(branchWallTimeToIso('2026-01-20T09:00:00', 'Europe/Athens')).toBe('2026-01-20T07:00:00.000Z');
  expect(() => branchWallTimeToIso('2026-03-29T03:30:00', 'Europe/Athens')).toThrow('BRANCH_TIME_INVALID');
  expect(branchWallTimeToIso('2026-10-25T03:30:00', 'Europe/Athens')).toBe('2026-10-25T00:30:00.000Z');
});

it('scopes arrival decoration to branch dates including yesterday and the next arrival window', async () => {
  vi.setSystemTime(new Date('2026-10-20T21:30:00Z')); // Oct 21, 00:30 in Athens
  bridge.reservations.list.mockResolvedValue({ success: true, data: { reservations: [{ ...raw, reservation_time: '23:30' }] } });
  expect(await reservationsService.projectArrivalTables([{ id: 'table', status: 'available' }] as any))
    .toEqual([{ id: 'table', status: 'reserved', reservationCanonicalStatus: 'available' }]);
  expect(bridge.reservations.list).toHaveBeenLastCalledWith({ kind: 'table', date_from: '2026-10-20', date_to: '2026-10-21' });
  vi.setSystemTime(new Date('2026-10-21T20:30:00Z')); // tomorrow's 00:15 is already in the lead window
  bridge.reservations.list.mockResolvedValue({ success: true, data: { reservations: [{ ...raw, reservation_date: '2026-10-22', reservation_time: '00:15' }] } });
  expect((await reservationsService.projectArrivalTables([{ id: 'table', status: 'available' }] as any))[0].status).toBe('reserved');
  expect(bridge.reservations.list).toHaveBeenLastCalledWith({ kind: 'table', date_from: '2026-10-20', date_to: '2026-10-22' });
});

it.each([{ truncated: true }, { has_more: true }, { pagination: { hasMore: true } }, { reservations: null }])
  ('preserves previous decoration for an incomplete list: %j', async flags => {
    const tables = [{ id: 'table', status: 'reserved', reservationCanonicalStatus: 'available' }] as any;
    bridge.reservations.list.mockResolvedValue({ success: true, data: { reservations: [], ...flags } });
    expect(await reservationsService.projectArrivalTables(tables)).toBe(tables);
  });

it('preserves decoration when scoping cannot be established or the server ignores the window', async () => {
  const tables = [{ id: 'table', status: 'reserved' }] as any;
  bridge.reservations.list.mockResolvedValue({ success: true, data: { reservations: [{ ...raw, reservation_date: '2025-01-01' }] } });
  expect(await reservationsService.projectArrivalTables(tables)).toBe(tables);
  bridge.settings.get.mockResolvedValue('');
  expect(await reservationsService.projectArrivalTables(tables)).toBe(tables);
});

it('does not release tables from a native local-only or stale fallback list', async () => {
  const tables = [{ id: 'table', status: 'reserved' }] as any;
  for (const meta of [{ source: 'local' }, { source: 'cache', offlineFallback: true }]) {
    bridge.reservations.list.mockResolvedValue({ success: true, data: { reservations: [] }, meta });
    expect(await reservationsService.projectArrivalTables(tables)).toBe(tables);
  }
});
