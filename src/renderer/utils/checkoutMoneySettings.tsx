import React from 'react';
import type { TFunction } from 'i18next';
import toast from 'react-hot-toast';

/**
 * The store's money settings at checkout (item H, fix review 30/09/2026; the
 * same decision as Android): a read error is not "missing". While the tax
 * rate or the discount cap cannot be read, checkout is paused with a clear
 * message and a retry, and nothing is priced, capped or split on an assumed
 * value. A setting that is truly missing keeps today's default.
 */

/** The till's default tax rate when none is stored (today's default). */
export const DEFAULT_TAX_RATE_PERCENTAGE = 24;

export type CheckoutTaxRate =
  | { available: true; rate: number }
  | { available: false };

export interface TerminalSettingsReader {
  /** False until one read of the local settings succeeded. */
  loaded?: boolean;
  getSetting: <T = unknown>(category: string, key: string, defaultValue?: T) => T | undefined;
}

/**
 * The terminal's tax rate for a checkout: the stored rate, today's default
 * when none is stored, unavailable when the settings could not be read or
 * the stored value is not a rate.
 */
export function resolveCheckoutTaxRate(terminal: TerminalSettingsReader): CheckoutTaxRate {
  if (terminal.loaded === false) {
    return { available: false };
  }
  const raw = terminal.getSetting<number | string | null>('tax', 'tax_rate_percentage', undefined);
  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) {
    return { available: true, rate: DEFAULT_TAX_RATE_PERCENTAGE };
  }
  const rate = Number(raw);
  if (!Number.isFinite(rate) || rate < 0 || rate > 100) {
    return { available: false };
  }
  return { available: true, rate };
}

const PAUSED_TOAST_ID = 'checkout-money-settings-unavailable';

/**
 * Tell the cashier, in the store's language, that checkout is paused because
 * the store's tax rate or discount limit could not be read, with "Try again".
 */
export function notifyMoneySettingsUnavailable(
  t: TFunction,
  retry: () => void | Promise<unknown>,
): void {
  toast.error(
    (current) => (
      <span className="flex flex-col gap-2" data-testid="money-settings-unavailable">
        <span className="font-semibold">
          {t('payment.moneySettings.unavailableTitle', { defaultValue: 'Checkout paused' })}
        </span>
        <span>
          {t('payment.moneySettings.unavailableMessage', {
            defaultValue:
              "The store's tax rate and discount limit could not be read, so nothing is priced on a guess. Try again; if it keeps failing, restart the app.",
          })}
        </span>
        <button
          type="button"
          className="self-start rounded-lg border border-current px-2 py-1 text-xs font-bold"
          onClick={() => {
            toast.dismiss(current.id);
            void retry();
          }}
        >
          {t('payment.moneySettings.retry', { defaultValue: 'Try again' })}
        </button>
      </span>
    ),
    { id: PAUSED_TOAST_ID, duration: 12000 },
  );
}
