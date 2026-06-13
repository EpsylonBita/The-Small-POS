import React from 'react';
import { useTranslation } from 'react-i18next';
import { ShoppingCart, Trash2, AlertTriangle, Ban, Ticket, X, Loader2, Plus, ScanLine, Gift, CheckSquare, Square, Percent, RotateCcw, Award } from 'lucide-react';
import { useI18n } from '../../contexts/i18n-context';
import { useOnBarcodeScan } from '../../contexts/barcode-scanner-context';
import { useLoyaltyReader } from '../../hooks/useLoyaltyReader';
import { formatCurrency } from '../../utils/format';
import type { DeliveryFeeStatus } from '../../utils/delivery-fee';
import { formatMoneyInputWithCents, parseMoneyInputValue } from '../../utils/moneyInput';
import {
  applyDiscountToCartLines,
  clearDiscountFromCartLines,
  getCartLineTotal,
  roundMoney,
  type CartLineDiscountMode,
} from '../../utils/cart-line-discounts';
import { getBridge } from '../../../lib';
import toast from 'react-hot-toast';

const BATCH_SELECT_HOLD_DURATION_MS = 650;
const LINE_PRICE_HOLD_DURATION_MS = 5000;
const LINE_PRICE_HOLD_TICK_MS = 100;

export interface CartItem {
  id: string | number;
  name: string;
  quantity: number;
  price: number;
  unitPrice?: number;
  unit_price?: number;
  totalPrice: number;
  total_price?: number;
  originalUnitPrice?: number | null;
  original_unit_price?: number | null;
  isPriceOverridden?: boolean;
  is_price_overridden?: boolean;
  discount?: number;
  discountAmount?: number;
  discount_amount?: number;
  discountBaseUnitPrice?: number;
  discountBaseTotalPrice?: number;
  lineDiscountMode?: CartLineDiscountMode;
  lineDiscountValue?: number;
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
  is_offer_reward?: boolean;
  auto_added_by_offer?: boolean;
  offer_id?: string;
  offer_name?: string;
  reward_item_id?: string;
  reward_item_category_id?: string | null;
  reward_source_item_id?: string | null;
  reward_source_category_id?: string | null;
  reward_signature?: string;
}

export interface AppliedCoupon {
  id: string;
  code: string;
  discount_type: 'percentage' | 'fixed_amount';
  discount_value: number;
  minimum_order_amount?: number;
}

export interface AppliedLoyaltyRedemption {
  customerId: string;
  customerName?: string | null;
  pointsRedeemed: number;
  discountAmount: number;
  pointsBalance?: number;
  tier?: string | null;
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
  orderType?: 'pickup' | 'delivery' | 'dine-in'; // Order type for minimum order validation
  minimumOrderAmount?: number; // Minimum order amount for delivery zones
  deliveryFee?: number;
  deliveryFeeStatus?: DeliveryFeeStatus;
  allowManualDeliveryFee?: boolean;
  manualDeliveryFeeValue?: number;
  onManualDeliveryFeeChange?: (value: number) => void;
  // Coupon props
  appliedCoupon?: AppliedCoupon | null;
  onApplyCoupon?: (code: string) => void;
  onRemoveCoupon?: () => void;
  couponDiscount?: number;
  isValidatingCoupon?: boolean;
  couponError?: string | null;
  // Loyalty redemption props
  loyaltyRedemption?: AppliedLoyaltyRedemption | null;
  loyaltyDiscount?: number;
  loyaltyRedeemAvailable?: boolean;
  loyaltyRedeemLoading?: boolean;
  loyaltyRedeemDisabledReason?: string | null;
  loyaltyRedeemablePoints?: number;
  loyaltyRedeemableAmount?: number;
  onOpenLoyaltyRedeem?: () => void;
  onRemoveLoyaltyRedemption?: () => void;
  offerDiscountAmount?: number;
  matchedOfferNames?: string[];
  // Manual item props
  onAddManualItem?: (price: number, name?: string) => void;
  onLinePriceChange?: (itemId: string | number, newUnitPrice: number) => void;
  ghostModeFeatureEnabled?: boolean;
  ghostModeArmed?: boolean;
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
  deliveryFee = 0,
  deliveryFeeStatus = 'resolved',
  allowManualDeliveryFee = false,
  manualDeliveryFeeValue = 0,
  onManualDeliveryFeeChange,
  appliedCoupon,
  onApplyCoupon,
  onRemoveCoupon,
  couponDiscount = 0,
  isValidatingCoupon = false,
  couponError,
  loyaltyRedemption = null,
  loyaltyDiscount,
  loyaltyRedeemAvailable = false,
  loyaltyRedeemLoading = false,
  loyaltyRedeemDisabledReason,
  loyaltyRedeemablePoints = 0,
  loyaltyRedeemableAmount = 0,
  onOpenLoyaltyRedeem,
  onRemoveLoyaltyRedemption,
  offerDiscountAmount = 0,
  matchedOfferNames = [],
  onAddManualItem,
  onLinePriceChange,
  ghostModeFeatureEnabled = false,
  ghostModeArmed = false,
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
  const [manualDeliveryFeeInput, setManualDeliveryFeeInput] = React.useState('');
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
  const [isSelectionMode, setIsSelectionMode] = React.useState(false);
  const [selectedCartItemIds, setSelectedCartItemIds] = React.useState<Set<string | number>>(
    () => new Set()
  );
  const [isLineDiscountModalOpen, setIsLineDiscountModalOpen] = React.useState(false);
  const [lineDiscountModeDraft, setLineDiscountModeDraft] = React.useState<CartLineDiscountMode>('percentage');
  const [lineDiscountDraft, setLineDiscountDraft] = React.useState<number>(0);
  const [lineDiscountManualInput, setLineDiscountManualInput] = React.useState<string>('');
  const selectionHoldPointerIdRef = React.useRef<number | null>(null);
  const selectionHoldTriggeredRef = React.useRef(false);
  const selectionHoldTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
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
    if (!isDiscountModalOpen && !isCouponModalOpen && !isLineDiscountModalOpen) {
      return;
    }

