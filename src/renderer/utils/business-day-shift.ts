/**
 * Does an open shift belong to the terminal's CURRENT business day?
 *
 * A business day here runs check-in -> Z for as long as it takes, so "open for
 * forty hours" is not by itself wrong and must never be judged by a wall-clock
 * age limit. The only honest boundary is the day's own start — the moment the
 * last Z closed the previous one, which `staff-auth:refresh-directory` reports
 * as `businessDayStartAt`.
 *
 * Field failure this exists for (2026-08-25): the table-service waiter picker
 * treated the mere existence of a shift id as ACTIVE, so a row left open weeks
 * earlier presented its owner as a waiter standing by the tables.
 *
 * Fails OPEN on purpose. If the boundary or the check-in stamp is missing or
 * unparseable we return true, because hiding a real person who is actually on
 * shift is worse than showing a stale one — the caller can still surface the
 * timestamp so a human can tell.
 */
export function shiftBelongsToCurrentBusinessDay(
  businessDayStartAt: string | null | undefined,
  checkedInAt: string | null | undefined,
): boolean {
  const boundary = typeof businessDayStartAt === 'string' ? Date.parse(businessDayStartAt) : NaN;
  if (Number.isNaN(boundary)) {
    return true;
  }

  const checkedIn = typeof checkedInAt === 'string' ? Date.parse(checkedInAt) : NaN;
  if (Number.isNaN(checkedIn)) {
    return true;
  }

  return checkedIn >= boundary;
}
