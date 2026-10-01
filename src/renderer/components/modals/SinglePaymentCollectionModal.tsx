import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { roundMoney } from '@shared/utils/money';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Banknote, CreditCard, Loader2 } from 'lucide-react';
import toast from 'react-hot-toast';

import { getBridge } from '../../../lib';
import { formatCurrency } from '../../utils/format';
import {
  isPaymentSetAsideError,
  PAYMENT_SET_ASIDE_TOAST_MS,
  throwIfPaymentSetAside,
} from '../../utils/paymentSetAside';
import {
  isPaymentNotSavedError,
  notifyPaymentNotSaved,
  PAYMENT_NOT_SAVED_TOAST_MS,
  pendingNotSavedMessage,
  throwIfPaymentNotSaved,
  useUnsavedChargedPayments,
} from '../../utils/unsavedPayments';
import {
  formatPaymentNotSavedMessage,
  formatSetAsidePaymentMessage,
} from '../../../lib/payment-integrity';
import {
  claimOrdinaryCollectionOwner,
  classifyOrdinaryTerminalReply,
  classifyOrdinaryWrite,
  noteOrdinaryTerminalTransaction,
  noteOrdinaryWriteFacts,
  ordinaryCollectionView,
  probeOrdinaryOwner,
  readOrdinaryWriteReply,
  releaseOrdinaryOwnerBeforeSend,
  retainedOrdinaryOwner,
  runOrdinaryCollection,
  type OrdinaryCollectionOwner,
  type OrdinaryCollectionScope,
  type OrdinaryCollectionVerdict,
} from '../../hooks/useOrderStore';
import { loadPersistedSplitDismissal } from '../../utils/splitCheckoutRecovery';
import { LiquidGlassModal } from '../ui/pos-glass-components';
import { UnsavedChargedPaymentBanner } from '../ui/UnsavedChargedPaymentBanner';
import {
  PlatformHeldPaymentNotice,
  usePlatformHeldNoticeForOrderId,
} from '../ui/PlatformHeldPaymentNotice';

type PaymentOrigin = 'manual' | 'terminal';

/** What one guarded collect sent and learned; never card data. */
type GuardedCollection = {
  paymentId: string | null;
  paymentOrigin: PaymentOrigin;
  transactionRef?: string;
  terminalDeviceId?: string;
  message: string | null;
  /**
   * The native answer was a charged payment not saved (or a tender refused
   * because one is not), or money set aside for review (30/09/2026): never a
   * collection and never a generic failure.
   */
  notice?: { kind: 'not_saved' | 'set_aside'; message: string };
};

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
  /**
   * Existing-order ordinary collection scope of this terminal. When set (null
   * fails closed) every collect runs under the order's ordinary claim.
   */
  collectionScope?: OrdinaryCollectionScope | null;
}

