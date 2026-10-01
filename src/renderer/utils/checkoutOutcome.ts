import type { TFunction } from 'i18next';
import toast from 'react-hot-toast';

/** How long the "no answer yet" notice stays: the cashier must read it. */
const CHECKOUT_OUTCOME_TOAST_MS = 12_000;

/**
 * A checkout whose payment has no answer yet (fix review 30/09/2026): the card
 * terminal is still waiting, or this same checkout is still in progress. The
 * screen keeps the cart and its checkout id; pressing Pay again checks the
 * same payment and never charges twice.
 */
export function isCheckoutOutcomeUnknown(result: unknown): boolean {
  return (result as { outcomeUnknown?: unknown } | null)?.outcomeUnknown === true;
}

/** Tell the cashier, in the store's language, not to start a new payment. */
export function notifyCheckoutOutcomeUnknown(result: unknown, t: TFunction): void {
  const inProgress =
    (result as { errorCode?: unknown } | null)?.errorCode === 'CHECKOUT_IN_PROGRESS';
  const message = inProgress
    ? t('payment.checkoutInProgress', {
        defaultValue:
          'This payment is still in progress on the card terminal. Wait for it to finish, then press Pay again: it checks the same payment and never charges twice.',
      })
    : t('payment.checkoutOutcomeUnknown', {
        defaultValue:
          'The card terminal has not answered yet. Do not start a new payment: wait, then press Pay again. It checks the same payment and never charges twice.',
      });
  toast.error(String(message), {
    id: 'checkout-outcome-unknown',
    duration: CHECKOUT_OUTCOME_TOAST_MS,
  });
}
