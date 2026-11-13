import { describe, expect, it } from 'vitest';
import {
  RESERVATION_DAY_STRIP_LENGTH,
  activeReservationsOn,
  buildReservationDays,
  buildReservationSlots,
  minutesOfDay,
  overlapsReservation,
} from '../reservationAvailability';

// Founder, 11/11/2026: the New Reservation window shows the day and the time with the table's
// availability. The rule must be the conflict check's own, or a time shown free would be refused.

const now = new Date('2026-11-11T10:00:00');
const reservation = (overrides: Record<string, unknown> = {}) => ({
  id: 'r1',
  reservationDate: '2026-11-12',
  reservationTime: '20:00:00',
  durationMinutes: 90,
  status: 'confirmed',
  ...overrides,
});
const state = (slots: { time: string; state: string }[], time: string) =>
  slots.find((slot) => slot.time === time)?.state;

describe('reservation availability', () => {
  it('reads times of day and rejects what is not one', () => {
    expect(minutesOfDay('08:00')).toBe(480);
    expect(minutesOfDay('20:30:00')).toBe(1230);
    expect(minutesOfDay('')).toBeNull();
    expect(minutesOfDay('25:00')).toBeNull();
    expect(minutesOfDay(null)).toBeNull();
  });

  it('counts only the pending and confirmed reservations of that day, never the edited one', () => {
    const list = [
      reservation(),
      reservation({ id: 'r2', status: 'cancelled' }),
      reservation({ id: 'r3', status: 'pending', reservationTime: '13:00' }),
      reservation({ id: 'r4', reservationDate: '2026-11-13' }),
      reservation({ id: 'r5', status: undefined, reservationTime: '09:00' }),
    ];
    expect(activeReservationsOn(list, '2026-11-12').map((r) => r.id)).toEqual(['r1', 'r3', 'r5']);
    expect(activeReservationsOn(list, '2026-11-12', 'r1').map((r) => r.id)).toEqual(['r3', 'r5']);
    expect(activeReservationsOn(null, '2026-11-12')).toEqual([]);
    expect(activeReservationsOn(list, '')).toEqual([]);
  });

  it('uses the conflict check rule: 90 minutes for the new one, its own duration for the old one', () => {
    const sameDay = [reservation()]; // 20:00 to 21:30
    // 18:30 ends exactly at 20:00: free. 19:00 would run into it: taken.
    expect(overlapsReservation(18 * 60 + 30, sameDay)).toBe(false);
    expect(overlapsReservation(19 * 60, sameDay)).toBe(true);
    expect(overlapsReservation(21 * 60, sameDay)).toBe(true);
    // 21:30 starts when it ends: free.
    expect(overlapsReservation(21 * 60 + 30, sameDay)).toBe(false);
    // A longer existing reservation holds the table longer; no duration means 90.
    expect(overlapsReservation(22 * 60, [reservation({ durationMinutes: 180 })])).toBe(true);
    expect(overlapsReservation(21 * 60 + 30, [reservation({ durationMinutes: null })])).toBe(false);
    // A reservation with no readable time blocks nothing.
    expect(overlapsReservation(20 * 60, [reservation({ reservationTime: '' })])).toBe(false);
  });

  it('offers every half hour from 08:00 to 23:30 and marks the taken ones', () => {
    const slots = buildReservationSlots({ date: '2026-11-12', now, reservations: [reservation()] });
    expect(slots[0]).toEqual({ time: '08:00', state: 'free' });
    expect(slots[slots.length - 1]).toEqual({ time: '23:30', state: 'free' });
    expect(slots).toHaveLength(32);
    expect(state(slots, '18:30')).toBe('free');
    expect(state(slots, '19:00')).toBe('taken');
    expect(state(slots, '20:00')).toBe('taken');
    expect(state(slots, '21:00')).toBe('taken');
    expect(state(slots, '21:30')).toBe('free');
  });

  it('leaves out the times of today that have passed, and offers nothing for a past day', () => {
    const today = buildReservationSlots({ date: '2026-11-11', now, reservations: [] });
    // It is 10:00: 10:00 itself has started, 10:30 is the first time left.
    expect(today[0].time).toBe('10:30');
    expect(buildReservationSlots({ date: '2026-11-10', now, reservations: [] })).toEqual([]);
    expect(buildReservationSlots({ date: '', now, reservations: [] })).toEqual([]);
    const lateNow = new Date('2026-11-11T23:45:00');
    expect(buildReservationSlots({ date: '2026-11-11', now: lateNow, reservations: [] })).toEqual([]);
  });

  it('never blocks the time of the reservation being edited', () => {
    const slots = buildReservationSlots({
      date: '2026-11-12', now, reservations: [reservation()], excludeId: 'r1',
    });
    expect(state(slots, '20:00')).toBe('free');
  });

  it('summarises today and the next days for the day strip', () => {
    const days = buildReservationDays({
      now,
      reservations: [reservation(), reservation({ id: 'r3', reservationTime: '13:00', status: 'pending' })],
    });
    expect(days).toHaveLength(RESERVATION_DAY_STRIP_LENGTH);
    expect(days[0]).toMatchObject({ date: '2026-11-11', reserved: 0 });
    // Today only has the times after 10:00 left.
    expect(days[0].free).toBe(27);
    expect(days[1]).toMatchObject({ date: '2026-11-12', reserved: 2 });
    // 12:00–14:00 and 19:00–21:00 are held: 5 + 5 of the 32 times.
    expect(days[1].free).toBe(32 - 10);
    expect(days[13].date).toBe('2026-11-24');
    expect(buildReservationDays({ now, reservations: [], length: 3 }).map((d) => d.date))
      .toEqual(['2026-11-11', '2026-11-12', '2026-11-13']);
  });
});
