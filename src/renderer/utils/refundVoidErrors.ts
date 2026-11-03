import { paymentRefusalMessage } from './paymentRefusalMessage';

/**
 * The till's refusal to refund or void a payment row that records no money:
 * a 1.4.119 placeholder guessed from the order's own label (item D3, round 2
 * review, 01/10/2026). It counts nowhere as money in, so nothing is paid out
 * or taken back against it; the server ledger restore adopts or replaces it.
 */
export const PAYMENT_PLACEHOLDER_NOT_MONEY = 'PAYMENT_PLACEHOLDER_NOT_MONEY';

/**
 * The till's refusal to void or refund a delivery platform's settlement row
 * (shared rule R1, round 3 review 01/10/2026; Android
 * `PLATFORM_SETTLEMENT_NOT_REVERSIBLE`): the platform's money, mirrored from
 * the server, which decides what becomes of it.
 */
export const PLATFORM_SETTLEMENT_NOT_REVERSIBLE = 'PLATFORM_SETTLEMENT_NOT_REVERSIBLE';

type Translate = (key: string, options?: Record<string, unknown>) => unknown;

const REFUND_REFUSALS: Record<string, string> = {
  REFUND_PAYMENT_VOIDED: 'paymentVoided',
  REFUND_PAYMENT_SET_ASIDE: 'paymentSetAside',
  REFUND_AMOUNT_EXCEEDS_BALANCE: 'amountExceedsBalance',
  REFUND_PAYMENT_NOT_FOUND: 'paymentNotFound',
  REFUND_INVALID_REQUEST: 'invalidRequest',
  REFUND_IDEMPOTENCY_CONFLICT: 'idempotencyConflict',
  REFUND_DRIVER_EARNING_REQUIRED: 'driverEarningRequired',
};

const errorText = (error: unknown): string => {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === 'string' ? message : '';
};

/**
 * What the operator is told when a refund or void did not happen: the
 * known refund, placeholder or platform-settlement refusal in their language, otherwise
 * the till's own message, otherwise `fallback`.
 */
export function refundVoidErrorMessage(error: unknown, t: Translate, fallback: string): string {
  const text = errorText(error);
  for (const code of text.match(/[A-Za-z0-9_]+/g) ?? []) {
    const key = Object.prototype.hasOwnProperty.call(REFUND_REFUSALS, code) ? REFUND_REFUSALS[code] : null;
    if (key) return String(t(`modals.refund.refusals.${key}`));
  }
  if (text.includes('PAYMENT_CANONICAL_REFRESH_REQUIRED')) {
    return String(t('modals.refund.canonicalRefreshRequired'));
  }
  if (text.includes('PAYMENT_CANONICAL_RETURN_FINAL')) {
    return String(t('modals.refund.canonicalReturnFinal'));
  }
  if (text.includes(PAYMENT_PLACEHOLDER_NOT_MONEY)) {
    return String(
      t('modals.refund.placeholderNotMoney', {
        defaultValue:
          "This payment row records no money (the till guessed it from the order's label): it cannot be refunded or voided. Restore the order's payments from the server with Sync Now.",
      }),
    );
  }
  if (text.includes(PLATFORM_SETTLEMENT_NOT_REVERSIBLE)) {
    return String(
      t('modals.refund.platformSettlementLocked', {
        defaultValue:
          "The delivery platform's settlement: it is never voided or refunded at the till. The server decides what becomes of it.",
      }),
    );
  }
  return paymentRefusalMessage(error, t) ?? (text || fallback);
}
