import React, { useEffect, useRef, useState } from 'react';

import type { PaymentCompletionData } from './PaymentModal';
import { PaymentModal } from './PaymentModal';

export type OutstandingPaymentMethod = 'cash' | 'card' | 'split';

export interface OutstandingPaymentSelection {
  method: OutstandingPaymentMethod;
  amount: number;
  cashReceived?: number;
  change?: number;
  transactionId?: string;
  reconciliationOnly?: boolean;
}

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
}) => {
  const selectionInFlightRef = useRef(false);
  const pendingReconciliationRef = useRef<OutstandingPaymentSelection | null>(null);
  const retryTimerRef = useRef<number | null>(null);
  const retryInFlightRef = useRef(false);
  const onSelectRef = useRef(onSelect);
  const [isReconciling, setIsReconciling] = useState(false);
  onSelectRef.current = onSelect;

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

  useEffect(() => () => {
    pendingReconciliationRef.current = null;
    if (retryTimerRef.current !== null) {
      window.clearTimeout(retryTimerRef.current);
    }
  }, []);

  const handlePaymentComplete = async (paymentData: PaymentCompletionData) => {
    const transactionId = paymentData.transactionId?.trim();
    if (
      !transactionId ||
      transactionId.length > 128 ||
      !/^[A-Za-z0-9._:-]+$/.test(transactionId)
    ) {
      return false;
    }
    if (
      selectionInFlightRef.current ||
      pendingReconciliationRef.current ||
      isProcessing
    ) return false;
    selectionInFlightRef.current = true;
    try {
      const selection: OutstandingPaymentSelection = {
        method: paymentData.method as 'cash' | 'card',
        amount,
        cashReceived: paymentData.cashReceived,
        change: paymentData.change,
        transactionId,
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
    />
  );
};
