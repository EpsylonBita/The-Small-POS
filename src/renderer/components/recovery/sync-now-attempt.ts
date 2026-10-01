/**
 * The Health modal's "Sync now" on the desktop parity queue, judged on the
 * rows it actually tried (review 30/09/2026).
 *
 * The replay cycle takes only due rows: a row waiting out its retry delay
 * was never tried, yet the old judgment ("the same problem is still there")
 * called the attempt failed and escalated to Export diagnostics. Sync now
 * now makes the rows behind the problem due (their retry time only,
 * recorded in the recovery log first: sync_queue_make_due), runs the cycle,
 * reads the rows again by id (sync_queue_items_by_id) and counts a failure
 * only for rows it tried. Android judges its queue rows the same way
 * (POSSystemMobile services/health/syncNowRecovery.ts, mobileHealthModel
 * wasAttempted).
 */

import type { SyncQueueItem } from '../../../../../shared/pos/sync-queue-types';
import type { HealthProblemCode } from '../../../../../shared/pos/health/health-contract';
import type { SyncAttemptRemainder } from '../../../../../shared/pos/health/health-summary';
import {
  classifyParityQueueItem,
  parseQueueTimestampMs,
  rowBlocksDayClose,
} from '../../../../../shared/pos/health/queue-classification';

/** Rows one Sync now works on (and reads back by id). */
export const MAX_SYNC_NOW_TARGET_ROWS = 50;

/** The issue family a Sync now is logged against (Android's issue codes). */
export function syncNowIssueCode(problem: HealthProblemCode): string {
  switch (problem) {
    case 'fiscalNotSent':
      return 'fiscal_queue_not_empty';
    case 'syncStuck':
    case 'closeoutWaitingSync':
      return 'sync_stuck';
    case 'syncFailed':
    case 'failedPayments':
      return 'sync_failed';
    case 'syncWaiting':
      return 'sync_waiting';
    default:
      return 'sync';
  }
}

const createdMs = (item: SyncQueueItem): number =>
  parseQueueTimestampMs(item.createdAt ?? null) ?? Number.MAX_SAFE_INTEGER;

/** The parity rows behind a Health problem, oldest first: what Sync now works on. */
export function syncNowTargetItems(
  problem: HealthProblemCode,
  items: readonly SyncQueueItem[],
  nowMs: number,
): SyncQueueItem[] {
  const behind = (item: SyncQueueItem): boolean => {
    switch (problem) {
      case 'fiscalNotSent':
        return item.moduleType === 'fiscal';
      case 'closeoutWaitingSync':
        return rowBlocksDayClose({ tableName: item.tableName, moduleType: item.moduleType ?? null });
      case 'syncStuck':
        return classifyParityQueueItem(item, nowMs) === 'stuck';
      default:
        return item.status === 'pending' || item.status === 'processing';
    }
  };
  return items
    .filter(behind)
    .sort((a, b) => createdMs(a) - createdMs(b))
    .slice(0, MAX_SYNC_NOW_TARGET_ROWS);
}

/** Pending rows waiting out a retry delay: the cycle would skip them. */
export function rowsWaitingOutRetry(items: readonly SyncQueueItem[], nowMs: number): string[] {
  return items
    .filter((item) => {
      if (item.status !== 'pending' || !item.nextRetryAt) return false;
      const retryAt = Date.parse(item.nextRetryAt);
      return !Number.isFinite(retryAt) || retryAt > nowMs;
    })
    .map((item) => item.id);
}

/**
 * Whether a send attempt touched the row since `before`: it is gone, its
 * attempt count or last attempt moved, or it turned failed or conflicted.
 */
export function wasAttempted(before: SyncQueueItem, now: SyncQueueItem | undefined): boolean {
  if (!now) return true;
  return (
    now.attempts > before.attempts ||
    (now.lastAttempt ?? null) !== (before.lastAttempt ?? null) ||
    (now.status !== before.status && (now.status === 'failed' || now.status === 'conflict'))
  );
}

/**
 * What is left of the rows a Sync now worked on, judged only on the rows it
 * tried: gone → none; tried and still stuck, failed or in conflict →
 * problem; not tried, or still going → progressing. With no rows named, the
 * problem itself says whether anything is left, never "problem". null when
 * the rows could not be read again (not verified).
 */
export function syncNowRemainder(input: {
  before: readonly SyncQueueItem[] | null;
  after: readonly SyncQueueItem[] | null;
  problemStillThere: boolean;
  nowMs: number;
}): SyncAttemptRemainder | null {
  if (!input.before || input.before.length === 0) {
    return input.problemStillThere ? 'progressing' : 'none';
  }
  if (!input.after) return null;
  const now = new Map(input.after.map((item) => [item.id, item]));
  let progressing = false;
  for (const before of input.before) {
    const current = now.get(before.id);
    if (!current) continue;
    const state = classifyParityQueueItem(current, input.nowMs);
    const stillAProblem = state === 'stuck' || state === 'failed' || state === 'conflict';
    if (wasAttempted(before, current) && stillAProblem) return 'problem';
    progressing = true;
  }
  return progressing ? 'progressing' : 'none';
}
