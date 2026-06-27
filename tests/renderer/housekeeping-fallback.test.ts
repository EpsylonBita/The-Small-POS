import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyHousekeepingStatusOverrides,
  applyStatusTransition,
  buildHousekeepingFallbackTasks,
  housekeepingStatusRank,
  isFallbackTaskId,
  toHousekeepingStatusOverride,
  FALLBACK_TASK_PREFIX,
  type CleaningRoomLike,
  type HousekeepingStatusOverride,
  type HousekeepingTask,
} from '../../src/renderer/pages/verticals/hotel/housekeeping-fallback.ts';

const room = (over: Partial<CleaningRoomLike> = {}): CleaningRoomLike => ({
  id: 'r1',
  roomNumber: '101',
  roomType: 'standard',
  floor: 1,
  status: 'cleaning',
  updatedAt: '2026-06-20T10:00:00Z',
  ...over,
});

const task = (over: Partial<HousekeepingTask> = {}): HousekeepingTask => ({
  id: 't1',
  room_id: 'r1',
  room_number: '101',
  floor: 1,
  room_type: 'standard',
  task_type: 'cleaning',
  status: 'pending',
  priority: 'normal',
  assigned_staff_id: null,
  assigned_staff_name: null,
  checklist: null,
  notes: null,
  scheduled_at: null,
  started_at: null,
  completed_at: null,
  verified_at: null,
  created_at: '2026-06-21T07:00:00Z',
  updated_at: '2026-06-21T07:00:00Z',
  ...over,
});

test('derives a pending fallback task for each cleaning room when no tasks exist', () => {
  const rooms = [room({ id: 'r1', roomNumber: '101' }), room({ id: 'r2', roomNumber: '204', floor: 2 })];
  const out = buildHousekeepingFallbackTasks(rooms, []);

  assert.equal(out.length, 2);
  const [first, second] = out;
  assert.equal(first.id, `${FALLBACK_TASK_PREFIX}r1`);
  assert.equal(first.room_id, 'r1');
  assert.equal(first.room_number, '101');
  assert.equal(first.floor, 1);
  assert.equal(first.room_type, 'standard');
  assert.equal(first.task_type, 'cleaning');
  assert.equal(first.status, 'pending');
  assert.equal(first.priority, 'normal');
  assert.equal(first.isFallback, true);
  assert.equal(second.floor, 2);
});

test('ignores rooms that are not in cleaning status', () => {
  const rooms = [
    room({ id: 'r1', status: 'available' }),
    room({ id: 'r2', roomNumber: '204', status: 'occupied' }),
    room({ id: 'r3', roomNumber: '305', status: 'cleaning' }),
  ];
  const out = buildHousekeepingFallbackTasks(rooms, []);
  assert.equal(out.length, 1);
  assert.equal(out[0].room_id, 'r3');
});

test('dedupes a cleaning room that already has a real task (matched by room id)', () => {
  const rooms = [room({ id: 'r1', roomNumber: '101' }), room({ id: 'r2', roomNumber: '204' })];
  const existing = [{ room_id: 'r1', room_number: '101' }];
  const out = buildHousekeepingFallbackTasks(rooms, existing);
  assert.equal(out.length, 1);
  assert.equal(out[0].room_id, 'r2');
});

test('dedupes by room number when the real task carries no room id', () => {
  const rooms = [room({ id: 'r1', roomNumber: '101' })];
  const existing = [{ room_id: null, room_number: '101' }];
  const out = buildHousekeepingFallbackTasks(rooms, existing);
  assert.equal(out.length, 0);
});

test('returns nothing when no rooms are in cleaning status', () => {
  assert.deepEqual(buildHousekeepingFallbackTasks([room({ status: 'occupied' })], []), []);
});

test('isFallbackTaskId matches only the synthetic prefix', () => {
  assert.equal(isFallbackTaskId(`${FALLBACK_TASK_PREFIX}r1`), true);
  assert.equal(isFallbackTaskId('fallback:abc-123'), true);
  assert.equal(isFallbackTaskId('real-uuid-1234'), false);
  assert.equal(isFallbackTaskId(''), false);
});

test('housekeepingStatusRank orders the forward lifecycle with cancelled terminal-highest', () => {
  assert.ok(housekeepingStatusRank('pending') < housekeepingStatusRank('in_progress'));
  assert.ok(housekeepingStatusRank('in_progress') < housekeepingStatusRank('completed'));
  assert.ok(housekeepingStatusRank('completed') < housekeepingStatusRank('verified'));
  assert.ok(housekeepingStatusRank('cancelled') > housekeepingStatusRank('verified'));
});

