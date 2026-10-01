import { describe, expect, it } from 'vitest';

import type { SyncQueueItem } from '../../../../../../shared/pos/sync-queue-types';
import {
  MAX_SYNC_NOW_TARGET_ROWS,
  rowsWaitingOutRetry,
  syncNowIssueCode,
  syncNowRemainder,
  syncNowTargetItems,
  wasAttempted,
} from '../sync-now-attempt';

/**
 * Review 30/09/2026: the desktop Health "Sync now" was judged "failed" when
 * the same problem was still there, even for rows the replay cycle never
 * tried (waiting out their retry delay). It is now judged on the rows it
 * tried, as on Android.
 */

const NOW = Date.parse('2026-09-30T14:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

const row = (overrides: Partial<SyncQueueItem> = {}): SyncQueueItem => ({
  id: 'queue-1',
  tableName: 'orders',
  recordId: 'order-1',
  operation: 'UPDATE',
  data: '{}',
  organizationId: 'org-1',
  createdAt: iso(-4 * HOUR),
  attempts: 2,
  lastAttempt: iso(-3 * HOUR),
  errorMessage: 'HTTP 503',
  nextRetryAt: null,
  retryDelayMs: 4000,
  priority: 0,
  moduleType: 'orders',
  conflictStrategy: 'server-wins',
  version: 1,
  status: 'pending',
  ...overrides,
});

describe('syncNowTargetItems', () => {
  it('takes the rows behind the problem, oldest first', () => {
    const items = [
      row({ id: 'young-order', createdAt: iso(-60 * 1000) }),
      row({ id: 'stuck-order' }),
      row({ id: 'fiscal', moduleType: 'fiscal', tableName: 'fiscal_submission', createdAt: iso(-5 * HOUR) }),
      row({ id: 'customer', moduleType: 'customers', tableName: 'customers', createdAt: iso(-2 * HOUR) }),
      row({ id: 'failed', status: 'failed', createdAt: iso(-6 * HOUR) }),
    ];
    expect(syncNowTargetItems('fiscalNotSent', items, NOW).map((item) => item.id)).toEqual(['fiscal']);
    expect(syncNowTargetItems('syncStuck', items, NOW).map((item) => item.id)).toEqual([
      'fiscal',
      'stuck-order',
      'customer',
    ]);
    expect(syncNowTargetItems('closeoutWaitingSync', items, NOW).map((item) => item.id)).toEqual([
      'failed',
      'fiscal',
      'stuck-order',
      'young-order',
    ]);
    expect(syncNowTargetItems('syncWaiting', items, NOW).map((item) => item.id)).toEqual([
      'fiscal',
      'stuck-order',
      'customer',
      'young-order',
    ]);
    const many = Array.from({ length: 80 }, (_, index) => row({ id: `row-${index}` }));
    expect(syncNowTargetItems('syncWaiting', many, NOW)).toHaveLength(MAX_SYNC_NOW_TARGET_ROWS);
  });

  it('logs against the Android issue families', () => {
    expect(syncNowIssueCode('fiscalNotSent')).toBe('fiscal_queue_not_empty');
    expect(syncNowIssueCode('closeoutWaitingSync')).toBe('sync_stuck');
    expect(syncNowIssueCode('offline')).toBe('sync');
  });
});

describe('rowsWaitingOutRetry', () => {
  it('lists only pending rows whose retry time is still ahead', () => {
    expect(
      rowsWaitingOutRetry(
        [
          row({ id: 'waiting', nextRetryAt: iso(12 * 60 * 1000) }),
          row({ id: 'due', nextRetryAt: iso(-60 * 1000) }),
          row({ id: 'never-tried', nextRetryAt: null }),
          row({ id: 'failed', status: 'failed', nextRetryAt: iso(HOUR) }),
        ],
        NOW,
      ),
    ).toEqual(['waiting']);
  });
});

describe('syncNowRemainder', () => {
  const before = [row({ id: 'a' }), row({ id: 'b' })];
  const tried = (item: SyncQueueItem) => ({ ...item, attempts: item.attempts + 1, lastAttempt: iso(-1000) });

  it('never counts a row the cycle did not try as a failure', () => {
    expect(syncNowRemainder({ before, after: before, problemStillThere: true, nowMs: NOW })).toBe('progressing');
  });

  it('counts a row tried and still stuck, failed or in conflict as a failure', () => {
    expect(syncNowRemainder({ before, after: before.map(tried), problemStillThere: true, nowMs: NOW })).toBe(
      'problem',
    );
    expect(
      syncNowRemainder({
        before,
        after: [{ ...before[0], status: 'conflict' }],
        problemStillThere: true,
        nowMs: NOW,
      }),
    ).toBe('problem');
  });

  it('calls the rows sent once they are gone, and waits on rows still going', () => {
    expect(syncNowRemainder({ before, after: [], problemStillThere: true, nowMs: NOW })).toBe('none');
    const young = [row({ id: 'y', createdAt: iso(-60 * 1000) })];
    expect(
      syncNowRemainder({ before: young, after: young.map(tried), problemStillThere: true, nowMs: NOW }),
    ).toBe('progressing');
  });

  it('says not verified when the rows could not be read again, and never failed with no rows', () => {
    expect(syncNowRemainder({ before, after: null, problemStillThere: true, nowMs: NOW })).toBeNull();
    expect(syncNowRemainder({ before: [], after: [], problemStillThere: true, nowMs: NOW })).toBe('progressing');
    expect(syncNowRemainder({ before: null, after: null, problemStillThere: false, nowMs: NOW })).toBe('none');
  });

  it('reads an attempt from the count, the last attempt or a turn to failed', () => {
    const base = row();
    expect(wasAttempted(base, undefined)).toBe(true);
    expect(wasAttempted(base, base)).toBe(false);
    expect(wasAttempted(base, { ...base, attempts: 3 })).toBe(true);
    expect(wasAttempted(base, { ...base, lastAttempt: iso(-1000) })).toBe(true);
    expect(wasAttempted(base, { ...base, status: 'failed' })).toBe(true);
    expect(wasAttempted(base, { ...base, status: 'processing' })).toBe(false);
  });
});
