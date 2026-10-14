import type { TFunction } from "i18next";

/**
 * The native refusal of a write at the offline queue's ceiling
 * (`sync_queue::SYNC_QUEUE_FULL`, offline-week audit 13/10/2026): new sales
 * and changes stop until the till reconnects and sends its backlog.
 */
export const SYNC_QUEUE_FULL_ERROR_CODE = "SYNC_QUEUE_FULL";

/**
 * The native refusal at the ceiling of unresolved sync conflicts
 * (`sync_queue::SYNC_QUEUE_CONFLICTS_FULL`): a manager resolves them first.
 */
export const SYNC_QUEUE_CONFLICTS_FULL_ERROR_CODE = "SYNC_QUEUE_CONFLICTS_FULL";

export type SyncQueueFullErrorCode =
  | typeof SYNC_QUEUE_FULL_ERROR_CODE
  | typeof SYNC_QUEUE_CONFLICTS_FULL_ERROR_CODE;

function errorText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value instanceof Error) {
    return value.message;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of ["message", "error", "reason"]) {
      if (typeof record[key] === "string") {
        return record[key] as string;
      }
    }
  }
  return "";
}

/**
 * Which queue ceiling refused this write, or `null`. The native text may be
 * wrapped by its caller (`enqueue parity sync: SYNC_QUEUE_FULL: …`), so the
 * code is looked for as a whole word anywhere in it.
 */
export function syncQueueFullErrorCode(value: unknown): SyncQueueFullErrorCode | null {
  const text = errorText(value);
  if (/\bSYNC_QUEUE_CONFLICTS_FULL\b/.test(text)) {
    return SYNC_QUEUE_CONFLICTS_FULL_ERROR_CODE;
  }
  if (/\bSYNC_QUEUE_FULL\b/.test(text)) {
    return SYNC_QUEUE_FULL_ERROR_CODE;
  }
  return null;
}

/**
 * The cashier's sentence for a write the full queue refused, in the
 * operator's language; `null` for any other error. It says that nothing
 * already saved is lost and what to do.
 */
export function formatSyncQueueFullMessage(value: unknown, t: TFunction): string | null {
  switch (syncQueueFullErrorCode(value)) {
    case SYNC_QUEUE_CONFLICTS_FULL_ERROR_CODE:
      return String(
        t("sync.capacity.conflictsFull", {
          defaultValue:
            "Too many sync conflicts are waiting for review on this till, so new sales and changes can't be saved. Nothing already saved is lost. Ask a manager to resolve them in Sync health, then try again.",
        }),
      );
    case SYNC_QUEUE_FULL_ERROR_CODE:
      return String(
        t("sync.capacity.full", {
          defaultValue:
            "The offline queue on this till is full, so new sales and changes can't be saved. Nothing already saved is lost. Reconnect this terminal to the internet so the queue can send its backlog, then try again.",
        }),
      );
    default:
      return null;
  }
}