test('applyStatusTransition mirrors server status-to-timestamp semantics and preserves real timestamps', () => {
  const base = task({ status: 'pending', started_at: null, completed_at: null, verified_at: null });

  const inProgress = applyStatusTransition(base, 'in_progress', 'T1');
  assert.equal(inProgress.status, 'in_progress');
  assert.equal(inProgress.started_at, 'T1');
  assert.equal(inProgress.updated_at, 'T1');

  const completed = applyStatusTransition(base, 'completed', 'T2');
  assert.equal(completed.completed_at, 'T2');
  assert.equal(completed.started_at, 'T2', 'completed backfills started_at when missing');

  const verified = applyStatusTransition(base, 'verified', 'T3');
  assert.equal(verified.verified_at, 'T3');
  assert.equal(verified.completed_at, 'T3', 'verified backfills completed_at so it counts toward Completed Today');

  // A real (server) started_at must not be clobbered with `now`.
  const started = task({ status: 'in_progress', started_at: 'real-start' });
  const completedFromStarted = applyStatusTransition(started, 'completed', 'T4');
  assert.equal(completedFromStarted.started_at, 'real-start');
  assert.equal(completedFromStarted.completed_at, 'T4');
});

test('toHousekeepingStatusOverride captures the status + assignment + timestamp slice', () => {
  const verified = task({
    status: 'verified',
    assigned_staff_id: 'staff-ana',
    assigned_staff_name: 'Ana Novak',
    started_at: 'a',
    completed_at: 'b',
    verified_at: 'c',
    updated_at: 'd',
    notes: 'should-not-be-copied',
  });
  assert.deepEqual(toHousekeepingStatusOverride(verified), {
    status: 'verified',
    assigned_staff_id: 'staff-ana',
    assigned_staff_name: 'Ana Novak',
    started_at: 'a',
    completed_at: 'b',
    verified_at: 'c',
    updated_at: 'd',
  });
});

// THE LIVE REGRESSION: verify Room 106 locally, then a refresh while sync is unhealthy
// returns the stale pending row. The merge must keep the verified transition visible.
test('applyHousekeepingStatusOverrides keeps a locally verified task visible when the refetch is stale pending', () => {
  const verifiedOverride: HousekeepingStatusOverride = {
    status: 'verified',
    started_at: '2026-06-21T08:00:00Z',
    completed_at: '2026-06-21T08:10:00Z',
    verified_at: '2026-06-21T08:12:00Z',
    updated_at: '2026-06-21T08:12:00Z',
  };
  const overrides = new Map<string, HousekeepingStatusOverride>([['t-106', verifiedOverride]]);
  // Admin API (sync unhealthy) still returns Room 106 as pending with no timestamps.
  const fetched = [
    task({ id: 't-106', room_number: '106', status: 'pending', started_at: null, completed_at: null, verified_at: null }),
  ];

  const { tasks: merged, resolved } = applyHousekeepingStatusOverrides(fetched, overrides);

  assert.equal(resolved.length, 0, 'a stale-pending server row must NOT resolve a verified override');
  assert.equal(merged[0].status, 'verified', 'the local verified transition survives the refetch');
  assert.equal(merged[0].verified_at, '2026-06-21T08:12:00Z');
  assert.equal(
    merged[0].completed_at,
    '2026-06-21T08:10:00Z',
    'completed_at survives so Completed Today keeps counting the verified task',
  );
});

// THE LIVE ASSIGNMENT REGRESSION (2026-06-21): assign Room 102 to Ana, then Start. The
// status override now carries the assignment, so a refetch returning the still-unassigned
// server row must NOT revert the card to unassigned.
test('applyHousekeepingStatusOverrides preserves the locally assigned staff across a status change', () => {
  const startedOverride: HousekeepingStatusOverride = {
    status: 'in_progress',
    assigned_staff_id: 'staff-ana',
    assigned_staff_name: 'Ana Novak',
    started_at: '2026-06-21T09:00:00Z',
    completed_at: null,
    verified_at: null,
    updated_at: '2026-06-21T09:00:00Z',
  };
  const overrides = new Map<string, HousekeepingStatusOverride>([['t-102', startedOverride]]);
  // The admin API still returns Room 102 as pending AND unassigned (neither mutation synced).
  const fetched = [
    task({ id: 't-102', room_number: '102', status: 'pending', assigned_staff_id: null, assigned_staff_name: null }),
  ];

  const { tasks: merged, resolved } = applyHousekeepingStatusOverrides(fetched, overrides, fetched);

  assert.equal(resolved.length, 0, 'a stale-pending row must not resolve an in_progress override');
  assert.equal(merged[0].status, 'in_progress', 'the local Start transition survives the refetch');
  assert.equal(merged[0].assigned_staff_id, 'staff-ana', 'the assigned cleaner id is preserved');
  assert.equal(merged[0].assigned_staff_name, 'Ana Novak', 'the assigned cleaner name is preserved');
});

