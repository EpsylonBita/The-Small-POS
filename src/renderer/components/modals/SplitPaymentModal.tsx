import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { motion, AnimatePresence } from 'framer-motion';
import { Banknote, BadgePercent, Check, ChevronDown, CreditCard, Loader2, Plus, ShoppingCart, Split, Trash2, Users } from 'lucide-react';
import toast from 'react-hot-toast';

import { getBridge } from '../../../lib';
import { LiquidGlassModal } from '../ui/pos-glass-components';

export interface CartItem { name: string; quantity: number; totalPrice: number; price?: number; itemIndex?: number; isSynthetic?: boolean; [key: string]: any }
type TabMode = 'by-amount' | 'by-items';
type ReceiptMode = 'combined' | 'individual';
type PortionStatus = 'draft' | 'processing' | 'paid';
type PaymentOrigin = 'manual' | 'terminal';

export interface SplitPortion {
  id: string; label: string; method: 'cash' | 'card'; amount: number; grossAmount: number; discountAmount: number;
  items: CartItem[]; status: PortionStatus; cashReceived?: number; changeGiven?: number; paymentId?: string;
  transactionRef?: string; paymentOrigin?: PaymentOrigin; terminalDeviceId?: string; paidAt?: string;
  collectedBy?: 'cashier_drawer' | 'driver_shift';
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
  allowDiscounts?: boolean;
}

interface OrderFinancialState {
  totalAmount: number; subtotal: number; discountAmount: number; discountPercentage: number;
  taxAmount: number; deliveryFee: number; tipAmount: number;
}

const EMPTY_EXISTING_PAYMENTS: any[] = [];
let nextGeneratedPortionId = 1;
const round2 = (value: number) => Math.round(value * 100) / 100;
const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);
const nextPortionId = () => `portion-${nextGeneratedPortionId++}-${Date.now()}`;
const unwrapBridgeArray = <T,>(result: any): T[] => Array.isArray(result) ? result : Array.isArray(result?.data) ? result.data : [];
const isCompletedPaymentRecord = (payment: any) => ['completed', 'paid'].includes(String(payment?.status || '').toLowerCase());
const extractPaymentId = (result: any) => (typeof result?.paymentId === 'string' ? result.paymentId : typeof result?.data?.paymentId === 'string' ? result.data.paymentId : undefined);
const extractTransactionDetails = (raw: any) => {
  const tx = raw?.transaction ?? raw?.data?.transaction ?? raw?.data ?? raw ?? {};
  return { success: raw?.success === true, status: String(tx?.status || raw?.status || '').toLowerCase(), transactionId: tx?.transactionId ?? tx?.id ?? raw?.transactionId ?? raw?.id ?? '', errorMessage: tx?.errorMessage ?? raw?.error ?? raw?.data?.error };
};
const applyPortionFinancials = (portion: SplitPortion, grossAmount: number, discountAmount = portion.discountAmount): SplitPortion => {
  const gross = round2(Math.max(0, grossAmount));
  const discount = round2(clamp(discountAmount, 0, gross));
  return { ...portion, grossAmount: gross, discountAmount: discount, amount: round2(gross - discount) };
};
const createPortion = (label: string, grossAmount: number): SplitPortion => applyPortionFinancials({ id: nextPortionId(), label, method: 'cash', amount: round2(grossAmount), grossAmount: round2(grossAmount), discountAmount: 0, items: [], status: 'draft', paymentOrigin: 'manual' }, grossAmount);
const extractOrderFinancialState = (order: any, fallbackTotal: number): OrderFinancialState => {
  const totalAmount = round2(Number(order?.total_amount ?? order?.totalAmount ?? order?.total ?? fallbackTotal));
  const discountAmount = round2(Number(order?.discount_amount ?? order?.discountAmount ?? 0));
  const discountPercentage = round2(Number(order?.discount_percentage ?? order?.discountPercentage ?? 0));
  const taxAmount = round2(Number(order?.tax_amount ?? order?.taxAmount ?? order?.tax ?? 0));
  const deliveryFee = round2(Number(order?.delivery_fee ?? order?.deliveryFee ?? 0));
  const tipAmount = round2(Number(order?.tip_amount ?? order?.tipAmount ?? 0));
  const subtotal = round2(Number(order?.subtotal ?? (totalAmount + discountAmount - taxAmount - deliveryFee - tipAmount)));
  return { totalAmount, subtotal, discountAmount, discountPercentage, taxAmount, deliveryFee, tipAmount };
};

