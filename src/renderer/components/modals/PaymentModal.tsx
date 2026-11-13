import { useSupportPaymentCritical } from '../../hooks/useSupportPaymentCritical';
import { getStoreCurrency } from '../../utils/store-currency';
import { canChargeFolio } from '../../utils/folio-currency';
import React, { useState, useEffect, useMemo, useRef } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { Coins, AlertTriangle, BedDouble, HandCoins, Gift, Plus } from 'lucide-react';
import { CardsIcon, CashHandIcon, SplitReceiptIcon } from '../icons/PaymentMethodIcons';
import { useTranslation } from 'react-i18next';
import { roundMoney } from '@shared/utils/money';
import { useFeatures } from '../../hooks/useFeatures';
import { useAcquiredModules, MODULE_IDS } from '../../hooks/useAcquiredModules';
import {
  useOrderStore,
  claimOrdinaryCollectionOwner,
  ordinaryCollectionView,
  releaseOrdinaryOwnerBeforeSend,
  type OrdinaryCollectionOwner,
} from '../../hooks/useOrderStore';
import { parseMoneyInputValue } from '../../utils/moneyInput';
import { CentsMoneyInput } from '../ui/CentsMoneyInput';
import { formatCurrency } from '../../utils/format';
import { LiquidGlassModal } from '../ui/pos-glass-components';
import toast from 'react-hot-toast';
import { paymentRefusalMessage } from '../../utils/paymentRefusalMessage';
import { ActivityTracker } from '../../services/ActivityTracker';
import type { GiftCardTenderEvent } from '../../services/GiftCardCheckoutService';
import type { GiftCardScope } from '../../services/GiftCardsApiService';
import { GiftCardTender } from '../payment/GiftCardTender';
import { TwintManualQrTender } from '../payment/TwintManualQrTender';
import { loadTwintManualConfiguration, twintManualMetadata, type TwintManualConfiguration, type TwintConfirmationAction } from '../../services/TwintManualQrService';
import twintLogo from '../../../../../shared/payments/assets/twint-logo.png';
import { admitTwintCollection, loadPendingTwintReceipts, saveOriginalTwintReceipt, twintAdmissionReason } from '../../services/TwintReceiptRecoveryService';
import type { UnsavedChargedPaymentSummary } from '../../../lib/ipc-adapter';
import { ChangingValue } from '../ui/ChangingValue';
import {
  TipModal,
  type TipRecipientRole,
  type TipSelection,
  type TipStaffOption,
} from './TipModal';

const formatMoney = formatCurrency;

export interface RoomChargeContext {
  currency?: string | null;
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

export type PaymentMethodSelection = 'cash' | 'card' | 'room_charge' | 'twint';

export type PaymentCompletionResult = void | boolean | RoomChargeFallbackPrompt;

export interface PaymentCompletionData {
  method: PaymentMethodSelection;
  amount: number;
  transactionId?: string;
  idempotencyKey?: string;
  currency?: string;
  metadata?: ReturnType<typeof twintManualMetadata>;
  driverId?: string;
  cashReceived?: number;
  change?: number;
  tipAmount?: number;
  tipRecipientRole?: TipRecipientRole;
  tipRecipientStaffId?: string;
  tipRecipientStaffShiftId?: string;
  roomId?: string;
  room_id?: string;
  folio_id?: string;
  roomCharge?: RoomChargeContext;
  existingOrderId?: string;
  existingOrderNumber?: string;
  roomChargeFallback?: boolean;
  roomChargeApplied?: boolean;
  /**
   * Existing-order cash/card only: the ordinary collection claim this confirm
   * made. Pass it on unchanged; never claim again, copy, log or persist it.
   */
  ordinaryOwner?: OrdinaryCollectionOwner;
}

/** An existing order this modal collects its outstanding balance for. */
export interface PaymentModalExistingOrder {
  orderId: string;            // real local order ID
  orderSynced: boolean;       // host: supabase id present and sync status synced
  currency: string | null;    // host: fresh giftCardsApiService.getStatus().currency; null refuses gift
  scope: GiftCardScope;       // resolved organization + public terminal
  online: boolean;
  outstandingCents: number;   // integer cents of the current outstanding balance = fixed full gift amount
  giftEnabled: boolean;       // host decision: only the ordinary outstanding flow offers gift
  giftReceiptRecovery?: boolean; // host: reopen a gift-paid order's own Tender for its receipt only
  onGiftEvent?: (event: GiftCardTenderEvent) => void;
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
  currency?: string;
  discountAmount?: number;
  deliveryFee?: number;
  isProcessing?: boolean;
  orderType?: 'pickup' | 'delivery' | 'dine-in';
  minimumOrderAmount?: number; // From delivery zone settings in admin dashboard
  onBeforePayment?: (paymentData: PaymentCompletionData) => Promise<boolean>;
  onPaymentAdmissionCancelled?: () => Promise<boolean>;
  onPaymentComplete: (
    paymentData: PaymentCompletionData,
  ) => PaymentCompletionResult | Promise<PaymentCompletionResult>;
  /** When provided, a "Split" button is rendered alongside Cash/Card in the payment selection step. */
  onSplitPayment?: (tipSelection: TipSelection | null) => void;
  /**
   * The tip to show when the window opens (founder 01/11/2026): the tip chosen before a split the cashier backed
   * out of comes back with the cart. Read only when the window opens.
   */
  initialTipSelection?: TipSelection | null;
  roomChargeContext?: RoomChargeContext | null;
  allowTips?: boolean;
  /** The order's stylists (`staff_id` on its lines): a tip may go to one of them. */
  tipStaffOptions?: TipStaffOption[];
  allowTwint?: boolean;
  /**
   * Collect the outstanding balance of this existing order: cash/card confirms
   * claim its ordinary collection, and the host may offer a fixed full gift card.
   */
  existingOrder?: PaymentModalExistingOrder;
  /**
   * When provided (the host passes it only while nothing is paid on the order), a «Cancel order» action is shown
   * under the payment methods; the host runs its normal cancellation (coordinator 01/11, founder «Ναι, έτσι»).
   */
  onCancelOrder?: () => void;
}

type ModalStep = 'minimum_warning' | 'payment_selection' | 'cash_input' | 'gift' | 'twint';

type CashChangeBreakdownItem = {
  value: number;
  count: number;
  type: 'bill' | 'coin';
};

const CASH_CHANGE_DENOMINATIONS = [50, 20, 10, 5, 2, 1, 0.5, 0.2, 0.1, 0.05];
const QUICK_CASH_ROUNDING_STEPS = [1, 5, 10, 20, 50, 100];
const CASH_CHANGE_CHIP_CLASS =
  'pos-glass-form-card inline-flex min-h-8 items-center gap-1.5 whitespace-nowrap rounded-full! px-2.5! py-1! text-xs font-semibold liquid-glass-modal-text';

// Module audit closure (2026-09-16): one rounding rule for the renderer. The local copy
// rounded 1.005 down to 1.00 (1.005 * 100 is 100.49999999999999 in binary).

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
    'pos-glass-form-card space-y-3 p-3!',
  quickAmountsLabel: 'liquid-glass-modal-text-muted',
  quickAmountSelected: 'border-(--pos-s-sel-bg) bg-(--pos-s-sel-bg) text-(--pos-s-sel-fg)',
  quickAmountIdle:
    'pos-glass-field',
  cashInput:
    'liquid-glass-modal-input pos-glass-field min-h-touch',
  summary: 'pos-glass-form-card',
  summaryDivider: 'space-y-2',
  // Founder 31/10: the change keeps its green; a short amount its red.
  changeTone: hasEnoughCash
    ? 'text-emerald-700 dark:text-emerald-300'
    : 'text-red-700 dark:text-red-300',
  changeChip: CASH_CHANGE_CHIP_CLASS,
  // Wave ΣΤ7: «Ολοκλήρωση» is the kit modal primary (yellow in both themes); short cash = neutral, muted.
  completeButton: hasEnoughCash
    ? 'pos-modal-primary'
    : 'border-(--pos-s-border)! bg-(--pos-s-surface-2)! text-(--pos-s-muted)!',
});

