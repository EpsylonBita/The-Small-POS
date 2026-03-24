import React, { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, RotateCcw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';

import type {
  OrderEditSettlementPreview,
  OrderEditSettlementRefund,
} from '../../../lib/ipc-adapter';
import { LiquidGlassModal } from '../ui/pos-glass-components';
import { RefundAttributionFields } from './RefundAttributionFields';

interface EditOrderRefundSettlementModalProps {
  isOpen: boolean;
  orderNumber?: string;
  preview: OrderEditSettlementPreview | null;
  onConfirm: (refunds: OrderEditSettlementRefund[]) => Promise<void>;
}

interface RefundDraft {
  amount: string;
  reason: string;
  refundMethod: 'cash' | 'card';
  cashHandler: 'cashier_drawer' | 'driver_shift';
}

const round2 = (value: number) => Math.round(value * 100) / 100;

export const EditOrderRefundSettlementModal: React.FC<EditOrderRefundSettlementModalProps> = ({
  isOpen,
  orderNumber,
  preview,
  onConfirm,
}) => {
  const { t } = useTranslation();
  const [drafts, setDrafts] = useState<Record<string, RefundDraft>>({});
  const [isSubmitting, setIsSubmitting] = useState(false);

  const totalRequired = useMemo(() => round2(Math.max(0, (preview?.paidTotal || 0) - (preview?.nextTotal || 0))), [preview]);
  const totalReduced = (preview?.nextTotal || 0) < (preview?.originalTotal || 0) - 0.01;
  const allowDriverCashHandler = preview?.deliverySettlement?.driverCashOwned === true;

  useEffect(() => {
    if (!isOpen || !preview) {
      return;
    }

    const nextDrafts: Record<string, RefundDraft> = {};
    for (const payment of preview.completedPayments) {
      const defaultMethod = String(payment.method || '').toLowerCase() === 'card' ? 'card' : 'cash';
      nextDrafts[payment.id] = {
        amount:
          preview.completedPayments.length === 1
            ? round2(Math.min(totalRequired, payment.remainingRefundable || 0)).toFixed(2)
            : '',
        reason: '',
        refundMethod: defaultMethod,
        cashHandler: allowDriverCashHandler ? 'driver_shift' : 'cashier_drawer',
      };
    }

    setDrafts(nextDrafts);
  }, [allowDriverCashHandler, isOpen, preview, totalRequired]);

  const allocatedTotal = useMemo(() => round2(
    Object.values(drafts).reduce((sum, draft) => sum + (Number.parseFloat(draft.amount) || 0), 0),
  ), [drafts]);
  const remainingAmount = round2(totalRequired - allocatedTotal);

  const setDraft = (
    paymentId: string,
    updater: (current: RefundDraft) => RefundDraft,
  ) => {
    setDrafts((current) => ({
      ...current,
      [paymentId]: updater(
        current[paymentId] || {
          amount: '',
          reason: '',
          refundMethod: 'cash',
          cashHandler: allowDriverCashHandler ? 'driver_shift' : 'cashier_drawer',
        },
      ),
    }));
  };

  const handleFillRemaining = (paymentId: string, maxAmount: number) => {
    const assignedElsewhere = round2(
      Object.entries(drafts)
        .filter(([id]) => id !== paymentId)
        .reduce((sum, [, draft]) => sum + (Number.parseFloat(draft.amount) || 0), 0),
    );
    const nextAmount = round2(Math.min(maxAmount, Math.max(0, totalRequired - assignedElsewhere)));
    setDraft(paymentId, (current) => ({ ...current, amount: nextAmount > 0 ? nextAmount.toFixed(2) : '' }));
  };

  const handleConfirm = async () => {
    if (!preview) {
      return;
    }

    const refunds: OrderEditSettlementRefund[] = [];
    for (const payment of preview.completedPayments) {
      const draft = drafts[payment.id];
      const amount = Number.parseFloat(draft?.amount || '');
      if (!Number.isFinite(amount) || amount <= 0) {
        continue;
      }
      if (amount > (payment.remainingRefundable || 0) + 0.01) {
        toast.error(
          t('modals.refund.exceedsBalance', {
            defaultValue: 'Amount exceeds remaining balance',
          }),
        );
        return;
      }
      if (!draft.reason.trim()) {
        toast.error(
          t('modals.refund.reasonRequired', {
            defaultValue: 'A reason is required',
          }),
        );
        return;
      }

      refunds.push({
        paymentId: payment.id,
        amount,
        reason: draft.reason.trim(),
        refundMethod: draft.refundMethod,
        cashHandler: draft.refundMethod === 'cash' ? draft.cashHandler : undefined,
      });
    }

    if (Math.abs(remainingAmount) > 0.01) {
      toast.error(
        t('modals.refund.editAllocationRequired', {
          defaultValue: 'Refund allocation must match the overpaid amount exactly',
        }),
      );
      return;
    }
    if (refunds.length === 0) {
      toast.error(
        t('modals.refund.selectAllocation', {
          defaultValue: 'Allocate the refund to at least one payment',
        }),
      );
      return;
    }

    setIsSubmitting(true);
    try {
      await onConfirm(refunds);
    } catch (error) {
      const message = error instanceof Error ? error.message : t('modals.refund.refundFailed', { defaultValue: 'Refund failed' });
      toast.error(message);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <LiquidGlassModal
      isOpen={isOpen}
      onClose={() => undefined}
      title={t('modals.refund.editSettlementTitle', { defaultValue: 'Settle Edit Refund' })}
      size="lg"
      className="!max-w-3xl"
      closeOnBackdrop={false}
      closeOnEscape={false}
      footer={(
        <div className="flex items-center justify-between gap-3 border-t border-white/10 pt-4">
          <div className="text-sm liquid-glass-modal-text-muted">
            {t('modals.refund.requiredAmount', { defaultValue: 'Required refund' })}:{' '}
            <span className="font-semibold text-orange-300">&euro;{totalRequired.toFixed(2)}</span>
            {' • '}
            {t('splitPayment.assigned', { defaultValue: 'Assigned' })}:{' '}
            <span className="font-semibold liquid-glass-modal-text">&euro;{allocatedTotal.toFixed(2)}</span>
            {' • '}
            {t('splitPayment.remaining', { defaultValue: 'Remaining' })}:{' '}
            <span className={`font-semibold ${Math.abs(remainingAmount) <= 0.01 ? 'text-emerald-300' : 'text-amber-300'}`}>
              &euro;{remainingAmount.toFixed(2)}
            </span>
          </div>
          <button
            type="button"
            onClick={() => void handleConfirm()}
            disabled={isSubmitting}
            className="rounded-xl border border-orange-500/30 bg-orange-500/15 px-5 py-2.5 text-sm font-semibold text-orange-300 transition-colors hover:bg-orange-500/20 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isSubmitting
              ? t('common.loading', { defaultValue: 'Processing...' })
              : t('modals.refund.confirmRefund', { defaultValue: 'Record Refund' })}
          </button>
        </div>
      )}
    >
      {!preview ? null : (
        <div className="space-y-4">
          <div className="rounded-xl border border-amber-500/20 bg-amber-500/10 p-4">
            <div className="flex items-start gap-3">
              <AlertTriangle className="mt-0.5 h-5 w-5 text-amber-300" />
              <div className="space-y-1">
                <h3 className="text-sm font-semibold text-amber-200">
                  {totalReduced
                    ? t('modals.refund.editSettlementReducedRequired', {
                        defaultValue: 'This edit reduces a paid order and requires a recorded refund',
                      })
                    : t('modals.refund.editSettlementOverpaidRequired', {
                        defaultValue: 'This edit leaves the order overpaid and requires a recorded refund',
                      })}
                </h3>
                <p className="text-sm text-amber-100/80">
                  {orderNumber
                    ? `#${orderNumber} • `
                    : ''}
                  {t('modals.refund.editSettlementHint', {
                    defaultValue: 'Choose exactly how the refunded amount was settled before the order edit can finish.',
                  })}
                </p>
                <p className="text-xs text-amber-100/70">
                  {t('modals.refund.originalVsNext', {
                    defaultValue: 'Order total changed from €{{from}} to €{{to}}',
                    from: preview.originalTotal.toFixed(2),
                    to: preview.nextTotal.toFixed(2),
                  })}
                </p>
                <p className="text-xs text-amber-100/70">
                  {t('modals.refund.netPaidAfterRefunds', {
                    defaultValue: 'Paid after previous refunds: €{{amount}}',
                    amount: preview.paidTotal.toFixed(2),
                  })}
                </p>
              </div>
            </div>
          </div>

          <div className="space-y-3">
            {preview.completedPayments.map((payment) => {
              const draft = drafts[payment.id] || {
                amount: '',
                reason: '',
                refundMethod: 'cash' as const,
                cashHandler: allowDriverCashHandler ? 'driver_shift' as const : 'cashier_drawer' as const,
              };
              const currentAmount = Number.parseFloat(draft.amount || '');
              const hasAmount = Number.isFinite(currentAmount) && currentAmount > 0;

              return (
                <div
                  key={payment.id}
                  className="space-y-3 rounded-xl border border-white/10 bg-white/5 p-4"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="text-sm font-semibold capitalize liquid-glass-modal-text">
                        {payment.method || 'Payment'}
                      </div>
                      <div className="text-xs liquid-glass-modal-text-muted">
                        {t('modals.refund.remaining', { defaultValue: 'Remaining' })}: &euro;{Number(payment.remainingRefundable || 0).toFixed(2)}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleFillRemaining(payment.id, Number(payment.remainingRefundable || 0))}
                      className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-semibold text-white/70 transition-colors hover:bg-white/10"
                    >
                      {t('modals.refund.useRemaining', { defaultValue: 'Use Remaining' })}
                    </button>
                  </div>

                  <div className="grid gap-3 md:grid-cols-[140px,1fr]">
                    <label className="space-y-1">
                      <span className="text-xs font-semibold uppercase tracking-wider liquid-glass-modal-text-muted">
                        {t('modals.refund.amount', { defaultValue: 'Amount' })}
                      </span>
                      <div className="relative">
                        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-white/40">&euro;</span>
                        <input
                          type="number"
                          step="0.01"
                          min="0"
                          max={payment.remainingRefundable || 0}
                          value={draft.amount}
                          onChange={(event) => setDraft(payment.id, (current) => ({ ...current, amount: event.target.value }))}
                          className="w-full rounded-lg border border-white/20 bg-white/10 py-2 pl-7 pr-3 text-sm liquid-glass-modal-text focus:border-orange-400/50 focus:outline-none"
                          placeholder="0.00"
                        />
                      </div>
                    </label>

                    <label className="space-y-1">
                      <span className="text-xs font-semibold uppercase tracking-wider liquid-glass-modal-text-muted">
                        {t('modals.refund.reason', { defaultValue: 'Reason' })}
                      </span>
                      <textarea
                        rows={2}
                        value={draft.reason}
                        onChange={(event) => setDraft(payment.id, (current) => ({ ...current, reason: event.target.value }))}
                        className="w-full rounded-lg border border-white/20 bg-white/10 px-3 py-2 text-sm liquid-glass-modal-text focus:border-orange-400/50 focus:outline-none"
                        placeholder={t('modals.refund.reasonPlaceholder', { defaultValue: 'Enter refund reason...' })}
                      />
                    </label>
                  </div>

                  {hasAmount ? (
                    <RefundAttributionFields
                      refundMethod={draft.refundMethod}
                      onRefundMethodChange={(value) => setDraft(payment.id, (current) => ({ ...current, refundMethod: value }))}
                      cashHandler={draft.cashHandler}
                      onCashHandlerChange={(value) => setDraft(payment.id, (current) => ({ ...current, cashHandler: value }))}
                      allowDriverCashHandler={allowDriverCashHandler}
                      disabled={isSubmitting}
                    />
                  ) : (
                    <div className="rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs liquid-glass-modal-text-muted">
                      <RotateCcw className="mr-2 inline h-3.5 w-3.5" />
                      {t('modals.refund.enterAmountFirst', {
                        defaultValue: 'Enter a refund amount to choose how this payment was settled.',
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </LiquidGlassModal>
  );
};
