import React, { useState, useCallback, useMemo } from 'react';
import { useI18n } from '../../contexts/i18n-context';
import toast from 'react-hot-toast';
import type { Order } from '../../types/orders';
import { formatCurrency, formatDate, formatTime } from '../../utils/format';
import { normalizeOrderTypeForDisplay, resolveOrderDisplayTitle } from '../../utils/orderDisplay';
import { Package, User, MapPin, CreditCard, Clock, Printer, X, Check, XCircle, Banknote, Tag, Ban } from 'lucide-react';
import { getBridge } from '../../../lib';
import { calculateSubtotalFromItems } from './order-math';
import { LiquidGlassModal } from '../ui/pos-glass-components';
import { formatCompactOrderNumberForDisplay } from '../../utils/orderNumberUtils';

interface OrderApprovalPanelProps {
  order: Order;
  onApprove: (orderId: string, estimatedTime?: number) => Promise<void>;
  onDecline: (orderId: string, reason: string) => Promise<void>;
  onClose: () => void;
  viewOnly?: boolean;
}

const ESTIMATED_TIME_OPTIONS = [15, 20, 25, 30, 45, 60];
const DECLINE_REASON_MAX_LENGTH = 500;
const KIOSK_ORDER_NUMBER_PATTERN = /^#?[A-Za-z]+-[A-Za-z0-9]{1,16}-\d{8}-\d{6}-\d+$/;
const KIOSK_SHORT_ORDER_NUMBER_PATTERN = /^#?K[A-Za-z]*-\d+$/i;

function readFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function resolveOrderTotalAmount(order: unknown, fallback: number): number {
  const record = (order ?? {}) as Record<string, unknown>;
  const cents =
    readFiniteNumber(record.total_amount_cents) ??
    readFiniteNumber(record.totalAmountCents);
  if (cents !== null) {
    return cents / 100;
  }

  return (
    readFiniteNumber(record.total_amount) ??
    readFiniteNumber(record.totalAmount) ??
    fallback
  );
}

function resolveDisplayOrderNumber(orderNumber: string, createdAt?: string | null): string {
  const trimmedOrderNumber = orderNumber.trim();
  if (isKioskOrderNumber(trimmedOrderNumber)) {
    return formatCompactOrderNumberForDisplay(trimmedOrderNumber, createdAt);
  }

  return trimmedOrderNumber;
}

function isKioskOrderNumber(orderNumber: string): boolean {
  return (
    KIOSK_ORDER_NUMBER_PATTERN.test(orderNumber) ||
    KIOSK_SHORT_ORDER_NUMBER_PATTERN.test(orderNumber)
  );
}

/**
 * Safely parses items from JSON string format.
 * Handles parsing errors gracefully.
 * Requirements: 2.6
 *
 * @param items - Items that may be a JSON string or array
 * @returns Parsed array of items
 */
function parseItemsFromJson(items: any): any[] {
  if (!items) return [];

  // If already an array, return as-is
  if (Array.isArray(items)) return items;

  // If it's a string, try to parse as JSON
  if (typeof items === 'string') {
    try {
      const parsed = JSON.parse(items);
      if (Array.isArray(parsed)) return parsed;
      console.warn('[OrderApprovalPanel] Parsed JSON is not an array:', typeof parsed);
      return [];
    } catch (e) {
      console.warn('[OrderApprovalPanel] Failed to parse items JSON:', items, e);
      return [];
    }
  }

  console.warn('[OrderApprovalPanel] Items is not an array or string:', typeof items);
  return [];
}

function getOrderItemsCandidate(order: Order | any): any {
  return order?.items ?? order?.order_items ?? order?.orderItems;
}

function flattenCustomizationInput(customizations: any): any[] {
  if (!customizations) return [];
  if (Array.isArray(customizations)) return customizations;
  if (typeof customizations !== 'object') return [];

  const groupedCandidates = [
    customizations.added,
    customizations.selected,
    customizations.ingredients,
    customizations.items,
  ].filter(Array.isArray);

  const added = groupedCandidates.flat();
  const removed = Array.isArray(customizations.removed)
    ? customizations.removed.map((entry: any) => {
        if (typeof entry === 'string') {
          return { name: entry, isWithout: true };
        }
        return { ...entry, isWithout: true };
      })
    : [];

  if (added.length > 0 || removed.length > 0) {
    return [...added, ...removed];
  }

  return Object.values(customizations).flatMap((value: any) => (
    Array.isArray(value) ? value : [value]
  ));
}

function parseMetadataCandidate(value: unknown): Record<string, any> | null {
  if (!value) return null;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, any>
        : null;
    } catch {
      return null;
    }
  }
  return typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, any>
    : null;
}

function resolveKioskMetadata(order: Order | any): Record<string, any> | null {
  const metadata = parseMetadataCandidate(order?.ghost_metadata ?? order?.ghostMetadata);
  const kiosk = metadata?.kiosk;
  return kiosk && typeof kiosk === 'object' && !Array.isArray(kiosk)
    ? kiosk as Record<string, any>
    : null;
}

