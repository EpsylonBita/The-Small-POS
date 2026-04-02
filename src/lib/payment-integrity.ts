import type {
  PaymentIntegrityErrorPayload,
  UnsettledPaymentBlocker,
} from "./ipc-contracts";

export const UNSETTLED_PAYMENT_BLOCKER_ERROR_CODE =
  "UNSETTLED_PAYMENT_BLOCKER";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}

function parseJsonString(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }

  const trimmed = value.trim();
  if (
    trimmed.length < 2 ||
    !(
      (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
      (trimmed.startsWith("[") && trimmed.endsWith("]"))
    )
  ) {
    return value;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  const parsed = parseJsonString(value);
  return isRecord(parsed) ? parsed : null;
}

function firstString(
  record: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }

  return undefined;
}

function firstNumber(
  record: Record<string, unknown>,
  keys: string[],
): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string" && value.trim().length > 0) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }

  return undefined;
}

function collectCandidateRecords(value: unknown): Record<string, unknown>[] {
  const queue: unknown[] = [value];
  const visited = new Set<unknown>();
  const candidates: Record<string, unknown>[] = [];

  while (queue.length > 0 && candidates.length < 12) {
    const current = queue.shift();
    if (current === undefined || current === null) {
      continue;
    }

    if (visited.has(current)) {
      continue;
    }
    visited.add(current);

    const record = asRecord(current);
    if (!record) {
      continue;
    }

    candidates.push(record);
    queue.push(
      record.error,
      record.details,
      record.payload,
      record.data,
      record.cause,
      record.message,
      record.body,
      record.response,
    );
  }

  return candidates;
}

function normalizeBlockers(value: unknown): UnsettledPaymentBlocker[] {
  const parsed = parseJsonString(value);
  if (!Array.isArray(parsed)) {
    return [];
  }

  return parsed
    .map((entry) => {
      const record = asRecord(entry);
      if (!record) {
        return null;
      }

      const orderId = firstString(record, ["orderId", "order_id"]);
      const orderNumber = firstString(record, ["orderNumber", "order_number"]);
      const reasonCode = firstString(record, ["reasonCode", "reason_code"]);
      const reasonText = firstString(record, ["reasonText", "reason_text"]);
      const suggestedFix = firstString(record, [
        "suggestedFix",
        "suggested_fix",
      ]);

      if (
        !orderId ||
        !orderNumber ||
        !reasonCode ||
        !reasonText ||
        !suggestedFix
      ) {
        return null;
      }

      return {
        orderId,
        orderNumber,
        totalAmount:
          firstNumber(record, ["totalAmount", "total_amount"]) ?? 0,
        settledAmount:
          firstNumber(record, ["settledAmount", "settled_amount"]) ?? 0,
        paymentStatus:
          firstString(record, ["paymentStatus", "payment_status"]) ??
          "pending",
        paymentMethod:
          firstString(record, ["paymentMethod", "payment_method"]) ??
          "pending",
        reasonCode,
        reasonText,
        suggestedFix,
      } satisfies UnsettledPaymentBlocker;
    })
    .filter((entry): entry is UnsettledPaymentBlocker => Boolean(entry));
}

export function extractPaymentIntegrityPayload(
  value: unknown,
): PaymentIntegrityErrorPayload | null {
  for (const candidate of collectCandidateRecords(value)) {
    const blockers = normalizeBlockers(candidate.blockers);
    const errorCode = firstString(candidate, ["errorCode", "error_code"]);
    const nestedError = asRecord(candidate.error);
    const error =
      firstString(candidate, ["error", "userMessage"]) ||
      firstString(nestedError ?? {}, ["message", "error", "userMessage"]);
    const message =
      firstString(candidate, ["message", "userMessage"]) || error;

    if (
      errorCode === UNSETTLED_PAYMENT_BLOCKER_ERROR_CODE ||
      blockers.length > 0
    ) {
      return {
        errorCode,
        error,
        message,
        blockers,
      };
    }
  }

  return null;
}

export function summarizeUnsettledPaymentBlockers(
  blockers: UnsettledPaymentBlocker[],
): string {
  if (blockers.length === 0) {
    return "";
  }

  if (blockers.length === 1) {
    const blocker = blockers[0];
    return `${blocker.orderNumber}: ${blocker.reasonText} ${blocker.suggestedFix}`.trim();
  }

  const first = blockers[0];
  return `${blockers.length} orders are blocked. First blocker ${first.orderNumber}: ${first.reasonText}`.trim();
}

export function formatPaymentIntegrityError(
  value: unknown,
  fallback: string,
): string {
  const payload = extractPaymentIntegrityPayload(value);
  if (payload?.error?.trim()) {
    return payload.error.trim();
  }

  if (payload?.blockers?.length) {
    return summarizeUnsettledPaymentBlockers(payload.blockers);
  }

  return fallback;
}
