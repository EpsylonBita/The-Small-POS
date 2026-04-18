import React, { useState, useEffect, useMemo } from "react";
import { useTranslation } from 'react-i18next';
import { useTheme } from '../../contexts/theme-context';
import { LiquidGlassModal } from '../ui/pos-glass-components';
import { Package, MapPin, User, Clock, CreditCard, ChevronRight, X, Printer, Truck, Phone, Building, FileText, History, Banknote, Smartphone, Bell, Layers, Car, CheckCircle, RotateCcw, Split } from 'lucide-react';
import { toast } from 'react-hot-toast';
import { getOrderStatusBadgeClasses } from '../../utils/orderStatus';
import { getVisibleOrderNumber } from '../../utils/orderNumberUtils';
import { formatCurrency, formatDate, formatTime } from '../../utils/format';
import { normalizeOrderTypeForDisplay, resolveOrderDisplayTitle } from '../../utils/orderDisplay';
import RefundVoidModal from './RefundVoidModal';
import { SplitPaymentModal } from './SplitPaymentModal';
import type { SplitPaymentResult } from './SplitPaymentModal';
import { getBridge } from '../../../lib';
import { buildSplitPaymentItems } from '../../utils/splitPaymentItems';

interface OrderDetailsModalProps {
  isOpen: boolean;
  orderId: string;
  order?: any;
  onClose: () => void;
  onPrintReceipt?: () => void;
  onShowCustomerHistory?: (customerPhone: string) => void;
}

function isCompletedPaymentRecord(payment: any): boolean {
  const status = String(payment?.status || '').toLowerCase();
  return status === 'completed' || status === 'paid';
}

function unwrapBridgeArray<T>(result: any): T[] {
  if (Array.isArray(result)) {
    return result;
  }

  if (Array.isArray(result?.data)) {
    return result.data;
  }

  return [];
}

