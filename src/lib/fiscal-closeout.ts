import type { TFunction } from "i18next";

/**
 * The Z close-day guard's typed refusal (native
 * `fiscal::close_day_guard::FISCAL_CLOSE_BLOCKED_ERROR_CODE`).
 *
 * Field incident 29/09/2026 (Le Petit Paris): a Z was refused over queued
 * fiscal receipts with an English-only sentence built in native code. The
 * refusal now carries a code and parameters; the operator reads it in the
 * store's configured language (`modals.zReport.fiscalCloseBlocked`), never
 * the native English fallback. Detection is by code, never by message text,
 * so a translation can never switch the guard off.
 */
export const FISCAL_CLOSE_BLOCKED_ERROR_CODE = "FISCAL_CLOSE_BLOCKED";

/**
 * `reason` of a refusal because the fiscal queue could not be read (native
 * `fiscal::close_day_guard::FISCAL_QUEUE_UNREADABLE_REASON`). Review of the
 * 29/09/2026 fixes: the guard used to answer "nothing queued" on a read
 * error and let the day close; it now holds the close, and the operator is
 * told the submissions could not be checked, not that "0" are unsent.
 */
export const FISCAL_QUEUE_UNREADABLE_REASON = "fiscal_queue_unreadable";

export interface FiscalCloseBlockedPayload {
  count: number;
  /** The report's business day, `YYYY-MM-DD`, when the refusal names one. */
  businessDay: string | null;
  /** `active` | `inactive` | `unknown` — the verdict the guard applied. */
  activeVerdict: string | null;
  /** `fiscal_queue_not_empty` | `fiscal_queue_unreadable`, when named. */
  reason: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseJsonRecord(value: string): Record<string, unknown> | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Every record a refusal may be wrapped in: the value, `error`, `data`. */
function candidateRecords(value: unknown): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];
  const visit = (candidate: unknown, depth: number) => {
    if (depth > 3 || candidate === null || candidate === undefined) {
      return;
    }
    if (typeof candidate === "string") {
      const parsed = parseJsonRecord(candidate);
      if (parsed) {
        visit(parsed, depth + 1);
      }
      return;
    }
    if (candidate instanceof Error) {
      visit(candidate.message, depth + 1);
      return;
    }
    if (!isRecord(candidate)) {
      return;
    }
    records.push(candidate);
    visit(candidate.error, depth + 1);
    visit(candidate.data, depth + 1);
    visit(candidate.message, depth + 1);
  };
  visit(value, 0);
  return records;
}

function isFiscalCloseBlockedRecord(record: Record<string, unknown>): boolean {
  const errorCode = record.errorCode ?? record.error_code;
  return (
    errorCode === FISCAL_CLOSE_BLOCKED_ERROR_CODE ||
    record.code === "fiscal_close_blocked"
  );
}

/** The typed fiscal refusal inside a submit response or error, if any. */
export function extractFiscalCloseBlockedPayload(
  value: unknown,
): FiscalCloseBlockedPayload | null {
  const record = candidateRecords(value).find(isFiscalCloseBlockedRecord);
  if (!record) {
    return null;
  }
  const count = Number(record.count);
  const businessDay =
    typeof record.businessDay === "string" && record.businessDay.trim()
      ? record.businessDay.trim()
      : null;
  const activeVerdict =
    typeof record.activeVerdict === "string" ? record.activeVerdict : null;
  const reason =
    typeof record.reason === "string" && record.reason.trim()
      ? record.reason.trim()
      : null;
  return {
    count: Number.isFinite(count) && count > 0 ? Math.trunc(count) : 0,
    businessDay,
    activeVerdict,
    reason,
  };
}

/**
 * The localized sentence for a fiscal refusal, or `null` when `value` is not
 * one. `formatBusinessDay` renders the report day the way the screen shows
 * dates; by default the ISO day is used as is.
 */
export function formatFiscalCloseBlockedError(
  value: unknown,
  t: TFunction,
  formatBusinessDay: (isoDay: string) => string = (isoDay) => isoDay,
): string | null {
  const payload = extractFiscalCloseBlockedPayload(value);
  if (!payload) {
    return null;
  }
  const date = payload.businessDay ? formatBusinessDay(payload.businessDay) : "";
  if (payload.reason === FISCAL_QUEUE_UNREADABLE_REASON) {
    return String(
      t(
        date
          ? "modals.zReport.fiscalCloseCheckFailed"
          : "modals.zReport.fiscalCloseCheckFailedNoDate",
        {
          date,
          defaultValue: date
            ? "The day cannot be closed yet: the fiscal submissions of {{date}} could not be checked. You can keep selling; try again in a moment, and if it keeps failing, export diagnostics for support."
            : "The day cannot be closed yet: the fiscal submissions could not be checked. You can keep selling; try again in a moment, and if it keeps failing, export diagnostics for support.",
        },
      ),
    );
  }
  return String(
    t(
      date
        ? "modals.zReport.fiscalCloseBlocked"
        : "modals.zReport.fiscalCloseBlockedNoDate",
      {
        count: payload.count,
        date,
        defaultValue: date
          ? "The day cannot be closed yet: {{count}} fiscal submission(s) of {{date}} have not been sent. You can keep selling; keep the terminal online and send them again from this report."
          : "The day cannot be closed yet: {{count}} fiscal submission(s) have not been sent. You can keep selling; keep the terminal online and send them again from this report.",
      },
    ),
  );
}
