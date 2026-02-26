import React from 'react';
import { useTranslation } from 'react-i18next';
import { ShoppingCart, Trash2, AlertTriangle, Ban, Ticket, X, Loader2, Plus, ScanLine } from 'lucide-react';
import { useI18n } from '../../contexts/i18n-context';
import { useOnBarcodeScan } from '../../contexts/barcode-scanner-context';
import { useLoyaltyReader } from '../../hooks/useLoyaltyReader';
import { formatCurrency } from '../../utils/format';
import { getBridge } from '../../../lib';
import toast from 'react-hot-toast';

const LINE_PRICE_HOLD_DURATION_MS = 5000;
const LINE_PRICE_HOLD_TICK_MS = 100;

interface CartItem {
  id: string | number;
  name: string;
  quantity: number;
  price: number;
  unitPrice?: number;
  totalPrice: number;
  originalUnitPrice?: number | null;
  isPriceOverridden?: boolean;
  categoryName?: string; // Main category (e.g., "Crepes", "Waffles")
  flavorType?: 'savory' | 'sweet' | null; // Flavor type for display
  customizations?: Array<{
    ingredient: {
      id: string;
      name: string;
      name_en?: string;
      name_el?: string;
      price?: number;
      pickup_price?: number;
      delivery_price?: number;
      category_name?: string;
    };
    quantity: number;
    isLittle?: boolean;
    isWithout?: boolean;
  }>;
  notes?: string;
}

export interface AppliedCoupon {
  id: string;
  code: string;
  discount_type: 'percentage' | 'fixed_amount';
  discount_value: number;
  minimum_order_amount?: number;
}

interface MenuCartProps {
  cartItems: CartItem[];
  onCheckout: () => void;
  onUpdateCart: (items: CartItem[]) => void;
  onEditItem?: (item: CartItem) => void;
  onRemoveItem?: (itemId: string | number) => void;
  discountPercentage?: number;
  manualDiscountMode?: 'percentage' | 'fixed';
  manualDiscountValue?: number;
  maxDiscountPercentage?: number;
  onDiscountChange?: (percentage: number) => void;
  onManualDiscountChange?: (mode: 'percentage' | 'fixed', value: number) => void;
  editMode?: boolean; // When true, shows "Save Changes" instead of "Complete Order"
  isSaving?: boolean; // When true, shows loading state on save button
  orderType?: 'pickup' | 'delivery'; // Order type for minimum order validation
  minimumOrderAmount?: number; // Minimum order amount for delivery zones
  // Coupon props
  appliedCoupon?: AppliedCoupon | null;
  onApplyCoupon?: (code: string) => void;
  onRemoveCoupon?: () => void;
  couponDiscount?: number;
  isValidatingCoupon?: boolean;
  couponError?: string | null;
  // Manual item props
  onAddManualItem?: (price: number, name?: string) => void;
  onLinePriceChange?: (itemId: string | number, newUnitPrice: number) => void;
}

