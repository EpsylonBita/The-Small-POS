import React from 'react';
import { Banknote, CreditCard, Truck, Wallet, Wallet2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

/** The tender a refund names (shared rule R5): cash, card, or any other. */
export type RefundTender = 'cash' | 'card' | 'other';

/** Who hands a cash refund back (shared rule R2). */
export type CashRefundHandler = 'cashier_drawer' | 'driver_shift';

/**
 * The tender a refund of a payment names by default (shared rule R5, round 3
 * review 01/10/2026; Android `paymentTenderBucket`): the payment's own, cash,
 * card, or `other` for any other tender (a voucher, a bank transfer). A
 * refund always names its tender and an `other` tender is never guessed as
 * cash.
 */
export const refundRouteForTender = (method: unknown): RefundTender => {
  const tender = String(method ?? '').trim().toLowerCase();
  if (tender === 'cash') return 'cash';
  if (tender === 'card' || tender === 'credit_card' || tender === 'debit_card') return 'card';
  return 'other';
};

/** What the till says about refunding one payment (`refunds.getPaymentBalance`). */
export interface RefundBalanceHints {
  /** The payment's own tender: cash, card or other (R5). */
  defaultRefundMethod?: RefundTender | null;
  /** Who hands a cash refund back by the rule (R2). */
  cashHandlerByRule?: CashRefundHandler;
}

/**
 * What the refund form starts from for one payment (shared rules R2 and R5,
 * round 3 review 01/10/2026): the till's tender when it gave one, else the
 * payment's own, and who hands a cash refund back by the rule (the courier
 * while their earning on the order is still unsettled, else the drawer).
 * The handler is shown, never chosen: the till records it by the rule, as
 * Android does. `null` when the till could not say.
 */
export const refundFormDefaults = (
  payment: { method?: unknown },
  balance: RefundBalanceHints | undefined,
): {
  refundMethod: RefundTender;
  cashHandler: CashRefundHandler | null;
} => ({
  refundMethod: balance?.defaultRefundMethod ?? refundRouteForTender(payment.method),
  cashHandler: balance?.cashHandlerByRule ?? null,
});

export interface RefundAttributionFieldsProps {
  /**
   * The tender the refund names. `null`: none chosen yet; the refund cannot
   * be recorded until one is (R5).
   */
  refundMethod: RefundTender | null;
  onRefundMethodChange: (method: RefundTender) => void;
  /**
   * The payment's own tender is neither cash nor card: its refund may name
   * it (`other`), the default.
   */
  allowOtherTender?: boolean;
  /**
   * Who hands a cash refund back by the rule (R2), shown with a cash refund.
   * Not a choice: the till records the rule's answer whatever is sent.
   */
  cashHandler?: CashRefundHandler | null;
  disabled?: boolean;
}

export const RefundAttributionFields: React.FC<RefundAttributionFieldsProps> = ({
  refundMethod,
  onRefundMethodChange,
  allowOtherTender = false,
  cashHandler = null,
  disabled = false,
}) => {
  const { t } = useTranslation();

  return (
    <div className="space-y-3">
      <div>
        <label className="block text-sm font-medium liquid-glass-modal-text-muted mb-2">
          {t('modals.refund.refundRoute', { defaultValue: 'Refund Route' })}
        </label>
        <div className={`grid gap-2 ${allowOtherTender ? 'grid-cols-3' : 'grid-cols-2'}`}>
          <button
            type="button"
            disabled={disabled}
            aria-pressed={refundMethod === 'cash'}
            onClick={() => onRefundMethodChange('cash')}
            className={`liquid-glass-modal-button justify-center gap-2 text-sm ${
              refundMethod === 'cash'
                ? 'bg-green-600/20 text-green-300 border-green-500/30'
                : ''
            } ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
          >
            <Banknote className="w-4 h-4" />
            {t('modals.refund.cashRefund', { defaultValue: 'Cash Refund' })}
          </button>
          <button
            type="button"
            disabled={disabled}
            aria-pressed={refundMethod === 'card'}
            onClick={() => onRefundMethodChange('card')}
            className={`liquid-glass-modal-button justify-center gap-2 text-sm ${
              refundMethod === 'card'
                ? 'bg-amber-600/20 text-amber-300 border-amber-500/30'
                : ''
            } ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
          >
            <CreditCard className="w-4 h-4" />
            {t('modals.refund.cardRefund', { defaultValue: 'Card Refund' })}
          </button>
          {allowOtherTender && (
            <button
              type="button"
              disabled={disabled}
              aria-pressed={refundMethod === 'other'}
              onClick={() => onRefundMethodChange('other')}
              className={`liquid-glass-modal-button justify-center gap-2 text-sm ${
                refundMethod === 'other'
                  ? 'bg-emerald-600/20 text-emerald-300 border-emerald-500/30'
                  : ''
              } ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
            >
              <Wallet2 className="w-4 h-4" />
              {t('modals.refund.otherRefund', { defaultValue: 'Same tender (other)' })}
            </button>
          )}
        </div>
      </div>

      {refundMethod === 'cash' && cashHandler && (
        <div data-testid="refund-cash-handler">
          <span className="block text-sm font-medium liquid-glass-modal-text-muted mb-2">
            {t('modals.refund.cashReturnedBy', { defaultValue: 'Cash Returned By' })}
          </span>
          <div
            className={`liquid-glass-modal-inset flex items-center justify-center gap-2 rounded-2xl px-3 py-2 text-sm ${
              cashHandler === 'driver_shift'
                ? 'text-emerald-300'
                : 'text-amber-300'
            }`}
          >
            {cashHandler === 'driver_shift' ? (
              <>
                <Truck className="w-4 h-4" />
                {t('modals.refund.driverCash', { defaultValue: 'Driver Cash' })}
              </>
            ) : (
              <>
                <Wallet className="w-4 h-4" />
                {t('modals.refund.cashierCash', { defaultValue: 'Cashier Cash' })}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default RefundAttributionFields;
