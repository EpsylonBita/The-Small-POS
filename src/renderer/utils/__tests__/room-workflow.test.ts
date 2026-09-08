import { expect, it } from 'vitest';
import { reservationWallDateTime, roomStayNights } from '../room-workflow';

it('keeps entered 19:00 and its business date despite a differently zoned persisted instant', () => {
  const value = reservationWallDateTime({ reservationDate: '2026-09-08', reservationTime: '19:00:00', reservationDatetime: '2026-09-08T16:00:00Z' });
  expect(value).toBe('2026-09-08T19:00:00');
  expect(new Date(value).getHours()).toBe(19);
});
it('counts nights as calendar days over DST changes and rejects invalid/reversed dates', () => {
  expect(roomStayNights('2026-10-24', '2026-10-26')).toBe(2);
  expect(roomStayNights('2026-03-28', '2026-03-30')).toBe(2);
  for (const [start, end] of [['2026-09-09','2026-09-08'], ['2026-09-08','2026-09-08'], ['2026-02-30','2026-03-02'], ['', '2026-03-01']]) {
    expect(roomStayNights(start, end)).toBe(0);
  }
});