// A task that drops out of the fetched list (status=all -> active-only compat) but is still
// in previousTasks must be re-added WITH the assignment carried by the override.
test('applyHousekeepingStatusOverrides re-adds a missing task with its preserved assignment', () => {
  const startedOverride: HousekeepingStatusOverride = {
    status: 'in_progress',
    assigned_staff_id: 'staff-ana',
    assigned_staff_name: 'Ana Novak',
    started_at: '2026-06-21T09:00:00Z',
    completed_at: null,
    verified_at: null,
    updated_at: '2026-06-21T09:00:00Z',
  };
  const overrides = new Map<string, HousekeepingStatusOverride>([['t-102', startedOverride]]);
  const previous = [task({ id: 't-102', room_number: '102', status: 'pending', assigned_staff_id: null, assigned_staff_name: null })];

  // Fetched list omits t-102 entirely; previousTasks carries the prior visible row.
  const { tasks: merged } = applyHousekeepingStatusOverrides([], overrides, previous);

  const room102 = merged.find((t) => t.id === 't-102');
  assert.ok(room102, 't-102 must be re-added from previousTasks while its override is active');
  assert.equal(room102?.status, 'in_progress');
  assert.equal(room102?.assigned_staff_id, 'staff-ana', 're-added row keeps the assigned cleaner id');
  assert.equal(room102?.assigned_staff_name, 'Ana Novak', 're-added row keeps the assigned cleaner name');
});

// Review follow-up (2026-06-21): an override that OWNS a cleared assignment (null) must win
// over stale server staff during a status transition — staff explicitly unassigned the task,
// so a refetch returning the old cleaner must NOT resurrect it.
test('applyHousekeepingStatusOverrides preserves an explicitly-cleared (null) assignment over stale fetched staff', () => {
  const clearedOverride: HousekeepingStatusOverride = {
    status: 'in_progress',
    assigned_staff_id: null,
    assigned_staff_name: null,
    started_at: '2026-06-21T09:00:00Z',
    completed_at: null,
    verified_at: null,
    updated_at: '2026-06-21T09:00:00Z',
  };
  const overrides = new Map<string, HousekeepingStatusOverride>([['t-102', clearedOverride]]);
  // The stale server row still carries the previously-assigned cleaner.
  const fetched = [
    task({ id: 't-102', room_number: '102', status: 'pending', assigned_staff_id: 'staff-ana', assigned_staff_name: 'Ana Novak' }),
  ];

  const { tasks: merged } = applyHousekeepingStatusOverrides(fetched, overrides, fetched);

  assert.equal(merged[0].status, 'in_progress');
  assert.equal(merged[0].assigned_staff_id, null, 'the cleared assignment id must win over stale server staff');
  assert.equal(merged[0].assigned_staff_name, null, 'the cleared assignment name must win over stale server staff');
});

test('applyHousekeepingStatusOverrides preserves a cleared (null) assignment on a re-added missing task', () => {
  const clearedOverride: HousekeepingStatusOverride = {
    status: 'in_progress',
    assigned_staff_id: null,
    assigned_staff_name: null,
    started_at: '2026-06-21T09:00:00Z',
    completed_at: null,
    verified_at: null,
    updated_at: '2026-06-21T09:00:00Z',
  };
  const overrides = new Map<string, HousekeepingStatusOverride>([['t-102', clearedOverride]]);
  // previousTasks row still has the old cleaner; the override cleared it.
  const previous = [task({ id: 't-102', room_number: '102', status: 'pending', assigned_staff_id: 'staff-ana', assigned_staff_name: 'Ana Novak' })];

  const { tasks: merged } = applyHousekeepingStatusOverrides([], overrides, previous);

  const room102 = merged.find((t) => t.id === 't-102');
  assert.ok(room102, 't-102 must be re-added from previousTasks while its override is active');
  assert.equal(room102?.assigned_staff_id, null, 're-added row must honor the cleared assignment id');
  assert.equal(room102?.assigned_staff_name, null, 're-added row must honor the cleared assignment name');
});

// Backward-compat: a legacy override that never carried assignment keys must still fall back
// to the base row's staff (not clobber it to null).
test('applyHousekeepingStatusOverrides falls back to base staff when the override omits assignment keys', () => {
  const legacyOverride: HousekeepingStatusOverride = {
    status: 'in_progress',
    started_at: '2026-06-21T09:00:00Z',
    completed_at: null,
    verified_at: null,
    updated_at: '2026-06-21T09:00:00Z',
  };
  const overrides = new Map<string, HousekeepingStatusOverride>([['t-102', legacyOverride]]);
  const fetched = [
    task({ id: 't-102', room_number: '102', status: 'pending', assigned_staff_id: 'staff-ana', assigned_staff_name: 'Ana Novak' }),
  ];

  const { tasks: merged } = applyHousekeepingStatusOverrides(fetched, overrides, fetched);

  assert.equal(merged[0].status, 'in_progress');
  assert.equal(merged[0].assigned_staff_id, 'staff-ana', 'legacy override without keys keeps the base staff');
  assert.equal(merged[0].assigned_staff_name, 'Ana Novak', 'legacy override without keys keeps the base staff name');
});

