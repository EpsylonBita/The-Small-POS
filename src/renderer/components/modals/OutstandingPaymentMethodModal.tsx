import React, { useEffect, useRef, useState } from 'react';

import {
  ordinaryCollectionView,
  releaseOrdinaryOwnerBeforeSend,
  retainedOrdinaryOwner,
  type OrdinaryCollectionOwner,
  type OrdinaryCollectionScope,
} from '../../hooks/useOrderStore';
import type { PaymentCompletionData, PaymentModalExistingOrder } from './PaymentModal';
import { PaymentModal } from './PaymentModal';

export type OutstandingPaymentMethod = 'cash' | 'card' | 'split';

export interface OutstandingPaymentSelection {
  method: OutstandingPaymentMethod;
  amount: number;
  cashReceived?: number;
  change?: number;
  transactionId?: string;
  reconciliationOnly?: boolean;
  /**
   * The payment modal's ordinary collection claim for this cash/card attempt.
   * Retries reuse this exact owner; the host never claims again.
   */
  ordinaryOwner?: OrdinaryCollectionOwner;
}

/** The retained unknown collection of this order, as its snapshot-only retry. */
const retainedReconciliation = (
  scope: OrdinaryCollectionScope | null | undefined,
  orderId: string | null | undefined,
): OutstandingPaymentSelection | null => {
  if (!orderId) return null;
  const owner = retainedOrdinaryOwner(scope, orderId);
  const original = owner ? ordinaryCollectionView(owner)?.original : null;
  if (!owner || !original) return null;
  return {
    method: original.method,
    amount: original.amount,
    transactionId: original.transactionRef ?? undefined,
    reconciliationOnly: true,
    ordinaryOwner: owner,
  };
};

export type OutstandingPaymentSelectionResult =
  | void
  | boolean
  | 'reconciliation-pending';

export interface OutstandingPaymentMethodModalProps {
  isOpen: boolean;
  onClose: () => void;
  amount: number;
  orderType?: 'pickup' | 'delivery' | 'dine-in';
  allowSplit?: boolean;
  isProcessing?: boolean;
  onSelect: (
    selection: OutstandingPaymentSelection,
  ) => OutstandingPaymentSelectionResult | Promise<OutstandingPaymentSelectionResult>;
  /** Existing order being collected; passed through to the payment modal. */
  existingOrder?: PaymentModalExistingOrder;
}

export const OutstandingPaymentMethodModal: React.FC<
  OutstandingPaymentMethodModalProps
