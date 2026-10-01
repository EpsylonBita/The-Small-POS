import React, { useEffect, useState } from 'react';
import { Ban, HandCoins, Loader2, Receipt } from 'lucide-react';

import { useI18n } from '../../contexts/i18n-context';
import { formatCurrency } from '../../utils/format';
import { LiquidGlassModal } from '../ui/pos-glass-components';

export interface TableReleaseOwedModalProps {
  isOpen: boolean;
  /** The table's number as the floor shows it. */
  tableLabel: string;
  /** What the table's order still owes. */
  outstandingAmount: number;
  /** Whether the order can be cancelled here (its id is known). */
  canCancel: boolean;
  /**
   * Why the till refuses to cancel the order, known before any reason
   * (founder rule 30/09 and 01/10/2026). `ORDER_PAYMENT_NOT_RECORDED`: it is
   * labelled paid with no payment record here, so it is never collected
   * again nor cancelled; its record is restored or recorded first.
   * `ORDER_HAS_PAYMENTS`: money was taken on it, so it is not cancelled.
   */
  cancelRefusal?: 'ORDER_HAS_PAYMENTS' | 'ORDER_PAYMENT_NOT_RECORDED' | null;
  busy?: boolean;
  onCollect: () => void;
  onKeepOpenTab: () => void;
  onCancelOrder: (reason: string) => void;
  onClose: () => void;
}

/**
 * Releasing a table whose order still owes money (item D1, fix review
 * 30/09/2026). The server frees the table and ends the session but leaves an
 * owing order open, so a release never settles or cancels it. The operator
 * decides: collect the payment, cancel the order explicitly (a reason, then
 * the manager's approval), or keep it as an open tab.
 */
