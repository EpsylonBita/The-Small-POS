import type { TFunction } from 'i18next';

import { formatSetAsidePaymentMessage } from '../../lib/payment-integrity';

/**
 * A card the terminal already approved found its order covered while the
 * customer was paying (a restore or another terminal's payment landed). The
 * money moved, so it was recorded set aside for a manager to give back and is
 * NOT a collection: never retry it, never offer the amount as still due
 * (fix review 30/09/2026, Android 1.0.13 parity).
 */
export class PaymentSetAsideError extends Error {
  readonly paymentSetAside = true;

  constructor(message: string) {
    super(message);
    this.name = 'PaymentSetAsideError';
  }
}

/** Throw the operator's localized sentence when `result` was set aside. */
export function throwIfPaymentSetAside(
  result: unknown,
  t: TFunction,
  formatMoney: (amount: number) => string,
): void {
  const message = formatSetAsidePaymentMessage(result, t, formatMoney);
  if (message) {
    throw new PaymentSetAsideError(message);
  }
}

export function isPaymentSetAsideError(error: unknown): error is PaymentSetAsideError {
  return (
    error instanceof PaymentSetAsideError
    || (typeof error === 'object'
      && error !== null
      && (error as { paymentSetAside?: unknown }).paymentSetAside === true)
  );
}

/** How long the cashier sees the "do not charge again" sentence. */
export const PAYMENT_SET_ASIDE_TOAST_MS = 12000;

/** The Z blocker panel's busy key for one set-aside payment being resolved. */
export function setAsideResolvingKey(paymentId: string): string {
  return `set-aside:${paymentId}`;
}
