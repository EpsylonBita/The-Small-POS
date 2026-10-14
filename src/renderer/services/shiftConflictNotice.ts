/**
 * The cashier's notice for `recovery:shift-conflict`: the server refused a
 * shift this till sent, either because the person's open shift is held
 * elsewhere or because it re-checked a check-in made without a connection
 * and refused it (`OFFLINE_CHECK_IN_CONFLICT`, admin
 * `shifts/sync/offline-check-in.ts`). The shift's row stays failed in Sync
 * for review and holds the Z; nothing here changes it.
 *
 * The native event carries machine codes only (Rust `ShiftConflictNotice`);
 * every word shown comes from the store's language.
 */
import type { TFunction } from 'i18next';

export const SHIFT_CONFLICT_CHANNEL = 'recovery:shift-conflict';

const OFFLINE_REASONS = new Set([
  'waiter_terminal',
  'staff_not_found',
  'active_shift_elsewhere',
  'unresolved_shift',
]);

export interface ShiftConflictNotice {
  shiftId: string;
  code: 'OFFLINE_CHECK_IN_CONFLICT' | 'SHIFT_CONFLICT';
  reason: string | null;
}

/** The notice in a native payload, or null when it is not one. */
export function readShiftConflictNotice(payload: unknown): ShiftConflictNotice | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  const shiftId = typeof record.shiftId === 'string' ? record.shiftId.trim() : '';
  const code = record.code;
  if (!shiftId || (code !== 'OFFLINE_CHECK_IN_CONFLICT' && code !== 'SHIFT_CONFLICT')) return null;
  const reason = typeof record.reason === 'string' && OFFLINE_REASONS.has(record.reason)
    ? record.reason
    : null;
  return { shiftId, code, reason };
}

export function describeShiftConflict(notice: ShiftConflictNotice, t: TFunction): string {
  const review = t(
    'modals.staffShift.syncConflict.review',
    'The shift stays on this till for review in Sync.',
  );
  if (notice.code === 'OFFLINE_CHECK_IN_CONFLICT') {
    const title = t(
      'modals.staffShift.syncConflict.offlineTitle',
      'The server refused a check-in made without a connection',
    );
    const reason = t(`modals.staffShift.syncConflict.reason.${notice.reason ?? 'unknown'}`, {
      defaultValue: 'The server could not confirm this check-in.',
    });
    return `${title}: ${reason} ${review}`;
  }
  return `${t(
    'modals.staffShift.syncConflict.shiftTitle',
    'The server refused a shift',
  )}: ${t(
    'modals.staffShift.syncConflict.shiftBody',
    'the staff member already has another open shift. Close or repair it, then retry it in Sync.',
  )} ${review}`;
}
