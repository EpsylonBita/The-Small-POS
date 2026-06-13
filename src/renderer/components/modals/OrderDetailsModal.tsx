import React, { useState, useEffect, useMemo, useRef } from "react";
import { useTranslation } from 'react-i18next';
import { useTheme } from '../../contexts/theme-context';
import { LiquidGlassModal } from '../ui/pos-glass-components';
import { Package, MapPin, User, Clock, CreditCard, ChevronRight, X, Printer, Truck, Phone, FileText, History, Banknote, Smartphone, RotateCcw, Split } from 'lucide-react';
import { toast } from 'react-hot-toast';
import { getOrderStatusBadgeClasses } from '../../utils/orderStatus';
import {
  formatCompactOrderNumberForDisplay,
  getVisibleOrderNumber,
} from '../../utils/orderNumberUtils';
import { formatCurrency, formatDate, formatTime } from '../../utils/format';
import { normalizeOrderTypeForDisplay } from '../../utils/orderDisplay';
import RefundVoidModal from './RefundVoidModal';
import { SplitPaymentModal } from './SplitPaymentModal';
import type { SplitPaymentResult } from './SplitPaymentModal';
import { getBridge } from '../../../lib';
import { buildSplitPaymentItems } from '../../utils/splitPaymentItems';
import { menuService, type Ingredient, type MenuCategory, type MenuItem } from '../../services/MenuService';

interface OrderDetailsModalProps {
  isOpen: boolean;
  orderId: string;
  order?: any;
  onClose: () => void;
  onPrintReceipt?: () => void;
  onShowCustomerHistory?: (customerPhone: string) => void;
  openPaymentOnMount?: boolean;
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

function isSystemGeneratedServiceNote(note: string): boolean {
  return /^kiosk source\s*:/i.test(note);
}

interface OrderCatalogLookups {
  menuItemsById: Map<string, {
    name: string;
    categoryId: string;
    categoryName: string;
  }>;
  categoriesById: Map<string, string>;
  ingredientsById: Map<string, Ingredient>;
}

function createEmptyOrderCatalogLookups(): OrderCatalogLookups {
  return {
    menuItemsById: new Map(),
    categoriesById: new Map(),
    ingredientsById: new Map(),
  };
}

function readOrderDetailsString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }

    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const record = value as Record<string, unknown>;
      const nested = readOrderDetailsString(
        record.name,
        record.name_en,
        record.name_el,
        record.base,
        record.en,
        record.el,
        record.label,
      );
      if (nested) {
        return nested;
      }
    }
  }

  return '';
}

function readOrderDetailsNumber(...values: unknown[]): number {
  for (const value of values) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      return numeric;
    }
  }
  return 0;
}

function buildOrderCatalogLookups(
  menuItems: MenuItem[],
  menuCategories: MenuCategory[],
  ingredients: Ingredient[],
): OrderCatalogLookups {
  const categoriesById = new Map(
    menuCategories.map((category) => [
      String(category.id),
      readOrderDetailsString(category.name, category.name_en, category.name_el),
    ]),
  );

  return {
    categoriesById,
    menuItemsById: new Map(
      menuItems.map((item) => {
        const categoryId = readOrderDetailsString(item.category_id, item.category);
        return [
          String(item.id),
          {
            name: readOrderDetailsString(item.name, item.name_en, item.name_el),
            categoryId,
            categoryName:
              categoriesById.get(categoryId) ||
              readOrderDetailsString((item as any).category_name, (item as any).categoryName),
          },
        ];
      }),
    ),
    ingredientsById: new Map(ingredients.map((ingredient) => [String(ingredient.id), ingredient])),
  };
}

function getOrderItemMenuItemId(item: any): string {
  return readOrderDetailsString(
    item?.menu_item_id,
    item?.menuItemId,
    item?.menu_item?.id,
    item?.menuItem?.id,
    item?.subcategory_id,
  );
}

