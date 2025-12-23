import React, { useState, useCallback, useMemo } from 'react';
import { useTheme } from '../../contexts/theme-context';
import { useI18n } from '../../contexts/i18n-context';
import toast from 'react-hot-toast';
import type { Order, OrderItem } from '../../types/orders';

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
  
  const api: any = (window as any).electronAPI;
  if (!api?.invoke) {
    console.log('[OrderApprovalPanel] electronAPI not available');
    return [];
  }
  
  // 2. Fetch from local DB by order ID
  try {
    console.log('[OrderApprovalPanel] Fetching from local DB for order:', order.id);
    const response = await api.invoke('order:get-by-id', { orderId: order.id });
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
    
    const response = await api.invoke('order:fetch-items-from-supabase', { orderId: supabaseId });
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
  const { t } = useI18n();
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === 'dark';
  const [estimatedTime, setEstimatedTime] = useState(30);
  const [isApproving, setIsApproving] = useState(false);
  const [isDeclining, setIsDeclining] = useState(false);
  const [showDeclineModal, setShowDeclineModal] = useState(false);
  const [declineReason, setDeclineReason] = useState('');
  const [isPrinting, setIsPrinting] = useState(false);
  const [isLoadingItems, setIsLoadingItems] = useState(false);
  const [itemsLoadError, setItemsLoadError] = useState<string | null>(null);

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
        const api: any = (window as any).electronAPI;
        const customer = await api?.customerLookupByPhone?.(String(phone));
        if (!customer) return;
        const addr = Array.isArray(customer.addresses) && customer.addresses.length > 0
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
    
    return items.map((item: any) => {
      // Extract customizations/ingredients - handle both array and object formats
      // Requirements: 2.2 - Display customizations as sub-items with prices
      let customizationsList: { name: string; price: number }[] = [];
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
      
      if (rawCustomizations) {
        if (Array.isArray(rawCustomizations)) {
          customizationsList = rawCustomizations
            .filter((c: any) => c && (c.ingredient || c.name || c.name_en || c.customizationId))
            .map((c: any) => ({
              name: extractName(c),
              price: extractPrice(c)
            }));
        } else if (typeof rawCustomizations === 'object' && rawCustomizations !== null) {
          const values = Object.values(rawCustomizations);
          customizationsList = values
            .filter((c: any) => c && (c.ingredient || c.name || c.name_en || c.customizationId))
            .map((c: any) => ({
              name: extractName(c),
              price: extractPrice(c)
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
        customizations: customizationsList
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
      const api: any = (window as any).electronAPI;
      console.log('[OrderApprovalPanel] electronAPI available:', !!api);
      console.log('[OrderApprovalPanel] printReceipt available:', !!api?.printReceipt);

      if (api?.printReceipt) {
        console.log('[OrderApprovalPanel] Calling printReceipt with order ID:', order.id);
        const result = await api.printReceipt(order.id);
        console.log('[OrderApprovalPanel] printReceipt result:', result);
        toast.success(t('orderApprovalPanel.printSuccess') || 'Receipt printed successfully');
      } else if (api?.printOrder) {
        console.log('[OrderApprovalPanel] Using printOrder fallback');
        await api.printOrder(order.id);
        toast.success(t('orderApprovalPanel.printSuccess') || 'Receipt printed successfully');
      } else {
        console.log('[OrderApprovalPanel] No print API available, using window.print()');
        // Fallback to browser print
        window.print();
      }
    } catch (error) {
      console.error('[OrderApprovalPanel] Print error:', error);
      toast.error(t('orderApprovalPanel.printFailed') || 'Failed to print receipt');
    } finally {
      setIsPrinting(false);
    }
  }, [order.id, t]);

  return (
    <div
      className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      <div
        className={`${
          isDark
            ? 'bg-gray-900 border-gray-700'
            : 'bg-white border-gray-200'
        } border rounded-2xl shadow-2xl max-w-2xl w-full max-h-[90vh] overflow-hidden flex flex-col`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          className={`${
            isDark
              ? 'bg-gradient-to-r from-blue-800 to-blue-700'
              : 'bg-gradient-to-r from-blue-500 to-blue-600'
          } p-5 text-white flex-shrink-0`}
        >
          <div className="flex justify-between items-center">
            <div>
              <h2 className="text-xl font-bold">
                {t('orderApprovalPanel.orderNumber', { number: orderNumber }) || `Order #${orderNumber}`}
              </h2>
              <p className={`text-sm mt-1 ${isDark ? 'text-blue-200' : 'text-blue-100'}`}>
                {createdAt ? createdAt.toLocaleString() : ''}
              </p>
            </div>
            <button
              onClick={onClose}
              className="text-white hover:bg-white/20 p-2 rounded-full transition w-10 h-10 flex items-center justify-center"
              aria-label={t('common.actions.close')}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        {/* Scrollable Content */}
        <div className={`flex-1 overflow-y-auto p-5 space-y-4 ${isDark ? 'text-white' : 'text-gray-900'}`}>
          
          {/* Customer & Order Info - Compact */}
          <div className={`${isDark ? 'bg-gray-800/50' : 'bg-gray-50'} rounded-xl p-4`}>
            <div className="grid grid-cols-2 gap-3 text-sm">
              {customerName && (
                <div>
                  <span className={`${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                    {t('orderApprovalPanel.name') || 'Customer'}
                  </span>
                  <p className="font-semibold">{customerName}</p>
                </div>
              )}
              {customerPhone && (
                <div>
                  <span className={`${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                    {t('orderApprovalPanel.phone') || 'Phone'}
                  </span>
                  <p className="font-semibold">{customerPhone}</p>
                </div>
              )}
              <div>
                <span className={`${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                  {t('orderApprovalPanel.orderType') || 'Type'}
                </span>
                <p className="font-semibold capitalize">{orderType || 'N/A'}</p>
              </div>
              <div>
                <span className={`${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                  {t('orderApprovalPanel.status') || 'Status'}
                </span>
                <p className="font-semibold capitalize">{order.status || 'pending'}</p>
              </div>
            </div>
            {orderType === 'delivery' && deliveryAddress && (
              <div className={`mt-3 pt-3 border-t ${isDark ? 'border-gray-700' : 'border-gray-200'}`}>
                <span className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                  {t('orderApprovalPanel.address') || 'Delivery Address'}
                </span>
                <p className="font-semibold">{deliveryAddress}</p>
              </div>
            )}
          </div>

          {/* Order Items - Cart Style */}
          <div>
            <h3 className={`font-semibold mb-3 ${isDark ? 'text-gray-200' : 'text-gray-700'}`}>
              {t('orderApprovalPanel.orderItems') || 'Order Items'}
            </h3>
            <div className={`${isDark ? 'bg-gray-800/50' : 'bg-gray-50'} rounded-xl overflow-hidden`}>
              {/* Loading state */}
              {isLoadingItems ? (
                <div className={`p-6 text-center ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                  <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500 mx-auto mb-2"></div>
                  <p>{t('orderApprovalPanel.loadingItems') || 'Loading items...'}</p>
                </div>
              ) : normalizedItems.length > 0 ? (
                <div className={`divide-y ${isDark ? 'divide-gray-700' : 'divide-gray-200'}`}>
                  {normalizedItems.map((item: { name: string; quantity: number; price: number; total_price: number; special_instructions?: string; customizations?: any[] }, idx: number) => (
                    <div key={idx} className="p-4">
                      <div className="flex justify-between items-start">
                        <div className="flex-1">
                          <div className="flex items-center gap-3">
                            {/* Quantity Badge */}
                            <span className={`${isDark ? 'bg-blue-600' : 'bg-blue-500'} text-white text-sm font-bold px-2.5 py-1 rounded-lg min-w-[32px] text-center`}>
                              {item.quantity}x
                            </span>
                            {/* Item Name */}
                            <span className="font-medium text-base">{item.name}</span>
                          </div>
                          {/* Special Instructions */}
                          {item.special_instructions && (
                            <p className={`text-sm mt-2 ml-11 ${isDark ? 'text-yellow-400' : 'text-yellow-600'}`}>
                              📝 {item.special_instructions}
                            </p>
                          )}
                          {/* Customizations/Ingredients - Requirements: 2.2 */}
                          {item.customizations && item.customizations.length > 0 && (
                            <div className={`mt-2 ml-11 space-y-1`}>
                              {item.customizations.map((c: { name: string; price: number }, i: number) => (
                                <div key={i} className={`flex justify-between text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                                  <span>+ {c.name}</span>
                                  {c.price > 0 ? (
                                    <span className={`${isDark ? 'text-gray-500' : 'text-gray-400'}`}>+€{c.price.toFixed(2)}</span>
                                  ) : null}
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                        {/* Price - Use total_price which includes customizations */}
                        <div className="text-right ml-4">
                          <span className="font-bold text-base">€{item.total_price.toFixed(2)}</span>
                          {item.quantity > 1 && (
                            <p className={`text-xs ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                              €{item.price.toFixed(2)} each
                            </p>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                /* No items found - show retry button (Requirements: 2.5) */
                <div className={`p-6 text-center ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                  <p className="mb-3">{itemsLoadError || t('orderApprovalPanel.noItems') || 'No items in this order'}</p>
                  <button
                    onClick={handleRetryLoadItems}
                    disabled={isLoadingItems}
                    className={`px-4 py-2 rounded-lg text-sm font-medium transition ${
                      isDark
                        ? 'bg-blue-600 hover:bg-blue-700 text-white'
                        : 'bg-blue-500 hover:bg-blue-600 text-white'
                    } disabled:opacity-50`}
                  >
                    {t('orderApprovalPanel.retryLoadItems') || 'Retry'}
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* Special Instructions */}
          {order.special_instructions && (
            <div className={`${isDark ? 'bg-yellow-900/30 border-yellow-700/50' : 'bg-yellow-50 border-yellow-200'} border rounded-xl p-4`}>
              <p className={`text-sm font-semibold mb-1 ${isDark ? 'text-yellow-400' : 'text-yellow-700'}`}>
                {t('orderApprovalPanel.specialInstructions') || 'Special Instructions'}
              </p>
              <p className={`text-sm ${isDark ? 'text-yellow-200' : 'text-yellow-800'}`}>{order.special_instructions}</p>
            </div>
          )}

          {/* Order Summary - Cart Style */}
          <div className={`${isDark ? 'bg-gray-800/50' : 'bg-gray-50'} rounded-xl p-4 space-y-2`}>
            <div className={`flex justify-between text-sm ${isDark ? 'text-gray-300' : 'text-gray-600'}`}>
              <span>{t('orderApprovalPanel.subtotal') || 'Subtotal'}</span>
              <span>€{subtotal.toFixed(2)}</span>
            </div>
            {taxAmount > 0 && (
              <div className={`flex justify-between text-sm ${isDark ? 'text-gray-300' : 'text-gray-600'}`}>
                <span>{t('orderApprovalPanel.tax') || 'Tax'}</span>
                <span>€{taxAmount.toFixed(2)}</span>
              </div>
            )}
            {deliveryFee > 0 && (
              <div className={`flex justify-between text-sm ${isDark ? 'text-gray-300' : 'text-gray-600'}`}>
                <span>{t('orderApprovalPanel.deliveryFee') || 'Delivery Fee'}</span>
                <span>€{deliveryFee.toFixed(2)}</span>
              </div>
            )}
            {discountAmount > 0 && (
              <div className={`flex justify-between text-sm text-green-500`}>
                <span>{t('orderApprovalPanel.discount') || 'Discount'}</span>
                <span>-€{discountAmount.toFixed(2)}</span>
              </div>
            )}
            <div className={`flex justify-between text-lg font-bold pt-2 border-t ${isDark ? 'border-gray-700' : 'border-gray-300'}`}>
              <span>{t('orderApprovalPanel.totalAmount') || 'Total'}</span>
              <span className="text-green-500">€{totalAmount.toFixed(2)}</span>
            </div>
          </div>

          {/* Estimated Time - Only for approval */}
          {!viewOnly && (
            <div>
              <label className={`block text-sm font-semibold mb-2 ${isDark ? 'text-gray-200' : 'text-gray-700'}`}>
                {t('orderApprovalPanel.estimatedTime') || 'Estimated Preparation Time'}
              </label>
              <div className="grid grid-cols-6 gap-2">
                {ESTIMATED_TIME_OPTIONS.map((time) => (
                  <button
                    key={time}
                    onClick={() => setEstimatedTime(time)}
                    className={`py-2 px-3 rounded-lg font-medium transition ${
                      estimatedTime === time
                        ? 'bg-blue-500 text-white'
                        : isDark
                          ? 'bg-gray-800 text-gray-300 hover:bg-gray-700'
                          : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                    }`}
                  >
                    {time}m
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Decline Reason Modal */}
          {!viewOnly && showDeclineModal && (
            <div className={`${isDark ? 'bg-red-900/30 border-red-700/50' : 'bg-red-50 border-red-200'} border rounded-xl p-4`}>
              <label className={`block text-sm font-semibold mb-2 ${isDark ? 'text-red-400' : 'text-red-700'}`}>
                {t('orderApprovalPanel.declineReason') || 'Reason for declining'}
              </label>
              <textarea
                value={declineReason}
                onChange={(e) => setDeclineReason(e.target.value)}
                placeholder={t('orderApprovalPanel.declinePlaceholder') || 'Enter reason...'}
                className={`w-full px-4 py-2 rounded-lg border ${
                  isDark
                    ? 'bg-gray-800 border-gray-700 text-white placeholder-gray-500'
                    : 'bg-white border-gray-300 placeholder-gray-400'
                } focus:outline-none focus:ring-2 focus:ring-red-500`}
                rows={3}
              />
            </div>
          )}
        </div>

        {/* Footer Actions */}
        <div className={`p-4 border-t ${isDark ? 'border-gray-700 bg-gray-800/50' : 'border-gray-200 bg-gray-50'} flex-shrink-0`}>
          {!viewOnly ? (
            <div className="flex gap-3">
              <button
                onClick={handleApprove}
                disabled={isApproving}
                className="flex-1 bg-green-500 hover:bg-green-600 disabled:bg-gray-500 text-white font-semibold py-3 rounded-xl transition active:scale-95"
              >
                {isApproving ? t('orderApprovalPanel.approving') : t('orderApprovalPanel.approveButton') || 'Approve'}
              </button>
              {!showDeclineModal ? (
                <button
                  onClick={() => setShowDeclineModal(true)}
                  className="flex-1 bg-red-500 hover:bg-red-600 text-white font-semibold py-3 rounded-xl transition active:scale-95"
                >
                  {t('orderApprovalPanel.declineButton') || 'Decline'}
                </button>
              ) : (
                <>
                  <button
                    onClick={handleDecline}
                    disabled={isDeclining}
                    className="flex-1 bg-red-500 hover:bg-red-600 disabled:bg-gray-500 text-white font-semibold py-3 rounded-xl transition active:scale-95"
                  >
                    {isDeclining ? t('orderApprovalPanel.declining') : t('orderApprovalPanel.confirmDecline') || 'Confirm'}
                  </button>
                  <button
                    onClick={() => setShowDeclineModal(false)}
                    className={`px-4 py-3 rounded-xl font-semibold transition active:scale-95 ${
                      isDark ? 'bg-gray-700 hover:bg-gray-600 text-white' : 'bg-gray-200 hover:bg-gray-300 text-gray-700'
                    }`}
                  >
                    {t('common.actions.cancel') || 'Cancel'}
                  </button>
                </>
              )}
            </div>
          ) : (
            <div className="flex gap-3">
              {/* Print Button */}
              <button
                onClick={handlePrint}
                disabled={isPrinting}
                className={`flex-1 flex items-center justify-center gap-2 py-3 rounded-xl font-semibold transition active:scale-95 ${
                  isDark
                    ? 'bg-blue-600 hover:bg-blue-700 text-white'
                    : 'bg-blue-500 hover:bg-blue-600 text-white'
                } disabled:opacity-50`}
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polyline points="6 9 6 2 18 2 18 9" />
                  <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
                  <rect x="6" y="14" width="12" height="8" />
                </svg>
                {isPrinting ? (t('orderApprovalPanel.printing') || 'Printing...') : (t('orderApprovalPanel.printReceipt') || 'Print Receipt')}
              </button>
              {/* Close Button */}
              <button
                onClick={onClose}
                className={`flex-1 py-3 rounded-xl font-semibold transition active:scale-95 ${
                  isDark
                    ? 'bg-gray-700 hover:bg-gray-600 text-white'
                    : 'bg-gray-200 hover:bg-gray-300 text-gray-700'
                }`}
              >
                {t('common.actions.close') || 'Close'}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