test('applyHousekeepingStatusOverrides drops an override once the server status catches up', () => {
  const overrides = new Map<string, HousekeepingStatusOverride>([
    ['t1', { status: 'verified', started_at: null, completed_at: 'local-c', verified_at: 'local-v', updated_at: 'local-u' }],
  ]);
  const serverVerified = task({ id: 't1', status: 'verified', verified_at: 'server-v', completed_at: 'server-c' });

  const { tasks: merged, resolved } = applyHousekeepingStatusOverrides([serverVerified], overrides);

  assert.deepEqual(resolved, ['t1'], 'the override resolves when the server reaches the same status');
  assert.equal(merged[0].verified_at, 'server-v', 'the server value wins once it has caught up');
  assert.equal(merged[0].completed_at, 'server-c');
});

test('applyHousekeepingStatusOverrides keeps a higher local status over a stale lower server, resolves when reached/surpassed', () => {
  const completedOverride: HousekeepingStatusOverride = {
    status: 'completed',
    started_at: null,
    completed_at: 'c',
    verified_at: null,
    updated_at: 'u',
  };

  // Stale: server still pending -> keep the local completed transition.
  const stale = applyHousekeepingStatusOverrides([task({ id: 't1', status: 'pending' })], new Map([['t1', completedOverride]]));
  assert.equal(stale.resolved.length, 0);
  assert.equal(stale.tasks[0].status, 'completed');

  // Caught up: server completed -> resolve.
  const caughtUp = applyHousekeepingStatusOverrides([task({ id: 't1', status: 'completed' })], new Map([['t1', completedOverride]]));
  assert.deepEqual(caughtUp.resolved, ['t1']);

  // Surpassed: server verified (higher) -> resolve and defer to the server.
  const surpassed = applyHousekeepingStatusOverrides([task({ id: 't1', status: 'verified' })], new Map([['t1', completedOverride]]));
  assert.deepEqual(surpassed.resolved, ['t1']);
  assert.equal(surpassed.tasks[0].status, 'verified');
});

test('applyHousekeepingStatusOverrides preserves overridden tasks absent from the fetch when a previous row exists', () => {
  const overrides = new Map<string, HousekeepingStatusOverride>([
    ['gone', { status: 'verified', started_at: null, completed_at: 'c', verified_at: 'v', updated_at: 'u' }],
  ]);
  const previous = task({ id: 'gone', room_number: '106', status: 'completed', completed_at: 'old-c' });
  const { tasks: merged, resolved } = applyHousekeepingStatusOverrides(
    [task({ id: 'other', status: 'pending' })],
    overrides,
    [previous],
  );

  assert.equal(resolved.length, 0, 'a task missing from the fetch must not resolve its override');
  assert.equal(merged.length, 2);
  assert.equal(merged[0].id, 'other');
  assert.equal(merged[1].id, 'gone');
  assert.equal(merged[1].room_number, '106');
  assert.equal(merged[1].status, 'verified');
  assert.equal(merged[1].completed_at, 'c');
  assert.equal(merged[1].verified_at, 'v');
  assert.equal(overrides.has('gone'), true, 'the override is retained for when the task reappears');
});

test('applyHousekeepingStatusOverrides is a no-op with no overrides and falls back to server timestamps it lacks', () => {
  const fetched = [task({ id: 't1', status: 'pending', started_at: 'srv-start' })];

  const noop = applyHousekeepingStatusOverrides(fetched, new Map());
  assert.equal(noop.tasks, fetched, 'no overrides returns the same array reference');
  assert.deepEqual(noop.resolved, []);

  // Override carries verified_at/completed_at but not started_at -> started_at falls back to server.
  const overrides = new Map<string, HousekeepingStatusOverride>([
    ['t1', { status: 'verified', started_at: null, completed_at: 'ov-c', verified_at: 'ov-v', updated_at: 'ov-u' }],
  ]);
  const { tasks: merged } = applyHousekeepingStatusOverrides(fetched, overrides);
  assert.equal(merged[0].started_at, 'srv-start', 'a timestamp the override lacks falls back to the server value');
  assert.equal(merged[0].verified_at, 'ov-v');
  assert.equal(merged[0].updated_at, 'ov-u');
});
