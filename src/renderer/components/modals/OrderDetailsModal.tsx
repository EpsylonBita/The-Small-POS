import React, { useState, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useTranslation } from 'react-i18next';
import { useTheme } from '../../contexts/theme-context';
import { LiquidGlassModal } from '../ui/pos-glass-components';
import { Package, MapPin, User, Clock, CreditCard, ChevronRight, X, Printer, Truck, Phone, FileText, History, Banknote, Smartphone, RotateCcw, Split, Copy, Edit3, Mail, Loader2 } from 'lucide-react';
import { toast } from 'react-hot-toast';
import { getOrderStatusBadgeClasses } from '../../utils/orderStatus';
import {
  formatCompactOrderNumberForDisplay,
  getVisibleOrderNumber,
} from '../../utils/orderNumberUtils';
import { formatCurrency, formatDate, formatTime } from '../../utils/format';
import { normalizeOrderTypeForDisplay } from '../../utils/orderDisplay';
import { resolveTableServiceCustomerNumber } from '../../utils/tableOrderFlow';
import { resolveStrikethroughSubtotal } from '../../utils/orderSummary';
import {
  PlatformHeldPaymentNotice,
  usePlatformHeldNotice,
} from '../ui/PlatformHeldPaymentNotice';
import RefundVoidModal, { type RefundCompleteDetail } from './RefundVoidModal';
import { UnsavedChargedPaymentBanner } from '../ui/UnsavedChargedPaymentBanner';
import { useUnsavedChargedPayments } from '../../utils/unsavedPayments';
import { SplitPaymentModal } from './SplitPaymentModal';
import type { SplitPaymentResult } from './SplitPaymentModal';
import { getBridge } from '../../../lib';
import { buildSplitPaymentItems } from '../../utils/splitPaymentItems';
import { readPrintedVatAmount } from '../../utils/printedVat';
import { menuService, type Ingredient, type MenuCategory, type MenuItem } from '../../services/MenuService';
import { AddCustomerModal } from './AddCustomerModal';
import { isGiftCardPayment } from '../../lib/gift-card-returns';
import {
  boxClosedReasonLabelKey,
  isBoxDecisionClosed,
  isBoxManualCheckRequired,
  isBoxOrder,
  readBoxDisplayItems,
} from '../order/box-order-decision';
import { isExternalDeliveryPlatform } from '../../../../../shared/platforms/order-platforms';

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

/** True only when the bridge answered with rows `unwrapBridgeArray` can read. */
function isBridgeArray(result: any): boolean {
  return Array.isArray(result) || Array.isArray(result?.data);
}

/**
 * A delivery-platform order whose structured items are missing, by the same rule
 * the native food print readiness uses (`has_usable_food_order_items`): at least
 * one row, and every row has a name and a positive quantity.
 */
function platformOrderItemsMissing(order: any): boolean {
  if (!isExternalDeliveryPlatform(order?.plugin ?? order?.platform)) {
    return false;
  }
  let rows: unknown = order?.items;
  if (typeof rows === 'string') {
    try {
      rows = JSON.parse(rows);
    } catch {
      return true;
    }
  }
  if (!Array.isArray(rows) || rows.length === 0) {
    return true;
  }
  return !rows.every((row) => {
    if (!row || typeof row !== 'object') {
      return false;
    }
    const item = row as Record<string, unknown>;
    const nameKey = ['name', 'itemName', 'menu_item_name', 'title'].find((key) => item[key] !== undefined);
    const name = nameKey ? item[nameKey] : undefined;
    const rawQuantity = item.quantity;
    const quantity =
      typeof rawQuantity === 'string' && rawQuantity.trim() ? Number(rawQuantity.trim()) : rawQuantity;
    return (
      typeof name === 'string' &&
      name.trim().length > 0 &&
      typeof quantity === 'number' &&
      Number.isFinite(quantity) &&
      quantity > 0
    );
  });
}

function isSystemGeneratedServiceNote(note: string): boolean {
  return /^kiosk source\s*:/i.test(note);
}