export const CashChangeChip: React.FC<{
  item: CashChangeBreakdownItem;
  formattedValue: string;
}> = ({ item, formattedValue }) => {
  const Icon = item.type === 'bill' ? CashHandIcon : Coins;

  return (
    <span className={CASH_CHANGE_CHIP_CLASS}>
      <Icon
        aria-hidden="true"
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
  onClose: onPaymentClose,
  orderTotal,
  currency,
  discountAmount = 0,
  deliveryFee = 0,
  isProcessing = false,
  orderType,
  minimumOrderAmount = 0, // Default to 0 (no minimum) if not provided
  onPaymentComplete,
  onBeforePayment,
  onPaymentAdmissionCancelled,
  onSplitPayment,
  roomChargeContext = null,
  allowTips = true,
  allowTwint = true,
  existingOrder,
  tipStaffOptions,
  initialTipSelection,
  onCancelOrder,
}) => {
  const { t } = useTranslation();
  const reduceMotion = useReducedMotion();
  const revealMotion = {
    initial: reduceMotion ? false as const : { opacity: 0, height: 0, y: 12, overflow: 'hidden' },
    animate: { opacity: 1, height: 'auto', y: 0, overflow: 'visible' },
    exit: reduceMotion ? { opacity: 0 } : { opacity: 0, height: 0, overflow: 'hidden', transition: { overflow: { delay: 0, duration: 0 } } },
    transition: { duration: reduceMotion ? 0 : 0.24, ease: [0.2, 0.8, 0.2, 1] as const, overflow: { delay: reduceMotion ? 0 : 0.24, duration: 0 } },
  };

  const supportPayment = useSupportPaymentCritical(isOpen);
  const onClose = () => { supportPayment.close(); onPaymentClose(); };
  const { isFeatureEnabled, isMobileWaiter, loading: isFeatureLoading } = useFeatures();
  const { hasModule } = useAcquiredModules();
  const [twintConfiguration, setTwintConfiguration] = useState<TwintManualConfiguration | null>(null);
  const twintSendRef = useRef(false);
  const [pendingTwintReceipts,setPendingTwintReceipts] = useState<UnsavedChargedPaymentSummary[]>([]);
  const [twintRecoveryChecked,setTwintRecoveryChecked] = useState(false);
  const [twintRecovering,setTwintRecovering] = useState(false);
  // Fix review 06/10/2026: the QR is shown only after its admission (fresh
  // configuration, durable receipts, the order's native admission and its
  // ordinary claim). An existing order's claim is held while the QR is shown,
  // so no other collection can start on it, and the confirm reuses it.
  const twintPaymentRef = useRef<PaymentCompletionData | null>(null);
  const [twintAdmitting, setTwintAdmitting] = useState(false);
  const twintAdmissionRef = useRef<{ owner?: OrdinaryCollectionOwner } | null>(null);
  const twintModule = hasModule('plugin_integrations');
  useEffect(() => {
    let current = true;
    setTwintConfiguration(null);
    if (isOpen && twintModule) {
      void loadTwintManualConfiguration().then(value => { if (current) setTwintConfiguration(value); });
    }
    return () => { current = false; };
  }, [isOpen, twintModule]);
  useEffect(() => {
    let current = true;
    setPendingTwintReceipts([]); setTwintRecoveryChecked(false);
    if (isOpen) void loadPendingTwintReceipts(existingOrder?.orderId).then(values => { if(current){setPendingTwintReceipts(values);setTwintRecoveryChecked(true);} }).catch(()=>{});
    return () => { current=false; };
  },[isOpen,existingOrder?.orderId]);
  const canUseTwint = allowTwint && twintModule && twintRecoveryChecked && pendingTwintReceipts.length===0 && Boolean(twintConfiguration) && !roomChargeContext;
  const canUseCash = isFeatureEnabled('cashPayments');
  const canUseCard = isFeatureEnabled('cardPayments');
  const [isProcessingPayment, setIsProcessingPayment] = useState(isProcessing);
  const [cashReceived, setCashReceived] = useState<string>('');
  const [selectedPaymentMethod, setSelectedPaymentMethod] = useState<PaymentMethodSelection | null>(null);
  const formatCurrency = (value: number) => formatMoney(value, currency ?? getStoreCurrency());
  const [roomChargeFallback, setRoomChargeFallback] = useState<RoomChargeFallbackPrompt | null>(null);
  const [showTipModal, setShowTipModal] = useState(false);
  const [tipSelection, setTipSelection] = useState<TipSelection | null>(null);
  const initialTipSelectionRef = useRef<TipSelection | null>(null);
  initialTipSelectionRef.current = initialTipSelection ?? null;
  const cashInputRef = useRef<HTMLInputElement | null>(null);
  // This modal's own existing-order cash/card attempt holds the order's claim.
  const ordinaryAttemptRef = useRef(false);
  const wasOpenRef = useRef(false);
  const canUseRoomCharge =
    !roomChargeFallback &&
    Boolean(roomChargeContext?.roomId && roomChargeContext?.activeFolioId) &&
    canChargeFolio(roomChargeContext?.currency, getStoreCurrency()) &&
    hasModule(MODULE_IDS.ROOMS) &&
    hasModule(MODULE_IDS.ORDERS) &&
    hasModule('guest_billing');
  // The gift card pays the whole outstanding balance, fixed in integer cents,
  // and never joins a room-charge flow or a tip it could not collect.
  const giftOutstandingCents = existingOrder?.outstandingCents;
  const hasGiftAmount =
    typeof giftOutstandingCents === 'number' &&
    Number.isSafeInteger(giftOutstandingCents) &&
    giftOutstandingCents > 0;
  const canUseGiftCard =
    Boolean(existingOrder?.giftEnabled) &&
    hasModule(MODULE_IDS.GIFT_CARDS) &&
    hasGiftAmount &&
    !roomChargeContext &&
    !roomChargeFallback &&
    !(tipSelection?.amount && tipSelection.amount > 0);
  // Receipt reentry for an order a gift card already paid: the modal opens on
  // that order's own Tender at a zero amount and offers no way to collect money.
  const giftReceiptRecovery = Boolean(existingOrder?.giftEnabled && existingOrder.giftReceiptRecovery);
  const hasAnyPaymentMethod = canUseCash || canUseCard || canUseRoomCharge || canUseTwint;
  const paymentOptionCount =
    2 + (onSplitPayment ? 1 : 0) + (canUseRoomCharge ? 1 : 0) + (canUseGiftCard ? 1 : 0) + (canUseTwint ? 1 : 0);
  const paymentGridClass =
    paymentOptionCount >= 4
      ? 'grid-cols-2'
      : paymentOptionCount === 3
        ? 'grid-cols-3'
        : 'grid-cols-2';
  const paymentGridGapClass = paymentOptionCount === 3 ? 'gap-4' : 'gap-6';
  const paymentOptionPaddingClass = paymentOptionCount === 3 ? 'p-4' : 'p-6';
  const paymentMethodLabelBaseClass =
    'w-full text-center text-base font-bold leading-tight tracking-normal hyphens-none whitespace-normal transition-colors duration-300';
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
    giftReceiptRecovery ? 'gift' : isBelowMinimum ? 'minimum_warning' : 'payment_selection'
  );
  const currentStepRef = useRef(currentStep);
  currentStepRef.current = currentStep;
  // Gift step: the Tender pays a fixed amount, never an editable one.
  const giftFixedAmountCents = hasGiftAmount ? (giftOutstandingCents as number) : 0;

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

      // Founder 01/11/2026 («εδω λειπει το 100»): six, so the 100 note is there and the third column is full.
      if (amounts.length >= 6) {
        break;
      }
    }

    return amounts.sort((a, b) => a - b).slice(0, 6);
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
    const reopened = isOpen && !wasOpenRef.current;
    wasOpenRef.current = isOpen;
    if (isOpen) {
      // Only the user or the host leaves the gift step: a processing flag
      // change while open keeps the Tender and its pending receipt action.
      if (!reopened && (currentStepRef.current === 'gift' || currentStepRef.current === 'twint')) {
        setIsProcessingPayment(isProcessing);
        return;
      }
      setCurrentStep(giftReceiptRecovery ? 'gift' : isBelowMinimum ? 'minimum_warning' : 'payment_selection');
      setIsProcessingPayment(isProcessing);
      setCashReceived('');
      setSelectedPaymentMethod(null);
      setRoomChargeFallback(null);
      setShowTipModal(false);
      setTipSelection(initialTipSelectionRef.current);
    }
  }, [isOpen, isProcessing, isBelowMinimum, giftReceiptRecovery]);

  useEffect(() => {
    if (!isOpen || currentStep !== 'cash_input') return;

    const focusTimer = window.setTimeout(() => {
      cashInputRef.current?.focus();
    }, 0);

    return () => window.clearTimeout(focusTimer);
  }, [isOpen, currentStep]);

  // Handle payment method selection
  const handlePaymentMethodSelect = (method: Exclude<PaymentMethodSelection, 'twint'>) => {
    if (giftReceiptRecovery) return;
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

  const ordinaryClaimRefusalText = (code: string): string =>
    code === 'GIFT_CARD_TERMINAL_SCOPE_REQUIRED'
      ? t(
          'giftCardCheckout.refusal.scope',
          'This terminal has no confirmed organization or terminal identity. Pair the POS again.',
        )
      : t('giftCardCheckout.refusal.admission', 'Earlier gift card attempts must be checked first.');

  const handleGiftCardSelect = () => {
    if (pendingTwintReceipts.length || !canUseGiftCard || isProcessingPayment) return;
    setSelectedPaymentMethod(null);
    setCurrentStep('gift');
  };
  const twintRefusalText = (code: string): string => {
    switch (twintAdmissionReason(code)) {
      case 'pending':
        return t('twintPayment.receiptRecovery', 'A TWINT receipt is confirmed but its payment is not saved. Save the original receipt before taking another payment.');
      case 'notSaved':
        return t('twintPayment.admission.notSaved', 'A payment of this order is not saved yet. Save it again before taking TWINT. Nothing was charged.');
      case 'reconcile':
        return t('twintPayment.admission.reconcile', 'An earlier payment step of this order must be checked first. Nothing was charged.');
      case 'platformHeld':
        return t('twintPayment.admission.platformHeld', "The delivery platform holds this order's money. Nothing is collected at the till.");
      case 'amountChanged':
        return t('twintPayment.admission.amountChanged', 'The amount left to pay on this order changed. Check the order and try again. Nothing was charged.');
      default:
        return t('twintPayment.admission.unavailable', "TWINT can't be taken right now. Check the connection or choose another payment. Nothing was charged.");
    }
  };

  /** Ends an admission nothing was sent under (cancel, close, refusal). */
  const releaseTwintAdmission = () => {
    const admission = twintAdmissionRef.current;
    twintAdmissionRef.current = null;
    if (admission?.owner && ordinaryCollectionView(admission.owner)?.phase === 'held') {
      releaseOrdinaryOwnerBeforeSend(admission.owner);
    }
  };

  // The QR is shown only once this order could take the receipt: every
  // refusal comes before the customer pays, never after (fix review 06/10/2026).
  const handleTwintSelect = async () => {
    if (!canUseTwint || twintAdmitting || twintSendRef.current || giftReceiptRecovery || isProcessingPayment) return;
    releaseTwintAdmission();
    let owner: OrdinaryCollectionOwner | undefined;
    if (existingOrder) {
      // Synchronous, before any await: no other collection starts meanwhile.
      const claim = claimOrdinaryCollectionOwner(existingOrder.scope, existingOrder.orderId);
      if (!claim.claimed) { toast.error(ordinaryClaimRefusalText(claim.code)); return; }
      owner = claim.owner;
    }
    setTwintAdmitting(true);
    let admittedHere = false;
    try {
      const paymentData: PaymentCompletionData = { method: 'twint', amount: payableTotal, currency: 'CHF',
        idempotencyKey: crypto.randomUUID(), tipAmount: tipSelection?.amount,
        tipRecipientRole: tipSelection?.recipientRole,
        tipRecipientStaffId: tipSelection?.recipientRole === 'staff' ? tipSelection.recipientStaffId : undefined };
      if (onBeforePayment && !await onBeforePayment(paymentData)) return;
      const admission = await admitTwintCollection({
        orderId: existingOrder?.orderId,
        amount: payableTotal,
        hold: owner?.hold ?? null,
      });
      if (!admission.admitted) {
        await onPaymentAdmissionCancelled?.();
        toast.error(twintRefusalText(admission.code));
        if (admission.code === 'TWINT_RECEIPT_PENDING') {
          const pending = await loadPendingTwintReceipts(existingOrder?.orderId).catch(() => []);
          if (pending.length) setPendingTwintReceipts(pending);
        }
        return;
      }
      twintPaymentRef.current = paymentData;
      twintAdmissionRef.current = { owner };
      admittedHere = true;
      setTwintConfiguration(admission.configuration);
      setCurrentStep('twint');
    } catch {
      toast.error(twintRefusalText('TWINT_ADMISSION_UNAVAILABLE'));
    } finally {
      if (!admittedHere && owner && ordinaryCollectionView(owner)?.phase === 'held') releaseOrdinaryOwnerBeforeSend(owner);
      setTwintAdmitting(false);
    }
  };

  const handleTwintCancel = async () => {
    releaseTwintAdmission();
    setCurrentStep('payment_selection');
    twintPaymentRef.current = null;
    await onPaymentAdmissionCancelled?.();
  };

  const handleTwintConfirm = async (action: TwintConfirmationAction, idempotencyKey: string): Promise<boolean> => supportPayment.run(async () => {
    // Confirmed means the customer paid: once the QR was admitted, nothing
    // here may refuse the receipt before it reaches the native journal.
    if (twintSendRef.current || giftReceiptRecovery) return false;
    let ordinaryOwner: OrdinaryCollectionOwner | undefined = twintAdmissionRef.current?.owner;
    twintAdmissionRef.current = null;
    if (existingOrder && !ordinaryOwner) {
      // A second press of the same receipt (same key) after a failed first one.
      const claim = claimOrdinaryCollectionOwner(existingOrder.scope, existingOrder.orderId);
      if (!claim.claimed) { toast.error(ordinaryClaimRefusalText(claim.code)); return false; }
      ordinaryOwner = claim.owner;
    }
    twintSendRef.current = true; setIsProcessingPayment(true);
    try {
      const result = await onPaymentComplete({ ...(twintPaymentRef.current || { method: 'twint', amount: payableTotal, currency: 'CHF' }),
        idempotencyKey, metadata: twintManualMetadata(action),
        ...(ordinaryOwner ? { ordinaryOwner } : {}) });
      if (result === false) {
        const pending=await loadPendingTwintReceipts(existingOrder?.orderId).catch(()=>[]);
        if(pending.length) { setPendingTwintReceipts(pending);setCurrentStep('payment_selection'); }
      }
      return result !== false && !isRoomChargeFallbackPrompt(result);
    } catch (failure) {
      const pending=await loadPendingTwintReceipts(existingOrder?.orderId).catch(()=>null);
      if (pending?.length) { setPendingTwintReceipts(pending);setCurrentStep('payment_selection'); }
      if (!pending) { setTwintRecoveryChecked(false);setCurrentStep('payment_selection'); }
      // The customer paid: never an invitation to collect again. A receipt
      // this till could not even journal must stay with the cashier.
      const notRetained = (failure as { manualReceiptRetained?: unknown } | null)?.manualReceiptRetained === false;
      toast.error(notRetained
        ? t('twintPayment.returned.notRetained', 'The cashier confirmed TWINT receipt, but this till could not retain it. Do not collect again. Keep the receipt and contact a manager before closing or restarting the POS.')
        : t('twintPayment.confirmNotSaved','The TWINT receipt is not saved yet. Do not collect again. A manager checks it before the POS is closed.'), { duration: 10000 });
      return false;
    } finally {
      if (ordinaryOwner && ordinaryCollectionView(ordinaryOwner)?.phase === 'held') releaseOrdinaryOwnerBeforeSend(ordinaryOwner);
      twintSendRef.current = false; setIsProcessingPayment(false);
    }
  });

  // Simple payment handler - just method, no amount input needed
  const handleSimplePayment = async (method: Exclude<PaymentMethodSelection, 'twint'>) => supportPayment.run(async () => {
    if (pendingTwintReceipts.length) return;
    if (method === 'room_charge' && !canChargeFolio(roomChargeContext?.currency, getStoreCurrency())) return;
    // A receipt reentry never collects money.
    if (giftReceiptRecovery) return;
    // Existing-order cash/card: claim the order before any state change or
    // await, so a gift debit or another collection cannot start meanwhile.
    let ordinaryOwner: OrdinaryCollectionOwner | undefined;
    if (existingOrder && (method === 'cash' || method === 'card')) {
      const claim = claimOrdinaryCollectionOwner(existingOrder.scope, existingOrder.orderId);
      if (!claim.claimed) {
        // A repeated tap during this modal's own attempt stays silent.
        if (!ordinaryAttemptRef.current) toast.error(ordinaryClaimRefusalText(claim.code));
        return;
      }
      ordinaryOwner = claim.owner;
      ordinaryAttemptRef.current = true;
    }
    setIsProcessingPayment(true);
    try {
      const txId = `${method.toUpperCase().replace('_', '-')}-${Date.now()}`;

      const paymentPayload: PaymentCompletionData = {
        method,
        amount: payableTotal,
        transactionId: txId,
        driverId: undefined,
        cashReceived: method === 'cash' ? (cashAmount || payableTotal) : undefined,
        change: method === 'cash' ? (changeAmount > 0 ? changeAmount : 0) : undefined,
        tipAmount: tipSelection?.amount,
        tipRecipientRole: tipSelection?.recipientRole,
        tipRecipientStaffId: tipSelection?.recipientRole === 'staff' ? tipSelection.recipientStaffId : undefined,
        ...(method === 'room_charge' && roomChargeContext
          ? {
              currency: roomChargeContext.currency ?? undefined,
              roomId: roomChargeContext.roomId,
              room_id: roomChargeContext.roomId,
              folio_id: roomChargeContext.activeFolioId ?? undefined,
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
        ...(ordinaryOwner ? { ordinaryOwner } : {}),
      };

      if (onBeforePayment && !await onBeforePayment(paymentPayload)) return;
      // Intentional 500ms delay: gives the user visible feedback that the
      // payment is being processed (the spinner / "processing" state) before
      // the modal closes.  Without this, quick cash payments feel like the
      // button did nothing because the modal dismisses instantly.
      await new Promise(resolve => setTimeout(resolve, 500));

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

      if (method === 'room_charge' && paymentPayload.roomChargeApplied !== true) {
        toast(t('guestBilling.roomChargePending'));
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
      toast.error(paymentRefusalMessage(error, t) ?? t('modals.payment.paymentFailed'));
    } finally {
      if (ordinaryOwner) {
        ordinaryAttemptRef.current = false;
        // Nothing was sent under a claim that is still only held, so end it.
        // Once a send started, only its own reconciliation settles the owner.
        if (ordinaryCollectionView(ordinaryOwner)?.phase === 'held') {
          releaseOrdinaryOwnerBeforeSend(ordinaryOwner);
        }
      }
      setIsProcessingPayment(false);
    }
  });

  // Handle cash payment completion
  const handleCashPaymentComplete = () => {
    if (!hasEnoughCash) {
      toast.error(t('modals.payment.insufficientCash', 'Insufficient cash received'));
      return;
    }
    handleSimplePayment('cash');
  };

  const handleQuickCashSelect = (amount: number) => {
    setCashReceived(Number.isFinite(amount) ? String(roundMoney(Math.max(0, amount))) : '');
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
    // A receipt reentry has no payment selection to return to.
    if (giftReceiptRecovery) {
      handleClose();
      return;
    }
    setCurrentStep('payment_selection');
    setCashReceived('');
    setSelectedPaymentMethod(null);
  };

  // Leaving the QR (closing, unmounting) ends a claim nothing was sent under.
  useEffect(() => {
    if (!isOpen) releaseTwintAdmission();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);
  useEffect(() => () => releaseTwintAdmission(), []);

  const handleClose = () => {
    // Prevent closing while a payment is actively processing
    if (isProcessingPayment) return;
    releaseTwintAdmission();
    // A receipt reentry keeps only its Tender until the host closes the modal.
    if (!giftReceiptRecovery) resetModal();
    onClose();
  };

  const handleModalEnter = () => {
    if (pendingTwintReceipts.length || isProcessingPayment || isFeatureLoading) return;

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
      className="max-w-lg! [&>.liquid-glass-modal-header]:border-b-0!"
      closeOnBackdrop={false}
      closeOnEscape={!isProcessingPayment}
      closeDisabled={isProcessingPayment}
      initialFocusRef={currentStep === 'cash_input' ? cashInputRef : undefined}
      onEnterKey={handleModalEnter}
      enterKeyEnabled={!isProcessingPayment && !isFeatureLoading && canSubmitWithEnter}
      footer={pendingTwintReceipts.length ? undefined : currentStep === 'cash_input' ? (
        <div className="flex gap-3 bg-(--pos-s-surface) px-6 pb-5 pt-2">
          <button onClick={handleBackToPaymentSelection} disabled={isProcessingPayment}
            className="liquid-glass-modal-button flex-1 font-medium liquid-glass-modal-text">
            {t('common.actions.back', 'Back')}
          </button>
          <button onClick={handleCashPaymentComplete} disabled={!hasEnoughCash || isProcessingPayment}
            className={`liquid-glass-modal-button flex-1 font-medium ${cashInputVisualClasses.completeButton} ${!hasEnoughCash || isProcessingPayment ? 'cursor-not-allowed opacity-50' : ''}`}>
            {isProcessingPayment ? t('modals.payment.processing') : t('modals.payment.completeCash', 'Complete')}
          </button>
        </div>
      ) : currentStep === 'gift' ? (
        <div className="flex gap-3 bg-(--pos-s-surface) px-6 pb-5 pt-2">
          <button type="button" onClick={handleBackToPaymentSelection} disabled={isProcessingPayment}
            className="liquid-glass-modal-button flex-1 font-medium liquid-glass-modal-text">
            {t('common.actions.back', 'Back')}
          </button>
        </div>
      ) : undefined}
    >
      {/* Content */}
      <div>
        {/* Order Total with Discount Breakdown */}
        <div className="text-center mb-8">
          <AnimatePresence initial={false}>
            {(discountAmount > 0 || showDeliveryFee || tipAmount > 0) && (
              <motion.div key="discountamount-0-showdeliveryfee-tipamount-0" {...revealMotion} className="pos-glass-form-card mb-4 space-y-2">
                <div className="flex justify-between text-sm">
                  <span className="liquid-glass-modal-text-muted">
                    {t('payment.fields.subtotal')}
                  </span>
                  <span className="liquid-glass-modal-text font-medium">
                    {formatCurrency(subtotalBeforeDiscount)}
                  </span>
                </div>
                <AnimatePresence initial={false}>
                  {discountAmount > 0 && (
                    <motion.div key="discountamount-0" {...revealMotion} className="flex justify-between text-sm">
                      <span className="text-green-500 dark:text-green-400 font-medium">
                        {t('modals.payment.discount')}
                      </span>
                      <span className="text-green-500 dark:text-green-400 font-medium">
                        -{formatCurrency(discountAmount)}
                      </span>
                    </motion.div>
                  )}
                </AnimatePresence>
                <AnimatePresence initial={false}>
                  {showDeliveryFee && (
                    <motion.div key="showdeliveryfee" {...revealMotion} className="flex justify-between text-sm">
                      <span className="liquid-glass-modal-text-muted">
                        {t('payment.fields.deliveryFee')}
                      </span>
                      <span className="liquid-glass-modal-text font-medium">
                        {formatCurrency(deliveryFee)}
                      </span>
                    </motion.div>
                  )}
                </AnimatePresence>
                <AnimatePresence initial={false}>
                  {tipAmount > 0 && (
                    <motion.div key="tipamount-0" {...revealMotion} className="flex justify-between text-sm">
                      <span className="font-medium text-emerald-700 dark:text-emerald-400">
                        {t('modals.payment.tip', 'Tip')}
                      </span>
                      <span className="font-medium text-emerald-700 dark:text-emerald-400">
                        +{formatCurrency(tipAmount)}
                      </span>
                    </motion.div>
                  )}
                </AnimatePresence>
              </motion.div>
            )}
          </AnimatePresence>
          <p className="text-sm liquid-glass-modal-text-muted mb-2">
            {discountAmount > 0 ? t('modals.payment.finalAmount') : t('modals.payment.totalAmount')}
          </p>
          {/* Founder 31/10: the amount due keeps its green. */}
          <p className="text-4xl font-bold text-emerald-700 dark:text-emerald-400 tracking-tight tabular-nums">
            <ChangingValue value={formatCurrency(payableTotal)} />
          </p>
        </div>

        {/* Step: Minimum Order Warning */}
        <AnimatePresence initial={false}>
          {pendingTwintReceipts.length>0 && <motion.div key="twint" {...revealMotion} className="space-y-4" role="alert">
            <p>{t('twintPayment.receiptRecovery','A TWINT receipt is confirmed but its payment is not saved. Save the original receipt before taking another payment.')}</p>
            <button type="button" disabled={twintRecovering} className="liquid-glass-modal-button" onClick={async()=>supportPayment.run(async()=>{
              if(twintRecovering)return; setTwintRecovering(true);
              try {
                if(await saveOriginalTwintReceipt(pendingTwintReceipts[0])) {
                  await useOrderStore.getState().silentRefresh().catch(()=>{});
                  toast.success(t('twintPayment.receiptSaved','The original TWINT receipt was saved.'));
                  onClose();
                } else toast.error(t('twintPayment.saveFailed','The payment could not be saved. Check its status before trying again.'));
              } catch { toast.error(t('twintPayment.saveFailed','The payment could not be saved. Check its status before trying again.')); }
              finally {setTwintRecovering(false);}
            })}>{t('twintPayment.saveOriginal','Save original TWINT receipt')}</button>
          </motion.div>}
        </AnimatePresence>
        <AnimatePresence initial={false}>
          {pendingTwintReceipts.length===0 && currentStep === 'minimum_warning' && (
            <motion.div key="currentstep-minimum_warning" {...revealMotion} className="space-y-4">
              <div className="flex items-center gap-3 p-4 rounded-2xl bg-(--pos-s-warn-bg) border border-(--pos-s-warn)">
                <AlertTriangle className="w-8 h-8 text-(--pos-s-warn) shrink-0" />
                <div>
                  <h3 className="font-semibold text-(--pos-s-warn)">
                    {t('modals.payment.belowMinimumTitle', 'Minimum Order Not Met')}
                  </h3>
                  <p className="text-sm text-(--pos-s-fg)">
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
                  className="liquid-glass-modal-button flex-1 font-medium bg-(--pos-s-surface-2) active:bg-(--pos-s-surface-2) text-orange-800 dark:text-orange-300 border-(--pos-s-border)"
                >
                  {t('modals.payment.skip', 'Skip')}
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <AnimatePresence initial={false}>

          {pendingTwintReceipts.length===0 && currentStep === 'payment_selection' && (
            <motion.div key="currentstep-payment_selection" {...revealMotion} className="relative">
              {allowTips && <button
                type="button"
                onClick={() => setShowTipModal(true)}
                disabled={isProcessingPayment}
                data-depth="off"
                // Founder 01/11: a glass card with the panel depth, like the payment choices under it; a tip already
                // added keeps its green edge.
                className={`payment-tip-row mb-4 flex min-h-14 w-full items-center justify-between gap-3 rounded-2xl border px-4 py-3 text-left transition-colors ${
                  tipAmount > 0
                    ? 'border-emerald-600'
                    : 'border-(--modal-glass-card-border)'
                } ${isProcessingPayment ? 'cursor-not-allowed opacity-50' : 'active:scale-[0.99]'}`}
              >
                <span className="flex items-center gap-3">
                  <HandCoins className="h-6 w-6 shrink-0 text-emerald-500 dark:text-emerald-300" aria-hidden="true" />
                  <span>
                    <span className="block font-bold liquid-glass-modal-text">
                      {tipAmount > 0
                        ? t('modals.payment.editTip', 'Edit tip')
                        : t('modals.payment.addTip', 'Add tip')}
                    </span>
                    <span className="block text-xs liquid-glass-modal-text-muted">
                      {tipSelection
                        ? tipSelection.recipientRole === 'staff'
                          ? tipSelection.recipientStaffName || t('salonStaff.tipRecipient', 'Staff member')
                          : t(`modals.tip.recipients.${tipSelection.recipientRole}`)
                        : t('modals.payment.tipOptional', 'Optional — added before payment')}
                    </span>
                  </span>
                </span>
                {tipAmount > 0 ? (
                  <span className="text-lg font-bold text-emerald-700 dark:text-emerald-400 tabular-nums">{formatCurrency(tipAmount)}</span>
                ) : (
                  <span aria-hidden="true" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-(--pos-s-border) bg-(--pos-s-surface) text-emerald-700 dark:text-emerald-400">
                    <Plus className="h-5 w-5" />
                  </span>
                )}
              </button>}
              <AnimatePresence initial={false}>
                {isFeatureLoading ? (
                  <motion.div key="isfeatureloading" {...revealMotion} className="pos-glass-form-card flex items-center gap-3 w-full">
                    <div className="w-5 h-5 rounded-full border-2 border-(--pos-s-border) border-t-(--pos-s-muted) animate-spin shrink-0" />
                    <div>
                      <h3 className="font-semibold liquid-glass-modal-text">
                        {t('modals.payment.loadingMethods', 'Loading payment methods')}
                      </h3>
                      <p className="text-sm liquid-glass-modal-text-muted">
                        {t('modals.payment.loadingMethodsHint', 'Checking terminal payment configuration...')}
                      </p>
                    </div>
                  </motion.div>
                ) : !hasAnyPaymentMethod ? (
                  <motion.div key="payment-view-1" {...revealMotion} className="flex items-center gap-3 p-4 rounded-2xl bg-(--pos-s-warn-bg) border border-(--pos-s-warn) w-full">
                    <AlertTriangle className="w-6 h-6 text-(--pos-s-warn) shrink-0" />
                    <div>
                      <h3 className="font-semibold text-(--pos-s-warn)">
                        {t('settings.terminal.messages.noPaymentMethods', 'No payment methods available')}
                      </h3>
                      <p className="text-sm text-(--pos-s-fg)">
                        {t('settings.terminal.messages.contactManager', 'Contact your manager for configuration changes.')}
                      </p>
                    </div>
                  </motion.div>
                ) : (
                  <motion.div key="payment-view-2" {...revealMotion} className={`grid ${paymentGridGapClass} ${paymentGridClass}`}>
                    {/* Cash Option */}
                    <button
                      onClick={() => canUseCash && handlePaymentMethodSelect('cash')}
                      disabled={!canUseCash || isProcessingPayment}
                      className={`group relative flex flex-col items-center justify-center ${paymentOptionPaddingClass} rounded-2xl border-2 transition-all duration-300 overflow-hidden
                        ${cashVisualClasses.option}`}
                    >
                      {/* Founder 31/10: his glyphs -- a hand with notes for cash, two cards, a torn receipt. */}
                      <CashHandIcon
                        className={`w-14 h-14 mb-3 transition-all duration-300
                          ${cashVisualClasses.icon}`}
                      />

                      <span className={`${paymentMethodLabelBaseClass}
                        ${cashVisualClasses.label}`}
                      >
                        {t('modals.payment.cashSimple', 'Cash')}
                      </span>

                      {isMobileWaiter && !canUseCash && (
                        <p className="text-xs text-amber-700 dark:text-amber-400 mt-2 text-center">
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
                      <CardsIcon
                        className={`w-14 h-14 mb-3 transition-all duration-300
                          ${cardVisualClasses.icon}`}
                      />

                      <span className={`${paymentMethodLabelBaseClass}
                        ${cardVisualClasses.label}`}
                      >
                        {t('modals.payment.cardSimple', 'Card')}
                      </span>

                      {!canUseCard && (
                        <p className="text-xs text-amber-700 dark:text-amber-400 mt-2 text-center">
                          {t('settings.terminal.messages.featureDisabled', 'Feature disabled for this terminal')}
                        </p>
                      )}
                    </button>

                    {canUseTwint && (
                      <button type="button" disabled={isProcessingPayment || twintAdmitting} aria-busy={twintAdmitting} onClick={() => void handleTwintSelect()}
                        className={`pos-glass-tap-card min-h-touch flex flex-col items-center justify-center ${paymentOptionPaddingClass}`}>
                        <img src={twintLogo} alt="" className="h-14 max-w-full mb-3 rounded-lg" />
                        <span className={paymentMethodLabelBaseClass}>TWINT</span>
                      </button>
                    )}
                    <AnimatePresence initial={false}>
                      {roomChargeContext && !canChargeFolio(roomChargeContext.currency, getStoreCurrency()) && (
                        <motion.p key="roomchargecontext-canchargefolio-roomchargecontext-currency-getstorecurrency" {...revealMotion} role="alert" className="col-span-full text-sm text-amber-600">{t(roomChargeContext.currency ? 'guestBilling.errors.currencyMismatch' : 'guestBilling.errors.currencyUnavailable')}</motion.p>
                      )}
                    </AnimatePresence>
                    {canUseRoomCharge && roomChargeContext && (
                      <button
                        onClick={() => handlePaymentMethodSelect('room_charge')}
                        disabled={isProcessingPayment}
                        className={`pos-glass-tap-card min-h-touch group relative flex flex-col items-center justify-center ${paymentOptionPaddingClass} transition-all duration-300 overflow-hidden
                          ${isProcessingPayment ? 'opacity-50 cursor-not-allowed' : ''}`}
                      >
                        <BedDouble
                          className={`w-14 h-14 mb-3 transition-all duration-300
                            ${isProcessingPayment ? 'text-gray-400' : 'text-amber-700 dark:text-amber-400'}`}
                          strokeWidth={1.5}
                        />

                        <span className={`${paymentMethodLabelBaseClass}
                          ${isProcessingPayment ? 'text-gray-400' : 'text-amber-700 dark:text-amber-400'}`}
                        >
                          {t('modals.payment.roomChargeSimple', 'Room')}
                        </span>
                        <p className="mt-2 max-w-36 truncate text-center text-xs liquid-glass-modal-text-muted">
                          {roomChargeContext.roomNumber
                            ? t('modals.payment.roomChargeRoom', 'Room {{roomNumber}}', { roomNumber: roomChargeContext.roomNumber })
                            : t('modals.payment.roomChargeLabel', 'Charge to room')}
                        </p>
                      </button>
                    )}

                    {/* Gift Card Option — existing orders only, for the whole outstanding balance */}
                    {canUseGiftCard && (
                      <button
                        type="button"
                        onClick={handleGiftCardSelect}
                        disabled={isProcessingPayment}
                        className={`pos-glass-tap-card min-h-touch group relative flex flex-col items-center justify-center ${paymentOptionPaddingClass} transition-all duration-300 overflow-hidden
                          ${isProcessingPayment ? 'opacity-50 cursor-not-allowed' : ''}`}
                      >
                        <Gift
                          className={`w-14 h-14 mb-3 transition-all duration-300
                            ${isProcessingPayment ? 'text-gray-400' : 'text-violet-400'}`}
                          strokeWidth={1.5}
                        />

                        <span className={`${paymentMethodLabelBaseClass}
                          ${isProcessingPayment ? 'text-gray-400' : 'text-violet-400'}`}
                        >
                          {t('giftCardCheckout.title', 'Gift card')}
                        </span>
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
                        <SplitReceiptIcon
                          className={`w-14 h-14 mb-3 transition-all duration-300
                            ${splitVisualClasses.icon}`}
                        />

                        <span className={`${paymentMethodLabelBaseClass}
                          ${splitVisualClasses.label}`}
                        >
                          {t('modals.payment.splitSimple', 'Split')}
                        </span>
                      </button>
                    )}
                  </motion.div>
                )}
              </AnimatePresence>

              {/* An unpaid order taken to payment can still be cancelled (the host's normal cancel): the kit's
                  raised button with red words. */}
              {onCancelOrder && (
                <button
                  type="button"
                  data-testid="payment-cancel-order"
                  onClick={onCancelOrder}
                  disabled={isProcessingPayment}
                  className="pos-solid-btn pos-solid-btn--md pos-solid-btn--danger mt-4 w-full"
                >
                  {t('modals.payment.cancelOrder', 'Cancel order')}
                </button>
              )}

              {/* Processing indicator */}
              <AnimatePresence initial={false}>
                {isProcessingPayment && (
                  <motion.div key="isprocessingpayment" {...revealMotion} className="mt-4 text-center">
                    <p className="text-sm liquid-glass-modal-text-muted animate-pulse">
                      {t('modals.payment.processing')}
                    </p>
                  </motion.div>
                )}
              </AnimatePresence>

              <AnimatePresence initial={false}>

                {roomChargeFallback && !isProcessingPayment && (
                  <motion.div key="roomchargefallback-isprocessingpayment" {...revealMotion} className="mt-4 flex items-center gap-3 rounded-2xl bg-(--pos-s-warn-bg) border border-(--pos-s-warn) p-4">
                    <AlertTriangle className="h-5 w-5 shrink-0 text-(--pos-s-warn)" />
                    <p className="text-sm text-(--pos-s-fg)">
                      {t(
                        'modals.payment.roomChargeFallback',
                        'Room charge was not applied. Collect cash or card payment for this order.',
                      )}
                    </p>
                  </motion.div>
                )}
              </AnimatePresence>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Step: Cash Input (only for pickup/in-store) */}
        {pendingTwintReceipts.length===0 && currentStep === 'twint' && twintConfiguration && (
          <TwintManualQrTender configuration={twintConfiguration} amount={twintPaymentRef.current?.amount ?? payableTotal}
            idempotencyKey={twintPaymentRef.current?.idempotencyKey}
            externalEnabled={hasModule('customer_display')} onConfirm={handleTwintConfirm}
            onCancel={handleTwintCancel} />
        )}
        <AnimatePresence initial={false}>
          {pendingTwintReceipts.length===0 && currentStep === 'cash_input' && (
            <motion.div key="currentstep-cash_input" {...revealMotion} className="space-y-3">
              <AnimatePresence initial={false}>
                {quickCashAmounts.length > 0 && (
                  <motion.div key="quickcashamounts-length-0" {...revealMotion} className={cashInputVisualClasses.quickAmountsPanel}>
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
                            className={`min-h-11 rounded-xl px-3 py-2 text-sm font-bold transition-all ${
                              isSelected
                                ? cashInputVisualClasses.quickAmountSelected
                                : cashInputVisualClasses.quickAmountIdle
                            } ${isProcessingPayment ? 'cursor-not-allowed opacity-50' : ''}`}
                          >
                            {formatCurrency(amount)}
                          </button>
                        );
                      })}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>

              <div className="pos-glass-form-card text-center">
                <p className="text-xs font-semibold liquid-glass-modal-text-muted mb-1.5">
                  {t('modals.payment.enterCashReceived', 'Cash Received')}
                </p>
                <CentsMoneyInput
                  ref={cashInputRef}
                  aria-label={t('modals.payment.enterCashReceived', 'Cash Received')}
                  value={cashReceived}
                  onValueChange={setCashReceived}
                  placeholder="0,00"
                  autoFocus
                  className={`w-full p-4 text-center text-3xl font-bold outline-hidden transition-colors ${cashInputVisualClasses.cashInput}`}
                />
              </div>

              <AnimatePresence initial={false}>

                {cashReceived && (
                  <motion.div key="cashreceived" {...revealMotion} className={`transition-colors ${cashInputVisualClasses.summary}`}>
                    {/* Founder 31/10: only what is new -- the total is at the top, the received amount in the field. */}
                    <div className="flex justify-between items-center">
                      <span className={`font-semibold ${cashInputVisualClasses.changeTone}`}>
                        {hasEnoughCash
                          ? t('modals.payment.change', 'Change')
                          : t('modals.payment.amountShort', 'Amount Short')}
                      </span>
                      <span className={`text-2xl font-bold ${cashInputVisualClasses.changeTone}`}>
                        <ChangingValue value={hasEnoughCash ? formatCurrency(changeAmount) : formatCurrency(amountShort)} />
                      </span>
                    </div>
                    <AnimatePresence initial={false}>
                      {hasEnoughCash && changeAmount > 0 && changeBreakdown.length > 0 && (
                        <motion.div key="hasenoughcash-changeamount-0-changebreakdown-length-0" {...revealMotion} className={`mt-3 pt-3 ${cashInputVisualClasses.summaryDivider}`}>
                          <p className="mb-2 text-xs font-semibold tracking-normal liquid-glass-modal-text-muted">
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
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </motion.div>
                )}
              </AnimatePresence>

            </motion.div>
          )}
        </AnimatePresence>

        {/* Step: Gift card (existing order). The Tender owns the debit and its
            receipt action; it stays mounted after a payment until the user or
            the host closes it, and this modal never completes a gift payment. */}
        {pendingTwintReceipts.length===0 && currentStep === 'gift' && existingOrder && (
          <GiftCardTender
            orderId={existingOrder.orderId}
            orderSynced={existingOrder.orderSynced}
            currency={existingOrder.currency}
            scope={existingOrder.scope}
            online={existingOrder.online}
            fixedAmountCents={giftFixedAmountCents}
            onEvent={existingOrder.onGiftEvent}
          />
        )}
      </div>
    </LiquidGlassModal>
    <TipModal
      isOpen={allowTips && isOpen && showTipModal}
      onClose={() => setShowTipModal(false)}
      baseAmount={tipBaseAmount}
      orderType={orderType}
      selection={tipSelection}
      onApply={setTipSelection}
      staffOptions={tipStaffOptions}
    />
    </>
  );
};
