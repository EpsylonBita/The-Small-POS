import type {
  PaymentIntegrityErrorPayload,
  UnsettledPaymentBlocker,
} from "./ipc-contracts";

export const UNSETTLED_PAYMENT_BLOCKER_ERROR_CODE =
  "UNSETTLED_PAYMENT_BLOCKER";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}

function normalizeBlockers(value: unknown): UnsettledPaymentBlocker[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((entry): entry is UnsettledPaymentBlocker => {
    if (!isRecord(entry)) {
      return false;
    }

    return (
      typeof entry.orderId === "string" &&
      typeof entry.orderNumber === "string" &&
      typeof entry.reasonCode === "string" &&
      typeof entry.reasonText === "string" &&
      typeof entry.suggestedFix === "string"
    );
  });
}

export function extractPaymentIntegrityPayload(
  value: unknown,
): PaymentIntegrityErrorPayload | null {
  if (!isRecord(value)) {
    return null;
  }

  const blockers = normalizeBlockers(value.blockers);
  const errorCode =
    typeof value.errorCode === "string" ? value.errorCode : undefined;
  const error =
    typeof value.error === "string"
      ? value.error
      : typeof value.message === "string"
        ? value.message
        : undefined;

  if (errorCode === UNSETTLED_PAYMENT_BLOCKER_ERROR_CODE || blockers.length > 0) {
    return {
      errorCode,
      error,
      message: typeof value.message === "string" ? value.message : error,
      blockers,
    };
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

