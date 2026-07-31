import React, { useState, useEffect, useMemo, useRef } from 'react';
import { CreditCard, Banknote, Coins, AlertTriangle, Split, BedDouble, HandCoins } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useFeatures } from '../../hooks/useFeatures';
import { useAcquiredModules, MODULE_IDS } from '../../hooks/useAcquiredModules';
import { formatMoneyInputFromNumber, formatMoneyInputWithCents, parseMoneyInputValue } from '../../utils/moneyInput';
import { formatCurrency } from '../../utils/format';
import { LiquidGlassModal } from '../ui/pos-glass-components';
import toast from 'react-hot-toast';
import { ActivityTracker } from '../../services/ActivityTracker';
import {
  TipModal,
  type TipRecipientRole,
  type TipSelection,
} from './TipModal';

export interface RoomChargeContext {
  roomId: string;
  roomNumber?: string | null;
  guestName?: string | null;
  activeFolioId?: string | null;
}

export interface RoomChargeFallbackPrompt {
  roomChargeApplied: false;
  orderId: string;
  orderNumber?: string;
  amount?: number;
  reason?: string;
}

export type PaymentMethodSelection = 'cash' | 'card' | 'room_charge';

export type PaymentCompletionResult = void | boolean | RoomChargeFallbackPrompt;

export interface PaymentCompletionData {
  method: PaymentMethodSelection;
  amount: number;
  transactionId?: string;
  driverId?: string;
  cashReceived?: number;
  change?: number;
  tipAmount?: number;
  tipRecipientRole?: TipRecipientRole;
  tipRecipientStaffId?: string;
  tipRecipientStaffShiftId?: string;
  roomId?: string;
  room_id?: string;
  roomCharge?: RoomChargeContext;
  existingOrderId?: string;
  existingOrderNumber?: string;
  roomChargeFallback?: boolean;
}

export const isRoomChargeFallbackPrompt = (
  value: PaymentCompletionResult,
): value is RoomChargeFallbackPrompt =>
  Boolean(
    value &&
      typeof value === 'object' &&
      (value as RoomChargeFallbackPrompt).roomChargeApplied === false &&
      typeof (value as RoomChargeFallbackPrompt).orderId === 'string',
  );

interface PaymentModalProps {
  isOpen: boolean;
  onClose: () => void;
  orderTotal: number;
  discountAmount?: number;
  deliveryFee?: number;
  isProcessing?: boolean;
  orderType?: 'pickup' | 'delivery' | 'dine-in';
  minimumOrderAmount?: number; // From delivery zone settings in admin dashboard
  onPaymentComplete: (
    paymentData: PaymentCompletionData,
  ) => PaymentCompletionResult | Promise<PaymentCompletionResult>;
  /** When provided, a "Split" button is rendered alongside Cash/Card in the payment selection step. */
  onSplitPayment?: (tipSelection: TipSelection | null) => void;
  roomChargeContext?: RoomChargeContext | null;
}

type ModalStep = 'minimum_warning' | 'payment_selection' | 'cash_input';

type CashChangeBreakdownItem = {
  value: number;
  count: number;
  type: 'bill' | 'coin';
};

const CASH_CHANGE_DENOMINATIONS = [50, 20, 10, 5, 2, 1, 0.5, 0.2, 0.1, 0.05];
const QUICK_CASH_ROUNDING_STEPS = [1, 5, 10, 20, 50, 100];
const CASH_CHANGE_CHIP_CLASS =
  'inline-flex min-h-8 items-center gap-1.5 whitespace-nowrap rounded-full border border-slate-200/90 bg-white/90 px-2.5 py-1 text-xs font-semibold text-slate-700 shadow-[0_4px_12px_rgba(15,23,42,0.06)] dark:border-white/10 dark:bg-white/5 dark:text-slate-100 dark:shadow-none';

const roundMoney = (value: number): number =>
  Math.round((Number.isFinite(value) ? value : 0) * 100) / 100;

const hasMoneyAmount = (amounts: number[], candidate: number): boolean =>
  amounts.some(amount => Math.abs(amount - candidate) < 0.01);

type AccentedPaymentOption = 'cash' | 'card' | 'split';

