import type { TFunction } from "i18next";

import type {
  PaymentIntegrityErrorPayload,
  SyncBlockerDetail,
  UnsettledPaymentBlocker,
} from "./ipc-contracts";

export const UNSETTLED_PAYMENT_BLOCKER_ERROR_CODE =
  "UNSETTLED_PAYMENT_BLOCKER";
export const SYNC_CLOSEOUT_BLOCKED_ERROR_CODE = "SYNC_CLOSEOUT_BLOCKED";

export interface SyncCloseoutBlockedPayload {
  errorCode?: string;
  error?: string;
  message?: string;
  stage?: string;
  stageCode?: string;
  syncItemCount?: number;
  blockersSummary?: string;
  syncBlockerDetails?: SyncBlockerDetail[];
}

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

function normalizeSyncBlockerDetails(value: unknown): SyncBlockerDetail[] {
  const parsed = parseJsonString(value);
  if (!Array.isArray(parsed)) {
    return [];
  }

  const details: SyncBlockerDetail[] = [];
  for (const entry of parsed) {
    const record = asRecord(entry);
    if (!record) {
      continue;
    }

    const queueId = firstNumber(record, ["queueId", "queue_id"]);
    const entityType = firstString(record, ["entityType", "entity_type"]);
    const entityId = firstString(record, ["entityId", "entity_id"]);
    const operation = firstString(record, ["operation"]);
    const queueStatus = firstString(record, ["queueStatus", "queue_status"]);
    const blockerReason = firstString(record, [
      "blockerReason",
      "blocker_reason",
    ]);
    if (
      queueId === undefined ||
      !entityType ||
      !entityId ||
      !operation ||
      !queueStatus ||
      !blockerReason
    ) {
      continue;
    }

    details.push({
      queueId,
      entityType,
      entityId,
      operation,
      queueStatus,
      blockerReason,
      orderId: firstString(record, ["orderId", "order_id"]) ?? null,
      orderNumber: firstString(record, ["orderNumber", "order_number"]) ?? null,
      paymentId: firstString(record, ["paymentId", "payment_id"]) ?? null,
      adjustmentId:
        firstString(record, ["adjustmentId", "adjustment_id"]) ?? null,
      lastError: firstString(record, ["lastError", "last_error"]) ?? null,
    });
  }

  return details;
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

export function extractSyncCloseoutPayload(
  value: unknown,
): SyncCloseoutBlockedPayload | null {
  for (const candidate of collectCandidateRecords(value)) {
    const errorCode = firstString(candidate, ["errorCode", "error_code"]);
    const syncBlockerDetails = normalizeSyncBlockerDetails(
      candidate.syncBlockerDetails ?? candidate.sync_blocker_details,
    );
    if (
      errorCode !== SYNC_CLOSEOUT_BLOCKED_ERROR_CODE &&
      syncBlockerDetails.length === 0
    ) {
      continue;
    }

    const nestedError = asRecord(candidate.error);
    const error =
      firstString(candidate, ["error", "userMessage"]) ||
      firstString(nestedError ?? {}, ["message", "error", "userMessage"]);
    const message =
      firstString(candidate, ["message", "userMessage"]) || error;

    return {
      errorCode,
      error,
      message,
      stage: firstString(candidate, ["stage"]),
      stageCode: firstString(candidate, ["stageCode", "stage_code"]),
      syncItemCount: firstNumber(candidate, ["syncItemCount", "sync_item_count"]),
      blockersSummary:
        firstString(candidate, ["blockersSummary", "blockers_summary"]) ?? "",
      syncBlockerDetails,
    };
  }

  return null;
}

function paymentMethodKey(method: string): string {
  return `paymentIntegrity.methods.${method || "pending"}`;
}

function paymentStatusKey(status: string): string {
  return `paymentIntegrity.statuses.${status || "pending"}`;
}

export function getLocalizedPaymentMethod(
  method: string,
  t: TFunction,
): string {
  return t(paymentMethodKey(method), { defaultValue: method || "pending" });
}

export function getLocalizedPaymentStatus(
  status: string,
  t: TFunction,
): string {
  return t(paymentStatusKey(status), { defaultValue: status || "pending" });
}

export function getLocalizedPaymentBlockerReason(
  blocker: UnsettledPaymentBlocker,
  t: TFunction,
): string {
  return t(`paymentIntegrity.reasonCodes.${blocker.reasonCode}`, {
    defaultValue: blocker.reasonText,
    orderNumber: blocker.orderNumber,
    paymentMethod: getLocalizedPaymentMethod(blocker.paymentMethod, t),
    paymentStatus: getLocalizedPaymentStatus(blocker.paymentStatus, t),
  });
}

export function getLocalizedPaymentBlockerFix(
  blocker: UnsettledPaymentBlocker,
  t: TFunction,
): string {
  return t(`paymentIntegrity.fixCodes.${blocker.reasonCode}`, {
    defaultValue: blocker.suggestedFix,
    orderNumber: blocker.orderNumber,
    paymentMethod: getLocalizedPaymentMethod(blocker.paymentMethod, t),
    paymentStatus: getLocalizedPaymentStatus(blocker.paymentStatus, t),
  });
}

export function summarizeUnsettledPaymentBlockers(
  blockers: UnsettledPaymentBlocker[],
  t?: TFunction,
): string {
  if (blockers.length === 0) {
    return "";
  }

  if (blockers.length === 1) {
    const blocker = blockers[0];
    const reason = t
      ? getLocalizedPaymentBlockerReason(blocker, t)
      : blocker.reasonText;
    const fix = t ? getLocalizedPaymentBlockerFix(blocker, t) : blocker.suggestedFix;
    return `${blocker.orderNumber}: ${reason} ${fix}`.trim();
  }

  const first = blockers[0];
  if (t) {
    return t("paymentIntegrity.multipleOrdersSummary", {
      count: blockers.length,
      orderNumber: first.orderNumber,
      reason: getLocalizedPaymentBlockerReason(first, t),
      defaultValue:
        "{{count}} orders are blocked. First blocker {{orderNumber}}: {{reason}}",
    });
  }

  return `${blockers.length} orders are blocked. First blocker ${first.orderNumber}: ${first.reasonText}`.trim();
}

function closeoutStageLabel(payload: SyncCloseoutBlockedPayload, t: TFunction): string {
  const key = payload.stageCode || payload.stage || "closeout_sync";
  return t(`sync.closeoutStages.${key}`, {
    defaultValue: payload.stage || payload.stageCode || "closeout sync",
  });
}

export function getLocalizedSyncBlockerReason(
  blocker: Pick<SyncBlockerDetail, "blockerReason" | "entityType" | "queueStatus" | "lastError">,
  t: TFunction,
): string {
  return t(`sync.blockerReasons.${blocker.blockerReason}`, {
    defaultValue:
      blocker.lastError || blocker.blockerReason || blocker.queueStatus || blocker.entityType,
  });
}

export function formatSyncCloseoutError(
  value: unknown,
  fallback: string,
  t: TFunction,
): string {
  const payload = extractSyncCloseoutPayload(value);
  if (!payload) {
    return fallback;
  }

  const stage = closeoutStageLabel(payload, t);
  const details = payload.syncBlockerDetails ?? [];
  if (details.length === 1) {
    const blocker = details[0];
    const orderReference =
      blocker.orderNumber || blocker.orderId || blocker.paymentId || blocker.adjustmentId || blocker.entityId;
    return t("sync.closeoutBlocked.single", {
      defaultValue:
        "Cannot close the day during {{stage}} because {{orderReference}} is still blocked: {{reason}}.",
      stage,
      orderReference,
      reason: getLocalizedSyncBlockerReason(blocker, t),
    });
  }

  return t("sync.closeoutBlocked.multiple", {
    defaultValue:
      "Cannot close the day during {{stage}} because {{count}} sync items are still blocked.",
    stage,
    count: payload.syncItemCount ?? details.length,
  });
}

export function formatPaymentIntegrityError(
  value: unknown,
  fallback: string,
  t?: TFunction,
): string {
  const payload = extractPaymentIntegrityPayload(value);
  if (payload?.blockers?.length) {
    return summarizeUnsettledPaymentBlockers(payload.blockers, t);
  }

  if (payload?.error?.trim()) {
    return payload.error.trim();
  }

  return fallback;
}

export function formatOperatorFacingError(
  value: unknown,
  fallback: string,
  t: TFunction,
): string {
  const syncCloseoutMessage = formatSyncCloseoutError(value, "", t);
  if (syncCloseoutMessage.trim()) {
    return syncCloseoutMessage.trim();
  }

  const paymentIntegrityMessage = formatPaymentIntegrityError(value, "", t);
  if (paymentIntegrityMessage.trim()) {
    return paymentIntegrityMessage.trim();
  }

  if (value instanceof Error && value.message.trim()) {
    return value.message;
  }

  if (typeof value === "string" && value.trim()) {
    return value;
  }

  if (value && typeof value === "object") {
    const candidate = value as Record<string, unknown>;
    const directMessage = candidate.message ?? candidate.error ?? candidate.reason;
    if (typeof directMessage === "string" && directMessage.trim()) {
      return directMessage;
    }
  }

  return fallback;
}
