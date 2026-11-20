import type { TFunction } from "i18next";
import {
  extractPrivilegedActionError,
  privilegedActionFeedback,
} from "../renderer/utils/privileged-actions";

import { formatFiscalCloseBlockedError } from "./fiscal-closeout";
import { formatUnitShiftsQueueReason } from "./unit-shifts-queue-reason";
import type {
  PaymentIntegrityErrorPayload,
  ReviewPaymentSummary,
  UnsavedPaymentSummary,
  SyncBlockerDetail,
  UnsettledPaymentBlocker,
} from "./ipc-contracts";

export const UNSETTLED_PAYMENT_BLOCKER_ERROR_CODE =
  "UNSETTLED_PAYMENT_BLOCKER";
export const SYNC_CLOSEOUT_BLOCKED_ERROR_CODE = "SYNC_CLOSEOUT_BLOCKED";
/**
 * Sync blocker reason of a payment, refund or other money record of the
 * closing window that has not reached the server (native
 * `zreport::MONEY_NOT_SYNCED_REASON`).
 */
export const MONEY_NOT_SYNCED_BLOCKER_REASON = "money_not_synced";
/**
 * One unresolved payment set aside as a possible duplicate (30/09/2026). The
 * native Z gate and the shared Health contract key on this exact code.
 */
export const PAYMENTS_NEED_REVIEW_REASON_CODE = "payments_need_review";
/**
 * `payment_record` refusal for an approved card that found its order already
 * covered: recorded set aside for a manager to give back, not collected.
 */
export const PAYMENT_SET_ASIDE_ERROR_CODE = "PAYMENT_SET_ASIDE_FOR_REVIEW";
/**
 * One card payment charged on this till whose payment row could not be saved
 * yet (30/09/2026). The Z gate and the shared Health contract key on it.
 */
export const PAYMENTS_NOT_SAVED_REASON_CODE = "payments_not_saved";
/** `payment_record`: the card was charged, the payment is not saved yet. */
export const PAYMENT_NOT_SAVED_ERROR_CODE = "PAYMENT_NOT_SAVED";
/**
 * `payment_record`: a new tender was refused because a charged payment of the
 * order is not saved yet. Nothing was charged.
 */
export const PAYMENT_NOT_SAVED_PENDING_ERROR_CODE = "PAYMENT_NOT_SAVED_PENDING";

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

function normalizeReasonAmounts(
  value: unknown,
): Record<string, number> | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }

  const amounts: Record<string, number> = {};
  for (const [key, raw] of Object.entries(record)) {
    const cents =
      typeof raw === "number"
        ? raw
        : typeof raw === "string" && raw.trim().length > 0
          ? Number(raw)
          : Number.NaN;
    if (Number.isFinite(cents)) {
      amounts[key] = cents;
    }
  }

  return Object.keys(amounts).length > 0 ? amounts : undefined;
}

/**
 * Last-resort money formatting for callers with no renderer formatter to hand.
 * Components pass `formatCurrency`, which follows the operator's locale.
 */
function defaultFormatMoney(amount: number, currency?: string | null): string {
  const safe = Number.isFinite(amount) ? amount : 0;
  return `${safe.toFixed(2)} ${currency || "—"}`;
}

/**
 * The figures a localized blocker sentence may interpolate.
 *
 * The desktop classifier writes its sentences in English and puts the money
 * inside them, which is how a Greek till came to show a Greek operator «The
 * platform settles this order, but EUR 6.50 is recorded as cash/card in the
 * till.» (live, 17/09/2026). The operator-facing sentence is built here from
 * `reasonCode` instead, and these are the values it can name. `reasonText`
 * remains the fallback for a code the locale has not translated.
 */
