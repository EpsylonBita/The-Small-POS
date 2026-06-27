import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { motion, AnimatePresence } from 'framer-motion';
import {
  ShoppingBag,
  RefreshCw,
  Search,
  Filter,
  ChevronLeft,
  ChevronRight,
  User,
  Phone,
  Package,
  Truck,
  X,
  RotateCcw,
  Bed
} from 'lucide-react';
import TableOrderIcon from '../components/icons/TableOrderIcon';
import PickupOrderIcon from '../components/icons/PickupOrderIcon';
import { useTheme } from '../contexts/theme-context';
import { toast } from 'react-hot-toast';
import OrderDetailsModal from '../components/modals/OrderDetailsModal';
import { formatCurrency } from '../utils/format';
import { formatCompactOrderNumberForDisplay, resolveMergedOrderNumber } from '../utils/orderNumberUtils';
import { resolveTableServiceCustomerNumber } from '../utils/tableOrderFlow';
import { getBridge, isBrowser, offEvent, onEvent } from '../../lib';

interface OrderItem {
  id: string;
  menu_item_id: string;
  name: string;
  quantity: number;
  price: number;
  unit_price: number;
  total_price: number;
  customizations?: Record<string, any>;
  notes?: string;
}

interface Order {
  id: string;
  order_number: string;
  status: string;
  order_type: string;
  payment_method: string;
  payment_status?: string;
  total_amount: number;
  subtotal?: number;
  tax_amount?: number;
  delivery_fee?: number;
  discount_amount?: number;
  customer_name?: string;
  customer_phone?: string;
  customer_email?: string;
  delivery_address?: string;
  delivery_city?: string;
  delivery_postal_code?: string;
  delivery_floor?: string;
  delivery_notes?: string;
  table_number?: string;
  special_instructions?: string;
  name_on_ringer?: string;
  driver_id?: string;
  driver_name?: string;
  driverId?: string;
  driverName?: string;
  order_items: OrderItem[];
  created_at: string;
  updated_at: string;
  estimated_ready_time?: number;
  sync_status?: string;
  supabase_id?: string;
  client_order_id?: string;
  cancellation_reason?: string;
  cancelled_at?: string;
  source?: 'local' | 'remote';
}