const OrderDetailsModal: React.FC<OrderDetailsModalProps> = ({
  isOpen,
  orderId,
  order,
  onClose,
  onPrintReceipt,
}) => {
  const bridge = getBridge();
  const { t } = useTranslation();
  const { resolvedTheme } = useTheme();
  const [orderData, setOrderData] = useState<any>(null);
  const [orderPayments, setOrderPayments] = useState<any[]>([]);
  const [paidItems, setPaidItems] = useState<any[]>([]);
  const [customerOrders, setCustomerOrders] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [showRefundModal, setShowRefundModal] = useState(false);
  const [showSplitPaymentModal, setShowSplitPaymentModal] = useState(false);

  useEffect(() => {
    if (!isOpen) {
      setOrderData(null);
      setOrderPayments([]);
      setPaidItems([]);
      setCustomerOrders([]);
      setLoading(false);
      setHistoryLoading(false);
      return;
    }

    if (order) {
      setOrderData(order);
      const seedPhone = order.customer_phone || order.customerPhone || order.customer?.phone || '';
      if (seedPhone) {
        void loadCustomerHistory(seedPhone);
      } else {
        setCustomerOrders([]);
      }
    }

    if (orderId) {
      void loadOrderData(orderId);
    }
  }, [isOpen, orderId, order]);

  const loadOrderData = async (targetOrderId = orderId) => {
    if (!targetOrderId) {
      return;
    }

    try {
      setLoading(true);
      const result: any = await bridge.orders.getById(targetOrderId);
      const hydratedOrder = result?.order ?? result?.data ?? result;
      if (hydratedOrder) {
        setOrderData(hydratedOrder);
        const hydratedPhone =
          hydratedOrder.customer_phone ||
          hydratedOrder.customerPhone ||
          hydratedOrder.customer?.phone ||
          '';
        if (hydratedPhone) {
          void loadCustomerHistory(hydratedPhone);
        } else {
          setCustomerOrders([]);
        }
      }
    } catch (error) {
      console.error('Error loading order:', error);
      toast.error(t('errors.loadOrderFailed') || 'Failed to load order');
    } finally {
      setLoading(false);
    }
  };

  const loadPaymentState = async () => {
    if (!orderId) {
      setOrderPayments([]);
      setPaidItems([]);
      return;
    }

    try {
      const [paymentsResult, paidItemsResult] = await Promise.all([
        bridge.payments.getOrderPayments(orderId),
        bridge.payments.getPaidItems(orderId),
      ]);

      setOrderPayments(unwrapBridgeArray<any>(paymentsResult));
      setPaidItems(unwrapBridgeArray<any>(paidItemsResult));
    } catch (error) {
      console.error('Error loading order payment state:', error);
      setOrderPayments([]);
      setPaidItems([]);
    }
  };

  const loadCustomerHistory = async (phone: string) => {
    const normalizedPhone = String(phone || '').replace(/\D+/g, '');
    if (!normalizedPhone) {
      setCustomerOrders([]);
      return;
    }

    try {
      setHistoryLoading(true);
      const result = await bridge.orders.getByCustomerPhone(phone);
      if (result?.success && Array.isArray(result.orders)) {
        setCustomerOrders(result.orders);
      } else if (Array.isArray(result)) {
        setCustomerOrders(result);
      } else if (Array.isArray(result?.data)) {
        setCustomerOrders(result.data);
      } else {
        setCustomerOrders([]);
      }
    } catch (error) {
      console.error('Error loading customer order history:', error);
      setCustomerOrders([]);
    } finally {
      setHistoryLoading(false);
    }
  };

  useEffect(() => {
    if (!isOpen || !orderId) {
      return;
    }

    void loadPaymentState();
  }, [isOpen, orderId]);

  const getStatusColor = (status: string) => getOrderStatusBadgeClasses(status);

  const getOrderTypeLabel = (type: string) => {
    switch (type?.toLowerCase()) {
      case 'delivery': return t('orderDashboard.delivery', { defaultValue: 'Delivery' });
      case 'pickup': return t('orderDashboard.pickup', { defaultValue: 'Pickup' });
      case 'dine-in': return t('orderDashboard.dineIn', { defaultValue: 'Dine In' });
      default: return type;
    }
  };

  const getPaymentMethodLabel = (method: string) => {
    switch (method?.toLowerCase()) {
      case 'card': return t('modals.orderDetails.card', { defaultValue: 'Card' });
      case 'cash': return t('modals.orderDetails.cash', { defaultValue: 'Cash' });
      case 'split':
      case 'mixed': return t('payment.split.title', { defaultValue: 'Split Payment' });
      case 'digital':
      case 'digital_wallet': return t('modals.orderDetails.digital', { defaultValue: 'Digital' });
      default: return method || t('modals.orderDetails.pending', { defaultValue: 'Pending' });
    }
  };

  const getPaymentMethodIcon = (method: string): React.ReactNode => {
    switch (method?.toLowerCase()) {
      case 'card': return <CreditCard className="h-5 w-5 text-blue-400" />;
      case 'cash': return <Banknote className="h-5 w-5 text-green-400" />;
      case 'split':
      case 'mixed': return <Split className="h-5 w-5 text-purple-400" />;
      case 'digital':
      case 'digital_wallet': return <Smartphone className="h-5 w-5 text-purple-400" />;
      default: return <Clock className="h-5 w-5 text-gray-400" />;
    }
  };

  // Use real data or fallback to default values
  const displayOrder = orderData || order || {};
  const items = displayOrder.items || displayOrder.order_items || [];
  const customer = displayOrder.customer || {};
  const orderType = normalizeOrderTypeForDisplay(
    displayOrder.order_type || displayOrder.orderType || 'delivery',
  );

  // Get customer info from various sources (snake_case from prop, camelCase from Rust backend)
  const customerName = resolveOrderDisplayTitle({
    orderType,
    customerName: customer.name || displayOrder.customer_name || displayOrder.customerName || '',
    pickupLabel: t('orders.type.pickup', { defaultValue: 'Pickup' }),
    fallbackLabel: t('modals.orderDetails.guestCustomer', { defaultValue: 'Guest' }),
  });
  const customerPhone = customer.phone || displayOrder.customer_phone || displayOrder.customerPhone || '';
  const customerEmail = customer.email || displayOrder.customer_email || displayOrder.customerEmail || '';
  const normalizedCustomerPhone = String(customerPhone || '').replace(/\D+/g, '');

  const normalizeText = (value: any): string => typeof value === 'string' ? value.trim() : '';
  const rawAddress = displayOrder.delivery_address || displayOrder.deliveryAddress;
  const rawAddressText = normalizeText(
    typeof rawAddress === 'string'
      ? rawAddress
      : (rawAddress?.address || rawAddress?.street_address || rawAddress?.street || '')
  );
  const deliveryAddress = {
    address: rawAddressText,
    city: normalizeText(displayOrder.delivery_city || displayOrder.deliveryCity || rawAddress?.city || ''),
    postal_code: normalizeText(
      displayOrder.delivery_postal_code || displayOrder.deliveryPostalCode || rawAddress?.postal_code || '',
    ),
    floor: normalizeText(
      displayOrder.delivery_floor ||
        displayOrder.deliveryFloor ||
        rawAddress?.floor ||
        rawAddress?.floor_number ||
        '',
    ),
    notes: normalizeText(displayOrder.delivery_notes || displayOrder.deliveryNotes || rawAddress?.notes || ''),
    name_on_ringer: normalizeText(
      displayOrder.name_on_ringer || displayOrder.nameOnRinger || rawAddress?.name_on_ringer || '',
    ),
  };
  const hasDeliveryAddress = Object.values(deliveryAddress).some((value) => Boolean(value));

  const currentOrderKeys = new Set(
    [
      orderId,
      displayOrder.id,
      displayOrder.order_number,
      displayOrder.orderNumber,
      displayOrder.client_order_id,
      displayOrder.clientOrderId,
      displayOrder.supabase_id,
      displayOrder.supabaseId,
    ]
      .map((value) => String(value || '').trim().toLowerCase())
      .filter(Boolean),
  );
  const orderMatchesCurrent = (candidate: any) => {
    const candidateKeys = [
      candidate?.id,
      candidate?.orderId,
      candidate?.order_id,
      candidate?.order_number,
      candidate?.orderNumber,
      candidate?.client_order_id,
      candidate?.clientOrderId,
      candidate?.supabase_id,
      candidate?.supabaseId,
    ]
      .map((value) => String(value || '').trim().toLowerCase())
      .filter(Boolean);
    return candidateKeys.some((value) => currentOrderKeys.has(value));
  };
  const sortedCustomerOrders = [...customerOrders]
    .filter((entry) => {
      const entryPhone = String(entry?.customer_phone || entry?.customerPhone || '').replace(/\D+/g, '');
      return !normalizedCustomerPhone || !entryPhone || entryPhone === normalizedCustomerPhone;
    })
    .sort(
      (a, b) =>
        new Date(b?.created_at || b?.createdAt || 0).getTime() -
        new Date(a?.created_at || a?.createdAt || 0).getTime(),
    );
  const repeatOrderCount = normalizedCustomerPhone
    ? sortedCustomerOrders.length + (sortedCustomerOrders.some(orderMatchesCurrent) ? 0 : 1)
    : 0;
  const recentOrders = sortedCustomerOrders.filter((entry) => !orderMatchesCurrent(entry)).slice(0, 4);

  const subtotal = displayOrder.subtotal || 0;
  const tax = displayOrder.tax || displayOrder.tax_amount || displayOrder.taxAmount || 0;
  const deliveryFee = displayOrder.delivery_fee ?? displayOrder.deliveryFee ?? 0;
  const discountAmount = displayOrder.discount_amount || displayOrder.discountAmount || 0;
  const discountPercentage = displayOrder.discount_percentage || displayOrder.discountPercentage || 0;
  const total = displayOrder.total || displayOrder.total_amount || displayOrder.totalAmount || 0;
  // Calculate original subtotal before discount (for display purposes)
  const originalSubtotal = discountAmount > 0 ? subtotal + discountAmount : subtotal;
  const status = displayOrder.status || 'pending';
  const paymentMethod = displayOrder.payment_method || displayOrder.paymentMethod || '';
  const paymentStatus = String(displayOrder.payment_status || displayOrder.paymentStatus || 'pending').toLowerCase();
  const completedPayments = useMemo(
    () => orderPayments.filter(isCompletedPaymentRecord),
    [orderPayments],
  );
  const paidAmount = useMemo(
    () => completedPayments.reduce((sum: number, payment: any) => sum + Number(payment?.amount || 0), 0),
    [completedPayments],
  );
  const remainingAmount = Math.max(0, total - paidAmount);
  const itemPaymentBreakdownByIndex = useMemo(() => {
    const breakdown = new Map<number, Array<{
      paymentId: string;
      method: string;
      paymentOrigin: string;
      itemAmount: number;
      createdAt?: string;
      transactionRef?: string;
    }>>();

    completedPayments.forEach((payment: any) => {
      const paymentId = String(payment?.id || payment?.paymentId || '');
      const method = String(payment?.method || payment?.payment_method || '').toLowerCase();
      const paymentOrigin = String(payment?.paymentOrigin || payment?.payment_origin || 'manual').toLowerCase();
      const paymentCreatedAt = payment?.created_at || payment?.createdAt;
      const paymentTransactionRef = payment?.transactionRef || payment?.transaction_ref || '';
      const paymentItems = Array.isArray(payment?.items) ? payment.items : [];

      paymentItems.forEach((item: any) => {
        const itemIndex = Number(item?.itemIndex ?? item?.item_index);
        if (!Number.isInteger(itemIndex)) {
          return;
        }

        const entries = breakdown.get(itemIndex) ?? [];
        entries.push({
          paymentId,
          method,
          paymentOrigin,
          itemAmount: Number(item?.itemAmount ?? item?.item_amount ?? payment?.amount ?? 0),
          createdAt: paymentCreatedAt,
          transactionRef: paymentTransactionRef,
        });
        breakdown.set(itemIndex, entries);
      });
    });

    paidItems.forEach((item: any) => {
      const itemIndex = Number(item?.itemIndex ?? item?.item_index);
      if (!Number.isInteger(itemIndex) || breakdown.has(itemIndex)) {
        return;
      }

      breakdown.set(itemIndex, [{
        paymentId: String(item?.paymentId || item?.payment_id || ''),
        method: String(item?.paymentMethod || item?.payment_method || '').toLowerCase(),
        paymentOrigin: 'manual',
        itemAmount: Number(item?.itemAmount ?? item?.item_amount ?? 0),
        createdAt: item?.createdAt || item?.created_at,
        transactionRef: '',
      }]);
    });

    return breakdown;
  }, [completedPayments, paidItems]);
  const paidItemIndices = useMemo(
    () => Array.from(itemPaymentBreakdownByIndex.keys()),
    [itemPaymentBreakdownByIndex],
  );
  const paidItemIndexSet = useMemo(() => new Set(paidItemIndices), [paidItemIndices]);
  const getItemPaymentPresentation = useMemo(
    () => (itemIndex: number) => {
      const entries = itemPaymentBreakdownByIndex.get(itemIndex) ?? [];
      if (!entries.length) {
        return '';
      }

      const uniqueMethods = new Set(
        entries
          .map((entry) => entry.method)
          .filter((method) => method === 'cash' || method === 'card'),
      );
      const uniquePayments = new Set(entries.map((entry) => entry.paymentId).filter(Boolean));

      if (uniquePayments.size > 1 || uniqueMethods.size > 1) {
        return 'split';
      }

      return Array.from(uniqueMethods)[0] || 'split';
    },
    [itemPaymentBreakdownByIndex],
  );
  const paymentMethodPresentation = (() => {
    const normalizedMethod = String(paymentMethod || '').toLowerCase();
    if (normalizedMethod === 'split' || normalizedMethod === 'mixed') {
      return 'split';
    }
    if (paymentStatus === 'partially_paid' && completedPayments.length > 0) {
      return 'split';
    }
    if (completedPayments.length > 1) {
      return 'split';
    }
    return normalizedMethod;
  })();
  const createdAt = displayOrder.created_at || displayOrder.createdAt
    ? new Date(displayOrder.created_at || displayOrder.createdAt)
    : new Date();
  const isGhostOrder =
    displayOrder.is_ghost === true ||
    displayOrder.isGhost === true ||
    displayOrder.ghost === true;

  // Driver info for delivered orders
  const driverName = displayOrder.driver_name || displayOrder.driverName || '';
  const hasDriverAssignment = !!(displayOrder.driver_id || displayOrder.driverId || driverName);
  const isDelivered = status?.toLowerCase() === 'completed' || status?.toLowerCase() === 'delivered';
  const isDeliveryOrder = orderType?.toLowerCase() === 'delivery';
  const displayOrderNumber = getVisibleOrderNumber(displayOrder) || orderId;
  const createdDateTimeLabel = `${formatDate(createdAt)} ${formatTime(createdAt, { hour: '2-digit', minute: '2-digit' })}`;
  const primaryAddressLine = deliveryAddress.address || t('modals.orderDetails.noAddress', { defaultValue: 'No address' });
  const totalItemCount = items.reduce((sum: number, item: any) => sum + Number(item?.quantity || 1), 0);
  const serviceNotes = [displayOrder.special_instructions, displayOrder.specialInstructions, displayOrder.notes]
    .map((note) => normalizeText(note))
    .filter(
      (note, index, array) =>
        Boolean(note) &&
        array.findIndex((existing) => existing.toLowerCase() === note.toLowerCase()) === index,
    );
  const isDarkTheme = resolvedTheme === 'dark';
  const shellPanelClass =
    'rounded-[30px] border border-zinc-200/80 bg-white/90 shadow-[0_20px_60px_rgba(15,23,42,0.08)] dark:border-white/10 dark:bg-[rgba(12,14,20,0.88)]';
  const insetPanelClass =
    'rounded-2xl border border-zinc-200/70 bg-white/70 dark:border-white/10 dark:bg-white/[0.04]';
  const mutedEyebrowClass =
    'text-[11px] font-semibold uppercase tracking-[0.32em] liquid-glass-modal-text-muted';

  // Parse customizations/ingredients with prices
  // Edge Case Handling (Requirements 5.3, 5.5):
  // - Returns empty array when customizations is null/undefined
  // - Handles malformed JSON strings gracefully without crashing
  const parseCustomizations = (customizations: any): { name: string; price: number; isWithout?: boolean; isLittle?: boolean }[] => {
    // Handle null/undefined - return empty array (Requirement 5.3)
    if (customizations === null || customizations === undefined) return [];

    const parsePrice = (val: any): number => {
      if (val === null || val === undefined) return 0;
      const num = typeof val === 'string' ? parseFloat(val) : Number(val);
      return isNaN(num) ? 0 : num;
    };

    const extractPrice = (c: any): number => {
      // Check ingredient object first
      if (c.ingredient) {
        const ing = c.ingredient;
        const pickupPrice = parsePrice(ing.pickup_price);
        const deliveryPrice = parsePrice(ing.delivery_price);
        const price = parsePrice(ing.price);
        const basePrice = parsePrice(ing.base_price);

        // Return appropriate price based on order type
        if (orderType === 'delivery' && deliveryPrice > 0) return deliveryPrice;
        if (orderType === 'pickup' && pickupPrice > 0) return pickupPrice;
        if (price > 0) return price;
        if (basePrice > 0) return basePrice;
      }

      // Check direct price fields
      const directPrice = parsePrice(c.price);
      const additionalPrice = parsePrice(c.additionalPrice);
      const extraPrice = parsePrice(c.extra_price);

      if (directPrice > 0) return directPrice;
      if (additionalPrice > 0) return additionalPrice;
      if (extraPrice > 0) return extraPrice;

      return 0;
    };

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

    // Check if item is "without" (removed ingredient)
    const isWithoutItem = (c: any): boolean => {
      return c.isWithout === true || c.is_without === true || c.without === true;
    };
    const isLittleItem = (c: any): boolean => {
      return c.isLittle === true || c.is_little === true || c.little === true;
    };

    // Handle JSON string format - parse it first (Requirement 5.5)
    let parsedCustomizations = customizations;
    if (typeof customizations === 'string') {
      const trimmed = customizations.trim();
      if (!trimmed) return [];
      try {
        parsedCustomizations = JSON.parse(trimmed);
      } catch {
        // Malformed JSON - return empty array without crashing
        return [];
      }
    }

    if (Array.isArray(parsedCustomizations)) {
      return parsedCustomizations
        .filter((c: any) => c && (c.ingredient || c.name || c.name_en))
        .map((c: any) => ({
          name: extractName(c),
          price: isWithoutItem(c) ? 0 : extractPrice(c),
          isWithout: isWithoutItem(c),
          isLittle: isLittleItem(c)
        }));
    }
    if (typeof parsedCustomizations === 'object' && parsedCustomizations !== null) {
      return Object.values(parsedCustomizations)
        .filter((c: any) => c && (c.ingredient || c.name || c.name_en))
        .map((c: any) => ({
          name: extractName(c),
          price: isWithoutItem(c) ? 0 : extractPrice(c),
          isWithout: isWithoutItem(c),
          isLittle: isLittleItem(c)
        }));
    }
    return [];
  };

  const resolveCategoryPath = (item: any): string => {
    const explicitPath =
      (typeof item?.category_path === 'string' && item.category_path.trim()) ||
      (typeof item?.categoryPath === 'string' && item.categoryPath.trim()) ||
      '';
    if (explicitPath) {
      const [primary] = explicitPath.split('>');
      const normalizedPrimary = typeof primary === 'string' ? primary.trim() : '';
      if (normalizedPrimary) return normalizedPrimary;
      return explicitPath;
    }

    const category =
      item?.categoryName ||
      item?.category_name ||
      item?.category?.name ||
      item?.menu_item?.category_name ||
      item?.menu_item?.categoryName ||
      '';
    const normalizedCategory = typeof category === 'string' ? category.trim() : '';
    if (normalizedCategory) return normalizedCategory;

    const fallbackSubcategory =
      item?.subcategory_name ||
      item?.subcategoryName ||
      item?.sub_category_name ||
      item?.subCategoryName ||
      '';
    return typeof fallbackSubcategory === 'string' ? fallbackSubcategory.trim() : '';
  };

  const resolveItemNotes = (item: any): string => {
    const notes = [
      item?.notes,
      item?.special_instructions,
      item?.specialInstructions,
      item?.instructions
    ]
      .map(value => (typeof value === 'string' ? value.trim() : ''))
      .filter(value => Boolean(value));
    const deduped = notes.filter(
      (value, index, array) =>
        array.findIndex(existing => existing.toLowerCase() === value.toLowerCase()) === index
    );
    return deduped.join(' | ');
  };

  const modalHeader = (
    <div className="flex-shrink-0 border-b liquid-glass-modal-border bg-gradient-to-br from-emerald-500/[0.08] via-cyan-500/[0.05] to-transparent px-6 py-5 dark:from-emerald-500/[0.12] dark:via-cyan-500/[0.09]">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-3">
            <div className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.26em] ${
              isDarkTheme
                ? 'border-white/10 bg-white/[0.06] text-white/70'
                : 'border-zinc-200 bg-white/80 text-zinc-500'
            }`}>
              <Package className="h-3.5 w-3.5" />
              {t('modals.orderDetails.title', { defaultValue: 'Order Details' })}
            </div>
            <span className={`inline-flex items-center rounded-full border px-3 py-1 text-xs font-semibold ${getStatusColor(status)}`}>
              {status?.toUpperCase() || 'PENDING'}
            </span>
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <h2 className="text-3xl font-bold tracking-tight liquid-glass-modal-text">
              #{displayOrderNumber}
            </h2>
            <div className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-sm ${
              isDarkTheme
                ? 'bg-white/[0.06] text-white/70'
                : 'bg-zinc-100 text-zinc-600'
            }`}>
              <Clock className="h-4 w-4" />
              {createdDateTimeLabel}
            </div>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2 text-sm liquid-glass-modal-text-muted">
            <span className="inline-flex items-center gap-2 rounded-full border border-zinc-200/70 bg-white/70 px-3 py-1 dark:border-white/10 dark:bg-white/[0.04]">
              {isDeliveryOrder ? <Truck className="h-4 w-4 text-orange-400" /> : <Clock className="h-4 w-4 text-blue-400" />}
              {getOrderTypeLabel(orderType)}
            </span>
            <span className="inline-flex items-center gap-2 rounded-full border border-zinc-200/70 bg-white/70 px-3 py-1 dark:border-white/10 dark:bg-white/[0.04]">
              {getPaymentMethodIcon(paymentMethodPresentation)}
              {getPaymentMethodLabel(paymentMethodPresentation)}
            </span>
            {isDeliveryOrder && hasDriverAssignment ? (
              <span className="inline-flex items-center gap-2 rounded-full border border-zinc-200/70 bg-white/70 px-3 py-1 dark:border-white/10 dark:bg-white/[0.04]">
                <Car className="h-4 w-4 text-cyan-400" />
                {driverName || t('modals.orderDetails.unknownDriver', { defaultValue: 'Unknown Driver' })}
              </span>
            ) : null}
          </div>
          {isDeliveryOrder && hasDeliveryAddress ? (
            <p className="mt-4 max-w-4xl whitespace-pre-line text-sm leading-6 liquid-glass-modal-text-muted">
              {primaryAddressLine}
            </p>
          ) : null}
        </div>
        <button
          onClick={onClose}
          className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl border border-zinc-200/70 bg-white/80 text-zinc-700 shadow-sm transition-colors hover:bg-white dark:border-white/10 dark:bg-white/[0.05] dark:text-zinc-200 dark:hover:bg-white/[0.08]"
          aria-label={t('common.actions.close')}
        >
          <X className="h-6 w-6" />
        </button>
      </div>
    </div>
  );

  const canRefund = paymentStatus === 'paid' || paymentStatus === 'completed';
  const canSplitPayment = paymentStatus === 'pending' || paymentStatus === 'partially_paid';

  // Compute footer grid columns based on visible buttons
  const footerButtonCount =
    (onPrintReceipt ? 1 : 0) +
    (canSplitPayment ? 1 : 0) +
    (canRefund ? 1 : 0) +
    1; // Close button is always shown
  const footerGridCols =
    footerButtonCount === 4 ? 'grid-cols-4' :
    footerButtonCount === 3 ? 'grid-cols-3' :
    'grid-cols-2';

  /** Called when split payment finishes -- reload order data to reflect updated payment status. */
  const handleSplitComplete = (_result: SplitPaymentResult) => {
    setShowSplitPaymentModal(false);
    // Reload order data to reflect updated payment status
    if (orderId && !order) {
      loadOrderData();
    }
    void loadPaymentState();
  };

  const modalFooter = (
    <div className="flex-shrink-0 border-t liquid-glass-modal-border bg-white/85 px-6 py-4 backdrop-blur-xl dark:bg-black/30">
      <div className={`grid gap-3 ${footerGridCols}`}>
        {onPrintReceipt && (
          <button
            onClick={onPrintReceipt}
            className="flex min-h-[52px] w-full items-center justify-center gap-2 rounded-2xl border border-zinc-200/70 bg-white/90 px-4 text-sm font-semibold text-zinc-900 transition hover:bg-white dark:border-white/10 dark:bg-white/[0.05] dark:text-zinc-100 dark:hover:bg-white/[0.08]"
          >
            <Printer className="h-4 w-4" />
            {t('modals.orderDetails.printReceipt') || 'Print Receipt'}
          </button>
        )}
        {canSplitPayment && (
          <button
            onClick={() => setShowSplitPaymentModal(true)}
            className="flex min-h-[52px] w-full items-center justify-center gap-2 rounded-2xl border border-fuchsia-300/60 bg-fuchsia-50 px-4 text-sm font-semibold text-fuchsia-700 transition hover:bg-fuchsia-100 dark:border-fuchsia-500/25 dark:bg-fuchsia-500/10 dark:text-fuchsia-200 dark:hover:bg-fuchsia-500/15"
          >
            <Split className="h-4 w-4" />
            {t('payment.split.title', { defaultValue: 'Split Payment' })}
          </button>
        )}
        {canRefund && (
          <button
            onClick={() => setShowRefundModal(true)}
            className="flex min-h-[52px] w-full items-center justify-center gap-2 rounded-2xl border border-red-300/70 bg-red-50 px-4 text-sm font-semibold text-red-700 transition hover:bg-red-100 dark:border-red-500/25 dark:bg-red-500/10 dark:text-red-200 dark:hover:bg-red-500/15"
          >
            <RotateCcw className="h-4 w-4" />
            {t('modals.orderDetails.voidRefund', { defaultValue: 'Void / Refund' })}
          </button>
        )}
        <button
          onClick={onClose}
          className="flex min-h-[52px] w-full items-center justify-center gap-2 rounded-2xl border border-zinc-300/80 bg-zinc-100 px-4 text-sm font-semibold text-zinc-700 transition hover:bg-zinc-200 dark:border-white/10 dark:bg-zinc-900/80 dark:text-zinc-100 dark:hover:bg-zinc-800"
        >
          {t('common.actions.close') || 'Close'}
        </button>
      </div>
    </div>
  );

  if (!isOpen) return null;

  return (
    <>
    <LiquidGlassModal
      isOpen={isOpen}
      onClose={onClose}
      size="lg"
      className="!w-[92vw] !max-w-6xl"
      contentClassName="p-0 overflow-hidden"
      ariaLabel={t('modals.orderDetails.title', { defaultValue: 'Order Details' })}
      header={modalHeader}
      footer={modalFooter}
    >
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-6 py-6 scrollbar-hide">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <div className={`h-12 w-12 animate-spin rounded-full border-2 ${
              isDarkTheme
                ? 'border-white/15 border-t-cyan-300'
                : 'border-zinc-200 border-t-blue-600'
            }`}></div>
          </div>
        ) : (
          <div className="space-y-6">

            <section className={`${shellPanelClass} overflow-hidden p-6`}>
              <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
                <div className="space-y-4">
                  <div className={mutedEyebrowClass}>{t('modals.orderDetails.title', { defaultValue: 'Order Details' })}</div>
                  <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                    <div className={`${insetPanelClass} px-4 py-4`}>
                      <div className="flex items-center gap-3">
                        <div className={`flex h-11 w-11 items-center justify-center rounded-2xl ${
                          isDeliveryOrder
                            ? 'bg-orange-500/15 text-orange-500 dark:bg-orange-500/20 dark:text-orange-300'
                            : 'bg-blue-500/15 text-blue-600 dark:bg-blue-500/20 dark:text-blue-300'
                        }`}>
                          {isDeliveryOrder ? <Truck className="h-5 w-5" /> : <Clock className="h-5 w-5" />}
                        </div>
                        <div className="min-w-0">
                          <div className="text-lg font-semibold liquid-glass-modal-text">{getOrderTypeLabel(orderType)}</div>
                          <div className="text-sm liquid-glass-modal-text-muted">{createdDateTimeLabel}</div>
                        </div>
                      </div>
                    </div>
                    <div className={`${insetPanelClass} px-4 py-4`}>
                      <div className="flex items-center gap-3">
                        <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-emerald-500/15 text-emerald-600 dark:bg-emerald-500/20 dark:text-emerald-300">
                          {getPaymentMethodIcon(paymentMethodPresentation)}
                        </div>
                        <div className="min-w-0">
                          <div className="text-lg font-semibold liquid-glass-modal-text">{getPaymentMethodLabel(paymentMethodPresentation)}</div>
                          <div className="text-sm capitalize liquid-glass-modal-text-muted">{paymentStatus}</div>
                        </div>
                      </div>
                    </div>
                    <div className={`${insetPanelClass} px-4 py-4 md:col-span-2 xl:col-span-1`}>
                      <div className="flex items-center gap-3">
                        <div className={`flex h-11 w-11 items-center justify-center rounded-2xl ${
                          isDeliveryOrder
                            ? 'bg-cyan-500/15 text-cyan-600 dark:bg-cyan-500/20 dark:text-cyan-300'
                            : 'bg-violet-500/15 text-violet-600 dark:bg-violet-500/20 dark:text-violet-300'
                        }`}>
                          {isDeliveryOrder ? <Car className="h-5 w-5" /> : <User className="h-5 w-5" />}
                        </div>
                        <div className="min-w-0">
                          <div className="truncate text-lg font-semibold liquid-glass-modal-text">
                            {isDeliveryOrder
                              ? (driverName || t('modals.orderDetails.unknownDriver', { defaultValue: 'Unknown Driver' }))
                              : (customerName || t('modals.orderDetails.guestCustomer', { defaultValue: 'Guest' }))}
                          </div>
                          <div className="text-sm liquid-glass-modal-text-muted">
                            {isDeliveryOrder
                              ? hasDriverAssignment
                                ? (isDelivered
                                  ? t('modals.orderDetails.deliveredBy', { defaultValue: 'Delivered By' })
                                  : t('modals.orderDetails.assignedDriver', { defaultValue: 'Assigned Driver' }))
                                : t('modals.orderDetails.processing', { defaultValue: 'Processing' })
                              : (customerPhone || customerEmail || t('modals.orderDetails.processing', { defaultValue: 'Processing' }))}
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                  {isDeliveryOrder && hasDeliveryAddress ? (
                    <div className={`${insetPanelClass} px-4 py-4`}>
                      <div className={mutedEyebrowClass}>{t('modals.orderDetails.savedAddress', { defaultValue: 'Saved Address' })}</div>
                      <p className="mt-3 whitespace-pre-line text-base leading-7 liquid-glass-modal-text">
                        {primaryAddressLine}
                      </p>
                    </div>
                  ) : null}
                </div>
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-1">
                  <div className={`${insetPanelClass} px-5 py-5`}>
                    <div className={mutedEyebrowClass}>{t('modals.orderDetails.total', { defaultValue: 'Total' })}</div>
                    <div className="mt-3 text-3xl font-bold tracking-tight liquid-glass-modal-text">
                      {formatCurrency(total)}
                    </div>
                    <div className="mt-2 text-sm liquid-glass-modal-text-muted">
                      {remainingAmount > 0
                        ? `${t('splitPayment.remaining', { defaultValue: 'Remaining' })}: ${formatCurrency(remainingAmount)}`
                        : `${t('modals.orderDetails.paid', { defaultValue: 'Paid' })}: ${formatCurrency(paidAmount || total)}`}
                    </div>
                  </div>
                  <div className={`${insetPanelClass} px-5 py-5`}>
                    <div className={mutedEyebrowClass}>{t('modals.orderDetails.orderItems', { defaultValue: 'Items' })}</div>
                    <div className="mt-3 flex items-end justify-between gap-3">
                      <div className="text-3xl font-bold tracking-tight liquid-glass-modal-text">
                        {totalItemCount}
                      </div>
                      {normalizedCustomerPhone ? (
                        <div className="rounded-full border border-emerald-300/70 bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-700 dark:border-emerald-500/25 dark:bg-emerald-500/10 dark:text-emerald-200">
                          {t('modals.orderDetails.customerOrderIndex', {
                            count: repeatOrderCount || 1,
                            defaultValue: 'Order #{{count}}',
                          })}
                        </div>
                      ) : null}
                    </div>
                    <div className="mt-2 text-sm liquid-glass-modal-text-muted">
                      {normalizedCustomerPhone
                        ? repeatOrderCount > 1
                          ? t('modals.orderDetails.previousOrdersCount', {
                            count: repeatOrderCount - 1,
                            defaultValue: '{{count}} previous orders on this phone',
                          })
                          : t('modals.orderDetails.firstOrder', { defaultValue: 'First recorded order' })
                        : t('modals.orderDetails.processing', { defaultValue: 'Processing' })}
                    </div>
                    {completedPayments.length > 0 ? (
                      <div className="mt-4 rounded-2xl border border-zinc-200/70 bg-white/70 px-4 py-3 text-sm liquid-glass-modal-text-muted dark:border-white/10 dark:bg-white/[0.04]">
                        <div>{t('modals.orderDetails.paid', { defaultValue: 'Paid' })}: {formatCurrency(paidAmount)}</div>
                        <div>{t('splitPayment.remaining', { defaultValue: 'Remaining' })}: {formatCurrency(remainingAmount)}</div>
                      </div>
                    ) : null}
                  </div>
                </div>
              </div>
            </section>

            <div className="grid grid-cols-1 gap-6 xl:grid-cols-[340px_minmax(0,1fr)]">
              {/* Left Column: Customer, Delivery & Driver Info */}
              <div className="space-y-6">

                {/* Customer Card */}
                <div className="liquid-glass-modal-card rounded-[28px] border border-zinc-200/80 bg-white/90 shadow-[0_20px_60px_rgba(15,23,42,0.08)] dark:border-white/10 dark:bg-zinc-900/75">
                  <div className="mb-4 flex items-center gap-2 text-sm font-bold uppercase tracking-[0.28em] liquid-glass-modal-text-muted">
                    <User className="w-4 h-4" />
                    {t('modals.orderDetails.customerInformation') || 'Customer'}
                  </div>
                  <div className="space-y-4">
                    <div className="flex items-center gap-3">
                      <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-purple-200 bg-purple-50 text-lg font-bold text-purple-700 shadow-sm dark:border-purple-500/25 dark:bg-purple-500/15 dark:text-purple-200">
                        {customerName ? customerName.charAt(0).toUpperCase() : '?'}
                      </div>
                      <div className="min-w-0">
                        <div className="truncate text-base font-semibold liquid-glass-modal-text">
                          {customerName || t('modals.orderDetails.guestCustomer') || 'Guest'}
                        </div>
                        {customerPhone ? (
                          <div className="mt-1 flex items-center gap-1 text-sm liquid-glass-modal-text-muted">
                            <Phone className="w-3 h-3" />
                            {customerPhone}
                          </div>
                        ) : null}
                        {customerEmail ? (
                          <div className="mt-1 text-xs liquid-glass-modal-text-muted">
                            {customerEmail}
                          </div>
                        ) : null}
                      </div>
                    </div>
                  </div>
                </div>

                {normalizedCustomerPhone ? (
                  <div className="liquid-glass-modal-card rounded-[28px] border border-zinc-200/80 bg-white/90 shadow-[0_20px_60px_rgba(15,23,42,0.08)] dark:border-white/10 dark:bg-zinc-900/75">
                    <div className="flex items-center gap-2 text-sm font-bold uppercase tracking-[0.28em] liquid-glass-modal-text-muted">
                      <History className="w-4 h-4" />
                      {t('modals.orderDetails.repeatCustomer', { defaultValue: 'Repeat Customer' })}
                    </div>
                    <div className="mt-4 rounded-2xl border border-emerald-200 bg-emerald-50/90 px-4 py-3 dark:border-emerald-500/20 dark:bg-emerald-500/10">
                      <div className="text-xs font-semibold uppercase tracking-[0.22em] text-emerald-700 dark:text-emerald-200">
                        {t('modals.orderDetails.customerOrderIndex', {
                          count: repeatOrderCount || 1,
                          defaultValue: 'Order #{{count}}',
                        })}
                      </div>
                      <div className="mt-2 text-sm text-emerald-800 dark:text-emerald-100">
                        {repeatOrderCount > 1
                          ? t('modals.orderDetails.previousOrdersCount', {
                            count: repeatOrderCount - 1,
                            defaultValue: '{{count}} previous orders on this phone',
                          })
                          : t('modals.orderDetails.firstOrder', { defaultValue: 'First recorded order' })}
                      </div>
                    </div>
                    <div className="mt-4">
                      <div className="mb-3 flex items-center justify-between">
                        <div className="text-sm font-semibold liquid-glass-modal-text">
                          {t('modals.orderDetails.recentOrders', { defaultValue: 'Recent Orders' })}
                        </div>
                        {historyLoading && (
                          <div className="h-4 w-4 animate-spin rounded-full border border-zinc-300 border-t-zinc-700 dark:border-zinc-700 dark:border-t-zinc-200" />
                        )}
                      </div>
                      <div className="space-y-2">
                        {recentOrders.length > 0 ? (
                          recentOrders.map((historyOrder) => (
                            <div
                              key={`${historyOrder.id || historyOrder.order_number || historyOrder.orderNumber}-${historyOrder.created_at || historyOrder.createdAt || ''}`}
                              className="flex items-center justify-between gap-3 rounded-2xl border border-zinc-200/70 bg-zinc-50/90 px-3 py-3 dark:border-white/10 dark:bg-white/5"
                            >
                              <div className="min-w-0">
                                <div className="truncate text-sm font-semibold liquid-glass-modal-text">
                                  #{historyOrder.order_number || historyOrder.orderNumber || historyOrder.id}
                                </div>
                                <div className="text-xs liquid-glass-modal-text-muted">
                                  {`${formatDate(new Date(historyOrder.created_at || historyOrder.createdAt || Date.now()))} ${formatTime(new Date(historyOrder.created_at || historyOrder.createdAt || Date.now()), { hour: '2-digit', minute: '2-digit' })}`}
                                </div>
                              </div>
                              <div className="flex items-center gap-2">
                                <span className={`inline-flex items-center rounded-full border px-2 py-1 text-[10px] font-semibold ${getStatusColor(historyOrder.status || 'pending')}`}>
                                  {historyOrder.status || 'pending'}
                                </span>
                                <span className="text-sm font-semibold liquid-glass-modal-text">
                                  {formatCurrency(Number(historyOrder.total_amount || historyOrder.totalAmount || 0))}
                                </span>
                                <ChevronRight className="w-4 h-4 liquid-glass-modal-text-muted" />
                              </div>
                            </div>
                          ))
                        ) : (
                          <div className="rounded-2xl border border-dashed border-zinc-200 px-4 py-4 text-sm liquid-glass-modal-text-muted dark:border-white/10">
                            {t('modals.orderDetails.noRecentOrders', { defaultValue: 'No previous orders found' })}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                ) : null}

                {/* Delivery Address Card - Show only for delivery orders */}
                {isDeliveryOrder && hasDeliveryAddress && (
                  <div className="liquid-glass-modal-card rounded-[28px] border border-zinc-200/80 bg-white/90 shadow-[0_20px_60px_rgba(15,23,42,0.08)] dark:border-white/10 dark:bg-zinc-900/75">
                    <h4 className="mb-4 flex items-center gap-2 text-sm font-bold uppercase tracking-[0.28em] liquid-glass-modal-text-muted">
                      <MapPin className="w-4 h-4" />
                      {t('modals.orderDetails.deliveryAddress') || 'Delivery Address'}
                    </h4>
                    <div className="rounded-2xl border border-zinc-200/70 bg-zinc-50/90 px-4 py-3 dark:border-white/10 dark:bg-white/5">
                      <div className="text-xs font-semibold uppercase tracking-[0.22em] liquid-glass-modal-text-muted">
                        {t('modals.orderDetails.savedAddress', { defaultValue: 'Saved Address' })}
                      </div>
                      <p className="mt-2 whitespace-pre-line font-medium liquid-glass-modal-text">
                        {deliveryAddress.address || t('modals.orderDetails.noAddress') || 'No address'}
                      </p>
                    </div>

                    <div className="mt-4 space-y-2">
                      {deliveryAddress.city ? (
                        <div className="flex items-center justify-between gap-3 rounded-2xl border border-zinc-200/70 bg-zinc-50/90 px-4 py-3 text-sm dark:border-white/10 dark:bg-white/5">
                          <span className="flex items-center gap-2 liquid-glass-modal-text-muted">
                            <MapPin className="w-3 h-3" />
                            {t('modals.orderDetails.city', { defaultValue: 'City' })}
                          </span>
                          <span className="font-medium liquid-glass-modal-text">{deliveryAddress.city}</span>
                        </div>
                      ) : null}
                      {deliveryAddress.postal_code ? (
                        <div className="flex items-center justify-between gap-3 rounded-2xl border border-zinc-200/70 bg-zinc-50/90 px-4 py-3 text-sm dark:border-white/10 dark:bg-white/5">
                          <span className="flex items-center gap-2 liquid-glass-modal-text-muted">
                            <Layers className="w-3 h-3" />
                            {t('modals.orderDetails.postalCode', { defaultValue: 'Postal Code' })}
                          </span>
                          <span className="font-medium liquid-glass-modal-text">{deliveryAddress.postal_code}</span>
                        </div>
                      ) : null}
                      {deliveryAddress.floor ? (
                        <div className="flex items-center justify-between gap-3 rounded-2xl border border-zinc-200/70 bg-zinc-50/90 px-4 py-3 text-sm dark:border-white/10 dark:bg-white/5">
                          <span className="flex items-center gap-2 liquid-glass-modal-text-muted">
                            <Layers className="w-3 h-3" />
                            {t('modals.orderDetails.floor', { defaultValue: 'Floor' })}
                          </span>
                          <span className="font-medium liquid-glass-modal-text">{deliveryAddress.floor}</span>
                        </div>
                      ) : null}
                      {deliveryAddress.name_on_ringer ? (
                        <div className="flex items-center justify-between gap-3 rounded-2xl border border-zinc-200/70 bg-zinc-50/90 px-4 py-3 text-sm dark:border-white/10 dark:bg-white/5">
                          <span className="flex items-center gap-2 liquid-glass-modal-text-muted">
                            <Bell className="w-3 h-3" />
                            {t('modals.orderDetails.nameOnRinger', { defaultValue: 'Bell' })}
                          </span>
                          <span className="font-medium liquid-glass-modal-text">{deliveryAddress.name_on_ringer}</span>
                        </div>
                      ) : null}
                    </div>

                    {deliveryAddress.notes ? (
                      <div className="mt-4 rounded-2xl border border-amber-200 bg-amber-50/90 px-4 py-3 dark:border-amber-500/20 dark:bg-amber-500/10">
                        <div className="text-xs font-semibold uppercase tracking-[0.22em] text-amber-700 dark:text-amber-200">
                          {t('modals.orderDetails.deliveryNotes', { defaultValue: 'Delivery Notes' })}
                        </div>
                        <div className="mt-2 flex items-start gap-2 text-sm text-amber-900 dark:text-amber-100">
                          <FileText className="mt-0.5 w-3 h-3 shrink-0" />
                          <span>{deliveryAddress.notes}</span>
                        </div>
                      </div>
                    ) : null}
                  </div>
                )}

                {/* Driver Info - Show for assigned and delivered delivery orders */}
                {isDeliveryOrder && hasDriverAssignment && (
                  <div className="liquid-glass-modal-card rounded-[28px] border border-zinc-200/80 bg-white/90 shadow-[0_20px_60px_rgba(15,23,42,0.08)] dark:border-white/10 dark:bg-zinc-900/75">
                    <h4 className="mb-4 flex items-center gap-2 text-sm font-bold uppercase tracking-[0.28em] liquid-glass-modal-text-muted">
                      <Truck className="w-4 h-4" />
                      {t('modals.orderDetails.deliveryFulfillment', { defaultValue: 'Delivery Fulfillment' })}
                    </h4>
                    <div className={`rounded-2xl border px-4 py-3 ${
                      isDelivered
                        ? 'border-green-500/20 bg-green-500/10'
                        : 'border-cyan-500/20 bg-cyan-500/10'
                    }`}>
                      <div className="flex items-center gap-3">
                        <div className={`flex h-10 w-10 items-center justify-center rounded-full text-white font-bold text-lg shadow-lg ${
                          isDelivered
                            ? 'bg-gradient-to-br from-green-500 to-teal-600'
                            : 'bg-gradient-to-br from-cyan-500 to-blue-600'
                        }`}>
                          {driverName ? driverName.charAt(0).toUpperCase() : <Car className="w-5 h-5" />}
                        </div>
                        <div>
                          <div className="font-semibold liquid-glass-modal-text">
                            {driverName || t('modals.orderDetails.unknownDriver', { defaultValue: 'Unknown Driver' })}
                          </div>
                          <div className={`text-xs flex items-center gap-1 ${
                            isDelivered ? 'text-green-400' : 'text-cyan-400'
                          }`}>
                            {isDelivered ? <CheckCircle className="w-3 h-3" aria-hidden="true" /> : <Truck className="w-3 h-3" aria-hidden="true" />}
                            {isDelivered
                              ? t('modals.orderDetails.deliveredBy', { defaultValue: 'Delivered By' })
                              : t('modals.orderDetails.assignedDriver', { defaultValue: 'Assigned Driver' })}
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {serviceNotes.length > 0 ? (
                  <div className="liquid-glass-modal-card rounded-[28px] border border-zinc-200/80 bg-white/90 shadow-[0_20px_60px_rgba(15,23,42,0.08)] dark:border-white/10 dark:bg-zinc-900/75">
                    <h4 className="mb-4 flex items-center gap-2 text-sm font-bold uppercase tracking-[0.28em] liquid-glass-modal-text-muted">
                      <FileText className="w-4 h-4" />
                      {t('modals.orderDetails.serviceNotes', { defaultValue: 'Service Notes' })}
                    </h4>
                    <div className="space-y-2">
                      {serviceNotes.map((note) => (
                        <div
                          key={note}
                          className="rounded-2xl border border-zinc-200/70 bg-zinc-50/90 px-4 py-3 text-sm liquid-glass-modal-text dark:border-white/10 dark:bg-white/5"
                        >
                          {note}
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}

              </div>

              {/* Right Column: Order Items */}
              <div className="min-w-0">
                <div className={`${shellPanelClass} flex h-full flex-col p-6`}>
                  <div className="mb-5 flex items-center justify-between gap-3">
                    <h4 className="flex items-center gap-2 text-sm font-bold uppercase tracking-[0.28em] liquid-glass-modal-text-muted">
                      <Package className="w-4 h-4" />
                      {t('modals.orderDetails.orderItems') || 'Items'}
                    </h4>
                    <span className="rounded-full border border-zinc-200/70 bg-white/70 px-3 py-1 text-xs font-semibold liquid-glass-modal-text dark:border-white/10 dark:bg-white/[0.04]">
                      {totalItemCount}
                    </span>
                  </div>

                  <div className="flex-1 overflow-y-auto space-y-3 custom-scrollbar">
                    {items.length > 0 ? (
                      items.map((item: any, index: number) => {
                        const customizations = parseCustomizations(item.customizations);
                        const categoryPath = resolveCategoryPath(item);
                        const itemNotes = resolveItemNotes(item);
                        const itemIndex = item.itemIndex ?? item.item_index ?? index;
                        const itemPayments = itemPaymentBreakdownByIndex.get(itemIndex) ?? [];
                        const isItemPaid = paidItemIndexSet.has(itemIndex);
                        const itemPaymentPresentation = getItemPaymentPresentation(itemIndex);
                        const shouldShowItemPaymentState =
                          paymentMethodPresentation === 'split' ||
                          paymentStatus === 'partially_paid' ||
                          paidItemIndices.length > 0;
                        const withoutLabel = t('menu.itemModal.without', { defaultValue: 'Without' });
                        const littleLabel = t('menu.itemModal.little', { defaultValue: 'Little' });

                        return (
                          <div
                            key={item.id || index}
                            className={`rounded-[24px] border px-4 py-4 transition-colors ${
                              shouldShowItemPaymentState && isItemPaid
                                ? 'border-green-500/20 bg-green-500/8'
                                : 'border-zinc-200/70 bg-white/70 dark:border-white/10 dark:bg-white/[0.04]'
                            }`}
                          >
                            {/* Item Header */}
                            <div className="flex items-start justify-between mb-2">
                              <div className="flex items-start gap-3 flex-1">
                                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border border-orange-300/60 bg-orange-50 text-sm font-bold text-orange-700 dark:border-orange-500/25 dark:bg-orange-500/10 dark:text-orange-200">
                                  {item.quantity || 1}x
                                </div>
                                <div className="flex-1">
                                  {/* Category name above item */}
                                  {categoryPath && (
                                    <div className="text-[10px] uppercase tracking-wider font-medium mb-0.5 liquid-glass-modal-text-muted">
                                      {categoryPath}
                                    </div>
                                  )}
                                  {/* Item name (subcategory) */}
                                  <div className="text-lg font-semibold liquid-glass-modal-text">
                                    {item.name || item.item_name || item.menu_item_name || item.menu_item?.name || 'Item'}
                                  </div>
                                  {shouldShowItemPaymentState && (
                                    <div className="mt-1 space-y-1.5">
                                      <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                                        isItemPaid
                                          ? itemPaymentPresentation === 'card'
                                            ? 'bg-blue-500/15 text-blue-300 border border-blue-500/30'
                                            : itemPaymentPresentation === 'split'
                                              ? 'bg-purple-500/15 text-purple-300 border border-purple-500/30'
                                              : 'bg-green-500/15 text-green-300 border border-green-500/30'
                                          : 'bg-amber-500/15 text-amber-300 border border-amber-500/30'
                                      }`}>
                                        {isItemPaid
                                          ? `${t('modals.orderDetails.paid', { defaultValue: 'Paid' })}${itemPaymentPresentation ? ` • ${getPaymentMethodLabel(itemPaymentPresentation).toUpperCase()}` : ''}`
                                          : t('splitPayment.remaining', { defaultValue: 'Remaining' })}
                                      </span>
                                      {itemPayments.length > 1 && (
                                        <div className="space-y-1">
                                          {itemPayments.map((entry, paymentEntryIndex) => (
                                            <div
                                              key={`${itemIndex}-${entry.paymentId || paymentEntryIndex}`}
                                              className="flex flex-wrap items-center gap-2 text-[11px] liquid-glass-modal-text-muted"
                                            >
                                              <span className={`inline-flex items-center rounded-full px-2 py-0.5 font-semibold uppercase tracking-wide ${
                                                entry.method === 'card'
                                                  ? 'border border-blue-500/30 bg-blue-500/15 text-blue-300'
                                                  : 'border border-green-500/30 bg-green-500/15 text-green-300'
                                              }`}>
                                                {getPaymentMethodLabel(entry.method)}
                                              </span>
                                              <span>{formatCurrency(entry.itemAmount)}</span>
                                              {entry.paymentOrigin === 'terminal' && (
                                                <span className="text-cyan-300">
                                                  {t('splitPayment.terminalApproved', { defaultValue: 'Terminal' })}
                                                </span>
                                              )}
                                              {entry.createdAt && (
                                                <span>
                                                  {formatTime(new Date(entry.createdAt), { hour: '2-digit', minute: '2-digit' })}
                                                </span>
                                              )}
                                            </div>
                                          ))}
                                        </div>
                                      )}
                                    </div>
                                  )}
                                </div>
                              </div>
                              <div className="text-right">
                                <div className="text-lg font-semibold liquid-glass-modal-text">
                                  {formatCurrency(item.total_price || item.price || 0)}
                                </div>
                                <div className="text-xs liquid-glass-modal-text-muted">
                                  @ {formatCurrency(item.unit_price || item.price || 0)}
                                </div>
                              </div>
                            </div>

                            {/* Customizations/Ingredients */}
                            {customizations.length > 0 && (
                              <div className="ml-14 mt-3 space-y-2">
                                {/* Added ingredients */}
                                {customizations.filter(c => !c.isWithout).length > 0 && (
                                  <div className="space-y-1 rounded-2xl border border-emerald-200/70 bg-emerald-50/70 px-3 py-3 dark:border-emerald-500/15 dark:bg-emerald-500/[0.06]">
                                    {customizations.filter(c => !c.isWithout).map((c, idx) => (
                                      <div key={`add-${idx}`} className="flex justify-between text-xs">
                                        <span className="flex items-center gap-1 liquid-glass-modal-text-muted">
                                          <span className="text-emerald-500">+</span> {c.name}{c.isLittle ? ` (${littleLabel})` : ''}
                                        </span>
                                        {c.price > 0 && (
                                          <span className="font-medium text-emerald-600 dark:text-emerald-300">+{formatCurrency(c.price)}</span>
                                        )}
                                      </div>
                                    ))}
                                  </div>
                                )}
                                {/* Without ingredients */}
                                {customizations.filter(c => c.isWithout).length > 0 && (
                                  <div className="mt-1 space-y-1 rounded-2xl border border-red-200/70 bg-red-50/70 px-3 py-3 dark:border-red-500/15 dark:bg-red-500/[0.06]">
                                    <div className="text-[11px] font-semibold uppercase tracking-wide text-red-700 dark:text-red-300">{withoutLabel}</div>
                                    {customizations.filter(c => c.isWithout).map((c, idx) => (
                                      <div key={`without-${idx}`} className="flex justify-between text-xs text-red-600 dark:text-red-300">
                                        <span className="line-through">- {c.name}</span>
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </div>
                            )}

                            {/* Item Notes */}
                            {itemNotes && (
                              <div className="ml-14 mt-3 flex items-center gap-1 text-xs italic liquid-glass-modal-text-muted">
                                <FileText className="w-3 h-3" />
                                <span>{itemNotes}</span>
                              </div>
                            )}
                          </div>
                        );
                      })
                    ) : (
                      <div className="text-center py-8 liquid-glass-modal-text-muted">
                        {t('modals.orderDetails.noItems') || 'No items in order'}
                      </div>
                    )}
                  </div>

                  {/* Totals Section */}
                  <div className={`${insetPanelClass} mt-6 space-y-2 px-5 py-5`}>
                    <div className="flex justify-between text-sm liquid-glass-modal-text-muted">
                      <span>{t('modals.orderDetails.subtotal') || 'Subtotal'}</span>
                      <div className="flex items-center gap-2">
                        {discountAmount > 0 && (
                          <span className="line-through text-xs text-zinc-400">{formatCurrency(originalSubtotal)}</span>
                        )}
                        <span>{formatCurrency(subtotal)}</span>
                      </div>
                    </div>
                    {tax > 0 && (
                      <div className="flex justify-between text-sm liquid-glass-modal-text-muted">
                        <span>{t('modals.orderDetails.tax') || 'Tax'}</span>
                        <span>{formatCurrency(tax)}</span>
                      </div>
                    )}
                    {deliveryFee > 0 && (
                      <div className="flex justify-between text-sm liquid-glass-modal-text-muted">
                        <span>{t('modals.orderDetails.deliveryFee') || 'Delivery Fee'}</span>
                        <span>{formatCurrency(deliveryFee)}</span>
                      </div>
                    )}
                    {discountAmount > 0 && (
                      <div className="flex justify-between text-sm font-medium text-emerald-600 dark:text-emerald-300">
                        <span>
                          {t('modals.orderDetails.discount') || 'Discount'}
                          {discountPercentage > 0 && ` (${discountPercentage}%)`}
                        </span>
                        <span>-{formatCurrency(discountAmount)}</span>
                      </div>
                    )}
                    <div className="flex justify-between items-end border-t border-dashed border-zinc-300 pt-3 dark:border-white/10">
                      <span className="text-lg font-bold liquid-glass-modal-text">
                        {t('modals.orderDetails.total') || 'Total'}
                      </span>
                      <span className="text-3xl font-bold tracking-tight text-blue-600 dark:text-blue-300">
                        {formatCurrency(total)}
                      </span>
                    </div>
                  </div>

                </div>
              </div>
            </div>
          </div>
        )}
      </div>

    </LiquidGlassModal>

    {showRefundModal && (
      <RefundVoidModal
        isOpen={showRefundModal}
        onClose={() => setShowRefundModal(false)}
        orderId={orderId}
        orderTotal={total}
        onRefundComplete={() => {
          // Reload order data to reflect updated payment status
          if (orderId && !order) {
            loadOrderData();
          }
          void loadPaymentState();
        }}
      />
    )}

    {/* Split Payment Modal for existing orders with pending/partially_paid status */}
    {showSplitPaymentModal && (
      <SplitPaymentModal
        isOpen={showSplitPaymentModal}
        onClose={() => setShowSplitPaymentModal(false)}
        orderId={orderId}
        orderTotal={total}
        items={buildSplitPaymentItems({
          items: items.map((item: any, index: number) => ({
            name: item.name || item.item_name || '',
            quantity: item.quantity || 1,
            totalPrice:
              item.total_price ||
              item.totalPrice ||
              ((item.price || item.unit_price || 0) * (item.quantity || 1)),
            price: item.price || item.unit_price || 0,
            itemIndex: item.itemIndex ?? item.item_index ?? index,
          })),
          orderTotal: total,
          deliveryFee,
          discountAmount,
          taxAmount: tax,
          deliveryFeeLabel: t('payment.fields.deliveryFee', { defaultValue: 'Delivery Fee' }),
          discountLabel: t('modals.payment.discount', { defaultValue: 'Discount' }),
          taxLabel: t('modals.orderDetails.tax', { defaultValue: 'Tax' }),
          adjustmentLabel: t('splitPayment.adjustment', { defaultValue: 'Adjustment' }),
        })}
        initialMode="by-items"
        isGhostOrder={isGhostOrder}
        onSplitComplete={handleSplitComplete}
      />
    )}
    </>
  );
};

export default OrderDetailsModal;