function blockerInterpolation(
  blocker: UnsettledPaymentBlocker,
  t: TFunction,
  formatMoney: (amount: number) => string,
): Record<string, string> {
  const total = Number(blocker.totalAmount) || 0;
  const settled = Number(blocker.settledAmount) || 0;
  const values: Record<string, string> = {
    orderNumber: blocker.orderNumber,
    paymentMethod: getLocalizedPaymentMethod(blocker.paymentMethod, t),
    paymentStatus: getLocalizedPaymentStatus(blocker.paymentStatus, t),
    totalAmount: formatMoney(total),
    settledAmount: formatMoney(settled),
    outstandingAmount: formatMoney(Math.max(total - settled, 0)),
  };

  // Only the amounts the sentences name; built without a computed property write.
  const reasonAmounts = Object.fromEntries([
    "paymentAmount", "overpaidAmount", "netSettledAmount", "ceilingAmount",
    "drawerAmount", "platformSettledAmount",
  ].flatMap((key): Array<[string, string]> => {
    const cents = blocker.reasonAmounts?.[key];
    return typeof cents === "number" && Number.isFinite(cents)
      ? [[key, formatMoney(cents / 100)]]
      : [];
  }));

  return { ...values, ...reasonAmounts };
}

function normalizeReviewPayment(value: unknown): ReviewPaymentSummary | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  const paymentId = firstString(record, ["paymentId", "payment_id"]);
  if (!paymentId) {
    return undefined;
  }
  const amountCents = firstNumber(record, ["amountCents", "amount_cents"]);
  const amount =
    firstNumber(record, ["amount"]) ??
    (amountCents !== undefined ? amountCents / 100 : 0);
  const detectedAt = firstString(record, ["detectedAt", "detected_at"]);
  return {
    paymentId,
    method: firstString(record, ["method", "paymentMethod"]) ?? "pending",
    amount,
    amountCents: amountCents ?? Math.round(amount * 100),
    currency: firstString(record, ["currency"]) ?? "",
    takenAt: firstString(record, ["takenAt", "taken_at"]) ?? "",
    reason: firstString(record, ["reason"]) ?? "already_paid",
    ...(detectedAt ? { detectedAt } : {}),
  };
}

function normalizeUnsavedPayment(value: unknown): UnsavedPaymentSummary | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  const idempotencyKey = firstString(record, ["idempotencyKey", "idempotency_key"]);
  if (!idempotencyKey) {
    return undefined;
  }
  const amountCents = firstNumber(record, ["amountCents", "amount_cents"]);
  const amount =
    firstNumber(record, ["amount"]) ??
    (amountCents !== undefined ? amountCents / 100 : 0);
  const canSaveAgain = record.canSaveAgain ?? record.can_save_again;
  return {
    idempotencyKey,
    method: firstString(record, ["method", "paymentMethod"]) ?? "card",
    amount,
    amountCents: amountCents ?? Math.round(amount * 100),
    currency: firstString(record, ["currency"]) ?? "",
    capturedAt: firstString(record, ["capturedAt", "captured_at"]) ?? "",
    kind: firstString(record, ["kind"]) ?? "single",
    attempts: firstNumber(record, ["attempts"]) ?? 0,
    canSaveAgain: canSaveAgain !== false,
  };
}

/** Is this the `payments_not_saved` blocker of one charged payment? */
export function isPaymentsNotSavedBlocker(
  blocker: Pick<UnsettledPaymentBlocker, "reasonCode">,
): boolean {
  return blocker.reasonCode === PAYMENTS_NOT_SAVED_REASON_CODE;
}

/** Is this the `payments_need_review` blocker of one set-aside payment? */
export function isPaymentsNeedReviewBlocker(
  blocker: Pick<UnsettledPaymentBlocker, "reasonCode">,
): boolean {
  return blocker.reasonCode === PAYMENTS_NEED_REVIEW_REASON_CODE;
}

/**
 * A stable identity for a blocker: one per order and reason, except
 * `payments_need_review` (one per set-aside payment) and `payments_not_saved`
 * (one per charged payment not saved): an order can hold more than one.
 */
