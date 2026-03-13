/**
 * SplitPaymentModal — Desktop-optimized split payment modal for the Tauri POS.
 *
 * Supports two split modes:
 *   - "By Amount": divide the order total among N people with arbitrary amounts
 *   - "By Items": assign individual line items to specific people
 *
 * Each person (portion) independently selects a payment method (cash / card).
 * After confirmation every portion is recorded as a separate payment via the
 * IPC bridge.
 */

import React, { useState, useMemo, useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { motion, AnimatePresence } from 'framer-motion';
import {
  X, CreditCard, Banknote, Plus, Trash2, Check,
  Users, ShoppingCart, Split, ChevronRight
} from 'lucide-react';
import { getBridge } from '../../../lib';
import { LiquidGlassModal } from '../ui/pos-glass-components';
import toast from 'react-hot-toast';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CartItem {
  name: string;
  quantity: number;
  totalPrice: number;
  price?: number;
  itemIndex?: number;
  [key: string]: any;
}

export interface SplitPortion {
  id: string;
  label: string;
  method: 'cash' | 'card';
  amount: number;
  items: CartItem[];
  cashReceived?: number;
  changeGiven?: number;
}

export interface SplitPaymentResult {
  mode: 'by-amount' | 'by-items';
  portions: SplitPortion[];
  receiptMode: 'combined' | 'individual';
}

interface SplitPaymentModalProps {
  isOpen: boolean;
  onClose: () => void;
  orderId: string;
  orderTotal: number;
  items: CartItem[];
  onSplitComplete: (result: SplitPaymentResult) => void;
  existingPayments?: any[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let _nextId = 1;
/** Generate a locally-unique portion id. */
function nextPortionId(): string {
  return `portion-${_nextId++}-${Date.now()}`;
}

/** Round to two decimal places (avoid floating-point drift). */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Create a fresh portion object. */
function createPortion(label: string, amount: number): SplitPortion {
  return {
    id: nextPortionId(),
    label,
    method: 'cash',
    amount: round2(amount),
    items: [],
  };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

type TabMode = 'by-amount' | 'by-items';

export const SplitPaymentModal: React.FC<SplitPaymentModalProps> = ({
  isOpen,
  onClose,
  orderId,
  orderTotal,
  items,
  onSplitComplete,
  existingPayments = [],
}) => {
  const { t } = useTranslation();
  const bridge = getBridge();

  /** Build the default label for a person at a given 0-based index. */
  const personLabel = useCallback(
    (index: number) => `${t('splitPayment.person', 'Person')} ${index + 1}`,
    [t]
  );

  // -----------------------------------------------------------------------
  // State
  // -----------------------------------------------------------------------

  const [activeTab, setActiveTab] = useState<TabMode>('by-amount');
  const [portions, setPortions] = useState<SplitPortion[]>([]);
  const [receiptMode, setReceiptMode] = useState<'combined' | 'individual'>('combined');
  const [isProcessing, setIsProcessing] = useState(false);

  // By-items mode: mapping of itemIndex -> portion id
  const [itemAssignments, setItemAssignments] = useState<Record<number, string>>({});

  // -----------------------------------------------------------------------
  // Initialization — reset state whenever the modal opens
  // -----------------------------------------------------------------------

  useEffect(() => {
    if (isOpen) {
      const half = round2(orderTotal / 2);
      setPortions([
        createPortion(personLabel(0), half),
        createPortion(personLabel(1), round2(orderTotal - half)),
      ]);
      setActiveTab('by-amount');
      setReceiptMode('combined');
      setIsProcessing(false);
      setItemAssignments({});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, orderTotal]);

  // -----------------------------------------------------------------------
  // Derived values
  // -----------------------------------------------------------------------

  const totalAssigned = useMemo(
    () => round2(portions.reduce((sum, p) => sum + p.amount, 0)),
    [portions]
  );

  const remaining = useMemo(() => round2(orderTotal - totalAssigned), [orderTotal, totalAssigned]);

  /** True when every item has been assigned to a person (by-items mode). */
  const allItemsAssigned = useMemo(() => {
    if (activeTab !== 'by-items') return true;
    return items.every((_, idx) => itemAssignments[idx] !== undefined);
  }, [activeTab, items, itemAssignments]);

  /** Can we confirm? remaining must be ~0 and (for by-items) all items assigned. */
  const canConfirm = useMemo(() => {
    return Math.abs(remaining) < 0.01 && allItemsAssigned && !isProcessing;
  }, [remaining, allItemsAssigned, isProcessing]);

  // -----------------------------------------------------------------------
  // Quick-split presets (By Amount tab)
  // -----------------------------------------------------------------------

  const applySplit5050 = useCallback(() => {
    const half = round2(orderTotal / 2);
    setPortions([
      createPortion(personLabel(0), half),
      createPortion(personLabel(1), round2(orderTotal - half)),
    ]);
  }, [orderTotal, t]);

  const applySplit3Way = useCallback(() => {
    const third = round2(orderTotal / 3);
    const lastThird = round2(orderTotal - third * 2);
    setPortions([
      createPortion(personLabel(0), third),
      createPortion(personLabel(1), third),
      createPortion(personLabel(2), lastThird),
    ]);
  }, [orderTotal, t]);

  const applyCustom = useCallback(() => {
    // Start with two empty portions so the user can type freely
    setPortions([
      createPortion(personLabel(0), 0),
      createPortion(personLabel(1), 0),
    ]);
  }, [t]);

  // -----------------------------------------------------------------------
  // Portion manipulation
  // -----------------------------------------------------------------------

  const addPerson = useCallback(() => {
    setPortions((prev) => [...prev, createPortion(personLabel(prev.length), 0)]);
  }, [t]);

  const removePerson = useCallback((id: string) => {
    setPortions((prev) => prev.filter((p) => p.id !== id));
    // Unassign items belonging to that person
    setItemAssignments((prev) => {
      const next = { ...prev };
      for (const key of Object.keys(next)) {
        if (next[Number(key)] === id) delete next[Number(key)];
      }
      return next;
    });
  }, []);

  const updatePortionAmount = useCallback((id: string, amount: number) => {
    setPortions((prev) =>
      prev.map((p) => (p.id === id ? { ...p, amount: round2(amount) } : p))
    );
  }, []);

  const updatePortionMethod = useCallback((id: string, method: 'cash' | 'card') => {
    setPortions((prev) =>
      prev.map((p) => (p.id === id ? { ...p, method } : p))
    );
  }, []);

  // -----------------------------------------------------------------------
  // Item assignment (By Items tab)
  // -----------------------------------------------------------------------

  const assignItem = useCallback(
    (itemIndex: number, portionId: string) => {
      setItemAssignments((prev) => ({ ...prev, [itemIndex]: portionId }));
    },
    []
  );

  const unassignItem = useCallback((itemIndex: number) => {
    setItemAssignments((prev) => {
      const next = { ...prev };
      delete next[itemIndex];
      return next;
    });
  }, []);

  /** Recompute portion amounts from item assignments. */
  useEffect(() => {
    if (activeTab !== 'by-items') return;

    setPortions((prev) => {
      return prev.map((p) => {
        const assignedItems = items.filter(
          (_, idx) => itemAssignments[idx] === p.id
        );
        const total = round2(
          assignedItems.reduce((sum, item) => sum + item.totalPrice, 0)
        );
        return { ...p, amount: total, items: assignedItems };
      });
    });
  }, [activeTab, itemAssignments, items]);

  // -----------------------------------------------------------------------
  // Confirm / process payments
  // -----------------------------------------------------------------------

  const handleConfirm = useCallback(async () => {
    if (!canConfirm) return;
    setIsProcessing(true);

    try {
      // Record each portion as a separate payment
      for (const portion of portions) {
        const txRef = `SPLIT-${portion.method.toUpperCase()}-${Date.now()}-${portion.id}`;
        await bridge.payments.recordPayment({
          orderId,
          method: portion.method,
          amount: portion.amount,
          cashReceived: portion.method === 'cash' ? portion.cashReceived : undefined,
          changeGiven: portion.method === 'cash' ? portion.changeGiven : undefined,
          transactionRef: txRef,
        });

        // For individual receipts, print after each payment
        if (receiptMode === 'individual') {
          try {
            await bridge.payments.printSplitReceipt(txRef);
          } catch {
            // Non-fatal — receipt printing failure should not block the flow
          }
        }
      }

      // For combined receipts, print a single receipt for the entire order
      if (receiptMode === 'combined') {
        try {
          await bridge.payments.getReceiptPreview(orderId);
        } catch {
          // Non-fatal
        }
      }

      const result: SplitPaymentResult = {
        mode: activeTab,
        portions,
        receiptMode,
      };

      toast.success(t('splitPayment.success', 'Split payment completed successfully'));
      onSplitComplete(result);
      onClose();
    } catch (error) {
      toast.error(t('splitPayment.failed', 'Split payment failed. Please try again.'));
    } finally {
      setIsProcessing(false);
    }
  }, [canConfirm, portions, orderId, receiptMode, activeTab, onSplitComplete, onClose, t]);

  // -----------------------------------------------------------------------
  // Render helpers
  // -----------------------------------------------------------------------

  /** Payment method toggle for a single portion. */
  const MethodToggle: React.FC<{ portion: SplitPortion }> = ({ portion }) => (
    <div className="flex gap-1 rounded-lg bg-white/5 p-0.5">
      <button
        type="button"
        onClick={() => updatePortionMethod(portion.id, 'cash')}
        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
          portion.method === 'cash'
            ? 'bg-green-500/20 text-green-400 border border-green-400/30'
            : 'text-white/40 hover:text-white/60'
        }`}
      >
        <Banknote className="w-3.5 h-3.5" />
        {t('splitPayment.cash', 'Cash')}
      </button>
      <button
        type="button"
        onClick={() => updatePortionMethod(portion.id, 'card')}
        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
          portion.method === 'card'
            ? 'bg-blue-500/20 text-blue-400 border border-blue-400/30'
            : 'text-white/40 hover:text-white/60'
        }`}
      >
        <CreditCard className="w-3.5 h-3.5" />
        {t('splitPayment.card', 'Card')}
      </button>
    </div>
  );

  // -----------------------------------------------------------------------
  // Render — Tab: By Amount
  // -----------------------------------------------------------------------

  const renderByAmountTab = () => (
    <div className="space-y-4">
      {/* Quick split presets */}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={applySplit5050}
          className="liquid-glass-modal-button flex-1 text-sm font-medium bg-white/5 hover:bg-white/10 liquid-glass-modal-text border border-white/10"
        >
          {t('splitPayment.halfHalf', '50 / 50')}
        </button>
        <button
          type="button"
          onClick={applySplit3Way}
          className="liquid-glass-modal-button flex-1 text-sm font-medium bg-white/5 hover:bg-white/10 liquid-glass-modal-text border border-white/10"
        >
          {t('splitPayment.threeWay', '3-Way Equal')}
        </button>
        <button
          type="button"
          onClick={applyCustom}
          className="liquid-glass-modal-button flex-1 text-sm font-medium bg-white/5 hover:bg-white/10 liquid-glass-modal-text border border-white/10"
        >
          {t('splitPayment.custom', 'Custom')}
        </button>
      </div>

      {/* Portions list */}
      <div className="space-y-3 max-h-[340px] overflow-y-auto pr-1">
        <AnimatePresence mode="popLayout">
          {portions.map((portion, idx) => (
            <motion.div
              key={portion.id}
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -12 }}
              className="p-3 rounded-xl bg-white/5 border border-white/10 space-y-2"
            >
              {/* Header row: label + remove */}
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold liquid-glass-modal-text flex items-center gap-2">
                  <Users className="w-4 h-4 text-white/40" />
                  {portion.label}
                </span>
                {portions.length > 2 && (
                  <button
                    type="button"
                    onClick={() => removePerson(portion.id)}
                    className="p-1 rounded-md text-red-400/60 hover:text-red-400 hover:bg-red-500/10 transition-colors"
                    title={t('splitPayment.removePerson', 'Remove person')}
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                )}
              </div>

              {/* Amount input + payment method */}
              <div className="flex items-center gap-3">
                <div className="relative flex-1">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-white/40 text-sm font-medium">
                    &euro;
                  </span>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={portion.amount || ''}
                    onChange={(e) =>
                      updatePortionAmount(portion.id, parseFloat(e.target.value) || 0)
                    }
                    className="w-full pl-7 pr-3 py-2 rounded-lg bg-white/10 border border-white/20 focus:border-emerald-400/50 focus:outline-none liquid-glass-modal-text text-sm font-medium transition-colors"
                    placeholder="0.00"
                  />
                </div>
                <MethodToggle portion={portion} />
              </div>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>

      {/* Add person */}
      <button
        type="button"
        onClick={addPerson}
        className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl border-2 border-dashed border-white/15 text-white/50 hover:text-white/70 hover:border-white/25 transition-colors text-sm font-medium"
      >
        <Plus className="w-4 h-4" />
        {t('splitPayment.addPerson', 'Add Person')}
      </button>

      {/* Remaining indicator */}
      <div
        className={`text-center p-3 rounded-xl border transition-colors ${
          Math.abs(remaining) < 0.01
            ? 'bg-emerald-500/10 border-emerald-400/30'
            : remaining > 0
            ? 'bg-amber-500/10 border-amber-400/30'
            : 'bg-red-500/10 border-red-400/30'
        }`}
      >
        <span className="text-xs liquid-glass-modal-text-muted">
          {t('splitPayment.remaining', 'Remaining')}
        </span>
        <p
          className={`text-lg font-bold ${
            Math.abs(remaining) < 0.01
              ? 'text-emerald-400'
              : remaining > 0
              ? 'text-amber-400'
              : 'text-red-400'
          }`}
        >
          &euro;{remaining.toFixed(2)}
        </p>
      </div>
    </div>
  );

  // -----------------------------------------------------------------------
  // Render — Tab: By Items
  // -----------------------------------------------------------------------

  const renderByItemsTab = () => {
    const unassignedCount = items.filter(
      (_, idx) => itemAssignments[idx] === undefined
    ).length;

    return (
      <div className="grid grid-cols-2 gap-4 max-h-[460px]">
        {/* Left column: order items */}
        <div className="space-y-2 overflow-y-auto pr-1">
          <h4 className="text-xs font-semibold uppercase tracking-wider text-white/40 mb-2 flex items-center gap-1.5">
            <ShoppingCart className="w-3.5 h-3.5" />
            {t('splitPayment.orderItems', 'Order Items')}
          </h4>

          {items.map((item, idx) => {
            const assignedTo = itemAssignments[idx];
            const assignedPortion = portions.find((p) => p.id === assignedTo);

            return (
              <div
                key={idx}
                className={`p-2.5 rounded-lg border transition-colors ${
                  assignedTo
                    ? 'bg-emerald-500/5 border-emerald-400/20'
                    : 'bg-white/5 border-white/10'
                }`}
              >
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-sm font-medium liquid-glass-modal-text truncate flex-1">
                    {item.quantity > 1 && (
                      <span className="text-white/40 mr-1">{item.quantity}x</span>
                    )}
                    {item.name}
                  </span>
                  <span className="text-sm font-semibold text-emerald-400 ml-2 whitespace-nowrap">
                    &euro;{item.totalPrice.toFixed(2)}
                  </span>
                </div>

                {/* Person assignment selector */}
                <select
                  value={assignedTo || ''}
                  onChange={(e) => {
                    const val = e.target.value;
                    if (val) {
                      assignItem(idx, val);
                    } else {
                      unassignItem(idx);
                    }
                  }}
                  className="w-full text-xs py-1.5 px-2 rounded-md bg-white/10 border border-white/15 liquid-glass-modal-text focus:outline-none focus:border-emerald-400/40 transition-colors"
                >
                  <option value="">
                    {t('splitPayment.unassigned', '-- Unassigned --')}
                  </option>
                  {portions.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </div>
            );
          })}

          {unassignedCount > 0 && (
            <div className="p-2 rounded-lg bg-amber-500/10 border border-amber-400/30 text-center">
              <span className="text-xs text-amber-400 font-medium">
                {t('splitPayment.unassignedWarning', {
                  count: unassignedCount,
                  defaultValue: '{{count}} item(s) not assigned',
                })}
              </span>
            </div>
          )}
        </div>

        {/* Right column: person cards */}
        <div className="space-y-2 overflow-y-auto pr-1">
          <h4 className="text-xs font-semibold uppercase tracking-wider text-white/40 mb-2 flex items-center gap-1.5">
            <Users className="w-3.5 h-3.5" />
            {t('splitPayment.people', 'People')}
          </h4>

          {portions.map((portion) => {
            const assignedItems = items.filter(
              (_, idx) => itemAssignments[idx] === portion.id
            );

            return (
              <div
                key={portion.id}
                className="p-2.5 rounded-lg bg-white/5 border border-white/10 space-y-2"
              >
                <div className="flex items-center justify-between">
                  <span className="text-sm font-semibold liquid-glass-modal-text">
                    {portion.label}
                  </span>
                  {portions.length > 2 && (
                    <button
                      type="button"
                      onClick={() => removePerson(portion.id)}
                      className="p-0.5 rounded text-red-400/60 hover:text-red-400 transition-colors"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>

                {/* Assigned items list */}
                {assignedItems.length > 0 ? (
                  <ul className="space-y-0.5">
                    {assignedItems.map((item, i) => (
                      <li
                        key={i}
                        className="text-xs liquid-glass-modal-text-muted flex justify-between"
                      >
                        <span className="truncate">
                          {item.quantity > 1 && `${item.quantity}x `}
                          {item.name}
                        </span>
                        <span className="ml-1 whitespace-nowrap">
                          &euro;{item.totalPrice.toFixed(2)}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-xs text-white/30 italic">
                    {t('splitPayment.noItems', 'No items assigned')}
                  </p>
                )}

                {/* Subtotal + method */}
                <div className="flex items-center justify-between pt-1 border-t border-white/10">
                  <span className="text-sm font-bold text-emerald-400">
                    &euro;{portion.amount.toFixed(2)}
                  </span>
                  <MethodToggle portion={portion} />
                </div>
              </div>
            );
          })}

          {/* Add person */}
          <button
            type="button"
            onClick={addPerson}
            className="w-full flex items-center justify-center gap-1.5 py-2 rounded-lg border-2 border-dashed border-white/15 text-white/50 hover:text-white/70 hover:border-white/25 transition-colors text-xs font-medium"
          >
            <Plus className="w-3.5 h-3.5" />
            {t('splitPayment.addPerson', 'Add Person')}
          </button>
        </div>
      </div>
    );
  };

  // -----------------------------------------------------------------------
  // Render — Footer (bottom bar)
  // -----------------------------------------------------------------------

  const renderFooter = () => (
    <div className="flex items-center justify-between gap-4 pt-4 border-t border-white/10">
      {/* Receipt mode toggle */}
      <div className="flex gap-1 rounded-lg bg-white/5 p-0.5">
        <button
          type="button"
          onClick={() => setReceiptMode('combined')}
          className={`px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
            receiptMode === 'combined'
              ? 'bg-white/10 liquid-glass-modal-text border border-white/20'
              : 'text-white/40 hover:text-white/60'
          }`}
        >
          {t('splitPayment.receiptCombined', 'Combined')}
        </button>
        <button
          type="button"
          onClick={() => setReceiptMode('individual')}
          className={`px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
            receiptMode === 'individual'
              ? 'bg-white/10 liquid-glass-modal-text border border-white/20'
              : 'text-white/40 hover:text-white/60'
          }`}
        >
          {t('splitPayment.receiptIndividual', 'Individual')}
        </button>
      </div>

      {/* Summary */}
      <div className="flex items-center gap-4 text-xs">
        <span className="liquid-glass-modal-text-muted">
          {t('splitPayment.total', 'Total')}:{' '}
          <span className="font-bold liquid-glass-modal-text">
            &euro;{orderTotal.toFixed(2)}
          </span>
        </span>
        <span className="liquid-glass-modal-text-muted">
          {t('splitPayment.assigned', 'Assigned')}:{' '}
          <span className="font-bold text-emerald-400">
            &euro;{totalAssigned.toFixed(2)}
          </span>
        </span>
        <span className="liquid-glass-modal-text-muted">
          {t('splitPayment.remaining', 'Remaining')}:{' '}
          <span
            className={`font-bold ${
              Math.abs(remaining) < 0.01 ? 'text-emerald-400' : 'text-amber-400'
            }`}
          >
            &euro;{remaining.toFixed(2)}
          </span>
        </span>
      </div>

      {/* Confirm */}
      <button
        type="button"
        onClick={handleConfirm}
        disabled={!canConfirm}
        className={`flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold transition-all ${
          canConfirm
            ? 'bg-emerald-600/20 hover:bg-emerald-600/30 text-emerald-400 border border-emerald-500/30 hover:scale-[1.02] active:scale-100'
            : 'bg-gray-500/20 text-gray-500 cursor-not-allowed opacity-50'
        }`}
      >
        {isProcessing ? (
          <>
            <div className="w-4 h-4 rounded-full border-2 border-emerald-400/30 border-t-emerald-400 animate-spin" />
            {t('splitPayment.processing', 'Processing...')}
          </>
        ) : (
          <>
            <Check className="w-4 h-4" />
            {t('splitPayment.confirm', 'Confirm Split')}
          </>
        )}
      </button>
    </div>
  );

  // -----------------------------------------------------------------------
  // Main render
  // -----------------------------------------------------------------------

  return (
    <LiquidGlassModal
      isOpen={isOpen}
      onClose={onClose}
      title={t('splitPayment.title', 'Split Payment')}
      size="xl"
      className="!max-w-3xl"
      closeOnBackdrop={false}
      closeOnEscape={!isProcessing}
      footer={renderFooter()}
    >
      <div className="space-y-4">
        {/* Order total display */}
        <div className="text-center">
          <p className="text-sm liquid-glass-modal-text-muted mb-1">
            {t('splitPayment.orderTotal', 'Order Total')}
          </p>
          <p className="text-3xl font-bold text-emerald-500 dark:text-emerald-400 tracking-tight">
            &euro;{orderTotal.toFixed(2)}
          </p>
        </div>

        {/* Tab selector */}
        <div className="flex gap-1 p-1 rounded-xl bg-white/5 border border-white/10">
          <button
            type="button"
            onClick={() => setActiveTab('by-amount')}
            className={`flex-1 flex items-center justify-center gap-2 py-2.5 rounded-lg text-sm font-medium transition-all ${
              activeTab === 'by-amount'
                ? 'bg-white/10 liquid-glass-modal-text shadow-sm'
                : 'text-white/40 hover:text-white/60'
            }`}
          >
            <Split className="w-4 h-4" />
            {t('splitPayment.byAmount', 'By Amount')}
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('by-items')}
            className={`flex-1 flex items-center justify-center gap-2 py-2.5 rounded-lg text-sm font-medium transition-all ${
              activeTab === 'by-items'
                ? 'bg-white/10 liquid-glass-modal-text shadow-sm'
                : 'text-white/40 hover:text-white/60'
            }`}
          >
            <ShoppingCart className="w-4 h-4" />
            {t('splitPayment.byItems', 'By Items')}
          </button>
        </div>

        {/* Tab content */}
        {activeTab === 'by-amount' ? renderByAmountTab() : renderByItemsTab()}
      </div>
    </LiquidGlassModal>
  );
};