function resolveRequestedPaymentMethod(order: Order | any): 'cash' | 'card' | null {
  const kioskMetadata = resolveKioskMetadata(order);
  const candidates = [
    order?.payment_method,
    order?.paymentMethod,
    kioskMetadata?.payment_method,
    kioskMetadata?.paymentMethod,
  ];

  for (const candidate of candidates) {
    const normalized = String(candidate ?? '').trim().toLowerCase();
    if (normalized === 'cash' || normalized === 'card') {
      return normalized;
    }
  }

  return null;
}

/**
 * Fetches order items with a clear fallback chain:
 * 1. Try local order items first
 * 2. Then local DB fetch
 * 3. Then Supabase fetch
 *
 * Requirements: 2.1, 2.5, 2.6
 *
 * @param order - The order object
 * @returns Promise resolving to array of order items
 */
async function fetchOrderItems(order: Order): Promise<any[]> {
  // 1. Check local order first - handle JSON string format
  const localItems = getOrderItemsCandidate(order);
  const parsedLocalItems = parseItemsFromJson(localItems);

  if (parsedLocalItems.length > 0) {
    console.log('[OrderApprovalPanel] Using local order items:', parsedLocalItems.length);
    return parsedLocalItems;
  }

  // Need to fetch from backend
  if (!order.id || typeof window === 'undefined') {
    console.log('[OrderApprovalPanel] Cannot fetch items - no order ID or not in browser');
    return [];
  }

  const bridge = getBridge();

  // 2. Fetch from local DB by order ID
  try {
    console.log('[OrderApprovalPanel] Fetching from local DB for order:', order.id);
    const response: any = await bridge.orders.getById(order.id);
    const fetchedOrder = response?.data || response;

    if (fetchedOrder) {
      const dbItems = parseItemsFromJson(getOrderItemsCandidate(fetchedOrder));
      if (dbItems.length > 0) {
        console.log('[OrderApprovalPanel] Fetched items from local DB:', dbItems.length);
        return dbItems;
      }
    }
  } catch (e) {
    console.warn('[OrderApprovalPanel] Local DB fetch failed:', e);
  }

  // 3. Fetch from Supabase using supabase_id
  try {
    const supabaseId = order.supabase_id || order.supabaseId || order.id;
    console.log('[OrderApprovalPanel] Fetching from Supabase for order:', supabaseId);

    const response: any = await bridge.orders.fetchItemsFromSupabase(supabaseId);
    const itemsResult = response?.data || response;

    if (Array.isArray(itemsResult) && itemsResult.length > 0) {
      console.log('[OrderApprovalPanel] Fetched items from Supabase:', itemsResult.length);
      return itemsResult;
    }
  } catch (e) {
    console.warn('[OrderApprovalPanel] Supabase fetch failed:', e);
  }

  console.log('[OrderApprovalPanel] No items found after all fetch attempts');
  return [];
}

