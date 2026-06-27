/**
 * Housekeeping fallback task derivation.
 *
 * Rooms can sit in `cleaning` status (e.g. right after check-out, or when staff
 * set them to cleaning) before a `housekeeping_tasks` row exists for them. When
 * that happens the Housekeeping board would show an empty state even though the
 * Rooms view clearly counts cleaning rooms. These helpers derive conservative,
 * client-only fallback rows from the current Rooms data so those rooms stay
 * visible and counted — WITHOUT creating or submitting any server records just
 * by rendering the page.
 *
 * Fallback rows carry a synthetic id (`fallback:<roomId>`); callers must never
 * send that id to the housekeeping task update/assign APIs. Use isFallbackTaskId
 * to guard those code paths.
 */

export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'verified' | 'cancelled';
export type Priority = 'urgent' | 'high' | 'normal' | 'low';

export interface HousekeepingTask {
  id: string;
  room_id: string | null;
  room_number: string | null;
  floor: number | null;
  room_type: string | null;
  task_type: string;
  status: TaskStatus;
  priority: Priority;
  assigned_staff_id: string | null;
  assigned_staff_name: string | null;
  checklist: Array<{ id: string; label: string; completed: boolean }> | null;
  notes: string | null;
  scheduled_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  verified_at: string | null;
  created_at: string;
  updated_at: string;
  /** True for client-derived rows that have no backing housekeeping_tasks row. */
  isFallback?: boolean;
}

/** Minimal room shape needed to derive a fallback row (structurally a Room). */
export interface CleaningRoomLike {
  id: string;
  roomNumber: string;
  roomType?: string | null;
  floor?: number | null;
  status: string;
  updatedAt?: string | null;
}

export const FALLBACK_TASK_PREFIX = 'fallback:';

/** A synthetic fallback id must never be sent to a housekeeping task endpoint. */
export const isFallbackTaskId = (id: string): boolean =>
  typeof id === 'string' && id.startsWith(FALLBACK_TASK_PREFIX);

/**
 * The minimal slice of an optimistic local status transition we keep so a refetch
 * cannot regress it. Stored per real task id while the offline mutation that carries
 * the same change is still pending/failing to sync.
 */
export interface HousekeepingStatusOverride {
  status: TaskStatus;
  // The locally-visible staff assignment captured at transition time. A status change must
  // not revert the card to unassigned when a refetch fires before the assign mutation has
  // synced, so the override carries the assignment forward alongside the status.
  assigned_staff_id?: string | null;
  assigned_staff_name?: string | null;
  started_at: string | null;
  completed_at: string | null;
  verified_at: string | null;
  updated_at: string;
}

/**
 * Housekeeping status is a forward lifecycle. Ranking it lets a refetch decide whether
 * the server has "caught up" to a local optimistic transition (drop the override) or is
 * still returning stale data (keep showing the local transition). `cancelled` is a
 * terminal off-ladder state ranked highest so a local cancel is only superseded once the
 * server itself reports cancelled.
 */
const STATUS_RANK: Record<TaskStatus, number> = {
  pending: 0,
  in_progress: 1,
  completed: 2,
  verified: 3,
  cancelled: 4,
};

export const housekeepingStatusRank = (status: TaskStatus): number => STATUS_RANK[status] ?? 0;

/**
 * Apply the server's status-to-timestamp semantics to a task locally so an optimistic
 * transition stays consistent with timestamp-driven KPIs (Completed Today, average
 * completion time) immediately, not only after the next refetch. Existing real
 * timestamps are preserved; only missing ones are backfilled with `now`.
 */
export function applyStatusTransition(
  task: HousekeepingTask,
  status: TaskStatus,
  now: string,
): HousekeepingTask {
  const next: HousekeepingTask = { ...task, status, updated_at: now };
  if (status === 'in_progress' && !next.started_at) {
    next.started_at = now;
  }
  if (status === 'completed') {
    next.completed_at = now;
    if (!next.started_at) next.started_at = now;
  }
  if (status === 'verified') {
    next.verified_at = now;
    // A verified task was completed; keep (or backfill) completed_at so it still counts
    // toward Completed Today even when the stale server row has none.
    if (!next.completed_at) next.completed_at = now;
  }
  return next;
}

/** Capture the status + assignment + timestamp slice of an (already transitioned) task as an override. */
export function toHousekeepingStatusOverride(
  task: Pick<
    HousekeepingTask,
    'status' | 'assigned_staff_id' | 'assigned_staff_name' | 'started_at' | 'completed_at' | 'verified_at' | 'updated_at'
  >,
): HousekeepingStatusOverride {
  return {
    status: task.status,
    assigned_staff_id: task.assigned_staff_id,
    assigned_staff_name: task.assigned_staff_name,
    started_at: task.started_at,
    completed_at: task.completed_at,
    verified_at: task.verified_at,
    updated_at: task.updated_at,
  };
}