export const MenuCart: React.FC<MenuCartProps> = ({
  cartItems,
  onCheckout,
  onUpdateCart,
  onEditItem,
  onRemoveItem,
  discountPercentage = 0,
  manualDiscountMode = 'percentage',
  manualDiscountValue = 0,
  maxDiscountPercentage = 30,
  onDiscountChange,
  onManualDiscountChange,
  editMode = false,
  isSaving = false,
  orderType,
  minimumOrderAmount = 0,
  appliedCoupon,
  onApplyCoupon,
  onRemoveCoupon,
  couponDiscount = 0,
  isValidatingCoupon = false,
  couponError,
  onAddManualItem,
  onLinePriceChange,
}) => {
  const { t } = useTranslation();

  // Deduplicate cart items by ID to prevent React key warnings
  // This is a safety measure in case duplicates somehow make it into the cart
  const uniqueCartItems = React.useMemo(() => {
    const seen = new Set<string | number>();
    return cartItems.filter(item => {
      if (seen.has(item.id)) {
        console.warn('Duplicate cart item detected:', item.id);
        return false;
      }
      seen.add(item.id);
      return true;
    });
  }, [cartItems]);
  const { language } = useI18n();

  const [couponInput, setCouponInput] = React.useState('');
  const [isCouponModalOpen, setIsCouponModalOpen] = React.useState(false);
  const [showManualInput, setShowManualInput] = React.useState(false);
  const [manualPrice, setManualPrice] = React.useState('');
  const [manualName, setManualName] = React.useState('');
  const [isDiscountModalOpen, setIsDiscountModalOpen] = React.useState(false);
  const [discountModeDraft, setDiscountModeDraft] = React.useState<'percentage' | 'fixed'>(
    onManualDiscountChange ? manualDiscountMode : 'percentage'
  );
  const [discountDraft, setDiscountDraft] = React.useState<number>(
    onManualDiscountChange ? manualDiscountValue : discountPercentage || 0
  );
  const [discountManualInput, setDiscountManualInput] = React.useState<string>('');
  const [editingLineItemId, setEditingLineItemId] = React.useState<string | number | null>(null);
  const [linePriceDraft, setLinePriceDraft] = React.useState<string>('');
  const [holdingLineItemId, setHoldingLineItemId] = React.useState<string | number | null>(null);
  const [linePriceHoldProgress, setLinePriceHoldProgress] = React.useState<number>(0);
  const holdStartAtRef = React.useRef<number | null>(null);
  const holdItemSnapshotRef = React.useRef<string | null>(null);
  const holdPointerIdRef = React.useRef<number | null>(null);
  const holdTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const holdProgressIntervalRef = React.useRef<ReturnType<typeof setInterval> | null>(null);
  const couponInputRef = React.useRef<HTMLInputElement | null>(null);

  const discountPresetValues = React.useMemo(() => (
    Array.from({ length: 10 }, (_, index) => (index + 1) * 10)
  ), []);

  React.useEffect(() => {
    const mode = onManualDiscountChange ? manualDiscountMode : 'percentage';
    const value = onManualDiscountChange ? manualDiscountValue : discountPercentage || 0;
    setDiscountModeDraft(mode);
    setDiscountDraft(value || 0);
    setDiscountManualInput(value ? String(value) : '');
  }, [manualDiscountMode, manualDiscountValue, discountPercentage, onManualDiscountChange]);

  React.useEffect(() => {
    if (!isDiscountModalOpen && !isCouponModalOpen) {
      return;
    }

    const onEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsDiscountModalOpen(false);
        setIsCouponModalOpen(false);
      }
    };

    window.addEventListener('keydown', onEscape);
    return () => {
      window.removeEventListener('keydown', onEscape);
    };
  }, [isDiscountModalOpen, isCouponModalOpen]);

  React.useEffect(() => {
    if (!isCouponModalOpen) {
      return;
    }
    if (appliedCoupon) {
      setIsCouponModalOpen(false);
      setCouponInput('');
    }
  }, [isCouponModalOpen, appliedCoupon]);

  React.useEffect(() => {
    if (!isCouponModalOpen) {
      return;
    }

    const focusTimer = window.setTimeout(() => {
      couponInputRef.current?.focus();
    }, 20);

    return () => {
      window.clearTimeout(focusTimer);
    };
  }, [isCouponModalOpen]);

  useOnBarcodeScan((barcode) => {
    if (!isCouponModalOpen || !onApplyCoupon) {
      return;
    }
    const scannedCode = (barcode || '').trim().toUpperCase();
    if (!scannedCode) {
      return;
    }
    setCouponInput(scannedCode);
    onApplyCoupon(scannedCode);
  }, [isCouponModalOpen, onApplyCoupon]);

  const handleLoyaltyCardScanned = React.useCallback(async (card: { uid: string }) => {
    const uid = (card?.uid || '').trim().toUpperCase();
    if (!uid) return;

    // If the coupon modal is open, fall through to apply the card UID as a coupon code
    if (isCouponModalOpen && onApplyCoupon) {
      setCouponInput(uid);
      onApplyCoupon(uid);
      return;
    }

    // Otherwise, perform a loyalty card lookup via IPC
    try {
      const bridge = getBridge();
      const result = await bridge.loyalty.lookupByCard(uid) as any;
      if (result?.success && result?.customer) {
        toast.success(t('loyalty.customerFound', { name: result.customer.customer_name || '', defaultValue: 'Loyalty customer found: {{name}}' }));
        if (result.customer.points_balance > 0) {
          toast(t('loyalty.balanceInfo', { points: result.customer.points_balance, defaultValue: 'Balance: {{points}} points' }), { icon: '\uD83C\uDF81' });
        }
      } else {
        toast.error(t('loyalty.cardNotFound', 'Card not linked to any loyalty account'));
      }
    } catch (err) {
      console.warn('[MenuCart] Loyalty card lookup failed:', err);
    }
  }, [isCouponModalOpen, onApplyCoupon, t]);

  const { start: startLoyaltyReader } = useLoyaltyReader(isCouponModalOpen, handleLoyaltyCardScanned);

  const clearHoldTimers = React.useCallback(() => {
    if (holdTimeoutRef.current) {
      clearTimeout(holdTimeoutRef.current);
      holdTimeoutRef.current = null;
    }
    if (holdProgressIntervalRef.current) {
      clearInterval(holdProgressIntervalRef.current);
      holdProgressIntervalRef.current = null;
    }
  }, []);

  const cancelLinePriceHold = React.useCallback(() => {
    clearHoldTimers();
    holdStartAtRef.current = null;
    holdItemSnapshotRef.current = null;
    holdPointerIdRef.current = null;
    setHoldingLineItemId(null);
    setLinePriceHoldProgress(0);
  }, [clearHoldTimers]);

  const closeLinePriceModal = React.useCallback(() => {
    setEditingLineItemId(null);
    setLinePriceDraft('');
  }, []);

  const openLinePriceModal = React.useCallback((itemId: string | number, unitPrice: number) => {
    setEditingLineItemId(itemId);
    setLinePriceDraft(unitPrice.toFixed(2));
  }, []);

  const applyLinePriceDraft = React.useCallback(() => {
    if (editingLineItemId === null) {
      return;
    }

    const next = Number.parseFloat(linePriceDraft.replace(',', '.').trim());
    if (!Number.isFinite(next) || next < 0) {
      return;
    }

    const targetItem = cartItems.find((ci) => ci.id === editingLineItemId);
    if (!targetItem) {
      closeLinePriceModal();
      return;
    }

    const baselinePrice =
      targetItem.unitPrice ||
      targetItem.price ||
      ((targetItem.totalPrice || 0) / Math.max(targetItem.quantity || 1, 1));

    if (onLinePriceChange) {
      onLinePriceChange(editingLineItemId, next);
    } else {
      const updatedItems = cartItems.map(ci =>
        ci.id === editingLineItemId
          ? {
              ...ci,
              unitPrice: next,
              totalPrice: next * ci.quantity,
              originalUnitPrice: ci.originalUnitPrice ?? baselinePrice,
              isPriceOverridden:
                Math.abs(next - (ci.originalUnitPrice ?? baselinePrice)) > 0.0001,
            }
          : ci
      );
      onUpdateCart(updatedItems);
    }

    closeLinePriceModal();
  }, [editingLineItemId, linePriceDraft, cartItems, onLinePriceChange, onUpdateCart, closeLinePriceModal]);

  const startLinePriceHold = React.useCallback(
    (
      event: React.PointerEvent<HTMLButtonElement>,
      itemId: string | number,
      unitPrice: number,
      holdSnapshot: string
    ) => {
      if (event.pointerType === 'mouse' && event.button !== 0) {
        return;
      }

      event.stopPropagation();
      cancelLinePriceHold();
      holdPointerIdRef.current = event.pointerId;
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {}
      setHoldingLineItemId(itemId);
      holdStartAtRef.current = Date.now();
      holdItemSnapshotRef.current = holdSnapshot;
      setLinePriceHoldProgress(0);

      holdProgressIntervalRef.current = setInterval(() => {
        if (holdStartAtRef.current === null) {
          return;
        }
        const elapsed = Date.now() - holdStartAtRef.current;
        const progress = Math.min(99, (elapsed / LINE_PRICE_HOLD_DURATION_MS) * 100);
        setLinePriceHoldProgress(progress);
      }, LINE_PRICE_HOLD_TICK_MS);

      holdTimeoutRef.current = setTimeout(() => {
        setLinePriceHoldProgress(100);
        openLinePriceModal(itemId, unitPrice);
        cancelLinePriceHold();
      }, LINE_PRICE_HOLD_DURATION_MS);
    },
    [cancelLinePriceHold, openLinePriceModal]
  );

  const handleLinePricePointerEnd = React.useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      if (holdPointerIdRef.current !== null && event.pointerId !== holdPointerIdRef.current) {
        return;
      }
      cancelLinePriceHold();
    },
    [cancelLinePriceHold]
  );

  React.useEffect(() => {
    if (editingLineItemId === null) {
      return;
    }

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeLinePriceModal();
      }
    };

    window.addEventListener('keydown', handleEscape);
    return () => {
      window.removeEventListener('keydown', handleEscape);
    };
  }, [editingLineItemId, closeLinePriceModal]);

  React.useEffect(() => {
    if (holdingLineItemId === null) {
      return;
    }

    const cancelFromWindow = () => cancelLinePriceHold();
    window.addEventListener('blur', cancelFromWindow);
    window.addEventListener('scroll', cancelFromWindow, true);

    return () => {
      window.removeEventListener('blur', cancelFromWindow);
      window.removeEventListener('scroll', cancelFromWindow, true);
    };
  }, [holdingLineItemId, cancelLinePriceHold]);

  React.useEffect(() => {
    if (holdingLineItemId !== null && !cartItems.some((item) => item.id === holdingLineItemId)) {
      cancelLinePriceHold();
    }
  }, [holdingLineItemId, cartItems, cancelLinePriceHold]);

  React.useEffect(() => {
    if (holdingLineItemId === null || holdItemSnapshotRef.current === null) {
      return;
    }

    const heldItem = cartItems.find((item) => item.id === holdingLineItemId);
    if (!heldItem) {
      cancelLinePriceHold();
      return;
    }

    const heldItemUnitPrice =
      heldItem.unitPrice ||
      heldItem.price ||
      ((heldItem.totalPrice || 0) / Math.max(heldItem.quantity || 1, 1));
    const currentSnapshot = `${heldItem.quantity}:${heldItemUnitPrice}:${heldItem.totalPrice || 0}`;

    if (currentSnapshot !== holdItemSnapshotRef.current) {
      cancelLinePriceHold();
    }
  }, [cartItems, holdingLineItemId, cancelLinePriceHold]);

  React.useEffect(() => {
    if (editingLineItemId !== null && !cartItems.some((item) => item.id === editingLineItemId)) {
      closeLinePriceModal();
    }
  }, [editingLineItemId, cartItems, closeLinePriceModal]);

  React.useEffect(() => {
    return () => {
      clearHoldTimers();
    };
  }, [clearHoldTimers]);

  const parseDiscountInput = (value: string, mode: 'percentage' | 'fixed'): number => {
    const normalized = value.replace(',', '.').trim();
    const parsed = Number.parseFloat(normalized);
    if (!Number.isFinite(parsed)) {
      return 0;
    }
    if (mode === 'percentage') {
      return Math.max(0, Math.min(parsed, 100));
    }
    return Math.max(0, parsed);
  };

  const openDiscountModal = () => {
    const mode = onManualDiscountChange ? manualDiscountMode : 'percentage';
    const current = onManualDiscountChange ? manualDiscountValue : discountPercentage || 0;
    setDiscountModeDraft(mode);
    setDiscountDraft(current);
    setDiscountManualInput(current > 0 ? String(current) : '');
    setIsDiscountModalOpen(true);
  };

  const applyCouponFromModal = React.useCallback(() => {
    if (!onApplyCoupon) {
      return;
    }
    const normalizedCode = couponInput.trim().toUpperCase();
    if (!normalizedCode) {
      return;
    }
    setCouponInput(normalizedCode);
    onApplyCoupon(normalizedCode);
  }, [couponInput, onApplyCoupon]);

  const applyDraftDiscount = () => {
    if (!onDiscountChange && !onManualDiscountChange) {
      return;
    }
    if (onManualDiscountChange) {
      if (discountModeDraft === 'percentage') {
        const nextValue = Math.max(0, Math.min(discountDraft, maxDiscountPercentage));
        onManualDiscountChange('percentage', nextValue);
      } else {
        const nextValue = Math.max(0, Math.min(discountDraft, getSubtotal()));
        onManualDiscountChange('fixed', nextValue);
      }
    } else {
      const nextValue = Math.max(0, Math.min(discountDraft, maxDiscountPercentage));
      onDiscountChange?.(nextValue);
    }
    setIsDiscountModalOpen(false);
  };

  const clearDiscount = () => {
    setDiscountDraft(0);
    setDiscountManualInput('');
    if (onManualDiscountChange) {
      onManualDiscountChange(discountModeDraft, 0);
    } else {
      onDiscountChange?.(0);
    }
    setIsDiscountModalOpen(false);
  };

  const isDraftOverMax = discountModeDraft === 'percentage' && discountDraft > maxDiscountPercentage;

  // Helper function to get localized ingredient name
  const getIngredientName = (ingredient: {
    id: string;
    name: string;
    name_en?: string;
    name_el?: string;
    price?: number;
    pickup_price?: number;
    delivery_price?: number;
  }): string => {
    if (language === 'el' && ingredient.name_el) {
      return ingredient.name_el;
    }
    if (language === 'en' && ingredient.name_en) {
      return ingredient.name_en;
    }
    // Fallback to name_en, then name_el, then name
    return ingredient.name_en || ingredient.name_el || ingredient.name || 'Unknown';
  };

  const getSubtotal = () => {
    return uniqueCartItems.reduce((sum, item) => sum + (item.totalPrice || 0), 0);
  };

  const subtotal = getSubtotal();
  const effectiveDiscountMode = onManualDiscountChange ? manualDiscountMode : 'percentage';
  const effectiveDiscountValue = onManualDiscountChange ? manualDiscountValue : discountPercentage;
  const effectiveDiscountPercentage = effectiveDiscountMode === 'percentage'
    ? Math.max(0, Math.min(effectiveDiscountValue || 0, 100))
    : 0;
  const discountAmount = effectiveDiscountMode === 'percentage'
    ? subtotal * (effectiveDiscountPercentage / 100)
    : Math.min(Math.max(effectiveDiscountValue || 0, 0), subtotal);
  const discountControlEnabled = Boolean(onDiscountChange || onManualDiscountChange);
  const isAppliedDiscountOverMax =
    effectiveDiscountMode === 'percentage' && effectiveDiscountPercentage > maxDiscountPercentage;
  const totalAfterDiscount = subtotal - discountAmount - couponDiscount;
  const editingLineItem = editingLineItemId === null
    ? null
    : cartItems.find(item => item.id === editingLineItemId) ?? null;
  const parsedLinePriceDraft = Number.parseFloat(linePriceDraft.replace(',', '.').trim());
  const isLinePriceDraftValid = Number.isFinite(parsedLinePriceDraft) && parsedLinePriceDraft >= 0;

  // Minimum order validation for delivery orders
  const isDeliveryOrder = orderType === 'delivery';
  const isBelowMinimum = isDeliveryOrder && minimumOrderAmount > 0 && totalAfterDiscount < minimumOrderAmount;
  const shortfall = isBelowMinimum ? minimumOrderAmount - totalAfterDiscount : 0;

  return (
    <div
      className="flex flex-col h-full w-full border-l border-black/10 dark:border-white/10 bg-white/5 dark:bg-black/10"
    >
      {/* Header - flex-shrink-0 keeps it fixed size */}
      <div className="flex-shrink-0 border-b border-black/10 dark:border-white/10">
        <div className="flex items-center justify-between p-4">
          <h3 className="text-lg font-semibold liquid-glass-modal-title !text-base">
            {t('menu.cart.header', { count: uniqueCartItems.length })}
          </h3>
          {onAddManualItem && !editMode && (
            <button
              onClick={() => setShowManualInput((prev) => !prev)}
              className={`p-1.5 rounded-lg transition-colors ${
                showManualInput
                  ? 'bg-blue-500 text-white'
                  : 'liquid-glass-modal-text-muted hover:bg-black/5 dark:hover:bg-white/10'
              }`}
              title={t('menu.cart.addManualItem', 'Manual Item')}
            >
              <Plus className="w-4 h-4" />
            </button>
          )}
        </div>
        {/* Manual item inline form */}
        {showManualInput && onAddManualItem && (
          <div className={`px-4 pb-3 space-y-2`}>
            <div className="flex gap-2">
              <input
                type="text"
                value={manualName}
                onChange={(e) => setManualName(e.target.value)}
                placeholder={t('menu.cart.manualNamePlaceholder', 'Item name (optional)')}
                className="flex-1 px-2.5 py-1.5 text-sm border rounded-lg antialiased bg-black/5 dark:bg-white/10 border-black/10 dark:border-white/15 liquid-glass-modal-text placeholder:text-black/40 dark:placeholder:text-white/40 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div className="flex gap-2">
              <input
                type="number"
                value={manualPrice}
                onChange={(e) => setManualPrice(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    const price = parseFloat(manualPrice);
                    if (price > 0) {
                      onAddManualItem(price, manualName.trim() || undefined);
                      setManualPrice('');
                      setManualName('');
                      setShowManualInput(false);
                    }
                  }
                }}
                min="0.01"
                step="0.01"
                placeholder={t('menu.cart.manualPricePlaceholder', 'Price')}
                className="flex-1 px-2.5 py-1.5 text-sm border rounded-lg antialiased bg-black/5 dark:bg-white/10 border-black/10 dark:border-white/15 liquid-glass-modal-text placeholder:text-black/40 dark:placeholder:text-white/40 focus:outline-none focus:ring-2 focus:ring-blue-500"
                autoFocus
              />
              <button
                onClick={() => {
                  const price = parseFloat(manualPrice);
                  if (price > 0) {
                    onAddManualItem(price, manualName.trim() || undefined);
                    setManualPrice('');
                    setManualName('');
                    setShowManualInput(false);
                  }
                }}
                disabled={!manualPrice || parseFloat(manualPrice) <= 0}
                className={`px-3 py-1.5 text-sm font-medium rounded-lg transition-colors ${
                  !manualPrice || parseFloat(manualPrice) <= 0
                    ? 'bg-black/10 dark:bg-white/10 text-black/30 dark:text-white/30 cursor-not-allowed'
                    : 'bg-blue-500 text-white hover:bg-blue-600'
                }`}
              >
                {t('common.add', 'Add')}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Scrollable Cart Items - flex-1 + min-h-0 allows proper scrolling */}
      <div className="flex-1 min-h-0 overflow-y-auto p-2 sm:p-4 touch-scroll pos-scrollbar-glass">
        {uniqueCartItems.length === 0 ? (
          <div className="text-center py-6 sm:py-8">
            <ShoppingCart className="w-12 h-12 sm:w-16 sm:h-16 mx-auto mb-3 sm:mb-4 text-black/20 dark:text-white/20" />
            <p className="text-sm sm:text-base antialiased liquid-glass-modal-text-muted">
              {t('menu.cart.empty')}
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {uniqueCartItems.map((item) => {
              const itemUnitPrice =
                item.unitPrice ||
                item.price ||
                ((item.totalPrice || 0) / Math.max(item.quantity || 1, 1));
              const isHoldingLinePrice = holdingLineItemId === item.id;
              const isPriceOverridden =
                item.isPriceOverridden || ((item.originalUnitPrice ?? itemUnitPrice) !== itemUnitPrice);

              return (
              <div
                key={item.id}
                className={`p-3 rounded-xl border transition-all duration-200 bg-black/[0.03] dark:bg-white/[0.06] border-black/8 dark:border-white/10 hover:border-blue-400/50 dark:hover:border-blue-400/40 hover:bg-black/[0.05] dark:hover:bg-white/[0.09] ${onEditItem ? 'cursor-pointer' : ''}`}
                onClick={() => onEditItem?.(item)}
              >
                <div className="flex justify-between items-start mb-2">
                  <div className="flex-1">
                    {/* Category label */}
                    {item.categoryName && (
                      <div className="text-[10px] uppercase tracking-wider font-medium mb-0.5 antialiased liquid-glass-modal-text-muted">
                        {item.categoryName}
                      </div>
                    )}
                    {/* Item name (subcategory) */}
                    <h4 className="font-semibold antialiased liquid-glass-modal-text">
                      {item.name}
                    </h4>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="font-semibold antialiased text-emerald-600 dark:text-emerald-400">
                      {formatCurrency(item.totalPrice || 0)}
                    </span>
                    {/* Delete button - positioned away from main click area */}
                    {onRemoveItem && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onRemoveItem(item.id);
                        }}
                        className="p-1.5 rounded-full hover:bg-red-500/20 transition-colors ml-2 text-red-600 dark:text-red-400"
                        title={t('common.actions.delete')}
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                </div>
                {/* Quantity controls */}
                <div
                  className="flex items-center justify-between mt-2 antialiased liquid-glass-modal-text-muted"
                  onClick={(e) => e.stopPropagation()}
                >
                  <div className="flex items-center gap-2">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        if (item.quantity <= 1) {
                          onRemoveItem?.(item.id);
                        } else {
                          const updatedItems = cartItems.map(ci =>
                            ci.id === item.id
                              ? {
                                  ...ci,
                                  quantity: ci.quantity - 1,
                                  totalPrice:
                                    (ci.unitPrice || ci.price || (ci.totalPrice / ci.quantity)) *
                                    (ci.quantity - 1),
                                }
                              : ci
                          );
                          onUpdateCart(updatedItems);
                        }
                      }}
                      className="w-7 h-7 rounded-full flex items-center justify-center font-bold transition-colors bg-black/8 dark:bg-white/12 hover:bg-black/15 dark:hover:bg-white/20 liquid-glass-modal-text"
                    >
                      −
                    </button>
                    <span className="min-w-[24px] text-center font-semibold antialiased liquid-glass-modal-text">{item.quantity}</span>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        const updatedItems = cartItems.map(ci =>
                          ci.id === item.id
                            ? {
                                ...ci,
                                quantity: ci.quantity + 1,
                                totalPrice:
                                  (ci.unitPrice || ci.price || (ci.totalPrice / ci.quantity)) *
                                  (ci.quantity + 1),
                              }
                            : ci
                        );
                        onUpdateCart(updatedItems);
                      }}
                      className="w-7 h-7 rounded-full flex items-center justify-center font-bold transition-colors bg-black/8 dark:bg-white/12 hover:bg-black/15 dark:hover:bg-white/20 liquid-glass-modal-text"
                    >
                      +
                    </button>
                  </div>
                  <button
                    type="button"
                    onPointerDown={(event) =>
                      startLinePriceHold(
                        event,
                        item.id,
                        itemUnitPrice || 0,
                        `${item.quantity}:${itemUnitPrice || 0}:${item.totalPrice || 0}`
                      )
                    }
                    onPointerUp={handleLinePricePointerEnd}
                    onPointerCancel={handleLinePricePointerEnd}
                    onLostPointerCapture={handleLinePricePointerEnd}
                    onContextMenu={(event) => event.preventDefault()}
                    onClick={(event) => event.stopPropagation()}
                    className={`relative overflow-hidden px-2.5 py-1 rounded-md text-sm font-medium antialiased transition-colors ${
                      isHoldingLinePrice
                        ? 'bg-blue-500/15 text-blue-600 dark:text-blue-300'
                        : 'liquid-glass-modal-text hover:bg-black/8 dark:hover:bg-white/10'
                    }`}
                  >
                    <span className="relative z-[1]">× {formatCurrency(itemUnitPrice || 0)}</span>
                    {isHoldingLinePrice && (
                      <span
                        className="absolute left-0 bottom-0 h-[2px] bg-blue-500/70 rounded-full"
                        style={{ width: `${linePriceHoldProgress}%` }}
                      />
                    )}
                  </button>
                </div>
                {isPriceOverridden && (
                  <div className="mt-2 flex items-center justify-end" onClick={(e) => e.stopPropagation()}>
                    <span className="text-[11px] px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-600 dark:text-amber-300">
                      {t('menu.cart.priceOverridden', 'Overridden')}
                    </span>
                  </div>
                )}
                {item.customizations && item.customizations.length > 0 && (
                  <div className="mt-2 pt-2 border-t border-black/8 dark:border-white/10">
                    {/* Separate "with" and "without" ingredients */}
                    {(() => {
                      const withIngredients = item.customizations.filter(c => !c.isWithout);
                      const withoutIngredients = item.customizations.filter(c => c.isWithout);

                      return (
                        <>
                          {/* Added ingredients */}
                          {withIngredients.length > 0 && (
                            <>
                              <div className="text-xs font-semibold mb-1 antialiased liquid-glass-modal-text-muted">
                                {t('menu.cart.ingredients')}:
                              </div>
                              <div className="flex flex-wrap gap-1">
                                {withIngredients.map((c, idx) => {
                                  const ingredientName = getIngredientName(c.ingredient);
                                  const quantityText = c.quantity > 1 ? ` ×${c.quantity}` : '';
                                  const littleText = c.isLittle ? ` (${t('menu.itemModal.little')})` : '';

                                  return (
                                    <span
                                      key={`${item.id}-customization-${c.ingredient.id}-${idx}`}
                                      className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium antialiased bg-blue-500/15 text-blue-700 dark:bg-blue-500/25 dark:text-blue-200"
                                    >
                                      + {ingredientName}
                                      {quantityText && (
                                        <span className="ml-1 font-bold text-blue-800 dark:text-blue-100">
                                          {quantityText}
                                        </span>
                                      )}
                                      {littleText && (
                                        <span className="ml-1 opacity-80">{littleText}</span>
                                      )}
                                    </span>
                                  );
                                })}
                              </div>
                            </>
                          )}

                          {/* Without ingredients */}
                          {withoutIngredients.length > 0 && (
                            <>
                              <div className={`text-xs font-semibold mb-1 antialiased text-red-500 dark:text-red-400 ${withIngredients.length > 0 ? 'mt-2' : ''}`}>
                                <span className="inline-flex items-center gap-1">
                                  <Ban className="w-3 h-3" aria-hidden="true" />
                                  {t('menu.cart.without', { defaultValue: 'Without' })}:
                                </span>
                              </div>
                              <div className="flex flex-wrap gap-1">
                                {withoutIngredients.map((c, idx) => {
                                  const ingredientName = getIngredientName(c.ingredient);

                                  return (
                                    <span
                                      key={`${item.id}-without-${c.ingredient.id}-${idx}`}
                                      className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium antialiased bg-red-500/15 text-red-700 dark:bg-red-500/25 dark:text-red-200 line-through"
                                    >
                                      {ingredientName}
                                    </span>
                                  );
                                })}
                              </div>
                            </>
                          )}
                        </>
                      );
                    })()}
                  </div>
                )}
                {/* Special Notes */}
                {item.notes && item.notes.trim() && (
                  <div className="mt-2 pt-2 border-t border-black/8 dark:border-white/10">
                    <div className="text-xs font-semibold mb-1 antialiased text-amber-600 dark:text-amber-400">
                      📝 {t('menu.cart.specialNotes') || t('menu.itemModal.specialInstructions')}:
                    </div>
                    <p className="text-xs italic antialiased liquid-glass-modal-text-muted">
                      {item.notes}
                    </p>
                  </div>
                )}
              </div>
            )})}
          </div>
        )}
      </div>

      {/* Cart Footer - flex-shrink-0 keeps it fixed at bottom */}
      <div className="flex-shrink-0 p-4 border-t border-black/10 dark:border-white/10 bg-white/5 dark:bg-black/10 space-y-3">
        {/* Coupon + Discount Controls */}
        {!editMode && (onApplyCoupon || discountControlEnabled) && (
          <div className="space-y-2">
            <div className={`grid gap-2 ${onApplyCoupon && discountControlEnabled ? 'grid-cols-2' : 'grid-cols-1'}`}>
              {onApplyCoupon && (
                <button
                  type="button"
                  onClick={() => setIsCouponModalOpen(true)}
                  className="h-11 px-3 text-sm font-semibold border rounded-lg antialiased transition-colors bg-black/5 dark:bg-white/10 border-black/10 dark:border-white/15 liquid-glass-modal-text hover:bg-black/10 dark:hover:bg-white/15 focus:outline-none focus:ring-2 focus:ring-blue-500 flex items-center justify-between"
                >
                  <span>{t('menu.cart.couponButton', 'Coupon')}</span>
                  {isValidatingCoupon ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <span className="text-xs font-semibold opacity-80">
                      {appliedCoupon ? appliedCoupon.code : t('menu.cart.applyCoupon', 'Apply')}
                    </span>
                  )}
                </button>
              )}

              {discountControlEnabled && (
                <button
                  type="button"
                  onClick={openDiscountModal}
                  className="h-11 px-3 text-sm font-semibold border rounded-lg antialiased transition-colors bg-black/5 dark:bg-white/10 border-black/10 dark:border-white/15 liquid-glass-modal-text hover:bg-black/10 dark:hover:bg-white/15 focus:outline-none focus:ring-2 focus:ring-blue-500 flex items-center justify-between"
                >
                  <span>{t('menu.cart.discountAmount', 'Discount')}</span>
                  <span>
                    {effectiveDiscountMode === 'percentage'
                      ? `${effectiveDiscountPercentage}%`
                      : formatCurrency(discountAmount)}
                  </span>
                </button>
              )}
            </div>

            {couponError && !appliedCoupon && (
              <p className="text-xs text-red-500 font-medium antialiased">{couponError}</p>
            )}

            {isAppliedDiscountOverMax && (
              <p className="text-xs text-red-500 text-right font-medium antialiased">
                {t('menu.cart.discountExceeded', { max: maxDiscountPercentage })}
              </p>
            )}

            {onApplyCoupon && appliedCoupon && (
              <div className="flex items-center justify-between rounded-lg px-3 py-2 bg-emerald-500/10 dark:bg-emerald-500/20 border border-emerald-500/20 dark:border-emerald-500/30">
                <div className="flex items-center gap-2">
                  <Ticket className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
                  <div>
                    <span className="text-sm font-semibold antialiased text-emerald-700 dark:text-emerald-400">
                      {appliedCoupon.code}
                    </span>
                    <span className="text-xs ml-2 antialiased text-emerald-600/70 dark:text-emerald-300/70">
                      {appliedCoupon.discount_type === 'percentage'
                        ? `${appliedCoupon.discount_value}%`
                        : formatCurrency(appliedCoupon.discount_value)
                      } {t('menu.cart.couponOff', 'off')}
                    </span>
                  </div>
                </div>
                {onRemoveCoupon && (
                  <button
                    onClick={onRemoveCoupon}
                    className="p-1 rounded-full transition-colors text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/20"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            )}
          </div>
        )}

        {/* Subtotal */}
        <div className="flex justify-between items-center text-sm font-medium antialiased">
          <span className="liquid-glass-modal-text-muted">
            {t('menu.cart.subtotal')}
          </span>
          <span className="liquid-glass-modal-text">
            {formatCurrency(subtotal)}
          </span>
        </div>

        {/* Discount Display */}
        {discountAmount > 0 && (
          <div className="flex justify-between items-center text-sm font-medium antialiased">
            <span className="text-green-600 dark:text-green-400">
              {effectiveDiscountMode === 'percentage'
                ? t('menu.cart.discount', { percent: effectiveDiscountPercentage })
                : t('menu.cart.discountAmount', 'Discount')}:
            </span>
            <span className="text-green-600 dark:text-green-400">
              -{formatCurrency(discountAmount)}
            </span>
          </div>
        )}

        {/* Coupon Discount Display */}
        {couponDiscount > 0 && appliedCoupon && (
          <div className="flex justify-between items-center text-sm font-medium antialiased">
            <span className="flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
              <Ticket className="w-3.5 h-3.5" />
              {t('menu.cart.couponDiscount', 'Coupon')} ({appliedCoupon.code}):
            </span>
            <span className="text-emerald-600 dark:text-emerald-400">
              -{formatCurrency(couponDiscount)}
            </span>
          </div>
        )}

        {/* Total */}
        <div className="flex justify-between items-center pt-2 border-t border-black/10 dark:border-white/10 antialiased">
          <span className="text-lg font-semibold liquid-glass-modal-text">
            {t('menu.cart.total')}
          </span>
          <span className="text-xl font-bold text-emerald-600 dark:text-emerald-400">
            {formatCurrency(totalAfterDiscount)}
          </span>
        </div>

        {/* Minimum Order Warning for Delivery */}
        {isBelowMinimum && !editMode && (
          <div className="flex items-center gap-2 p-3 rounded-lg mb-3 bg-orange-500/10 dark:bg-orange-500/20 border border-orange-500/20 dark:border-orange-500/30">
            <AlertTriangle className="w-5 h-5 flex-shrink-0 text-orange-500 dark:text-orange-400" />
            <div className="flex-1">
              <p className="text-sm font-medium antialiased text-orange-600 dark:text-orange-400">
                {t('menu.cart.minimumNotMet', 'Minimum order not met')}
              </p>
              <p className="text-xs antialiased text-orange-500/80 dark:text-orange-300/80">
                {t('menu.cart.addMoreToOrder', 'Add {{amount}} more to complete order', { amount: formatCurrency(shortfall) })}
              </p>
            </div>
          </div>
        )}

        <button
          onClick={onCheckout}
          disabled={uniqueCartItems.length === 0 || isAppliedDiscountOverMax || isSaving || (isBelowMinimum && !editMode)}
          className={`w-full py-3 rounded-xl font-semibold antialiased transition-all duration-300 ${
            uniqueCartItems.length === 0 || isAppliedDiscountOverMax || isSaving || (isBelowMinimum && !editMode)
              ? 'bg-black/10 dark:bg-white/10 text-black/30 dark:text-white/30 cursor-not-allowed'
              : editMode
                ? 'bg-amber-600 text-white hover:bg-amber-700 hover:scale-[1.02]'
                : 'bg-blue-600 text-white hover:bg-blue-700 hover:scale-[1.02]'
          }`}
        >
          {isSaving ? (
            <span className="flex items-center justify-center gap-2">
              <svg className="animate-spin h-5 w-5" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
              </svg>
              {t('common.saving')}
            </span>
          ) : editMode ? (
            t('modals.menu.saveChanges') || t('common.saveChanges')
          ) : (
            t('menu.cart.completeOrder')
          )}
        </button>
      </div>

      {editingLineItem && (
        <div className="fixed inset-0 z-[1190] flex items-center justify-center p-4">
          <button
            type="button"
            aria-label={t('common.close', 'Close')}
            onClick={closeLinePriceModal}
            className="absolute inset-0 bg-black/45 backdrop-blur-sm"
          />
          <div
            className="relative w-full max-w-xs rounded-2xl border bg-white/85 dark:bg-black/75 border-black/10 dark:border-white/15 shadow-2xl p-4 space-y-3"
            onClick={(event) => event.stopPropagation()}
          >
            <div>
              <h4 className="text-base font-semibold liquid-glass-modal-text">
                {t('menu.cart.changePrice', 'Change Price')}
              </h4>
              <p className="text-xs mt-1 liquid-glass-modal-text-muted">
                {editingLineItem.name}
              </p>
            </div>

            <div className="space-y-2">
              <label className="text-xs font-semibold antialiased liquid-glass-modal-text-muted">
                {t('order.unit_price', 'Unit price')}
              </label>
              <input
                type="text"
                inputMode="decimal"
                autoFocus
                value={linePriceDraft}
                onChange={(event) => setLinePriceDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && isLinePriceDraftValid) {
                    event.preventDefault();
                    applyLinePriceDraft();
                  }
                }}
                placeholder="0.00"
                className="w-full px-3 py-2 text-sm border rounded-lg antialiased bg-black/5 dark:bg-white/10 border-black/10 dark:border-white/15 liquid-glass-modal-text placeholder:text-black/40 dark:placeholder:text-white/40 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              {!isLinePriceDraftValid && linePriceDraft.trim().length > 0 && (
                <p className="text-xs text-red-500 font-medium antialiased">
                  {t('menu.cart.invalidPrice', 'Enter a valid non-negative price')}
                </p>
              )}
            </div>

            <div className="flex items-center justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={closeLinePriceModal}
                className="px-3 py-1.5 text-xs font-semibold rounded-md border bg-black/5 dark:bg-white/10 border-black/10 dark:border-white/15 liquid-glass-modal-text hover:bg-black/10 dark:hover:bg-white/15"
              >
                {t('common.cancel', 'Cancel')}
              </button>
              <button
                type="button"
                onClick={applyLinePriceDraft}
                disabled={!isLinePriceDraftValid}
                className={`px-3 py-1.5 text-xs font-semibold rounded-md ${
                  isLinePriceDraftValid
                    ? 'bg-blue-600 text-white hover:bg-blue-700'
                    : 'bg-black/10 dark:bg-white/10 text-black/30 dark:text-white/30 cursor-not-allowed'
                }`}
              >
                {t('common.apply', 'Apply')}
              </button>
            </div>
          </div>
        </div>
      )}

      {isCouponModalOpen && onApplyCoupon && !editMode && (
        <div className="fixed inset-0 z-[1195] flex items-center justify-center p-4">
          <button
            type="button"
            aria-label={t('common.close', 'Close')}
            onClick={() => setIsCouponModalOpen(false)}
            className="absolute inset-0 bg-black/45 backdrop-blur-sm"
          />
          <div
            className="relative w-full max-w-xs rounded-2xl border bg-white/85 dark:bg-black/75 border-black/10 dark:border-white/15 shadow-2xl p-4 space-y-3"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-3">
              <h4 className="text-base font-semibold liquid-glass-modal-text">
                {t('menu.cart.couponButton', 'Coupon')}
              </h4>
              <button
                type="button"
                onClick={() => setIsCouponModalOpen(false)}
                className="p-1 rounded-full transition-colors liquid-glass-modal-text-muted hover:bg-black/10 dark:hover:bg-white/15"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-2">
              <label className="text-xs font-semibold antialiased liquid-glass-modal-text-muted">
                {t('menu.cart.couponPlaceholder', 'Coupon code')}
              </label>
              <input
                ref={couponInputRef}
                type="text"
                value={couponInput}
                onChange={(e) => setCouponInput(e.target.value.toUpperCase())}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && couponInput.trim()) {
                    e.preventDefault();
                    applyCouponFromModal();
                  }
                }}
                placeholder={t('menu.cart.couponPlaceholder', 'Coupon code')}
                className="w-full px-3 py-2 text-sm border rounded-lg antialiased bg-black/5 dark:bg-white/10 border-black/10 dark:border-white/15 liquid-glass-modal-text placeholder:text-black/40 dark:placeholder:text-white/40 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              {couponError && (
                <p className="text-xs text-red-500 font-medium antialiased">{couponError}</p>
              )}
            </div>

            <div className="flex items-center justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => {
                  startLoyaltyReader().catch(() => undefined);
                  couponInputRef.current?.focus();
                }}
                className="px-3 py-1.5 text-xs font-semibold rounded-md border bg-black/5 dark:bg-white/10 border-black/10 dark:border-white/15 liquid-glass-modal-text hover:bg-black/10 dark:hover:bg-white/15 inline-flex items-center gap-1.5"
              >
                <ScanLine className="w-3.5 h-3.5" />
                {t('menu.cart.scanCoupon', 'Scan')}
              </button>
              <button
                type="button"
                onClick={() => setIsCouponModalOpen(false)}
                className="px-3 py-1.5 text-xs font-semibold rounded-md border bg-black/5 dark:bg-white/10 border-black/10 dark:border-white/15 liquid-glass-modal-text hover:bg-black/10 dark:hover:bg-white/15"
              >
                {t('common.cancel', 'Cancel')}
              </button>
              <button
                type="button"
                onClick={applyCouponFromModal}
                disabled={!couponInput.trim() || isValidatingCoupon}
                className={`px-3 py-1.5 text-xs font-semibold rounded-md ${
                  !couponInput.trim() || isValidatingCoupon
                    ? 'bg-black/10 dark:bg-white/10 text-black/30 dark:text-white/30 cursor-not-allowed'
                    : 'bg-blue-600 text-white hover:bg-blue-700'
                }`}
              >
                {isValidatingCoupon ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  t('menu.cart.applyCoupon', 'Apply')
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {discountControlEnabled && isDiscountModalOpen && (
        <div className="fixed inset-0 z-[1200] flex items-center justify-center p-4">
          <button
            type="button"
            aria-label={t('common.close', 'Close')}
            onClick={() => setIsDiscountModalOpen(false)}
            className="absolute inset-0 bg-black/50 backdrop-blur-md"
          />
          <div className="relative w-full max-w-xl liquid-glass-modal-shell !fixed !top-1/2 !left-1/2 !-translate-x-1/2 !-translate-y-1/2 !max-w-xl !max-h-fit !animate-none">
            <div className="liquid-glass-modal-header">
              <div>
                <h4 className="liquid-glass-modal-title !text-xl">
                  {t('menu.cart.discountPickerTitle', 'Apply Discount')}
                </h4>
                <p className="text-sm antialiased liquid-glass-modal-text-muted">
                  {discountModeDraft === 'percentage'
                    ? t('menu.cart.discountMax', { max: maxDiscountPercentage })
                    : t('menu.cart.fixedDiscountHint', 'Fixed discount is clamped to subtotal')}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setIsDiscountModalOpen(false)}
                className="liquid-glass-modal-close"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="px-6 py-5 space-y-5">
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setDiscountModeDraft('percentage');
                    setDiscountDraft(parseDiscountInput(discountManualInput, 'percentage'));
                  }}
                  className={`py-2 rounded-lg text-sm font-semibold border transition-colors ${
                    discountModeDraft === 'percentage'
                      ? 'bg-blue-500 border-blue-400 text-white'
                      : 'bg-black/5 dark:bg-white/10 border-black/10 dark:border-white/15 liquid-glass-modal-text hover:bg-black/10 dark:hover:bg-white/15'
                  }`}
                >
                  {t('menu.cart.percentMode', '% Mode')}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setDiscountModeDraft('fixed');
                    setDiscountDraft(parseDiscountInput(discountManualInput, 'fixed'));
                  }}
                  className={`py-2 rounded-lg text-sm font-semibold border transition-colors ${
                    discountModeDraft === 'fixed'
                      ? 'bg-blue-500 border-blue-400 text-white'
                      : 'bg-black/5 dark:bg-white/10 border-black/10 dark:border-white/15 liquid-glass-modal-text hover:bg-black/10 dark:hover:bg-white/15'
                  }`}
                >
                  {t('menu.cart.fixedMode', 'Fixed')}
                </button>
              </div>

              <div>
                <p className="text-sm font-semibold mb-3 antialiased liquid-glass-modal-text">
                  {t('menu.cart.quickDiscounts', 'Quick discounts')}
                </p>
                <div className="grid grid-cols-5 gap-2">
                  {discountPresetValues.map((value) => {
                    const disabled = discountModeDraft === 'percentage' && value > maxDiscountPercentage;
                    const selected = Math.abs(discountDraft - value) < 0.001;

                    return (
                      <button
                        key={value}
                        type="button"
                        disabled={disabled}
                        onClick={() => {
                          if (disabled) {
                            return;
                          }
                          const nextValue =
                            discountModeDraft === 'fixed' ? Math.min(value, getSubtotal()) : value;
                          setDiscountDraft(nextValue);
                          setDiscountManualInput(String(nextValue));
                        }}
                        className={`py-2 rounded-lg text-sm font-semibold border transition-colors ${
                          disabled
                            ? 'opacity-45 cursor-not-allowed'
                            : selected
                              ? 'bg-blue-500 border-blue-400 text-white'
                              : 'bg-black/5 dark:bg-white/10 border-black/10 dark:border-white/15 liquid-glass-modal-text hover:bg-black/10 dark:hover:bg-white/15'
                        }`}
                      >
                        {discountModeDraft === 'percentage' ? `${value}%` : formatCurrency(value)}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div>
                <label className="text-sm font-semibold mb-2 block antialiased liquid-glass-modal-text">
                  {t('menu.cart.manualDiscount', 'Manual discount')}
                </label>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    inputMode="decimal"
                    value={discountManualInput}
                    onChange={(e) => {
                      const rawValue = e.target.value;
                      setDiscountManualInput(rawValue);
                      setDiscountDraft(parseDiscountInput(rawValue, discountModeDraft));
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !isDraftOverMax) {
                        applyDraftDiscount();
                      }
                    }}
                    placeholder={
                      discountModeDraft === 'percentage'
                        ? t('menu.cart.discountLabel')
                        : t('menu.cart.discountAmount', 'Discount amount')
                    }
                    className="w-full px-4 py-3 rounded-lg text-base border bg-black/5 dark:bg-white/10 border-black/10 dark:border-white/15 liquid-glass-modal-text placeholder:text-black/40 dark:placeholder:text-white/40 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                  <span className="text-base font-semibold liquid-glass-modal-text">
                    {discountModeDraft === 'percentage' ? '%' : '€'}
                  </span>
                </div>
                {isDraftOverMax && (
                  <p className="text-xs text-red-500 mt-2 font-medium antialiased">
                    {t('menu.cart.discountExceeded', { max: maxDiscountPercentage })}
                  </p>
                )}
              </div>
            </div>

            <div className="flex items-center justify-between gap-3 px-6 py-4 border-t border-black/10 dark:border-white/10">
              <button
                type="button"
                onClick={clearDiscount}
                className="liquid-glass-modal-button px-4 py-2 text-sm font-semibold"
              >
                {t('menu.cart.removeDiscount', 'Remove discount')}
              </button>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setIsDiscountModalOpen(false)}
                  className="liquid-glass-modal-button px-4 py-2 text-sm font-semibold"
                >
                  {t('common.cancel', 'Cancel')}
                </button>
                <button
                  type="button"
                  onClick={applyDraftDiscount}
                  disabled={isDraftOverMax}
                  className={`px-5 py-2 rounded-lg text-sm font-semibold ${
                    isDraftOverMax
                      ? 'bg-black/10 dark:bg-white/10 text-black/30 dark:text-white/30 cursor-not-allowed'
                      : 'bg-blue-600 text-white hover:bg-blue-700'
                  }`}
                >
                  {t('menu.cart.applyDiscount', 'Apply discount')}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