export const SplitPaymentModal: React.FC<SplitPaymentModalProps> = ({ isOpen, onClose, orderId, orderTotal, items, onSplitComplete, existingPayments = EMPTY_EXISTING_PAYMENTS, initialMode = 'by-amount', isGhostOrder = false, collectionMode, allowDiscounts = true }) => {
  const { t } = useTranslation();
  const bridge = getBridge();
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

  const alreadyPaidAmount = useMemo(() => round2(completedPayments.reduce((sum, payment) => sum + Number(payment?.amount || 0), 0)), [completedPayments]);
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
  const activeDiscountTotal = useMemo(() => round2(portions.filter((portion) => portion.status !== 'paid').reduce((sum, portion) => sum + portion.discountAmount, 0)), [portions]);
  const assignedDraftAmount = useMemo(() => round2(portions.filter((portion) => portion.status !== 'paid').reduce((sum, portion) => sum + portion.amount, 0)), [portions]);
  const adjustedDue = useMemo(() => round2(Math.max(0, persistedOutstanding - activeDiscountTotal)), [activeDiscountTotal, persistedOutstanding]);
  const remaining = useMemo(() => round2(adjustedDue - assignedDraftAmount), [adjustedDue, assignedDraftAmount]);
  const hasPositiveAssignment = useMemo(() => portions.some((portion) => portion.status !== 'paid' && portion.amount > 0.009), [portions]);
  const anyItemsAssigned = useMemo(() => activeTab !== 'by-items' || availableItems.some((item) => itemAssignments[Number(item.itemIndex ?? 0)] !== undefined), [activeTab, availableItems, itemAssignments]);
  const canConfirm = useMemo(() => hasPositiveAssignment && anyItemsAssigned && remaining >= -0.01 && !isInitializing && !isProcessing && !processingPortionId, [anyItemsAssigned, hasPositiveAssignment, isInitializing, isProcessing, processingPortionId, remaining]);

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

  useEffect(() => {
    let cancelled = false;
    if (!isOpen) return () => { cancelled = true; };
    const loadState = async () => {
      setIsInitializing(true);
      try {
        const [paymentResult, paidItemsResult, orderResult] = await Promise.all([existingPayments.length > 0 ? Promise.resolve(existingPayments) : bridge.payments.getOrderPayments(orderId), bridge.payments.getPaidItems(orderId), bridge.orders.getById(orderId)]);
        if (cancelled) return;
        const payments = unwrapBridgeArray<any>(paymentResult).filter(isCompletedPaymentRecord);
        const paidIndices = unwrapBridgeArray<any>(paidItemsResult).map((item: any) => Number(item?.itemIndex ?? item?.item_index)).filter((itemIndex: number) => Number.isInteger(itemIndex));
        const financials = extractOrderFinancialState(orderResult, orderTotal);
        setOrderFinancials(financials);
        setCompletedPayments(payments);
        setPaidItemIndices(Array.from(new Set(paidIndices)));
        initializePortions(initialMode, round2(Math.max(0, financials.totalAmount - payments.reduce((sum: number, payment: any) => sum + Number(payment?.amount || 0), 0))));
      } catch (error) {
        console.error('[SplitPaymentModal] Failed to load split state:', error);
        if (!cancelled) initializePortions(initialMode, round2(Math.max(0, orderTotal)));
      } finally {
        if (!cancelled) setIsInitializing(false);
      }
    };
    void loadState();
    return () => { cancelled = true; };
  }, [bridge, existingPayments, initializePortions, initialMode, isOpen, orderId, orderTotal]);

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
  const setPortionMethod = useCallback((portionId: string, method: 'cash' | 'card') => updatePortion(portionId, (portion) => portion.status !== 'draft' ? portion : { ...portion, method, paymentOrigin: 'manual', terminalDeviceId: method === 'card' ? portion.terminalDeviceId : undefined }), [updatePortion]);
  const setPortionCollectedBy = useCallback((portionId: string, collectedBy: 'cashier_drawer' | 'driver_shift') => updatePortion(portionId, (portion) => portion.status !== 'draft' ? portion : { ...portion, collectedBy }), [updatePortion]);
  const openDiscountEditor = useCallback((portionId: string) => { const portion = getPortion(portionId); if (!portion || portion.status !== 'draft' || portion.grossAmount <= 0.009) return; setDiscountEditorPortionId(portionId); setDiscountDraftValue(portion.discountAmount ? portion.discountAmount.toFixed(2) : ''); }, [getPortion]);
  const saveDiscount = useCallback((portionId: string) => { const portion = getPortion(portionId); if (!portion || portion.status !== 'draft') return; updatePortion(portionId, (current) => applyPortionFinancials(current, current.grossAmount, round2(Number.parseFloat(discountDraftValue) || 0))); setDiscountEditorPortionId(null); setDiscountDraftValue(''); }, [discountDraftValue, getPortion, updatePortion]);
  const assignItem = useCallback((itemIndex: number, portionId: string | null) => { setItemAssignments((current) => { const next = { ...current }; if (portionId) next[itemIndex] = portionId; else delete next[itemIndex]; return next; }); setOpenAssignmentItemIndex(null); }, []);

  const appendCompletedPayment = useCallback((portion: SplitPortion, paymentId: string, paymentOrigin: PaymentOrigin, transactionRef?: string, terminalDeviceId?: string) => {
    const createdAt = new Date().toISOString();
    const paymentItems = portion.items.map((item) => ({ itemIndex: Number(item.itemIndex ?? 0), itemName: item.name, itemQuantity: item.quantity, itemAmount: item.totalPrice, createdAt }));
    setCompletedPayments((current) => [{ id: paymentId, orderId, method: portion.method, amount: portion.amount, discountAmount: portion.discountAmount, status: 'completed', createdAt, updatedAt: createdAt, transactionRef, paymentOrigin, terminalApproved: paymentOrigin === 'terminal', terminalDeviceId, items: paymentItems }, ...current]);
    if (paymentItems.length > 0) setPaidItemIndices((current) => Array.from(new Set([...current, ...paymentItems.map((item) => item.itemIndex)])));
    setPortions((current) => current.map((currentPortion) => currentPortion.id === portion.id ? { ...currentPortion, status: 'paid', paymentId, paymentOrigin, transactionRef, terminalDeviceId, paidAt: createdAt } : currentPortion));
  }, [orderId]);

  const persistAdditionalDiscount = useCallback(async (discountDelta: number) => {
    const delta = round2(discountDelta);
    if (delta <= 0.009) return orderFinancials;
    const next = { ...orderFinancials, totalAmount: round2(Math.max(0, orderFinancials.totalAmount - delta)), discountAmount: round2(orderFinancials.discountAmount + delta) };
    await bridge.orders.updateFinancials({ orderId, totalAmount: next.totalAmount, subtotal: next.subtotal, discountAmount: next.discountAmount, discountPercentage: next.discountPercentage, taxAmount: next.taxAmount, deliveryFee: next.deliveryFee, tipAmount: next.tipAmount });
    setOrderFinancials(next);
    return next;
  }, [bridge, orderFinancials, orderId]);

  const safePrintSplitReceipt = useCallback(async (paymentId: string) => { try { await bridge.payments.printSplitReceipt(paymentId); } catch (error) { console.warn('[SplitPaymentModal] Failed to print split receipt:', error); toast.error(t('orderDashboard.printFailed', { defaultValue: 'Receipt print failed' })); } }, [bridge, t]);
  const printFinalOrderDocuments = useCallback(async () => {
    try { await bridge.payments.printReceipt(orderId); } catch (error) { console.warn('[SplitPaymentModal] Final receipt print failed:', error); toast.error(t('orderDashboard.printFailed', { defaultValue: 'Receipt print failed' })); }
    if (isGhostOrder) return;
    try { const fiscalResult: any = await bridge.ecr.fiscalPrint(orderId); if (fiscalResult?.skipped) return; } catch (error) { console.warn('[SplitPaymentModal] Fiscal print failed:', error); toast.error(t('orderDashboard.fiscalPrintFailed', { defaultValue: 'Cash register print failed' })); }
  }, [bridge, isGhostOrder, orderId, t]);
  const recordPortionPayment = useCallback(async (portion: SplitPortion, paymentOrigin: PaymentOrigin, transactionRef?: string, terminalDeviceId?: string) => {
    const result: any = await bridge.payments.recordPayment({ orderId, method: portion.method, amount: portion.amount, discountAmount: portion.discountAmount, cashReceived: portion.method === 'cash' ? portion.amount : undefined, changeGiven: portion.method === 'cash' ? 0 : undefined, transactionRef, paymentOrigin, terminalApproved: paymentOrigin === 'terminal', terminalDeviceId, collectedBy: portion.collectedBy ?? defaultCollectedBy, items: activeTab === 'by-items' ? portion.items.map((item) => ({ itemIndex: Number(item.itemIndex ?? 0), itemName: item.name, itemQuantity: item.quantity, itemAmount: item.totalPrice })) : undefined });
    const paymentId = extractPaymentId(result); if (result?.success === false || !paymentId) throw new Error(result?.error || 'Missing paymentId after recording split payment');
    appendCompletedPayment(portion, paymentId, paymentOrigin, transactionRef, terminalDeviceId);
    return paymentId;
  }, [activeTab, appendCompletedPayment, bridge, defaultCollectedBy, orderId]);

  const completeAndClose = useCallback(async (recordedPortions: SplitPortion[], paymentIds: string[], updatedOrderTotal: number, recordedAmount: number) => {
    const remainingAmount = round2(Math.max(0, updatedOrderTotal - (alreadyPaidAmount + recordedAmount)));
    const paymentStatus = remainingAmount <= 0.01 ? 'paid' : 'partially_paid';
    if (paymentStatus === 'paid') await printFinalOrderDocuments();
    await onSplitComplete({ mode: activeTab, portions: recordedPortions, receiptMode, paymentIds, paymentStatus, remainingAmount, recordedAmount: round2(recordedAmount) });
    toast.success(paymentStatus === 'paid' ? t('splitPayment.success', 'Split payment completed successfully') : t('splitPayment.partialSuccess', { defaultValue: 'Split payment recorded. Remaining balance: €{{amount}}', amount: remainingAmount.toFixed(2) }));
    onClose();
  }, [activeTab, alreadyPaidAmount, onClose, onSplitComplete, printFinalOrderDocuments, receiptMode, t]);

  const resolveReadyTerminal = useCallback(async () => { const raw: any = await bridge.ecr.getDefaultTerminal(); const device = raw?.device ?? raw?.data?.device ?? null; const deviceId = typeof device?.id === 'string' ? device.id : ''; if (!deviceId) return null; const status: any = await bridge.ecr.getDeviceStatus(deviceId); return status?.connected === true && status?.ready === true && status?.busy !== true ? { deviceId, name: device?.name || deviceId } : null; }, [bridge]);
  const handleTerminalCardPayment = useCallback(async (portionId: string) => {
    const portion = getPortion(portionId); if (!portion || portion.status !== 'draft') return; setPortionMethod(portionId, 'card'); if (portion.amount <= 0.009) return;
    if (processingPortionId && processingPortionId !== portionId) { toast.error(t('splitPayment.cardBusy', { defaultValue: 'Another card payment is already in progress' })); return; }
    let terminal: { deviceId: string; name: string } | null = null; try { terminal = await resolveReadyTerminal(); } catch (error) { console.warn('[SplitPaymentModal] Failed to resolve terminal:', error); }
    if (!terminal) { toast(t('splitPayment.manualCardFallback', { defaultValue: 'No ready payment terminal. This portion will be recorded as a manual card payment on confirm.' })); return; }
    updatePortion(portionId, (current) => ({ ...current, method: 'card', status: 'processing', paymentOrigin: 'terminal', terminalDeviceId: terminal!.deviceId }));
    try {
      const updatedFinancials = await persistAdditionalDiscount(portion.discountAmount);
      const rawPayment: any = await bridge.ecr.processPayment(portion.amount, { deviceId: terminal.deviceId, orderId, reference: `${orderId}:${portion.id}` });
      const tx = extractTransactionDetails(rawPayment); if (!tx.success || tx.status !== 'approved' || !tx.transactionId) throw new Error(tx.errorMessage || 'Card payment was not approved');
      const paymentId = await recordPortionPayment(portion, 'terminal', tx.transactionId, terminal.deviceId);
      if (receiptMode === 'individual') await safePrintSplitReceipt(paymentId);
      const nextRemaining = round2(Math.max(0, updatedFinancials.totalAmount - (alreadyPaidAmount + portion.amount)));
      if (nextRemaining <= 0.01) { await completeAndClose([{ ...portion, status: 'paid', paymentId, paymentOrigin: 'terminal', transactionRef: tx.transactionId, terminalDeviceId: terminal.deviceId }], [paymentId], updatedFinancials.totalAmount, portion.amount); return; }
      toast.success(t('splitPayment.portionPaid', { defaultValue: '{{person}} paid successfully', person: portion.label }));
    } catch (error) {
      console.error('[SplitPaymentModal] Terminal card payment failed:', error);
      updatePortion(portionId, (current) => ({ ...current, status: 'draft', paymentOrigin: 'manual' }));
      toast.error(error instanceof Error ? error.message : t('splitPayment.cardFailed', { defaultValue: 'Card payment failed' }));
    }
  }, [alreadyPaidAmount, bridge, completeAndClose, getPortion, orderId, persistAdditionalDiscount, processingPortionId, receiptMode, recordPortionPayment, resolveReadyTerminal, safePrintSplitReceipt, setPortionMethod, t, updatePortion]);

  const handleConfirm = useCallback(async () => {
    if (!canConfirm) return;
    const draftPortions = portions.filter((portion) => portion.status === 'draft' && portion.amount > 0.009); if (!draftPortions.length) return;
    setIsProcessing(true);
    try {
      const updatedFinancials = await persistAdditionalDiscount(round2(draftPortions.reduce((sum, portion) => sum + portion.discountAmount, 0)));
      const paymentIds: string[] = []; const recordedPortions: SplitPortion[] = [];
      for (const portion of draftPortions) { const origin: PaymentOrigin = portion.method === 'card' ? (portion.paymentOrigin || 'manual') : 'manual'; const paymentId = await recordPortionPayment(portion, origin, portion.transactionRef, portion.terminalDeviceId); paymentIds.push(paymentId); recordedPortions.push({ ...portion, status: 'paid', paymentId, paymentOrigin: origin }); if (receiptMode === 'individual') await safePrintSplitReceipt(paymentId); }
      await completeAndClose(recordedPortions, paymentIds, updatedFinancials.totalAmount, recordedPortions.reduce((sum, portion) => sum + portion.amount, 0));
    } catch (error) {
      console.error('[SplitPaymentModal] Split confirmation failed:', error);
      toast.error(error instanceof Error ? error.message : t('splitPayment.failed', 'Split payment failed. Please try again.'));
    } finally {
      setIsProcessing(false);
    }
  }, [canConfirm, completeAndClose, persistAdditionalDiscount, portions, receiptMode, recordPortionPayment, safePrintSplitReceipt, t]);

  const MethodToggle: React.FC<{ portion: SplitPortion }> = ({ portion }) => {
    const locked = portion.status !== 'draft' || isProcessing;
    return (
      <div className="flex gap-1 rounded-lg bg-white/5 p-0.5">
        <button
          type="button"
          disabled={locked}
          onClick={() => setPortionMethod(portion.id, 'cash')}
          className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-all ${portion.method === 'cash' ? 'border border-green-400/30 bg-green-500/20 text-green-400' : 'text-white/40 hover:text-white/60'} ${locked ? 'cursor-not-allowed opacity-70' : ''}`}
        >
          <Banknote className="h-3.5 w-3.5" />
          {t('splitPayment.cash', 'Cash')}
        </button>
        <button
          type="button"
          disabled={locked}
          onClick={() => void handleTerminalCardPayment(portion.id)}
          className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-all ${portion.method === 'card' ? 'border border-blue-400/30 bg-blue-500/20 text-blue-400' : 'text-white/40 hover:text-white/60'} ${locked ? 'cursor-not-allowed opacity-70' : ''}`}
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
    const locked = portion.status !== 'draft' || isProcessing;
    const showDriverShift = collectionMode.allowDriverShift === true;
    const selectedOwner = portion.collectedBy ?? defaultCollectedBy ?? 'cashier_drawer';
    return (
      <div className="space-y-1">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-white/40">
          {collectionMode.label || t('splitPayment.collectedBy', { defaultValue: 'Collected By' })}
        </p>
        {collectionMode.description ? (
          <p className="text-xs liquid-glass-modal-text-muted">{collectionMode.description}</p>
        ) : null}
        <div className="flex gap-1 rounded-lg bg-white/5 p-0.5">
          <button
            type="button"
            disabled={locked}
            onClick={() => setPortionCollectedBy(portion.id, 'cashier_drawer')}
            className={`flex-1 rounded-md px-3 py-1.5 text-xs font-medium transition-all ${selectedOwner !== 'driver_shift' ? 'border border-emerald-400/30 bg-emerald-500/15 text-emerald-300' : 'text-white/50 hover:text-white/70'} ${locked ? 'cursor-not-allowed opacity-70' : ''}`}
          >
            {t('splitPayment.cashierDrawer', { defaultValue: 'Cashier' })}
          </button>
          {showDriverShift ? (
            <button
              type="button"
              disabled={locked}
              onClick={() => setPortionCollectedBy(portion.id, 'driver_shift')}
              className={`flex-1 rounded-md px-3 py-1.5 text-xs font-medium transition-all ${selectedOwner === 'driver_shift' ? 'border border-blue-400/30 bg-blue-500/15 text-blue-300' : 'text-white/50 hover:text-white/70'} ${locked ? 'cursor-not-allowed opacity-70' : ''}`}
            >
              {t('splitPayment.driverShift', { defaultValue: 'Driver' })}
            </button>
          ) : null}
        </div>
      </div>
    );
  };
  const renderPortionDetails = (portion: SplitPortion) => (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-xs liquid-glass-modal-text-muted">
        <span>{t('modals.orderDetails.subtotal', { defaultValue: 'Subtotal' })}</span>
        <span>&euro;{portion.grossAmount.toFixed(2)}</span>
      </div>
      <div className="flex items-center justify-between text-xs text-green-300">
        <span>{t('modals.orderDetails.discount', { defaultValue: 'Discount' })}</span>
        <span>-&euro;{portion.discountAmount.toFixed(2)}</span>
      </div>
      <div className="flex items-center justify-between text-sm font-semibold text-emerald-400">
        <span>{t('splitPayment.payable', { defaultValue: 'Payable' })}</span>
        <span>&euro;{portion.amount.toFixed(2)}</span>
      </div>
      {portion.status === 'paid' ? (
        <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-200">
          {t('modals.orderDetails.paid', { defaultValue: 'Paid' })} • {t(portion.method === 'card' ? 'modals.orderDetails.card' : 'modals.orderDetails.cash', { defaultValue: portion.method === 'card' ? 'Card' : 'Cash' })}
          {portion.paymentOrigin === 'terminal' ? ` • ${t('splitPayment.terminalApproved', { defaultValue: 'Terminal' })}` : ''}
        </div>
      ) : portion.status === 'processing' ? (
        <div className="rounded-lg border border-blue-500/30 bg-blue-500/10 px-3 py-2 text-xs text-blue-200">
          {t('splitPayment.waitingForApproval', { defaultValue: 'Waiting for card approval on the payment terminal...' })}
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
                className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-all ${portion.grossAmount > 0.009 ? 'border border-yellow-500/30 bg-yellow-500/10 text-yellow-300 hover:bg-yellow-500/15' : 'cursor-not-allowed bg-gray-500/20 text-gray-500'}`}
              >
                <BadgePercent className="h-3.5 w-3.5" />
                {t('splitPayment.discount', { defaultValue: 'Discount' })}
              </button>
              {discountEditorPortionId === portion.id ? (
                <div className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 p-2">
                  <div className="relative flex-1">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-white/40">&euro;</span>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      max={portion.grossAmount}
                      value={discountDraftValue}
                      onChange={(event) => setDiscountDraftValue(event.target.value)}
                      className="w-full rounded-lg border border-white/20 bg-white/10 py-2 pl-7 pr-3 text-sm liquid-glass-modal-text focus:border-emerald-400/50 focus:outline-none"
                      placeholder="0.00"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => saveDiscount(portion.id)}
                    className="rounded-lg border border-emerald-500/30 bg-emerald-600/20 px-3 py-2 text-xs font-semibold text-emerald-300"
                  >
                    {t('common.actions.apply', { defaultValue: 'Apply' })}
                  </button>
                  <button
                    type="button"
                    onClick={() => { setDiscountEditorPortionId(null); setDiscountDraftValue(''); }}
                    className="rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs font-semibold text-white/70"
                  >
                    {t('common.actions.cancel', { defaultValue: 'Cancel' })}
                  </button>
                </div>
              ) : null}
            </>
          ) : null}
        </>
      )}
    </div>
  );
  const renderByAmountTab = () => <div className="space-y-4"><div className="flex gap-2"><button type="button" onClick={() => { const half = round2(adjustedDue / 2); setPortions([createPortion(personLabel(0), half), createPortion(personLabel(1), round2(adjustedDue - half))]); }} className="liquid-glass-modal-button flex-1 border border-white/10 bg-white/5 text-sm font-medium liquid-glass-modal-text hover:bg-white/10">{t('splitPayment.halfHalf', '50 / 50')}</button><button type="button" onClick={() => { const third = round2(adjustedDue / 3); setPortions([createPortion(personLabel(0), third), createPortion(personLabel(1), third), createPortion(personLabel(2), round2(adjustedDue - third * 2))]); }} className="liquid-glass-modal-button flex-1 border border-white/10 bg-white/5 text-sm font-medium liquid-glass-modal-text hover:bg-white/10">{t('splitPayment.threeWay', '3-Way Equal')}</button><button type="button" onClick={() => setPortions([createPortion(personLabel(0), 0), createPortion(personLabel(1), 0)])} className="liquid-glass-modal-button flex-1 border border-white/10 bg-white/5 text-sm font-medium liquid-glass-modal-text hover:bg-white/10">{t('splitPayment.custom', 'Custom')}</button></div><div className="max-h-[380px] space-y-3 overflow-y-auto pr-1"><AnimatePresence mode="popLayout">{portions.map((portion) => <motion.div key={portion.id} initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -12 }} className="space-y-3 rounded-xl border border-white/10 bg-white/5 p-3"><div className="flex items-center justify-between"><span className="flex items-center gap-2 text-sm font-semibold liquid-glass-modal-text"><Users className="h-4 w-4 text-white/40" />{portion.label}</span>{portions.length > 2 && portion.status === 'draft' && <button type="button" onClick={() => removePerson(portion.id)} className="rounded-md p-1 text-red-400/60 transition-colors hover:bg-red-500/10 hover:text-red-400"><Trash2 className="h-4 w-4" /></button>}</div><div className="flex items-center gap-3"><div className="relative flex-1"><span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm font-medium text-white/40">&euro;</span><input type="number" step="0.01" min="0" value={portion.grossAmount || ''} disabled={portion.status !== 'draft' || isProcessing} onChange={(event) => updatePortionGrossAmount(portion.id, Number.parseFloat(event.target.value) || 0)} className="w-full rounded-lg border border-white/20 bg-white/10 py-2 pl-7 pr-3 text-sm font-medium liquid-glass-modal-text focus:border-emerald-400/50 focus:outline-none disabled:cursor-not-allowed disabled:opacity-70" placeholder="0.00" /></div><MethodToggle portion={portion} /></div>{renderPortionDetails(portion)}</motion.div>)}</AnimatePresence></div><button type="button" onClick={addPerson} disabled={Boolean(processingPortionId) || isProcessing} className="flex w-full items-center justify-center gap-2 rounded-xl border-2 border-dashed border-white/15 py-2.5 text-sm font-medium text-white/50 transition-colors hover:border-white/25 hover:text-white/70 disabled:cursor-not-allowed disabled:opacity-60"><Plus className="h-4 w-4" />{t('splitPayment.addPerson', 'Add Person')}</button></div>;
  const renderByItemsTab = () => { const unassignedCount = availableItems.filter((item) => itemAssignments[Number(item.itemIndex ?? 0)] === undefined).length; return <div className="grid max-h-[500px] grid-cols-2 gap-4"><div className="space-y-2 overflow-y-auto pr-1"><h4 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-white/40"><ShoppingCart className="h-3.5 w-3.5" />{t('splitPayment.orderItems', 'Order Items')}</h4>{availableItems.map((item) => { const itemIndex = Number(item.itemIndex ?? 0); const assignedTo = itemAssignments[itemIndex]; const assignedPortion = portions.find((portion) => portion.id === assignedTo); return <div key={itemIndex} className={`rounded-lg border p-2.5 transition-colors ${assignedTo ? 'border-emerald-400/20 bg-emerald-500/5' : 'border-white/10 bg-white/5'}`}><div className="mb-1.5 flex items-center justify-between"><span className="flex-1 truncate text-sm font-medium liquid-glass-modal-text">{item.quantity > 1 && <span className="mr-1 text-white/40">{item.quantity}x</span>}{item.name}</span><span className="ml-2 whitespace-nowrap text-sm font-semibold text-emerald-400">&euro;{item.totalPrice.toFixed(2)}</span></div><div className="space-y-1.5"><button type="button" onClick={() => setOpenAssignmentItemIndex((current) => current === itemIndex ? null : itemIndex)} className={`flex w-full items-center justify-between gap-2 rounded-md border px-2 py-1.5 text-xs transition-colors ${openAssignmentItemIndex === itemIndex ? 'border-emerald-400/40 bg-white/12' : 'border-white/15 bg-white/10 hover:border-white/25 hover:bg-white/12'}`}><span className={`truncate ${assignedPortion ? 'text-white' : 'text-white/70'}`}>{assignedPortion?.label || t('splitPayment.unassigned', '-- Unassigned --')}</span><ChevronDown className={`h-3.5 w-3.5 text-white/50 transition-transform ${openAssignmentItemIndex === itemIndex ? 'rotate-180' : ''}`} /></button>{openAssignmentItemIndex === itemIndex && <div className="overflow-hidden rounded-lg border border-white/15 bg-[#2f2f2f] shadow-xl"><button type="button" onClick={() => assignItem(itemIndex, null)} className={`w-full px-3 py-2 text-left text-xs transition-colors ${!assignedTo ? 'bg-emerald-500/20 text-emerald-300' : 'text-white/80 hover:bg-white/8'}`}>{t('splitPayment.unassigned', '-- Unassigned --')}</button>{portions.filter((portion) => portion.status !== 'paid').map((portion) => <button key={portion.id} type="button" onClick={() => assignItem(itemIndex, portion.id)} className={`w-full px-3 py-2 text-left text-xs transition-colors ${assignedTo === portion.id ? 'bg-emerald-500/20 text-emerald-300' : 'text-white hover:bg-white/8'}`}>{portion.label}</button>)}</div>}</div></div>; })}{availableItems.length === 0 && <div className="rounded-lg border border-emerald-400/30 bg-emerald-500/10 p-2 text-center"><span className="text-xs font-medium text-emerald-400">{t('splitPayment.allItemsPaid', { defaultValue: 'All remaining balance has already been allocated to previous item payments' })}</span></div>}{availableItems.length > 0 && unassignedCount > 0 && <div className="rounded-lg border border-amber-400/30 bg-amber-500/10 p-2 text-center"><span className="text-xs font-medium text-amber-400">{t('splitPayment.unassignedWarning', { count: unassignedCount, defaultValue: '{{count}} item(s) not assigned' })}</span></div>}</div><div className="space-y-2 overflow-y-auto pr-1"><h4 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-white/40"><Users className="h-3.5 w-3.5" />{t('splitPayment.people', 'People')}</h4>{portions.map((portion) => <div key={portion.id} className={`space-y-2 rounded-lg border p-2.5 ${portion.status === 'paid' ? 'border-emerald-400/20 bg-emerald-500/5' : portion.status === 'processing' ? 'border-blue-400/25 bg-blue-500/5' : 'border-white/10 bg-white/5'}`}><div className="flex items-center justify-between"><span className="text-sm font-semibold liquid-glass-modal-text">{portion.label}</span>{portions.length > 2 && portion.status === 'draft' && <button type="button" onClick={() => removePerson(portion.id)} className="rounded p-0.5 text-red-400/60 transition-colors hover:text-red-400"><Trash2 className="h-3.5 w-3.5" /></button>}</div>{portion.items.length > 0 ? <ul className="space-y-0.5">{portion.items.map((item) => <li key={`${portion.id}-${item.itemIndex}`} className="flex justify-between text-xs liquid-glass-modal-text-muted"><span className="truncate">{item.quantity > 1 && `${item.quantity}x `}{item.name}</span><span className="ml-1 whitespace-nowrap">&euro;{item.totalPrice.toFixed(2)}</span></li>)}</ul> : <p className="text-xs italic text-white/30">{t('splitPayment.noItems', 'No items assigned')}</p>}<div className="border-t border-white/10 pt-2"><div className="mb-2 flex items-center justify-between"><span className="text-sm font-bold text-emerald-400">&euro;{portion.amount.toFixed(2)}</span><MethodToggle portion={portion} /></div>{renderPortionDetails(portion)}</div></div>)}<button type="button" onClick={addPerson} disabled={Boolean(processingPortionId) || isProcessing} className="flex w-full items-center justify-center gap-1.5 rounded-lg border-2 border-dashed border-white/15 py-2 text-xs font-medium text-white/50 transition-colors hover:border-white/25 hover:text-white/70 disabled:cursor-not-allowed disabled:opacity-60"><Plus className="h-3.5 w-3.5" />{t('splitPayment.addPerson', 'Add Person')}</button></div></div>; };
  const footer = <div className="flex items-center justify-between gap-4 border-t border-white/10 pt-4"><div className="flex gap-1 rounded-lg bg-white/5 p-0.5"><button type="button" onClick={() => setReceiptMode('combined')} className={`rounded-md px-3 py-1.5 text-xs font-medium transition-all ${receiptMode === 'combined' ? 'border border-white/20 bg-white/10 liquid-glass-modal-text' : 'text-white/40 hover:text-white/60'}`}>{t('splitPayment.receiptCombined', 'All Together')}</button><button type="button" onClick={() => setReceiptMode('individual')} className={`rounded-md px-3 py-1.5 text-xs font-medium transition-all ${receiptMode === 'individual' ? 'border border-white/20 bg-white/10 liquid-glass-modal-text' : 'text-white/40 hover:text-white/60'}`}>{t('splitPayment.receiptIndividual', 'Separate')}</button></div><div className="flex items-center gap-4 text-xs">{alreadyPaidAmount > 0 && <span className="liquid-glass-modal-text-muted">{t('splitPayment.alreadyPaid', 'Already Paid')}: <span className="font-bold text-emerald-400">&euro;{alreadyPaidAmount.toFixed(2)}</span></span>}{activeDiscountTotal > 0 && <span className="liquid-glass-modal-text-muted">{t('modals.orderDetails.discount', { defaultValue: 'Discount' })}: <span className="font-bold text-green-300">-&euro;{activeDiscountTotal.toFixed(2)}</span></span>}<span className="liquid-glass-modal-text-muted">{t('splitPayment.outstanding', 'Due')}: <span className="font-bold liquid-glass-modal-text">&euro;{persistedOutstanding.toFixed(2)}</span></span><span className="liquid-glass-modal-text-muted">{t('splitPayment.total', 'Total')}: <span className="font-bold liquid-glass-modal-text">&euro;{orderFinancials.totalAmount.toFixed(2)}</span></span><span className="liquid-glass-modal-text-muted">{t('splitPayment.assigned', 'Assigned')}: <span className="font-bold text-emerald-400">&euro;{assignedDraftAmount.toFixed(2)}</span></span><span className="liquid-glass-modal-text-muted">{t('splitPayment.remaining', 'Remaining')}: <span className={`font-bold ${Math.abs(remaining) < 0.01 ? 'text-emerald-400' : 'text-amber-400'}`}>&euro;{remaining.toFixed(2)}</span></span></div><button type="button" onClick={handleConfirm} disabled={!canConfirm} className={`flex items-center gap-2 rounded-xl px-5 py-2.5 text-sm font-semibold transition-all ${canConfirm ? 'border border-emerald-500/30 bg-emerald-600/20 text-emerald-400 hover:scale-[1.02] hover:bg-emerald-600/30 active:scale-100' : 'cursor-not-allowed bg-gray-500/20 text-gray-500 opacity-50'}`}>{isProcessing ? <><Loader2 className="h-4 w-4 animate-spin" />{t('splitPayment.processing', 'Processing...')}</> : <><Check className="h-4 w-4" />{t('splitPayment.confirm', 'Confirm Split')}</>}</button></div>;
  return <LiquidGlassModal isOpen={isOpen} onClose={processingPortionId || isProcessing ? () => undefined : onClose} title={t('splitPayment.title', 'Split Payment')} size="xl" className="!max-w-4xl" closeOnBackdrop={false} closeOnEscape={!processingPortionId && !isProcessing} footer={footer}><div className="space-y-4"><div className="text-center"><p className="mb-1 text-sm liquid-glass-modal-text-muted">{t('splitPayment.orderTotal', 'Order Total')}</p><p className="text-3xl font-bold tracking-tight text-emerald-500 dark:text-emerald-400">&euro;{orderFinancials.totalAmount.toFixed(2)}</p>{alreadyPaidAmount > 0 && <p className="mt-2 text-sm liquid-glass-modal-text-muted">{t('splitPayment.alreadyPaidSummary', { defaultValue: 'Already paid €{{paid}}. Remaining due €{{due}}', paid: alreadyPaidAmount.toFixed(2), due: persistedOutstanding.toFixed(2) })}</p>}</div>{isInitializing ? <div className="flex items-center gap-3 rounded-xl border border-white/10 bg-white/5 p-4"><Loader2 className="h-5 w-5 animate-spin text-white/70" /><div><h3 className="font-semibold liquid-glass-modal-text">{t('splitPayment.loading', 'Loading split payment')}</h3><p className="text-sm liquid-glass-modal-text-muted">{t('splitPayment.loadingHint', { defaultValue: 'Checking existing split payments and paid items...' })}</p></div></div> : <><div className="flex gap-1 rounded-xl border border-white/10 bg-white/5 p-1"><button type="button" onClick={() => setActiveTab('by-amount')} className={`flex flex-1 items-center justify-center gap-2 rounded-lg py-2.5 text-sm font-medium transition-all ${activeTab === 'by-amount' ? 'bg-white/10 liquid-glass-modal-text shadow-sm' : 'text-white/40 hover:text-white/60'}`}><Split className="h-4 w-4" />{t('splitPayment.byAmount', 'By Amount')}</button><button type="button" onClick={() => setActiveTab('by-items')} className={`flex flex-1 items-center justify-center gap-2 rounded-lg py-2.5 text-sm font-medium transition-all ${activeTab === 'by-items' ? 'bg-white/10 liquid-glass-modal-text shadow-sm' : 'text-white/40 hover:text-white/60'}`}><ShoppingCart className="h-4 w-4" />{t('splitPayment.byItems', 'By Items')}</button></div>{activeTab === 'by-amount' ? renderByAmountTab() : renderByItemsTab()}</>}</div></LiquidGlassModal>;
};
