import { describe, expect, it } from 'vitest';
import { isPosDayOpenTooLong, POS_DAY_OPEN_WARNING_AFTER_MS } from '../pos-day-open';

const MINUTE = 60 * 1000;
const dayStartAt = '2026-10-13T14:00:00Z';
const startedAt = Date.parse(dayStartAt);

describe('POS day open too long (Health, founder decision 13/10/2026)', () => {
  it('names a 24 hour threshold', () => {
    expect(POS_DAY_OPEN_WARNING_AFTER_MS).toBe(24 * 60 * MINUTE);
  });

  it('does not warn at 23 h 59', () => {
    expect(isPosDayOpenTooLong(dayStartAt, startedAt + 23 * 60 * MINUTE + 59 * MINUTE)).toBe(false);
  });

  it('warns at 24 h 01', () => {
    expect(isPosDayOpenTooLong(dayStartAt, startedAt + 24 * 60 * MINUTE + MINUTE)).toBe(true);
  });

  it('never warns without a readable day start', () => {
    const later = startedAt + 72 * 60 * MINUTE;
    expect(isPosDayOpenTooLong(null, later)).toBe(false);
    expect(isPosDayOpenTooLong(undefined, later)).toBe(false);
    expect(isPosDayOpenTooLong('', later)).toBe(false);
    expect(isPosDayOpenTooLong('not a date', later)).toBe(false);
  });

  it('reads the native +00:00 spelling with nanoseconds', () => {
    expect(
      isPosDayOpenTooLong('2026-10-13T14:00:00.123456789+00:00', startedAt + 24 * 60 * MINUTE + MINUTE),
    ).toBe(true);
  });
});
