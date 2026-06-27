/**
 * Shared validation for Staff Schedule add-shift duration / next-day handling.
 *
 * The add-shift modal lets staff pick a start and end (date + time) and offers a
 * "set end date to next day" shortcut for overnight shifts. Two problems are
 * guarded here:
 *
 * 1. The next-day shortcut must not turn a normal same-day preset (e.g.
 *    17:00-23:00) into an implausible 24h+ shift. It should only roll the end
 *    date forward when the end clock-time is at or before the start clock-time
 *    (a genuine overnight wrap such as 23:00-05:00).
 * 2. Preview and submit must apply the SAME rules, so a shift the preview flags
 *    as invalid can never be saved. Both call evaluateShiftDuration.
 *
 * Display/formatting stays in the component; these are pure functions.
 */

// A scheduled shift must be strictly shorter than a full day; a duration that
// reaches or exceeds this is rejected. Legitimate overnight shifts are
// comfortably under this, so it only blocks implausible (e.g. 24h, 30h) durations.
export const MAX_SHIFT_MINUTES = 24 * 60;

export type ShiftDurationStatus = 'ok' | 'invalid' | 'endNotAfterStart' | 'tooLong';

export interface ShiftDurationResult {
  status: ShiftDurationStatus;
  valid: boolean;
  durationMinutes: number | null;
}

/**
 * Evaluate a start/end pair (ISO strings) against the shared shift rules:
 * end must be after start, and the duration must be strictly less than
 * `maxMinutes` (so an exact full-day shift is rejected).
 */
export function evaluateShiftDuration(
  startIso: string | null | undefined,
  endIso: string | null | undefined,
  maxMinutes: number = MAX_SHIFT_MINUTES,
): ShiftDurationResult {
  if (!startIso || !endIso) {
    return { status: 'invalid', valid: false, durationMinutes: null };
  }

  const start = new Date(startIso).getTime();
  const end = new Date(endIso).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return { status: 'invalid', valid: false, durationMinutes: null };
  }

  if (end <= start) {
    return { status: 'endNotAfterStart', valid: false, durationMinutes: null };
  }

  const durationMinutes = Math.round((end - start) / 60000);
  if (durationMinutes >= maxMinutes) {
    return { status: 'tooLong', valid: false, durationMinutes };
  }

  return { status: 'ok', valid: true, durationMinutes };
}

/**
 * Whether the "next day" shortcut should roll the end date forward by one day.
 * True only when the end clock-time is at or before the start clock-time, i.e.
 * the shift genuinely wraps past midnight. A same-day shift (end strictly after
 * start) keeps its end date so the shortcut can't fabricate a 24h+ shift.
 */
export function shouldRollEndToNextDay(
  startHour: string | number,
  startMinute: string | number,
  endHour: string | number,
  endMinute: string | number,
): boolean {
  const startTotal = Number(startHour) * 60 + Number(startMinute);
  const endTotal = Number(endHour) * 60 + Number(endMinute);
  if (!Number.isFinite(startTotal) || !Number.isFinite(endTotal)) {
    return false;
  }
  return endTotal <= startTotal;
}