function parseOrderCustomizationCandidate(customizations: any): any {
  if (typeof customizations !== 'string') {
    return customizations;
  }

  const trimmed = customizations.trim();
  if (!trimmed) {
    return null;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function flattenOrderCustomizationEntry(entry: any, isWithout = false): any[] {
  if (!entry) return [];
  if (typeof entry === 'string') return [{ name: entry, isWithout }];
  if (Array.isArray(entry)) return entry.flatMap((value) => flattenOrderCustomizationEntry(value, isWithout));
  if (typeof entry !== 'object') return [];

  if (Array.isArray(entry.ingredients) && !entry.ingredient && !entry.ingredient_id && !entry.ingredientId) {
    return entry.ingredients.flatMap((ingredient: any) =>
      flattenOrderCustomizationEntry(
        {
          ...ingredient,
          group_id: ingredient?.group_id ?? entry.id,
          group_name: ingredient?.group_name ?? entry.name,
        },
        isWithout || entry.isWithout === true || entry.is_without === true,
      ),
    );
  }

  return [
    {
      ...entry,
      isWithout: isWithout || entry.isWithout === true || entry.is_without === true,
    },
  ];
}

function flattenOrderCustomizationInput(customizations: any): any[] {
  const parsed = parseOrderCustomizationCandidate(customizations);
  if (!parsed) return [];
  if (Array.isArray(parsed)) return parsed.flatMap((entry) => flattenOrderCustomizationEntry(entry));
  if (typeof parsed !== 'object') return [];

  const groupedEntries = [
    parsed.added,
    parsed.selected,
    parsed.ingredients,
    parsed.items,
    parsed.groups,
  ]
    .filter(Array.isArray)
    .flatMap((entries) => flattenOrderCustomizationEntry(entries));
  const removedEntries = Array.isArray(parsed.removed)
    ? flattenOrderCustomizationEntry(parsed.removed, true)
    : [];

  if (groupedEntries.length > 0 || removedEntries.length > 0) {
    return [...groupedEntries, ...removedEntries];
  }

  return Object.values(parsed).flatMap((entry) => flattenOrderCustomizationEntry(entry));
}

const OrderDetailsModal: React.FC<OrderDetailsModalProps> = ({
  isOpen,
  orderId,
  order,
  onClose,
  onPrintReceipt,
  openPaymentOnMount = false,
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
  const [catalogLookups, setCatalogLookups] = useState<OrderCatalogLookups>(() => createEmptyOrderCatalogLookups());
  const paymentAutoOpenKeyRef = useRef<string | null>(null);

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

  useEffect(() => {
    if (!isOpen) {
      setCatalogLookups(createEmptyOrderCatalogLookups());
      return;
    }

    let cancelled = false;

    const loadCatalogLookups = async () => {
      const [menuItemsResult, categoriesResult, ingredientsResult] = await Promise.allSettled([
        menuService.getMenuItems(),
        menuService.getMenuCategories(),
        menuService.getIngredients(),
      ]);

      if (cancelled) {
        return;
      }

      setCatalogLookups(
        buildOrderCatalogLookups(
          menuItemsResult.status === 'fulfilled' ? menuItemsResult.value : [],
          categoriesResult.status === 'fulfilled' ? categoriesResult.value : [],
          ingredientsResult.status === 'fulfilled' ? ingredientsResult.value : [],
        ),
      );

      if (
        menuItemsResult.status === 'rejected' ||
        categoriesResult.status === 'rejected' ||
        ingredientsResult.status === 'rejected'
      ) {
        console.warn('[OrderDetailsModal] Failed to load one or more menu lookup sources', {
          menuItems: menuItemsResult.status,
          categories: categoriesResult.status,
          ingredients: ingredientsResult.status,
        });
      }
    };

    void loadCatalogLookups();

    return () => {
      cancelled = true;
    };
  }, [isOpen]);

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

  const getPaymentStatusLabel = (value: string) => {
    switch (value?.toLowerCase()) {
      case 'paid':
        return t('modals.orderDetails.paid', { defaultValue: 'Paid' });
      case 'completed':
        return t('modals.orderDetails.completed', { defaultValue: 'Completed' });
      case 'partially_paid':
        return t('payment.split.partiallyPaid', { defaultValue: 'Partially Paid' });
      case 'cancelled':
      case 'canceled':
        return t('modals.orderDetails.cancelled', { defaultValue: 'Cancelled' });
      case 'pending':
      default:
        return t('modals.orderDetails.pending', { defaultValue: 'Pending' });
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

  const getOrderStatusLabel = (value: string) => {
    switch (value?.toLowerCase()) {
      case 'cancelled':
      case 'canceled':
        return t('modals.orderDetails.cancelled', { defaultValue: 'Cancelled' });
      case 'completed':
        return t('modals.orderDetails.completed', { defaultValue: 'Completed' });
      case 'delivered':
        return t('modals.orderDetails.delivered', { defaultValue: 'Delivered' });
      case 'ready':
        return t('modals.orderDetails.ready', { defaultValue: 'Ready' });
      case 'out_for_delivery':
        return t('modals.orderDetails.outForDelivery', { defaultValue: 'Out for delivery' });
      case 'preparing':
      case 'processing':
        return t('modals.orderDetails.processing', { defaultValue: 'Processing' });
      case 'confirmed':
        return t('modals.orderDetails.confirmed', { defaultValue: 'Confirmed' });
      case 'pending':
      default:
        return t('modals.orderDetails.pending', { defaultValue: 'Pending' });
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
  const rawCustomerName = customer.name || displayOrder.customer_name || displayOrder.customerName || '';
  const customerPhone = customer.phone || displayOrder.customer_phone || displayOrder.customerPhone || '';
  const customerEmail = customer.email || displayOrder.customer_email || displayOrder.customerEmail || '';
  const normalizedCustomerPhone = String(customerPhone || '').replace(/\D+/g, '');

  const normalizeText = (value: any): string => typeof value === 'string' ? value.trim() : '';
  const hasRealCustomerIdentity = Boolean(
    normalizeText(rawCustomerName) ||
    normalizeText(customerPhone) ||
    normalizeText(customerEmail),
  );
  const customerIdentityName =
    normalizeText(rawCustomerName) ||
    t('modals.orderDetails.guestCustomer', { defaultValue: 'Guest' });
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
  const normalizedOrderStatus = String(displayOrder.status || 'pending').toLowerCase();
  const isCancelledOrder = normalizedOrderStatus === 'cancelled' || normalizedOrderStatus === 'canceled';
  const displayStatus = isCancelledOrder ? 'cancelled' : normalizedOrderStatus;
  const displayStatusLabel = getOrderStatusLabel(displayStatus);
  const status = displayStatus;
  // Reason text supplied at cancel time. Stored on either snake_case or
  // camelCase depending on which sync layer wrote the row, so check both.
  const cancellationReason = String(
    displayOrder.cancellation_reason
    || displayOrder.cancellationReason
    || '',
  ).trim();
  const cancellationReasonDisplay =
    cancellationReason ||
    t('modals.orderDetails.reasonNotRecorded', { defaultValue: 'Reason not recorded' });
  const paymentMethod = displayOrder.payment_method || displayOrder.paymentMethod || '';
  const paymentStatus = String(displayOrder.payment_status || displayOrder.paymentStatus || 'pending').toLowerCase();
  const cancelledAt =
    displayOrder.cancelled_at || displayOrder.cancelledAt || displayOrder.updated_at || displayOrder.updatedAt || '';
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
  const rawDisplayOrderNumber = getVisibleOrderNumber(displayOrder) || orderId;
  const displayOrderNumber = formatCompactOrderNumberForDisplay(
    rawDisplayOrderNumber,
    displayOrder.created_at || displayOrder.createdAt,
  );
  const createdDateTimeLabel = `${formatDate(createdAt)} ${formatTime(createdAt, { hour: '2-digit', minute: '2-digit' })}`;
  const primaryAddressLine = deliveryAddress.address || t('modals.orderDetails.noAddress', { defaultValue: 'No address' });
  const totalItemCount = items.reduce((sum: number, item: any) => sum + Number(item?.quantity || 1), 0);
  const serviceNotes = [
    displayOrder.notes,
    displayOrder.customer_notes,
    displayOrder.customerNotes,
    displayOrder.special_instructions,
    displayOrder.specialInstructions,
  ]
    .map((note) => normalizeText(note))
    .filter(
      (note, index, array) =>
        Boolean(note) &&
        !isSystemGeneratedServiceNote(note) &&
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
    const customizationEntries = flattenOrderCustomizationInput(customizations);
    if (customizationEntries.length === 0) return [];

    const getCatalogIngredient = (c: any): Ingredient | undefined => {
      const ingredientId = readOrderDetailsString(
        c?.ingredient?.id,
        c?.ingredient_id,
        c?.ingredientId,
        c?.id,
        c?.customizationId,
        c?.optionId,
      );
      return ingredientId ? catalogLookups.ingredientsById.get(ingredientId) : undefined;
    };

    const extractPrice = (c: any): number => {
      // Check ingredient object first
      if (c.ingredient) {
        const ing = c.ingredient;
        const pickupPrice = readOrderDetailsNumber(ing.pickup_price);
        const deliveryPrice = readOrderDetailsNumber(ing.delivery_price);
        const price = readOrderDetailsNumber(ing.price);
        const basePrice = readOrderDetailsNumber(ing.base_price);

        // Return appropriate price based on order type
        if (orderType === 'delivery' && deliveryPrice > 0) return deliveryPrice;
        if (orderType === 'pickup' && pickupPrice > 0) return pickupPrice;
        if (price > 0) return price;
        if (basePrice > 0) return basePrice;
      }

      const catalogIngredient = getCatalogIngredient(c);
      if (catalogIngredient) {
        const pickupPrice = readOrderDetailsNumber(catalogIngredient.pickup_price);
        const deliveryPrice = readOrderDetailsNumber(catalogIngredient.delivery_price);
        const dineInPrice = readOrderDetailsNumber(catalogIngredient.dine_in_price);
        const price = readOrderDetailsNumber(catalogIngredient.price);

        if (orderType === 'delivery' && deliveryPrice > 0) return deliveryPrice;
        if (orderType === 'pickup' && pickupPrice > 0) return pickupPrice;
        if (orderType === 'dine-in' && dineInPrice > 0) return dineInPrice;
        if (price > 0) return price;
      }

      // Check direct price fields
      const directPrice = readOrderDetailsNumber(c.price);
      const additionalPrice = readOrderDetailsNumber(c.additionalPrice);
      const extraPrice = readOrderDetailsNumber(c.extra_price);

      if (directPrice > 0) return directPrice;
      if (additionalPrice > 0) return additionalPrice;
      if (extraPrice > 0) return extraPrice;

      return 0;
    };

    const extractName = (c: any): string => {
      const catalogIngredient = getCatalogIngredient(c);
      return (
        readOrderDetailsString(
          c.ingredient?.name,
          c.ingredient?.name_en,
          c.ingredient?.name_el,
          c.ingredient_name,
          c.ingredientName,
          c.name,
          c.name_en,
          c.name_el,
          c.optionName,
          c.label,
          catalogIngredient?.name,
          catalogIngredient?.name_en,
          catalogIngredient?.name_el,
        ) || 'Unknown'
      );
    };

    // Check if item is "without" (removed ingredient)
    const isWithoutItem = (c: any): boolean => {
      return c.isWithout === true || c.is_without === true || c.without === true;
    };
    const isLittleItem = (c: any): boolean => {
      return c.isLittle === true || c.is_little === true || c.little === true;
    };

    return customizationEntries
      .filter((c: any) => c && extractName(c) !== 'Unknown')
      .map((c: any) => ({
        name: extractName(c),
        price: isWithoutItem(c) ? 0 : extractPrice(c),
        isWithout: isWithoutItem(c),
        isLittle: isLittleItem(c)
      }));
  };

  const resolveCategoryPath = (item: any): string => {
    const menuItemId = getOrderItemMenuItemId(item);
    const catalogMenuItem = menuItemId ? catalogLookups.menuItemsById.get(menuItemId) : undefined;
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
      catalogMenuItem?.categoryName ||
      catalogLookups.categoriesById.get(readOrderDetailsString(item?.category_id, item?.categoryId)) ||
      '';
    const normalizedCategory = typeof category === 'string' ? category.trim() : '';
    if (normalizedCategory) return normalizedCategory;

    const fallbackSubcategory =
      item?.subcategory_name ||
      item?.subcategoryName ||
      item?.sub_category_name ||
      item?.subCategoryName ||
      catalogMenuItem?.name ||
      '';
    return typeof fallbackSubcategory === 'string' ? fallbackSubcategory.trim() : '';
  };

  const resolveItemName = (item: any): string => {
    const menuItemId = getOrderItemMenuItemId(item);
    const catalogMenuItem = menuItemId ? catalogLookups.menuItemsById.get(menuItemId) : undefined;
    return (
      readOrderDetailsString(
        item?.name,
        item?.item_name,
        item?.menu_item_name,
        item?.menuItemName,
        item?.menu_item?.name,
        item?.menuItem?.name,
        catalogMenuItem?.name,
      ) || 'Item'
    );
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

  const canRefund = paymentStatus === 'paid' || paymentStatus === 'completed';
  const canSplitPayment = !isCancelledOrder && (paymentStatus === 'pending' || paymentStatus === 'partially_paid');

  useEffect(() => {
    if (!isOpen) {
      paymentAutoOpenKeyRef.current = null;
      return;
    }

    if (!openPaymentOnMount || !canSplitPayment) {
      return;
    }

    const autoOpenKey = `${orderId}:${paymentStatus}`;
    if (paymentAutoOpenKeyRef.current === autoOpenKey) {
      return;
    }

    paymentAutoOpenKeyRef.current = autoOpenKey;
    setShowSplitPaymentModal(true);
  }, [canSplitPayment, isOpen, openPaymentOnMount, orderId, paymentStatus]);

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
      footer={modalFooter}
    >
      <div className="relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-6 pb-6 pt-16 scrollbar-hide">
        <button
          onClick={onClose}
          className="absolute right-4 top-3 z-20 flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border border-zinc-200/70 bg-white/80 text-zinc-700 shadow-sm transition-colors hover:bg-white dark:border-white/10 dark:bg-white/[0.05] dark:text-zinc-200 dark:hover:bg-white/[0.08]"
          aria-label={t('common.actions.close')}
        >
          <X className="h-6 w-6" />
        </button>
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
              <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className={mutedEyebrowClass}>
                    {t('modals.orderDetails.orderInformation', { defaultValue: 'Order Information' })}
                  </div>
                  <h3 className="mt-2 text-2xl font-bold tracking-tight liquid-glass-modal-text">
                    {displayOrderNumber}
                  </h3>
                </div>
                <span className={`inline-flex items-center rounded-full border px-4 py-2 text-sm font-semibold ${getStatusColor(displayStatus)}`}>
                  {displayStatusLabel}
                </span>
              </div>

              {isCancelledOrder ? (
                <div className="mb-5 rounded-2xl border border-red-500/70 bg-black px-6 py-7 text-center shadow-[0_18px_50px_rgba(0,0,0,0.28)]">
                  <div className="flex items-center justify-center gap-2 text-sm font-bold uppercase tracking-[0.24em] text-red-400">
                    <RotateCcw className="h-4 w-4" />
                    {t('modals.orderDetails.cancellationReason', { defaultValue: 'Cancellation Reason' })}
                  </div>
                  <p className="mt-4 whitespace-pre-line text-2xl font-bold leading-9 text-white">
                    {cancellationReasonDisplay}
                  </p>
                </div>
              ) : null}

              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                <div className={`${insetPanelClass} px-4 py-4`}>
                  <div className="flex items-center gap-3">
                    <span className={`flex h-5 w-5 shrink-0 items-center justify-center ${
                      isDeliveryOrder
                        ? 'text-orange-500 dark:text-orange-300'
                        : 'text-blue-600 dark:text-blue-300'
                    }`}>
                      {isDeliveryOrder ? <Truck className="h-5 w-5" /> : <Clock className="h-5 w-5" />}
                    </span>
                    <div className="min-w-0">
                      <div className={mutedEyebrowClass}>{t('modals.orderDetails.orderType', { defaultValue: 'Order Type' })}</div>
                      <div className="mt-1 text-lg font-semibold liquid-glass-modal-text">{getOrderTypeLabel(orderType)}</div>
                    </div>
                  </div>
                </div>

                <div className={`${insetPanelClass} px-4 py-4`}>
                  <div className="flex items-center gap-3">
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center text-sky-600 dark:text-sky-300">
                      <Clock className="h-5 w-5" />
                    </span>
                    <div className="min-w-0">
                      <div className={mutedEyebrowClass}>{t('modals.orderDetails.createdAt', { defaultValue: 'Created' })}</div>
                      <div className="mt-1 text-base font-semibold liquid-glass-modal-text">{createdDateTimeLabel}</div>
                    </div>
                  </div>
                </div>

                <div className={`${insetPanelClass} px-4 py-4`}>
                  <div className="flex items-center gap-3">
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center text-emerald-600 dark:text-emerald-300">
                      {getPaymentMethodIcon(paymentMethodPresentation)}
                    </span>
                    <div className="min-w-0">
                      <div className={mutedEyebrowClass}>{t('modals.orderDetails.paymentMethod', { defaultValue: 'Payment Method' })}</div>
                      <div className="mt-1 text-lg font-semibold liquid-glass-modal-text">{getPaymentMethodLabel(paymentMethodPresentation)}</div>
                      <div className="text-sm capitalize liquid-glass-modal-text-muted">
                        {t('modals.orderDetails.paymentStatus', { defaultValue: 'Payment status' })}: {getPaymentStatusLabel(paymentStatus)}
                      </div>
                    </div>
                  </div>
                </div>

                <div className={`${insetPanelClass} px-4 py-4`}>
                  <div className="flex items-center gap-3">
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center text-violet-600 dark:text-violet-300">
                      <Package className="h-5 w-5" />
                    </span>
                    <div className="min-w-0">
                      <div className={mutedEyebrowClass}>{t('modals.orderDetails.total', { defaultValue: 'Total' })}</div>
                      <div className="mt-1 text-2xl font-bold tracking-tight liquid-glass-modal-text">{formatCurrency(total)}</div>
                      <div className="text-sm liquid-glass-modal-text-muted">
                        {totalItemCount} {t('modals.orderDetails.orderItems', { defaultValue: 'Items' })}
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {hasRealCustomerIdentity || (isDeliveryOrder && hasDeliveryAddress) || serviceNotes.length > 0 || (isDeliveryOrder && hasDriverAssignment) ? (
                <div className="mt-4 grid gap-3 lg:grid-cols-2">
                  {hasRealCustomerIdentity ? (
                    <div className={`${insetPanelClass} px-4 py-4`}>
                      <div className="mb-3 flex items-center gap-2 text-sm font-bold uppercase tracking-[0.22em] liquid-glass-modal-text-muted">
                        <User className="h-4 w-4" />
                        {t('modals.orderDetails.customerInformation', { defaultValue: 'Customer' })}
                      </div>
                      <div className="text-lg font-semibold liquid-glass-modal-text">{customerIdentityName}</div>
                      {customerPhone ? (
                        <div className="mt-2 flex items-center gap-2 text-sm liquid-glass-modal-text-muted">
                          <Phone className="h-3.5 w-3.5" />
                          {customerPhone}
                        </div>
                      ) : null}
                      {customerEmail ? (
                        <div className="mt-1 text-sm liquid-glass-modal-text-muted">{customerEmail}</div>
                      ) : null}
                    </div>
                  ) : null}

                  {isDeliveryOrder && hasDeliveryAddress ? (
                    <div className={`${insetPanelClass} px-4 py-4`}>
                      <div className="mb-3 flex items-center gap-2 text-sm font-bold uppercase tracking-[0.22em] liquid-glass-modal-text-muted">
                        <MapPin className="h-4 w-4" />
                        {t('modals.orderDetails.deliveryAddress', { defaultValue: 'Delivery Address' })}
                      </div>
                      <p className="whitespace-pre-line text-base font-semibold leading-7 liquid-glass-modal-text">
                        {primaryAddressLine}
                      </p>
                      {[deliveryAddress.city, deliveryAddress.postal_code, deliveryAddress.floor, deliveryAddress.name_on_ringer]
                        .filter(Boolean)
                        .join(' | ') ? (
                        <div className="mt-2 text-sm liquid-glass-modal-text-muted">
                          {[deliveryAddress.city, deliveryAddress.postal_code, deliveryAddress.floor, deliveryAddress.name_on_ringer]
                            .filter(Boolean)
                            .join(' | ')}
                        </div>
                      ) : null}
                      {deliveryAddress.notes ? (
                        <div className="mt-3 rounded-2xl border border-amber-200 bg-amber-50/90 px-4 py-3 text-sm text-amber-900 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-100">
                          {deliveryAddress.notes}
                        </div>
                      ) : null}
                    </div>
                  ) : null}

                  {isDeliveryOrder && hasDriverAssignment ? (
                    <div className={`${insetPanelClass} px-4 py-4`}>
                      <div className="mb-3 flex items-center gap-2 text-sm font-bold uppercase tracking-[0.22em] liquid-glass-modal-text-muted">
                        <Truck className="h-4 w-4" />
                        {t('modals.orderDetails.deliveryFulfillment', { defaultValue: 'Delivery Fulfillment' })}
                      </div>
                      <div className="text-lg font-semibold liquid-glass-modal-text">
                        {driverName || t('modals.orderDetails.unknownDriver', { defaultValue: 'Unknown Driver' })}
                      </div>
                      <div className="mt-1 text-sm liquid-glass-modal-text-muted">
                        {isDelivered
                          ? t('modals.orderDetails.deliveredBy', { defaultValue: 'Delivered By' })
                          : t('modals.orderDetails.assignedDriver', { defaultValue: 'Assigned Driver' })}
                      </div>
                    </div>
                  ) : null}

                  {serviceNotes.length > 0 ? (
                    <div className={`${insetPanelClass} px-4 py-4`}>
                      <div className="mb-3 flex items-center gap-2 text-sm font-bold uppercase tracking-[0.22em] liquid-glass-modal-text-muted">
                        <FileText className="h-4 w-4" />
                        {t('modals.orderDetails.serviceNotes', { defaultValue: 'Service Notes' })}
                      </div>
                      <div className="space-y-2">
                        {serviceNotes.map((note) => (
                          <div key={note} className="rounded-2xl border border-zinc-200/70 bg-zinc-50/90 px-4 py-3 text-sm liquid-glass-modal-text dark:border-white/10 dark:bg-white/5">
                            {note}
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </section>

            <section className={`${shellPanelClass} flex flex-col p-6`}>
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
                        const customizations = parseCustomizations(
                          item.customizations ?? item.modifiers ?? item.ingredients ?? item.selectedIngredients
                        );
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
                                <div className="min-w-8 shrink-0 pt-0.5 text-sm font-bold text-orange-600 dark:text-orange-200">
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
                                    {resolveItemName(item)}
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
                                  {formatCurrency(item.unit_price || item.price || 0)}
                                </div>
                              </div>
                            </div>

                            {/* Customizations/Ingredients */}
                            {customizations.length > 0 && (
                              <div className="ml-11 mt-3 space-y-2">
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
                              <div className="ml-11 mt-3 flex items-center gap-1 text-xs italic liquid-glass-modal-text-muted">
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
                      <span className="text-3xl font-bold tracking-tight text-yellow-500 dark:text-yellow-300">
                        {formatCurrency(total)}
                      </span>
                    </div>
                  </div>

            </section>

            <section className={`${shellPanelClass} p-6`}>
              <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <History className="h-4 w-4 liquid-glass-modal-text-muted" />
                  <div className={mutedEyebrowClass}>
                    {t('modals.orderDetails.orderHistory', { defaultValue: 'Order History' })}
                  </div>
                </div>
                {historyLoading ? (
                  <div className="h-4 w-4 animate-spin rounded-full border border-zinc-300 border-t-zinc-700 dark:border-zinc-700 dark:border-t-zinc-200" />
                ) : normalizedCustomerPhone ? (
                  <span className="text-xs font-semibold text-emerald-600 dark:text-emerald-300">
                    {t('modals.orderDetails.customerOrderIndex', {
                      count: repeatOrderCount || 1,
                      defaultValue: 'Order #{{count}}',
                    })}
                  </span>
                ) : null}
              </div>

              {normalizedCustomerPhone ? (
                <div className="space-y-4">
                  <div className={`${insetPanelClass} px-4 py-4`}>
                    <div className="text-sm font-semibold liquid-glass-modal-text">
                      {repeatOrderCount > 1
                        ? t('modals.orderDetails.previousOrdersCount', {
                          count: repeatOrderCount - 1,
                          defaultValue: '{{count}} previous orders on this phone',
                        })
                        : t('modals.orderDetails.firstOrder', { defaultValue: 'First recorded order' })}
                    </div>
                    {customerPhone ? (
                      <div className="mt-1 text-sm liquid-glass-modal-text-muted">{customerPhone}</div>
                    ) : null}
                  </div>

                  <div className="space-y-2">
                    {recentOrders.length > 0 ? (
                      recentOrders.map((historyOrder) => {
                        const historyStatus = String(historyOrder.status || 'pending').toLowerCase();
                        return (
                          <div
                            key={`${historyOrder.id || historyOrder.order_number || historyOrder.orderNumber}-${historyOrder.created_at || historyOrder.createdAt || ''}`}
                            className="flex items-center justify-between gap-3 rounded-2xl border border-zinc-200/70 bg-zinc-50/90 px-4 py-3 dark:border-white/10 dark:bg-white/5"
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
                              <span className={`inline-flex items-center rounded-full border px-2 py-1 text-[10px] font-semibold ${getStatusColor(historyStatus)}`}>
                                {getOrderStatusLabel(historyStatus)}
                              </span>
                              <span className="text-sm font-semibold liquid-glass-modal-text">
                                {formatCurrency(Number(historyOrder.total_amount || historyOrder.totalAmount || 0))}
                              </span>
                              <ChevronRight className="h-4 w-4 liquid-glass-modal-text-muted" />
                            </div>
                          </div>
                        );
                      })
                    ) : (
                      <div className="rounded-2xl border border-dashed border-zinc-200 px-4 py-5 text-sm liquid-glass-modal-text-muted dark:border-white/10">
                        {t('modals.orderDetails.noRecentOrders', { defaultValue: 'No previous orders found' })}
                      </div>
                    )}
                  </div>
                </div>
              ) : (
                <div className="rounded-2xl border border-dashed border-zinc-200 px-4 py-5 text-sm liquid-glass-modal-text-muted dark:border-white/10">
                  {t('modals.orderDetails.noCustomerHistory', { defaultValue: 'No customer history available' })}
                </div>
              )}
            </section>
          </div>
        )}

        {/* Cancellation reason — visible whenever the order is cancelled. */}
        {String(status).toLowerCase() === 'cancelled' ? (
          <div className="mt-4 rounded-2xl border border-rose-300/70 bg-rose-50/80 p-4 dark:border-rose-700/70 dark:bg-rose-950/30">
            <div className="text-xs font-semibold uppercase tracking-wider text-rose-700 dark:text-rose-300">
              {t('modals.orderDetails.cancellation.title', { defaultValue: 'Cancellation' })}
            </div>
            <div className="mt-1 text-sm text-rose-900 dark:text-rose-100">
              <span className="font-medium">
                {t('modals.orderDetails.cancellation.reasonLabel', { defaultValue: 'Reason' })}:
              </span>{' '}
              {cancellationReason ||
                t('modals.orderDetails.cancellation.reasonMissing', {
                  defaultValue: 'Reason not recorded',
                })}
            </div>
            {cancelledAt ? (
              <div className="mt-1 text-xs text-rose-700/80 dark:text-rose-300/80">
                <span className="font-medium">
                  {t('modals.orderDetails.cancellation.cancelledAtLabel', {
                    defaultValue: 'Cancelled at',
                  })}
                  :
                </span>{' '}
                {formatDate(cancelledAt)}
              </div>
            ) : null}
          </div>
        ) : null}
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
