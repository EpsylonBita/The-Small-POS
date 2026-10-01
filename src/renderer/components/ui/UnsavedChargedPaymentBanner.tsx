import React from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Loader2, RotateCcw } from 'lucide-react';

import type { UnsavedChargedPaymentSummary } from '../../../lib/ipc-adapter';
import { formatCurrency, formatDateTime } from '../../utils/format';
import { isNewOrderCheckoutRecord } from '../../utils/unsavedPayments';

interface UnsavedChargedPaymentBannerProps {
  payments: UnsavedChargedPaymentSummary[];
  onSaveAgain: () => void | Promise<void>;
  isSaving?: boolean;
  className?: string;
}

/**
 * The card payments of this order that were charged on this till and are not
 * saved yet (fix review 30/09/2026, Android 1.0.13 parity). Read from their
 * durable records, so it keeps saying so after a restart. Its one action,
 * "Save payment again", replays the same writes with the same keys: it never
 * charges again. While it shows, the payment surface refuses every new tender.
 * The order dashboard shows it too for a card charged at new-order checkout
 * whose order could not be saved yet (item E): saving it writes the order and
 * its payment with the same keys.
 */
export function UnsavedChargedPaymentBanner({
  payments,
  onSaveAgain,
  isSaving = false,
  className = '',
}: UnsavedChargedPaymentBannerProps) {
  const { t } = useTranslation();
  if (payments.length === 0) {
    return null;
  }
  const total = payments.reduce((sum, entry) => sum + Number(entry.amount || 0), 0);
  const canSaveAgain = payments.some((entry) => entry.canSaveAgain !== false);

  return (
    <div
      data-testid="unsaved-charged-payment-banner"
      role="alert"
      className={`rounded-2xl border border-red-400/40 bg-red-500/10 p-3.5 text-red-900 dark:text-red-100 ${className}`}
    >
      <div className="flex items-start gap-2.5">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="text-sm font-black">
            {t('payment.notSaved.title', { defaultValue: 'Charged, not saved yet' })}
          </div>
          <p className="text-xs font-semibold leading-relaxed opacity-90">
            {t('payment.notSaved.message', {
              amount: formatCurrency(total),
              defaultValue:
                'The card was charged {{amount}}. The payment could not be saved on this till yet. Do NOT charge again: save the payment again.',
            })}
          </p>
          <ul className="space-y-0.5 text-xs font-semibold opacity-80">
            {payments.map((entry) => (
              <li key={entry.idempotencyKey}>
                {isNewOrderCheckoutRecord(entry)
                  ? `${t('payment.notSaved.newOrder', {
                      defaultValue: 'New order, not saved yet',
                    })} · `
                  : ''}
                {formatCurrency(Number(entry.amount || 0))}
                {entry.capturedAt
                  ? ` · ${t('payment.notSaved.chargedAt', {
                      time: formatDateTime(entry.capturedAt),
                      defaultValue: 'charged {{time}}',
                    })}`
                  : ''}
              </li>
            ))}
          </ul>
          {canSaveAgain ? (
            <button
              type="button"
              onClick={() => void onSaveAgain()}
              disabled={isSaving}
              className="mt-1 inline-flex items-center gap-2 rounded-xl border border-red-400/40 bg-red-500/15 px-3 py-2 text-xs font-bold transition active:bg-red-500/25 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isSaving ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RotateCcw className="h-3.5 w-3.5" />
              )}
              {isSaving
                ? t('payment.notSaved.saving', { defaultValue: 'Saving…' })
                : t('payment.notSaved.saveAgain', { defaultValue: 'Save payment again' })}
            </button>
          ) : (
            <p className="text-xs font-bold opacity-90">
              {t('payment.notSaved.cannotSave', {
                amount: formatCurrency(total),
                defaultValue:
                  'The {{amount}} charged cannot be saved on this till. Do NOT charge again. Give the money back to the customer, then a manager confirms it on the Z-report.',
              })}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

export default UnsavedChargedPaymentBanner;