export const getPaymentOptionVisualClasses = (
  method: AccentedPaymentOption,
  disabled: boolean,
): { option: string; icon: string; label: string } => {
  if (disabled) {
    return {
      option: 'border-gray-400/20 bg-gray-500/5 opacity-50 cursor-not-allowed',
      icon: 'text-gray-400',
      label: 'text-gray-400',
    };
  }

  if (method === 'cash') {
    return {
      option: 'payment-option-cash active:scale-[0.98]',
      icon: 'payment-option-cash-icon',
      label: 'liquid-glass-modal-text',
    };
  }

  if (method === 'card') {
    return {
      option: 'payment-option-card active:scale-[0.98]',
      icon: 'payment-option-card-icon',
      label: 'liquid-glass-modal-text',
    };
  }

  return {
    option: 'payment-option-split active:scale-[0.98]',
    icon: 'payment-option-split-icon',
    label: 'liquid-glass-modal-text',
  };
};

export const getCashInputVisualClasses = (
  hasEnoughCash: boolean,
): Record<string, string> => ({
  quickAmountsPanel:
    'space-y-3 rounded-2xl border border-slate-200/80 bg-slate-50/70 p-3 dark:border-white/10 dark:bg-white/5',
  quickAmountsLabel: 'text-slate-600 dark:text-slate-300',
  quickAmountSelected:
    'border-yellow-400 bg-yellow-400 text-slate-950 shadow-[0_6px_16px_rgba(234,179,8,0.18)] dark:border-yellow-400/70 dark:bg-yellow-400/20 dark:text-yellow-100 dark:shadow-none',
  quickAmountIdle:
    'border-slate-200/90 bg-white/90 text-slate-900 shadow-sm active:bg-slate-100 dark:border-white/10 dark:bg-white/5 dark:text-white dark:shadow-none dark:active:bg-white/10',
  cashInput:
    'border-slate-300/90 bg-white/90 text-slate-950 shadow-inner placeholder:text-slate-400 focus:border-yellow-400 focus:ring-2 focus:ring-yellow-400/20 dark:border-white/20 dark:bg-white/10 dark:text-white dark:placeholder:text-white/35 dark:focus:border-yellow-400/70',
  summary: hasEnoughCash
    ? 'border-slate-200/90 bg-white/80 shadow-[0_12px_28px_rgba(15,23,42,0.08)] dark:border-white/10 dark:bg-white/5 dark:shadow-none'
    : 'border-red-300/70 bg-red-50/80 dark:border-red-400/30 dark:bg-red-500/10',
  summaryDivider: 'border-slate-200/80 dark:border-white/10',
  changeTone: hasEnoughCash
    ? 'text-emerald-700 dark:text-emerald-300'
    : 'text-red-700 dark:text-red-300',
  changeChip: CASH_CHANGE_CHIP_CLASS,
  completeButton: hasEnoughCash
    ? '!border-emerald-700 !bg-emerald-700 !text-white !shadow-[0_8px_20px_rgba(4,120,87,0.24)] active:!bg-emerald-800 dark:!border-emerald-400/50 dark:!bg-emerald-500/20 dark:!text-emerald-100 dark:!shadow-none'
    : '!border-slate-200/80 !bg-slate-100/80 !text-slate-400 dark:!border-white/10 dark:!bg-white/5 dark:!text-white/35',
});

export const CashChangeChip: React.FC<{
  item: CashChangeBreakdownItem;
  formattedValue: string;
}> = ({ item, formattedValue }) => {
  const Icon = item.type === 'bill' ? Banknote : Coins;

  return (
    <span className={CASH_CHANGE_CHIP_CLASS}>
      <Icon
        className={
          item.type === 'bill'
            ? 'h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-300'
            : 'h-3.5 w-3.5 shrink-0 text-amber-500 dark:text-amber-300'
        }
      />
      <span>
        {item.count} x {formattedValue}
      </span>
    </span>
  );
};

