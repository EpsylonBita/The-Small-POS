import { getStoreCurrency } from '../../utils/store-currency';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { roundMoney } from '@shared/utils/money';
import { formatCurrencyInput, parseCurrencyDigits } from '@shared/utils/currencyInput';
import { useTranslation } from 'react-i18next';
import { motion, AnimatePresence } from 'framer-motion';
import { Banknote, BadgePercent, Check, ChevronDown, CreditCard, Loader2, Plus, ShoppingCart, Split, Trash2, Users } from 'lucide-react';
import toast from 'react-hot-toast';

import { getBridge } from '../../../lib';
import type { PaymentSettlementSnapshot } from '../../../lib/ipc-adapter';
import { usePaymentPrintPrompt } from '../../hooks/usePaymentPrintPrompt';
import { createInFlightGuard, settleDraftPortions, settleTerminalPortion, toTerminalCardPortion, type InFlightGuard, type SplitOrderFinancials, type TerminalSettlementResult } from '../../utils/splitPaymentSettlement';
import { LiquidGlassModal } from '../ui/pos-glass-components';
import './split-payment-modal.css';
import { PlatformHeldPaymentNotice, usePlatformHeldNoticeForOrderId } from '../ui/PlatformHeldPaymentNotice';
import { formatCurrency } from '../../utils/format';
import { isPaymentSetAsideError, PAYMENT_SET_ASIDE_TOAST_MS, throwIfPaymentSetAside } from '../../utils/paymentSetAside';
import { isPaymentNotSavedError, PAYMENT_NOT_SAVED_TOAST_MS, pendingNotSavedMessage, throwIfPaymentNotSaved, useUnsavedChargedPayments } from '../../utils/unsavedPayments';
import { UnsavedChargedPaymentBanner } from '../ui/UnsavedChargedPaymentBanner';
import {
  admitManualCard,
  lookupCardTerminal,
  manualCardNoticeText,
  manualCardRecordRefusalText,
  terminalLookupNotice,
} from '../../services/ManualCardAdmissionService';
import {
  claimOrdinaryCollectionOwner,
  classifyOrdinaryTerminalReply,
  classifyOrdinaryWrite,
  noteOrdinaryTerminalTransaction,
  noteOrdinaryBatchWrite,
  noteOrdinaryWriteFacts,
  ordinaryCollectionView,
  probeOrdinaryOwner,
  readOrdinaryWriteReply,
  releaseOrdinaryOwnerBeforeSend,
  retainedOrdinaryOwner,
  runOrdinaryCollection,
  type OrdinaryCollectionFacts,
  type OrdinaryCollectionOwner,
  type OrdinaryCollectionScope,
  type OrdinaryCollectionVerdict,
  type OrdinaryTerminalVerdict,
} from '../../hooks/useOrderStore';

export interface CartItem { name: string; quantity: number; totalPrice: number; price?: number; itemIndex?: number; isSynthetic?: boolean; [key: string]: any }
type TabMode = 'by-amount' | 'by-items';
type ReceiptMode = 'combined' | 'individual';
// `unsaved`: a terminal portion charged on this till whose payment could not
// be saved yet (30/09/2026): never a chargeable draft again.
type PortionStatus = 'draft' | 'processing' | 'paid' | 'unsaved';
type PaymentOrigin = 'manual' | 'terminal';

export interface SplitPortion {
  id: string; label: string; method: 'cash' | 'card'; amount: number; grossAmount: number; discountAmount: number;
  items: CartItem[]; status: PortionStatus; cashReceived?: number; changeGiven?: number; paymentId?: string;
  transactionRef?: string; paymentOrigin?: PaymentOrigin; terminalDeviceId?: string; paidAt?: string;
  collectedBy?: 'cashier_drawer' | 'driver_shift';
  /**
   * A card taken on the shop's own machine, recorded by hand. Set only after
   * the manual card admission (no terminal on this till and a fresh server
   * "no provider connected"); Confirm asks that admission again before it
   * records, and books no other draft card portion (06/10/2026).
   */
  manualCardFallback?: boolean;
  /**
   * The discount the cashier asked for. `discountAmount` is the effective
   * part of it, never more than `grossAmount` (C2, 06/10/2026: digit entry of
   * the amount passes through 0,02 on its way to 25,00).
   */
  requestedDiscountAmount?: number;
}

export interface SplitPaymentResult {
  mode: TabMode; portions: SplitPortion[]; receiptMode: ReceiptMode; paymentIds: string[];
  paymentStatus: 'paid' | 'partially_paid'; remainingAmount: number; recordedAmount: number;
}

export interface SplitPaymentCollectionMode {
  enabled: boolean;
  allowDriverShift?: boolean;
  defaultCollectedBy?: 'cashier_drawer' | 'driver_shift';
  label?: string;
  description?: string;
}

interface SplitPaymentModalProps {
  isOpen: boolean; onClose: () => void; orderId: string; orderTotal: number; items: CartItem[];
  onSplitComplete: (result: SplitPaymentResult) => void | Promise<void>; existingPayments?: any[];
  initialMode?: TabMode; isGhostOrder?: boolean; collectionMode?: SplitPaymentCollectionMode;
  allowDiscounts?: boolean; isReconciliationPending?: boolean;
  /** Existing-order ordinary collection scope of this terminal; when set (null fails closed) every charge and confirm runs under the order's ordinary claim. */
  collectionScope?: OrdinaryCollectionScope | null;
}

type OrderFinancialState = SplitOrderFinancials;

interface SplitStateSnapshot {
  payments: any[];
  paidIndices: number[];
  financials: OrderFinancialState;
  outstanding: number;
}

const EMPTY_EXISTING_PAYMENTS: any[] = [];
// Gap review P0-01 (+ review round 2): the synchronous double-charge guard is
// MODULE-scoped, not per-instance. There is one physical payment terminal; a
// per-instance ref dies with the modal, so closing the modal during the
// pre-flight window and reopening it would hand a fresh, unlocked guard to a
// second charge while the first is still running headless on the ECR.
const terminalChargeGuard: InFlightGuard = createInFlightGuard();
// Sentinel id: the Confirm Split settlement holds the same guard so a manual
// confirm cannot run concurrently with an in-flight terminal charge (the
// review found Card-tap + Confirm during pre-flight double-collects).
const CONFIRM_SETTLEMENT_GUARD_ID = '__confirm-settlement__';
type DraftSettlement = Awaited<ReturnType<typeof settleDraftPortions>>;
type DirectSale = NonNullable<PaymentSettlementSnapshot['unresolvedDirectSale']>;
let nextGeneratedPortionId = 1;
// Module audit closure (2026-09-16): one rounding rule for the renderer. The local copy
// rounded on the binary product, so it sent 1.005 to 1.00.
const round2 = (value: number) => roundMoney(value);
const nextPortionId = () => `portion-${nextGeneratedPortionId++}-${Date.now()}`;
const unwrapBridgeArray = <T,>(result: any): T[] => Array.isArray(result) ? result : Array.isArray(result?.data) ? result.data : [];
const isCompletedPaymentRecord = (payment: any) => ['completed', 'paid'].includes(String(payment?.status || '').toLowerCase());
const getNetRecordedPaymentAmount = (payment: any) => round2(Math.max(
  0,
  Number(
    payment?.remainingRefundable
      ?? (Number(payment?.amount || 0) - Number(payment?.refundedAmount || 0)),
  ) || 0,
));
const extractPaymentId = (result: any) => (typeof result?.paymentId === 'string' ? result.paymentId : typeof result?.data?.paymentId === 'string' ? result.data.paymentId : undefined);
const extractTransactionDetails = (raw: any) => {
  const tx = raw?.transaction ?? raw?.data?.transaction ?? raw?.data ?? raw ?? {};
  return { success: raw?.success === true, status: String(tx?.status || raw?.status || '').toLowerCase(), transactionId: tx?.transactionId ?? tx?.id ?? raw?.transactionId ?? raw?.id ?? '', errorMessage: tx?.errorMessage ?? raw?.error ?? raw?.data?.error };
};
// C2 (06/10/2026): the cashier's discount is kept as asked and only its
// effective part follows the gross. Digit entry passes through 0,02 / 0,25 /
// 2,50 on the way to 25,00; clamping the stored discount at each keystroke
// turned a 5,00 discount into 0,02 for good.
const applyPortionFinancials = (portion: SplitPortion, grossAmount: number, requestedDiscount = portion.requestedDiscountAmount ?? portion.discountAmount): SplitPortion => {
  const gross = round2(Math.max(0, grossAmount));
  const requested = round2(Math.max(0, Number.isFinite(requestedDiscount) ? requestedDiscount : 0));
  const discount = round2(Math.min(requested, gross));
  return { ...portion, grossAmount: gross, requestedDiscountAmount: requested, discountAmount: discount, amount: round2(gross - discount) };
};
// C1 (06/10/2026): only a terminal reply with the exact transaction and a
// final `declined` status proves the card was declined and no money moved
// (native also stops counting such a SALE). Those refusals are marked so the
// portion can say "declined, nothing charged"; any other failure may hide a
// charge and keeps its own message.
const provenCardDeclines = new WeakSet<Error>();
const isProvenDeclineReply = (raw: unknown, threw = false): boolean => !threw
  && classifyOrdinaryTerminalReply(raw, threw).verdict === 'not_sent'
  && extractTransactionDetails(raw).status.trim() === 'declined';
const cardNotApproved = (message: string | null | undefined, provenDecline: boolean): Error => {
  const error = new Error(message || 'Card payment was not approved');
  if (provenDecline) provenCardDeclines.add(error);
  return error;
};
const createPortion = (label: string, grossAmount: number): SplitPortion => applyPortionFinancials({ id: nextPortionId(), label, method: 'cash', amount: round2(grossAmount), grossAmount: round2(grossAmount), discountAmount: 0, items: [], status: 'draft', paymentOrigin: 'manual' }, grossAmount);
// Round 298 (third correction): a by-items portion is "compact-eligible" when it is an untouched draft --
// no assigned items, nothing payable, and no discount. Such cards render a short label / "no items" / 0,00 €
// summary instead of the full renderPortionDetails settlement stack, so the two initial empty People cards
// fit above the footer on first open. Any assigned items / positive amount / discount / paid|processing
// state flips it back to the full details + payment controls (no real functionality is removed).
const isEmptyByItemsPortion = (portion: SplitPortion): boolean => portion.status === 'draft' && portion.items.length === 0 && portion.amount <= 0.009 && portion.discountAmount <= 0.009;
const extractOrderFinancialState = (order: any, fallbackTotal: number): OrderFinancialState => {
  const totalAmount = round2(Number(order?.total_amount ?? order?.totalAmount ?? order?.total ?? fallbackTotal));
  const discountAmount = round2(Number(order?.discount_amount ?? order?.discountAmount ?? 0));
  const discountPercentage = round2(Number(order?.discount_percentage ?? order?.discountPercentage ?? 0));
  const taxAmount = round2(Number(order?.tax_amount ?? order?.taxAmount ?? order?.tax ?? 0));
  const deliveryFee = round2(Number(order?.delivery_fee ?? order?.deliveryFee ?? 0));
  const tipAmount = round2(Number(order?.tip_amount ?? order?.tipAmount ?? 0));
  // Prices include VAT: a missing subtotal holds it, nothing sits on top (07/10/2026).
  const subtotal = round2(Number(order?.subtotal ?? (totalAmount + discountAmount - deliveryFee - tipAmount)));
  return { totalAmount, subtotal, discountAmount, discountPercentage, taxAmount, deliveryFee, tipAmount };
};