/**
 * Resolve the assignment to apply when merging an override onto a base task row. When the
 * override OWNS the assignment keys (real overrides built via toHousekeepingStatusOverride),
 * its values win even when null — so an explicitly-cleared (unassigned) assignment is
 * preserved against stale server staff during the status-transition/refetch race. Legacy
 * overrides that never carried assignment (keys absent) fall back to the base row.
 */
function resolveOverrideAssignment(
  override: HousekeepingStatusOverride,
  base: Pick<HousekeepingTask, 'assigned_staff_id' | 'assigned_staff_name'>,
): Pick<HousekeepingTask, 'assigned_staff_id' | 'assigned_staff_name'> {
  return {
    assigned_staff_id: 'assigned_staff_id' in override ? (override.assigned_staff_id ?? null) : base.assigned_staff_id,
    assigned_staff_name: 'assigned_staff_name' in override ? (override.assigned_staff_name ?? null) : base.assigned_staff_name,
  };
}

/**
 * Merge pending optimistic status overrides onto a freshly fetched task list so a refresh
 * while sync is pending/failing cannot overwrite a local in_progress/completed/verified
 * transition with stale admin data.
 *
 * For each fetched task that has an override:
 * - If the server's status rank is >= the override's, the server has caught up (or moved
 *   past it): defer to the server and report the id as `resolved` so the caller can drop
 *   the override.
 * - Otherwise the server row is stale: re-apply the local status + its timestamps (falling
 *   back to the server's value for any timestamp the override does not carry) so the staff-
 *   visible transition and its counters survive the refetch.
 *
 * Overrides whose task id is absent from `tasks` are left intact (neither applied nor
 * resolved). If the previous visible task row is provided, that row is preserved with the
 * override applied so a status=all -> active-only compatibility refetch cannot silently
 * discard a verified task that the active-only endpoint omits.
 */
export function applyHousekeepingStatusOverrides(
  tasks: HousekeepingTask[],
  overrides: Map<string, HousekeepingStatusOverride>,
  previousTasks: HousekeepingTask[] = [],
): { tasks: HousekeepingTask[]; resolved: string[] } {
  if (overrides.size === 0) {
    return { tasks, resolved: [] };
  }

  const resolved: string[] = [];
  const fetchedTaskIds = new Set<string>();
  const merged = tasks.map((task) => {
    fetchedTaskIds.add(task.id);
    const override = overrides.get(task.id);
    if (!override) {
      return task;
    }
    if (housekeepingStatusRank(task.status) >= housekeepingStatusRank(override.status)) {
      resolved.push(task.id);
      return task;
    }
    return {
      ...task,
      status: override.status,
      // Preserve the locally-visible assignment captured at transition time (including an
      // explicitly-cleared null) so a status change does not revert the card to stale staff
      // before the assign mutation syncs.
      ...resolveOverrideAssignment(override, task),
      started_at: override.started_at ?? task.started_at,
      completed_at: override.completed_at ?? task.completed_at,
      verified_at: override.verified_at ?? task.verified_at,
      updated_at: override.updated_at,
    };
  });

  for (const previousTask of previousTasks) {
    const override = overrides.get(previousTask.id);
    if (!override || fetchedTaskIds.has(previousTask.id)) {
      continue;
    }
    merged.push({
      ...previousTask,
      status: override.status,
      ...resolveOverrideAssignment(override, previousTask),
      started_at: override.started_at ?? previousTask.started_at,
      completed_at: override.completed_at ?? previousTask.completed_at,
      verified_at: override.verified_at ?? previousTask.verified_at,
      updated_at: override.updated_at,
    });
  }

  return { tasks: merged, resolved };
}

/**
 * Build fallback housekeeping rows from rooms currently in `cleaning` status that
 * are not already represented by a real housekeeping task. Dedupe is by room id
 * and, defensively, by room number (a real task may not carry the room id).
 */
export function buildHousekeepingFallbackTasks(
  rooms: CleaningRoomLike[],
  existingTasks: Array<Pick<HousekeepingTask, 'room_id' | 'room_number'>>,
): HousekeepingTask[] {
  const cleaningRooms = rooms.filter((room) => room.status === 'cleaning');
  if (cleaningRooms.length === 0) {
    return [];
  }

  const coveredRoomIds = new Set(
    existingTasks
      .map((task) => task.room_id)
      .filter((value): value is string => Boolean(value)),
  );
  const coveredRoomNumbers = new Set(
    existingTasks
      .map((task) => (task.room_number != null ? String(task.room_number) : ''))
      .filter((value) => value.length > 0),
  );

  return cleaningRooms
    .filter(
      (room) =>
        !coveredRoomIds.has(room.id) &&
        !coveredRoomNumbers.has(String(room.roomNumber)),
    )
    .map((room) => ({
      id: `${FALLBACK_TASK_PREFIX}${room.id}`,
      room_id: room.id,
      room_number: room.roomNumber,
      floor: room.floor ?? null,
      room_type: room.roomType ?? null,
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
      created_at: room.updatedAt || '',
      updated_at: room.updatedAt || '',
      isFallback: true,
    }));
}
