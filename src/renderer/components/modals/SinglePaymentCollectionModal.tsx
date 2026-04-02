import React, { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Banknote, CreditCard, Loader2 } from 'lucide-react';
import toast from 'react-hot-toast';

import { getBridge } from '../../../lib';
import { LiquidGlassModal } from '../ui/pos-glass-components';

type PaymentOrigin = 'manual' | 'terminal';

export interface SinglePaymentCollectionResult {
  paymentId: string;
  amount: number;
  method: 'cash' | 'card';
  paymentOrigin: PaymentOrigin;
  transactionRef?: string;
  terminalDeviceId?: string;
}

interface SinglePaymentCollectionModalProps {
  isOpen: boolean;
  onClose: () => void;
  onPaymentCollected: (
    result: SinglePaymentCollectionResult,
  ) => void | Promise<void>;
  orderId: string;
  orderNumber?: string;
  method: 'cash' | 'card';
  outstandingAmount: number;
  settledAmount?: number;
  totalAmount?: number;
}

const round2 = (value: number) => Math.round(value * 100) / 100;

const extractPaymentId = (result: any) =>
  typeof result?.paymentId === 'string'
    ? result.paymentId
    : typeof result?.data?.paymentId === 'string'
      ? result.data.paymentId
      : undefined;

const extractTransactionDetails = (raw: any) => {
  const tx = raw?.transaction ?? raw?.data?.transaction ?? raw?.data ?? raw ?? {};
  return {
    success: raw?.success === true,
    status: String(tx?.status || raw?.status || '').toLowerCase(),
    transactionId:
      tx?.transactionId ?? tx?.id ?? raw?.transactionId ?? raw?.id ?? '',
    errorMessage: tx?.errorMessage ?? raw?.error ?? raw?.data?.error,
  };
};

export const SinglePaymentCollectionModal: React.FC<
  SinglePaymentCollectionModalProps