const SplitAmountInput: React.FC<{
  amount: number; label: string; disabled: boolean; onAmountChange: (amount: number) => void;
}> = ({ amount, label, disabled, onAmountChange }) => {
  const [text, setText] = useState(() => formatCurrencyInput(amount));
  useEffect(() => setText(formatCurrencyInput(amount)), [amount]);
  return (
    <input
      type="text"
      inputMode="numeric"
      aria-label={label}
      className="split-payment-money-input w-full py-2 pl-12 pr-3 font-medium disabled:cursor-not-allowed disabled:opacity-70"
      value={text}
      disabled={disabled}
      onFocus={(event) => event.currentTarget.select()}
      onBlur={() => setText(formatCurrencyInput(amount))}
      onChange={(event) => {
        const next = parseCurrencyDigits(event.currentTarget.value);
        if (next === null) return;
        setText(event.currentTarget.value === '' ? '' : formatCurrencyInput(next));
        onAmountChange(next);
      }}
    />
  );
};

export const SplitPaymentModal: React.FC<SplitPaymentModalProps> = ({ isOpen, onClose, orderId, orderTotal, items, onSplitComplete, existingPayments = EMPTY_EXISTING_PAYMENTS, initialMode = 'by-amount', isGhostOrder = false, collectionMode, allowDiscounts = true, isReconciliationPending = false, collectionScope }) => {
  const { t } = useTranslation();
  const bridge = getBridge();
  const viewEpoch = useRef(0);
  useEffect(() => {
    const epoch = ++viewEpoch.current;
    return () => { if (viewEpoch.current === epoch) viewEpoch.current++; };
  }, [isOpen, orderId, collectionScope?.organizationId, collectionScope?.terminalId]);
  // Mirrors the module-scoped guard into render state so the UI can lock the
  // modal (close, inputs, Confirm) for the WHOLE guarded window — including
  // the pre-flight IPC that runs before portion.status flips to 'processing'.
  const [isTerminalChargeInFlight, setIsTerminalChargeInFlight] = useState(false);
  const { askForPaymentPrint, paymentPrintPromptModal } = usePaymentPrintPrompt();
  const personLabel = useCallback((index: number) => `${t('splitPayment.person', 'Person')} ${index + 1}`, [t]);

  const [activeTab, setActiveTab] = useState<TabMode>(initialMode);
  const [receiptMode, setReceiptMode] = useState<ReceiptMode>('combined');
  const [portions, setPortions] = useState<SplitPortion[]>([]);
  const [completedPayments, setCompletedPayments] = useState<any[]>([]);
  const [paidItemIndices, setPaidItemIndices] = useState<number[]>([]);
  const [itemAssignments, setItemAssignments] = useState<Record<number, string>>({});
  const [openAssignmentItemIndex, setOpenAssignmentItemIndex] = useState<number | null>(null);
  const [orderFinancials, setOrderFinancials] = useState<OrderFinancialState>({ totalAmount: round2(orderTotal), subtotal: round2(orderTotal), discountAmount: 0, discountPercentage: 0, taxAmount: 0, deliveryFee: 0, tipAmount: 0 });
  const [isInitializing, setIsInitializing] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [discountEditorPortionId, setDiscountEditorPortionId] = useState<string | null>(null);
  const [discountDraftValue, setDiscountDraftValue] = useState('');

  const defaultCollectedBy = useMemo<'cashier_drawer' | 'driver_shift' | undefined>(() => {
    if (!collectionMode?.enabled) {
      return undefined;
    }
    return collectionMode.defaultCollectedBy
      ?? (collectionMode.allowDriverShift ? 'driver_shift' : 'cashier_drawer');
  }, [collectionMode]);
  const withCollectionDefaults = useCallback((portion: SplitPortion): SplitPortion => (
    defaultCollectedBy ? { ...portion, collectedBy: portion.collectedBy ?? defaultCollectedBy } : portion
  ), [defaultCollectedBy]);

  const normalizedItems = useMemo<CartItem[]>(() => items.map((item, index) => {
    const quantity = Math.max(1, Number(item.quantity || 1));
    const itemIndex = Number.isInteger(item.itemIndex) ? Number(item.itemIndex) : index;
    const totalPrice = round2(Number(item.totalPrice ?? ((item.price || 0) * quantity)));
    const price = round2(quantity > 0 ? Number(item.price ?? (totalPrice / quantity)) : Number(item.price || 0));
    return { ...item, quantity, itemIndex, price, totalPrice };
  }), [items]);
  const buildFallbackSplitState = useCallback((): SplitStateSnapshot => {
    const payments = unwrapBridgeArray<any>(existingPayments).filter(isCompletedPaymentRecord);
    const financials = extractOrderFinancialState(null, orderTotal);
    return {
      payments,
      paidIndices: [],
      financials,
      outstanding: round2(Math.max(0, financials.totalAmount - payments.reduce((sum, payment) => sum + getNetRecordedPaymentAmount(payment), 0))),
    };
  }, [existingPayments, orderTotal]);
  const fetchLatestSplitState = useCallback(async (): Promise<SplitStateSnapshot> => {
    const [paymentResult, paidItemsResult, orderResult] = await Promise.all([
      bridge.payments.getOrderPayments(orderId),
      bridge.payments.getPaidItems(orderId),
      bridge.orders.getById(orderId),
    ]);
    const payments = unwrapBridgeArray<any>(paymentResult).filter(isCompletedPaymentRecord);
    const paidIndices = unwrapBridgeArray<any>(paidItemsResult)
      .map((item: any) => Number(item?.itemIndex ?? item?.item_index))
      .filter((itemIndex: number) => Number.isInteger(itemIndex));
    const financials = extractOrderFinancialState(orderResult, orderTotal);
    return {
      payments,
      paidIndices,
      financials,
      outstanding: round2(Math.max(0, financials.totalAmount - payments.reduce((sum, payment) => sum + getNetRecordedPaymentAmount(payment), 0))),
    };
  }, [bridge, orderId, orderTotal]);

  const alreadyPaidAmount = useMemo(
    () => round2(completedPayments.reduce((sum, payment) => sum + getNetRecordedPaymentAmount(payment), 0)),
    [completedPayments],
  );
  const paidItemIndexSet = useMemo(() => new Set(paidItemIndices), [paidItemIndices]);
  const availableItems = useMemo(() => {
    const unpaidItems = normalizedItems.filter((item) => !paidItemIndexSet.has(Number(item.itemIndex ?? 0)));
    const unpaidTotal = round2(unpaidItems.reduce((sum, item) => sum + item.totalPrice, 0));
    const persistedOutstanding = round2(Math.max(0, orderFinancials.totalAmount - alreadyPaidAmount));
    const adjustment = round2(persistedOutstanding - unpaidTotal);
    if (Math.abs(adjustment) >= 0.01) unpaidItems.push({ name: adjustment < 0 ? t('splitPayment.priorPayments', 'Prior Payments') : t('splitPayment.balanceAdjustment', 'Balance Adjustment'), quantity: 1, price: adjustment, totalPrice: adjustment, itemIndex: unpaidItems.reduce((max, item) => Math.max(max, Number(item.itemIndex ?? 0)), -1) + 1, isSynthetic: true });
    return unpaidItems;
  }, [alreadyPaidAmount, normalizedItems, orderFinancials.totalAmount, paidItemIndexSet, t]);
  const persistedOutstanding = useMemo(() => round2(Math.max(0, orderFinancials.totalAmount - alreadyPaidAmount)), [alreadyPaidAmount, orderFinancials.totalAmount]);
  const processingPortionId = useMemo(() => portions.find((portion) => portion.status === 'processing')?.id ?? null, [portions]);
  // Money the platform is holding (prepaid online, or COD its own rider
  // collected) is never collected here. Reuses the existing collect lock so
  // every confirm/portion path is covered at once, and the banner below says
  // why instead of leaving the operator to meet the write path's refusal as a
  // generic error (founder request, 16/09/2026).
  //
  // Read from the order's own disposition, NOT from `payment_status`: a failed
  // settlement honestly lowers that to `pending`, which reads exactly like
  // money still owed.
  const platformHeldNotice = usePlatformHeldNoticeForOrderId(orderId, isOpen);
  const platformHeld = platformHeldNotice !== null;
  // A card of this order charged on this till and not saved yet (30/09/2026):
  // shown with Save payment again, and no portion is charged or confirmed
  // while it stands.
  // Saved again, the charged card's row is in the ledger: the retained
  // ordinary claim of the order settles from it and the split shows the order
  // as it now stands (`onUnsavedSavedRef` is set once the state readers exist).
  const onUnsavedSavedRef = useRef<() => Promise<void>>(async () => undefined);
  const onUnsavedSaved = useCallback(() => onUnsavedSavedRef.current(), []);
  const unsaved = useUnsavedChargedPayments(orderId, isOpen, t, formatCurrency, onUnsavedSaved);
  const unsavedLocked = unsaved.payments.length > 0;
  const isCloseLocked = isReconciliationPending || Boolean(processingPortionId) || isProcessing || isTerminalChargeInFlight;
  const activeDiscountTotal = useMemo(() => round2(portions.filter((portion) => portion.status !== 'paid').reduce((sum, portion) => sum + portion.discountAmount, 0)), [portions]);
  const assignedDraftAmount = useMemo(() => round2(portions.filter((portion) => portion.status !== 'paid').reduce((sum, portion) => sum + portion.amount, 0)), [portions]);
  const adjustedDue = useMemo(() => round2(Math.max(0, persistedOutstanding - activeDiscountTotal)), [activeDiscountTotal, persistedOutstanding]);
  const remaining = useMemo(() => round2(adjustedDue - assignedDraftAmount), [adjustedDue, assignedDraftAmount]);
  const hasPositiveAssignment = useMemo(() => portions.some((portion) => portion.status !== 'paid' && portion.amount > 0.009), [portions]);
  const anyItemsAssigned = useMemo(() => activeTab !== 'by-items' || availableItems.some((item) => itemAssignments[Number(item.itemIndex ?? 0)] !== undefined), [activeTab, availableItems, itemAssignments]);
  // C1 (06/10/2026): Confirm books a card portion only as an admitted manual
  // card (its notice is on screen). A card the terminal refused, or one not
  // charged yet, is never a confirmable draft.
  const hasCardDraftWithoutManualNotice = useMemo(() => portions.some((portion) => portion.status === 'draft' && portion.amount > 0.009 && portion.method === 'card' && portion.manualCardFallback !== true), [portions]);
  const canConfirm = useMemo(() => hasPositiveAssignment && !hasCardDraftWithoutManualNotice && anyItemsAssigned && remaining >= -0.01 && !unsavedLocked && !isInitializing && !isProcessing && !processingPortionId && !isTerminalChargeInFlight && !isReconciliationPending && !platformHeld, [anyItemsAssigned, hasCardDraftWithoutManualNotice, hasPositiveAssignment, isInitializing, isProcessing, isReconciliationPending, isTerminalChargeInFlight, platformHeld, processingPortionId, remaining, unsavedLocked]);

  const getPortion = useCallback((portionId: string) => portions.find((portion) => portion.id === portionId) ?? null, [portions]);
  const updatePortion = useCallback((portionId: string, updater: (portion: SplitPortion) => SplitPortion) => setPortions((current) => current.map((portion) => portion.id === portionId ? updater(portion) : portion)), []);
  const initializePortions = useCallback((mode: TabMode, amountDue: number) => {
    const half = round2(amountDue / 2);
    const initialPortions = mode === 'by-items'
      ? [createPortion(personLabel(0), 0), createPortion(personLabel(1), 0)]
      : [createPortion(personLabel(0), half), createPortion(personLabel(1), round2(amountDue - half))];
    setPortions(initialPortions.map(withCollectionDefaults));
    setActiveTab(mode);
    setReceiptMode('combined');
    setItemAssignments({});
    setOpenAssignmentItemIndex(null);
    setDiscountEditorPortionId(null);
    setDiscountDraftValue('');
  }, [personLabel, withCollectionDefaults]);
  const applySplitStateSnapshot = useCallback((snapshot: SplitStateSnapshot, options?: { resetDraft?: boolean; mode?: TabMode }) => {
    setOrderFinancials(snapshot.financials);
    setCompletedPayments(snapshot.payments);
    setPaidItemIndices(Array.from(new Set(snapshot.paidIndices)));
    if (options?.resetDraft) {
      // Default to initialMode (a stable prop), never the live activeTab. Every
      // caller passes an explicit mode, so this only changes the callback's
      // identity stability: depending on activeTab here made the load-state effect
      // (which depends on this callback) re-run on every tab click and reset the
      // tab back to initialMode, making the "By Item" tab unreachable.
      initializePortions(options.mode ?? initialMode, snapshot.outstanding);
    }
  }, [initialMode, initializePortions]);
  const hasLiveSplitStateDrift = useCallback((snapshot: SplitStateSnapshot) => {
    if (Math.abs(snapshot.financials.totalAmount - orderFinancials.totalAmount) >= 0.01) {
      return true;
    }
    if (Math.abs(snapshot.outstanding - persistedOutstanding) >= 0.01) {
      return true;
    }
    const snapshotPaidAmount = round2(snapshot.payments.reduce((sum, payment) => sum + getNetRecordedPaymentAmount(payment), 0));
    if (Math.abs(snapshotPaidAmount - alreadyPaidAmount) >= 0.01) {
      return true;
    }
    const currentPaid = Array.from(new Set(paidItemIndices)).sort((left, right) => left - right);
    const nextPaid = Array.from(new Set(snapshot.paidIndices)).sort((left, right) => left - right);
    return currentPaid.length !== nextPaid.length || currentPaid.some((value, index) => value !== nextPaid[index]);
  }, [alreadyPaidAmount, orderFinancials.totalAmount, paidItemIndices, persistedOutstanding]);

  useEffect(() => {
    let cancelled = false;
    if (!isOpen) return () => { cancelled = true; };
    const loadState = async () => {
      setIsInitializing(true);
      try {
        const snapshot = await fetchLatestSplitState();
        if (cancelled) return;
        applySplitStateSnapshot(snapshot, { resetDraft: true, mode: initialMode });
      } catch (error) {
        console.error('[SplitPaymentModal] Failed to load split state:', error);
        if (!cancelled) {
          applySplitStateSnapshot(buildFallbackSplitState(), { resetDraft: true, mode: initialMode });
        }
      } finally {
        if (!cancelled) setIsInitializing(false);
      }
    };
    void loadState();
    return () => { cancelled = true; };
  }, [applySplitStateSnapshot, buildFallbackSplitState, fetchLatestSplitState, initialMode, isOpen]);

  useEffect(() => {
    onUnsavedSavedRef.current = async () => {
      const retained = collectionScope === undefined ? null : retainedOrdinaryOwner(collectionScope, orderId);
      if (retained) {
        await probeOrdinaryOwner(retained, async () => {
          const state = await fetchLatestSplitState();
          return { completedPayments: state.payments, value: state };
        }).catch(() => undefined);
      }
      try {
        applySplitStateSnapshot(await fetchLatestSplitState(), { resetDraft: true, mode: activeTab });
      } catch (error) {
        console.warn('[SplitPaymentModal] Split refresh after Save payment again failed:', error);
      }
    };
  }, [activeTab, applySplitStateSnapshot, collectionScope, fetchLatestSplitState, orderId]);

  const ensureLatestOutstanding = useCallback(async (attemptedAmount: number, mode: TabMode) => {
    const snapshot = await fetchLatestSplitState();
    if (hasLiveSplitStateDrift(snapshot) || attemptedAmount > snapshot.outstanding + 0.01) {
      applySplitStateSnapshot(snapshot, { resetDraft: true, mode });
      throw new Error(t('splitPayment.balanceChanged', {
        defaultValue: 'Order balance changed while split payment was open. The split was refreshed to the latest outstanding amount of {{amount}}.',
        amount: formatCurrency(snapshot.outstanding),
      }));
    }
  }, [applySplitStateSnapshot, fetchLatestSplitState, hasLiveSplitStateDrift, t]);

  useEffect(() => {
    if (activeTab !== 'by-items') return;
    setPortions((current) => current.map((portion) => {
      if (portion.status === 'paid') return portion;
      const assignedItems = availableItems.filter((item) => itemAssignments[Number(item.itemIndex ?? 0)] === portion.id);
      return applyPortionFinancials({ ...portion, items: assignedItems }, round2(assignedItems.reduce((sum, item) => sum + Number(item.totalPrice || 0), 0)));
    }));
  }, [activeTab, availableItems, itemAssignments]);

  const addPerson = useCallback(() => {
    if (!processingPortionId && !isProcessing) {
      setPortions((current) => [...current, withCollectionDefaults(createPortion(personLabel(current.length), 0))]);
    }
  }, [isProcessing, personLabel, processingPortionId, withCollectionDefaults]);
  const removePerson = useCallback((portionId: string) => { setPortions((current) => current.filter((portion) => portion.id !== portionId)); setItemAssignments((current) => Object.fromEntries(Object.entries(current).filter(([, value]) => value !== portionId))); if (discountEditorPortionId === portionId) { setDiscountEditorPortionId(null); setDiscountDraftValue(''); } }, [discountEditorPortionId]);
  const updatePortionGrossAmount = useCallback((portionId: string, grossAmount: number) => updatePortion(portionId, (portion) => portion.status !== 'draft' ? portion : applyPortionFinancials(portion, grossAmount)), [updatePortion]);
  const setPortionMethod = useCallback((portionId: string, method: 'cash' | 'card') => updatePortion(portionId, (portion) => portion.status !== 'draft' ? portion : { ...portion, method, manualCardFallback: false, paymentOrigin: 'manual', terminalDeviceId: method === 'card' ? portion.terminalDeviceId : undefined }), [updatePortion]);
  // C1 (06/10/2026): a Card tap that took no card money puts the portion back
  // to the method it had before, as a plain draft with no terminal and no
  // manual-card notice. A paid or charged-not-saved portion is never touched.
  const restorePortionMethod = useCallback((portionId: string, method: 'cash' | 'card') => updatePortion(portionId, (portion) => (portion.status === 'paid' || portion.status === 'unsaved' ? portion : { ...portion, method, status: 'draft', manualCardFallback: false, paymentOrigin: 'manual', terminalDeviceId: undefined })), [updatePortion]);
  const setPortionCollectedBy = useCallback((portionId: string, collectedBy: 'cashier_drawer' | 'driver_shift') => updatePortion(portionId, (portion) => portion.status !== 'draft' ? portion : { ...portion, collectedBy }), [updatePortion]);
  const openDiscountEditor = useCallback((portionId: string) => { const portion = getPortion(portionId); if (!portion || portion.status !== 'draft' || portion.grossAmount <= 0.009) return; const requested = portion.requestedDiscountAmount ?? portion.discountAmount; setDiscountEditorPortionId(portionId); setDiscountDraftValue(requested ? requested.toFixed(2) : ''); }, [getPortion]);
  const saveDiscount = useCallback((portionId: string) => { const portion = getPortion(portionId); if (!portion || portion.status !== 'draft') return; updatePortion(portionId, (current) => applyPortionFinancials(current, current.grossAmount, round2(Number.parseFloat(discountDraftValue) || 0))); setDiscountEditorPortionId(null); setDiscountDraftValue(''); }, [discountDraftValue, getPortion, updatePortion]);
  const assignItem = useCallback((itemIndex: number, portionId: string | null) => { setItemAssignments((current) => { const next = { ...current }; if (portionId) next[itemIndex] = portionId; else delete next[itemIndex]; return next; }); setOpenAssignmentItemIndex(null); }, []);

  const appendCompletedPayment = useCallback((portion: SplitPortion, paymentId: string, paymentOrigin: PaymentOrigin, transactionRef?: string, terminalDeviceId?: string) => {
    const createdAt = new Date().toISOString();
    const paymentItems = portion.items.map((item) => ({ itemIndex: Number(item.itemIndex ?? 0), itemName: item.name, itemQuantity: item.quantity, itemAmount: item.totalPrice, createdAt }));
    setCompletedPayments((current) => [{ id: paymentId, orderId, method: portion.method, amount: portion.amount, discountAmount: portion.discountAmount, status: 'completed', createdAt, updatedAt: createdAt, transactionRef, paymentOrigin, terminalApproved: paymentOrigin === 'terminal', terminalDeviceId, items: paymentItems }, ...current]);
    if (paymentItems.length > 0) setPaidItemIndices((current) => Array.from(new Set([...current, ...paymentItems.map((item) => item.itemIndex)])));
    setPortions((current) => current.map((currentPortion) => currentPortion.id === portion.id ? { ...currentPortion, status: 'paid', paymentId, paymentOrigin, transactionRef, terminalDeviceId, paidAt: createdAt } : currentPortion));
  }, [orderId]);

  const persistFinancials = useCallback(async (next: OrderFinancialState) => {
    await bridge.orders.updateFinancials({ orderId, totalAmount: next.totalAmount, subtotal: next.subtotal, discountAmount: next.discountAmount, discountPercentage: next.discountPercentage, taxAmount: next.taxAmount, deliveryFee: next.deliveryFee, tipAmount: next.tipAmount });
    setOrderFinancials(next);
  }, [bridge, orderId]);

  const safePrintSplitReceipt = useCallback(async (paymentId: string) => { try { await bridge.payments.printSplitReceipt(paymentId); } catch (error) { console.warn('[SplitPaymentModal] Failed to print split receipt:', error); toast.error(t('orderDashboard.printFailed', { defaultValue: 'Receipt print failed' })); } }, [bridge, t]);
  const printFinalOrderDocuments = useCallback(async () => {
    const shouldPrint = await askForPaymentPrint({
      orderId,
      amount: orderFinancials.totalAmount,
    });
    if (!shouldPrint) return;

    try { await bridge.payments.printReceipt(orderId); } catch (error) { console.warn('[SplitPaymentModal] Final receipt print failed:', error); toast.error(t('orderDashboard.printFailed', { defaultValue: 'Receipt print failed' })); }
    if (isGhostOrder) return;
    const fiscalEnabled = await bridge.settings.get('terminal', 'fiscal_print_enabled').catch(() => true);
    if (fiscalEnabled === false || fiscalEnabled === 'false' || fiscalEnabled === '0') return;
    try { const fiscalResult: any = await bridge.ecr.fiscalPrint(orderId); if (fiscalResult?.skipped) return; } catch (error) { console.warn('[SplitPaymentModal] Fiscal print failed:', error); toast.error(t('orderDashboard.fiscalPrintFailed', { defaultValue: 'Cash register print failed' })); }
  }, [askForPaymentPrint, bridge, isGhostOrder, orderFinancials.totalAmount, orderId, t]);
  const recordPortionPayment = useCallback(async (portion: SplitPortion, paymentOrigin: PaymentOrigin, transactionRef?: string, terminalDeviceId?: string, onReply?: (raw: unknown, threw: boolean) => void) => {
    const result: any = await bridge.payments.recordPayment({ orderId, method: portion.method, amount: portion.amount, discountAmount: portion.discountAmount, cashReceived: portion.method === 'cash' ? portion.amount : undefined, changeGiven: portion.method === 'cash' ? 0 : undefined, transactionRef, paymentOrigin, terminalApproved: paymentOrigin === 'terminal', terminalDeviceId, collectedBy: portion.collectedBy ?? defaultCollectedBy, items: activeTab === 'by-items' ? portion.items.map((item) => ({ itemIndex: Number(item.itemIndex ?? 0), itemName: item.name, itemQuantity: item.quantity, itemAmount: item.totalPrice })) : undefined });
    onReply?.(result, false);
    // A charged card whose payment could not be saved: kept, never a draft.
    throwIfPaymentNotSaved(result, t, formatCurrency);
    // An approved card that found the order already paid is recorded set
    // aside for a manager to give back: never a collected portion.
    throwIfPaymentSetAside(result, t, formatCurrency);
    const paymentId = extractPaymentId(result); if (result?.success === false || !paymentId) throw new Error(result?.error || 'Missing paymentId after recording split payment');
    appendCompletedPayment(portion, paymentId, paymentOrigin, transactionRef, terminalDeviceId);
    return paymentId;
  }, [activeTab, appendCompletedPayment, bridge, defaultCollectedBy, orderId, t]);

  const completeAndClose = useCallback(async (recordedPortions: SplitPortion[], paymentIds: string[], updatedOrderTotal: number, recordedAmount: number) => {
    const remainingAmount = round2(Math.max(0, updatedOrderTotal - (alreadyPaidAmount + recordedAmount)));
    const paymentStatus = remainingAmount <= 0.01 ? 'paid' : 'partially_paid';
    if (paymentStatus === 'paid') await printFinalOrderDocuments();
    await onSplitComplete({ mode: activeTab, portions: recordedPortions, receiptMode, paymentIds, paymentStatus, remainingAmount, recordedAmount: round2(recordedAmount) });
    toast.success(paymentStatus === 'paid' ? t('splitPayment.success', 'Split payment completed successfully') : t('splitPayment.partialSuccess', { defaultValue: 'Split payment recorded. Remaining balance: {{amount}}', amount: formatCurrency(remainingAmount) }));
    onClose();
  }, [activeTab, alreadyPaidAmount, onClose, onSplitComplete, printFinalOrderDocuments, receiptMode, t]);

  const ordinaryRefusalText = useCallback((code: string) => (code === 'GIFT_CARD_TERMINAL_SCOPE_REQUIRED'
    ? t('giftCardCheckout.refusal.scope', 'This terminal has no confirmed organization or terminal identity. Pair the POS again.')
    : t('giftCardCheckout.refusal.admission', 'Earlier gift card attempts must be checked first.')), [t]);
  // Existing-order guard for one terminal charge and its write. Only an exact
  // decline proves nothing moved; an approved charge that is not booked stays
  // unknown and keeps the order's ordinary claim.
  const settleOrdinaryTerminalPortion = useCallback(async (owner: OrdinaryCollectionOwner, cardPortion: SplitPortion, terminal: { deviceId: string; name: string }, isCurrent: () => boolean, directSale?: DirectSale): Promise<TerminalSettlementResult> => {
    const seen: { charge: OrdinaryTerminalVerdict | null; write: OrdinaryCollectionFacts | null } = { charge: null, write: null };
    const noteWrite = (raw: unknown, threw: boolean) => { if (seen.write) return; seen.write = readOrdinaryWriteReply(raw, threw); noteOrdinaryWriteFacts(owner, seen.write); };
    const run = await runOrdinaryCollection<{ settlement?: TerminalSettlementResult; failure?: unknown }>(owner, { method: 'card', amount: cardPortion.amount, transactionRef: directSale?.id ?? null, idempotencyKey: null, settlementGeneration: null, terminalTransactionId: directSale?.id ?? null }, async () => {
      try {
        const settlement = await settleTerminalPortion(orderFinancials, cardPortion, {
          processPayment: async () => {
            if (!isCurrent()) throw new Error('The split payment view changed before card collection');
            if (directSale?.recoverable && directSale.id) {
              // This is the saved original approval, not another hardware send.
              seen.charge = { verdict: 'approved', transactionId: directSale.id, message: null };
              noteOrdinaryTerminalTransaction(owner, directSale.id);
              return { transactionId: directSale.id };
            }
            let rawPayment: unknown; let threw = false;
            try { rawPayment = await bridge.ecr.processPayment(cardPortion.amount, { deviceId: terminal.deviceId, orderId, reference: `${orderId}:${cardPortion.id}` }); } catch { threw = true; }
            const charge = classifyOrdinaryTerminalReply(rawPayment, threw);
            seen.charge = charge;
            if (charge.verdict !== 'approved') throw cardNotApproved(charge.message, isProvenDeclineReply(rawPayment, threw));
            noteOrdinaryTerminalTransaction(owner, charge.transactionId);
            return { transactionId: charge.transactionId };
          },
          recordPayment: async (transactionId: string) => {
            if (!isCurrent()) throw new Error('The split payment view changed before card recording');
            try { return await recordPortionPayment(cardPortion, 'terminal', transactionId, terminal.deviceId, noteWrite); } catch (error) { noteWrite(undefined, true); throw error; }
          },
          persistFinancials,
        });
        return { verdict: 'completed' as OrdinaryCollectionVerdict, value: { settlement } };
      } catch (failure) {
        const charge = seen.charge;
        const verdict: OrdinaryCollectionVerdict = !charge
          ? 'not_sent'
          : charge.verdict === 'approved'
            ? (seen.write && classifyOrdinaryWrite(seen.write) === 'completed' ? 'completed' : 'unknown')
            : charge.verdict;
        return { verdict, value: { failure } };
      }
    });
    if (run.status === 'refused') throw new Error(ordinaryRefusalText(run.code));
    if (run.status === 'completed' && run.value?.settlement) return run.value.settlement;
    const failure = run.value?.failure;
    throw failure instanceof Error ? failure : new Error(t('splitPayment.cardFailed', { defaultValue: 'Card payment failed' }));
  }, [bridge, orderFinancials, orderId, ordinaryRefusalText, persistFinancials, recordPortionPayment, t]);
  // Existing-order guard for Confirm Split: every portion write under one
  // ordinary claim, each kept with its own reference. Any unknown write keeps
  // it; a booked write completes it; an earlier booked write never proves a
  // later unknown one.
  const settleOrdinaryDrafts = useCallback(async (owner: OrdinaryCollectionOwner, draftPortions: SplitPortion[], settle: (onReply: (raw: unknown, threw: boolean, transactionRef: string | null) => void) => Promise<DraftSettlement>): Promise<DraftSettlement> => {
    const writes: OrdinaryCollectionFacts[] = [];
    const first = draftPortions[0];
    const run = await runOrdinaryCollection<{ settlement?: DraftSettlement; failure?: unknown }>(owner, { method: first.method, amount: round2(draftPortions.reduce((sum, portion) => sum + portion.amount, 0)), transactionRef: first.transactionRef ?? null, idempotencyKey: null, settlementGeneration: null, terminalTransactionId: null }, async () => {
      let outcome: { settlement?: DraftSettlement; failure?: unknown };
      try {
        outcome = { settlement: await settle((raw, threw, transactionRef) => { const facts = readOrdinaryWriteReply(raw, threw); noteOrdinaryBatchWrite(owner, facts, transactionRef); writes.push(facts); }) };
      } catch (failure) {
        outcome = { failure };
      }
      const verdicts = writes.map(classifyOrdinaryWrite);
      const verdict: OrdinaryCollectionVerdict = verdicts.includes('unknown') ? 'unknown' : verdicts.includes('completed') ? 'completed' : 'not_sent';
      return { verdict, value: outcome };
    });
    if (run.status === 'refused') throw new Error(ordinaryRefusalText(run.code));
    if (run.status === 'completed' && run.value?.settlement && run.value.failure === undefined) return run.value.settlement;
    const failure = run.value?.failure;
    throw failure instanceof Error ? failure : new Error(t('splitPayment.failed', 'Split payment failed. Please try again.'));
  }, [ordinaryRefusalText, t]);
  const handleTerminalCardPayment = useCallback(async (portionId: string) => {
    if (isReconciliationPending || platformHeld) return;
    if (unsavedLocked) { toast.error(pendingNotSavedMessage(unsaved.payments, t, formatCurrency), { duration: PAYMENT_NOT_SAVED_TOAST_MS }); return; }
    const startedEpoch = viewEpoch.current;
    const isCurrent = () => isOpen && viewEpoch.current === startedEpoch;
    const portion = getPortion(portionId); if (!portion || portion.status !== 'draft') return; if (portion.amount <= 0.009) return;
    // C1: the method this portion had before the tap; any outcome that takes no card money puts it back.
    const methodBeforeTap = portion.method;
    // Gap review P0-01: the guard must be armed synchronously BEFORE the first
    // await. The pre-flight IPC below yields long enough for a double-tap to
    // re-enter with portion.status still 'draft', and the ECR device mutex
    // queues a concurrent charge instead of rejecting it — the card was charged
    // twice. The state-based checks below stay as defense in depth only.
    if (!terminalChargeGuard.acquire(portionId)) { toast.error(t('splitPayment.cardBusy', { defaultValue: 'Another card payment is already in progress' })); return; }
    // Existing-order guard: claim the order before the first await.
    let ordinaryOwner: OrdinaryCollectionOwner | null = null;
    if (collectionScope !== undefined) {
      const claim = claimOrdinaryCollectionOwner(collectionScope, orderId);
      if (!claim.claimed) {
        if (claim.retained) {
          try {
            const sale = (await bridge.payments.getSettlementSnapshot(orderId)).unresolvedDirectSale;
            const original = ordinaryCollectionView(claim.retained)?.original;
            let recoveredLabel: string | null = null;
            if (isCurrent() && sale?.recoverable && sale.id && sale.deviceId && /^[A-Z]{3}$/.test(sale.currency?.toUpperCase() || '')
              && sale.amountCents === Math.round(portion.amount * 100) && original?.method === 'card'
              && Math.round(original.amount * 100) === sale.amountCents
              && (!original.terminalTransactionId || original.terminalTransactionId === sale.id)) {
              const cardPortion = toTerminalCardPortion(portion, sale.deviceId);
              noteOrdinaryTerminalTransaction(claim.retained, sale.id);
              await recordPortionPayment(cardPortion, 'terminal', sale.id, sale.deviceId);
              recoveredLabel = cardPortion.label;
            }
            // The retained original is continued from the ledger, never
            // resent: its row may have landed above or through Save payment
            // again (30/09/2026).
            const probe = await probeOrdinaryOwner(claim.retained, async () => {
              const state = await fetchLatestSplitState();
              return { completedPayments: state.payments, value: state };
            });
            if (isCurrent() && probe.status === 'completed' && probe.value) {
              applySplitStateSnapshot(probe.value, { resetDraft: true, mode: activeTab });
              toast.success(recoveredLabel
                ? t('splitPayment.portionPaid', { defaultValue: '{{person}} paid successfully', person: recoveredLabel })
                : t('orderDashboard.cardPaymentRecorded', { defaultValue: 'Card payment recorded.' }));
              terminalChargeGuard.release(portionId);
              return;
            }
          } catch (error) {
            if (isPaymentNotSavedError(error)) {
              terminalChargeGuard.release(portionId);
              toast.error(error.message, { duration: PAYMENT_NOT_SAVED_TOAST_MS });
              await unsaved.refresh();
              return;
            }
            if (isPaymentSetAsideError(error)) {
              terminalChargeGuard.release(portionId);
              toast.error(error.message, { duration: PAYMENT_SET_ASIDE_TOAST_MS });
              try { applySplitStateSnapshot(await fetchLatestSplitState(), { resetDraft: true, mode: activeTab }); } catch (refreshError) { console.warn('[SplitPaymentModal] Split refresh after a set-aside card failed:', refreshError); }
              return;
            }
            console.warn('[SplitPaymentModal] Original SALE recovery remains pending:', error);
          }
        }
        terminalChargeGuard.release(portionId); toast.error(ordinaryRefusalText(claim.code)); return;
      }
      ordinaryOwner = claim.owner;
    }
    setIsTerminalChargeInFlight(true);
    try {
      if (processingPortionId && processingPortionId !== portionId) { toast.error(t('splitPayment.cardBusy', { defaultValue: 'Another card payment is already in progress' })); return; }
      // Read fresh before any terminal is asked to charge.
      const pending = await unsaved.refresh();
      if (pending.length > 0) { toast.error(pendingNotSavedMessage(pending, t, formatCurrency), { duration: PAYMENT_NOT_SAVED_TOAST_MS }); return; }
      try { await ensureLatestOutstanding(portion.amount, activeTab); } catch (error) { toast.error(error instanceof Error ? error.message : t('splitPayment.failed', 'Split payment failed. Please try again.')); return; }
      if (!isCurrent()) return;
      const sale = (await bridge.payments.getSettlementSnapshot(orderId)).unresolvedDirectSale;
      if (!isCurrent()) return;
      if (sale && (!sale.recoverable || !sale.id || !sale.deviceId || !/^[A-Z]{3}$/.test(sale.currency?.toUpperCase() || '')
        || sale.amountCents !== Math.round(portion.amount * 100))) {
        toast.error(ordinaryRefusalText('DIRECT_SALE_RECONCILIATION_REQUIRED'));
        return;
      }
      setPortionMethod(portionId, 'card');
      let terminal: { deviceId: string; name: string } | null = sale?.recoverable && sale.deviceId
        ? { deviceId: sale.deviceId, name: sale.deviceId } : null;
      if (!terminal) {
        const lookup = await lookupCardTerminal();
        if (!isCurrent()) return;
        if (lookup.kind !== 'ready') {
          // D (06/10/2026, Android parity): a configured terminal that is busy,
          // disconnected or unreadable takes no card and never turns into a
          // manual card. With no terminal at all, only a fresh server admission
          // offers one, and Confirm asks again before it records.
          const admission = lookup.kind === 'none' ? await admitManualCard() : null;
          if (!isCurrent()) return;
          if (admission?.admitted) {
            updatePortion(portionId, (current) => (current.status !== 'draft' ? current : { ...current, method: 'card', manualCardFallback: true, paymentOrigin: 'manual', terminalDeviceId: undefined }));
            return;
          }
          restorePortionMethod(portionId, methodBeforeTap);
          toast.error(manualCardNoticeText(t, admission ? admission.reason : terminalLookupNotice(lookup) ?? 'terminal_check_failed'));
          return;
        }
        terminal = { deviceId: lookup.deviceId, name: lookup.name };
      }
      // Gap review P0-02: `portion` was captured before the setPortionMethod
      // write above landed in state, so recording from it persisted an approved
      // terminal charge as method 'cash' with a cashReceived amount. Everything
      // downstream — state update, settlement, recording, completion — operates
      // on the normalized card portion instead of the stale capture.
      const cardPortion = toTerminalCardPortion(portion, terminal.deviceId);
      updatePortion(portionId, (current) => toTerminalCardPortion(current, terminal!.deviceId));
      let settlement: TerminalSettlementResult;
      try {
        settlement = ordinaryOwner ? await settleOrdinaryTerminalPortion(ordinaryOwner, cardPortion, terminal, isCurrent, sale ?? undefined) : await settleTerminalPortion(orderFinancials, cardPortion, {
          processPayment: async () => {
            if (!isCurrent()) throw new Error('The split payment view changed before card collection');
            if (sale?.recoverable && sale.id) return { transactionId: sale.id };
            const rawPayment: any = await bridge.ecr.processPayment(cardPortion.amount, { deviceId: terminal!.deviceId, orderId, reference: `${orderId}:${cardPortion.id}` });
            const tx = extractTransactionDetails(rawPayment);
            if (!tx.success || tx.status !== 'approved' || !tx.transactionId) throw cardNotApproved(tx.errorMessage, isProvenDeclineReply(rawPayment));
            return { transactionId: tx.transactionId };
          },
          recordPayment: (transactionId) => {
            if (!isCurrent()) throw new Error('The split payment view changed before card recording');
            return recordPortionPayment(cardPortion, 'terminal', transactionId, terminal!.deviceId);
          },
          persistFinancials,
        });
      } catch (error) {
        if (isPaymentNotSavedError(error)) {
          // The card was charged and its payment is not saved yet: the portion
          // is never a chargeable draft again; its record offers Save payment
          // again and every other portion waits.
          toast.error(error.message, { duration: PAYMENT_NOT_SAVED_TOAST_MS });
          updatePortion(portionId, (current) => ({ ...current, status: 'unsaved' }));
          await unsaved.refresh();
          return;
        }
        if (isPaymentSetAsideError(error)) {
          // The card was charged and recorded set aside: tell the cashier not
          // to charge again, and show the order as it now stands.
          toast.error(error.message, { duration: PAYMENT_SET_ASIDE_TOAST_MS });
          try {
            applySplitStateSnapshot(await fetchLatestSplitState(), { resetDraft: true, mode: activeTab });
          } catch (refreshError) {
            console.warn('[SplitPaymentModal] Split refresh after a set-aside card failed:', refreshError);
          }
          return;
        }
        console.error('[SplitPaymentModal] Terminal card payment failed:', error);
        // C1 (06/10/2026): the portion never stays a card draft that Confirm
        // could book as a manual card for money the terminal refused. Only a
        // proven decline says nothing was charged; any other failure may hide
        // a charge (native then holds the order's unresolved SALE) and keeps
        // its own message.
        restorePortionMethod(portionId, methodBeforeTap);
        toast.error(error instanceof Error && provenCardDeclines.has(error)
          ? t('payment.messages.cardDeclinedNothingCharged', { defaultValue: 'The card was declined. Nothing was charged.' })
          : error instanceof Error ? error.message : t('splitPayment.cardFailed', { defaultValue: 'Card payment failed' }));
        return;
      }
      if (!isCurrent()) return;
      if (settlement.discountPersistFailed) toast.error(t('splitPayment.discountPersistFailed', { defaultValue: 'Payment recorded, but the discount could not be saved to the order. Review the order total before closing it.' }));
      try {
        if (receiptMode === 'individual') await safePrintSplitReceipt(settlement.paymentId);
        const nextRemaining = round2(Math.max(0, settlement.financials.totalAmount - (alreadyPaidAmount + cardPortion.amount)));
        if (nextRemaining <= 0.01) { await completeAndClose([{ ...cardPortion, status: 'paid', paymentId: settlement.paymentId, transactionRef: settlement.transactionId }], [settlement.paymentId], settlement.financials.totalAmount, cardPortion.amount); return; }
        toast.success(t('splitPayment.portionPaid', { defaultValue: '{{person}} paid successfully', person: cardPortion.label }));
      } catch (error) {
        console.error('[SplitPaymentModal] Split completion failed after payment was recorded:', error);
        toast.error(error instanceof Error ? error.message : t('splitPayment.failed', 'Split payment failed. Please try again.'));
      }
    } finally {
      // Ends the claim only while nothing was sent under it.
      if (ordinaryOwner) releaseOrdinaryOwnerBeforeSend(ordinaryOwner);
      terminalChargeGuard.release(portionId);
      setIsTerminalChargeInFlight(false);
    }
  }, [activeTab, alreadyPaidAmount, applySplitStateSnapshot, bridge, collectionScope, completeAndClose, ensureLatestOutstanding, fetchLatestSplitState, getPortion, isOpen, isReconciliationPending, orderFinancials, orderId, ordinaryRefusalText, persistFinancials, platformHeld, processingPortionId, receiptMode, recordPortionPayment, restorePortionMethod, safePrintSplitReceipt, setPortionMethod, settleOrdinaryTerminalPortion, t, unsaved, unsavedLocked, updatePortion]);

  const handleConfirm = useCallback(async () => {
    if (!canConfirm) return;
    const startedEpoch = viewEpoch.current;
    const isCurrent = () => isOpen && viewEpoch.current === startedEpoch;
    const draftPortions = portions.filter((portion) => portion.status === 'draft' && portion.amount > 0.009); if (!draftPortions.length) return;
    // C1 (06/10/2026), defensively behind canConfirm: Confirm books a card
    // portion only as an admitted manual card, never a card the terminal
    // refused or did not charge.
    if (draftPortions.some((portion) => portion.method === 'card' && portion.manualCardFallback !== true)) return;
    const manualCardIds = new Set(draftPortions.filter((portion) => portion.method === 'card').map((portion) => portion.id));
    // Review round 2 P0: Confirm must hold the SAME synchronous guard as the
    // terminal charge. During a Card tap's pre-flight IPC the portion is still
    // 'draft' and canConfirm's state checks pass, so an un-guarded Confirm
    // would record the portion as a manual payment while the terminal flow
    // proceeds to charge the card for it a second time.
    if (!terminalChargeGuard.acquire(CONFIRM_SETTLEMENT_GUARD_ID)) { toast.error(t('splitPayment.cardBusy', { defaultValue: 'Another card payment is already in progress' })); return; }
    // Existing-order guard: claim the order before the first await.
    let ordinaryOwner: OrdinaryCollectionOwner | null = null;
    if (collectionScope !== undefined) {
      const claim = claimOrdinaryCollectionOwner(collectionScope, orderId);
      if (!claim.claimed) { terminalChargeGuard.release(CONFIRM_SETTLEMENT_GUARD_ID); toast.error(ordinaryRefusalText(claim.code)); return; }
      ordinaryOwner = claim.owner;
    }
    setIsProcessing(true);
    try {
      const pending = await unsaved.refresh();
      if (pending.length > 0) { toast.error(pendingNotSavedMessage(pending, t, formatCurrency), { duration: PAYMENT_NOT_SAVED_TOAST_MS }); return; }
      if ((await bridge.payments.getSettlementSnapshot(orderId)).unresolvedDirectSale) {
        throw new Error(ordinaryRefusalText('DIRECT_SALE_RECONCILIATION_REQUIRED'));
      }
      if (!isCurrent()) return;
      await ensureLatestOutstanding(round2(draftPortions.reduce((sum, portion) => sum + portion.amount, 0)), activeTab);
      if (!isCurrent()) return;
      if (manualCardIds.size > 0) {
        // D (06/10/2026): the manual card admission is asked again right
        // before it is recorded. A refusal records nothing at all; a definite
        // one (a terminal or a provider is now there) withdraws the offer.
        const admission = await admitManualCard();
        if (!isCurrent()) return;
        if (!admission.admitted) {
          if (admission.reason !== 'unavailable') {
            setPortions((current) => current.map((portion) => (manualCardIds.has(portion.id) && portion.status === 'draft' ? { ...portion, manualCardFallback: false } : portion)));
          }
          toast.error(manualCardRecordRefusalText(t, admission.reason));
          return;
        }
      }
      const portionOrigins = new Map<string, PaymentOrigin>(draftPortions.map((portion) => [portion.id, portion.method === 'card' ? (portion.paymentOrigin || 'manual') : 'manual']));
      const settleDrafts = (onReply?: (raw: unknown, threw: boolean, transactionRef: string | null) => void) => settleDraftPortions(orderFinancials, draftPortions, {
        recordPayment: async (portion) => {
          if (!isCurrent()) throw new Error('The split payment view changed before recording');
          let replied = false;
          const noteReply = onReply && ((raw: unknown, threw: boolean) => { replied = true; onReply(raw, threw, portion.transactionRef ?? null); });
          try { return await recordPortionPayment(portion, portionOrigins.get(portion.id) ?? 'manual', portion.transactionRef, portion.terminalDeviceId, noteReply); }
          catch (error) { if (onReply && !replied) onReply(undefined, true, portion.transactionRef ?? null); throw error; }
        },
        persistFinancials,
        onPortionSettled: receiptMode === 'individual' ? async (_portion, paymentId) => { await safePrintSplitReceipt(paymentId); } : undefined,
      });
      const settlement = ordinaryOwner ? await settleOrdinaryDrafts(ordinaryOwner, draftPortions, settleDrafts) : await settleDrafts();
      if (!isCurrent()) return;
      if (settlement.discountPersistFailures.length > 0) toast.error(t('splitPayment.discountPersistFailed', { defaultValue: 'Payment recorded, but the discount could not be saved to the order. Review the order total before closing it.' }));
      const recordedPortions: SplitPortion[] = draftPortions.map((portion, index) => ({ ...portion, status: 'paid', paymentId: settlement.paymentIds[index], paymentOrigin: portionOrigins.get(portion.id) ?? 'manual' }));
      await completeAndClose(recordedPortions, settlement.paymentIds, settlement.financials.totalAmount, recordedPortions.reduce((sum, portion) => sum + portion.amount, 0));
    } catch (error) {
      if (isPaymentNotSavedError(error)) {
        toast.error(error.message, { duration: PAYMENT_NOT_SAVED_TOAST_MS });
        await unsaved.refresh();
        try { applySplitStateSnapshot(await fetchLatestSplitState(), { resetDraft: true, mode: activeTab }); } catch (refreshError) { console.warn('[SplitPaymentModal] Split refresh after a charged payment not saved failed:', refreshError); }
        return;
      }
      console.error('[SplitPaymentModal] Split confirmation failed:', error);
      toast.error(error instanceof Error ? error.message : t('splitPayment.failed', 'Split payment failed. Please try again.'));
    } finally {
      // Ends the claim only while nothing was sent under it.
      if (ordinaryOwner) releaseOrdinaryOwnerBeforeSend(ordinaryOwner);
      terminalChargeGuard.release(CONFIRM_SETTLEMENT_GUARD_ID);
      setIsProcessing(false);
    }
  }, [activeTab, applySplitStateSnapshot, bridge, canConfirm, collectionScope, completeAndClose, ensureLatestOutstanding, fetchLatestSplitState, isOpen, orderFinancials, orderId, ordinaryRefusalText, persistFinancials, portions, receiptMode, recordPortionPayment, safePrintSplitReceipt, settleOrdinaryDrafts, t, unsaved]);

  const MethodToggle: React.FC<{ portion: SplitPortion }> = ({ portion }) => {
    const locked = portion.status !== 'draft' || isProcessing || isTerminalChargeInFlight || isReconciliationPending || platformHeld;
    return (
      <div className="split-payment-methods" role="group" aria-label={portion.label}>
        <button
          type="button"
          disabled={locked}
          aria-pressed={portion.method === 'cash'}
          onClick={() => setPortionMethod(portion.id, 'cash')}
          className="split-payment-method"
        >
          <Banknote className="h-3.5 w-3.5" />
          {t('splitPayment.cash', 'Cash')}
        </button>
        <button
          type="button"
          disabled={locked}
          aria-pressed={portion.method === 'card'}
          onClick={() => void handleTerminalCardPayment(portion.id)}
          className="split-payment-method"
        >
          {portion.status === 'processing' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CreditCard className="h-3.5 w-3.5" />}
          {t('splitPayment.card', 'Card')}
        </button>
      </div>
    );
  };
  const renderCollectionOwner = (portion: SplitPortion) => {
    if (!collectionMode?.enabled) {
      return null;
    }
    const locked = portion.status !== 'draft' || isProcessing || isTerminalChargeInFlight || isReconciliationPending || platformHeld;
    const showDriverShift = collectionMode.allowDriverShift === true;
    const selectedOwner = portion.collectedBy ?? defaultCollectedBy ?? 'cashier_drawer';
    return (
      <div className="space-y-1">
        <p className="text-[11px] font-semibold text-slate-500 dark:text-white/40">
          {collectionMode.label || t('splitPayment.collectedBy', { defaultValue: 'Collected By' })}
        </p>
        {collectionMode.description ? (
          <p className="text-xs liquid-glass-modal-text-muted">{collectionMode.description}</p>
        ) : null}
        <div className="flex gap-1 rounded-2xl bg-slate-100/80 p-0.5 dark:bg-white/5">
          <button
            type="button"
            disabled={locked}
            onClick={() => setPortionCollectedBy(portion.id, 'cashier_drawer')}
            className={`flex-1 rounded-2xl px-3 py-1.5 text-xs font-medium transition-all ${selectedOwner !== 'driver_shift' ? 'border border-emerald-400/30 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300' : 'text-slate-500 active:text-slate-700 dark:text-white/50 dark:active:text-white/70'} ${locked ? 'cursor-not-allowed opacity-70' : ''}`}
          >
            {t('splitPayment.cashierDrawer', { defaultValue: 'Cashier' })}
          </button>
          {showDriverShift ? (
            <button
              type="button"
              disabled={locked}
              onClick={() => setPortionCollectedBy(portion.id, 'driver_shift')}
              className={`flex-1 rounded-2xl px-3 py-1.5 text-xs font-medium transition-all ${selectedOwner === 'driver_shift' ? 'border border-slate-400/30 bg-slate-500/15 text-slate-700 dark:text-slate-200' : 'text-slate-500 active:text-slate-700 dark:text-white/50 dark:active:text-white/70'} ${locked ? 'cursor-not-allowed opacity-70' : ''}`}
            >
              {t('splitPayment.driverShift', { defaultValue: 'Driver' })}
            </button>
          ) : null}
        </div>
      </div>
    );
  };
  const renderPortionDetails = (portion: SplitPortion) => {
    // A zero-discount portion has Subtotal == Payable, so the Subtotal/Discount rows are suppressed and only
    // the Payable line shows -- keeps the default by-amount person cards compact enough to clear the fixed
    // footer on first open. The rows return as soon as a discount is applied (discount logic is unchanged).
    const hasDiscount = portion.discountAmount > 0.009;
    return (
    <div className="split-payment-details">
      {hasDiscount && (
        <>
          <div className="flex items-center justify-between text-xs liquid-glass-modal-text-muted">
            <span>{t('modals.orderDetails.subtotal', { defaultValue: 'Subtotal' })}</span>
            <span>{formatCurrency(portion.grossAmount)}</span>
          </div>
          <div className="flex items-center justify-between text-xs text-green-700 dark:text-green-300">
            <span>{t('modals.orderDetails.discount', { defaultValue: 'Discount' })}</span>
            <span>-{formatCurrency(portion.discountAmount)}</span>
          </div>
        </>
      )}
      <div className="split-payment-payable flex items-center justify-between text-sm font-semibold">
        <span>{t('splitPayment.payable', { defaultValue: 'Payable' })}</span>
        <span>{formatCurrency(portion.amount)}</span>
      </div>
      {portion.status === 'paid' ? (
        <div className="rounded-2xl border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-200">
          {t('modals.orderDetails.paid', { defaultValue: 'Paid' })} • {t(portion.method === 'card' ? 'modals.orderDetails.card' : 'modals.orderDetails.cash', { defaultValue: portion.method === 'card' ? 'Card' : 'Cash' })}
          {portion.paymentOrigin === 'terminal' ? ` • ${t('splitPayment.terminalApproved', { defaultValue: 'Terminal' })}` : ''}
        </div>
      ) : portion.status === 'processing' ? (
        <div className="rounded-2xl border border-slate-400/30 bg-slate-500/10 px-3 py-2 text-xs text-slate-700 dark:text-slate-200">
          {t('splitPayment.waitingForApproval', { defaultValue: 'Waiting for card approval on the payment terminal...' })}
        </div>
      ) : portion.status === 'unsaved' ? (
        <div data-testid={`split-portion-unsaved-${portion.id}`} className="rounded-2xl border border-red-400/40 bg-red-500/10 px-3 py-2 text-xs font-semibold text-red-800 dark:text-red-200">
          {t('splitPayment.portionNotSaved', { defaultValue: 'Card charged, payment not saved yet. Do not charge again.' })}
        </div>
      ) : (
        <>
          {renderCollectionOwner(portion)}
          {allowDiscounts ? (
            <>
              <button
                type="button"
                disabled={portion.grossAmount <= 0.009}
                onClick={() => openDiscountEditor(portion.id)}
                className="split-payment-secondary"
              >
                <BadgePercent className="h-3.5 w-3.5" />
                {t('splitPayment.discount', { defaultValue: 'Discount' })}
              </button>
              {discountEditorPortionId === portion.id ? (
                <div className="flex items-center gap-2 rounded-2xl border border-slate-200/90 bg-slate-50/80 p-2 dark:border-white/10 dark:bg-white/5">
                  <div className="relative flex-1">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-slate-500 dark:text-white/40">{getStoreCurrency() ?? '—'}</span>
                    <SplitAmountInput
                      amount={Number(discountDraftValue) || 0}
                      label={t('splitPayment.discount', { defaultValue: 'Discount' })}
                      disabled={isProcessing || isTerminalChargeInFlight}
                      onAmountChange={(amount) => setDiscountDraftValue(amount.toFixed(2))}
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => saveDiscount(portion.id)}
                    className="rounded-2xl border border-emerald-500/30 bg-emerald-600/20 px-3 py-2 text-xs font-semibold text-emerald-700 dark:text-emerald-300"
                  >
                    {t('common.actions.apply', { defaultValue: 'Apply' })}
                  </button>
                  <button
                    type="button"
                    onClick={() => { setDiscountEditorPortionId(null); setDiscountDraftValue(''); }}
                    className="rounded-2xl border border-slate-200/90 bg-white/90 px-3 py-2 text-xs font-semibold text-slate-700 dark:border-white/10 dark:bg-white/5 dark:text-white/70"
                  >
                    {t('common.actions.cancel', { defaultValue: 'Cancel' })}
                  </button>
                </div>
              ) : null}
            </>
          ) : null}
          {portion.method === 'card' && portion.manualCardFallback ? (
            <div role="status" className="split-payment-card-notice">
              <CreditCard aria-hidden="true" />
              <p>{t('payment.manualCard.portionNotice', { defaultValue: "No card terminal is connected to this till. Take this amount on the shop's own card machine; on confirm it is recorded as a manual card payment." })}</p>
            </div>
          ) : null}
        </>
      )}
    </div>
    );
  };
  const renderByAmountTab = () => (
    <div className="space-y-3">
      <div className="split-payment-quick flex gap-2">
        <button type="button" onClick={() => {
          const half = round2(adjustedDue / 2);
          setPortions([createPortion(personLabel(0), half), createPortion(personLabel(1), round2(adjustedDue - half))]);
        }} className="liquid-glass-modal-button flex-1 text-sm font-medium liquid-glass-modal-text">
          {t('splitPayment.halfHalf', '50 / 50')}
        </button>
        <button type="button" onClick={() => {
          const third = round2(adjustedDue / 3);
          setPortions([createPortion(personLabel(0), third), createPortion(personLabel(1), third), createPortion(personLabel(2), round2(adjustedDue - third * 2))]);
        }} className="liquid-glass-modal-button flex-1 text-sm font-medium liquid-glass-modal-text">
          {t('splitPayment.threeWay', '3-Way Equal')}
        </button>
        <button type="button" onClick={() => setPortions([createPortion(personLabel(0), 0), createPortion(personLabel(1), 0)])}
          className="liquid-glass-modal-button flex-1 text-sm font-medium liquid-glass-modal-text">
          {t('splitPayment.custom', 'Custom')}
        </button>
      </div>
      <div className="space-y-2">
        <AnimatePresence mode="popLayout">
          {portions.map((portion) => (
            <motion.div key={portion.id} initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -12 }}
              className="split-payment-person space-y-2">
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-2 text-sm font-semibold liquid-glass-modal-text">
                  <Users className="h-4 w-4 text-slate-500 dark:text-white/40" />{portion.label}
                </span>
                {portions.length > 2 && portion.status === 'draft' && (
                  <button type="button" onClick={() => removePerson(portion.id)}
                    className="rounded-2xl p-1 text-red-400/60 transition-colors active:bg-red-500/10 active:text-red-400">
                    <Trash2 className="h-4 w-4" />
                  </button>
                )}
              </div>
              <div className="split-payment-amount-row flex items-center gap-3">
                <div className="relative min-w-0 flex-1">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm font-medium text-slate-500 dark:text-white/40">{getStoreCurrency() ?? '—'}</span>
                  <SplitAmountInput amount={portion.grossAmount} label={portion.label}
                    disabled={portion.status !== 'draft' || isProcessing || isTerminalChargeInFlight}
                    onAmountChange={(amount) => updatePortionGrossAmount(portion.id, amount)} />
                </div>
                <MethodToggle portion={portion} />
              </div>
              {renderPortionDetails(portion)}
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
      <button type="button" onClick={addPerson} disabled={Boolean(processingPortionId) || isProcessing || isTerminalChargeInFlight}
        className="flex w-full items-center justify-center gap-2 rounded-xl border-2 border-dashed border-slate-300/90 py-2.5 text-sm font-medium text-slate-500 transition-colors active:border-slate-400 active:text-slate-700 disabled:cursor-not-allowed disabled:opacity-60 dark:border-white/15 dark:text-white/50 dark:active:border-white/25 dark:active:text-white/70">
        <Plus className="h-4 w-4" />{t('splitPayment.addPerson', 'Add Person')}
      </button>
    </div>
  );
  const renderByItemsTab = () => {
    const unassignedCount = availableItems.filter(
      (item) => itemAssignments[Number(item.itemIndex ?? 0)] === undefined,
    ).length;
    return (
      <div className="split-payment-items-grid grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <h4 className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-slate-500 dark:text-white/40">
            <ShoppingCart className="h-3.5 w-3.5" />
            {t("splitPayment.orderItems", "Order Items")}
          </h4>
          {availableItems.map((item) => {
            const itemIndex = Number(item.itemIndex ?? 0);
            const assignedTo = itemAssignments[itemIndex];
            const assignedPortion = portions.find(
              (portion) => portion.id === assignedTo,
            );
            return (
              <div
                key={itemIndex}
                className={`rounded-2xl border p-2.5 transition-colors ${assignedTo ? "border-emerald-300/60 bg-emerald-50/80 dark:border-emerald-400/20 dark:bg-emerald-500/5" : "border-slate-200/90 bg-white/80 dark:border-white/10 dark:bg-white/5"}`}
              >
                <div className="mb-1.5 flex items-center justify-between">
                  <span className="flex-1 truncate text-sm font-medium liquid-glass-modal-text">
                    {item.quantity > 1 && (
                      <span className="mr-1 text-slate-500 dark:text-white/40">
                        {item.quantity}x
                      </span>
                    )}
                    {item.name}
                  </span>
                  <span className="ml-2 whitespace-nowrap text-sm font-semibold text-emerald-500 dark:text-emerald-400">
                    {formatCurrency(item.totalPrice)}
                  </span>
                </div>
                <div className="space-y-1.5">
                  <button
                    type="button"
                    aria-expanded={openAssignmentItemIndex === itemIndex}
                    onClick={() =>
                      setOpenAssignmentItemIndex((current) =>
                        current === itemIndex ? null : itemIndex,
                      )
                    }
                    className="split-payment-assignment flex w-full items-center justify-between gap-2"
                  >
                    <span
                      className={`truncate ${assignedPortion ? "text-slate-900 dark:text-white" : "text-slate-600 dark:text-white/70"}`}
                    >
                      {assignedPortion?.label ||
                        t("splitPayment.unassigned", "-- Unassigned --")}
                    </span>
                    <ChevronDown
                      className={`h-3.5 w-3.5 text-slate-500 transition-transform dark:text-white/50 ${openAssignmentItemIndex === itemIndex ? "rotate-180" : ""}`}
                    />
                  </button>
                  {openAssignmentItemIndex === itemIndex && (
                    <div className="split-payment-assignment-menu overflow-hidden">
                      <button
                        type="button"
                        aria-pressed={!assignedTo}
                        onClick={() => assignItem(itemIndex, null)}
                        className={`w-full px-3 py-2 text-left text-xs transition-colors ${!assignedTo ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300" : "text-slate-800 active:bg-slate-100 dark:text-white/80 dark:active:bg-white/8"}`}
                      >
                        {t("splitPayment.unassigned", "-- Unassigned --")}
                      </button>
                      {portions
                        .filter((portion) => portion.status !== "paid")
                        .map((portion) => (
                          <button
                            key={portion.id}
                            type="button"
                            aria-pressed={assignedTo === portion.id}
                            onClick={() => assignItem(itemIndex, portion.id)}
                            className={`w-full px-3 py-2 text-left text-xs transition-colors ${assignedTo === portion.id ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300" : "text-slate-900 active:bg-slate-100 dark:text-white dark:active:bg-white/8"}`}
                          >
                            {portion.label}
                          </button>
                        ))}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
          {availableItems.length === 0 && (
            <div className="rounded-2xl border border-emerald-400/30 bg-emerald-500/10 p-2 text-center">
              <span className="text-xs font-medium text-emerald-500 dark:text-emerald-400">
                {t("splitPayment.allItemsPaid", {
                  defaultValue:
                    "All remaining balance has already been allocated to previous item payments",
                })}
              </span>
            </div>
          )}
          {availableItems.length > 0 && unassignedCount > 0 && (
            <div className="rounded-2xl border border-amber-400/30 bg-amber-500/10 p-2 text-center">
              <span className="text-xs font-medium text-amber-500 dark:text-amber-400">
                {t("splitPayment.unassignedWarning", {
                  count: unassignedCount,
                })}
              </span>
            </div>
          )}
        </div>
        <div className="space-y-2">
          <h4 className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-slate-500 dark:text-white/40">
            <Users className="h-3.5 w-3.5" />
            {t("splitPayment.people", "People")}
          </h4>
          {portions.map((portion) => (
            <div
              key={portion.id}
              className={`space-y-2 rounded-2xl border p-2.5 ${portion.status === "paid" ? "border-emerald-300/60 bg-emerald-50/80 dark:border-emerald-400/20 dark:bg-emerald-500/5" : portion.status === "processing" ? "border-slate-300/70 bg-slate-100/80 dark:border-slate-400/25 dark:bg-slate-500/5" : "border-slate-200/90 bg-white/80 dark:border-white/10 dark:bg-white/5"}`}
            >
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold liquid-glass-modal-text">
                  {portion.label}
                </span>
                {portions.length > 2 && portion.status === "draft" && (
                  <button
                    type="button"
                    onClick={() => removePerson(portion.id)}
                    className="rounded-full p-1 text-red-400/60 transition-colors active:bg-red-500/10 active:text-red-400"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
              {isEmptyByItemsPortion(portion) ? (
                <>
                  <p className="split-payment-empty text-xs">
                    {t("splitPayment.noItems", "No items assigned")}
                  </p>
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-bold text-emerald-500 dark:text-emerald-400">
                      {formatCurrency(portion.amount)}
                    </span>
                    <MethodToggle portion={portion} />
                  </div>
                </>
              ) : (
                <>
                  {portion.items.length > 0 ? (
                    <ul className="space-y-0.5">
                      {portion.items.map((item) => (
                        <li
                          key={`${portion.id}-${item.itemIndex}`}
                          className="flex justify-between text-xs liquid-glass-modal-text-muted"
                        >
                          <span className="truncate">
                            {item.quantity > 1 && `${item.quantity}x `}
                            {item.name}
                          </span>
                          <span className="ml-1 whitespace-nowrap">
                            {formatCurrency(item.totalPrice)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="split-payment-empty text-xs">
                      {t("splitPayment.noItems", "No items assigned")}
                    </p>
                  )}
                  <div className="border-t border-slate-200/90 pt-2 dark:border-white/10">
                    <div className="mb-2 flex items-center justify-between">
                      <span className="text-sm font-bold text-emerald-500 dark:text-emerald-400">
                        {formatCurrency(portion.amount)}
                      </span>
                      <MethodToggle portion={portion} />
                    </div>
                    {renderPortionDetails(portion)}
                  </div>
                </>
              )}
            </div>
          ))}
          <button
            type="button"
            onClick={addPerson}
            disabled={
              Boolean(processingPortionId) ||
              isProcessing ||
              isTerminalChargeInFlight
            }
            className="flex w-full items-center justify-center gap-1.5 rounded-2xl border-2 border-dashed border-slate-300/90 py-2 text-xs font-medium text-slate-500 transition-colors active:border-slate-400 active:text-slate-700 disabled:cursor-not-allowed disabled:opacity-60 dark:border-white/15 dark:text-white/50 dark:active:border-white/25 dark:active:text-white/70"
          >
            <Plus className="h-3.5 w-3.5" />
            {t("splitPayment.addPerson", "Add Person")}
          </button>
        </div>
      </div>
    );
  };
  const footer = (
    <div className="split-payment-footer">
      <div className="flex gap-1 rounded-2xl bg-slate-100/80 p-0.5 dark:bg-white/5">
        <button
          type="button"
          onClick={() => setReceiptMode("combined")}
          className={`rounded-2xl px-3 py-1.5 text-xs font-medium transition-all ${receiptMode === "combined" ? "border border-yellow-400 bg-yellow-400 text-black split-payment-segment-selected" : "text-slate-500 active:text-slate-700 dark:text-white/40 dark:active:text-white/60"}`}
        >
          {t("splitPayment.receiptCombined", "All Together")}
        </button>
        <button
          type="button"
          onClick={() => setReceiptMode("individual")}
          className={`rounded-2xl px-3 py-1.5 text-xs font-medium transition-all ${receiptMode === "individual" ? "border border-yellow-400 bg-yellow-400 text-black split-payment-segment-selected" : "text-slate-500 active:text-slate-700 dark:text-white/40 dark:active:text-white/60"}`}
        >
          {t("splitPayment.receiptIndividual", "Separate")}
        </button>
      </div>
      <div className="split-payment-summary text-xs">
        {alreadyPaidAmount > 0 && (
          <span className="liquid-glass-modal-text-muted">
            {t("splitPayment.alreadyPaid", "Already Paid")}:{" "}
            <span className="font-bold text-emerald-400">
              {formatCurrency(alreadyPaidAmount)}
            </span>
          </span>
        )}
        {activeDiscountTotal > 0 && (
          <span className="liquid-glass-modal-text-muted">
            {t("modals.orderDetails.discount", { defaultValue: "Discount" })}:{" "}
            <span className="font-bold text-green-700 dark:text-green-300">
              -{formatCurrency(activeDiscountTotal)}
            </span>
          </span>
        )}
        <span className="liquid-glass-modal-text-muted">
          {t("splitPayment.outstanding", "Due")}:{" "}
          <span className="font-bold liquid-glass-modal-text">
            {formatCurrency(persistedOutstanding)}
          </span>
        </span>
        <span className="liquid-glass-modal-text-muted">
          {t("splitPayment.total", "Total")}:{" "}
          <span className="font-bold liquid-glass-modal-text">
            {formatCurrency(orderFinancials.totalAmount)}
          </span>
        </span>
        <span className="liquid-glass-modal-text-muted">
          {t("splitPayment.assigned", "Assigned")}:{" "}
          <span className="font-bold text-emerald-400">
            {formatCurrency(assignedDraftAmount)}
          </span>
        </span>
        <span className="liquid-glass-modal-text-muted">
          {t("splitPayment.remaining", "Remaining")}:{" "}
          <span
            className={`font-bold ${Math.abs(remaining) < 0.01 ? "text-emerald-400" : "text-amber-400"}`}
          >
            {formatCurrency(remaining)}
          </span>
        </span>
      </div>
      <button
        type="button"
        onClick={handleConfirm}
        disabled={!canConfirm}
        className="split-payment-confirm"
      >
        {isProcessing ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" />
            {t("splitPayment.processing", "Processing...")}
          </>
        ) : (
          <>
            <Check className="h-4 w-4" />
            {t("splitPayment.confirm", "Confirm Split")}
          </>
        )}
      </button>
    </div>
  );
  return (
    <>
      <LiquidGlassModal
        isOpen={isOpen}
        onClose={onClose}
        title={t("splitPayment.title", "Split Payment")}
        size="xl"
        className="split-payment-modal !max-w-4xl !max-h-[96vh]"
        closeMode="request"
        closeDisabled={isCloseLocked}
        closeOnBackdrop={false}
        closeOnEscape={!isCloseLocked}
        footer={footer}
        contentClassName="flex min-h-0 flex-col overflow-hidden !px-6 !py-3"
      >
          <div
            className="relative flex min-h-0 flex-1 flex-col space-y-3"
            aria-busy={isReconciliationPending}
            inert={isReconciliationPending ? true : undefined}
          >
            {isReconciliationPending && (
              <div className="absolute inset-0 z-50 flex items-center justify-center rounded-2xl bg-white/70 backdrop-blur-sm dark:bg-slate-950/70">
                <Loader2 className="h-8 w-8 animate-spin text-emerald-600 dark:text-emerald-300" />
              </div>
            )}
          <PlatformHeldPaymentNotice
            notice={platformHeldNotice}
            showBlockedAction
            className="flex-shrink-0"
          />
          <UnsavedChargedPaymentBanner
            payments={unsaved.payments}
            onSaveAgain={async () => {
              await unsaved.saveAgain();
              try { applySplitStateSnapshot(await fetchLatestSplitState(), { resetDraft: true, mode: activeTab }); } catch (refreshError) { console.warn('[SplitPaymentModal] Split refresh after Save payment again failed:', refreshError); }
            }}
            isSaving={unsaved.isSaving}
            className="flex-shrink-0"
          />
          <div className="split-payment-total flex-shrink-0">
            <p className="mb-0.5 text-sm liquid-glass-modal-text-muted">
              {t("splitPayment.orderTotal", "Order Total")}
            </p>
            <p className="text-2xl font-bold tracking-tight text-emerald-500 dark:text-emerald-400">
              {formatCurrency(orderFinancials.totalAmount)}
            </p>
            {alreadyPaidAmount > 0 && (
              <p className="mt-2 text-sm liquid-glass-modal-text-muted">
                {t("splitPayment.alreadyPaidSummary", {
                  defaultValue: "Already paid {{paid}}. Remaining due {{due}}",
                  paid: formatCurrency(alreadyPaidAmount),
                  due: formatCurrency(persistedOutstanding),
                })}
              </p>
            )}
          </div>
          {isInitializing ? (
            <div className="flex flex-shrink-0 items-center gap-3 rounded-2xl border border-slate-200/90 bg-white/80 p-4 dark:border-white/10 dark:bg-white/5">
              <Loader2 className="h-5 w-5 animate-spin text-slate-600 dark:text-white/70" />
              <div>
                <h3 className="font-semibold liquid-glass-modal-text">
                  {t("splitPayment.loading", "Loading split payment")}
                </h3>
                <p className="text-sm liquid-glass-modal-text-muted">
                  {t("splitPayment.loadingHint", {
                    defaultValue:
                      "Checking existing split payments and paid items...",
                  })}
                </p>
              </div>
            </div>
          ) : (
            <>
              <div className="flex flex-shrink-0 gap-1 rounded-xl border border-slate-200/90 bg-slate-100/80 p-1 dark:border-white/10 dark:bg-white/5">
                <button
                  type="button"
                  onClick={() => setActiveTab("by-amount")}
                  className={`flex flex-1 items-center justify-center gap-2 rounded-2xl py-2 text-sm font-medium transition-all ${activeTab === "by-amount" ? "bg-yellow-400 text-black shadow-sm split-payment-segment-selected" : "text-slate-500 active:text-slate-700 dark:text-white/40 dark:active:text-white/60"}`}
                >
                  <Split className="h-4 w-4" />
                  {t("splitPayment.byAmount", "By Amount")}
                </button>
                <button
                  type="button"
                  onClick={() => setActiveTab("by-items")}
                  className={`flex flex-1 items-center justify-center gap-2 rounded-2xl py-2 text-sm font-medium transition-all ${activeTab === "by-items" ? "bg-yellow-400 text-black shadow-sm split-payment-segment-selected" : "text-slate-500 active:text-slate-700 dark:text-white/40 dark:active:text-white/60"}`}
                >
                  <ShoppingCart className="h-4 w-4" />
                  {t("splitPayment.byItems", "By Items")}
                </button>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto scrollbar-hide pb-24 scroll-pb-24">
                {activeTab === "by-amount"
                  ? renderByAmountTab()
                  : renderByItemsTab()}
              </div>
            </>
          )}
        </div>
      </LiquidGlassModal>
      {paymentPrintPromptModal}
    </>
  );
};