export function OrderApprovalPanel({
  order,
  onApprove,
  onDecline,
  onClose,
  viewOnly = false,
}: OrderApprovalPanelProps) {
  const bridge = getBridge();
  const { t } = useI18n();
  const [estimatedTime, setEstimatedTime] = useState(20);
  const [isApproving, setIsApproving] = useState(false);
  const [isDeclining, setIsDeclining] = useState(false);
  const [showDeclineModal, setShowDeclineModal] = useState(false);
  const [declineReason, setDeclineReason] = useState('');
  const [isPrinting, setIsPrinting] = useState(false);
  const [isLoadingItems, setIsLoadingItems] = useState(false);
  const [itemsLoadError, setItemsLoadError] = useState<string | null>(null);
  const canClose = viewOnly;

  // Normalize fields to handle different shapes
  const rawOrderNumber = order.order_number || order.orderNumber || '';
  const orderType = normalizeOrderTypeForDisplay(
    (order.order_type || order.orderType || '').toString(),
  );
  const customerName = resolveOrderDisplayTitle({
    orderType,
    customerName: order.customer_name || order.customerName || '',
    pickupLabel: t('orders.type.pickup', { defaultValue: 'Pickup' }),
    fallbackLabel: t('orderApprovalPanel.guestCustomer', { defaultValue: 'Guest' }),
  });
  const customerPhone = order.customer_phone || order.customerPhone || '';
  const createdAtRaw = order.created_at || order.createdAt;
  const orderNumber = resolveDisplayOrderNumber(rawOrderNumber, createdAtRaw);
  const isKioskOrder = isKioskOrderNumber(rawOrderNumber.trim());
  const createdAt = createdAtRaw ? new Date(createdAtRaw) : null;
  const deliveryAddressRaw = order.delivery_address || order.address || '';
  const [deliveryAddress, setDeliveryAddress] = React.useState<string>(deliveryAddressRaw);
  const [fullOrder, setFullOrder] = React.useState<Order>(order);

  // Additional delivery fields (snake_case from normalized data)
  const deliveryCity = order.delivery_city || '';
  const deliveryPostalCode = order.delivery_postal_code || '';
  const deliveryFloor = order.delivery_floor || '';
  const deliveryNotes = order.delivery_notes || '';
  const nameOnRinger = order.name_on_ringer || '';
  const requestedPaymentMethod = resolveRequestedPaymentMethod(fullOrder || order);
  const paymentMethodLabel = requestedPaymentMethod === 'cash'
    ? t('orderApprovalPanel.paymentCash', { defaultValue: 'Cash' })
    : requestedPaymentMethod === 'card'
      ? t('orderApprovalPanel.paymentCard', { defaultValue: 'Card' })
      : t('orderApprovalPanel.paymentPending', { defaultValue: 'Pending' });
  const paymentMethodDescription = requestedPaymentMethod === 'cash'
    ? t('orderApprovalPanel.paymentCashDescription', { defaultValue: 'Customer selected cash payment at the linked terminal.' })
    : requestedPaymentMethod === 'card'
      ? t('orderApprovalPanel.paymentCardDescription', { defaultValue: 'Customer selected card payment at the linked terminal.' })
      : t('orderApprovalPanel.paymentPendingDescription', { defaultValue: 'Payment method is not available yet.' });

  // Log payment method for debugging
  console.log('[OrderApprovalPanel] order.payment_method:', order.payment_method);
  console.log('[OrderApprovalPanel] order.paymentMethod:', order.paymentMethod);
  console.log('[OrderApprovalPanel] full order object:', order);

  // Fetch full order details if items are missing
  // Requirements: 2.1, 2.5, 2.6
  React.useEffect(() => {
    const loadOrderItems = async () => {
      // Check if items are missing or empty using the parse function
      const currentItems = parseItemsFromJson(getOrderItemsCandidate(order));

      if (currentItems.length > 0) {
        // Items already present, update fullOrder
        setFullOrder({ ...order, items: currentItems });
        return;
      }

      // Need to fetch items
      setIsLoadingItems(true);
      setItemsLoadError(null);

      try {
        const items = await fetchOrderItems(order);
        if (items.length > 0) {
          setFullOrder({ ...order, items });
        } else {
          setItemsLoadError(t('orderApprovalPanel.noItems', { defaultValue: 'No items found' }));
        }
      } catch (e) {
        console.error('[OrderApprovalPanel] Failed to load order items:', e);
        setItemsLoadError(t('orderApprovalPanel.loadItemsFailed', { defaultValue: 'Failed to load items' }));
      } finally {
        setIsLoadingItems(false);
      }
    };

    loadOrderItems();
  }, [order.id, t]);

  React.useEffect(() => {
    if (deliveryAddressRaw) { setDeliveryAddress(deliveryAddressRaw); return; }
    const phone = order.customer_phone || order.customerPhone;
    if (!phone || typeof window === 'undefined') return;
    (async () => {
      try {
        const customer: any = await getBridge().customers.lookupByPhone(String(phone));
        if (!customer) return;
        const addr: any = Array.isArray(customer.addresses) && customer.addresses.length > 0
          ? (customer.addresses.find((a: any) => a.is_default) || customer.addresses[0])
          : null;
        if (addr) {
          let parts: string[] = [];
          if (addr.street) parts.push(addr.street);
          if (addr.city) parts.push(addr.city);
          if (addr.postal_code) parts.push(addr.postal_code);
          let full = parts.filter(Boolean).join(', ');
          setDeliveryAddress(full);
        }
      } catch {}
    })();
  }, [deliveryAddressRaw, order.customer_phone, order.customerPhone]);

  /**
   * Retry loading items when user clicks retry button
   * Requirements: 2.5
   */
  const handleRetryLoadItems = useCallback(async () => {
    setIsLoadingItems(true);
    setItemsLoadError(null);

    try {
      const items = await fetchOrderItems(order);
      if (items.length > 0) {
        setFullOrder({ ...order, items });
      } else {
        setItemsLoadError(t('orderApprovalPanel.noItems', { defaultValue: 'No items found' }));
      }
    } catch (e) {
      console.error('[OrderApprovalPanel] Retry failed:', e);
      setItemsLoadError(t('orderApprovalPanel.loadItemsFailed', { defaultValue: 'Failed to load items' }));
    } finally {
      setIsLoadingItems(false);
    }
  }, [order, t]);

  /**
   * Normalizes order items for display.
   * Extracts customizations/ingredients as sub-items with prices.
   * Requirements: 2.1, 2.2
   */
  const normalizedItems = useMemo(() => {
    // Use fullOrder which may have been fetched with complete data
    const orderToUse = fullOrder || order;

    // Parse items using the helper function
    const items = parseItemsFromJson(getOrderItemsCandidate(orderToUse));

    console.log('[OrderApprovalPanel] Normalizing items:', items.length);

    // Deduplicate items by id to prevent showing duplicates
    const seenIds = new Set<string>();
    const uniqueItems = items.filter((item: any) => {
      const itemId = item.id || item.menu_item_id || `${item.name}-${item.quantity}-${item.price}`;
      if (seenIds.has(itemId)) {
        console.log('[OrderApprovalPanel] Filtering duplicate item:', itemId);
        return false;
      }
      seenIds.add(itemId);
      return true;
    });

    console.log('[OrderApprovalPanel] Unique items after dedup:', uniqueItems.length);

    return uniqueItems.map((item: any) => {
      // Extract customizations/ingredients - handle both array and object formats
      // Requirements: 2.2 - Display customizations as sub-items with prices
      let customizationsList: { name: string; price: number; isWithout?: boolean; isLittle?: boolean; categoryName?: string }[] = [];
      const rawCustomizations = item.customizations || item.modifiers || item.ingredients || item.selectedIngredients;

      // Helper to extract price from ingredient object - check all possible price fields
      const extractPrice = (c: any): number => {
        const parsePrice = (val: any): number => {
          if (val === null || val === undefined) return 0;
          const num = typeof val === 'string' ? parseFloat(val) : Number(val);
          return isNaN(num) ? 0 : num;
        };

        // Check ingredient object first (most common structure from Supabase)
        if (c.ingredient) {
          const ing = c.ingredient;
          const pickupPrice = parsePrice(ing.pickup_price);
          const deliveryPrice = parsePrice(ing.delivery_price);
          const price = parsePrice(ing.price);
          const basePrice = parsePrice(ing.base_price);

          if (pickupPrice > 0) return pickupPrice;
          if (deliveryPrice > 0) return deliveryPrice;
          if (price > 0) return price;
          if (basePrice > 0) return basePrice;
        }

        // Check direct price fields on the customization object
        const directPickup = parsePrice(c.pickup_price);
        const directDelivery = parsePrice(c.delivery_price);
        const directPrice = parsePrice(c.price);
        const additionalPrice = parsePrice(c.additionalPrice);
        const extraPrice = parsePrice(c.extra_price);
        const directBase = parsePrice(c.base_price);

        if (directPickup > 0) return directPickup;
        if (directDelivery > 0) return directDelivery;
        if (directPrice > 0) return directPrice;
        if (additionalPrice > 0) return additionalPrice;
        if (extraPrice > 0) return extraPrice;
        if (directBase > 0) return directBase;

        return 0;
      };

      // Helper to extract name from customization object
      const extractName = (c: any): string => {
        if (c.ingredient?.name) return c.ingredient.name;
        if (c.ingredient?.name_en) return c.ingredient.name_en;
        if (c.ingredient?.name_el) return c.ingredient.name_el;
        if (c.name) return c.name;
        if (c.name_en) return c.name_en;
        if (c.name_el) return c.name_el;
        if (c.optionName) return c.optionName;
        if (c.label) return c.label;
        return 'Unknown';
      };

      // Helper to extract category name from customization
      const extractCategoryName = (c: any): string | undefined => {
        return c.ingredient?.category_name || c.category_name || c.categoryName || c.group_name || c.groupName || undefined;
      };

      // Helper to check if item is "without" (removed)
      const isWithoutItem = (c: any): boolean => {
        return c.isWithout === true || c.is_without === true || c.without === true;
      };
      const isLittleItem = (c: any): boolean => {
        return c.isLittle === true || c.is_little === true || c.little === true;
      };

      const resolveCategoryPath = (rawItem: any): string | null => {
        const explicitPath =
          (typeof rawItem?.category_path === 'string' && rawItem.category_path.trim()) ||
          (typeof rawItem?.categoryPath === 'string' && rawItem.categoryPath.trim()) ||
          '';
        if (explicitPath) {
          const [primary] = explicitPath.split('>');
          const normalizedPrimary = typeof primary === 'string' ? primary.trim() : '';
          if (normalizedPrimary) return normalizedPrimary;
          return explicitPath;
        }

        const category =
          rawItem?.categoryName ||
          rawItem?.category_name ||
          rawItem?.category?.name ||
          rawItem?.menu_item?.category_name ||
          rawItem?.menu_item?.categoryName ||
          '';
        const normalizedCategory = typeof category === 'string' ? category.trim() : '';
        if (normalizedCategory) return normalizedCategory;

        const fallbackSubcategory =
          rawItem?.subcategory_name ||
          rawItem?.subcategoryName ||
          rawItem?.sub_category_name ||
          rawItem?.subCategoryName ||
          '';
        const normalizedSubcategory =
          typeof fallbackSubcategory === 'string' ? fallbackSubcategory.trim() : '';
        return normalizedSubcategory || null;
      };

      const customizationEntries = flattenCustomizationInput(rawCustomizations);
      customizationsList = customizationEntries
        .filter((c: any) => c && (c.ingredient || c.name || c.name_en || c.name_el || c.customizationId))
        .map((c: any) => ({
          name: extractName(c),
          price: extractPrice(c),
          isWithout: isWithoutItem(c),
          isLittle: isLittleItem(c),
          categoryName: extractCategoryName(c)
        }));

      // Get item price - prefer unit_price, then price
      const unitPrice = typeof item.unit_price === 'number' ? item.unit_price :
                        typeof item.price === 'number' ? item.price : 0;

      const itemNotes = [
        item.special_instructions,
        item.specialInstructions,
        item.notes,
        item.instructions
      ]
        .map((value: any) => (typeof value === 'string' ? value.trim() : ''))
        .filter((value: string) => Boolean(value))
        .filter(
          (value: string, index: number, array: string[]) =>
            array.findIndex((existing: string) => existing.toLowerCase() === value.toLowerCase()) === index
        )
        .join(' | ');

      return {
        name: item.name || item.menu_item_name || item.menuItemName || item.title || item.product_name || 'Item',
        quantity: item.quantity || 1,
        price: unitPrice,
        total_price: item.total_price || item.totalPrice || (unitPrice * (item.quantity || 1)),
        special_instructions: itemNotes || undefined,
        customizations: customizationsList,
        categoryName: item.categoryName || item.category_name || null, // Main category (e.g., "Crepes")
        categoryPath: resolveCategoryPath(item),
      };
    });
  }, [fullOrder, order, t]);

  // Calculate subtotal from items using total_price values
  // Requirements: 2.3, 6.1, 6.3
  const subtotal = useMemo(() => {
    return calculateSubtotalFromItems(normalizedItems.map(item => ({
      total_price: item.total_price,
      unit_price: item.price,
      quantity: item.quantity
    })));
  }, [normalizedItems]);
  const taxAmount = order.tax_amount || order.taxAmount || 0;
  const deliveryFee = order.deliveryFee ?? 0;
  const discountAmount = order.discount_amount || 0;
  const discountPercentage = order.discount_percentage || 0;
  const totalAmount = resolveOrderTotalAmount(fullOrder || order, subtotal);

  const handleApprove = useCallback(async () => {
    if (!estimatedTime) {
      toast.error(t('orderApprovalPanel.selectTime'));
      return;
    }
    setIsApproving(true);
    try {
      await onApprove(order.id, estimatedTime);
      toast.success(t('orderApprovalPanel.approved'));
      onClose();
    } catch (error) {
      toast.error(t('orderApprovalPanel.approveFailed'));
    } finally {
      setIsApproving(false);
    }
  }, [order.id, estimatedTime, onApprove, onClose, t]);

  const handleDecline = useCallback(async () => {
    const trimmedReason = declineReason.trim();
    if (!trimmedReason) {
      toast.error(t('orderApprovalPanel.reasonRequired'));
      return;
    }
    setIsDeclining(true);
    try {
      await onDecline(order.id, trimmedReason);
      toast.success(t('orderApprovalPanel.declined'));
      onClose();
    } catch (error) {
      toast.error(t('orderApprovalPanel.declineFailed'));
    } finally {
      setIsDeclining(false);
      setShowDeclineModal(false);
    }
  }, [order.id, declineReason, onDecline, onClose, t]);

  const handlePrint = useCallback(async () => {
    console.log('[OrderApprovalPanel] Print button clicked, order ID:', order.id);
    setIsPrinting(true);
    try {
      const printType = order.order_type === 'delivery' ? 'delivery' : 'customer';
      console.log('[OrderApprovalPanel] Calling bridge.payments.printReceipt with order ID:', order.id);
      const result = await bridge.payments.printReceipt(order.id, printType);
      console.log('[OrderApprovalPanel] printReceipt result:', result);
      if (result?.success === false) {
        throw new Error(result.error || 'Print command returned failure');
      }
      toast.success(t('orderApprovalPanel.printSuccess') || 'Receipt printed successfully');
    } catch (error) {
      console.error('[OrderApprovalPanel] Print error:', error);
      toast.error(t('orderApprovalPanel.printFailed') || 'Failed to print receipt');
    } finally {
      setIsPrinting(false);
    }
  }, [bridge.payments, order.id, order.order_type, t]);


  const getOrderTypeLabel = (type: string) => {
    switch (type?.toLowerCase()) {
      case 'delivery': return t('orderDashboard.delivery', { defaultValue: 'Delivery' });
      case 'pickup': return t('orderDashboard.pickup', { defaultValue: 'Pickup' });
      case 'dine-in': return t('orderDashboard.dineIn', { defaultValue: 'Dine In' });
      default: return type;
    }
  };

  const getStatusTextColor = (status: string) => {
    switch (status?.toLowerCase()) {
      case 'pending': return 'text-yellow-600 dark:text-yellow-400';
      case 'processing': return 'text-blue-600 dark:text-blue-400';
      case 'completed': return 'text-green-600 dark:text-green-400';
      case 'cancelled': return 'text-red-600 dark:text-red-400';
      default: return 'text-gray-600 dark:text-gray-400';
    }
  };

  return (
    <>
      <LiquidGlassModal
        isOpen
        onClose={canClose ? onClose : () => undefined}
        closeOnBackdrop={canClose}
        closeOnEscape={canClose}
        size="lg"
        className="!max-h-[88vh] !max-w-3xl"
        contentClassName="px-5 py-4 sm:px-6"
        ariaLabel={t('orderApprovalPanel.reviewOrder', { defaultValue: 'Review incoming order' })}
        header={(
          <div className="flex-shrink-0 border-b liquid-glass-modal-border bg-white/5 px-5 py-4 dark:bg-black/20 sm:px-6">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className={`text-xs font-bold uppercase tracking-wide ${getStatusTextColor(order.status)}`}>
                    {t(`orders.status.${order.status}`, { defaultValue: order.status || 'Pending' })}
                  </span>
                  <span className="text-xs font-semibold uppercase tracking-wide liquid-glass-modal-text-muted">
                    {getOrderTypeLabel(orderType)}
                  </span>
                  <span className="text-xs font-semibold uppercase tracking-wide liquid-glass-modal-text-muted">
                    {paymentMethodLabel}
                  </span>
                </div>
                <h2
                  id={`order-approval-title-${order.id}`}
                  className="mt-3 truncate text-2xl font-bold liquid-glass-modal-text"
                >
                  {isKioskOrder
                    ? t('orderApprovalPanel.kioskOrderNumber', {
                        number: orderNumber,
                        defaultValue: `Order ${orderNumber}`,
                      })
                    : t('orderApprovalPanel.orderNumber', {
                        number: orderNumber,
                        defaultValue: `Order #${orderNumber}`,
                      })}
                </h2>
                {createdAt && (
                  <p className="mt-1 text-sm liquid-glass-modal-text-muted">
                    {t('orderApprovalPanel.receivedAt', {
                      defaultValue: 'Received {{time}}',
                      time: `${formatDate(createdAt)} ${formatTime(createdAt, { hour: '2-digit', minute: '2-digit' })}`,
                    })}
                  </p>
                )}
              </div>
              <div className="text-right">
                <p className="text-xs font-bold uppercase tracking-wider liquid-glass-modal-text-muted">
                  {t('orderApprovalPanel.total', { defaultValue: 'Total' })}
                </p>
                <p className="text-3xl font-black text-blue-500 dark:text-blue-400">
                  {formatCurrency(totalAmount)}
                </p>
              </div>
              {canClose ? (
                <button
                  onClick={onClose}
                  className="liquid-glass-modal-button min-h-0 min-w-0 shrink-0 p-2"
                  aria-label={t('common.actions.close')}
                >
                  <X className="h-5 w-5" />
                </button>
              ) : null}
            </div>
          </div>
        )}
        footer={(
          <div className="flex-shrink-0 space-y-3 border-t liquid-glass-modal-border bg-white/5 px-5 py-4 dark:bg-black/20 sm:px-6">
            {!viewOnly ? (
              <>
                <div className="flex flex-col gap-2 lg:flex-row lg:items-center">
                  <div className="flex items-center gap-2 text-sm font-bold uppercase tracking-wider liquid-glass-modal-text-muted lg:w-48">
                    <Clock className="h-4 w-4" />
                    {t('orderApprovalPanel.estimatedTimeShort', { defaultValue: 'Prep time' })}
                  </div>
                  <div className="grid flex-1 grid-cols-6 gap-2">
                    {ESTIMATED_TIME_OPTIONS.map((time) => (
                      <button
                        key={time}
                        type="button"
                        onClick={() => setEstimatedTime(time)}
                        className={`min-h-[2.75rem] rounded-lg px-2 text-sm font-bold transition ${
                          estimatedTime === time
                            ? 'border border-white bg-white text-black shadow-lg shadow-white/15'
                            : 'liquid-glass-modal-button'
                        }`}
                        aria-pressed={estimatedTime === time}
                      >
                        {time}{t('common.units.minutesShort', { defaultValue: 'm' })}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="grid grid-cols-[minmax(0,1fr)_minmax(8rem,0.45fr)] gap-3">
                  <button
                    type="button"
                    onClick={handleApprove}
                    disabled={isApproving || isDeclining}
                    className="liquid-glass-modal-button min-h-[3.25rem] justify-center gap-2 border-green-500/30 bg-green-600/20 text-green-400 hover:bg-green-600/30"
                  >
                    <Check className="h-4 w-4" />
                    {isApproving ? t('orderApprovalPanel.approving', { defaultValue: 'Approving...' }) : t('orderApprovalPanel.approveButton', { defaultValue: 'Approve' })}
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowDeclineModal(true)}
                    disabled={isApproving || isDeclining}
                    className="liquid-glass-modal-button min-h-[3.25rem] justify-center gap-2 border-red-500/30 bg-red-600/20 text-red-400 hover:bg-red-600/30"
                  >
                    <XCircle className="h-4 w-4" />
                    {t('orderApprovalPanel.declineButton', { defaultValue: 'Decline' })}
                  </button>
                </div>
              </>
            ) : (
              <div className="grid grid-cols-2 gap-3">
                <button
                  type="button"
                  onClick={handlePrint}
                  disabled={isPrinting}
                  className="liquid-glass-modal-button w-full gap-2"
                >
                  <Printer className="h-4 w-4" />
                  {isPrinting ? t('orderApprovalPanel.printing', { defaultValue: 'Printing...' }) : t('orderApprovalPanel.printReceipt', { defaultValue: 'Print receipt' })}
                </button>
                <button
                  type="button"
                  onClick={onClose}
                  className="liquid-glass-modal-button w-full gap-2 border-blue-500/30 bg-blue-600/20 text-blue-400 hover:bg-blue-600/30"
                >
                  {t('common.actions.close', { defaultValue: 'Close' })}
                </button>
              </div>
            )}
          </div>
        )}
      >
        <div className="space-y-4">
          <div className="grid gap-3 md:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)]">
            <section className="liquid-glass-modal-card p-4">
              <div className="flex items-center gap-3">
                <User className="h-5 w-5 flex-shrink-0 text-purple-400" />
                <div className="min-w-0">
                  <p className="text-xs font-bold uppercase tracking-wider liquid-glass-modal-text-muted">
                    {t('orderApprovalPanel.name', { defaultValue: 'Customer' })}
                  </p>
                  <p className="truncate text-base font-bold liquid-glass-modal-text">
                    {customerName}
                  </p>
                  {customerPhone && (
                    <p className="truncate text-sm liquid-glass-modal-text-muted">
                      {customerPhone}
                    </p>
                  )}
                </div>
              </div>
            </section>

            <section className={`liquid-glass-modal-card p-4 ${
              requestedPaymentMethod === 'cash'
                ? 'border-green-500/25 bg-green-500/10'
                : requestedPaymentMethod === 'card'
                  ? 'border-blue-500/25 bg-blue-500/10'
                  : ''
            }`}>
              <div className="flex items-center gap-3">
                {requestedPaymentMethod === 'cash' ? (
                  <Banknote className="h-5 w-5 flex-shrink-0 text-green-400" />
                ) : (
                  <CreditCard className={`h-5 w-5 flex-shrink-0 ${
                    requestedPaymentMethod === 'card'
                      ? 'text-blue-400'
                      : 'liquid-glass-modal-text-muted'
                  }`} />
                )}
                <div className="min-w-0">
                  <p className="text-xs font-bold uppercase tracking-wider liquid-glass-modal-text-muted">
                    {t('orderApprovalPanel.paymentMethod', { defaultValue: 'Payment' })}
                  </p>
                  <p className="truncate text-base font-bold liquid-glass-modal-text">
                    {paymentMethodLabel}
                  </p>
                  <p className="line-clamp-2 text-sm liquid-glass-modal-text-muted">
                    {paymentMethodDescription}
                  </p>
                </div>
              </div>
            </section>
          </div>

          {orderType === 'delivery' && (deliveryAddress || deliveryCity || deliveryPostalCode || deliveryFloor || nameOnRinger || deliveryNotes) && (
            <section className="liquid-glass-modal-card p-4">
              <div className="flex items-start gap-3">
                <div className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-xl bg-amber-500/15 text-amber-400">
                  <MapPin className="h-5 w-5" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-bold uppercase tracking-wider liquid-glass-modal-text-muted">
                    {t('orderApprovalPanel.address', { defaultValue: 'Address' })}
                  </p>
                  <p className="mt-1 font-semibold liquid-glass-modal-text">
                    {[deliveryAddress, deliveryCity, deliveryPostalCode].filter(Boolean).join(', ')}
                  </p>
                  {(deliveryFloor || nameOnRinger || deliveryNotes) && (
                    <p className="mt-1 text-sm liquid-glass-modal-text-muted">
                      {[deliveryFloor && `${t('orderApprovalPanel.floor', { defaultValue: 'Floor' })}: ${deliveryFloor}`, nameOnRinger && `${t('orderApprovalPanel.nameOnRinger', { defaultValue: 'Name on ringer' })}: ${nameOnRinger}`, deliveryNotes].filter(Boolean).join(' | ')}
                    </p>
                  )}
                </div>
              </div>
            </section>
          )}

          <section className="liquid-glass-modal-card overflow-hidden p-0">
            <div className="flex items-center justify-between gap-3 border-b liquid-glass-modal-border px-4 py-3">
              <h4 className="flex items-center gap-2 text-sm font-bold uppercase tracking-wider liquid-glass-modal-text-muted">
                <Package className="h-4 w-4" />
                {t('orderApprovalPanel.orderItems', { defaultValue: 'Order Items' })}
              </h4>
              <span className="text-sm font-semibold liquid-glass-modal-text-muted">
                {t('orderApprovalPanel.itemsCount', {
                  defaultValue: '{{count}} items',
                  count: normalizedItems.length,
                })}
              </span>
            </div>

            {isLoadingItems ? (
              <div className="flex items-center justify-center py-10">
                <div className="h-9 w-9 animate-spin rounded-full border-b-2 border-blue-500" />
              </div>
            ) : normalizedItems.length > 0 ? (
              <div className="max-h-[34vh] overflow-y-auto custom-scrollbar">
                {normalizedItems.map((item: { name: string; quantity: number; price: number; total_price: number; special_instructions?: string; customizations?: any[]; categoryName?: string | null; categoryPath?: string | null }, idx: number) => (
                  <div
                    key={idx}
                    className="border-b border-white/10 px-4 py-3 last:border-b-0"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex min-w-0 flex-1 items-start gap-3">
                        <div className="flex-shrink-0 text-sm font-bold text-orange-400">
                          {item.quantity}x
                        </div>
                        <div className="min-w-0 flex-1">
                          {(item.categoryPath || item.categoryName) && (
                            <div className="mb-0.5 text-[10px] font-bold uppercase tracking-wider liquid-glass-modal-text-muted">
                              {item.categoryPath || item.categoryName}
                            </div>
                          )}
                          <div className="break-words text-sm font-bold liquid-glass-modal-text">
                            {item.name}
                          </div>
                          {item.special_instructions && (
                            <div className="mt-1 text-xs italic liquid-glass-modal-text-muted">
                              {item.special_instructions}
                            </div>
                          )}
                          {item.customizations && item.customizations.length > 0 && (
                            <div className="mt-2 grid gap-1 text-xs liquid-glass-modal-text-muted sm:grid-cols-2">
                              {item.customizations.filter((c: any) => !c.isWithout).map((c: { name: string; price: number; isLittle?: boolean }, i: number) => (
                                <div key={`add-${i}`} className="flex justify-between gap-2">
                                  <span className="truncate">+ {c.name}{c.isLittle ? ` (${t('menu.itemModal.little', { defaultValue: 'Little' })})` : ''}</span>
                                  {c.price > 0 && <span>{formatCurrency(c.price)}</span>}
                                </div>
                              ))}
                              {item.customizations.filter((c: any) => c.isWithout).map((c: { name: string }, i: number) => (
                                <div key={`without-${i}`} className="flex items-center gap-1 text-red-400">
                                  <Ban className="h-3 w-3" />
                                  <span className="truncate line-through">{c.name}</span>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                      <div className="flex-shrink-0 text-sm font-bold liquid-glass-modal-text">
                        {formatCurrency(item.total_price)}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="py-8 text-center liquid-glass-modal-text-muted">
                <p className="mb-3">{itemsLoadError || t('orderApprovalPanel.noItems', { defaultValue: 'No items found' })}</p>
                <button
                  type="button"
                  onClick={handleRetryLoadItems}
                  disabled={isLoadingItems}
                  className="liquid-glass-modal-button"
                >
                  {t('orderApprovalPanel.retryLoadItems', { defaultValue: 'Try again' })}
                </button>
              </div>
            )}

            <div className="space-y-2 border-t liquid-glass-modal-border px-4 py-3">
              <div className="flex justify-between text-sm liquid-glass-modal-text-muted">
                <span>{t('orderApprovalPanel.subtotal', { defaultValue: 'Subtotal' })}</span>
                <span>{formatCurrency(subtotal)}</span>
              </div>
              {taxAmount > 0 && (
                <div className="flex justify-between text-sm liquid-glass-modal-text-muted">
                  <span>{t('orderApprovalPanel.tax', { defaultValue: 'Tax' })}</span>
                  <span>{formatCurrency(taxAmount)}</span>
                </div>
              )}
              {deliveryFee > 0 && (
                <div className="flex justify-between text-sm liquid-glass-modal-text-muted">
                  <span>{t('orderApprovalPanel.deliveryFee', { defaultValue: 'Delivery fee' })}</span>
                  <span>{formatCurrency(deliveryFee)}</span>
                </div>
              )}
              {discountAmount > 0 && (
                <div className="flex justify-between text-sm font-medium text-green-500">
                  <span className="inline-flex items-center gap-2">
                    <Tag className="h-4 w-4" aria-hidden="true" />
                    {t('orderApprovalPanel.discount', { defaultValue: 'Discount' })}
                    {discountPercentage > 0 && ` (${discountPercentage}%)`}
                  </span>
                  <span>-{formatCurrency(discountAmount)}</span>
                </div>
              )}
            </div>
          </section>
        </div>
      </LiquidGlassModal>

      <LiquidGlassModal
        isOpen={showDeclineModal}
        onClose={() => {
          if (!isDeclining) {
            setShowDeclineModal(false);
          }
        }}
        title={t('orderApprovalPanel.declineReason', { defaultValue: 'Decline reason' })}
        size="sm"
        className="!max-w-md"
        closeOnBackdrop={!isDeclining}
        closeOnEscape={!isDeclining}
        footer={(
          <div className="flex gap-3 border-t liquid-glass-modal-border bg-white/5 px-5 py-4 dark:bg-black/20">
            <button
              type="button"
              onClick={() => setShowDeclineModal(false)}
              disabled={isDeclining}
              className="liquid-glass-modal-button flex-1"
            >
              {t('common.actions.cancel', { defaultValue: 'Cancel' })}
            </button>
            <button
              type="button"
              onClick={handleDecline}
              disabled={isDeclining || !declineReason.trim()}
              className="liquid-glass-modal-button flex-1 border-red-500/30 bg-red-600/20 text-red-400 hover:bg-red-600/30 disabled:opacity-50"
            >
              {isDeclining ? t('orderApprovalPanel.declining', { defaultValue: 'Declining...' }) : t('orderApprovalPanel.confirmDecline', { defaultValue: 'Confirm' })}
            </button>
          </div>
        )}
      >
        <div className="space-y-4">
          <p className="text-sm liquid-glass-modal-text-muted">
            {t('orderApprovalPanel.declinePromptDescription', {
              defaultValue: 'Add the reason the customer will see when this order is denied.',
            })}
          </p>
          <textarea
            value={declineReason}
            onChange={(e) => setDeclineReason(e.target.value)}
            placeholder={t('orderApprovalPanel.declinePlaceholder', { defaultValue: 'Enter a reason...' })}
            className="liquid-glass-modal-input min-h-[8rem] w-full resize-none"
            maxLength={DECLINE_REASON_MAX_LENGTH}
            disabled={isDeclining}
          />
          <div className="text-right text-xs liquid-glass-modal-text-muted">
            {t('orderApprovalPanel.characterCount', {
              defaultValue: '{{current}}/{{max}}',
              current: declineReason.length,
              max: DECLINE_REASON_MAX_LENGTH,
            })}
          </div>
        </div>
      </LiquidGlassModal>
    </>
  );
}