> = ({
  isOpen,
  onClose,
  onPaymentCollected,
  orderId,
  orderNumber,
  method,
  outstandingAmount,
  settledAmount = 0,
  totalAmount,
}) => {
  const { t } = useTranslation();
  const bridge = getBridge();
  const [isProcessing, setIsProcessing] = useState(false);

  const amountToCollect = useMemo(
    () => round2(Math.max(0, Number(outstandingAmount || 0))),
    [outstandingAmount],
  );

  const resolveReadyTerminal = useCallback(async () => {
    const raw: any = await bridge.ecr.getDefaultTerminal();
    const device = raw?.device ?? raw?.data?.device ?? null;
    const deviceId = typeof device?.id === 'string' ? device.id : '';
    if (!deviceId) return null;
    const status: any = await bridge.ecr.getDeviceStatus(deviceId);
    return status?.connected === true &&
      status?.ready === true &&
      status?.busy !== true
      ? { deviceId, name: device?.name || deviceId }
      : null;
  }, [bridge]);

  const recordCollectedPayment = useCallback(
    async (
      paymentOrigin: PaymentOrigin,
      transactionRef?: string,
      terminalDeviceId?: string,
    ) => {
      const result: any = await bridge.payments.recordPayment({
        orderId,
        method,
        amount: amountToCollect,
        cashReceived: method === 'cash' ? amountToCollect : undefined,
        changeGiven: method === 'cash' ? 0 : undefined,
        transactionRef,
        paymentOrigin,
        terminalApproved: paymentOrigin === 'terminal',
        terminalDeviceId,
      });
      const paymentId = extractPaymentId(result);
      if (result?.success === false || !paymentId) {
        throw new Error(
          result?.error ||
            t('orderDashboard.collectPaymentFailed', {
              defaultValue: 'Failed to record payment.',
            }),
        );
      }

      await onPaymentCollected({
        paymentId,
        amount: amountToCollect,
        method,
        paymentOrigin,
        transactionRef,
        terminalDeviceId,
      });
    },
    [amountToCollect, bridge, method, onPaymentCollected, orderId, t],
  );

  const handleCollect = useCallback(async () => {
    if (isProcessing || amountToCollect <= 0.009) {
      return;
    }

    setIsProcessing(true);
    try {
      if (method === 'card') {
        let terminal: { deviceId: string; name: string } | null = null;
        try {
          terminal = await resolveReadyTerminal();
        } catch (error) {
          console.warn(
            '[SinglePaymentCollectionModal] Failed to resolve terminal:',
            error,
          );
        }

        if (!terminal) {
          toast(
            t('splitPayment.manualCardFallback', {
              defaultValue:
                'No ready payment terminal. Recording a manual card payment instead.',
            }),
          );
          await recordCollectedPayment('manual');
          toast.success(
            t('orderDashboard.cardPaymentRecorded', {
              defaultValue: 'Card payment recorded.',
            }),
          );
          return;
        }

        const rawPayment: any = await bridge.ecr.processPayment(amountToCollect, {
          deviceId: terminal.deviceId,
          orderId,
          reference: `${orderId}:single-payment`,
        });
        const tx = extractTransactionDetails(rawPayment);
        if (!tx.success || tx.status !== 'approved' || !tx.transactionId) {
          throw new Error(
            tx.errorMessage ||
              t('splitPayment.cardFailed', {
                defaultValue: 'Card payment failed',
              }),
          );
        }

        await recordCollectedPayment(
          'terminal',
          tx.transactionId,
          terminal.deviceId,
        );
        toast.success(
          t('orderDashboard.cardPaymentRecorded', {
            defaultValue: 'Card payment recorded.',
          }),
        );
        return;
      }

      await recordCollectedPayment('manual');
      toast.success(
        t('orderDashboard.cashPaymentRecorded', {
          defaultValue: 'Cash payment recorded.',
        }),
      );
    } catch (error) {
      console.error(
        '[SinglePaymentCollectionModal] Failed to collect payment:',
        error,
      );
      toast.error(
        error instanceof Error
          ? error.message
          : t('orderDashboard.collectPaymentFailed', {
              defaultValue: 'Failed to collect payment.',
            }),
      );
    } finally {
      setIsProcessing(false);
    }
  }, [
    amountToCollect,
    bridge.ecr,
    isProcessing,
    method,
    orderId,
    recordCollectedPayment,
    resolveReadyTerminal,
    t,
  ]);

  return (
    <LiquidGlassModal isOpen={isOpen} onClose={onClose} title="">
      <div className="space-y-5 text-white">
        <div className="flex items-start gap-3 rounded-2xl border border-amber-400/20 bg-amber-500/10 p-4">
          <AlertTriangle className="mt-0.5 h-5 w-5 text-amber-300" />
          <div className="space-y-1">
            <p className="text-sm font-semibold uppercase tracking-[0.24em] text-amber-200/90">
              {t('orderDashboard.paymentRequired', {
                defaultValue: 'Payment Required',
              })}
            </p>
            <h3 className="text-lg font-semibold text-white">
              {t('orderDashboard.collectSinglePaymentTitle', {
                defaultValue: 'Collect the missing payment to continue',
              })}
            </h3>
            <p className="text-sm text-white/70">
              {t('orderDashboard.collectSinglePaymentDescription', {
                defaultValue:
                  'This order is blocked because the expected payment was not persisted.',
              })}
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
            <p className="text-xs uppercase tracking-[0.22em] text-white/45">
              {t('orderDashboard.order', { defaultValue: 'Order' })}
            </p>
            <p className="mt-2 text-base font-semibold text-white">
              {orderNumber || orderId}
            </p>
          </div>
          <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
            <p className="text-xs uppercase tracking-[0.22em] text-white/45">
              {t('orderDashboard.outstandingAmount', {
                defaultValue: 'Outstanding',
              })}
            </p>
            <p className="mt-2 text-base font-semibold text-white">
              EUR {amountToCollect.toFixed(2)}
            </p>
          </div>
          <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
            <p className="text-xs uppercase tracking-[0.22em] text-white/45">
              {t('orderDashboard.paymentMethod', {
                defaultValue: 'Payment Method',
              })}
            </p>
            <p className="mt-2 flex items-center gap-2 text-base font-semibold text-white">
              {method === 'card' ? (
                <CreditCard className="h-4 w-4 text-sky-300" />
              ) : (
                <Banknote className="h-4 w-4 text-emerald-300" />
              )}
              {method === 'card'
                ? t('splitPayment.card', 'Card')
                : t('splitPayment.cash', 'Cash')}
            </p>
          </div>
        </div>

        {typeof totalAmount === 'number' ? (
          <div className="rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3 text-sm text-white/65">
            {t('orderDashboard.paymentProgress', {
              defaultValue:
                'Recorded {{settled}} of {{total}}. The remaining amount will be collected now.',
              settled: `EUR ${round2(settledAmount).toFixed(2)}`,
              total: `EUR ${round2(totalAmount).toFixed(2)}`,
            })}
          </div>
        ) : null}

        <div className="flex flex-col gap-3 sm:flex-row">
          <button
            type="button"
            onClick={handleCollect}
            disabled={isProcessing || amountToCollect <= 0.009}
            className="inline-flex flex-1 items-center justify-center gap-2 rounded-2xl border border-emerald-400/20 bg-emerald-500/15 px-4 py-3 text-sm font-semibold text-emerald-100 transition hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isProcessing ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : method === 'card' ? (
              <CreditCard className="h-4 w-4" />
            ) : (
              <Banknote className="h-4 w-4" />
            )}
            {method === 'card'
              ? t('orderDashboard.collectCardNow', {
                  defaultValue: 'Collect card payment',
                })
              : t('orderDashboard.collectCashNow', {
                  defaultValue: 'Collect cash payment',
                })}
          </button>
          <button
            type="button"
            onClick={onClose}
            disabled={isProcessing}
            className="inline-flex items-center justify-center rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-sm font-semibold text-white/80 transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {t('common.cancel', { defaultValue: 'Cancel' })}
          </button>
        </div>
      </div>
    </LiquidGlassModal>
  );
};

export default SinglePaymentCollectionModal;
