/**
 * How long a POS day may stay open before Health warns (founder decision
 * 13/10/2026). The POS day runs from its first check-in after the last Z to
 * the next Z (rule R5), whatever the clock says, so a day may legitimately run
 * past midnight. Past this age Health reports the day close as `overdue`: a
 * reminder only. It never blocks anything and never moves the day boundary.
 * POSSystemMobile mirrors the same threshold.
 */
export const POS_DAY_OPEN_WARNING_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * Whether the open POS day that started at `dayStartAt` (the end-of-day
 * status `dayStartAt`) has been open for more than
 * {@link POS_DAY_OPEN_WARNING_AFTER_MS}. No day start, or one that cannot be
 * read, never warns.
 */
export function isPosDayOpenTooLong(
  dayStartAt: string | null | undefined,
  nowMs: number,
): boolean {
  if (typeof dayStartAt !== 'string' || !dayStartAt.trim()) return false;
  // Native timestamps carry nanoseconds; keep the milliseconds JS parses.
  const startedAt = Date.parse(dayStartAt.trim().replace(/(\.\d{3})\d+/, '$1'));
  if (!Number.isFinite(startedAt) || !Number.isFinite(nowMs)) return false;
  return nowMs - startedAt > POS_DAY_OPEN_WARNING_AFTER_MS;
}