function formatCustomerAddressForCopy(address: any): string {
  return [
    readOrderDetailsString(address?.street_address, address?.street, address?.address),
    readOrderDetailsString(address?.city),
    readOrderDetailsString(address?.postal_code, address?.postalCode),
    readOrderDetailsString(address?.floor_number, address?.floor),
    readOrderDetailsString(address?.name_on_ringer, address?.nameOnRinger),
    readOrderDetailsString(address?.notes, address?.delivery_notes),
  ]
    .filter(Boolean)
    .join(', ');
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
    // Platform orders mirror server rows where customizations is an object
    // wrapping the actual list ({modifiers:[...], external_sku, platform_source})
    // — only the modifiers are materials; the metadata keys must never render.
    parsed.modifiers,
  ]
    .filter(Array.isArray)
    .flatMap((entries) => flattenOrderCustomizationEntry(entries));
  const removedEntries = Array.isArray(parsed.removed)
    ? flattenOrderCustomizationEntry(parsed.removed, true)
    : [];

  if (groupedEntries.length > 0 || removedEntries.length > 0) {
    return [...groupedEntries, ...removedEntries];
  }

  // A platform item without materials still carries the metadata-only wrapper
  // ({platform_source, external_sku}) — the legacy catch-all below would
  // render those values as «+ 1440683243» / «+ efood» lines, so bail out.
  if ('platform_source' in parsed || 'external_sku' in parsed) {
    return [];
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
  const [showCustomerCard, setShowCustomerCard] = useState(false);
  const [customerProfile, setCustomerProfile] = useState<any>(null);
  const [customerProfileLoading, setCustomerProfileLoading] = useState(false);
  const [editingAddressId, setEditingAddressId] = useState<string | null>(null);
  const [catalogLookups, setCatalogLookups] = useState<OrderCatalogLookups>(() => createEmptyOrderCatalogLookups());
  const paymentAutoOpenKeyRef = useRef<string | null>(null);
  // Net paid and outstanding of an order with a gift card row, from the native settlement read.
  const [giftSettlement, setGiftSettlement] = useState<
    { orderId: string; netPaid: number; outstanding: number } | 'unavailable' | null
  >(null);
  const giftSettlementRequestRef = useRef(0);
  // After a confirmed gift return: the order's reread, until all its reads succeeded.
  const [giftRefresh, setGiftRefresh] = useState<
    { orderId: string; status: 'running' | 'failed' | 'ok' } | null
  >(null);
  const giftRefreshRequestRef = useRef(0);
  const orderReadRequestRef = useRef(0);
  const paymentReadRequestRef = useRef(0);
  // The newest order read of this view; a superseded read answers with it.
  const latestOrderReadRef = useRef<Promise<boolean>>(Promise.resolve(false));
  // The order this modal shows now: late reads for another order are dropped.
  const currentOrderIdRef = useRef(orderId);
  useLayoutEffect(() => {
    currentOrderIdRef.current = orderId;
  }, [orderId]);
  // One open view of one order. Close, reopen and order switches start a new epoch,
  // so a held read from an earlier view publishes nothing.
  const viewEpochRef = useRef(0);
  useLayoutEffect(() => {
    viewEpochRef.current += 1;
  }, [isOpen, orderId]);
  const isCurrentView = (epoch: number, targetOrderId: string) =>
    viewEpochRef.current === epoch && currentOrderIdRef.current === targetOrderId;

  useEffect(() => {
    if (!isOpen) {
      setOrderData(null);
      setGiftSettlement(null);
      setGiftRefresh(null);
      setOrderPayments([]);
      setPaidItems([]);
      setCustomerOrders([]);
      setLoading(false);
      setHistoryLoading(false);
      setShowCustomerCard(false);
      setCustomerProfile(null);
      setCustomerProfileLoading(false);
      setEditingAddressId(null);
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

  /**
   * Resolves true only when this view's newest read hydrated the order. A read that
   * a newer one superseded in the same view answers with the newer read's outcome.
   */
  const loadOrderData = (targetOrderId = orderId): Promise<boolean> => {
    const read = readOrderData(targetOrderId);
    latestOrderReadRef.current = read;
    return read;
  };

  // Opening a delivery-platform order whose items never arrived asks the native
  // item fetch once per open view. Native persists them under the order's own
  // identity and releases a food print waiting for them; this view then shows
  // them from a fresh local read, never from the fetch reply alone.
  const platformItemRefreshEpochRef = useRef(-1);
  const refreshMissingPlatformItems = async (targetOrderId: string, epoch: number) => {
    if (platformItemRefreshEpochRef.current === epoch) {
      return;
    }
    platformItemRefreshEpochRef.current = epoch;
    try {
      const fetched = unwrapBridgeArray<unknown>(
        await bridge.orders.fetchItemsFromSupabase(targetOrderId),
      );
      if (fetched.length > 0 && isCurrentView(epoch, targetOrderId)) {
        await loadOrderData(targetOrderId);
      }
    } catch (error) {
      console.warn('[OrderDetailsModal] Refreshing missing platform order items failed:', error);
    }
  };

  const readOrderData = async (targetOrderId: string): Promise<boolean> => {
    if (!targetOrderId) {
      return false;
    }

    const epoch = viewEpochRef.current;
    const request = ++orderReadRequestRef.current;
    const isCurrent = () =>
      orderReadRequestRef.current === request && isCurrentView(epoch, targetOrderId);
    const newer = () => (isCurrentView(epoch, targetOrderId) ? latestOrderReadRef.current : false);
    try {
      setLoading(true);
      const result: any = await bridge.orders.getById(targetOrderId);
      if (!isCurrent()) {
        return newer();
      }
      const hydratedOrder =
        result?.success === false ? null : result?.order ?? result?.data ?? result;
      if (hydratedOrder) {
        setOrderData(hydratedOrder);
        if (platformOrderItemsMissing(hydratedOrder)) {
          void refreshMissingPlatformItems(targetOrderId, epoch);
        }
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
        return true;
      }
      return false;
    } catch (error) {
      console.error('Error loading order:', error);
      if (!isCurrent()) {
        return newer();
      }
      toast.error(t('errors.loadOrderFailed') || 'Failed to load order');
      return false;
    } finally {
      // A late read for an order or view no longer shown must not end the current load.
      if (isCurrent()) {
        setLoading(false);
      }
    }
  };

  /** Resolves true only when this view's newest read returned both row sets. */
  const loadPaymentState = async (
    options: { targetOrderId?: string; keepOnFailure?: boolean } = {},
  ): Promise<boolean> => {
    const targetOrderId = options.targetOrderId ?? orderId;
    if (!targetOrderId) {
      setOrderPayments([]);
      setPaidItems([]);
      return false;
    }

    const epoch = viewEpochRef.current;
    const request = ++paymentReadRequestRef.current;
    const isCurrent = () =>
      paymentReadRequestRef.current === request && isCurrentView(epoch, targetOrderId);
    try {
      const [paymentsResult, paidItemsResult] = await Promise.all([
        bridge.payments.getOrderPayments(targetOrderId),
        bridge.payments.getPaidItems(targetOrderId),
      ]);
      if (!isCurrent()) {
        return false;
      }

      const read = isBridgeArray(paymentsResult) && isBridgeArray(paidItemsResult);
      // After a confirmed gift return a failed read keeps the rows it cannot replace.
      if (read || !options.keepOnFailure) {
        setOrderPayments(unwrapBridgeArray<any>(paymentsResult));
        setPaidItems(unwrapBridgeArray<any>(paidItemsResult));
      }
      return read;
    } catch (error) {
      console.error('Error loading order payment state:', error);
      if (!isCurrent()) {
        return false;
      }
      if (!options.keepOnFailure) {
        setOrderPayments([]);
        setPaidItems([]);
      }
      return false;
    }
  };

  // A gift card row's gross amount stops being coverage once part of it went back
  // to the card, so net paid and outstanding come from the native settlement read.
  const loadGiftSettlement = async (targetOrderId: string): Promise<boolean> => {
    const epoch = viewEpochRef.current;
    const request = ++giftSettlementRequestRef.current;
    let next: { orderId: string; netPaid: number; outstanding: number } | 'unavailable' = 'unavailable';
    try {
      const snapshot = await bridge.payments.getSettlementSnapshot(targetOrderId);
      if (
        snapshot?.success === true &&
        snapshot.orderId === targetOrderId &&
        Number.isFinite(snapshot.netPaid) &&
        Number.isFinite(snapshot.outstandingAmount)
      ) {
        next = { orderId: targetOrderId, netPaid: snapshot.netPaid, outstanding: snapshot.outstandingAmount };
      }
    } catch (error) {
      console.error('Error loading order settlement:', error);
    }
    if (giftSettlementRequestRef.current !== request || !isCurrentView(epoch, targetOrderId)) {
      return false;
    }
    setGiftSettlement(next);
    return next !== 'unavailable';
  };

  /**
   * After a confirmed gift card return: reread this exact local order, its payment
   * rows and its settlement even when the dashboard passed an order prop, which
   * predates the return. A completion for an order no longer shown changes nothing.
   * Resolves true only when all three reads of this same view succeeded; otherwise
   * fresh actions stay blocked and a retry is offered.
   */
  const refreshAfterGiftReturn = async (targetOrderId: string): Promise<boolean> => {
    if (!targetOrderId || currentOrderIdRef.current !== targetOrderId) {
      return false;
    }
    const epoch = viewEpochRef.current;
    const request = ++giftRefreshRequestRef.current;
    setGiftRefresh({ orderId: targetOrderId, status: 'running' });
    // Each read reports its own success: a swallowed failure is not a refresh.
    const [orderRead, paymentsRead, settlementRead] = await Promise.all([
      loadOrderData(targetOrderId),
      loadPaymentState({ targetOrderId, keepOnFailure: true }),
      loadGiftSettlement(targetOrderId),
    ]);
    if (giftRefreshRequestRef.current !== request || !isCurrentView(epoch, targetOrderId)) {
      return false;
    }
    const refreshed = orderRead && paymentsRead && settlementRead;
    setGiftRefresh({ orderId: targetOrderId, status: refreshed ? 'ok' : 'failed' });
    return refreshed;
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
      case 'pending':
      case 'unpaid':
      case 'none':
      case 'not_selected':
        return t('modals.orderDetails.pending', { defaultValue: 'Pending' });
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
      case 'card': return <CreditCard className="h-5 w-5 text-slate-400" />;
      case 'cash': return <Banknote className="h-5 w-5 text-green-400" />;
      case 'split':
      case 'mixed': return <Split className="h-5 w-5 text-slate-400" />;
      case 'digital':
      case 'digital_wallet': return <Smartphone className="h-5 w-5 text-slate-400" />;
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
  // A pending BOX order has no order items until BOX confirms the accept; the
  // provider's lines are shown display-only instead: never paid, split or
  // totalled here (the totals stay the order's own).
  const isBox = isBoxOrder(displayOrder);
  const boxDisplayItems = isBox && items.length === 0 ? readBoxDisplayItems(displayOrder) : [];
  const customer = displayOrder.customer || {};
  const orderType = normalizeOrderTypeForDisplay(
    displayOrder.order_type || displayOrder.orderType || 'delivery',
  );

  // Get customer info from various sources (snake_case from prop, camelCase from Rust backend)
  const rawCustomerName = customer.name || displayOrder.customer_name || displayOrder.customerName || '';
  const customerPhone = customer.phone || displayOrder.customer_phone || displayOrder.customerPhone || '';
  const customerEmail = customer.email || displayOrder.customer_email || displayOrder.customerEmail || '';
  const canonicalCustomerId = readOrderDetailsString(
    customer.id,
    displayOrder.customer_id,
    displayOrder.customerId,
  );
  const normalizedCustomerPhone = String(customerPhone || '').replace(/\D+/g, '');

  const normalizeText = (value: any): string => typeof value === 'string' ? value.trim() : '';
  // Table-service orders use the table as the customer; show it through the shared
  // display convention ("Τραπέζι #TB01"), not the raw "Τραπέζι B01" pseudo-label.
  const tableCustomerNumber = resolveTableServiceCustomerNumber(displayOrder);
  const hasRealCustomerIdentity = Boolean(
    tableCustomerNumber ||
    normalizeText(rawCustomerName) ||
    normalizeText(customerPhone) ||
    normalizeText(customerEmail),
  );
  const customerIdentityName = tableCustomerNumber
    ? t('orderFlow.tableCustomer', { table: tableCustomerNumber })
    : normalizeText(rawCustomerName) ||
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
  // The VAT its slip prints (founder rule 07/10/2026): every order stores its
  // computed VAT, which a store without a fiscal plugin or an owner rate never
  // shows. Prices include VAT, so it is never added to the total.
  const tax = readPrintedVatAmount(displayOrder);
  const deliveryFee = displayOrder.delivery_fee ?? displayOrder.deliveryFee ?? 0;
  const discountAmount = displayOrder.discount_amount || displayOrder.discountAmount || 0;
  const discountPercentage = displayOrder.discount_percentage || displayOrder.discountPercentage || 0;
  const total = displayOrder.total || displayOrder.total_amount || displayOrder.totalAmount || 0;
  // Only strike through a pre-discount subtotal when the order carries a REAL,
  // distinct one greater than the displayed subtotal. `subtotal` is already the
  // pre-discount item subtotal, so subtotal + discount would double-count (bogus).
  const reportedOriginalSubtotal = Number(
    (displayOrder as any).original_subtotal ?? (displayOrder as any).originalSubtotal ?? 0,
  ) || 0;
  const strikethroughSubtotal = resolveStrikethroughSubtotal({
    subtotal,
    originalSubtotal: reportedOriginalSubtotal,
  });
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
  // A closed BOX decision is recorded as a code (BOX expired or refused it,
  // or staff closed it here after checking with BOX): staff read its label.
  const boxClosedReasonKey = boxClosedReasonLabelKey(cancellationReason);
  const cancellationReasonLabel = boxClosedReasonKey
    ? t(boxClosedReasonKey, { defaultValue: cancellationReason })
    : cancellationReason;
  const cancellationReasonDisplay =
    cancellationReasonLabel ||
    t('modals.orderDetails.reasonNotRecorded', { defaultValue: 'Reason not recorded' });
  // The server closed this pending BOX order's decision: it takes no accept
  // or decline any more, and with an unknown outcome staff check it with BOX.
  const isBoxDecisionClosedPending =
    isBox && normalizedOrderStatus === 'pending' && isBoxDecisionClosed(displayOrder);
  const isBoxManualCheck = isBoxDecisionClosedPending && isBoxManualCheckRequired(displayOrder);
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
    const completedPaymentMethods = new Set(
      completedPayments
        .map((payment: any) => String(payment?.method || payment?.payment_method || '').toLowerCase().trim())
        .filter(Boolean),
    );

    if (completedPaymentMethods.size > 1) {
      return 'split';
    }
    if (completedPaymentMethods.size === 1) {
      return Array.from(completedPaymentMethods)[0];
    }
    if (normalizedMethod === 'split' || normalizedMethod === 'mixed') {
      return 'split';
    }
    // A kiosk order is settled by staff at the till, so it never has a
    // completed payment row and the derived method comes back as 'pending' —
    // which showed the operator «Εκκρεμεί» instead of what the customer chose.
    // The kiosk records that choice in ghost_metadata.
    if (!normalizedMethod || normalizedMethod === 'pending') {
      const metadata = parseOrderCustomizationCandidate(
        displayOrder.ghost_metadata ?? displayOrder.ghostMetadata,
      );
      const kiosk =
        metadata && typeof metadata === 'object' && !Array.isArray(metadata)
          ? (metadata as Record<string, any>).kiosk
          : null;
      const intent = String(
        (kiosk && (kiosk.paymentMethod ?? kiosk.payment_method)) || '',
      )
        .toLowerCase()
        .trim();
      if (intent) {
        return intent;
      }
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
  const totalItemCount = (items.length > 0 ? items : boxDisplayItems)
    .reduce((sum: number, item: any) => sum + Number(item?.quantity || 1), 0);
  // A BOX order with no lines to render keeps the ingest's item text: it is
  // all staff have of what was ordered.
  const keepsItemsTextFallback = isBox && items.length === 0 && boxDisplayItems.length === 0;
  const serviceNotes = [
    displayOrder.notes,
    displayOrder.customer_notes,
    displayOrder.customerNotes,
    displayOrder.special_instructions,
    displayOrder.specialInstructions,
  ]
    .map((note) => normalizeText(note))
    // The platform ingest appends a "--- Order Items ---" text fallback for
    // legacy tokenless clients; the items render structured above, so only the
    // customer's own words belong in the notes panel.
    .map((note) => {
      const marker = note.indexOf('--- Order Items ---');
      return marker >= 0 && !keepsItemsTextFallback ? note.slice(0, marker).trim() : note;
    })
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
    'text-[11px] font-semibold liquid-glass-modal-text-muted';

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
      }))
      // Sandbox feeds ship junk materials (a literal ","); a material must
      // carry at least one letter or digit to render.
      .filter((c) => /[\p{L}\p{N}]/u.test(c.name));
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
  // Gift card rows go back only to their original card. A partial return moves the
  // header to partially_paid, so the entry stays while a completed gift row remains;
  // ordinary refunds keep the paid/completed rule.
  const hasGiftPaymentRow = orderPayments.some((payment: any) => isGiftCardPayment(payment?.method));
  const canGiftReturn =
    !canRefund && completedPayments.some((payment: any) => isGiftCardPayment(payment?.method));
  const showRefundEntry = canRefund || canGiftReturn;
  // Until the reread after a confirmed gift return succeeded, no fresh action starts here.
  const giftRefreshBlocked =
    giftRefresh !== null && giftRefresh.orderId === orderId && giftRefresh.status !== 'ok';
  const giftRefreshFailed =
    giftRefresh !== null && giftRefresh.orderId === orderId && giftRefresh.status === 'failed';

  useEffect(() => {
    if (!isOpen || !orderId || !hasGiftPaymentRow) {
      setGiftSettlement(null);
      return;
    }
    void loadGiftSettlement(orderId);
  }, [isOpen, orderId, hasGiftPaymentRow]);

  // Presentation for money the platform is holding (prepaid online, or COD its
  // own rider collected). Read from the order's disposition through the shared
  // collectability logic — NOT from `payment_status`, which a failed
  // settlement honestly lowers to `pending` at exactly the moment the operator
  // most needs to be told not to collect (founder request, 16/09/2026).
  const platformHeldOrder = useMemo(
    () => ({
      id: orderId,
      platform: displayOrder.plugin ?? displayOrder.platform ?? null,
      externalPlatformOrderId:
        displayOrder.external_plugin_order_id ?? displayOrder.externalPluginOrderId ?? null,
      ghostMetadata: displayOrder.ghost_metadata ?? displayOrder.ghostMetadata ?? null,
    }),
    [displayOrder, orderId],
  );
  const platformHeldNotice = usePlatformHeldNotice(platformHeldOrder);
  // A card of this order charged on this till whose payment is not saved yet
  // (30/09/2026): said here too, after a restart, with Save payment again;
  // no new collection is offered while it stands.
  const unsaved = useUnsavedChargedPayments(orderId, isOpen, t, formatCurrency, () => {
    void loadPaymentState();
  });

  // The collect action is hidden for platform-held money, and the banner below
  // says why. The write paths refuse it anyway; this keeps the operator from
  // meeting that refusal as an error with a customer waiting.
  const canSplitPayment =
    !isCancelledOrder &&
    platformHeldNotice === null &&
    unsaved.payments.length === 0 &&
    !giftRefreshBlocked &&
    (paymentStatus === 'pending' || paymentStatus === 'partially_paid');

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
    (showRefundEntry ? 1 : 0) +
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

  const orderCustomerFallback = {
    ...customer,
    id: canonicalCustomerId || customer.id,
    name: normalizeText(rawCustomerName),
    phone: normalizeText(customerPhone),
    email: normalizeText(customerEmail),
    addresses: Array.isArray(customer.addresses) ? customer.addresses : [],
  };
  const canOpenCustomerCard = !tableCustomerNumber && Boolean(canonicalCustomerId || customerPhone);
  const customerProfileAddresses = Array.isArray(customerProfile?.addresses)
    && customerProfile.addresses.length > 0
    ? customerProfile.addresses
    : customerProfile && formatCustomerAddressForCopy(customerProfile)
      ? [customerProfile]
      : [];

  const copyText = async (text: string, successMessage: string) => {
    if (!text.trim()) {
      return;
    }
    try {
      await bridge.clipboard.writeText(text);
      toast.success(successMessage);
    } catch (error) {
      console.error('[OrderDetailsModal] Failed to copy customer information', error);
      toast.error(t('modals.orderDetails.copyFailed', { defaultValue: 'Could not copy details' }));
    }
  };

  const copyCustomerDetails = async (profile = customerProfile || orderCustomerFallback) => {
    const addresses = Array.isArray(profile?.addresses) ? profile.addresses : [];
    const lines = [
      readOrderDetailsString(profile?.name, customerIdentityName),
      profile?.phone
        ? `${t('modals.orderDetails.phone', { defaultValue: 'Phone' })}: ${profile.phone}`
        : '',
      profile?.email
        ? `${t('modals.orderDetails.email', { defaultValue: 'Email' })}: ${profile.email}`
        : '',
      ...addresses
        .map((address: any, index: number) => {
          const formatted = formatCustomerAddressForCopy(address);
          return formatted
            ? `${t('modals.orderDetails.addressNumber', {
                defaultValue: 'Address {{number}}',
                number: index + 1,
              })}: ${formatted}`
            : '';
        })
        .filter(Boolean),
    ].filter(Boolean);

    await copyText(
      lines.join('\n'),
      t('modals.orderDetails.customerCopied', { defaultValue: 'Customer details copied' }),
    );
  };

  const openCustomerCard = async () => {
    setShowCustomerCard(true);
    setCustomerProfile(orderCustomerFallback);
    setCustomerProfileLoading(true);

    try {
      let resolvedCustomer: any = null;
      if (canonicalCustomerId) {
        const result: any = await bridge.customers.lookupById(canonicalCustomerId);
        resolvedCustomer = result?.customer ?? result?.data ?? result;
      }
      if (!resolvedCustomer && customerPhone) {
        const result: any = await bridge.customers.lookupByPhone(customerPhone);
        resolvedCustomer = result?.customer ?? result?.data ?? result;
      }
      if (resolvedCustomer) {
        setCustomerProfile({
          ...orderCustomerFallback,
          ...resolvedCustomer,
          addresses: Array.isArray(resolvedCustomer.addresses)
            ? resolvedCustomer.addresses
            : orderCustomerFallback.addresses,
        });
      }
    } catch (error) {
      console.warn('[OrderDetailsModal] Customer profile lookup failed; using order snapshot', error);
    } finally {
      setCustomerProfileLoading(false);
    }
  };

  const modalFooter = (
    <div className="flex-shrink-0 border-t liquid-glass-modal-border bg-white/85 px-6 py-4 backdrop-blur-xl dark:bg-black/30">
      <div className={`grid gap-3 ${footerGridCols}`}>
        {onPrintReceipt && (
          <button
            onClick={onPrintReceipt}
            className="flex min-h-[52px] w-full items-center justify-center gap-2 rounded-2xl border border-zinc-200/70 bg-white/90 px-4 text-sm font-semibold text-zinc-900 transition active:bg-white dark:border-white/10 dark:bg-white/[0.05] dark:text-zinc-100 dark:active:bg-white/[0.08]"
          >
            <Printer className="h-4 w-4" />
            {t('modals.orderDetails.printReceipt') || 'Print Receipt'}
          </button>
        )}
        {canSplitPayment && (
          <button
            onClick={() => setShowSplitPaymentModal(true)}
            className="flex min-h-[52px] w-full items-center justify-center gap-2 rounded-2xl border border-amber-300/60 bg-amber-50 px-4 text-sm font-semibold text-amber-700 transition active:bg-amber-100 dark:border-amber-500/25 dark:bg-amber-500/10 dark:text-amber-200 dark:active:bg-amber-500/15"
          >
            <Split className="h-4 w-4" />
            {t('payment.split.title', { defaultValue: 'Split Payment' })}
          </button>
        )}
        {showRefundEntry && (
          <button
            data-testid="order-details-void-refund"
            onClick={() => setShowRefundModal(true)}
            disabled={giftRefreshBlocked}
            className="flex min-h-[52px] w-full items-center justify-center gap-2 rounded-2xl border border-red-300/70 bg-red-50 px-4 text-sm font-semibold text-red-700 transition active:bg-red-100 disabled:opacity-50 dark:border-red-500/25 dark:bg-red-500/10 dark:text-red-200 dark:active:bg-red-500/15"
          >
            <RotateCcw className="h-4 w-4" />
            {canRefund
              ? t('modals.orderDetails.voidRefund', { defaultValue: 'Void / Refund' })
              : t('modals.refund.gift.action', { defaultValue: 'Return to gift card' })}
          </button>
        )}
        <button
          onClick={onClose}
          className="flex min-h-[52px] w-full items-center justify-center gap-2 rounded-2xl border border-zinc-300/80 bg-zinc-100 px-4 text-sm font-semibold text-zinc-700 transition active:bg-zinc-200 dark:border-white/10 dark:bg-zinc-900/80 dark:text-zinc-100 dark:active:bg-zinc-800"
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
      className="!w-[92vw] !max-w-6xl !max-h-[96vh]"
      contentClassName="p-0 !pt-0 overflow-hidden"
      ariaLabel={t('modals.orderDetails.title', { defaultValue: 'Order Details' })}
      footer={modalFooter}
    >
      <div className="relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-6 pt-16 pb-24 scroll-pb-24 scrollbar-hide">
        <button
          onClick={onClose}
          className="absolute right-4 top-3 z-20 flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border border-zinc-200/70 bg-white/80 text-zinc-700 shadow-sm transition-colors active:bg-white dark:border-white/10 dark:bg-white/[0.05] dark:text-zinc-200 dark:active:bg-white/[0.08]"
          aria-label={t('common.actions.close')}
        >
          <X className="h-6 w-6" />
        </button>
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <div className={`h-12 w-12 animate-spin rounded-full border-2 ${
              isDarkTheme
                ? 'border-white/15 border-t-yellow-400'
                : 'border-zinc-200 border-t-amber-500'
            }`}></div>
          </div>
        ) : (
          <div className="space-y-4">

            <section className={`${shellPanelClass} overflow-hidden p-5`}>
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
                  <div className="flex items-center justify-center gap-2 text-sm font-bold text-red-400">
                    <RotateCcw className="h-4 w-4" />
                    {t('modals.orderDetails.cancellationReason', { defaultValue: 'Cancellation Reason' })}
                  </div>
                  <p className="mt-4 whitespace-pre-line text-2xl font-bold leading-9 text-white">
                    {cancellationReasonDisplay}
                  </p>
                </div>
              ) : null}

              {isBoxDecisionClosedPending ? (
                <div
                  role="status"
                  data-testid="order-details-box-decision-closed"
                  className="mb-5 rounded-2xl border border-amber-300/70 bg-amber-50/90 px-5 py-4 dark:border-amber-500/30 dark:bg-amber-500/10"
                >
                  {isBoxManualCheck ? (
                    <>
                      <div className="text-sm font-bold text-amber-800 dark:text-amber-200">
                        {t('boxOrder.manualCheckTitle', { defaultValue: 'Check this order with BOX' })}
                      </div>
                      <p className="mt-1 text-sm text-amber-900 dark:text-amber-100">
                        {t('boxOrder.manualCheck', {
                          defaultValue: 'BOX did not confirm this order in time and may still have accepted it. Check with BOX before you prepare it or close it here.',
                        })}
                      </p>
                    </>
                  ) : (
                    <p className="text-sm font-semibold text-amber-900 dark:text-amber-100">
                      {t('boxOrder.decisionClosed', {
                        defaultValue: 'BOX has closed this order. It can no longer be accepted or declined here.',
                      })}
                    </p>
                  )}
                </div>
              ) : null}

              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                <div className={`${insetPanelClass} px-4 py-3`}>
                  <div className="flex items-center gap-3">
                    <span className={`flex h-5 w-5 shrink-0 items-center justify-center ${
                      isDeliveryOrder
                        ? 'text-orange-500 dark:text-orange-300'
                        : 'text-slate-600 dark:text-slate-300'
                    }`}>
                      {isDeliveryOrder ? <Truck className="h-5 w-5" /> : <Clock className="h-5 w-5" />}
                    </span>
                    <div className="min-w-0">
                      <div className={mutedEyebrowClass}>{t('modals.orderDetails.orderType', { defaultValue: 'Order Type' })}</div>
                      <div className="mt-1 text-lg font-semibold liquid-glass-modal-text">{getOrderTypeLabel(orderType)}</div>
                    </div>
                  </div>
                </div>

                <div className={`${insetPanelClass} px-4 py-3`}>
                  <div className="flex items-center gap-3">
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center text-slate-600 dark:text-slate-300">
                      <Clock className="h-5 w-5" />
                    </span>
                    <div className="min-w-0">
                      <div className={mutedEyebrowClass}>{t('modals.orderDetails.createdAt', { defaultValue: 'Created' })}</div>
                      <div className="mt-1 text-base font-semibold liquid-glass-modal-text">{createdDateTimeLabel}</div>
                    </div>
                  </div>
                </div>

                <div className={`${insetPanelClass} px-4 py-3`}>
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
                      {hasGiftPaymentRow && (
                        <div data-testid="order-details-net-coverage" className="text-sm liquid-glass-modal-text-muted">
                          {giftSettlement && giftSettlement !== 'unavailable' && giftSettlement.orderId === orderId
                            ? t('modals.refund.gift.netCoverage', {
                                paid: formatCurrency(giftSettlement.netPaid),
                                outstanding: formatCurrency(giftSettlement.outstanding),
                              })
                            : giftSettlement === 'unavailable'
                              ? t('modals.refund.gift.netCoverageUnavailable')
                              : t('modals.refund.gift.netCoverageLoading')}
                        </div>
                      )}
                      {giftRefreshFailed && (
                        <div data-testid="order-details-gift-refresh-failed" role="alert" className="mt-2 space-y-2 text-sm text-red-600 dark:text-red-300">
                          <p>{t('modals.refund.gift.orderRefreshFailed')}</p>
                          <button
                            type="button"
                            data-testid="order-details-gift-refresh-retry"
                            onClick={() => void refreshAfterGiftReturn(orderId)}
                            className="min-h-[44px] rounded-xl border border-red-300/70 bg-red-50 px-3 font-semibold text-red-700 active:bg-red-100 dark:border-red-500/25 dark:bg-red-500/10 dark:text-red-200"
                          >
                            {t('modals.refund.gift.retry')}
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                  {/* Right under the status the operator reads before deciding
                      to collect. `payment_status` alone cannot say this: a
                      failed settlement leaves it `pending`, which looks
                      exactly like money still owed. */}
                  <PlatformHeldPaymentNotice order={platformHeldOrder} className="mt-3" />
                  <UnsavedChargedPaymentBanner
                    payments={unsaved.payments}
                    onSaveAgain={unsaved.saveAgain}
                    isSaving={unsaved.isSaving}
                    className="mt-3"
                  />
                </div>

                <div className={`${insetPanelClass} px-4 py-3`}>
                  <div className="flex items-center gap-3">
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center text-slate-600 dark:text-slate-300">
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
                    <div className={`${insetPanelClass} px-4 py-3`}>
                      <div className="mb-3 flex items-center justify-between gap-3">
                        <div className="flex items-center gap-2 text-sm font-bold liquid-glass-modal-text-muted">
                          <User className="h-4 w-4" />
                          {t('modals.orderDetails.customerInformation', { defaultValue: 'Customer' })}
                        </div>
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            void copyCustomerDetails(orderCustomerFallback);
                          }}
                          className="inline-flex h-9 items-center gap-2 rounded-xl border border-zinc-200/70 bg-white/70 px-3 text-xs font-semibold text-zinc-700 active:bg-white dark:border-white/10 dark:bg-white/[0.06] dark:text-zinc-200"
                        >
                          <Copy className="h-3.5 w-3.5" />
                          {t('modals.orderDetails.copyCustomer', { defaultValue: 'Copy' })}
                        </button>
                      </div>
                      <div
                        className={`${canOpenCustomerCard ? 'cursor-pointer active:scale-[0.99]' : ''} transition-transform`}
                        role={canOpenCustomerCard ? 'button' : undefined}
                        tabIndex={canOpenCustomerCard ? 0 : undefined}
                        aria-label={t('modals.orderDetails.openCustomerCard', { defaultValue: 'Open customer card' })}
                        onClick={() => {
                          if (canOpenCustomerCard) {
                            void openCustomerCard();
                          }
                        }}
                        onKeyDown={(event) => {
                          if (canOpenCustomerCard && (event.key === 'Enter' || event.key === ' ')) {
                            event.preventDefault();
                            void openCustomerCard();
                          }
                        }}
                      >
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
                        {canOpenCustomerCard ? (
                          <div className="mt-3 flex items-center gap-1 text-xs font-semibold text-amber-600 dark:text-amber-300">
                            {t('modals.orderDetails.viewCustomerCard', { defaultValue: 'View customer card and addresses' })}
                            <ChevronRight className="h-3.5 w-3.5" />
                          </div>
                        ) : null}
                      </div>
                    </div>
                  ) : null}

                  {isDeliveryOrder && hasDeliveryAddress ? (
                    <div className={`${insetPanelClass} px-4 py-3`}>
                      <div className="mb-3 flex items-center justify-between gap-3">
                        <div className="flex items-center gap-2 text-sm font-bold liquid-glass-modal-text-muted">
                          <MapPin className="h-4 w-4" />
                          {t('modals.orderDetails.deliveryAddress', { defaultValue: 'Delivery Address' })}
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            void copyText(
                              formatCustomerAddressForCopy(deliveryAddress),
                              t('modals.orderDetails.addressCopied', { defaultValue: 'Address copied' }),
                            );
                          }}
                          className="inline-flex h-9 items-center gap-2 rounded-xl border border-zinc-200/70 bg-white/70 px-3 text-xs font-semibold text-zinc-700 active:bg-white dark:border-white/10 dark:bg-white/[0.06] dark:text-zinc-200"
                        >
                          <Copy className="h-3.5 w-3.5" />
                          {t('modals.orderDetails.copyAddress', { defaultValue: 'Copy' })}
                        </button>
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
                    <div className={`${insetPanelClass} px-4 py-3`}>
                      <div className="mb-3 flex items-center gap-2 text-sm font-bold liquid-glass-modal-text-muted">
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
                    <div className={`${insetPanelClass} px-4 py-3`}>
                      <div className="mb-3 flex items-center gap-2 text-sm font-bold liquid-glass-modal-text-muted">
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

            <section className={`${shellPanelClass} flex flex-col p-5`}>
                  <div className="mb-5 flex items-center justify-between gap-3">
                    <h4 className="flex items-center gap-2 text-sm font-bold liquid-glass-modal-text-muted">
                      <Package className="w-4 h-4" />
                      {t('modals.orderDetails.orderItems') || 'Items'}
                    </h4>
                    <span className="rounded-full border border-zinc-200/70 bg-white/70 px-3 py-1 text-xs font-semibold liquid-glass-modal-text dark:border-white/10 dark:bg-white/[0.04]">
                      {totalItemCount}
                    </span>
                  </div>

                  <div className="flex-1 overflow-y-auto space-y-3 scrollbar-hide">
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
                                    <div className="text-[10px] font-medium mb-0.5 liquid-glass-modal-text-muted">
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
                                            ? 'bg-slate-500/15 text-slate-300 border border-slate-500/30'
                                            : itemPaymentPresentation === 'split'
                                              ? 'bg-slate-500/15 text-slate-300 border border-slate-500/30'
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
                                                  ? 'border border-slate-500/30 bg-slate-500/15 text-slate-300'
                                                  : 'border border-green-500/30 bg-green-500/15 text-green-300'
                                              }`}>
                                                {getPaymentMethodLabel(entry.method)}
                                              </span>
                                              <span>{formatCurrency(entry.itemAmount)}</span>
                                              {entry.paymentOrigin === 'terminal' && (
                                                <span className="text-amber-300">
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
                                    <div className="text-[11px] font-semibold text-red-700 dark:text-red-300">{withoutLabel}</div>
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
                    ) : boxDisplayItems.length > 0 ? (
                      boxDisplayItems.map((line, index) => {
                        const added = line.modifiers.filter((modifier) => !modifier.without);
                        const removed = line.modifiers.filter((modifier) => modifier.without);
                        return (
                          <div
                            key={`box-line-${index}`}
                            data-testid="order-details-box-display-line"
                            className="rounded-[24px] border border-zinc-200/70 bg-white/70 px-4 py-4 dark:border-white/10 dark:bg-white/[0.04]"
                          >
                            <div className="flex items-start justify-between mb-2">
                              <div className="flex items-start gap-3 flex-1">
                                <div className="min-w-8 shrink-0 pt-0.5 text-sm font-bold text-orange-600 dark:text-orange-200">
                                  {line.quantity}x
                                </div>
                                <div className="flex-1 text-lg font-semibold liquid-glass-modal-text">
                                  {line.name}
                                </div>
                              </div>
                              <div className="text-right">
                                <div className="text-lg font-semibold liquid-glass-modal-text">
                                  {formatCurrency(line.total_price)}
                                </div>
                                <div className="text-xs liquid-glass-modal-text-muted">
                                  {formatCurrency(line.unit_price)}
                                </div>
                              </div>
                            </div>
                            {added.length > 0 || removed.length > 0 ? (
                              <div className="ml-11 mt-3 space-y-1 text-xs">
                                {added.map((modifier, modifierIndex) => (
                                  <div key={`add-${modifierIndex}`} className="flex justify-between liquid-glass-modal-text-muted">
                                    <span>
                                      <span className="text-emerald-500">+</span> {modifier.name}
                                    </span>
                                    {modifier.price > 0 ? (
                                      <span className="font-medium text-emerald-600 dark:text-emerald-300">
                                        +{formatCurrency(modifier.price)}
                                      </span>
                                    ) : null}
                                  </div>
                                ))}
                                {removed.map((modifier, modifierIndex) => (
                                  <div key={`without-${modifierIndex}`} className="text-red-600 dark:text-red-300">
                                    <span className="line-through">- {modifier.name}</span>
                                  </div>
                                ))}
                              </div>
                            ) : null}
                            {line.notes ? (
                              <div className="ml-11 mt-3 flex items-center gap-1 text-xs italic liquid-glass-modal-text-muted">
                                <FileText className="w-3 h-3" />
                                <span>{line.notes}</span>
                              </div>
                            ) : null}
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
                  <div className={`${insetPanelClass} mt-4 space-y-2 px-5 py-4`}>
                    <div className="flex justify-between text-sm liquid-glass-modal-text-muted">
                      <span>{t('modals.orderDetails.subtotal') || 'Subtotal'}</span>
                      <div className="flex items-center gap-2">
                        {strikethroughSubtotal !== null && (
                          <span className="line-through text-xs text-zinc-400">{formatCurrency(strikethroughSubtotal)}</span>
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

            <section className={`${shellPanelClass} p-5`}>
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
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
                  <div className={`${insetPanelClass} px-4 py-3`}>
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
            <div className="text-xs font-semibold text-rose-700 dark:text-rose-300">
              {t('modals.orderDetails.cancellation.title', { defaultValue: 'Cancellation' })}
            </div>
            <div className="mt-1 text-sm text-rose-900 dark:text-rose-100">
              <span className="font-medium">
                {t('modals.orderDetails.cancellation.reasonLabel', { defaultValue: 'Reason' })}:
              </span>{' '}
              {cancellationReasonLabel ||
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

    <LiquidGlassModal
      isOpen={showCustomerCard}
      onClose={() => {
        setShowCustomerCard(false);
        setEditingAddressId(null);
      }}
      title={t('modals.orderDetails.customerCard', { defaultValue: 'Customer Card' })}
      size="lg"
      contentClassName="p-0 overflow-hidden"
    >
      <div className="max-h-[72vh] overflow-y-auto p-6 scrollbar-hide">
        {customerProfileLoading ? (
          <div className="flex items-center justify-center gap-3 py-12 liquid-glass-modal-text-muted">
            <Loader2 className="h-5 w-5 animate-spin text-amber-500" />
            {t('modals.orderDetails.loadingCustomer', { defaultValue: 'Loading customer' })}
          </div>
        ) : (
          <div className="space-y-5">
            <section className={`${shellPanelClass} p-5`}>
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 text-sm font-bold liquid-glass-modal-text-muted">
                    <User className="h-4 w-4" />
                    {t('modals.orderDetails.customerInformation', { defaultValue: 'Customer' })}
                  </div>
                  <h3 className="mt-2 text-2xl font-bold liquid-glass-modal-text">
                    {readOrderDetailsString(customerProfile?.name, customerIdentityName)}
                  </h3>
                  {customerProfile?.phone ? (
                    <div className="mt-3 flex items-center gap-2 text-sm liquid-glass-modal-text-muted">
                      <Phone className="h-4 w-4 text-amber-500" />
                      <span className="select-text">{customerProfile.phone}</span>
                    </div>
                  ) : null}
                  {customerProfile?.email ? (
                    <div className="mt-2 flex items-center gap-2 text-sm liquid-glass-modal-text-muted">
                      <Mail className="h-4 w-4 text-amber-500" />
                      <span className="select-text">{customerProfile.email}</span>
                    </div>
                  ) : null}
                </div>
                <button
                  type="button"
                  onClick={() => void copyCustomerDetails()}
                  className="inline-flex min-h-11 items-center gap-2 rounded-2xl bg-amber-500 px-4 text-sm font-bold text-black active:bg-amber-400"
                >
                  <Copy className="h-4 w-4" />
                  {t('modals.orderDetails.copyCustomer', { defaultValue: 'Copy customer' })}
                </button>
              </div>
            </section>

            <section className={`${shellPanelClass} p-5`}>
              <div className="mb-4 flex items-center gap-2 text-sm font-bold liquid-glass-modal-text-muted">
                <MapPin className="h-4 w-4" />
                {t('modals.orderDetails.savedAddresses', { defaultValue: 'Saved Addresses' })}
              </div>
              {customerProfileAddresses.length > 0 ? (
                <div className="space-y-3">
                  {customerProfileAddresses.map((address: any, index: number) => {
                    const addressText = formatCustomerAddressForCopy(address);
                    const canEditAddress = Boolean(customerProfile?.id && address?.id);
                    return (
                      <div key={address?.id || `customer-address-${index}`} className={`${insetPanelClass} p-4`}>
                        <div className="flex items-start justify-between gap-4">
                          <div className="min-w-0">
                            <div className="text-xs font-bold liquid-glass-modal-text-muted">
                              {t('modals.orderDetails.addressNumber', {
                                defaultValue: 'Address {{number}}',
                                number: index + 1,
                              })}
                            </div>
                            <p className="mt-2 select-text whitespace-pre-line text-base font-semibold leading-6 liquid-glass-modal-text">
                              {addressText}
                            </p>
                          </div>
                          <div className="flex shrink-0 items-center gap-2">
                            <button
                              type="button"
                              onClick={() => {
                                void copyText(
                                  addressText,
                                  t('modals.orderDetails.addressCopied', { defaultValue: 'Address copied' }),
                                );
                              }}
                              aria-label={t('modals.orderDetails.copyAddress', { defaultValue: 'Copy address' })}
                              className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-zinc-200/70 bg-white/70 text-zinc-700 active:bg-white dark:border-white/10 dark:bg-white/[0.06] dark:text-zinc-200"
                            >
                              <Copy className="h-4 w-4" />
                            </button>
                            {canEditAddress ? (
                              <button
                                type="button"
                                onClick={() => setEditingAddressId(address.id)}
                                className="inline-flex min-h-10 items-center gap-2 rounded-xl bg-amber-500 px-3 text-xs font-bold text-black active:bg-amber-400"
                              >
                                <Edit3 className="h-4 w-4" />
                                {t('modals.orderDetails.editAddress', { defaultValue: 'Edit' })}
                              </button>
                            ) : null}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className={`${insetPanelClass} px-4 py-6 text-center text-sm liquid-glass-modal-text-muted`}>
                  {t('modals.orderDetails.noSavedAddresses', { defaultValue: 'No saved addresses' })}
                </div>
              )}
            </section>
          </div>
        )}
      </div>
    </LiquidGlassModal>

    {editingAddressId && customerProfile ? (
      <AddCustomerModal
        isOpen
        onClose={() => setEditingAddressId(null)}
        onCustomerAdded={(updatedCustomer) => {
          setCustomerProfile(updatedCustomer);
          setEditingAddressId(null);
        }}
        initialCustomer={{
          ...customerProfile,
          phone: customerProfile.phone || customerPhone || '',
          editAddressId: editingAddressId,
        }}
        mode="editAddress"
      />
    ) : null}

    {showRefundModal && (
      <RefundVoidModal
        isOpen={showRefundModal}
        onClose={() => setShowRefundModal(false)}
        orderId={orderId}
        orderTotal={total}
        giftReturnOnly={!canRefund}
        onRefundComplete={(detail?: RefundCompleteDetail) => {
          if (detail?.giftReturn) {
            // Awaited by the gift panel: false keeps fresh returns blocked behind a retry.
            return refreshAfterGiftReturn(detail.giftReturn.orderId);
          }
          // Reload order data to reflect updated payment status
          if (orderId && !order) {
            loadOrderData();
          }
          void loadPaymentState();
          return undefined;
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
          // VAT is inside the item prices: never a separate line to pay.
          deliveryFeeLabel: t('payment.fields.deliveryFee', { defaultValue: 'Delivery Fee' }),
          discountLabel: t('modals.payment.discount', { defaultValue: 'Discount' }),
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