// Module audit closure (2026-09-16): one rounding rule for the renderer. The local copy
// rounded on the binary product, so it sent 1.005 to 1.00.
const round2 = (value: number) => roundMoney(value);

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
  collectionScope,
}) => {
  const { t } = useTranslation();
  const bridge = getBridge();
  const [isProcessing, setIsProcessing] = useState(false);
  const viewEpoch = useRef(0);
  useEffect(() => {
    const epoch = ++viewEpoch.current;
    return () => { if (viewEpoch.current === epoch) viewEpoch.current++; };
  }, [isOpen, orderId, collectionScope?.organizationId, collectionScope?.terminalId]);

  const amountToCollect = useMemo(
    () => round2(Math.max(0, Number(outstandingAmount || 0))),
    [outstandingAmount],
  );
  // Card money of this order charged on this till and not saved yet (fix
  // review 30/09/2026): shown with "Save payment again", and no new charge
  // starts while it stands. Saved again, the collection is done.
  // Saved again, the charged card's own row is in the ledger: the order's
  // retained ordinary claim (its reply was "not saved") settles from it now.
  const onUnsavedSaved = useCallback(async () => {
    const retained = collectionScope === undefined ? null : retainedOrdinaryOwner(collectionScope, orderId);
    if (retained) {
      await probeOrdinaryOwner(retained, async () => {
        const settlement = await loadPersistedSplitDismissal(
          bridge,
          orderId,
          Number(totalAmount ?? amountToCollect),
        );
        return { completedPayments: settlement.completedPayments, value: settlement };
      }).catch(() => undefined);
    }
    onClose();
  }, [amountToCollect, bridge, collectionScope, onClose, orderId, totalAmount]);
  const unsaved = useUnsavedChargedPayments(orderId, isOpen, t, formatCurrency, onUnsavedSaved);
  const unsavedLocked = unsaved.payments.length > 0;

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
      // A card charged but not saved: kept, with Save payment again. Never
      // a generic failure that invites a second charge.
      throwIfPaymentNotSaved(result, t, formatCurrency);
      // An approved card that found the order already paid is recorded set
      // aside, not collected: say so and never treat it as a collection.
      throwIfPaymentSetAside(result, t, formatCurrency);
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
      // Read fresh: a charged payment of this order not saved yet (here, or
      // on another payment surface) refuses every new tender, before any
      // terminal is asked to charge.
      const pending = await unsaved.refresh();
      if (pending.length > 0) {
        toast.error(pendingNotSavedMessage(pending, t, formatCurrency), {
          duration: PAYMENT_NOT_SAVED_TOAST_MS,
        });
        return;
      }
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
      if (isPaymentNotSavedError(error)) {
        // The card was charged; its record stays and the banner offers Save
        // payment again. Collect stays disabled: nothing may charge again.
        toast.error(error.message, { duration: PAYMENT_NOT_SAVED_TOAST_MS });
        await unsaved.refresh();
        return;
      }
      if (isPaymentSetAsideError(error)) {
        // The money is recorded for a manager to give back; nothing is left
        // to collect here, so the cashier must not be invited to charge again.
        toast.error(error.message, { duration: PAYMENT_SET_ASIDE_TOAST_MS });
        onClose();
        return;
      }
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
    onClose,
    orderId,
    recordCollectedPayment,
    resolveReadyTerminal,
    t,
    unsaved,
  ]);

  // Existing-order guard. With a collection scope, each collect takes the
  // order's ordinary claim before its first await, preflights it right before
  // the send, and only the original operation's own outcome settles it.
  const ordinaryRefusalText = useCallback(
    (code: string) =>
      code === 'GIFT_CARD_TERMINAL_SCOPE_REQUIRED'
        ? t(
            'giftCardCheckout.refusal.scope',
            'This terminal has no confirmed organization or terminal identity. Pair the POS again.',
          )
        : t('giftCardCheckout.refusal.admission', 'Earlier gift card attempts must be checked first.'),
    [t],
  );

  // A retained unknown collection is continued, never repeated: only its exact
  // original row in the canonical ledger settles it, and nothing is written.
  const probeRetainedCollection = useCallback(
    async (owner: OrdinaryCollectionOwner, isCurrent: () => boolean) => {
      const probe = await probeOrdinaryOwner(owner, async () => {
        const settlement = await loadPersistedSplitDismissal(
          bridge,
          orderId,
          Number(totalAmount ?? amountToCollect),
        );
        return { completedPayments: settlement.completedPayments, value: settlement };
      });
      if (probe.status !== 'completed' || !isCurrent()) return;
      toast.success(
        method === 'card'
          ? t('orderDashboard.cardPaymentRecorded', { defaultValue: 'Card payment recorded.' })
          : t('orderDashboard.cashPaymentRecorded', { defaultValue: 'Cash payment recorded.' }),
      );
      onClose();
    },
    [amountToCollect, bridge, method, onClose, orderId, t, totalAmount],
  );

  const handleGuardedCollect = useCallback(async () => {
    if (isProcessing || amountToCollect <= 0.009) {
      return;
    }
    const startedEpoch = viewEpoch.current;
    const isCurrent = () => isOpen && viewEpoch.current === startedEpoch;
    const claim = claimOrdinaryCollectionOwner(collectionScope, orderId);
    if (!claim.claimed) {
      toast.error(ordinaryRefusalText(claim.code));
      if (claim.retained) {
        // The original direct SALE may have reached the terminal before its
        // local card row failed. Book only that saved approval, never resend.
        if (method === 'card') {
          try {
            const sale = (await bridge.payments.getSettlementSnapshot(orderId)).unresolvedDirectSale;
            const original = ordinaryCollectionView(claim.retained)?.original;
            if (isCurrent() && sale?.recoverable && sale.id && sale.deviceId && sale.currency?.toUpperCase() === 'EUR'
              && sale.amountCents === Math.round(amountToCollect * 100)
              && original?.method === 'card' && Math.round(original.amount * 100) === sale.amountCents
              && (!original.terminalTransactionId || original.terminalTransactionId === sale.id)) {
              noteOrdinaryTerminalTransaction(claim.retained, sale.id);
              // The same write, key and identity as the original and as its
              // "Save payment again" record (`terminal-card:<sale id>`).
              const recovered = await bridge.payments.recordPayment({
                orderId, method: 'card', amount: sale.amountCents / 100,
                currency: sale.currency, transactionRef: sale.id,
                paymentOrigin: 'terminal', terminalApproved: true, terminalDeviceId: sale.deviceId,
              });
              if (isCurrent() && !notifyPaymentNotSaved(recovered, t)) {
                const setAsideMessage = formatSetAsidePaymentMessage(recovered, t, formatCurrency);
                if (setAsideMessage) toast.error(setAsideMessage, { duration: PAYMENT_SET_ASIDE_TOAST_MS });
              }
            }
          } catch (error) {
            console.warn('[SinglePaymentCollectionModal] Original SALE recovery remains pending:', error);
          }
        }
        void unsaved.refresh();
        void probeRetainedCollection(claim.retained, isCurrent).catch(() => undefined);
      }
      return;
    }
    const owner = claim.owner;

    setIsProcessing(true);
    try {
      // Read fresh: a charged payment of this order not saved yet (here, or
      // on another payment surface) refuses every new tender, before any
      // terminal is asked to charge. Nothing is sent; the claim ends below.
      const pending = await unsaved.refresh();
      if (!isCurrent()) return;
      if (pending.length > 0) {
        toast.error(pendingNotSavedMessage(pending, t, formatCurrency), {
          duration: PAYMENT_NOT_SAVED_TOAST_MS,
        });
        return;
      }
      const sale = (await bridge.payments.getSettlementSnapshot(orderId)).unresolvedDirectSale;
      if (!isCurrent()) return;
      if (sale && (!sale.recoverable || method !== 'card' || !sale.id || !sale.deviceId
        || sale.currency?.toUpperCase() !== 'EUR'
        || sale.amountCents !== Math.round(amountToCollect * 100))) {
        toast.error(ordinaryRefusalText('DIRECT_SALE_RECONCILIATION_REQUIRED'));
        return;
      }
      let terminal: { deviceId: string; name: string } | null = null;
      if (method === 'card' && !sale) {
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
        }
      }

      const writeCollected = async (
        paymentOrigin: PaymentOrigin,
        transactionRef?: string,
        terminalDeviceId?: string,
      ): Promise<{ verdict: OrdinaryCollectionVerdict; value: GuardedCollection }> => {
        let raw: unknown;
        let threw = false;
        try {
          if (!isCurrent()) throw new Error('The collection view changed before payment recording');
          raw = await bridge.payments.recordPayment({
            orderId,
            method,
            amount: amountToCollect,
            cashReceived: method === 'cash' ? amountToCollect : undefined,
            changeGiven: method === 'cash' ? 0 : undefined,
            transactionRef,
            paymentOrigin,
            terminalApproved: paymentOrigin === 'terminal',
            terminalDeviceId,
            ...(sale?.recoverable ? { currency: sale.currency } : {}),
          });
        } catch {
          threw = true;
        }
        const facts = readOrdinaryWriteReply(raw, threw);
        noteOrdinaryWriteFacts(owner, facts);
        const notSavedMessage = threw ? null : formatPaymentNotSavedMessage(raw, t, formatCurrency);
        const setAsideMessage = threw ? null : formatSetAsidePaymentMessage(raw, t, formatCurrency);
        return {
          verdict: classifyOrdinaryWrite(facts),
          value: {
            paymentId: facts.paymentId,
            paymentOrigin,
            transactionRef,
            terminalDeviceId,
            message: null,
            ...(notSavedMessage
              ? { notice: { kind: 'not_saved' as const, message: notSavedMessage } }
              : setAsideMessage
                ? { notice: { kind: 'set_aside' as const, message: setAsideMessage } }
                : {}),
          },
        };
      };

      const run = await runOrdinaryCollection<GuardedCollection>(
        owner,
        {
          method,
          amount: amountToCollect,
          transactionRef: null,
          idempotencyKey: null,
          settlementGeneration: null,
          terminalTransactionId: null,
        },
        async () => {
          if (sale?.recoverable && sale.id && sale.deviceId) {
            noteOrdinaryTerminalTransaction(owner, sale.id);
            const written = await writeCollected('terminal', sale.id, sale.deviceId);
            return { ...written, verdict: written.verdict === 'completed' ? 'completed' as const : 'unknown' as const };
          }
          if (!terminal) return writeCollected('manual');
          let rawPayment: unknown;
          let threw = false;
          try {
            rawPayment = await bridge.ecr.processPayment(amountToCollect, {
              deviceId: terminal.deviceId,
              orderId,
              reference: `${orderId}:single-payment`,
            });
          } catch {
            threw = true;
          }
          const charge = classifyOrdinaryTerminalReply(rawPayment, threw);
          if (charge.verdict !== 'approved') {
            return {
              verdict: charge.verdict,
              value: {
                paymentId: null,
                paymentOrigin: 'terminal',
                terminalDeviceId: terminal.deviceId,
                message: charge.message,
              },
            };
          }
          noteOrdinaryTerminalTransaction(owner, charge.transactionId);
          const written = await writeCollected('terminal', charge.transactionId, terminal.deviceId);
          // Approved money is never "not sent": an unbooked approval stays unknown.
          return { ...written, verdict: written.verdict === 'completed' ? 'completed' : 'unknown' };
        },
      );

      if (run.status === 'refused') {
        toast.error(ordinaryRefusalText(run.code));
        return;
      }
      const collected = run.value;
      if (!isCurrent()) return;
      if (collected?.notice?.kind === 'not_saved') {
        // The card was charged; its record stays and the banner offers Save
        // payment again. Collect stays disabled: nothing may charge again.
        toast.error(collected.notice.message, { duration: PAYMENT_NOT_SAVED_TOAST_MS });
        await unsaved.refresh();
        return;
      }
      if (collected?.notice?.kind === 'set_aside') {
        // The money is recorded for a manager to give back; nothing is left
        // to collect here, so the cashier must not be invited to charge again.
        toast.error(collected.notice.message, { duration: PAYMENT_SET_ASIDE_TOAST_MS });
        onClose();
        return;
      }
      if (run.status !== 'completed' || !collected?.paymentId) {
        toast.error(
          collected?.message ||
            (run.status === 'not_sent' && method === 'card'
              ? t('splitPayment.cardFailed', { defaultValue: 'Card payment failed' })
              : t('orderDashboard.collectPaymentFailed', {
                  defaultValue: 'Failed to collect payment.',
                })),
        );
        return;
      }

      await onPaymentCollected({
        paymentId: collected.paymentId,
        amount: amountToCollect,
        method,
        paymentOrigin: collected.paymentOrigin,
        transactionRef: collected.transactionRef,
        terminalDeviceId: collected.terminalDeviceId,
      });
      toast.success(
        method === 'card'
          ? t('orderDashboard.cardPaymentRecorded', { defaultValue: 'Card payment recorded.' })
          : t('orderDashboard.cashPaymentRecorded', { defaultValue: 'Cash payment recorded.' }),
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
      // Ends the claim only while nothing was sent under it.
      releaseOrdinaryOwnerBeforeSend(owner);
      setIsProcessing(false);
    }
  }, [
    amountToCollect,
    bridge,
    collectionScope,
    isOpen,
    isProcessing,
    method,
    onClose,
    onPaymentCollected,
    orderId,
    ordinaryRefusalText,
    probeRetainedCollection,
    resolveReadyTerminal,
    t,
    unsaved,
  ]);

  const collect = collectionScope === undefined ? handleCollect : handleGuardedCollect;

  const platformHeldNotice = usePlatformHeldNoticeForOrderId(orderId, isOpen);

  return (
    <LiquidGlassModal
      isOpen={isOpen}
      onClose={onClose}
      title=""
      onEnterKey={collect}
      enterKeyEnabled={
        !isProcessing && amountToCollect > 0.009 && platformHeldNotice === null && !unsavedLocked
      }
    >
      <div className="liquid-glass-modal-text space-y-5">
        <UnsavedChargedPaymentBanner
          payments={unsaved.payments}
          onSaveAgain={unsaved.saveAgain}
          isSaving={unsaved.isSaving}
        />
        {/* Money the platform is holding: say so plainly instead of letting
            the operator press Collect and meet the write path's refusal as a
            generic error, with a customer waiting (founder request,
            16/09/2026). Resolved from the order's own disposition, never from
            `payment_status` — a failed settlement leaves that `pending`,
            which reads exactly like money still owed. */}
        {platformHeldNotice ? (
          <PlatformHeldPaymentNotice notice={platformHeldNotice} showBlockedAction />
        ) : (
        <div className="flex items-start gap-3 rounded-2xl border border-amber-400/20 bg-amber-500/10 p-4">
          <AlertTriangle className="mt-0.5 h-5 w-5 text-amber-300" />
          <div className="space-y-1">
            <p className="text-sm font-semibold uppercase tracking-[0.24em] text-amber-200/90">
              {t('orderDashboard.paymentRequired', {
                defaultValue: 'Payment Required',
              })}
            </p>
            <h3 className="liquid-glass-modal-text text-lg font-semibold">
              {t('orderDashboard.collectSinglePaymentTitle', {
                defaultValue: 'Collect the missing payment to continue',
              })}
            </h3>
            <p className="liquid-glass-modal-text-muted text-sm">
              {t('orderDashboard.collectSinglePaymentDescription', {
                defaultValue:
                  'This order is blocked because the expected payment was not persisted.',
              })}
            </p>
          </div>
        </div>
        )}

        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <div className="liquid-glass-modal-inset rounded-2xl p-4">
            <p className="liquid-glass-modal-text-muted text-xs uppercase tracking-[0.22em]">
              {t('orderDashboard.order', { defaultValue: 'Order' })}
            </p>
            <p className="liquid-glass-modal-text mt-2 text-base font-semibold">
              {orderNumber || orderId}
            </p>
          </div>
          <div className="liquid-glass-modal-inset rounded-2xl p-4">
            <p className="liquid-glass-modal-text-muted text-xs uppercase tracking-[0.22em]">
              {t('orderDashboard.outstandingAmount', {
                defaultValue: 'Outstanding',
              })}
            </p>
            <p className="liquid-glass-modal-text mt-2 text-base font-semibold">
              EUR {amountToCollect.toFixed(2)}
            </p>
          </div>
          <div className="liquid-glass-modal-inset rounded-2xl p-4">
            <p className="liquid-glass-modal-text-muted text-xs uppercase tracking-[0.22em]">
              {t('orderDashboard.paymentMethod', {
                defaultValue: 'Payment Method',
              })}
            </p>
            <p className="liquid-glass-modal-text mt-2 flex items-center gap-2 text-base font-semibold">
              {method === 'card' ? (
                <CreditCard className="h-4 w-4 text-slate-600 dark:text-slate-300" />
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
          <div className="liquid-glass-modal-inset liquid-glass-modal-text-muted rounded-2xl px-4 py-3 text-sm">
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
            onClick={collect}
            disabled={
              isProcessing || amountToCollect <= 0.009 || platformHeldNotice !== null || unsavedLocked
            }
            className="inline-flex flex-1 items-center justify-center gap-2 rounded-2xl border border-emerald-400/20 bg-emerald-500/15 px-4 py-3 text-sm font-semibold text-emerald-100 transition active:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-60"
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
            className="liquid-glass-modal-button inline-flex items-center justify-center rounded-2xl px-4 py-3 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-60"
          >
            {t('common.cancel', { defaultValue: 'Cancel' })}
          </button>
        </div>
      </div>
    </LiquidGlassModal>
  );
};

export default SinglePaymentCollectionModal;
