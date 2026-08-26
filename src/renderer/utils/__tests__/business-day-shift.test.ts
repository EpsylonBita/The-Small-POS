/**
 * The business-day boundary is the only honest way to age an open shift.
 *
 * Field failure (2026-08-25): the table-service waiter picker in
 * TableCheckManagerModal set `active: Boolean(member.currentShift?.shiftId)`,
 * so a shift left open weeks earlier presented its owner as a waiter standing
 * by the tables. These tests pin the replacement rule — and, just as
 * importantly, pin that it fails OPEN, because hiding someone who really is on
 * shift is worse than showing a stale row a human can recognise.
 */

import { describe, expect, it } from 'vitest';

import { shiftBelongsToCurrentBusinessDay } from '../business-day-shift';

const DAY_START = '2026-08-25T04:00:00.000Z';

describe('shiftBelongsToCurrentBusinessDay', () => {
  it('accepts a shift that started after the day opened', () => {
    expect(shiftBelongsToCurrentBusinessDay(DAY_START, '2026-08-25T09:58:49.000Z')).toBe(true);
  });

  it('accepts a shift that started exactly on the boundary', () => {
    expect(shiftBelongsToCurrentBusinessDay(DAY_START, DAY_START)).toBe(true);
  });

  it('rejects a shift left open from a day that has already been Z-closed', () => {
    // The real orphan: checked in 5 August, still "active" on 25 August.
    expect(shiftBelongsToCurrentBusinessDay(DAY_START, '2026-08-05T22:38:09.000Z')).toBe(false);
  });

  it('does not use a wall-clock age limit — a long day is still the current day', () => {
    // A business day runs check-in -> Z for as long as it takes. Ninety hours
    // after this day opened, a shift from its first minute still belongs to it.
    const longRunningDayStart = '2026-08-21T04:00:00.000Z';
    expect(
      shiftBelongsToCurrentBusinessDay(longRunningDayStart, '2026-08-21T04:05:00.000Z'),
    ).toBe(true);
  });

  it('fails open when the boundary is unknown', () => {
    for (const boundary of [null, undefined, '', 'not-a-date']) {
      expect(shiftBelongsToCurrentBusinessDay(boundary, '2026-08-05T22:38:09.000Z')).toBe(true);
    }
  });

  it('fails open when the check-in stamp is unusable', () => {
    for (const checkedInAt of [null, undefined, '', 'not-a-date']) {
      expect(shiftBelongsToCurrentBusinessDay(DAY_START, checkedInAt)).toBe(true);
    }
  });
});
