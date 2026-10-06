import { formatCurrency } from '../../utils/format';
import React, { useEffect, useRef, useState } from 'react';
import { roundMoney } from '@shared/utils/money';
import { Banknote, CreditCard, AlertTriangle, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';

import { LiquidGlassModal } from '../ui/pos-glass-components';

/**
 * EditSettlementDeltaModal — minimal cash/card picker used when editing a
 * paid order changes its total.
 *
 * Replaces the former routing of edit-settlement cases through the multi-
 * payer `SplitPaymentModal` (for collect) and the multi-line
 * `EditOrderRefundSettlementModal` (for refund). Both were overkill for the
 * common case of "one operator, one small delta, one payment method" that
 * edits typically produce — and the extra complexity hid a half-commit bug
 * where `order_type` / customer / delivery fields didn't persist through.
 *
 * Scope deliberately narrow: the modal only picks a method. All business
 * logic (which original payment a refund is attributed to, what payload
 * fields to forward, whether the caller falls back to the legacy modals
 * for multi-payment orders) stays in the caller so this component stays
 * testable and reusable.
 */

export type EditSettlementDeltaMode = 'collect' | 'refund';
export type EditSettlementDeltaMethod = 'cash' | 'card';

export interface EditSettlementDeltaModalProps {
  isOpen: boolean;
  mode: EditSettlementDeltaMode;
  /** Absolute delta amount in the store currency. Always positive; the mode distinguishes direction. */
  amount: number;
  /** Display hint — shown in the subtitle if provided. */
  orderNumber?: string | null;
  /**
   * Tenders this terminal may record for the difference (the server's own
   * `method_policy`, read by the native preview). Omitted means both; a
   * disallowed tender is never offered, because the server would refuse it
   * only after the cashier had taken or returned the money.
   */
  allowedMethods?: readonly EditSettlementDeltaMethod[] | null;
  onConfirm: (method: EditSettlementDeltaMethod) => void | Promise<void>;
  onCancel: () => void;
}

// Module audit closure (2026-09-16): one rounding rule for the renderer. The local copy
// rounded on the binary product, so it sent 1.005 to 1.00.
const round2 = (value: number) => roundMoney(value);

export const EditSettlementDeltaModal: React.FC<EditSettlementDeltaModalProps> = ({
  isOpen,
  mode,
  amount,
  orderNumber,
  allowedMethods,
  onConfirm,
  onCancel,
}) => {
  const { t } = useTranslation();
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const permits = (method: EditSettlementDeltaMethod) =>
    !Array.isArray(allowedMethods) || allowedMethods.includes(method);
  const restricted = !permits('cash') || !permits('card');

  // Reset submit state whenever the modal re-opens so a previous in-flight
  // error doesn't leave the buttons disabled forever.
  useEffect(() => {
    if (!isOpen) { setSubmitting(false); submittingRef.current = false; }
  }, [isOpen]);

  const displayAmount = round2(Math.max(0, Number.isFinite(amount) ? amount : 0));
  const isRefund = mode === 'refund';

  const title = isRefund
    ? t('modals.editSettlementDelta.refundTitle', { defaultValue: 'Refund' })
    : t('modals.editSettlementDelta.collectTitle', { defaultValue: 'Extra Payment' });

  const subtitle = isRefund
    ? t('modals.editSettlementDelta.refundBody', {
        defaultValue: 'Return {{amount}} to the customer — choose the method used.',
        amount: formatCurrency(displayAmount),
      })
    : t('modals.editSettlementDelta.collectBody', {
        defaultValue: 'Collect an additional {{amount}} — choose the method used.',
        amount: formatCurrency(displayAmount),
      });

  const handlePick = async (method: EditSettlementDeltaMethod) => {
    if (submittingRef.current || !permits(method)) return;
    submittingRef.current = true;
    setSubmitting(true);
    try {
      await onConfirm(method);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : t('modals.editSettlementDelta.failed', {
              defaultValue: 'Could not complete the settlement',
            });
      toast.error(message);
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  const cashLabel = isRefund
    ? t('modals.editSettlementDelta.refundCash', { defaultValue: 'Refund in Cash' })
    : t('modals.editSettlementDelta.payWithCash', { defaultValue: 'Pay with Cash' });
  const cardLabel = isRefund
    ? t('modals.editSettlementDelta.refundCard', { defaultValue: 'Refund to Card' })
    : t('modals.editSettlementDelta.payWithCard', { defaultValue: 'Pay with Card' });

  return (
    <LiquidGlassModal
      isOpen={isOpen}
      onClose={() => {
        if (submittingRef.current) return;
        onCancel();
      }}
      title={title}
      size="md"
      className="!max-w-md"
      closeOnBackdrop={false}
      closeOnEscape={false}
    >
      <div className="space-y-5 p-1">
        {/* Amount highlight */}
        <div
          className={`rounded-2xl border p-5 text-center ${
            isRefund
              ? 'border-orange-400/30 bg-orange-500/10'
              : 'border-emerald-400/30 bg-emerald-500/10'
          }`}
        >
          <div className="text-xs font-semibold uppercase tracking-wider liquid-glass-modal-text-muted">
            {isRefund
              ? t('modals.editSettlementDelta.refundAmountLabel', { defaultValue: 'Refund amount' })
              : t('modals.editSettlementDelta.collectAmountLabel', { defaultValue: 'Extra to collect' })}
          </div>
          <div
            className={`mt-1 text-4xl font-black tracking-tight ${
              isRefund ? 'text-orange-900 dark:text-orange-200' : 'text-emerald-900 dark:text-emerald-200'
            }`}
          >
            {formatCurrency(displayAmount)}
          </div>
          <div className="mt-2 text-sm liquid-glass-modal-text-muted">
            {orderNumber ? `#${orderNumber} • ${subtitle}` : subtitle}
          </div>
        </div>

        {/* Method buttons */}
        <div className="grid grid-cols-2 gap-3">
          <button
            type="button"
            onClick={() => void handlePick('cash')}
            disabled={submitting || !permits('cash')}
            aria-disabled={submitting || !permits('cash')}
            className={`flex flex-col items-center gap-2 rounded-2xl border px-4 py-5 text-sm font-semibold transition-all disabled:cursor-not-allowed disabled:opacity-60 ${
              isRefund
                ? 'border-orange-400/30 bg-orange-500/10 text-orange-900 dark:text-orange-200 active:border-orange-400/50 active:bg-orange-500/15'
                : 'border-emerald-400/30 bg-emerald-500/10 text-emerald-900 dark:text-emerald-200 active:border-emerald-400/50 active:bg-emerald-500/15'
            }`}
            data-testid="edit-settlement-delta-cash"
          >
            <Banknote className="h-7 w-7" strokeWidth={1.8} />
            <span>{cashLabel}</span>
          </button>

          <button
            type="button"
            onClick={() => void handlePick('card')}
            disabled={submitting || !permits('card')}
            aria-disabled={submitting || !permits('card')}
            className={`flex flex-col items-center gap-2 rounded-2xl border px-4 py-5 text-sm font-semibold transition-all disabled:cursor-not-allowed disabled:opacity-60 ${
              isRefund
                ? 'border-orange-400/30 bg-orange-500/10 text-orange-900 dark:text-orange-200 active:border-orange-400/50 active:bg-orange-500/15'
                : 'border-emerald-400/30 bg-emerald-500/10 text-emerald-900 dark:text-emerald-200 active:border-emerald-400/50 active:bg-emerald-500/15'
            }`}
            data-testid="edit-settlement-delta-card"
          >
            <CreditCard className="h-7 w-7" strokeWidth={1.8} />
            <span>{cardLabel}</span>
          </button>
        </div>

        {/* A tender this terminal may not record is never offered. */}
        {restricted && (
          <div
            role="note"
            data-testid="edit-settlement-delta-method-policy"
            className="flex items-start gap-2 rounded-2xl border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-xs text-amber-900 dark:text-amber-200/90"
          >
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              {!permits('cash')
                ? t('modals.editSettlementDelta.cashDisabled', {
                    defaultValue: 'Cash is turned off for this terminal, so it cannot be recorded here.',
                  })
                : t('modals.editSettlementDelta.cardDisabled', {
                    defaultValue: 'Card is turned off for this terminal, so it cannot be recorded here.',
                  })}
            </span>
          </div>
        )}

        {/* Refund caveat */}
        {isRefund && (
          <div className="flex items-start gap-2 rounded-2xl border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-xs text-amber-900 dark:text-amber-200/90">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              {t('modals.editSettlementDelta.refundNote', {
                defaultValue:
                  'Card refunds are recorded as a ledger adjustment. Process the actual card reversal separately if required.',
              })}
            </span>
          </div>
        )}

        {/* Cancel */}
        <div className="flex justify-end">
          <button
            type="button"
            onClick={() => {
              if (submittingRef.current) return;
              onCancel();
            }}
            disabled={submitting}
            className="liquid-glass-modal-button inline-flex items-center gap-1.5 rounded-2xl px-3 py-1.5 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-60"
          >
            <X className="h-3.5 w-3.5" />
            {t('modals.editSettlementDelta.cancel', { defaultValue: 'Cancel' })}
          </button>
        </div>
      </div>
    </LiquidGlassModal>
  );
};

export default EditSettlementDeltaModal;