export function paymentBlockerKey(blocker: UnsettledPaymentBlocker): string {
  return `${blocker.orderId}:${blocker.reasonCode}:${blocker.reviewPayment?.paymentId ?? blocker.unsavedPayment?.idempotencyKey ?? ""}`;
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

      const reasonAmounts = normalizeReasonAmounts(
        record.reasonAmounts ?? record.reason_amounts,
      );
      const reasonVariant = firstString(record, [
        "reasonVariant",
        "reason_variant",
      ]);
      const reviewPayment = normalizeReviewPayment(
        record.reviewPayment ?? record.review_payment,
      );
      const unsavedPayment = normalizeUnsavedPayment(
        record.unsavedPayment ?? record.unsaved_payment,
      );
      const severity = firstString(record, ["severity"]);
      const differenceCents = firstNumber(record, [
        "differenceCents",
        "difference_cents",
      ]);

      return {
        orderId,
        orderNumber,
        ...(reasonAmounts ? { reasonAmounts } : {}),
        ...(reasonVariant ? { reasonVariant } : {}),
        ...(reviewPayment ? { reviewPayment } : {}),
        ...(unsavedPayment ? { unsavedPayment } : {}),
        ...(severity === "blocking" || severity === "warning" ? { severity } : {}),
        ...(differenceCents !== undefined ? { differenceCents } : {}),
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

const isLabelCode = (value: string) => /^[a-z0-9_]+$/.test(value);

export function getPaymentBlockerOrderNumber(blocker: UnsettledPaymentBlocker): string {
  const number = blocker.orderNumber;
  return typeof number === "string" && number.trim() && number !== blocker.orderId ? number : "";
}

export function getLocalizedPaymentMethod(
  method: unknown,
  t: TFunction,
  fallback = t("paymentIntegrity.methods.unknown"),
): string {
  const code = typeof method === "string" ? method.trim().toLowerCase() : "";
  if (code === "twint") return "TWINT";
  const key = code === "mixed" ? "split" : code === "room-charge" ? "room_charge" : code;
  return isLabelCode(key) ? t(`paymentIntegrity.methods.${key}`, { defaultValue: fallback }) : fallback;
}

export function getLocalizedPaymentStatus(
  status: unknown,
  t: TFunction,
  fallback = t("paymentIntegrity.statuses.unknown"),
): string {
  const key = typeof status === "string" ? status.trim().toLowerCase() : "";
  return isLabelCode(key) ? t(`paymentIntegrity.statuses.${key}`, { defaultValue: fallback }) : fallback;
}

/**
 * The keys a blocker sentence may live under, most specific first: the variant
 * of a two-shaped reason code, then the code itself.
 */
function blockerSentenceKeys(
  namespace: "reasonCodes" | "fixCodes",
  blocker: UnsettledPaymentBlocker,
): string[] {
  if (!isLabelCode(blocker.reasonCode)) return [];
  const base = `paymentIntegrity.${namespace}.${blocker.reasonCode}`;
  return blocker.reasonVariant && isLabelCode(blocker.reasonVariant)
    ? [`${base}__${blocker.reasonVariant}`, base]
    : [base];
}

function localizeBlockerSentence(
  namespace: "reasonCodes" | "fixCodes",
  blocker: UnsettledPaymentBlocker,
  t: TFunction,
  formatMoney: (amount: number) => string,
  localizedFallback: string | undefined,
  nativeFallback: string,
): string {
  const fallback = localizedFallback ?? nativeFallback;
  const keys = blockerSentenceKeys(namespace, blocker);
  if (keys.length === 0) return fallback;
  const values = blockerInterpolation(blocker, t, formatMoney);
  if (localizedFallback !== undefined) {
    if (!getPaymentBlockerOrderNumber(blocker)) delete values.orderNumber;
    const template = t(keys, { defaultValue: "", skipInterpolation: true });
    if (typeof template !== "string" || !template || [...template.matchAll(/\{\{(\w+)\}\}/g)]
      .some(([, key]) => !Object.prototype.hasOwnProperty.call(values, key))) return fallback;
  }
  return t(keys, { ...values, defaultValue: fallback });
}

export function getLocalizedPaymentBlockerReason(
  blocker: UnsettledPaymentBlocker,
  t: TFunction,
  formatMoney: (amount: number) => string = defaultFormatMoney,
  fallback?: string,
): string {
  if (blocker.unsavedPayment?.method === 'twint' && blocker.unsavedPayment.kind.startsWith('manual_twint_')) return t('twintPayment.receiptRecovery');
  return localizeBlockerSentence("reasonCodes", blocker, t, formatMoney, fallback, blocker.reasonText);
}

export function getLocalizedPaymentBlockerFix(
  blocker: UnsettledPaymentBlocker,
  t: TFunction,
  formatMoney: (amount: number) => string = defaultFormatMoney,
  fallback?: string,
): string {
  if (blocker.unsavedPayment?.method === 'twint' && blocker.unsavedPayment.kind.startsWith('manual_twint_')) return t(blocker.unsavedPayment.canSaveAgain ? 'twintPayment.saveOriginal' : 'twintPayment.receiptReconcile');
  return localizeBlockerSentence("fixCodes", blocker, t, formatMoney, fallback, blocker.suggestedFix);
}

export function summarizeUnsettledPaymentBlockers(
  blockers: UnsettledPaymentBlocker[],
  t?: TFunction,
  localizedFallback?: string,
  formatMoney?: (amount: number) => string,
): string {
  if (blockers.length === 0) {
    return "";
  }

  const first = blockers[0];
  const nativeFallback = localizedFallback === undefined ? undefined : "";
  const orderNumber = localizedFallback === undefined ? first.orderNumber : getPaymentBlockerOrderNumber(first);
  const reason = t
    ? getLocalizedPaymentBlockerReason(first, t, formatMoney, nativeFallback)
    : first.reasonText;
  if (!reason && localizedFallback !== undefined) return localizedFallback;

  if (blockers.length === 1) {
    const fix = t
      ? getLocalizedPaymentBlockerFix(first, t, formatMoney, nativeFallback)
      : first.suggestedFix;
    if (!fix && localizedFallback !== undefined) return localizedFallback;
    return `${orderNumber ? `${orderNumber}: ` : ""}${reason} ${fix}`.trim();
  }

  if (t) {
    if (!orderNumber && localizedFallback !== undefined) {
      return t("paymentIntegrity.multipleOrdersSummaryWithoutNumber", {
        count: blockers.length,
        reason,
        defaultValue: localizedFallback,
      });
    }
    return t("paymentIntegrity.multipleOrdersSummary", {
      count: blockers.length,
      orderNumber,
      reason,
      defaultValue: localizedFallback ??
        "{{count}} orders are blocked. First blocker {{orderNumber}}: {{reason}}",
    });
  }

  return `${blockers.length} orders are blocked. First blocker ${first.orderNumber}: ${reason}`.trim();
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
  // A Z the server holds for open phone shifts: the operator's sentence with
  // the names, never the stored code (review 14/10/2026).
  const heldZ = formatUnitShiftsQueueReason(blocker.blockerReason, t)
    ?? formatUnitShiftsQueueReason(blocker.lastError, t);
  if (heldZ) {
    return heldZ;
  }
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
  // Money this till recorded that has not reached the server holds the day
  // close (06/10/2026: a Z erased a refund that was still unsent). Say it
  // in the operator's terms, with what to do.
  if (
    details.length > 0 &&
    details.every((blocker) => blocker.blockerReason === MONEY_NOT_SYNCED_BLOCKER_REASON)
  ) {
    return t("sync.closeoutBlocked.moneyNotSynced", {
      defaultValue:
        "The day cannot be closed yet: {{count}} payment or refund record(s) of this day have not reached the server. Make sure the till is online, press Sync Now and close the day again.",
      count: payload.syncItemCount ?? details.length,
    });
  }
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

  const approvalMessage = t && privilegedActionFeedback(value, t);
  if (approvalMessage) return approvalMessage;

  if (payload?.error?.trim()) {
    return payload.error.trim();
  }

  return fallback;
}

export function formatZReportLoadFailure(value: unknown, t: TFunction): string {
  const fallback = t("modals.zReport.loadFailed");
  const blockers = extractPaymentIntegrityPayload(value)?.blockers;
  if (blockers?.length) return summarizeUnsettledPaymentBlockers(blockers, t, fallback);
  return privilegedActionFeedback(value, t) ?? fallback;
}

export function formatCashierCloseRefusal(
  value: unknown,
  t: TFunction,
  formatMoney: (amount: number) => string,
): string {
  const fallback = t("modals.staffShift.cashierCloseRefused");
  const blockers = extractPaymentIntegrityPayload(value)?.blockers;
  if (blockers?.length) {
    const summary = summarizeUnsettledPaymentBlockers(blockers, t, "", formatMoney);
    if (summary) return summary;
  }

  // IPC refusals can put the approval code in errorCode rather than code.
  const approvalResult = collectCandidateRecords(value).find((record) =>
    firstString(record, ["errorCode", "error_code"]));
  const approvalValue = approvalResult
    ? { ...approvalResult, code: firstString(approvalResult, ["code", "errorCode", "error_code"]) }
    : value;
  const signIn = privilegedActionFeedback(approvalValue, t) ?? privilegedActionFeedback(value, t);
  if (signIn) return signIn;
  const approval = extractPrivilegedActionError(approvalValue) ?? extractPrivilegedActionError(value);
  switch (approval?.code) {
    case "REAUTH_REQUIRED":
    case "AUTH_PERMISSION_REQUIRED":
    case "NO_APPROVER_IN_STORE":
    case "MANAGER_PIN_REFUSED":
      return t("modals.staffShift.cashierCloseApprovalRequired");
    case "AUTH_GRANT_EXPIRED":
      return t("recovery.actionStatus.grantExpired");
    case "APPROVALS_PAUSED":
      return t("auth.managerApproval.paused", { minutes: approval.minutes ?? 5 });
    default:
      return fallback;
  }
}

// Native stale refusals in src-tauri/src/payments.rs:4617, 4642, 4648.
// The last two can still include blockers for the order that was refused.
const STALE_RECORD_PAYMENT_REASONS = new Set([
  "THIS ORDER NO LONGER HAS A PAYMENT BLOCKER. REFRESH THE PAYMENT BLOCKERS AND TRY AGAIN.",
  "THIS ORDER NO LONGER HAS A COLLECTIBLE OUTSTANDING BALANCE. REFRESH THE PAYMENT BLOCKERS AND TRY AGAIN.",
  "THE OUTSTANDING BALANCE CHANGED SINCE IT WAS CONFIRMED. REFRESH THE PAYMENT BLOCKERS AND TRY AGAIN.",
  "ORDER NOT FOUND",
  "ORDER_NOT_FOUND",
  "PAYMENT_ORDER_NOT_FOUND",
]);

export function formatRecordPaymentFailure(
  value: unknown,
  t: TFunction,
  fallbackKey: "modals.staffShift.paymentRecordFailed" | "modals.zReport.recordPaymentFailed",
  method: 'cash' | 'card',
  orderId?: string,
): string {
  const candidates = collectCandidateRecords(value);
  const reasons = [
    value,
    ...candidates.flatMap(({ code, errorCode, error_code, error, message, reason, details, cause }) =>
      [code, errorCode, error_code, error, message, reason, details, cause]),
  ].flatMap((reason) => typeof reason === 'string' ? [reason.trim().toUpperCase()] : []);
  const staleKey = fallbackKey === 'modals.staffShift.paymentRecordFailed'
    ? 'paymentIntegrity.recordFailureStaleCheckout'
    : 'paymentIntegrity.recordFailureStale';
  if (reasons.some((reason) => STALE_RECORD_PAYMENT_REASONS.has(reason))) return t(staleKey);

  for (const reason of reasons) {
    switch (reason) {
      case "STORE_CURRENCY_UNAVAILABLE":
        return t("paymentIntegrity.recordFailureCurrency");
      case "PAYMENT_CURRENCY_UNAVAILABLE":
      case "ORDER_CURRENCY_UNAVAILABLE":
      case "ORIGINAL_CURRENCY_UNAVAILABLE":
        return t("modals.zReport.recordPaymentOriginalCurrencyMissing");
    }
  }

  const blockerList = candidates.find((candidate) => Array.isArray(parseJsonString(candidate.blockers)))?.blockers;
  const blockers = normalizeBlockers(blockerList);
  // On the Z, a replacement list can omit the order whose button was used.
  if (orderId && blockerList !== undefined && !blockers.some((blocker) => blocker.orderId === orderId)) {
    return t(staleKey);
  }
  if (blockers.length > 0) {
    return summarizeUnsettledPaymentBlockers(blockers.map((blocker) => ({
      ...blocker,
      reasonText: t("paymentIntegrity.blockersHelper"),
      suggestedFix: "",
    })), t);
  }

  const approvalMessage = privilegedActionFeedback(value, t);
  if (approvalMessage) return approvalMessage;

  const approval = extractPrivilegedActionError(value);
  switch (approval?.code) {
    case "REAUTH_REQUIRED":
      return t(approval.approval ? "auth.managerApproval.subtitle" : "modals.zReport.recordApprovalSubtitle");
    case "AUTH_GRANT_EXPIRED":
      return t("recovery.actionStatus.grantExpired");
    case "AUTH_PERMISSION_REQUIRED":
      return t("recovery.actionStatus.permissionRequired");
    case "NO_APPROVER_IN_STORE":
      return t("auth.managerApproval.noApprover", { right: t("auth.managerApproval.rights.voidPayments") });
    case "APPROVALS_PAUSED":
      return t("auth.managerApproval.paused", { minutes: approval.minutes ?? 5 });
    case "MANAGER_PIN_REFUSED":
      return t("auth.managerApproval.pinRefused", { right: t("auth.managerApproval.rights.voidPayments") });
  }

  return t(fallbackKey, {
    button: t(method === 'cash' ? 'modals.zReport.resolveBlockerCash' : 'modals.zReport.resolveBlockerCard'),
    defaultValue: 'The payment was not recorded. Press "{{button}}" again.',
  });
}

/**
 * The cashier's sentence for money that moved but was recorded set aside
 * (`PAYMENT_SET_ASIDE_FOR_REVIEW`), in the operator's language; `null` for
 * any other answer. The payment is not a collection: never retry it.
 */
export function formatSetAsidePaymentMessage(
  value: unknown,
  t: TFunction,
  formatMoney: (amount: number, currency?: string | null) => string = defaultFormatMoney,
): string | null {
  for (const candidate of collectCandidateRecords(value)) {
    if (firstString(candidate, ["errorCode", "error_code"]) !== PAYMENT_SET_ASIDE_ERROR_CODE) {
      continue;
    }
    const currency = firstString(candidate, ["currency"]) ?? firstString(asRecord(candidate.reviewPayment) || {}, ["currency"]) ?? null;
    const amount = firstNumber(candidate, ["amount"]) ?? 0;
    const due = firstNumber(candidate, ["amountDue", "amount_due"]) ?? 0;
    const reason = firstString(candidate, ["reason"]);
    if (reason === "exceeds_amount_due") {
      return t("payment.setAside.exceedsMessage", {
        amount: formatMoney(amount, currency),
        due: formatMoney(due, currency),
        defaultValue:
          "Only {{due}} was still due on this order. The {{amount}} just taken is recorded for a manager to give back and is not counted. Collect only what is due.",
      });
    }
    return t("payment.setAside.message", {
      amount: formatMoney(amount, currency),
      defaultValue:
        "This order was already paid. The {{amount}} just taken is recorded for a manager to give back and is not counted. Do not charge it again.",
    });
  }
  return null;
}

/** The native Z refusal of a till that cannot reach the server (commands/analytics.rs). */
export const Z_REPORT_OFFLINE_ERROR_CODE = "Z_REPORT_OFFLINE";

/**
 * The cashier's sentence for a Z refused because the till is offline
 * (`Z_REPORT_OFFLINE`, offline audit 07/10/2026), in the operator's language;
 * `null` for any other answer. It says what still works and what to do.
 */
export function formatZReportOfflineMessage(value: unknown, t: TFunction): string | null {
  for (const candidate of collectCandidateRecords(value)) {
    if (firstString(candidate, ["errorCode", "error_code"]) !== Z_REPORT_OFFLINE_ERROR_CODE) {
      continue;
    }
    return t("zReportOffline.refusal", {
      defaultValue:
        "The day can't be closed without a connection. Keep selling: the day stays open and you close it once the connection is back. To count the drawer now, use the cashier checkout, which prints without internet, and the preview on this screen.",
    });
  }
  return null;
}

/**
 * The cashier's sentence for a card charged but not saved
 * (`PAYMENT_NOT_SAVED`), or for a tender refused because one is not saved
 * (`PAYMENT_NOT_SAVED_PENDING`), in the operator's language; `null` for any
 * other answer. Never the generic failure: it says not to charge again.
 */
export function formatPaymentNotSavedMessage(
  value: unknown,
  t: TFunction,
  formatMoney: (amount: number, currency?: string | null) => string = defaultFormatMoney,
): string | null {
  for (const candidate of collectCandidateRecords(value)) {
    const code = firstString(candidate, ["errorCode", "error_code"]);
    if (code !== PAYMENT_NOT_SAVED_ERROR_CODE && code !== PAYMENT_NOT_SAVED_PENDING_ERROR_CODE) {
      continue;
    }
    if (candidate.manualReceiptConfirmed === true || candidate.method === 'twint') {
      if (candidate.manualReceiptConfirmed === false && candidate.method === 'twint') return t('twintPayment.receiptReconcile');
      return t('twintPayment.receiptRecovery', 'A TWINT receipt is confirmed but its payment is not saved. Save the original receipt before taking another payment.');
    }
    const currency = firstString(candidate, ["currency"]) ?? firstString(asRecord(candidate.unsavedPayment) || {}, ["currency"]) ?? null;
    const cents = firstNumber(candidate, ["amountCents", "amount_cents"]);
    const amount =
      cents !== undefined ? cents / 100 : (firstNumber(candidate, ["amount"]) ?? 0);
    if (code === PAYMENT_NOT_SAVED_PENDING_ERROR_CODE) {
      return t("payment.notSaved.pendingMessage", {
        amount: formatMoney(amount, currency),
        defaultValue:
          "A card payment of {{amount}} on this order was charged but is not saved on this till yet. Save it again before taking another payment. Do NOT charge again.",
      });
    }
    return t("payment.notSaved.message", {
      amount: formatMoney(amount, currency),
      defaultValue:
        "The card was charged {{amount}}. The payment could not be saved on this till yet. Do NOT charge again: save the payment again.",
    });
  }
  return null;
}

export function formatOperatorFacingError(
  value: unknown,
  fallback: string,
  t: TFunction,
): string {
  // A Z refused because the till is offline (07/10/2026): what still works
  // and what to do, never the native "pre-Z-report sync failed" text.
  const zReportOfflineMessage = formatZReportOfflineMessage(value, t);
  if (zReportOfflineMessage?.trim()) {
    return zReportOfflineMessage.trim();
  }

  // A card charged but not saved (30/09/2026): never the generic failure.
  const notSavedMessage = formatPaymentNotSavedMessage(value, t);
  if (notSavedMessage?.trim()) {
    return notSavedMessage.trim();
  }

  // Money that moved but was recorded set aside (30/09/2026): the cashier
  // reads it in the store's language, never the native English fallback.
  const setAsideMessage = formatSetAsidePaymentMessage(value, t);
  if (setAsideMessage?.trim()) {
    return setAsideMessage.trim();
  }

  // The Z close-day guard's typed fiscal refusal (29/09/2026): localized from
  // its code and parameters, never shown as the native English fallback.
  const fiscalCloseMessage = formatFiscalCloseBlockedError(value, t);
  if (fiscalCloseMessage?.trim()) {
    return fiscalCloseMessage.trim();
  }

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