> = ({
  isOpen,
  onClose,
  amount,
  orderType,
  allowSplit = true,
  isProcessing = false,
  onSelect,
  existingOrder,
}) => {
  const selectionInFlightRef = useRef(false);
  const inFlightOwnerRef = useRef<OrdinaryCollectionOwner | null>(null);
  const pendingReconciliationRef = useRef<OutstandingPaymentSelection | null>(null);
  const retryTimerRef = useRef<number | null>(null);
  const retryInFlightRef = useRef(false);
  const onSelectRef = useRef(onSelect);
  // A remount over a retained unknown collection starts locked.
  const [isReconciling, setIsReconciling] = useState(
    () => isOpen && retainedReconciliation(existingOrder?.scope, existingOrder?.orderId) !== null,
  );
  onSelectRef.current = onSelect;
  const existingOrderId = existingOrder?.orderId;
  const existingOrganizationId = existingOrder?.scope.organizationId;
  const existingTerminalId = existingOrder?.scope.terminalId;

  const clearPendingReconciliation = (): void => {
    pendingReconciliationRef.current = null;
    setIsReconciling(false);
  };

  const scheduleReconciliationRetry = (): void => {
    if (retryTimerRef.current !== null || !pendingReconciliationRef.current) return;
    retryTimerRef.current = window.setTimeout(() => {
      retryTimerRef.current = null;
      void retryPendingReconciliation();
    }, 3_000);
  };

  const retryPendingReconciliation = async (): Promise<void> => {
    const pendingSelection = pendingReconciliationRef.current;
    if (!pendingSelection || retryInFlightRef.current) return;
    retryInFlightRef.current = true;
    try {
      const result = await onSelectRef.current({
        ...pendingSelection,
        reconciliationOnly: true,
      });
      if (pendingReconciliationRef.current !== pendingSelection) return;
      if (result === 'reconciliation-pending') {
        scheduleReconciliationRetry();
      } else {
        clearPendingReconciliation();
      }
    } catch {
      scheduleReconciliationRetry();
    } finally {
      retryInFlightRef.current = false;
    }
  };

  // Unmount clears timers and state only; an unknown owner stays retained.
  useEffect(() => () => {
    pendingReconciliationRef.current = null;
    if (retryTimerRef.current !== null) {
      window.clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
  }, []);

  // Remount over a retained unknown collection: continue the original owner
  // through the same snapshot-only retry, never with a new claim or key.
  useEffect(() => {
    if (!isOpen || !existingOrderId || pendingReconciliationRef.current) return;
    const retained = retainedReconciliation(
      { organizationId: existingOrganizationId, terminalId: existingTerminalId },
      existingOrderId,
    );
    if (!retained) {
      setIsReconciling(false);
      return;
    }
    pendingReconciliationRef.current = retained;
    setIsReconciling(true);
    scheduleReconciliationRetry();
    // Keyed by order identity; the host may pass a new existingOrder object each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, existingOrderId, existingOrganizationId, existingTerminalId]);

  // A local refusal sent nothing: end a fresh claim, never the in-flight or pending one.
  const refuseBeforeSelect = (owner: OrdinaryCollectionOwner | undefined): false => {
    if (
      owner &&
      owner !== inFlightOwnerRef.current &&
      owner !== pendingReconciliationRef.current?.ordinaryOwner
    ) {
      releaseOrdinaryOwnerBeforeSend(owner);
    }
    return false;
  };

  const handlePaymentComplete = async (paymentData: PaymentCompletionData) => {
    const ordinaryOwner = paymentData.ordinaryOwner;
    const transactionId = paymentData.transactionId?.trim();
    if (
      !transactionId ||
      transactionId.length > 128 ||
      !/^[A-Za-z0-9._:-]+$/.test(transactionId)
    ) {
      return refuseBeforeSelect(ordinaryOwner);
    }
    if (
      selectionInFlightRef.current ||
      pendingReconciliationRef.current ||
      isProcessing
    ) return refuseBeforeSelect(ordinaryOwner);
    selectionInFlightRef.current = true;
    inFlightOwnerRef.current = ordinaryOwner ?? null;
    try {
      const selection: OutstandingPaymentSelection = {
        method: paymentData.method as 'cash' | 'card',
        amount,
        cashReceived: paymentData.cashReceived,
        change: paymentData.change,
        transactionId,
        ...(ordinaryOwner ? { ordinaryOwner } : {}),
      };
      const result = await onSelect(selection);
      if (result === 'reconciliation-pending') {
        pendingReconciliationRef.current = selection;
        setIsReconciling(true);
        scheduleReconciliationRetry();
        return false;
      }
      return result;
    } finally {
      selectionInFlightRef.current = false;
      inFlightOwnerRef.current = null;
    }
  };

  const handleSplitPayment = () => {
    if (
      selectionInFlightRef.current ||
      pendingReconciliationRef.current ||
      isProcessing
    ) return;
    selectionInFlightRef.current = true;
    Promise.resolve(onSelect({ method: 'split', amount })).finally(() => {
      selectionInFlightRef.current = false;
    });
  };

  return (
    <PaymentModal
      isOpen={isOpen}
      onClose={onClose}
      orderTotal={amount}
      orderType={orderType}
      isProcessing={isProcessing || isReconciling}
      allowTips={false}
      onPaymentComplete={handlePaymentComplete}
      onSplitPayment={allowSplit ? handleSplitPayment : undefined}
      existingOrder={existingOrder}
    />
  );
};
