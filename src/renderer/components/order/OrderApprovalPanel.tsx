import React, { useState, useCallback, useMemo } from 'react';
import { useTheme } from '../../contexts/theme-context';
import { useI18n } from '../../contexts/i18n-context';
import toast from 'react-hot-toast';
import type { Order, OrderItem } from '../../types/orders';
import { formatCurrency, formatDate, formatTime } from '../../utils/format';
import { Package, User, MapPin, CreditCard, Clock, Printer, X, Check, XCircle, Banknote, Tag, Ban } from 'lucide-react';
import { getBridge } from '../../../lib';

interface OrderApprovalPanelProps {
  order: Order;
  onApprove: (orderId: string, estimatedTime?: number) => Promise<void>;
  onDecline: (orderId: string, reason: string) => Promise<void>;
  onClose: () => void;
  viewOnly?: boolean;
}

const ESTIMATED_TIME_OPTIONS = [15, 20, 25, 30, 45, 60];

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

/**
 * Calculates subtotal from order items using total_price values.
 * Requirements: 2.3, 6.1, 6.3
 *
 * @param items - Array of order items
 * @returns Calculated subtotal
 */
export function calculateSubtotalFromItems(items: any[]): number {
  if (!Array.isArray(items) || items.length === 0) return 0;

  return items.reduce((sum: number, item: any) => {
    // Prefer total_price which includes customizations
    // Fall back to unit_price * quantity or price * quantity
    const quantity = item.quantity || 1;

    if (typeof item.total_price === 'number' && item.total_price > 0) {
      return sum + item.total_price;
    }

    if (typeof item.totalPrice === 'number' && item.totalPrice > 0) {
      return sum + item.totalPrice;
    }

    // Calculate from unit price and quantity
    const unitPrice = typeof item.unit_price === 'number' ? item.unit_price :
                      typeof item.price === 'number' ? item.price : 0;

    return sum + (unitPrice * quantity);
  }, 0);
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
  const localItems = order.items || (order as any).order_items || (order as any).orderItems;
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
      const dbItems = parseItemsFromJson(fetchedOrder.items);
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
    const supabaseId = order.supabase_id || (order as any).supabaseId || order.id;
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
  const { resolvedTheme } = useTheme();
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
  const orderNumber = order.order_number || order.orderNumber || '';
  const customerName = order.customer_name || order.customerName || '';
  const customerPhone = order.customer_phone || order.customerPhone || '';
  const orderType = (order.order_type || order.orderType || '').toString();
  const createdAtRaw = order.created_at || order.createdAt;
  const createdAt = createdAtRaw ? new Date(createdAtRaw) : null;
  const deliveryAddressRaw = order.delivery_address || order.address || (order as any).deliveryAddress || '';
  const [deliveryAddress, setDeliveryAddress] = React.useState<string>(deliveryAddressRaw);
  const [fullOrder, setFullOrder] = React.useState<any>(order);

  // Additional delivery fields
  const deliveryCity = (order as any).delivery_city || '';
  const deliveryPostalCode = (order as any).delivery_postal_code || '';
  const deliveryFloor = (order as any).delivery_floor || '';
  const deliveryNotes = (order as any).delivery_notes || '';
  const nameOnRinger = (order as any).name_on_ringer || '';

  // Log payment method for debugging
  console.log('[OrderApprovalPanel] order.payment_method:', (order as any).payment_method);
  console.log('[OrderApprovalPanel] order.paymentMethod:', (order as any).paymentMethod);
  console.log('[OrderApprovalPanel] full order object:', order);

  // Fetch full order details if items are missing
  // Requirements: 2.1, 2.5, 2.6
  React.useEffect(() => {
    const loadOrderItems = async () => {
      // Check if items are missing or empty using the parse function
      const currentItems = parseItemsFromJson(order.items || (order as any).order_items || (order as any).orderItems);

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
          setItemsLoadError('No items found');
        }
      } catch (e) {
        console.error('[OrderApprovalPanel] Failed to load order items:', e);
        setItemsLoadError('Failed to load items');
      } finally {
        setIsLoadingItems(false);
      }
    };

    loadOrderItems();
  }, [order.id]);

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
        setItemsLoadError('No items found');
      }
    } catch (e) {
      console.error('[OrderApprovalPanel] Retry failed:', e);
      setItemsLoadError('Failed to load items');
    } finally {
      setIsLoadingItems(false);
    }
  }, [order]);

  /**
   * Normalizes order items for display.
   * Extracts customizations/ingredients as sub-items with prices.
   * Requirements: 2.1, 2.2
   */
  const normalizedItems = useMemo(() => {
    // Use fullOrder which may have been fetched with complete data
    const orderToUse = fullOrder || order;

    // Parse items using the helper function
    const items = parseItemsFromJson(orderToUse.items || (orderToUse as any).order_items || (orderToUse as any).orderItems);

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
      let customizationsList: { name: string; price: number; isWithout?: boolean; categoryName?: string }[] = [];
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
        return c.ingredient?.category_name || c.category_name || c.categoryName || undefined;
      };

      // Helper to check if item is "without" (removed)
      const isWithoutItem = (c: any): boolean => {
        return c.isWithout === true || c.is_without === true || c.without === true;
      };

      if (rawCustomizations) {
        if (Array.isArray(rawCustomizations)) {
          customizationsList = rawCustomizations
            .filter((c: any) => c && (c.ingredient || c.name || c.name_en || c.customizationId))
            .map((c: any) => ({
              name: extractName(c),
              price: extractPrice(c),
              isWithout: isWithoutItem(c),
              categoryName: extractCategoryName(c)
            }));
        } else if (typeof rawCustomizations === 'object' && rawCustomizations !== null) {
          const values = Object.values(rawCustomizations);
          customizationsList = values
            .filter((c: any) => c && (c.ingredient || c.name || c.name_en || c.customizationId))
            .map((c: any) => ({
              name: extractName(c),
              price: extractPrice(c),
              isWithout: isWithoutItem(c),
              categoryName: extractCategoryName(c)
            }));
        }
      }

      // Get item price - prefer unit_price, then price
      const unitPrice = typeof item.unit_price === 'number' ? item.unit_price :
                        typeof item.price === 'number' ? item.price : 0;

      return {
        name: item.name || item.menu_item_name || item.menuItemName || item.title || item.product_name || 'Item',
        quantity: item.quantity || 1,
        price: unitPrice,
        total_price: item.total_price || item.totalPrice || (unitPrice * (item.quantity || 1)),
        special_instructions: item.special_instructions || item.notes || item.instructions || undefined,
        customizations: customizationsList,
        categoryName: item.categoryName || item.category_name || null // Main category (e.g., "Crepes")
      };
    });
  }, [fullOrder, order]);

  // Calculate subtotal from items using total_price values
  // Requirements: 2.3, 6.1, 6.3
  const subtotal = useMemo(() => {
    return calculateSubtotalFromItems(normalizedItems.map(item => ({
      total_price: item.total_price,
      unit_price: item.price,
      quantity: item.quantity
    })));
  }, [normalizedItems]);
  const taxAmount = (order as any).tax_amount || (order as any).taxAmount || 0;
  const deliveryFee = (order as any).delivery_fee || (order as any).deliveryFee || 0;
  const discountAmount = (order as any).discount_amount || (order as any).discountAmount || 0;
  const discountPercentage = (order as any).discount_percentage || (order as any).discountPercentage || 0;
  const totalAmount = (order as any).total_amount || order.totalAmount || subtotal;

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
    if (!declineReason.trim()) {
      toast.error(t('orderApprovalPanel.reasonRequired'));
      return;
    }
    setIsDeclining(true);
    try {
      await onDecline(order.id, declineReason);
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
      console.log('[OrderApprovalPanel] Calling bridge.payments.printReceipt with order ID:', order.id);
      const result = await bridge.payments.printReceipt(order.id);
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
  }, [bridge.payments, order.id, t]);


  const getOrderTypeLabel = (type: string) => {
    switch (type?.toLowerCase()) {
      case 'delivery': return t('orderDashboard.delivery', { defaultValue: 'Delivery' });
      case 'pickup': return t('orderDashboard.pickup', { defaultValue: 'Pickup' });
      case 'dine-in': return t('orderDashboard.dineIn', { defaultValue: 'Dine In' });
      default: return type;
    }
  };

  const getStatusColor = (status: string) => {
    switch (status?.toLowerCase()) {
      case 'pending': return 'bg-yellow-500/20 text-yellow-600 dark:text-yellow-400 border-yellow-500/30';
      case 'processing': return 'bg-blue-500/20 text-blue-600 dark:text-blue-400 border-blue-500/30';
      case 'completed': return 'bg-green-500/20 text-green-600 dark:text-green-400 border-green-500/30';
      case 'cancelled': return 'bg-red-500/20 text-red-600 dark:text-red-400 border-red-500/30';
      default: return 'bg-gray-500/20 text-gray-600 dark:text-gray-400 border-gray-500/30';
    }
  };

  return (
    <>
      {/* Backdrop */}
      <div
        className="liquid-glass-modal-backdrop fixed inset-0 z-[1000]"
        onClick={canClose ? onClose : undefined}
      />

      {/* Modal Container */}
      <div
        className="liquid-glass-modal-shell fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-2xl max-h-[90vh] z-[1050] flex flex-col"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`order-approval-title-${order.id}`}
        tabIndex={-1}
      >

        {/* Header */}
        <div className="flex-shrink-0 px-6 py-4 border-b liquid-glass-modal-border">
          <div className="flex justify-between items-start gap-4">
            <div className="flex-1">
              <h2
                id={`order-approval-title-${order.id}`}
                className="text-2xl font-bold liquid-glass-modal-text"
              >
                {t('orderApprovalPanel.orderNumber', { number: orderNumber, defaultValue: `Order #${orderNumber}` })}
              </h2>
              <div className="flex items-center gap-3 mt-2 flex-wrap">
                <span className="text-sm liquid-glass-modal-text-muted">
                  {createdAt ? `${formatDate(createdAt)} ${formatTime(createdAt, { hour: '2-digit', minute: '2-digit' })}` : ''}
                </span>
                <span className={`text-xs px-3 py-1 rounded-full border ${getStatusColor(order.status)}`}>
                  {t(`orders.status.${order.status}`, { defaultValue: (order.status || 'Pending') }).toUpperCase()}
                </span>
              </div>
            </div>
              {canClose ? (
                <button
                  onClick={onClose}
                  className="liquid-glass-modal-button p-2 min-h-0 min-w-0 shrink-0"
                  aria-label={t('common.actions.close')}
                >
                  <X className="w-6 h-6" />
                </button>
              ) : null}
          </div>
        </div>

        {/* Scrollable Content */}
        <div className="flex-1 overflow-y-auto overflow-x-hidden px-6 py-4 min-h-0">
          <div className="space-y-6">

            {/* Order Type Banner */}
            <div className="liquid-glass-modal-card">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="p-2 bg-blue-500/20 rounded-lg text-blue-600 dark:text-blue-400">
                    <Clock className="w-5 h-5" />
                  </div>
                  <div>
                    <h3 className="font-semibold liquid-glass-modal-text">
                      {getOrderTypeLabel(orderType)}
                    </h3>
                    <p className="text-sm liquid-glass-modal-text-muted">
                      {t(`orders.status.${order.status}`, { defaultValue: order.status || 'Pending' })}
                    </p>
                  </div>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {/* Left Column: Customer Info */}
              <div className="space-y-6">
                {/* Customer Card */}
                <div className="liquid-glass-modal-card">
                  <h4 className="flex items-center gap-2 text-sm font-bold uppercase tracking-wider liquid-glass-modal-text-muted mb-4">
                    <User className="w-4 h-4" />
                    {t('orderApprovalPanel.name', { defaultValue: 'Customer' })}
                  </h4>
                  <div className="space-y-3">
                    <div className="flex items-center gap-3">
                      <User className="w-10 h-10 text-purple-500" />
                      <div>
                        <div className="font-semibold liquid-glass-modal-text">
                          {customerName || t('orderApprovalPanel.guestCustomer', { defaultValue: 'Guest' })}
                        </div>
                        {customerPhone && (
                          <div className="text-sm liquid-glass-modal-text-muted">
                            {customerPhone}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                </div>

                {/* Delivery Address Card - Show only for delivery orders */}
                {orderType === 'delivery' && (deliveryAddress || deliveryCity) && (
                  <div className="liquid-glass-modal-card">
                    <h4 className="flex items-center gap-2 text-sm font-bold uppercase tracking-wider liquid-glass-modal-text-muted mb-4">
                      <MapPin className="w-4 h-4" />
                      {t('orderApprovalPanel.address', { defaultValue: 'Address' })}
                    </h4>
                    <div className="p-3 bg-white/5 dark:bg-black/20 rounded-lg border border-white/10 dark:border-white/5 space-y-3">
                      {/* Address Road */}
                      {deliveryAddress && (
                        <div className="flex flex-col">
                          <span className="text-xs uppercase tracking-wide liquid-glass-modal-text-muted mb-1">
                            {t('orderApprovalPanel.addressRoad', { defaultValue: 'Street' })}
                          </span>
                          <span className="font-medium liquid-glass-modal-text">
                            {deliveryAddress}
                          </span>
                        </div>
                      )}

                      {/* Postal Code */}
                      {deliveryPostalCode && (
                        <div className="flex flex-col">
                          <span className="text-xs uppercase tracking-wide liquid-glass-modal-text-muted mb-1">
                            {t('orderApprovalPanel.postalCode', { defaultValue: 'Postal Code' })}
                          </span>
                          <span className="font-medium liquid-glass-modal-text">
                            {deliveryPostalCode}
                          </span>
                        </div>
                      )}

                      {/* City */}
                      {deliveryCity && (
                        <div className="flex flex-col">
                          <span className="text-xs uppercase tracking-wide liquid-glass-modal-text-muted mb-1">
                            {t('orderApprovalPanel.city', { defaultValue: 'City' })}
                          </span>
                          <span className="font-medium liquid-glass-modal-text">
                            {deliveryCity}
                          </span>
                        </div>
                      )}

                      {/* Floor */}
                      {deliveryFloor && (
                        <div className="flex flex-col">
                          <span className="text-xs uppercase tracking-wide liquid-glass-modal-text-muted mb-1">
                            {t('orderApprovalPanel.floor', { defaultValue: 'Floor' })}
                          </span>
                          <span className="font-medium liquid-glass-modal-text">
                            {deliveryFloor}
                          </span>
                        </div>
                      )}

                      {/* Name on Ringer */}
                      {nameOnRinger && (
                        <div className="flex flex-col">
                          <span className="text-xs uppercase tracking-wide liquid-glass-modal-text-muted mb-1">
                            {t('orderApprovalPanel.nameOnRinger', { defaultValue: 'Name on bell' })}
                          </span>
                          <span className="font-medium liquid-glass-modal-text">
                            {nameOnRinger}
                          </span>
                        </div>
                      )}

                      {/* Delivery Notes */}
                      {deliveryNotes && (
                        <div className="flex flex-col pt-2 border-t border-white/10">
                          <span className="text-xs uppercase tracking-wide liquid-glass-modal-text-muted mb-1">
                            {t('orderApprovalPanel.deliveryNotes', { defaultValue: 'Notes' })}
                          </span>
                          <span className="liquid-glass-modal-text italic">
                            {deliveryNotes}
                          </span>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* Payment Method Card */}
                <div className="liquid-glass-modal-card">
                  <h4 className="flex items-center gap-2 text-sm font-bold uppercase tracking-wider liquid-glass-modal-text-muted mb-4">
                    <CreditCard className="w-4 h-4" />
                    {t('orderApprovalPanel.paymentMethod', { defaultValue: 'Payment' })}
                  </h4>
                  <div className="p-3 bg-white/5 dark:bg-black/20 rounded-lg border border-white/10 dark:border-white/5">
                    <div className="flex items-center justify-between">
                      {(() => {
                        const paymentMethod = (order as any).payment_method || (order as any).paymentMethod;
                        if (paymentMethod === 'card') {
                          return (
                            <>
                              <p className="font-medium liquid-glass-modal-text">
                                {t('modals.orderDetails.card', { defaultValue: 'Card' })}
                              </p>
                              <CreditCard className="w-5 h-5 text-blue-500" />
                            </>
                          );
                        } else if (paymentMethod === 'cash') {
                          return (
                            <>
                              <p className="font-medium liquid-glass-modal-text">
                                {t('modals.orderDetails.cash', { defaultValue: 'Cash' })}
                              </p>
                              <Banknote className="w-5 h-5 text-green-500" />
                            </>
                          );
                        } else if (paymentMethod) {
                          return (
                            <p className="font-medium liquid-glass-modal-text">
                              {paymentMethod.charAt(0).toUpperCase() + paymentMethod.slice(1)}
                            </p>
                          );
                        } else {
                          return (
                            <p className="font-medium liquid-glass-modal-text">
                              {t('modals.orderDetails.pending', { defaultValue: 'Pending' })}
                            </p>
                          );
                        }
                      })()}
                    </div>
                  </div>
                </div>
              </div>

              {/* Right Column: Order Items */}
              <div>
                <div className="liquid-glass-modal-card h-full flex flex-col">
                  <h4 className="flex items-center gap-2 text-sm font-bold uppercase tracking-wider liquid-glass-modal-text-muted mb-4">
                    <Package className="w-4 h-4" />
                    {t('orderApprovalPanel.orderItems', { defaultValue: 'Order Items' })}
                  </h4>

                  {isLoadingItems ? (
                    <div className="flex items-center justify-center py-12">
                      <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500"></div>
                    </div>
                  ) : normalizedItems.length > 0 ? (
                    <div className="flex-1 overflow-y-auto pr-2 space-y-3 custom-scrollbar">
                      {normalizedItems.map((item: { name: string; quantity: number; price: number; total_price: number; special_instructions?: string; customizations?: any[]; categoryName?: string | null }, idx: number) => (
                        <div
                          key={idx}
                          className="flex items-start justify-between p-3 bg-white/5 dark:bg-white/5 rounded-lg border border-white/10 hover:bg-white/10 transition-colors"
                        >
                          <div className="flex items-start gap-3 flex-1">
                            <div className="w-8 h-8 rounded-md bg-orange-500/20 text-orange-400 flex items-center justify-center font-bold text-sm border border-orange-500/20 flex-shrink-0">
                              {item.quantity}x
                            </div>
                            <div className="flex-1">
                              {/* Category label */}
                              {item.categoryName && (
                                <div className="text-[10px] uppercase tracking-wider font-medium mb-0.5 liquid-glass-modal-text-muted">
                                  {item.categoryName}
                                </div>
                              )}
                              {/* Item name (subcategory) */}
                              <div className="font-medium liquid-glass-modal-text">
                                {item.name}
                              </div>
                              {item.special_instructions && (
                                <div className="text-xs liquid-glass-modal-text-muted mt-1 italic">
                                  📝 {item.special_instructions}
                                </div>
                              )}
                              {item.customizations && item.customizations.length > 0 && (
                                <div className="mt-2 space-y-1">
                                  {/* Added ingredients */}
                                  {item.customizations.filter((c: any) => !c.isWithout).map((c: { name: string; price: number }, i: number) => (
                                    <div key={`add-${i}`} className="flex justify-between text-xs liquid-glass-modal-text-muted">
                                      <span>+ {c.name}</span>
                                      {c.price > 0 && (
                                        <span>{formatCurrency(c.price)}</span>
                                      )}
                                    </div>
                                  ))}
                                  {/* Without ingredients */}
                                  {item.customizations.filter((c: any) => c.isWithout).length > 0 && (
                                    <div className="mt-1 pt-1 border-t border-red-500/20">
                                      {item.customizations.filter((c: any) => c.isWithout).map((c: { name: string }, i: number) => (
                                        <div key={`without-${i}`} className="flex justify-between text-xs text-red-400">
                                          <span className="line-through inline-flex items-center gap-1">
                                            <Ban className="w-3 h-3" />
                                            {c.name}
                                          </span>
                                        </div>
                                      ))}
                                    </div>
                                  )}
                                </div>
                              )}
                            </div>
                          </div>
                          <div className="font-semibold liquid-glass-modal-text ml-3 flex-shrink-0">
                            {formatCurrency(item.total_price)}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="text-center py-8 liquid-glass-modal-text-muted">
                      <p className="mb-3">{itemsLoadError || t('orderApprovalPanel.noItems', { defaultValue: 'No items found' })}</p>
                      <button
                        onClick={handleRetryLoadItems}
                        disabled={isLoadingItems}
                        className="liquid-glass-modal-button"
                      >
                        {t('orderApprovalPanel.retryLoadItems', { defaultValue: 'Try again' })}
                      </button>
                    </div>
                  )}

                  {/* Totals Section */}
                  <div className="mt-6 pt-6 border-t border-gray-200/50 dark:border-gray-700/50 space-y-2">
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
                      <div className="flex justify-between text-sm liquid-glass-modal-text-muted pb-2">
                        <span>{t('orderApprovalPanel.deliveryFee', { defaultValue: 'Delivery fee' })}</span>
                        <span>{formatCurrency(deliveryFee)}</span>
                      </div>
                    )}
                    {discountAmount > 0 && (
                      <div className="flex justify-between text-sm text-green-500 font-medium">
                        <span>
                          <span className="inline-flex items-center gap-2"><Tag className="w-4 h-4" aria-hidden="true" />{t('orderApprovalPanel.discount', { defaultValue: 'Discount' })}</span>
                          {discountPercentage > 0 && ` (${discountPercentage}%)`}
                        </span>
                        <span>-{formatCurrency(discountAmount)}</span>
                      </div>
                    )}
                    <div className="flex justify-between items-end pt-2 border-t border-dashed border-gray-300 dark:border-gray-600">
                      <span className="font-bold text-lg liquid-glass-modal-text">
                        {t('orderApprovalPanel.totalAmount', { defaultValue: 'Total' })}
                      </span>
                      <span className="font-bold text-2xl text-blue-600 dark:text-blue-400">
                        {formatCurrency(totalAmount)}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Estimated Time - Only for approval mode */}
            {!viewOnly && (
              <div className="liquid-glass-modal-card">
                <h4 className="flex items-center gap-2 text-sm font-bold uppercase tracking-wider liquid-glass-modal-text-muted mb-4">
                  <Clock className="w-4 h-4" />
                  {t('orderApprovalPanel.estimatedTime', { defaultValue: 'Estimated prep time' })}
                </h4>
                <div className="grid grid-cols-6 gap-2">
                  {ESTIMATED_TIME_OPTIONS.map((time) => (
                    <button
                      key={time}
                      onClick={() => setEstimatedTime(time)}
                      className={`py-2 px-3 rounded-lg font-medium transition ${
                        estimatedTime === time
                          ? 'bg-blue-500 text-white'
                          : 'liquid-glass-modal-button'
                      }`}
                    >
                      {time}{t('common.units.minutesShort', { defaultValue: 'm' })}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Decline Reason - Only shown when declining */}
            {!viewOnly && showDeclineModal && (
              <div className="liquid-glass-modal-card bg-red-500/10 border-red-500/30">
                <h4 className="flex items-center gap-2 text-sm font-bold uppercase tracking-wider text-red-600 dark:text-red-400 mb-4">
                  <XCircle className="w-4 h-4" />
                  {t('orderApprovalPanel.declineReason', { defaultValue: 'Decline reason' })}
                </h4>
                <textarea
                  value={declineReason}
                  onChange={(e) => setDeclineReason(e.target.value)}
                  placeholder={t('orderApprovalPanel.declinePlaceholder', { defaultValue: 'Enter a reason...' })}
                  className="w-full p-3 rounded-lg liquid-glass-modal-card border liquid-glass-modal-border focus:ring-2 focus:ring-red-500 transition-all resize-none text-sm liquid-glass-modal-text placeholder:liquid-glass-modal-text-muted"
                  rows={3}
                />
              </div>
            )}
          </div>
        </div>

        {/* Footer with Actions */}
        <div className="flex-shrink-0 px-6 py-4 border-t liquid-glass-modal-border bg-white/5 dark:bg-black/20">
          {!viewOnly ? (
            <div className="flex gap-3">
              {!showDeclineModal ? (
                <>
                  <button
                    onClick={handleApprove}
                    disabled={isApproving}
                    className="flex-1 liquid-glass-modal-button bg-green-600/20 hover:bg-green-600/30 text-green-400 border-green-500/30 gap-2"
                  >
                    <Check className="w-4 h-4" />
                    {isApproving ? (t('orderApprovalPanel.approving', { defaultValue: 'Approving...' })) : (t('orderApprovalPanel.approveButton', { defaultValue: 'Approve' }))}
                  </button>
                  <button
                    onClick={() => setShowDeclineModal(true)}
                    className="flex-1 liquid-glass-modal-button bg-red-600/20 hover:bg-red-600/30 text-red-400 border-red-500/30 gap-2"
                  >
                    <XCircle className="w-4 h-4" />
                    {t('orderApprovalPanel.declineButton', { defaultValue: 'Decline' })}
                  </button>
                </>
              ) : (
                <>
                  <button
                    onClick={handleDecline}
                    disabled={isDeclining}
                    className="flex-1 liquid-glass-modal-button bg-red-600/20 hover:bg-red-600/30 text-red-400 border-red-500/30"
                  >
                    {isDeclining ? (t('orderApprovalPanel.declining', { defaultValue: 'Declining...' })) : (t('orderApprovalPanel.confirmDecline', { defaultValue: 'Confirm' }))}
                  </button>
                  <button
                    onClick={() => setShowDeclineModal(false)}
                    className="liquid-glass-modal-button"
                  >
                    {t('common.actions.cancel', { defaultValue: 'Cancel' })}
                  </button>
                </>
              )}
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              <button
                onClick={handlePrint}
                disabled={isPrinting}
                className="liquid-glass-modal-button w-full gap-2"
              >
                <Printer className="w-4 h-4" />
                {isPrinting ? (t('orderApprovalPanel.printing', { defaultValue: 'Printing...' })) : (t('orderApprovalPanel.printReceipt', { defaultValue: 'Print receipt' }))}
              </button>
              <button
                onClick={onClose}
                className="liquid-glass-modal-button w-full gap-2 bg-blue-600/20 hover:bg-blue-600/30 text-blue-400 border-blue-500/30"
              >
                {t('common.actions.close', { defaultValue: 'Close' })}
              </button>
            </div>
          )}
        </div>

      </div>
    </>
  );
}
