/**
 * Reservations timeline hour-range helper.
 *
 * The timeline keeps a default business window (11:00–22:00) but must never hide a
 * reservation that falls earlier or later than it (e.g. a 09:00 booking). This
 * computes the ordered list of hour rows: the default window expanded to include the
 * earliest/latest reservation hour present in the filtered data.
 */

export const TIMELINE_DEFAULT_START_HOUR = 11;
export const TIMELINE_DEFAULT_END_HOUR = 22;

/**
 * Ordered hour rows for the reservations timeline.
 *
 * @param reservationHours - hours (0–23) of the filtered reservations; invalid/NaN
 *   values are ignored.
 * @returns ascending list of hours covering the default window plus any earlier/later
 *   reservation hour, so none are dropped from rendering.
 */
export function buildReservationTimelineSlots(
  reservationHours: number[],
  defaultStart: number = TIMELINE_DEFAULT_START_HOUR,
  defaultEnd: number = TIMELINE_DEFAULT_END_HOUR,
): number[] {
  const valid = reservationHours.filter(
    (hour) => Number.isInteger(hour) && hour >= 0 && hour <= 23,
  );
  const start = valid.length ? Math.min(defaultStart, ...valid) : defaultStart;
  const end = valid.length ? Math.max(defaultEnd, ...valid) : defaultEnd;
  return Array.from({ length: end - start + 1 }, (_, index) => start + index);
}