    const onEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsDiscountModalOpen(false);
        setIsCouponModalOpen(false);
        setIsLineDiscountModalOpen(false);
      }
    };

    window.addEventListener('keydown', onEscape);
    return () => {
      window.removeEventListener('keydown', onEscape);
    };
  }, [isDiscountModalOpen, isCouponModalOpen, isLineDiscountModalOpen]);

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

  React.useEffect(() => {
    if (!allowManualDeliveryFee) {
      setManualDeliveryFeeInput('');
      return;
    }

    const normalized = Math.max(0, manualDeliveryFeeValue || 0);
    setManualDeliveryFeeInput(
      normalized > 0 ? normalized.toFixed(2).replace('.', ',') : ''
    );
  }, [allowManualDeliveryFee, manualDeliveryFeeValue]);

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

  const loyaltyFeatureEnabled = Boolean(onOpenLoyaltyRedeem || loyaltyRedemption);
  const { start: startLoyaltyReader } = useLoyaltyReader(
    isCouponModalOpen && loyaltyFeatureEnabled,
    loyaltyFeatureEnabled ? handleLoyaltyCardScanned : undefined,
  );

  const clearSelectionHoldTimer = React.useCallback(() => {
    if (selectionHoldTimeoutRef.current) {
      clearTimeout(selectionHoldTimeoutRef.current);
      selectionHoldTimeoutRef.current = null;
    }
    selectionHoldPointerIdRef.current = null;
  }, []);

  const exitSelectionMode = React.useCallback(() => {
    clearSelectionHoldTimer();
    selectionHoldTriggeredRef.current = false;
    setIsSelectionMode(false);
    setSelectedCartItemIds(new Set());
    setIsLineDiscountModalOpen(false);
  }, [clearSelectionHoldTimer]);

  const enterSelectionMode = React.useCallback((itemId: string | number) => {
    selectionHoldTriggeredRef.current = true;
    setIsSelectionMode(true);
    setSelectedCartItemIds(new Set([itemId]));
  }, []);

  const startSelectionHold = React.useCallback(
    (event: React.PointerEvent<HTMLDivElement>, itemId: string | number) => {
      if (event.pointerType === 'mouse' && event.button !== 0) {
        return;
      }

      clearSelectionHoldTimer();
      selectionHoldTriggeredRef.current = false;
      selectionHoldPointerIdRef.current = event.pointerId;
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {}

      selectionHoldTimeoutRef.current = setTimeout(() => {
        enterSelectionMode(itemId);
        clearSelectionHoldTimer();
      }, BATCH_SELECT_HOLD_DURATION_MS);
    },
    [clearSelectionHoldTimer, enterSelectionMode]
  );

  const handleSelectionPointerEnd = React.useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (
        selectionHoldPointerIdRef.current !== null &&
        event.pointerId !== selectionHoldPointerIdRef.current
      ) {
        return;
      }
      clearSelectionHoldTimer();
      if (selectionHoldTriggeredRef.current) {
        window.setTimeout(() => {
          selectionHoldTriggeredRef.current = false;
        }, 0);
      }
    },
    [clearSelectionHoldTimer]
  );

  const toggleSelectedCartItem = React.useCallback((itemId: string | number) => {
    setSelectedCartItemIds((prev) => {
      const next = new Set(prev);
      if (next.has(itemId)) {
        next.delete(itemId);
      } else {
        next.add(itemId);
      }
      return next;
    });
  }, []);

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
              price: next,
              unitPrice: next,
              unit_price: next,
              totalPrice: roundMoney(next * ci.quantity),
              total_price: roundMoney(next * ci.quantity),
              originalUnitPrice: ci.originalUnitPrice ?? baselinePrice,
              original_unit_price: ci.originalUnitPrice ?? baselinePrice,
              isPriceOverridden:
                Math.abs(next - (ci.originalUnitPrice ?? baselinePrice)) > 0.0001,
              is_price_overridden:
                Math.abs(next - (ci.originalUnitPrice ?? baselinePrice)) > 0.0001,
              discount: 0,
              discountAmount: 0,
              discount_amount: 0,
              discountBaseUnitPrice: undefined,
              discountBaseTotalPrice: undefined,
              lineDiscountMode: undefined,
              lineDiscountValue: undefined,
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
    setSelectedCartItemIds((prev) => {
      if (prev.size === 0) {
        return prev;
      }

      const validIds = new Set(
        cartItems
          .filter((item) => item.is_offer_reward !== true)
          .map((item) => item.id)
      );
      const next = new Set([...prev].filter((id) => validIds.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [cartItems]);

  React.useEffect(() => {
    if (isSelectionMode && selectedCartItemIds.size === 0) {
      setIsSelectionMode(false);
      setIsLineDiscountModalOpen(false);
    }
  }, [isSelectionMode, selectedCartItemIds]);

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
      clearSelectionHoldTimer();
    };
  }, [clearHoldTimers, clearSelectionHoldTimer]);

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

  const formatManualPriceInput = React.useCallback((value: string) => {
    return formatMoneyInputWithCents(value);
  }, []);

  const parseManualPriceValue = React.useCallback((value: string) => {
    return parseMoneyInputValue(value);
  }, []);

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
  const parsedManualPrice = parseManualPriceValue(manualPrice);
  const canAddManualItem = parsedManualPrice > 0;

  const commitManualItem = React.useCallback(() => {
    if (!onAddManualItem || parsedManualPrice <= 0) {
      return;
    }

    onAddManualItem(parsedManualPrice, manualName.trim() || undefined);
    setManualPrice('');
    setManualName('');
    setShowManualInput(false);
  }, [manualName, onAddManualItem, parsedManualPrice]);

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
  const loyaltyDiscountAmount = Math.max(0, loyaltyDiscount ?? loyaltyRedemption?.discountAmount ?? 0);
  const totalAfterDiscount = Math.max(
    subtotal - offerDiscountAmount - discountAmount - couponDiscount - loyaltyDiscountAmount,
    0,
  );
  const loyaltyControlEnabled = loyaltyFeatureEnabled;
  const cartActionCount = [
    Boolean(onApplyCoupon),
    discountControlEnabled,
    loyaltyControlEnabled,
  ].filter(Boolean).length;
  const cartActionGridClass =
    cartActionCount >= 3
      ? 'grid-cols-3'
      : cartActionCount === 2
        ? 'grid-cols-2'
        : 'grid-cols-1';
  const cartActionIconButtonBaseClass = 'font-semibold antialiased transition-colors flex items-center justify-center rounded-lg bg-transparent border-0 p-0 shadow-none focus:outline-none focus:ring-2';
  const safeLoyaltyRedeemablePoints = Math.max(0, Math.trunc(loyaltyRedeemablePoints || 0));
  const safeLoyaltyRedeemableAmount = Math.max(0, loyaltyRedeemableAmount || 0);
  const loyaltyActionTitle = loyaltyRedeemDisabledReason || (
    safeLoyaltyRedeemableAmount > 0
      ? t('menu.cart.loyaltyAvailableTitle', {
          amount: formatCurrency(safeLoyaltyRedeemableAmount),
          points: safeLoyaltyRedeemablePoints,
          defaultValue: '{{points}} pts / {{amount}} available',
        })
      : t('loyalty.redeemTitle', 'Redeem Loyalty Points')
  );
  const discountActionTitle = effectiveDiscountMode === 'percentage'
    ? t('menu.cart.discount', { percent: effectiveDiscountPercentage })
    : t('menu.cart.discountAmount', 'Discount');
  const editingLineItem = editingLineItemId === null
    ? null
    : cartItems.find(item => item.id === editingLineItemId) ?? null;
  const parsedLinePriceDraft = Number.parseFloat(linePriceDraft.replace(',', '.').trim());
  const isLinePriceDraftValid = Number.isFinite(parsedLinePriceDraft) && parsedLinePriceDraft >= 0;
  const selectedCartItemIdsArray = React.useMemo(
    () => Array.from(selectedCartItemIds),
    [selectedCartItemIds]
  );
  const selectableCartItemIds = React.useMemo(
    () => uniqueCartItems
      .filter((item) => item.is_offer_reward !== true)
      .map((item) => item.id),
    [uniqueCartItems]
  );
  const selectedLineSubtotal = uniqueCartItems.reduce(
    (sum, item) => selectedCartItemIds.has(item.id) ? sum + getCartLineTotal(item) : sum,
    0
  );
  const allSelectableSelected =
    selectableCartItemIds.length > 0 &&
    selectableCartItemIds.every((id) => selectedCartItemIds.has(id));
  const isLineDiscountDraftOverMax =
    lineDiscountModeDraft === 'percentage' && lineDiscountDraft > maxDiscountPercentage;
  const canApplyLineDiscount =
    selectedCartItemIdsArray.length > 0 &&
    lineDiscountDraft > 0 &&
    !isLineDiscountDraftOverMax &&
    selectedLineSubtotal > 0;

  const toggleSelectAllCartItems = () => {
    if (allSelectableSelected) {
      setSelectedCartItemIds(new Set());
      return;
    }
    setIsSelectionMode(true);
    setSelectedCartItemIds(new Set(selectableCartItemIds));
  };

  const openLineDiscountModal = () => {
    if (selectedCartItemIdsArray.length === 0) {
      return;
    }
    setLineDiscountModeDraft('percentage');
    setLineDiscountDraft(0);
    setLineDiscountManualInput('');
    setIsLineDiscountModalOpen(true);
  };

  const applySelectedLineDiscount = () => {
    if (!canApplyLineDiscount) {
      return;
    }

    const discountValue =
      lineDiscountModeDraft === 'percentage'
        ? Math.max(0, Math.min(lineDiscountDraft, maxDiscountPercentage))
        : Math.max(0, Math.min(lineDiscountDraft, selectedLineSubtotal));

    onUpdateCart(
      applyDiscountToCartLines(
        cartItems,
        selectedCartItemIdsArray,
        lineDiscountModeDraft,
        discountValue
      )
    );
    toast.success(t('menu.cart.lineDiscountApplied', 'Discount applied to selected items'));
    exitSelectionMode();
  };

  const clearSelectedLineDiscount = () => {
    if (selectedCartItemIdsArray.length === 0) {
      return;
    }

    onUpdateCart(clearDiscountFromCartLines(cartItems, selectedCartItemIdsArray));
    toast.success(t('menu.cart.lineDiscountCleared', 'Selected item discounts cleared'));
    exitSelectionMode();
  };

  // Minimum order validation for delivery orders
  const isDeliveryOrder = orderType === 'delivery';
  const appliedDeliveryFee = isDeliveryOrder
    ? (allowManualDeliveryFee
        ? Math.max(0, manualDeliveryFeeValue || 0)
        : deliveryFeeStatus === 'resolved'
          ? deliveryFee
          : 0)
    : 0;
  const totalWithDeliveryFee = totalAfterDiscount + appliedDeliveryFee;
  const isBelowMinimum = isDeliveryOrder && minimumOrderAmount > 0 && totalAfterDiscount < minimumOrderAmount;
  const shortfall = isBelowMinimum ? minimumOrderAmount - totalAfterDiscount : 0;
  const deliveryFeeDisplay =
    deliveryFeeStatus === 'resolved'
      ? formatCurrency(appliedDeliveryFee)
      : editMode
        ? '—'
        : deliveryFeeStatus === 'requires_selection'
          ? t('menu.cart.deliveryFeeNeedsExactAddress')
          : deliveryFeeStatus === 'out_of_zone'
            ? t('menu.cart.deliveryFeeOutOfZone')
            : deliveryFeeStatus === 'unavailable'
              ? t('menu.cart.deliveryFeeUnavailable')
              : t('menu.cart.calculatingDeliveryFee');
  const isCheckoutBlocked =
    uniqueCartItems.length === 0 ||
    isAppliedDiscountOverMax ||
    isSaving ||
    (isBelowMinimum && !editMode) ||
    (isDeliveryOrder && !allowManualDeliveryFee && deliveryFeeStatus !== 'resolved' && !editMode);

  return (
    <div
      className="flex h-full w-full flex-col overflow-hidden rounded-[28px] border border-black/15 bg-transparent shadow-[0_10px_28px_rgba(15,23,42,0.06)] dark:border-white/60 dark:shadow-[0_12px_32px_rgba(0,0,0,0.08)]"
    >
      {/* Header - flex-shrink-0 keeps it fixed size */}
      <div className="flex-shrink-0 border-b border-black/10 dark:border-white/10">
        <div className="flex items-center justify-between px-4 py-3">
          <h3 className="text-lg font-semibold liquid-glass-modal-title !text-base">
            {t('menu.cart.header', { count: uniqueCartItems.length })}
          </h3>
          <div className="flex items-center gap-2">
            {isSelectionMode && (
              <>
                <span className="rounded-full bg-blue-500/15 px-2.5 py-1 text-xs font-semibold text-blue-700 dark:text-blue-300">
                  {t('menu.cart.selectedCount', '{{count}} selected', {
                    count: selectedCartItemIdsArray.length,
                  })}
                </span>
                <button
                  type="button"
                  onClick={exitSelectionMode}
                  className="p-1.5 rounded-lg transition-colors liquid-glass-modal-text-muted hover:bg-black/5 dark:hover:bg-white/10"
                  title={t('menu.cart.exitSelection', 'Exit selection')}
                >
                  <X className="w-4 h-4" />
                </button>
              </>
            )}
            {onAddManualItem && !isSelectionMode && (
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
        </div>
        {isSelectionMode && (
          <div className="px-4 pb-3">
            <div className="grid grid-cols-[2.75rem_1fr_1fr] gap-2">
              <button
                type="button"
                onClick={toggleSelectAllCartItems}
                disabled={selectableCartItemIds.length === 0}
                className="h-10 rounded-lg border bg-black/5 dark:bg-white/10 border-black/10 dark:border-white/15 liquid-glass-modal-text hover:bg-black/10 dark:hover:bg-white/15 disabled:cursor-not-allowed disabled:opacity-40 flex items-center justify-center"
                title={
                  allSelectableSelected
                    ? t('menu.cart.clearSelection', 'Clear selection')
                    : t('menu.cart.selectAll', 'Select all')
                }
              >
                {allSelectableSelected ? (
                  <CheckSquare className="w-4 h-4" />
                ) : (
                  <Square className="w-4 h-4" />
                )}
              </button>
              <button
                type="button"
                onClick={openLineDiscountModal}
                disabled={selectedCartItemIdsArray.length === 0}
                className="h-10 px-3 rounded-lg border text-sm font-semibold bg-black/5 dark:bg-white/10 border-black/10 dark:border-white/15 liquid-glass-modal-text hover:bg-black/10 dark:hover:bg-white/15 disabled:cursor-not-allowed disabled:opacity-40 flex items-center justify-center gap-2"
                title={t('menu.cart.discountSelected', 'Discount selected')}
              >
                <Percent className="w-4 h-4" />
                <span>{t('menu.cart.discountSelectedShort', 'Discount')}</span>
              </button>
              <button
                type="button"
                onClick={clearSelectedLineDiscount}
                disabled={selectedCartItemIdsArray.length === 0}
                className="h-10 px-3 rounded-lg border text-sm font-semibold bg-black/5 dark:bg-white/10 border-black/10 dark:border-white/15 liquid-glass-modal-text hover:bg-black/10 dark:hover:bg-white/15 disabled:cursor-not-allowed disabled:opacity-40 flex items-center justify-center gap-2"
                title={t('menu.cart.clearLineDiscount', 'Clear selected discounts')}
              >
                <RotateCcw className="w-4 h-4" />
                <span>{t('menu.cart.clearLineDiscountShort', 'Clear')}</span>
              </button>
            </div>
          </div>
        )}
        {ghostModeArmed && (
          <div className="px-4 pb-3">
            <div className="rounded-lg border border-amber-400/40 bg-amber-500/10 px-3 py-2 text-xs font-medium text-amber-700 dark:text-amber-200">
              {t(
                'menu.cart.ghostModeBanner',
                'Ghost order armed. This cart will print only, stay hidden in POS, and be saved as a ghost reference order.'
              )}
            </div>
          </div>
        )}
        {/* Manual item inline form */}
        {showManualInput && onAddManualItem && !isSelectionMode && (
          <div className={`px-4 pb-3 space-y-2`}>
            {ghostModeFeatureEnabled && !ghostModeArmed && (
              <p className="text-[11px] liquid-glass-modal-text-muted">
                {t(
                  'menu.cart.ghostModeHint',
                  'Enter name X and price 1 to arm ghost mode for the current cart only.'
                )}
              </p>
            )}
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
                type="text"
                inputMode="decimal"
                value={manualPrice}
                onChange={(e) => setManualPrice(formatManualPriceInput(e.target.value))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    commitManualItem();
                  }
                }}
                placeholder={`${t('menu.cart.manualPricePlaceholder', 'Price')} (0,00)`}
                className="flex-1 px-2.5 py-1.5 text-sm border rounded-lg antialiased bg-black/5 dark:bg-white/10 border-black/10 dark:border-white/15 liquid-glass-modal-text placeholder:text-black/40 dark:placeholder:text-white/40 focus:outline-none focus:ring-2 focus:ring-blue-500"
                autoFocus
              />
              <button
                onClick={commitManualItem}
                disabled={!canAddManualItem}
                className={`px-3 py-1.5 text-sm font-medium rounded-lg transition-colors ${
                  !canAddManualItem
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
      <div className="flex-1 min-h-0 overflow-y-auto p-3 touch-scroll scrollbar-hide">
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
              const isRewardLine = item.is_offer_reward === true;
              const canSelectLine = !isRewardLine;
              const isSelectedLine = selectedCartItemIds.has(item.id);
              const lineDiscountAmount = Math.max(
                0,
                Number(item.discountAmount ?? item.discount_amount ?? item.discount ?? 0)
              );

              return (
              <div
                key={item.id}
                aria-selected={isSelectionMode ? isSelectedLine : undefined}
                className={`p-3 rounded-xl border transition-all duration-200 ${
                  isSelectionMode && isSelectedLine
                    ? 'bg-blue-500/10 border-blue-500/60 shadow-[0_0_0_1px_rgba(59,130,246,0.25)]'
                    : 'bg-black/[0.03] dark:bg-white/[0.06] border-black/8 dark:border-white/10 hover:border-blue-400/50 dark:hover:border-blue-400/40 hover:bg-black/[0.05] dark:hover:bg-white/[0.09]'
                } ${isSelectionMode && canSelectLine ? 'cursor-pointer' : onEditItem && !isRewardLine ? 'cursor-pointer' : ''}`}
                onPointerDown={(event) => {
                  if (!isSelectionMode && canSelectLine) {
                    startSelectionHold(event, item.id);
                  }
                }}
                onPointerUp={handleSelectionPointerEnd}
                onPointerCancel={handleSelectionPointerEnd}
                onLostPointerCapture={handleSelectionPointerEnd}
                onContextMenu={(event) => {
                  if (canSelectLine) {
                    event.preventDefault();
                  }
                }}
                onClick={() => {
                  if (selectionHoldTriggeredRef.current) {
                    selectionHoldTriggeredRef.current = false;
                    return;
                  }
                  if (isSelectionMode) {
                    if (canSelectLine) {
                      toggleSelectedCartItem(item.id);
                    }
                    return;
                  }
                  if (!isRewardLine) {
                    onEditItem?.(item);
                  }
                }}
              >
                <div className="flex justify-between items-start mb-2">
                  <div className="flex min-w-0 flex-1 items-start gap-2">
                    {isSelectionMode && canSelectLine && (
                      <span
                        className={`mt-0.5 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg border ${
                          isSelectedLine
                            ? 'border-blue-400 bg-blue-500 text-white'
                            : 'border-black/15 bg-black/5 text-black/45 dark:border-white/20 dark:bg-white/10 dark:text-white/55'
                        }`}
                      >
                        {isSelectedLine ? (
                          <CheckSquare className="h-4 w-4" />
                        ) : (
                          <Square className="h-4 w-4" />
                        )}
                      </span>
                    )}
                    <div className="min-w-0 flex-1">
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
                    {isRewardLine && (
                      <div className="mt-1 flex flex-wrap items-center gap-1.5">
                        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] font-semibold text-emerald-700 dark:text-emerald-300">
                          <Gift className="h-3 w-3" />
                          {t('menu.cart.autoOfferReward', 'Auto reward')}
                        </span>
                        {item.offer_name && (
                          <span className="text-[11px] antialiased liquid-glass-modal-text-muted">
                            {item.offer_name}
                          </span>
                        )}
                      </div>
                    )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="text-right">
                      <span className="font-semibold antialiased text-emerald-600 dark:text-emerald-400">
                        {formatCurrency(item.totalPrice || 0)}
                      </span>
                      {lineDiscountAmount > 0 && (
                        <div className="text-[11px] font-semibold text-green-600 dark:text-green-400">
                          -{formatCurrency(lineDiscountAmount)}
                        </div>
                      )}
                    </div>
                    {/* Delete button - positioned away from main click area */}
                    {onRemoveItem && !isRewardLine && (
                      <button
                        onPointerDown={(e) => e.stopPropagation()}
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
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => e.stopPropagation()}
                >
                  <div className="flex items-center gap-2">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        if (isRewardLine) {
                          return;
                        }
                        if (item.quantity <= 1) {
                          onRemoveItem?.(item.id);
                        } else {
                          const updatedItems = cartItems.map(ci =>
                            ci.id === item.id
                              ? (() => {
                                  const nextQuantity = ci.quantity - 1;
                                  const unitPrice =
                                    ci.unitPrice || ci.price || (ci.totalPrice / ci.quantity);
                                  const nextTotal = roundMoney(unitPrice * nextQuantity);
                                  const discountBaseUnitPrice = ci.discountBaseUnitPrice;
                                  const nextDiscountAmount =
                                    discountBaseUnitPrice !== undefined
                                      ? roundMoney(Math.max(0, (discountBaseUnitPrice - unitPrice) * nextQuantity))
                                      : ci.discountAmount;

                                  return {
                                    ...ci,
                                    quantity: nextQuantity,
                                    totalPrice: nextTotal,
                                    total_price: nextTotal,
                                    discount:
                                      nextDiscountAmount !== undefined ? nextDiscountAmount : ci.discount,
                                    discountAmount: nextDiscountAmount,
                                    discount_amount: nextDiscountAmount,
                                    discountBaseTotalPrice:
                                      discountBaseUnitPrice !== undefined
                                        ? roundMoney(discountBaseUnitPrice * nextQuantity)
                                        : ci.discountBaseTotalPrice,
                                  };
                                })()
                              : ci
                          );
                          onUpdateCart(updatedItems);
                        }
                      }}
                      disabled={isRewardLine}
                      className="w-7 h-7 rounded-full flex items-center justify-center font-bold transition-colors bg-black/8 dark:bg-white/12 hover:bg-black/15 dark:hover:bg-white/20 liquid-glass-modal-text disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      −
                    </button>
                    <span className="min-w-[24px] text-center font-semibold antialiased liquid-glass-modal-text">{item.quantity}</span>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        if (isRewardLine) {
                          return;
                        }
                        const updatedItems = cartItems.map(ci =>
                          ci.id === item.id
                            ? (() => {
                                const nextQuantity = ci.quantity + 1;
                                const unitPrice =
                                  ci.unitPrice || ci.price || (ci.totalPrice / ci.quantity);
                                const nextTotal = roundMoney(unitPrice * nextQuantity);
                                const discountBaseUnitPrice = ci.discountBaseUnitPrice;
                                const nextDiscountAmount =
                                  discountBaseUnitPrice !== undefined
                                    ? roundMoney(Math.max(0, (discountBaseUnitPrice - unitPrice) * nextQuantity))
                                    : ci.discountAmount;

                                return {
                                  ...ci,
                                  quantity: nextQuantity,
                                  totalPrice: nextTotal,
                                  total_price: nextTotal,
                                  discount:
                                    nextDiscountAmount !== undefined ? nextDiscountAmount : ci.discount,
                                  discountAmount: nextDiscountAmount,
                                  discount_amount: nextDiscountAmount,
                                  discountBaseTotalPrice:
                                    discountBaseUnitPrice !== undefined
                                      ? roundMoney(discountBaseUnitPrice * nextQuantity)
                                      : ci.discountBaseTotalPrice,
                                };
                              })()
                            : ci
                        );
                        onUpdateCart(updatedItems);
                      }}
                      disabled={isRewardLine}
                      className="w-7 h-7 rounded-full flex items-center justify-center font-bold transition-colors bg-black/8 dark:bg-white/12 hover:bg-black/15 dark:hover:bg-white/20 liquid-glass-modal-text disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      +
                    </button>
                  </div>
                  {isRewardLine ? (
                    <span className="rounded-md bg-emerald-500/10 px-2.5 py-1 text-sm font-medium text-emerald-700 dark:text-emerald-300">
                      {t('menu.cart.freeLabel', 'Free')}
                    </span>
                  ) : (
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
                  )}
                </div>
                {(lineDiscountAmount > 0 || isPriceOverridden) && (
                  <div className="mt-2 flex items-center justify-end gap-1.5" onClick={(e) => e.stopPropagation()}>
                    {lineDiscountAmount > 0 && (
                      <span className="text-[11px] px-2 py-0.5 rounded-full bg-green-500/15 text-green-600 dark:text-green-300">
                        {t('menu.cart.lineDiscountBadge', 'Line discount')}
                      </span>
                    )}
                    {isPriceOverridden && (
                      <span className="text-[11px] px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-600 dark:text-amber-300">
                        {t('menu.cart.priceOverridden', 'Overridden')}
                      </span>
                    )}
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
      <div className="flex-shrink-0 p-3 border-t border-black/10 dark:border-white/10 bg-transparent space-y-3">
        {/* Coupon + Discount Controls */}
        {!editMode && (onApplyCoupon || discountControlEnabled || loyaltyControlEnabled) && (
          <div className="space-y-2">
            <div className={`grid gap-2 ${cartActionGridClass}`}>
              {onApplyCoupon && (
                <button
                  type="button"
                  onClick={() => setIsCouponModalOpen(true)}
                  title={appliedCoupon?.code || t('menu.cart.couponButton', 'Coupon')}
                  aria-label={appliedCoupon
                    ? t('menu.cart.couponApplied', 'Coupon applied')
                    : t('menu.cart.couponButton', 'Coupon')}
                  className={`${cartActionIconButtonBaseClass} text-sky-600 focus:ring-sky-400 dark:text-sky-300`}
                >
                  {isValidatingCoupon ? (
                    <Loader2 className="h-8 w-8 animate-spin flex-shrink-0" />
                  ) : (
                    <Ticket className="h-8 w-8 flex-shrink-0" aria-hidden="true" />
                  )}
                  <span className="sr-only">{t('menu.cart.couponButton', 'Coupon')}</span>
                </button>
              )}

              {loyaltyControlEnabled && (
                <button
                  type="button"
                  onClick={onOpenLoyaltyRedeem}
                  disabled={!loyaltyRedeemAvailable || loyaltyRedeemLoading}
                  title={loyaltyActionTitle}
                  aria-label={loyaltyActionTitle}
                  className={`${cartActionIconButtonBaseClass} ${
                    loyaltyRedeemAvailable
                      ? 'text-purple-600 focus:ring-purple-400 dark:text-purple-300'
                      : 'cursor-not-allowed text-purple-700/35 dark:text-purple-200/35'
                  }`}
                >
                  {loyaltyRedeemLoading ? (
                    <Loader2 className="h-8 w-8 animate-spin flex-shrink-0" />
                  ) : (
                    <Award className="h-8 w-8 flex-shrink-0" aria-hidden="true" />
                  )}
                  <span className="sr-only">{t('menu.cart.loyaltyButton', 'Loyalty')}</span>
                </button>
              )}

              {discountControlEnabled && (
                <button
                  type="button"
                  onClick={openDiscountModal}
                  title={discountActionTitle}
                  aria-label={discountActionTitle}
                  className={`${cartActionIconButtonBaseClass} text-amber-600 focus:ring-amber-400 dark:text-amber-300`}
                >
                  <Percent className="h-8 w-8 flex-shrink-0" aria-hidden="true" />
                  <span className="sr-only">{t('menu.cart.discountAmount', 'Discount')}</span>
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

            {loyaltyRedemption && (
              <div className="flex items-center justify-between rounded-lg px-3 py-2 bg-purple-500/10 dark:bg-purple-500/20 border border-purple-500/20 dark:border-purple-500/30">
                <div className="flex items-center gap-2">
                  <Award className="w-4 h-4 text-purple-600 dark:text-purple-400" />
                  <div>
                    <span className="text-sm font-semibold antialiased text-purple-700 dark:text-purple-300">
                      {t('menu.cart.loyaltyRedemption', '{{points}} pts', {
                        points: loyaltyRedemption.pointsRedeemed,
                      })}
                    </span>
                    <span className="text-xs ml-2 antialiased text-purple-600/70 dark:text-purple-300/70">
                      {formatCurrency(loyaltyDiscountAmount)} {t('menu.cart.loyaltyOff', 'off')}
                    </span>
                  </div>
                </div>
                {onRemoveLoyaltyRedemption && (
                  <button
                    onClick={onRemoveLoyaltyRedemption}
                    className="p-1 rounded-full transition-colors text-purple-600 dark:text-purple-300 hover:bg-purple-500/20"
                    title={t('menu.cart.removeLoyaltyRedemption', 'Remove loyalty redemption')}
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

        {offerDiscountAmount > 0 && (
          <div className="flex justify-between items-center text-sm font-medium antialiased">
            <span className="flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
              <Gift className="w-3.5 h-3.5" />
              {matchedOfferNames.length > 0
                ? t('menu.cart.offerDiscountWithNames', 'Offers ({{names}})', {
                    names: matchedOfferNames.join(', '),
                  })
                : t('menu.cart.offerDiscount', 'Offers')}
              :
            </span>
            <span className="text-emerald-600 dark:text-emerald-400">
              -{formatCurrency(offerDiscountAmount)}
            </span>
          </div>
        )}

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

        {loyaltyDiscountAmount > 0 && loyaltyRedemption && (
          <div className="flex justify-between items-center text-sm font-medium antialiased">
            <span className="flex items-center gap-1 text-purple-600 dark:text-purple-400">
              <Award className="w-3.5 h-3.5" />
              {t('menu.cart.loyaltyDiscount', 'Loyalty')}:
            </span>
            <span className="text-purple-600 dark:text-purple-400">
              -{formatCurrency(loyaltyDiscountAmount)}
            </span>
          </div>
        )}

        {isDeliveryOrder && (
          <div className="flex justify-between items-center text-sm font-medium antialiased">
            <span className="liquid-glass-modal-text-muted">
              {t('menu.cart.deliveryFee')}
            </span>
            {allowManualDeliveryFee ? (
              <input
                type="text"
                inputMode="decimal"
                value={manualDeliveryFeeInput}
                onChange={(event) => {
                  const formatted = formatMoneyInputWithCents(event.target.value);
                  setManualDeliveryFeeInput(formatted);
                  onManualDeliveryFeeChange?.(parseMoneyInputValue(formatted));
                }}
                placeholder={t('menu.cart.manualDeliveryFeePlaceholder', '0,00')}
                className="w-24 rounded-lg border bg-black/5 px-2.5 py-1.5 text-right text-sm antialiased dark:bg-white/10 border-black/10 dark:border-white/15 liquid-glass-modal-text placeholder:text-black/40 dark:placeholder:text-white/40 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            ) : (
              <span className="liquid-glass-modal-text">
                {deliveryFeeDisplay}
              </span>
            )}
          </div>
        )}

        {/* Total */}
        <div className="flex justify-between items-center pt-2 border-t border-black/10 dark:border-white/10 antialiased">
          <span className="text-lg font-semibold liquid-glass-modal-text">
            {t('menu.cart.total')}
          </span>
          <span className="text-xl font-bold text-emerald-600 dark:text-emerald-400">
            {formatCurrency(totalWithDeliveryFee)}
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
          disabled={isCheckoutBlocked}
          className={`w-full py-3 rounded-xl font-semibold antialiased transition-all duration-300 ${
            isCheckoutBlocked
              ? 'bg-black/10 dark:bg-white/10 text-black/30 dark:text-white/30 cursor-not-allowed'
              : editMode
                ? 'bg-amber-600 text-white hover:bg-amber-700 hover:scale-[1.02]'
                : 'bg-yellow-400 text-black hover:bg-yellow-300 hover:scale-[1.02]'
          }`}
        >
          {isSaving ? (
            <span className="flex items-center justify-center gap-2">
              <svg className="animate-spin h-5 w-5" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
              </svg>
              {t('common.actions.saving', { defaultValue: 'Saving...' })}
            </span>
          ) : editMode ? (
            t('modals.menu.saveChanges') || t('common.saveChanges')
          ) : (
            t('menu.cart.completeOrder')
          )}
        </button>
      </div>

      {isLineDiscountModalOpen && (
        <div className="fixed inset-0 z-[1198] flex items-center justify-center p-4">
          <button
            type="button"
            aria-label={t('common.close', 'Close')}
            onClick={() => setIsLineDiscountModalOpen(false)}
            className="absolute inset-0 bg-black/50 backdrop-blur-md"
          />
          <div className="relative w-full max-w-xl liquid-glass-modal-shell !fixed !top-1/2 !left-1/2 !-translate-x-1/2 !-translate-y-1/2 !max-w-xl !max-h-fit !animate-none">
            <div className="liquid-glass-modal-header">
              <div>
                <h4 className="liquid-glass-modal-title !text-xl">
                  {t('menu.cart.lineDiscountTitle', 'Selected Item Discount')}
                </h4>
                <p className="text-sm antialiased liquid-glass-modal-text-muted">
                  {t('menu.cart.lineDiscountSelectionSummary', '{{count}} items - {{amount}}', {
                    count: selectedCartItemIdsArray.length,
                    amount: formatCurrency(selectedLineSubtotal),
                  })}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setIsLineDiscountModalOpen(false)}
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
                    setLineDiscountModeDraft('percentage');
                    setLineDiscountDraft(parseDiscountInput(lineDiscountManualInput, 'percentage'));
                  }}
                  className={`py-2 rounded-lg text-sm font-semibold border transition-colors ${
                    lineDiscountModeDraft === 'percentage'
                      ? 'bg-blue-500 border-blue-400 text-white'
                      : 'bg-black/5 dark:bg-white/10 border-black/10 dark:border-white/15 liquid-glass-modal-text hover:bg-black/10 dark:hover:bg-white/15'
                  }`}
                >
                  {t('menu.cart.percentMode', '% Mode')}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setLineDiscountModeDraft('fixed');
                    setLineDiscountDraft(parseDiscountInput(lineDiscountManualInput, 'fixed'));
                  }}
                  className={`py-2 rounded-lg text-sm font-semibold border transition-colors ${
                    lineDiscountModeDraft === 'fixed'
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
                    const disabled =
                      lineDiscountModeDraft === 'percentage'
                        ? value > maxDiscountPercentage
                        : selectedLineSubtotal <= 0;
                    const selected = Math.abs(lineDiscountDraft - value) < 0.001;

                    return (
                      <button
                        key={`line-${value}`}
                        type="button"
                        disabled={disabled}
                        onClick={() => {
                          if (disabled) {
                            return;
                          }
                          const nextValue =
                            lineDiscountModeDraft === 'fixed'
                              ? Math.min(value, selectedLineSubtotal)
                              : value;
                          setLineDiscountDraft(nextValue);
                          setLineDiscountManualInput(String(nextValue));
                        }}
                        className={`py-2 rounded-lg text-sm font-semibold border transition-colors ${
                          disabled
                            ? 'opacity-45 cursor-not-allowed'
                            : selected
                              ? 'bg-blue-500 border-blue-400 text-white'
                              : 'bg-black/5 dark:bg-white/10 border-black/10 dark:border-white/15 liquid-glass-modal-text hover:bg-black/10 dark:hover:bg-white/15'
                        }`}
                      >
                        {lineDiscountModeDraft === 'percentage' ? `${value}%` : formatCurrency(value)}
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
                    value={lineDiscountManualInput}
                    onChange={(e) => {
                      const rawValue = e.target.value;
                      setLineDiscountManualInput(rawValue);
                      setLineDiscountDraft(parseDiscountInput(rawValue, lineDiscountModeDraft));
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && canApplyLineDiscount) {
                        applySelectedLineDiscount();
                      }
                    }}
                    placeholder={
                      lineDiscountModeDraft === 'percentage'
                        ? t('menu.cart.discountLabel')
                        : t('menu.cart.discountAmount', 'Discount amount')
                    }
                    className="w-full px-4 py-3 rounded-lg text-base border bg-black/5 dark:bg-white/10 border-black/10 dark:border-white/15 liquid-glass-modal-text placeholder:text-black/40 dark:placeholder:text-white/40 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    autoFocus
                  />
                  <span className="text-base font-semibold liquid-glass-modal-text">
                    {lineDiscountModeDraft === 'percentage' ? '%' : '€'}
                  </span>
                </div>
                {isLineDiscountDraftOverMax && (
                  <p className="text-xs text-red-500 mt-2 font-medium antialiased">
                    {t('menu.cart.discountExceeded', { max: maxDiscountPercentage })}
                  </p>
                )}
              </div>
            </div>

            <div className="flex items-center justify-between gap-3 px-6 py-4 border-t border-black/10 dark:border-white/10">
              <button
                type="button"
                onClick={clearSelectedLineDiscount}
                className="liquid-glass-modal-button px-4 py-2 text-sm font-semibold"
              >
                {t('menu.cart.clearLineDiscountShort', 'Clear')}
              </button>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setIsLineDiscountModalOpen(false)}
                  className="liquid-glass-modal-button px-4 py-2 text-sm font-semibold"
                >
                  {t('common.cancel', 'Cancel')}
                </button>
                <button
                  type="button"
                  onClick={applySelectedLineDiscount}
                  disabled={!canApplyLineDiscount}
                  className={`px-5 py-2 rounded-lg text-sm font-semibold ${
                    canApplyLineDiscount
                      ? 'bg-blue-600 text-white hover:bg-blue-700'
                      : 'bg-black/10 dark:bg-white/10 text-black/30 dark:text-white/30 cursor-not-allowed'
                  }`}
                >
                  {t('menu.cart.applyDiscount', 'Apply discount')}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

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