export function TableReleaseOwedModal({
  isOpen,
  tableLabel,
  outstandingAmount,
  canCancel,
  cancelRefusal = null,
  busy = false,
  onCollect,
  onKeepOpenTab,
  onCancelOrder,
  onClose,
}: TableReleaseOwedModalProps) {
  const { t } = useI18n();
  const [askingReason, setAskingReason] = useState(false);
  const [reason, setReason] = useState('');

  useEffect(() => {
    if (!isOpen) {
      setAskingReason(false);
      setReason('');
    }
  }, [isOpen]);

  const trimmedReason = reason.trim();
  const amount = formatCurrency(outstandingAmount);
  // Labelled paid, no payment record here: never collected again (founder
  // rule 30/09 and 01/10/2026), never cancelled before its record is back.
  const paymentNotRecorded = cancelRefusal === 'ORDER_PAYMENT_NOT_RECORDED';

  return (
    <LiquidGlassModal
      isOpen={isOpen}
      onClose={onClose}
      title={
        paymentNotRecorded
          ? t('tableRelease.notRecordedTitle', {
              table: tableLabel,
              defaultValue: 'Table {{table}}: its payment is not recorded',
            })
          : t('tableRelease.owedTitle', {
              table: tableLabel,
              amount,
              defaultValue: 'Table {{table}} still owes {{amount}}',
            })
      }
      size="md"
    >
      <div className="space-y-3" data-testid="table-release-owed">
        <p className="text-sm liquid-glass-modal-text-muted">
          {paymentNotRecorded
            ? t('tableRelease.notRecordedMessage', {
                defaultValue:
                  'Its order is marked paid, but its payment is not recorded on this till. Do not charge it again: restore it from the server with Sync Now, or record the payment from the Z Report.',
              })
            : t('tableRelease.owedMessage', {
                amount,
                defaultValue:
                  'Releasing the table does not settle or cancel its order. Choose what happens to the {{amount}} it owes.',
              })}
        </p>

        {!askingReason ? (
          <div className="grid gap-2">
            {paymentNotRecorded ? null : (
              <button
                type="button"
                disabled={busy}
                onClick={onCollect}
                className="flex min-h-[48px] items-center gap-3 rounded-2xl border border-emerald-400/40 bg-emerald-500/10 px-4 py-3 text-left font-semibold transition active:bg-emerald-500/20 disabled:opacity-60"
              >
                <HandCoins className="h-5 w-5 shrink-0 text-emerald-500" />
                <span>{t('tableRelease.collect', { defaultValue: 'Collect the payment' })}</span>
              </button>
            )}
            <button
              type="button"
              disabled={busy}
              onClick={onKeepOpenTab}
              className="flex min-h-[48px] flex-col items-start gap-1 rounded-2xl border border-amber-400/40 bg-amber-500/10 px-4 py-3 text-left transition active:bg-amber-500/20 disabled:opacity-60"
            >
              <span className="flex items-center gap-3 font-semibold">
                <Receipt className="h-5 w-5 shrink-0 text-amber-500" />
                {t('tableRelease.keepOpenTab', { defaultValue: 'Keep as an open tab' })}
              </span>
              <span className="text-xs liquid-glass-modal-text-muted">
                {paymentNotRecorded
                  ? t('tableRelease.keepOpenNotRecordedHint', {
                      defaultValue:
                        'The table is freed; the order stays as it is until its payment is restored or recorded.',
                    })
                  : t('tableRelease.keepOpenTabHint', {
                      defaultValue:
                        'The table is freed; the order stays open and unpaid until it is collected or cancelled.',
                    })}
              </span>
            </button>
            {cancelRefusal === 'ORDER_HAS_PAYMENTS' ? (
              <p
                data-testid="table-release-cancel-refused"
                className="rounded-2xl border border-red-400/30 bg-red-500/5 px-4 py-3 text-sm liquid-glass-modal-text-muted"
              >
                {t('tableRelease.cancelRefusedPaid', {
                  defaultValue:
                    'Money was taken on this order. Void or refund it from the order first, or collect the rest.',
                })}
              </p>
            ) : canCancel && !cancelRefusal ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => setAskingReason(true)}
                className="flex min-h-[48px] items-center gap-3 rounded-2xl border border-red-400/40 bg-red-500/10 px-4 py-3 text-left font-semibold transition active:bg-red-500/20 disabled:opacity-60"
              >
                <Ban className="h-5 w-5 shrink-0 text-red-500" />
                <span>{t('tableRelease.cancelOrder', { defaultValue: 'Cancel the order' })}</span>
              </button>
            ) : null}
          </div>
        ) : (
          <div className="grid gap-2">
            <label className="text-sm font-semibold" htmlFor="table-release-cancel-reason">
              {t('tableRelease.cancelReasonLabel', { defaultValue: 'Why is the order cancelled?' })}
            </label>
            <textarea
              id="table-release-cancel-reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              rows={3}
              maxLength={300}
              className="w-full rounded-xl border liquid-glass-modal-border bg-transparent p-3 text-sm"
              placeholder={t('tableRelease.cancelReasonPlaceholder', {
                defaultValue: 'For example: the customer left without ordering',
              })}
            />
            <p className="text-xs liquid-glass-modal-text-muted">
              {t('tableRelease.cancelApprovalHint', {
                defaultValue: 'A cashier or manager PIN approves the cancellation. Nothing is charged.',
              })}
            </p>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setAskingReason(false);
                  setReason('');
                }}
                className="min-h-[44px] rounded-2xl border liquid-glass-modal-border px-3 py-2 font-semibold disabled:opacity-60"
              >
                {t('common.actions.back', { defaultValue: 'Back' })}
              </button>
              <button
                type="button"
                disabled={busy || trimmedReason.length === 0}
                onClick={() => onCancelOrder(trimmedReason)}
                className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-2xl border border-red-400/50 bg-red-500/80 px-3 py-2 font-semibold text-white disabled:opacity-60"
              >
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Ban className="h-4 w-4" />}
                {t('tableRelease.confirmCancel', { defaultValue: 'Cancel the order' })}
              </button>
            </div>
          </div>
        )}
      </div>
    </LiquidGlassModal>
  );
}

export default TableReleaseOwedModal;