interface FetchOrdersOptions {
  status?: string;
  order_type?: string;
  date_from?: string;
  date_to?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

const asString = (value: any): string | undefined =>
  typeof value === 'string' && value.trim().length > 0 ? value : undefined;

const asNumber = (value: any, fallback = 0): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

const normalizeOrderType = (value: string | undefined): string => {
  const normalized = (value || '').trim().toLowerCase();
  if (!normalized) return 'pickup';
  if (normalized === 'dine_in') return 'dine-in';
  if (normalized === 'takeaway' || normalized === 'takeout') return 'pickup';
  return normalized;
};

const getDisplayOrderNumber = (order: Order): string =>
  formatCompactOrderNumberForDisplay(order.order_number, order.created_at) || order.order_number;

// Per-status PILL skins (background + border + text), light and dark. Data-driven via the `dark:`
// Tailwind variant (darkMode: 'class' + the theme context's root `.dark` toggle) so each status is one
// source of truth -- no per-call isDark branching. Base palette stays white/black/grey/yellow with small
// semantic accents (amber/green/red); unknown statuses fall back to the yellow pending
// skin. No hover utilities: the pill is informational, not an action.
const ORDER_STATUS_PILL_CLASSES: Record<string, string> = {
  pending: 'bg-amber-200 text-amber-900 border-amber-300 dark:bg-amber-400/20 dark:text-amber-200 dark:border-amber-400/45',
  confirmed: 'bg-yellow-200 text-yellow-950 border-yellow-300 dark:bg-yellow-400/20 dark:text-yellow-100 dark:border-yellow-400/45',
  processing: 'bg-zinc-200 text-zinc-900 border-zinc-300 dark:bg-zinc-500/20 dark:text-zinc-100 dark:border-zinc-400/35',
  preparing: 'bg-zinc-200 text-zinc-900 border-zinc-300 dark:bg-zinc-500/20 dark:text-zinc-100 dark:border-zinc-400/35',
  ready: 'bg-green-200 text-green-900 border-green-300 dark:bg-green-400/20 dark:text-green-200 dark:border-green-400/45',
  out_for_delivery: 'bg-amber-300 text-amber-950 border-amber-400 dark:bg-amber-400/25 dark:text-amber-100 dark:border-amber-300/50',
  completed: 'bg-gray-300 text-gray-900 border-gray-400 dark:bg-zinc-600/60 dark:text-zinc-100 dark:border-zinc-500/60',
  delivered: 'bg-gray-300 text-gray-900 border-gray-400 dark:bg-zinc-600/60 dark:text-zinc-100 dark:border-zinc-500/60',
  cancelled: 'bg-red-200 text-red-900 border-red-300 dark:bg-red-400/20 dark:text-red-200 dark:border-red-400/45',
};

const getOrderStatusPillClasses = (status?: string) => {
  const normalized = (status || '').toLowerCase();
  return ORDER_STATUS_PILL_CLASSES[normalized] || ORDER_STATUS_PILL_CLASSES.pending;
};

const ORDER_STATUS_FILTER_OPTIONS = [
  'pending',
  'confirmed',
  'preparing',
  'ready',
  'completed',
  'cancelled',
] as const;

const ORDER_TYPE_FILTER_OPTIONS = ['dine-in', 'pickup', 'delivery'] as const;

const normalizeOrder = (raw: any, source: 'local' | 'remote'): Order | null => {
  if (!raw || typeof raw !== 'object') return null;

  const id = asString(raw.id) || asString(raw.client_order_id) || asString(raw.order_number);
  if (!id) return null;

  const createdAt = asString(raw.created_at) || asString(raw.createdAt) || new Date().toISOString();
  const updatedAt = asString(raw.updated_at) || asString(raw.updatedAt) || createdAt;
  const driverId = asString(raw.driver_id) || asString(raw.driverId);
  const driverName = asString(raw.driver_name) || asString(raw.driverName);
  const orderItems = Array.isArray(raw.order_items)
    ? raw.order_items
    : Array.isArray(raw.items)
      ? raw.items
      : [];

  return {
    id,
    order_number:
      asString(raw.display_order_number) ||
      asString(raw.displayOrderNumber) ||
      asString(raw.order_number) ||
      asString(raw.orderNumber) ||
      id.slice(0, 8),
    status: asString(raw.status) || 'pending',
    order_type: normalizeOrderType(asString(raw.order_type) || asString(raw.orderType)),
    payment_method: asString(raw.payment_method) || asString(raw.paymentMethod) || 'cash',
    payment_status: asString(raw.payment_status) || asString(raw.paymentStatus),
    total_amount: asNumber(raw.total_amount ?? raw.totalAmount, 0),
    subtotal: asNumber(raw.subtotal, 0),
    tax_amount: asNumber(raw.tax_amount ?? raw.taxAmount, 0),
    delivery_fee: asNumber(raw.delivery_fee ?? raw.deliveryFee, 0),
    discount_amount: asNumber(raw.discount_amount ?? raw.discountAmount, 0),
    customer_name: asString(raw.customer_name) || asString(raw.customerName),
    customer_phone: asString(raw.customer_phone) || asString(raw.customerPhone),
    customer_email: asString(raw.customer_email) || asString(raw.customerEmail),
    delivery_address: asString(raw.delivery_address) || asString(raw.deliveryAddress),
    delivery_city: asString(raw.delivery_city) || asString(raw.deliveryCity),
    delivery_postal_code: asString(raw.delivery_postal_code) || asString(raw.deliveryPostalCode),
    delivery_floor: asString(raw.delivery_floor) || asString(raw.deliveryFloor),
    delivery_notes: asString(raw.delivery_notes) || asString(raw.deliveryNotes),
    table_number: asString(raw.table_number) || asString(raw.tableNumber),
    special_instructions: asString(raw.special_instructions) || asString(raw.specialInstructions),
    name_on_ringer: asString(raw.name_on_ringer) || asString(raw.nameOnRinger),
    driver_id: driverId,
    driver_name: driverName,
    driverId,
    driverName,
    order_items: orderItems as OrderItem[],
    created_at: createdAt,
    updated_at: updatedAt,
    estimated_ready_time: raw.estimated_ready_time ?? raw.estimatedTime,
    sync_status: asString(raw.sync_status) || asString(raw.syncStatus),
    supabase_id: asString(raw.supabase_id) || asString(raw.supabaseId),
    client_order_id: asString(raw.client_order_id),
    cancellation_reason: asString(raw.cancellation_reason) || asString(raw.cancellationReason),
    cancelled_at: asString(raw.cancelled_at) || asString(raw.cancelledAt),
    source,
  };
};

const toIdentitySet = (order: Order): Set<string> => {
  const keys = [
    order.id,
    order.supabase_id,
    order.client_order_id,
    order.order_number,
  ]
    .filter((v): v is string => !!v)
    .map((v) => v.trim().toLowerCase());
  return new Set(keys);
};

const sharesIdentity = (a: Order, b: Order): boolean => {
  const aKeys = toIdentitySet(a);
  const bKeys = toIdentitySet(b);
  for (const key of aKeys) {
    if (bKeys.has(key)) return true;
  }
  return false;
};

const isPendingOrQueuedLocal = (order: Order): boolean => {
  const syncStatus = (order.sync_status || '').toLowerCase();
  return order.source === 'local' && (syncStatus === 'pending' || syncStatus === 'queued');
};

const mergeHybridOrders = (localOrders: Order[], remoteOrders: Order[]): Order[] => {
  const merged: Order[] = [];
  const upsert = (incoming: Order) => {
    const index = merged.findIndex((existing) => sharesIdentity(existing, incoming));
    if (index === -1) {
      merged.push(incoming);
      return;
    }

    const existing = merged[index];
    if (isPendingOrQueuedLocal(existing) && incoming.source === 'remote') {
      return;
    }

    const existingTs = new Date(existing.updated_at).getTime();
    const incomingTs = new Date(incoming.updated_at).getTime();
    if (Number.isNaN(existingTs) || incomingTs >= existingTs) {
      merged[index] = {
        ...existing,
        ...incoming,
        order_number: resolveMergedOrderNumber(existing.order_number, incoming.order_number),
      };
    }
  };

  localOrders.forEach(upsert);
  remoteOrders.forEach(upsert);
  return merged;
};

const BACKGROUND_SYNC_REFRESH_MIN_MS = 30000;
const RECOVERY_ORDER_PAYMENT_TARGET_KEY = 'pos-recovery-order-payment-target';

interface RecoveryOrderPaymentTarget {
  orderId: string | null;
  orderNumber: string | null;
  params: Record<string, unknown>;
  createdAt: number;
}

function parseRecoveryOrderPaymentTarget(raw: string | null): RecoveryOrderPaymentTarget | null {
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<RecoveryOrderPaymentTarget>;
    const orderId = typeof parsed.orderId === 'string' && parsed.orderId.trim()
      ? parsed.orderId.trim()
      : null;
    const orderNumber = typeof parsed.orderNumber === 'string' && parsed.orderNumber.trim()
      ? parsed.orderNumber.trim()
      : null;
    if (!orderId && !orderNumber) {
      return null;
    }
    return {
      orderId,
      orderNumber,
      params: parsed.params && typeof parsed.params === 'object' ? parsed.params : {},
      createdAt: typeof parsed.createdAt === 'number' ? parsed.createdAt : Date.now(),
    };
  } catch {
    return null;
  }
}