export const PaymentModal: React.FC<PaymentModalProps> = ({
  isOpen,
  onClose,
  orderTotal,
  discountAmount = 0,
  deliveryFee = 0,
  isProcessing = false,
  orderType,
  minimumOrderAmount = 0, // Default to 0 (no minimum) if not provided
  onPaymentComplete,
  onSplitPayment,
  roomChargeContext = null,
}) => {
  const { t } = useTranslation();
  const { isFeatureEnabled, isMobileWaiter, loading: isFeatureLoading } = useFeatures();
  const { hasModule } = useAcquiredModules();
  const canUseCash = isFeatureEnabled('cashPayments');
  const canUseCard = isFeatureEnabled('cardPayments');
  const [isProcessingPayment, setIsProcessingPayment] = useState(isProcessing);
  const [cashReceived, setCashReceived] = useState<string>('');
  const [selectedPaymentMethod, setSelectedPaymentMethod] = useState<PaymentMethodSelection | null>(null);
  const [roomChargeFallback, setRoomChargeFallback] = useState<RoomChargeFallbackPrompt | null>(null);
  const [showTipModal, setShowTipModal] = useState(false);
  const [tipSelection, setTipSelection] = useState<TipSelection | null>(null);
  const cashInputRef = useRef<HTMLInputElement | null>(null);
  const canUseRoomCharge =
    !roomChargeFallback &&
    Boolean(roomChargeContext?.roomId && roomChargeContext?.activeFolioId) &&
    hasModule(MODULE_IDS.ROOMS) &&
    hasModule(MODULE_IDS.ORDERS) &&
    hasModule('guest_billing');
  const hasAnyPaymentMethod = canUseCash || canUseCard || canUseRoomCharge;
  const paymentOptionCount =
    2 + (onSplitPayment ? 1 : 0) + (canUseRoomCharge ? 1 : 0);
  const paymentGridClass =
    paymentOptionCount >= 4
      ? 'grid-cols-2'
      : paymentOptionCount === 3
        ? 'grid-cols-3'
        : 'grid-cols-2';
  const paymentGridGapClass = paymentOptionCount === 3 ? 'gap-4' : 'gap-6';
  const paymentOptionPaddingClass = paymentOptionCount === 3 ? 'p-4' : 'p-6';
  const paymentMethodLabelBaseClass =
    'w-full text-center text-sm font-bold uppercase leading-tight tracking-normal hyphens-none whitespace-normal transition-colors duration-300';
  const cashVisualClasses = getPaymentOptionVisualClasses(
    'cash',
    !canUseCash || isProcessingPayment,
  );
  const cardVisualClasses = getPaymentOptionVisualClasses(
    'card',
    !canUseCard || isProcessingPayment,
  );
  const splitVisualClasses = getPaymentOptionVisualClasses(
    'split',
    isProcessingPayment,
  );

  // Check if order is below minimum (only if a minimum is set)
  const isBelowMinimum = minimumOrderAmount > 0 && orderTotal < minimumOrderAmount;

  // Determine initial step based on minimum order check
  const [currentStep, setCurrentStep] = useState<ModalStep>(
    isBelowMinimum ? 'minimum_warning' : 'payment_selection'
  );

  const showDeliveryFee = orderType === 'delivery';
  const subtotalBeforeDiscount = Math.max(0, orderTotal + discountAmount - (showDeliveryFee ? deliveryFee : 0));
  const tipBaseAmount = Math.max(0, orderTotal - (showDeliveryFee ? deliveryFee : 0));
  const tipAmount = roundMoney(tipSelection?.amount || 0);
  const payableTotal = roundMoney(orderTotal + tipAmount);

  const roundedOrderTotal = payableTotal;

  // Calculate change
  const cashAmount = parseMoneyInputValue(cashReceived);
  const changeAmount = roundMoney(cashAmount - roundedOrderTotal);
  const hasEnoughCash = cashAmount >= roundedOrderTotal;
  const amountShort = roundMoney(Math.max(0, roundedOrderTotal - cashAmount));
  const cashInputVisualClasses = getCashInputVisualClasses(hasEnoughCash);

  const quickCashAmounts = useMemo(() => {
    const amounts: number[] = [];

    if (roundedOrderTotal > 0) {
      amounts.push(roundedOrderTotal);
    }

    for (const step of QUICK_CASH_ROUNDING_STEPS) {
      const rounded = roundMoney(Math.ceil(roundedOrderTotal / step) * step);
      if (rounded >= roundedOrderTotal && !hasMoneyAmount(amounts, rounded)) {
        amounts.push(rounded);
      }

      if (amounts.length >= 5) {
        break;
      }
    }

    return amounts.sort((a, b) => a - b).slice(0, 5);
  }, [roundedOrderTotal]);

  const changeBreakdown = useMemo<CashChangeBreakdownItem[]>(() => {
    if (!hasEnoughCash || changeAmount <= 0) {
      return [];
    }

    const breakdown: CashChangeBreakdownItem[] = [];
    let remaining = roundMoney(changeAmount);

    for (const value of CASH_CHANGE_DENOMINATIONS) {
      const count = Math.floor((remaining + 0.001) / value);
      if (count <= 0) {
        continue;
      }

      breakdown.push({
        value,
        count,
        type: value >= 5 ? 'bill' : 'coin',
      });
      remaining = roundMoney(remaining - count * value);
    }

    return breakdown;
  }, [changeAmount, hasEnoughCash]);

  // Reset step when modal opens
  useEffect(() => {
    if (isOpen) {
      setCurrentStep(isBelowMinimum ? 'minimum_warning' : 'payment_selection');
      setIsProcessingPayment(isProcessing);
      setCashReceived('');
      setSelectedPaymentMethod(null);
      setRoomChargeFallback(null);
      setShowTipModal(false);
      setTipSelection(null);
    }
  }, [isOpen, isProcessing, isBelowMinimum]);

  useEffect(() => {
    if (!isOpen || currentStep !== 'cash_input') return;

    const focusTimer = window.setTimeout(() => {
      cashInputRef.current?.focus();
    }, 0);

    return () => window.clearTimeout(focusTimer);
  }, [isOpen, currentStep]);

  // Handle payment method selection
  const handlePaymentMethodSelect = (method: PaymentMethodSelection) => {
    if (method === 'room_charge' && !canUseRoomCharge) return;
    setSelectedPaymentMethod(method);

    // For delivery orders, card payment, and charge-to-room, process immediately
    if (orderType === 'delivery' || method === 'card' || method === 'room_charge') {
      handleSimplePayment(method);
    } else {
      // For pickup/in-store with cash, show cash input
      setCurrentStep('cash_input');
    }
  };

  // Simple payment handler - just method, no amount input needed
  const handleSimplePayment = async (method: PaymentMethodSelection) => {
    setIsProcessingPayment(true);
    try {
      // Intentional 500ms delay: gives the user visible feedback that the
      // payment is being processed (the spinner / "processing" state) before
      // the modal closes.  Without this, quick cash payments feel like the
      // button did nothing because the modal dismisses instantly.
      await new Promise(resolve => setTimeout(resolve, 500));

      const txId = `${method.toUpperCase().replace('_', '-')}-${Date.now()}`;

      const paymentPayload = {
        method,
        amount: payableTotal,
        transactionId: txId,
        driverId: undefined,
        cashReceived: method === 'cash' ? (cashAmount || payableTotal) : undefined,
        change: method === 'cash' ? (changeAmount > 0 ? changeAmount : 0) : undefined,
        tipAmount: tipSelection?.amount,
        tipRecipientRole: tipSelection?.recipientRole,
        ...(method === 'room_charge' && roomChargeContext
          ? {
              roomId: roomChargeContext.roomId,
              room_id: roomChargeContext.roomId,
              roomCharge: roomChargeContext,
            }
          : {}),
        ...(roomChargeFallback && method !== 'room_charge'
          ? {
              existingOrderId: roomChargeFallback.orderId,
              existingOrderNumber: roomChargeFallback.orderNumber,
              roomChargeFallback: true,
            }
          : {}),
      };

      const completionResult = await onPaymentComplete(paymentPayload);

      if (isRoomChargeFallbackPrompt(completionResult)) {
        setRoomChargeFallback(completionResult);
        setSelectedPaymentMethod(null);
        toast.error(
          t(
            'modals.payment.roomChargeFallback',
            'Room charge was not applied. Collect cash or card payment for this order.',
          ),
        );
        return;
      }

      if (
        method === 'room_charge' &&
        completionResult === false &&
        paymentPayload.existingOrderId
      ) {
        setRoomChargeFallback({
          roomChargeApplied: false,
          orderId: paymentPayload.existingOrderId,
          orderNumber: paymentPayload.existingOrderNumber,
          amount: payableTotal,
          reason: 'room_charge_not_applied',
        });
        setSelectedPaymentMethod(null);
        toast.error(
          t(
            'modals.payment.roomChargeFallback',
            'Room charge was not applied. Collect cash or card payment for this order.',
          ),
        );
        return;
      }

      if (completionResult === false) {
        return;
      }

      try {
        ActivityTracker.trackPaymentCompleted(payableTotal, method, txId, undefined);
      } catch { }

      toast.success(
        method === 'room_charge'
          ? t('modals.payment.roomChargeSuccess', 'Charged to room')
          : t(`modals.payment.${method}Success`),
      );
    } catch (error) {
      toast.error(t('modals.payment.paymentFailed'));
    } finally {
      setIsProcessingPayment(false);
    }
  };

  // Handle cash payment completion
  const handleCashPaymentComplete = () => {
    if (!hasEnoughCash) {
      toast.error(t('modals.payment.insufficientCash', 'Insufficient cash received'));
      return;
    }
    handleSimplePayment('cash');
  };

  const handleQuickCashSelect = (amount: number) => {
    setCashReceived(formatMoneyInputFromNumber(amount));
    cashInputRef.current?.focus();
  };

  const handleSkipMinimumWarning = () => {
    setCurrentStep('payment_selection');
  };

  const resetModal = () => {
    setCurrentStep(isBelowMinimum ? 'minimum_warning' : 'payment_selection');
    setIsProcessingPayment(false);
    setCashReceived('');
    setSelectedPaymentMethod(null);
    setRoomChargeFallback(null);
    setShowTipModal(false);
    setTipSelection(null);
  };

  const handleBackToPaymentSelection = () => {
    setCurrentStep('payment_selection');
    setCashReceived('');
    setSelectedPaymentMethod(null);
  };

  const handleClose = () => {
    // Prevent closing while a payment is actively processing
    if (isProcessingPayment) return;
    resetModal();
    onClose();
  };

  const handleModalEnter = () => {
    if (isProcessingPayment || isFeatureLoading) return;

    if (currentStep === 'minimum_warning') {
      handleSkipMinimumWarning();
      return;
    }

    if (currentStep === 'cash_input') {
      handleCashPaymentComplete();
      return;
    }

    if (currentStep === 'payment_selection' && !onSplitPayment) {
      if (canUseCash && !canUseCard) {
        handlePaymentMethodSelect('cash');
      } else if (canUseCard && !canUseCash) {
        handlePaymentMethodSelect('card');
      }
    }
  };

  const canSubmitWithEnter =
    currentStep === 'minimum_warning' ||
    currentStep === 'cash_input' ||
    (currentStep === 'payment_selection' && !onSplitPayment && canUseCash !== canUseCard);

  return (
    <>
    <LiquidGlassModal
      isOpen={isOpen}
      onClose={handleClose}
      title={t('modals.payment.title')}
      size="md"
      className="!max-w-lg"
      closeOnBackdrop={false}
      closeOnEscape={!isProcessingPayment}
      initialFocusRef={currentStep === 'cash_input' ? cashInputRef : undefined}
      onEnterKey={handleModalEnter}
      enterKeyEnabled={!isProcessingPayment && !isFeatureLoading && canSubmitWithEnter}
    >
      {/* Content */}
      <div>
        {/* Order Total with Discount Breakdown */}
        <div className="text-center mb-8">
          {(discountAmount > 0 || showDeliveryFee || tipAmount > 0) && (
            <div className="mb-4 space-y-2 p-4 rounded-2xl bg-white/5 border border-white/10">
              <div className="flex justify-between text-sm">
                <span className="liquid-glass-modal-text-muted">
                  {t('payment.fields.subtotal')}
                </span>
                <span className="liquid-glass-modal-text font-medium">
                  {formatCurrency(subtotalBeforeDiscount)}
                </span>
              </div>
              {discountAmount > 0 && (
                <div className="flex justify-between text-sm">
                  <span className="text-green-500 dark:text-green-400 font-medium">
                    {t('modals.payment.discount')}
                  </span>
                  <span className="text-green-500 dark:text-green-400 font-medium">
                    -{formatCurrency(discountAmount)}
                  </span>
                </div>
              )}
              {showDeliveryFee && (
                <div className="flex justify-between text-sm">
                  <span className="liquid-glass-modal-text-muted">
                    {t('payment.fields.deliveryFee')}
                  </span>
                  <span className="liquid-glass-modal-text font-medium">
                    {formatCurrency(deliveryFee)}
                  </span>
                </div>
              )}
              {tipAmount > 0 && (
                <div className="flex justify-between text-sm">
                  <span className="font-medium text-emerald-400">
                    {t('modals.payment.tip', 'Tip')}
                  </span>
                  <span className="font-medium text-emerald-400">
                    +{formatCurrency(tipAmount)}
                  </span>
                </div>
              )}
              <div className="border-t border-white/10 pt-2 mt-2"></div>
            </div>
          )}
          <p className="text-sm liquid-glass-modal-text-muted mb-2">
            {discountAmount > 0 ? t('modals.payment.finalAmount') : t('modals.payment.totalAmount')}
          </p>
          <p className="text-4xl font-bold text-emerald-500 dark:text-emerald-400 tracking-tight">
            {formatCurrency(payableTotal)}
          </p>
        </div>

        {/* Step: Minimum Order Warning */}
        {currentStep === 'minimum_warning' && (
          <div className="space-y-4">
            <div className="flex items-center gap-3 p-4 rounded-2xl bg-orange-500/10 border border-orange-500/30">
              <AlertTriangle className="w-8 h-8 text-orange-400 flex-shrink-0" />
              <div>
                <h3 className="font-semibold text-orange-400">
                  {t('modals.payment.belowMinimumTitle', 'Minimum Order Not Met')}
                </h3>
                <p className="text-sm text-orange-300/80">
                  {t('modals.payment.belowMinimumMessage', 'Order amount is below minimum order amount of {{amount}}', { amount: formatCurrency(minimumOrderAmount) })}
                </p>
              </div>
            </div>

            <div className="flex gap-3">
              <button
                onClick={handleClose}
                className="liquid-glass-modal-button flex-1 font-medium bg-gray-500/20 active:bg-gray-500/30 liquid-glass-modal-text"
              >
                {t('modals.payment.cancel')}
              </button>
              <button
                onClick={handleSkipMinimumWarning}
                className="liquid-glass-modal-button flex-1 font-medium bg-orange-600/20 active:bg-orange-600/30 text-orange-400 border-orange-500/30"
              >
                {t('modals.payment.skip', 'Skip')}
              </button>
            </div>
          </div>
        )}

        {currentStep === 'payment_selection' && (
          <div className="relative">
            <button
              type="button"
              onClick={() => setShowTipModal(true)}
              disabled={isProcessingPayment}
              className={`mb-4 flex min-h-14 w-full items-center justify-between gap-3 rounded-2xl border px-4 py-3 text-left transition-colors ${
                tipAmount > 0
                  ? 'border-emerald-400/50 bg-emerald-500/15'
                  : 'border-white/10 bg-white/5 hover:bg-white/10'
              } ${isProcessingPayment ? 'cursor-not-allowed opacity-50' : 'active:scale-[0.99]'}`}
            >
              <span className="flex items-center gap-3">
                <HandCoins className="h-6 w-6 shrink-0 text-emerald-500 dark:text-emerald-300" />
                <span>
                  <span className="block font-bold liquid-glass-modal-text">
                    {tipAmount > 0
                      ? t('modals.payment.editTip', 'Edit tip')
                      : t('modals.payment.addTip', 'Add tip')}
                  </span>
                  <span className="block text-xs liquid-glass-modal-text-muted">
                    {tipSelection
                      ? t(`modals.tip.recipients.${tipSelection.recipientRole}`)
                      : t('modals.payment.tipOptional', 'Optional — added before payment')}
                  </span>
                </span>
              </span>
              <span className="text-lg font-bold text-emerald-400">
                {tipAmount > 0 ? formatCurrency(tipAmount) : '+'}
              </span>
            </button>
            {isFeatureLoading ? (
              <div className="flex items-center gap-3 p-4 rounded-2xl bg-white/5 border border-white/10 w-full">
                <div className="w-5 h-5 rounded-full border-2 border-white/20 border-t-white/70 animate-spin flex-shrink-0" />
                <div>
                  <h3 className="font-semibold liquid-glass-modal-text">
                    {t('modals.payment.loadingMethods', 'Loading payment methods')}
                  </h3>
                  <p className="text-sm liquid-glass-modal-text-muted">
                    {t('modals.payment.loadingMethodsHint', 'Checking terminal payment configuration...')}
                  </p>
                </div>
              </div>
            ) : !hasAnyPaymentMethod ? (
              <div className="flex items-center gap-3 p-4 rounded-2xl bg-amber-500/10 border border-amber-500/30 w-full">
                <AlertTriangle className="w-6 h-6 text-amber-400 flex-shrink-0" />
                <div>
                  <h3 className="font-semibold text-amber-400">
                    {t('settings.terminal.messages.noPaymentMethods', 'No payment methods available')}
                  </h3>
                  <p className="text-sm text-amber-300/80">
                    {t('settings.terminal.messages.contactManager', 'Contact your manager for configuration changes.')}
                  </p>
                </div>
              </div>
            ) : (
              <div className={`grid ${paymentGridGapClass} ${paymentGridClass}`}>
                {/* Cash Option */}
                <button
                  onClick={() => canUseCash && handlePaymentMethodSelect('cash')}
                  disabled={!canUseCash || isProcessingPayment}
                  className={`group relative flex flex-col items-center justify-center ${paymentOptionPaddingClass} rounded-2xl border-2 transition-all duration-300 overflow-hidden
                    ${cashVisualClasses.option}`}
                >
                  <Banknote
                    className={`w-20 h-20 mb-3 transition-all duration-300
                      ${cashVisualClasses.icon}`}
                    strokeWidth={1.5}
                  />

                  <span className={`${paymentMethodLabelBaseClass}
                    ${cashVisualClasses.label}`}
                  >
                    {t('modals.payment.cashSimple', 'CASH')}
                  </span>

                  {isMobileWaiter && !canUseCash && (
                    <p className="text-xs text-amber-400 mt-2 text-center">
                      {t('settings.terminal.messages.cashDrawerMainOnly', 'Cash handled by Main POS')}
                    </p>
                  )}
                </button>

                {/* Card Option */}
                <button
                  onClick={() => canUseCard && handlePaymentMethodSelect('card')}
                  disabled={!canUseCard || isProcessingPayment}
                  className={`group relative flex flex-col items-center justify-center ${paymentOptionPaddingClass} rounded-2xl border-2 transition-all duration-300 overflow-hidden
                    ${cardVisualClasses.option}`}
                >
                  <CreditCard
                    className={`w-20 h-20 mb-3 transition-all duration-300
                      ${cardVisualClasses.icon}`}
                    strokeWidth={1.5}
                  />

                  <span className={`${paymentMethodLabelBaseClass}
                    ${cardVisualClasses.label}`}
                  >
                    {t('modals.payment.cardSimple', 'CARD')}
                  </span>

                  {!canUseCard && (
                    <p className="text-xs text-amber-400 mt-2 text-center">
                      {t('settings.terminal.messages.featureDisabled', 'Feature disabled for this terminal')}
                    </p>
                  )}
                </button>

                {canUseRoomCharge && roomChargeContext && (
                  <button
                    onClick={() => handlePaymentMethodSelect('room_charge')}
                    disabled={isProcessingPayment}
                    className={`group relative flex flex-col items-center justify-center ${paymentOptionPaddingClass} rounded-2xl border-2 transition-all duration-300 overflow-hidden
                      ${isProcessingPayment
                        ? 'border-gray-400/20 bg-gray-500/5 opacity-50 cursor-not-allowed'
                        : 'border-amber-400/30 bg-gradient-to-br from-amber-500/10 to-amber-600/5 active:scale-[0.98]'
                      }`}
                  >
                    <BedDouble
                      className={`w-20 h-20 mb-3 transition-all duration-300
                        ${isProcessingPayment ? 'text-gray-400' : 'text-amber-400'}`}
                      strokeWidth={1.5}
                    />

                    <span className={`${paymentMethodLabelBaseClass}
                      ${isProcessingPayment ? 'text-gray-400' : 'text-amber-400'}`}
                    >
                      {t('modals.payment.roomChargeSimple', 'ROOM')}
                    </span>
                    <p className="mt-2 max-w-36 truncate text-center text-xs liquid-glass-modal-text-muted">
                      {roomChargeContext.roomNumber
                        ? t('modals.payment.roomChargeRoom', 'Room {{roomNumber}}', { roomNumber: roomChargeContext.roomNumber })
                        : t('modals.payment.roomChargeLabel', 'Charge to room')}
                    </p>
                  </button>
                )}

                {/* Split Option — shown only when onSplitPayment callback is provided */}
                {onSplitPayment && (
                  <button
                    onClick={() => { onSplitPayment(tipSelection); }}
                    disabled={isProcessingPayment}
                    className={`group relative flex flex-col items-center justify-center ${paymentOptionPaddingClass} rounded-2xl border-2 transition-all duration-300 overflow-hidden
                      ${splitVisualClasses.option}`}
                  >
                    <Split
                      className={`w-20 h-20 mb-3 transition-all duration-300
                        ${splitVisualClasses.icon}`}
                      strokeWidth={1.5}
                    />

                    <span className={`${paymentMethodLabelBaseClass}
                      ${splitVisualClasses.label}`}
                    >
                      {t('modals.payment.splitSimple', 'SPLIT')}
                    </span>
                  </button>
                )}
              </div>
            )}

            {/* Processing indicator */}
            {isProcessingPayment && (
              <div className="mt-4 text-center">
                <p className="text-sm liquid-glass-modal-text-muted animate-pulse">
                  {t('modals.payment.processing')}
                </p>
              </div>
            )}

            {roomChargeFallback && !isProcessingPayment && (
              <div className="mt-4 flex items-center gap-3 rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4">
                <AlertTriangle className="h-5 w-5 flex-shrink-0 text-amber-400" />
                <p className="text-sm text-amber-300">
                  {t(
                    'modals.payment.roomChargeFallback',
                    'Room charge was not applied. Collect cash or card payment for this order.',
                  )}
                </p>
              </div>
            )}
          </div>
        )}

        {/* Step: Cash Input (only for pickup/in-store) */}
        {currentStep === 'cash_input' && (
          <div className="space-y-6">
            {quickCashAmounts.length > 0 && (
              <div className={cashInputVisualClasses.quickAmountsPanel}>
                <p className={`text-sm font-semibold ${cashInputVisualClasses.quickAmountsLabel}`}>
                  {t('modals.payment.quickAmounts', 'Quick Amounts')}
                </p>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                  {quickCashAmounts.map((amount) => {
                    const isSelected = hasMoneyAmount([cashAmount], amount);

                    return (
                      <button
                        key={amount}
                        type="button"
                        onClick={() => handleQuickCashSelect(amount)}
                        disabled={isProcessingPayment}
                        className={`min-h-11 rounded-xl border px-3 py-2 text-sm font-bold transition-all ${
                          isSelected
                            ? cashInputVisualClasses.quickAmountSelected
                            : cashInputVisualClasses.quickAmountIdle
                        } ${isProcessingPayment ? 'cursor-not-allowed opacity-50' : 'active:scale-[0.98]'}`}
                      >
                        {formatCurrency(amount)}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            <div className="text-center">
              <p className="text-sm liquid-glass-modal-text-muted mb-2">
                {t('modals.payment.enterCashReceived', 'Cash Received')}
              </p>
              <input
                ref={cashInputRef}
                type="text"
                inputMode="decimal"
                value={cashReceived}
                onChange={(e) => setCashReceived(formatMoneyInputWithCents(e.target.value))}
                placeholder="0,00"
                autoFocus
                className={`w-full rounded-xl border-2 p-4 text-center text-3xl font-bold outline-none transition-colors ${cashInputVisualClasses.cashInput}`}
              />
            </div>

            {cashReceived && (
              <div className={`rounded-2xl border-2 p-4 transition-colors ${cashInputVisualClasses.summary}`}>
                <div className="flex justify-between items-center mb-2">
                  <span className="liquid-glass-modal-text-muted">
                    {t('modals.payment.totalAmount')}
                  </span>
                  <span className="font-bold liquid-glass-modal-text">
                    {formatCurrency(payableTotal)}
                  </span>
                </div>
                <div className="flex justify-between items-center mb-2">
                  <span className="liquid-glass-modal-text-muted">
                    {t('modals.payment.cashReceived', 'Cash Received')}
                  </span>
                  <span className="font-bold liquid-glass-modal-text">
                    {formatCurrency(cashAmount)}
                  </span>
                </div>
                <div className={`mt-2 border-t pt-2 ${cashInputVisualClasses.summaryDivider}`}></div>
                <div className="flex justify-between items-center">
                  <span className={`font-semibold ${cashInputVisualClasses.changeTone}`}>
                    {hasEnoughCash
                      ? t('modals.payment.change', 'Change')
                      : t('modals.payment.amountShort', 'Amount Short')}
                  </span>
                  <span className={`text-2xl font-bold ${cashInputVisualClasses.changeTone}`}>
                    {hasEnoughCash ? formatCurrency(changeAmount) : formatCurrency(amountShort)}
                  </span>
                </div>
                {hasEnoughCash && changeAmount > 0 && changeBreakdown.length > 0 && (
                  <div className={`mt-3 border-t pt-3 ${cashInputVisualClasses.summaryDivider}`}>
                    <p className="mb-2 text-xs font-semibold uppercase tracking-normal liquid-glass-modal-text-muted">
                      {t('modals.payment.suggestedChange', 'Suggested change')}
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {changeBreakdown.map((item) => (
                        <CashChangeChip
                          key={item.value}
                          item={item}
                          formattedValue={formatCurrency(item.value)}
                        />
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            <div className="flex gap-3">
              <button
                onClick={handleBackToPaymentSelection}
                disabled={isProcessingPayment}
                className="liquid-glass-modal-button flex-1 font-medium bg-gray-500/20 active:bg-gray-500/30 liquid-glass-modal-text"
              >
                {t('common.actions.back', 'Back')}
              </button>
              <button
                onClick={handleCashPaymentComplete}
                disabled={!hasEnoughCash || isProcessingPayment}
                className={`liquid-glass-modal-button flex-1 font-medium ${
                  hasEnoughCash && !isProcessingPayment
                    ? cashInputVisualClasses.completeButton
                    : `${cashInputVisualClasses.completeButton} cursor-not-allowed opacity-50`
                }`}
              >
                {isProcessingPayment ? t('modals.payment.processing') : t('modals.payment.completeCash', 'Complete')}
              </button>
            </div>
          </div>
        )}
      </div>
    </LiquidGlassModal>
    <TipModal
      isOpen={isOpen && showTipModal}
      onClose={() => setShowTipModal(false)}
      baseAmount={tipBaseAmount}
      orderType={orderType}
      selection={tipSelection}
      onApply={setTipSelection}
    />
    </>
  );
};