const OrdersPage: React.FC = () => {
  const { t } = useTranslation();
  const { resolvedTheme } = useTheme();
  const bridge = getBridge();

  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [orders, setOrders] = useState<Order[]>([]);
  const [total, setTotal] = useState(0);
  const [selectedOrder, setSelectedOrder] = useState<Order | null>(null);
  const [openSelectedOrderPayment, setOpenSelectedOrderPayment] = useState(false);
  const [recoveryPaymentTarget, setRecoveryPaymentTarget] =
    useState<RecoveryOrderPaymentTarget | null>(null);
  const recoveryPaymentAttemptKeyRef = useRef<string | null>(null);

  // Filters
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [searchTerm, setSearchTerm] = useState('');
  const [showFilters, setShowFilters] = useState(false);
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [orderTypeFilter, setOrderTypeFilter] = useState<string>('all');

  // Pagination
  const [currentPage, setCurrentPage] = useState(1);
  const pageSize = 20;
  const isDark = resolvedTheme === 'dark';

  const formatMoney = (amount: number) => formatCurrency(amount);

  const applyFilters = useCallback((input: Order[]): Order[] => {
    const search = searchTerm.trim().toLowerCase();
    return input.filter((order) => {
      if (statusFilter !== 'all' && order.status !== statusFilter) return false;
      if (orderTypeFilter !== 'all' && order.order_type !== orderTypeFilter) return false;
      if (dateFrom && order.created_at.slice(0, 10) < dateFrom) return false;
      if (dateTo && order.created_at.slice(0, 10) > dateTo) return false;

      if (!search) return true;
      const displayOrderNumber = getDisplayOrderNumber(order);
      const haystack = [
        order.order_number,
        displayOrderNumber,
        order.customer_name,
        order.customer_phone,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return haystack.includes(search);
    });
  }, [statusFilter, orderTypeFilter, dateFrom, dateTo, searchTerm]);

  const fetchOrders = useCallback(async () => {
    if (isBrowser()) {
      console.error('[OrdersPage] Desktop API not available');
      toast.error('Desktop API not available');
      setLoading(false);
      return;
    }

    setSyncing(true);
    try {
      const remoteOptions: FetchOrdersOptions = { limit: 500, offset: 0 };
      if (statusFilter !== 'all') remoteOptions.status = statusFilter;
      if (orderTypeFilter !== 'all') remoteOptions.order_type = orderTypeFilter;
      if (searchTerm) remoteOptions.search = searchTerm;
      if (dateFrom) remoteOptions.date_from = dateFrom;
      if (dateTo) remoteOptions.date_to = dateTo;

      const localRaw = await bridge.orders.getAll();
      const localOrders = (Array.isArray(localRaw) ? localRaw : [])
        .map((entry: any) => normalizeOrder(entry, 'local'))
        .filter((entry: Order | null): entry is Order => !!entry);

      let mergedOrders = localOrders;
      let filtered = applyFilters(mergedOrders).sort(
        (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
      );
      setTotal(filtered.length);
      setOrders(filtered);

      try {
        const remoteResult = await bridge.sync.fetchOrders(remoteOptions);
        if (remoteResult?.success) {
          const remoteOrders = (Array.isArray(remoteResult.orders) ? remoteResult.orders : [])
            .map((entry: any) => normalizeOrder(entry, 'remote'))
            .filter((entry: Order | null): entry is Order => !!entry);
          mergedOrders = mergeHybridOrders(localOrders, remoteOrders);
          filtered = applyFilters(mergedOrders).sort(
            (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
          );
          setTotal(filtered.length);
          setOrders(filtered);
        } else if (localOrders.length === 0) {
          toast.error(remoteResult?.error || 'Failed to load remote orders');
        }
      } catch (remoteError) {
        console.warn('[OrdersPage] Remote fetch failed, using local orders only', remoteError);
        if (localOrders.length === 0) {
          toast.error('Failed to load orders');
        }
      }
    } catch (error) {
      console.error('[OrdersPage] Exception while fetching orders:', error);
      toast.error('Failed to load orders');
    } finally {
      setLoading(false);
      setSyncing(false);
    }
  }, [
    statusFilter,
    orderTypeFilter,
    searchTerm,
    dateFrom,
    dateTo,
    applyFilters,
    bridge.orders,
    bridge.sync,
  ]);

  useEffect(() => {
    fetchOrders();
  }, [fetchOrders]);

  // Round 282: clamp a stranded page. When the filtered/fetched result count shrinks (a refetch, a
  // realtime update, or a filter narrowing), currentPage can be left beyond the last available page,
  // which renders the empty state even though orders exist. Reset it to the last available page (never
  // below 1) so page-1 data shows whenever filtered orders exist. No data fetch / filter change here.
  useEffect(() => {
    const maxPage = Math.max(1, Math.ceil(total / pageSize));
    if (currentPage > maxPage) {
      setCurrentPage(maxPage);
    }
  }, [total, pageSize, currentPage]);

  useEffect(() => {
    const consumeStoredRecoveryTarget = () => {
      const nextTarget = parseRecoveryOrderPaymentTarget(
        window.sessionStorage.getItem(RECOVERY_ORDER_PAYMENT_TARGET_KEY),
      );
      if (nextTarget) {
        setRecoveryPaymentTarget(nextTarget);
      }
    };

    consumeStoredRecoveryTarget();
    window.addEventListener('pos:open-order-payment', consumeStoredRecoveryTarget);
    return () => {
      window.removeEventListener('pos:open-order-payment', consumeStoredRecoveryTarget);
    };
  }, []);

  useEffect(() => {
    if (!recoveryPaymentTarget) {
      return;
    }

    const targetKey =
      recoveryPaymentTarget.orderId ||
      recoveryPaymentTarget.orderNumber ||
      `${recoveryPaymentTarget.createdAt}`;
    if (recoveryPaymentAttemptKeyRef.current === targetKey) {
      return;
    }

    const matchesTarget = (order: Order) =>
      (!!recoveryPaymentTarget.orderId && order.id === recoveryPaymentTarget.orderId) ||
      (!!recoveryPaymentTarget.orderNumber && order.order_number === recoveryPaymentTarget.orderNumber);

    const visibleMatch = orders.find(matchesTarget);
    if (visibleMatch) {
      recoveryPaymentAttemptKeyRef.current = targetKey;
      setSelectedOrder(visibleMatch);
      setOpenSelectedOrderPayment(true);
      window.sessionStorage.removeItem(RECOVERY_ORDER_PAYMENT_TARGET_KEY);
      setRecoveryPaymentTarget(null);
      return;
    }

    const lookupId = recoveryPaymentTarget.orderId || recoveryPaymentTarget.orderNumber;
    if (!lookupId) {
      return;
    }

    recoveryPaymentAttemptKeyRef.current = targetKey;
    let cancelled = false;
    bridge.orders
      .getById(lookupId)
      .then((result: any) => {
        if (cancelled) {
          return;
        }
        const hydrated = result?.order ?? result?.data ?? result;
        const normalized = normalizeOrder(hydrated, 'local');
        if (normalized) {
          setSelectedOrder(normalized);
          setOpenSelectedOrderPayment(true);
          window.sessionStorage.removeItem(RECOVERY_ORDER_PAYMENT_TARGET_KEY);
          setRecoveryPaymentTarget(null);
          return;
        }
        toast.error(t('recovery.messages.orderPaymentOpenFailed', {
          defaultValue: 'Could not open the blocked order payment screen.',
        }));
      })
      .catch((error) => {
        if (!cancelled) {
          console.warn('[OrdersPage] Failed to open recovery payment target:', error);
          toast.error(t('recovery.messages.orderPaymentOpenFailed', {
            defaultValue: 'Could not open the blocked order payment screen.',
          }));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [bridge.orders, orders, recoveryPaymentTarget, t]);

  // Refresh from Rust-driven events instead of renderer polling.
  useEffect(() => {
    let disposed = false;
    let pendingTimer: ReturnType<typeof setTimeout> | null = null;
    let lastSyncRefreshAt = Date.now();

    const scheduleFetch = (delayMs = 250) => {
      if (disposed || pendingTimer) return;
      pendingTimer = setTimeout(() => {
        pendingTimer = null;
        void fetchOrders();
      }, delayMs);
    };

    const handleOrderMutation = () => {
      scheduleFetch(150);
    };

    const handleSyncStatus = () => {
      const now = Date.now();
      if (now - lastSyncRefreshAt < BACKGROUND_SYNC_REFRESH_MIN_MS) {
        return;
      }
      lastSyncRefreshAt = now;
      scheduleFetch(300);
    };

    onEvent('order-created', handleOrderMutation);
    onEvent('order-status-updated', handleOrderMutation);
    onEvent('order-deleted', handleOrderMutation);
    onEvent('sync:status', handleSyncStatus);
    onEvent('sync:complete', handleOrderMutation);

    return () => {
      disposed = true;
      if (pendingTimer) clearTimeout(pendingTimer);
      offEvent('order-created', handleOrderMutation);
      offEvent('order-status-updated', handleOrderMutation);
      offEvent('order-deleted', handleOrderMutation);
      offEvent('sync:status', handleSyncStatus);
      offEvent('sync:complete', handleOrderMutation);
    };
  }, [fetchOrders]);

  // Pickup / takeaway (and the default fall-through) render the shared PickupOrderIcon as a plain bag
  // silhouette at row scale -- the same bag glyph as the order-type chooser, sized (w-6 h-6) to match
  // the sibling delivery/table row icons. No green badge/holder: a semantic green stroke
  // (light text-green-600 / dark text-green-400) keeps it readable on both the cream and dark rows
  // while reading as a bag, not a boxed chip. Never a Store/Package/storefront glyph or a raw
  // ShoppingBag for the order-type icon (the bag always goes through the shared PickupOrderIcon).
  const pickupRowIcon = (
    <PickupOrderIcon
      className={`w-6 h-6 ${isDark ? 'text-green-400' : 'text-green-600'}`}
      strokeWidth={2}
    />
  );
  const getOrderTypeIcon = (type: string) => {
    // Room service is matched first via the ZReportModal slug-collapse idea ('-'/'_'/space -> '_') so
    // room_service / room-service / room service all resolve to the Bed icon and never fall through to
    // the pickup bag. Delivery / pickup / dine-in keep their existing icons unchanged (round 218).
    const collapsed = String(type || '').trim().toLowerCase().replace(/[\s_-]+/g, '_');
    if (collapsed === 'room_service') return <Bed className="w-6 h-6" />;
    switch (type) {
      case 'delivery': return <Truck className="w-6 h-6" />;
      case 'pickup': return pickupRowIcon;
      case 'dine-in': return <TableOrderIcon className="w-6 h-6" />;
      default: return pickupRowIcon;
    }
  };

  const getOrderStatusLabel = useCallback((status?: string) => {
    const normalized = String(status || '').trim().toLowerCase();
    if (!normalized) return '';
    return t(`orders.status.${normalized}`, { defaultValue: status || '' });
  }, [t]);

  const getOrderTypeLabel = useCallback((type?: string) => {
    const normalized = String(type || '').trim().toLowerCase();
    if (!normalized) return '';
    // Collapse '-'/'_'/whitespace (the ZReportModal slug idea) so dine-in/dine_in and
    // room_service/room-service/room service each resolve to one localized orders.type.* key
    // instead of leaking the raw slug.
    const collapsed = normalized.replace(/[\s_-]+/g, '_');
    const key =
      collapsed === 'dine_in' ? 'dineIn' :
      collapsed === 'room_service' ? 'roomService' :
      normalized;
    return t(`orders.type.${key}`, { defaultValue: type || '' });
  }, [t]);

  const totalPages = Math.ceil(total / pageSize);
  // Round 283: derive the visible page from the FULL filtered list (stored in `orders`) at render time,
  // clamped to the available range. Next/Previous update currentPage and this slice recomputes
  // immediately -- no refetch. The empty state stays driven by the full `orders` length, not this slice.
  const visibleOrders = useMemo(() => {
    const maxPage = Math.max(1, Math.ceil(orders.length / pageSize));
    const safePage = Math.min(currentPage, maxPage);
    const start = (safePage - 1) * pageSize;
    return orders.slice(start, start + pageSize);
  }, [orders, currentPage, pageSize]);
  const refreshLabel = syncing
    ? t('orders.syncingOrders', { defaultValue: 'Syncing orders' })
    : t('orders.refreshOrders', { defaultValue: 'Refresh orders' });
  const filterLabel = showFilters
    ? t('orders.hideFilters', { defaultValue: 'Hide filters' })
    : t('orders.showFilters', { defaultValue: 'Show filters' });
  const clearSearchLabel = t('orders.clearSearch', { defaultValue: 'Clear search' });
  const statusFilterLabel = t('orders.filters.status', { defaultValue: 'Status' });
  const orderTypeFilterLabel = t('orders.filters.orderType', { defaultValue: 'Order Type' });
  const dateFromFilterLabel = t('orders.filters.dateFrom', { defaultValue: 'Date From' });

  const handleClearFilters = () => {
    setStatusFilter('all');
    setOrderTypeFilter('all');
    setSearchTerm('');
    setDateFrom('');
    setDateTo('');
    setCurrentPage(1);
  };

  if (loading && orders.length === 0) {
    return (
      <div className={`flex items-center justify-center h-full ${isDark ? 'bg-black text-zinc-200' : 'bg-[#fdfaf5] text-gray-800'}`}>
        <div className="text-center">
          <RefreshCw className={`w-12 h-12 animate-spin mx-auto mb-4 ${isDark ? 'text-yellow-300' : 'text-yellow-600'}`} />
          <p className={isDark ? 'text-zinc-300' : 'text-gray-700'}>
            {t('orders.loadingOrders', { defaultValue: 'Loading orders...' })}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className={`h-full flex flex-col ${isDark ? 'bg-black text-zinc-100' : 'bg-[#fdfaf5] text-gray-900'}`}>
      {/* Header */}
      <div className={isDark ? 'bg-black' : 'bg-[#fffaf1]'}>
        <div className="p-6 md:p-8">
          <div className="flex items-center justify-between mb-6">
            <div>
              <h1 className={`text-3xl font-bold tracking-tight mb-1 ${isDark ? 'text-white' : 'text-gray-900'}`}>{t('orders.title', 'Orders')}</h1>
              <p className={`text-sm ${isDark ? 'text-zinc-400' : 'text-gray-600'}`}>
                {t('orders.ordersTotal', { count: total, defaultValue: '{{count}} orders total' })}
              </p>
            </div>
            <button
              onClick={fetchOrders}
              disabled={syncing}
              aria-label={refreshLabel}
              className={`h-12 w-12 rounded-xl inline-flex items-center justify-center transition-all shadow-sm ${isDark ? 'border border-white/80 bg-white text-black active:bg-zinc-200' : 'border border-black bg-black text-white active:bg-zinc-800'} ${syncing ? 'opacity-60 cursor-not-allowed' : 'active:scale-95'}`}
            >
              <RefreshCw className={`w-5 h-5 ${syncing ? 'animate-spin' : ''}`} />
            </button>
          </div>

          {/* Search and Filters */}
          <div className="space-y-3">
            <div className={`flex items-center gap-2 px-4 py-3 rounded-xl border ${isDark ? 'bg-zinc-900/90 border-zinc-800 focus-within:border-yellow-500/50' : 'bg-[#fffdf8] border-amber-100/80 focus-within:border-amber-300'}`}>
              <Search className={`w-5 h-5 ${isDark ? 'text-zinc-500' : 'text-gray-400'}`} />
              <input
                type="text"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                placeholder={t('orders.searchPlaceholder', {
                  defaultValue: 'Search by order number, customer name, or phone...',
                })}
                className={`flex-1 bg-transparent outline-none ${isDark ? 'text-zinc-100 placeholder:text-zinc-500' : 'text-gray-900 placeholder:text-gray-500'}`}
              />
              {searchTerm && (
                <button
                  type="button"
                  onClick={() => setSearchTerm('')}
                  aria-label={clearSearchLabel}
                  className={`${isDark ? 'text-zinc-500 active:text-zinc-200' : 'text-gray-400 active:text-gray-700'} transition-colors`}
                >
                  <X className="w-4 h-4" />
                </button>
              )}
              <button
                type="button"
                onClick={() => setShowFilters(!showFilters)}
                aria-label={filterLabel}
                className={`ml-2 inline-flex shrink-0 items-center justify-center transition-colors ${showFilters
                  ? isDark ? 'text-yellow-300' : 'text-yellow-600'
                  : isDark ? 'text-zinc-400 active:text-yellow-300' : 'text-gray-500 active:text-yellow-600'
                  }`}
              >
                <Filter className="w-5 h-5" />
              </button>
            </div>

            {/* Filters Panel */}
            <AnimatePresence>
              {showFilters && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  className="overflow-hidden"
                >
                  <div className={`grid grid-cols-1 md:grid-cols-3 gap-3 p-4 rounded-xl border ${isDark ? 'bg-zinc-950 border-zinc-800' : 'bg-[#fffdf8] border-amber-100/80'}`}>
                    <div>
                      <label className="text-xs mb-1 block opacity-70">
                        {t('orders.filters.status', { defaultValue: 'Status' })}
                      </label>
                      <select
                        value={statusFilter}
                        onChange={(e) => setStatusFilter(e.target.value)}
                        aria-label={statusFilterLabel}
                        className={`w-full px-3 py-2 rounded-2xl text-sm border ${isDark ? 'bg-zinc-900 border-zinc-700' : 'bg-[#fffaf1] border-amber-200/70'}`}
                      >
                        <option value="all">{t('orders.filters.allStatuses', { defaultValue: 'All Statuses' })}</option>
                        {ORDER_STATUS_FILTER_OPTIONS.map((status) => (
                          <option key={status} value={status}>
                            {getOrderStatusLabel(status)}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="text-xs mb-1 block opacity-70">
                        {t('orders.filters.orderType', { defaultValue: 'Order Type' })}
                      </label>
                      <select
                        value={orderTypeFilter}
                        onChange={(e) => setOrderTypeFilter(e.target.value)}
                        aria-label={orderTypeFilterLabel}
                        className={`w-full px-3 py-2 rounded-2xl text-sm border ${isDark ? 'bg-zinc-900 border-zinc-700' : 'bg-[#fffaf1] border-amber-200/70'}`}
                      >
                        <option value="all">{t('orders.filters.allTypes', { defaultValue: 'All Types' })}</option>
                        {ORDER_TYPE_FILTER_OPTIONS.map((type) => (
                          <option key={type} value={type}>
                            {getOrderTypeLabel(type)}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="text-xs mb-1 block opacity-70">
                        {t('orders.filters.dateFrom', { defaultValue: 'Date From' })}
                      </label>
                      <input
                        type="date"
                        value={dateFrom}
                        onChange={(e) => setDateFrom(e.target.value)}
                        aria-label={dateFromFilterLabel}
                        className={`w-full px-3 py-2 rounded-2xl text-sm border ${isDark ? 'bg-zinc-900 border-zinc-700' : 'bg-[#fffaf1] border-amber-200/70'}`}
                      />
                    </div>
                  </div>
                  {/* Touch-first clear-filters action: a real ~44px button (not loose text) so it is an
                      obvious, reliable tap target on the POS touchscreen. Amber/yellow neutral styling that
                      fits the cream page; press feedback only (active:), no hover utilities. */}
                  <button
                    type="button"
                    onClick={handleClearFilters}
                    className={`mt-3 inline-flex min-h-[44px] items-center justify-center gap-2 rounded-2xl border px-4 py-2 text-sm font-medium transition active:scale-[0.97] ${
                      isDark
                        ? 'border-yellow-300/30 bg-yellow-400/10 text-yellow-200 active:bg-yellow-400/20'
                        : 'border-amber-300 bg-amber-100/70 text-amber-800 active:bg-amber-200'
                    }`}
                  >
                    <RotateCcw className="w-4 h-4" strokeWidth={2} />
                    <span>{t('orders.filters.clearAll', { defaultValue: 'Clear all filters' })}</span>
                  </button>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
      </div>

      {/* Orders List */}
      <div className={`flex-1 overflow-y-auto scrollbar-hide p-6 ${isDark ? 'bg-gradient-to-b from-black via-black to-zinc-950/80' : 'bg-[#fdfaf5]'}`}>
        {orders.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <ShoppingBag className={`w-16 h-16 mb-4 ${isDark ? 'text-zinc-700' : 'text-gray-400'}`} />
            <h3 className="text-lg font-semibold mb-2">
              {t('orders.emptyTitle', { defaultValue: 'No Orders Found' })}
            </h3>
            <p className={`text-sm ${isDark ? 'text-zinc-500' : 'text-gray-600'}`}>
              {t('orders.emptyDescription', { defaultValue: 'No orders match your current filters.' })}
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {visibleOrders.map((order) => (
              (() => {
                const orderStatus = String(order.status || '').toLowerCase();
                const orderType = String(order.order_type || '').toLowerCase();
                const displayOrderNumber = getDisplayOrderNumber(order);
                const deliveredDriverName = order.driver_name || order.driverName || '';
                const showDeliveredDriver =
                  orderType === 'delivery' &&
                  (orderStatus === 'completed' || orderStatus === 'delivered') &&
                  !!deliveredDriverName;
                // Table-service rows show the table as the customer, formatted
                // through the shared display convention ("Τραπέζι #TB01"); real
                // pickup/delivery customers keep their own name.
                const tableCustomerNumber = resolveTableServiceCustomerNumber(order as any);
                const customerDisplayName = tableCustomerNumber
                  ? t('orderFlow.tableCustomer', { table: tableCustomerNumber })
                  : order.customer_name;

                return (
                  <motion.div
                    key={order.id}
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    className={`p-5 rounded-xl border cursor-pointer transition-all ${isDark ? 'border-zinc-800 bg-zinc-950/80 active:border-amber-400/40 active:bg-zinc-900' : 'border-amber-100/80 bg-[#fffaf1]/90 active:border-amber-300/90 active:bg-[#fff7e8] active:shadow-md'}`}
                    onClick={() => setSelectedOrder(order)}
                  >
                    <div className="flex items-start justify-between">
                      <div className="flex-1">
                        <div className="flex items-center gap-3 mb-2">
                          <span className="font-mono font-bold text-lg">{displayOrderNumber}</span>
                          <span className={`inline-flex items-center justify-center rounded-full border px-3 py-1.5 text-[13px] leading-none font-bold whitespace-nowrap ${getOrderStatusPillClasses(order.status)}`}>
                            {getOrderStatusLabel(order.status)}
                          </span>
                          <div className={`flex items-center gap-1 text-xs font-medium ${isDark ? 'text-zinc-300' : 'text-gray-700'}`}>
                            {getOrderTypeIcon(order.order_type)}
                            <span>{getOrderTypeLabel(order.order_type)}</span>
                          </div>
                        </div>

                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-sm">
                          {customerDisplayName && (
                            <div className={`flex items-center gap-2 ${isDark ? 'text-zinc-200' : 'text-gray-700'}`}>
                              <User className={`w-4 h-4 ${isDark ? 'text-yellow-300' : 'text-yellow-600'}`} />
                              <span>{customerDisplayName}</span>
                            </div>
                          )}
                          {order.customer_phone && (
                            <div className={`flex items-center gap-2 ${isDark ? 'text-zinc-200' : 'text-gray-700'}`}>
                              <Phone className={`w-4 h-4 ${isDark ? 'text-yellow-300' : 'text-yellow-600'}`} />
                              <span>{order.customer_phone}</span>
                            </div>
                          )}
                          <div className={`flex items-center gap-2 ${isDark ? 'text-zinc-300' : 'text-gray-700'}`}>
                            <Package className={`w-4 h-4 ${isDark ? 'text-yellow-300' : 'text-yellow-600'}`} />
                            <span>
                              {t('orders.itemsCount', {
                                count: order.order_items?.length || 0,
                                defaultValue: '{{count}} items',
                              })}
                            </span>
                          </div>
                        </div>

                        {showDeliveredDriver && (
                          <div className={`mt-3 inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium ${isDark ? 'bg-green-950/70 border border-green-800 text-green-200' : 'bg-green-50 border border-green-200 text-green-700'}`}>
                            <Truck className="w-3.5 h-3.5" />
                            <span>{t('orders.deliveredBy', { defaultValue: 'Delivered by {{name}}', name: deliveredDriverName })}</span>
                          </div>
                        )}
                      </div>

                      <div className="text-right">
                        <div className={`text-3xl font-bold mb-1 ${isDark ? 'text-white' : 'text-gray-900'}`}>
                          {formatMoney(order.total_amount)}
                        </div>
                        <div className={`text-xs ${isDark ? 'text-zinc-400' : 'text-gray-500'}`}>
                          {new Date(order.created_at).toLocaleString()}
                        </div>
                      </div>
                    </div>
                  </motion.div>
                );
              })()
            ))}
          </div>
        )}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className={`border-t p-4 ${isDark ? 'border-zinc-800 bg-zinc-950/90' : 'border-amber-100/70 bg-[#fffaf1]'}`}>
          <div className="flex items-center justify-between">
            <div className={`text-sm ${isDark ? 'text-zinc-400' : 'text-gray-600'}`}>
              {t('orders.pageOf', {
                current: currentPage,
                total: totalPages,
                defaultValue: 'Page {{current}} of {{total}}',
              })}
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setCurrentPage(prev => Math.max(1, prev - 1))}
                disabled={currentPage === 1}
                aria-label={t('orders.pagination.previous', { defaultValue: 'Previous page' })}
                className={`px-3 py-2 rounded-2xl border ${currentPage === 1
                  ? isDark ? 'opacity-40 cursor-not-allowed bg-zinc-900 border-zinc-700' : 'opacity-40 cursor-not-allowed bg-[#fffdf8] border-amber-200/70'
                  : isDark ? 'bg-zinc-800 active:bg-zinc-700 border-zinc-700' : 'bg-[#fffdf8] active:bg-[#fff7e8] border-amber-200/70'
                  }`}
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <button
                onClick={() => setCurrentPage(prev => Math.min(totalPages, prev + 1))}
                disabled={currentPage === totalPages}
                aria-label={t('orders.pagination.next', { defaultValue: 'Next page' })}
                className={`px-3 py-2 rounded-2xl border ${currentPage === totalPages
                  ? isDark ? 'opacity-40 cursor-not-allowed bg-zinc-900 border-zinc-700' : 'opacity-40 cursor-not-allowed bg-[#fffdf8] border-amber-200/70'
                  : isDark ? 'bg-zinc-800 active:bg-zinc-700 border-zinc-700' : 'bg-[#fffdf8] active:bg-[#fff7e8] border-amber-200/70'
                  }`}
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Order Detail Modal */}
      <OrderDetailsModal
        isOpen={!!selectedOrder}
        orderId={selectedOrder?.id || selectedOrder?.order_number || ''}
        order={selectedOrder}
        openPaymentOnMount={openSelectedOrderPayment}
        onClose={() => {
          setSelectedOrder(null);
          setOpenSelectedOrderPayment(false);
        }}
        onPrintReceipt={async () => {
          const orderId = selectedOrder?.id;
          if (!orderId) {
            toast.error('No order ID available for printing');
            return;
          }
          toast.loading('Printing receipt...', { id: 'print-receipt' });
          try {
            const result = await bridge.payments.printReceipt(orderId, 'order_receipt');
            console.log('[OrdersPage] printReceipt result:', result);
            if (result?.success) {
              toast.success('Receipt sent to printer', { id: 'print-receipt' });
            } else {
              toast.error(result?.error || 'Print job queued but may fail', { id: 'print-receipt' });
            }
          } catch (err: any) {
            console.error('[OrdersPage] printReceipt error:', err);
            toast.error(`Print failed: ${err?.message || err}`, { id: 'print-receipt' });
          }
        }}
      />
    </div>
  );
};

export default OrdersPage;
