import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { motion, AnimatePresence } from 'framer-motion';
import {
  ChefHat,
  Clock,
  CheckCircle,
  AlertTriangle,
  Timer,
  Utensils,
  Coffee,
  Flame,
  Snowflake,
  RefreshCw,
  Volume2,
  VolumeX,
  Play,
  Pause,
  LayoutGrid,
  List,
  Copy,
  Monitor,
  ScreenShare,
  X
} from 'lucide-react';
import { useTheme } from '../contexts/theme-context';
import { toast } from 'react-hot-toast';
import {
  getBridge,
  offEvent,
  onEvent,
  type ExternalDisplayCapabilities,
  type ExternalDisplayInfo,
} from '../../lib';
import { subscriptionManager, type SubscriptionStatus } from '../services/SubscriptionManager';
import { useResolvedPosIdentity } from '../hooks/useResolvedPosIdentity';
import { useOrderStore } from '../hooks/useOrderStore';
import { environment } from '../../config/environment';
import { formatCompactOrderNumberForDisplay, getVisibleOrderNumber } from '../utils/orderNumberUtils';

interface KitchenOrder {
  id: string;
  sourceOrderId?: string;
  order_number: string;
  order_type: 'dine-in' | 'pickup' | 'takeaway' | 'delivery' | 'drive-through' | 'dine_in' | 'room_service';
  status: 'pending' | 'preparing';
  items: KitchenOrderItem[];
  created_at: string;
  table_number?: string;
  priority: 'normal' | 'rush' | 'vip';
  notes?: string;
  station_id?: string;
  source: 'ticket' | 'live-draft' | 'local-order';
  isDraft: boolean;
  draftSessionId?: string;
  sourceTerminalId?: string;
  dedupeKeys?: string[];
}

interface KitchenOrderItem {
  id: string;
  name: string;
  quantity: number;
  station: string;
  status: 'pending' | 'preparing' | 'ready';
  modifiers?: string[];
  notes?: string;
}

interface KdsStation {
  id: string;
  name: string;
  station_type: string;
}

const BACKGROUND_SYNC_REFRESH_MIN_MS = 30000;
const KDS_REALTIME_SUBSCRIPTION_KEY = 'kds-tickets-kitchen-display';
const KDS_FALLBACK_POLL_INTERVAL_MS = 1500;
const KITCHEN_DISPLAY_CONTENT_TYPE = 'kitchen_display';
const CLOSED_ORDER_STATUSES = new Set([
  'completed',
  'delivered',
  'cancelled',
  'canceled',
  'voided',
  'refunded',
]);
const ACTIVE_LOCAL_KDS_ORDER_STATUSES = new Set(['pending', 'confirmed', 'preparing']);

function readSearchParam(name: string): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return new URLSearchParams(window.location.search).get(name);
  } catch {
    return null;
  }
}

function isKitchenExternalDisplayWindow(): boolean {
  return readSearchParam('externalDisplay') === KITCHEN_DISPLAY_CONTENT_TYPE;
}

function isKitchenDisplayActive(capabilities: ExternalDisplayCapabilities | null): boolean {
  return Boolean(
    capabilities?.activePresentations?.some(
      (presentation) => presentation.contentType === KITCHEN_DISPLAY_CONTENT_TYPE
    )
  );
}

const normalizeKdsString = (value: unknown): string =>
  typeof value === 'string' ? value.trim() : '';

const readKdsString = (record: Record<string, unknown> | null | undefined, key: string): string =>
  normalizeKdsString(record?.[key]);

const getKdsRecordDedupeKeys = (record: Record<string, unknown> | null | undefined): string[] => {
  if (!record) return [];
  return [
    'id',
    'supabase_id',
    'supabaseId',
    'order_id',
    'client_order_id',
    'clientOrderId',
    'client_request_id',
    'clientRequestId',
    'display_order_number',
    'displayOrderNumber',
    'order_number',
    'orderNumber',
    'ticket_number',
  ]
    .map((key) => readKdsString(record, key))
    .filter(Boolean);
};

const getKdsVisibleOrderNumber = (
  primary: Record<string, unknown> | null | undefined,
  fallback?: Record<string, unknown> | null
): string => {
  const primaryVisible = getVisibleOrderNumber({
    display_order_number: readKdsString(primary, 'display_order_number'),
    displayOrderNumber: readKdsString(primary, 'displayOrderNumber'),
    order_number: readKdsString(primary, 'order_number'),
    orderNumber: readKdsString(primary, 'orderNumber'),
  });
  if (primaryVisible) return primaryVisible;

  return getVisibleOrderNumber({
    display_order_number: readKdsString(fallback, 'display_order_number'),
    displayOrderNumber: readKdsString(fallback, 'displayOrderNumber'),
    order_number: readKdsString(fallback, 'order_number'),
    orderNumber: readKdsString(fallback, 'orderNumber') || readKdsString(fallback, 'ticket_number'),
  });
};

const isGeneratedMobileTerminalId = (value: string): boolean => value.startsWith('mobile-terminal-');

const isClosedKdsTicket = (
  ticket: Record<string, unknown>,
  localOrder: Record<string, unknown> | null
): boolean => {
  const ticketStatus = readKdsString(ticket, 'status').toLowerCase();
  const orderStatus =
    readKdsString(ticket, 'order_status').toLowerCase() ||
    readKdsString(localOrder, 'status').toLowerCase();

  return (
    ticketStatus === 'completed' ||
    ticketStatus === 'cancelled' ||
    ticket['order_is_closed'] === true ||
    localOrder?.['is_closed'] === true ||
    Boolean(orderStatus && CLOSED_ORDER_STATUSES.has(orderStatus))
  );
};

const matchesKdsTerminal = (
  ticket: Record<string, unknown>,
  terminalId: string | null,
  localOrder: Record<string, unknown> | null
): boolean => {
  if (!terminalId) return false;

  const ticketSourceTerminalId = readKdsString(ticket, 'source_terminal_id');
  const ticketTerminalId = readKdsString(ticket, 'terminal_id');
  const ticketOwnerTerminalId = readKdsString(ticket, 'owner_terminal_id');

  if (ticketSourceTerminalId) return ticketSourceTerminalId === terminalId;
  if (ticketTerminalId) return ticketTerminalId === terminalId;
  if (ticketOwnerTerminalId === terminalId) return true;

  const localSourceTerminalId =
    readKdsString(localOrder, 'source_terminal_id') || readKdsString(localOrder, 'sourceTerminalId');
  const localTerminalId =
    readKdsString(localOrder, 'terminal_id') || readKdsString(localOrder, 'terminalId');
  const localOwnerTerminalId =
    readKdsString(localOrder, 'owner_terminal_id') || readKdsString(localOrder, 'ownerTerminalId');

  if (localSourceTerminalId) return localSourceTerminalId === terminalId;
  if (localTerminalId) return localTerminalId === terminalId || isGeneratedMobileTerminalId(localTerminalId);
  return localOwnerTerminalId === terminalId || isGeneratedMobileTerminalId(localOwnerTerminalId);
};

const getKitchenOrderDedupeKeys = (order: KitchenOrder): string[] =>
  [...(order.dedupeKeys || []), order.id, order.sourceOrderId, order.order_number]
    .map((value) => normalizeKdsString(value))
    .filter(Boolean);

const isActiveLocalKitchenOrder = (order: Record<string, unknown>): boolean => {
  const status = readKdsString(order, 'status').toLowerCase();
  return order['is_ghost'] !== true && !isClosedKdsTicket({}, order) && ACTIVE_LOCAL_KDS_ORDER_STATUSES.has(status);
};

const mapLocalOrderToKitchenOrder = (order: Record<string, unknown>): KitchenOrder | null => {
  const id = readKdsString(order, 'id') || readKdsString(order, 'supabase_id');
  const orderNumber =
    readKdsString(order, 'order_number') ||
    readKdsString(order, 'orderNumber') ||
    readKdsString(order, 'display_order_number') ||
    readKdsString(order, 'displayOrderNumber') ||
    id;

  if (!id || !orderNumber) return null;

  const rawItems = Array.isArray(order['items']) ? (order['items'] as Record<string, unknown>[]) : [];
  const orderStatus = readKdsString(order, 'status').toLowerCase();

  return {
    id,
    sourceOrderId: readKdsString(order, 'supabase_id') || id,
    order_number: orderNumber,
    order_type: (readKdsString(order, 'order_type') || readKdsString(order, 'orderType') || 'takeaway') as KitchenOrder['order_type'],
    status: orderStatus === 'preparing' ? 'preparing' : 'pending',
    created_at: readKdsString(order, 'created_at') || readKdsString(order, 'createdAt') || new Date().toISOString(),
    notes: readKdsString(order, 'special_instructions') || readKdsString(order, 'notes') || undefined,
    table_number: readKdsString(order, 'table_number') || readKdsString(order, 'tableNumber') || undefined,
    priority: 'normal',
    source: 'local-order',
    isDraft: false,
    draftSessionId: undefined,
    sourceTerminalId: readKdsString(order, 'source_terminal_id') || readKdsString(order, 'sourceTerminalId') || undefined,
    dedupeKeys: getKdsRecordDedupeKeys(order),
    items: rawItems.map((item, index) => ({
      id: readKdsString(item, 'id') || `local-item-${index + 1}`,
      name: readKdsString(item, 'name') || readKdsString(item, 'menu_item_name') || 'Unknown',
      quantity: Number(item['quantity']) || 1,
      station: readKdsString(item, 'station') || 'hot',
      status: orderStatus === 'preparing' ? 'preparing' : 'pending',
      notes: readKdsString(item, 'notes') || undefined,
      modifiers: Array.isArray(item['modifiers'])
        ? (item['modifiers'] as string[])
        : Array.isArray(item['customizations'])
          ? (item['customizations'] as string[])
          : undefined,
    })),
  };
};

const buildStationsSignature = (stations: KdsStation[]): string =>
  stations
    .map((station) => `${station.id}|${station.name}|${station.station_type}`)
    .join('||');

const buildOrderItemsSignature = (items: KitchenOrderItem[]): string =>
  items
    .map((item) => `${item.id}|${item.name}|${item.quantity}|${item.station}|${item.status}|${item.notes || ''}`)
    .join(';;');

const buildOrdersSignature = (orders: KitchenOrder[]): string =>
  orders
    .map((order) => `${order.id}|${order.status}|${order.order_type}|${order.station_id || ''}|${order.created_at}|${order.source}|${buildOrderItemsSignature(order.items)}`)
    .join('||');

const KitchenDisplayPage: React.FC = () => {
  const bridge = getBridge();
  const { t, i18n } = useTranslation();
  const { resolvedTheme } = useTheme();
  const {
    branchId,
    organizationId,
    terminalId,
    isResolving: isIdentityResolving,
    isReady: isIdentityReady,
    missing,
    refresh: refreshIdentity,
  } = useResolvedPosIdentity('branch');
  const localOrders = useOrderStore((state) => state.orders);
  const loadLocalOrders = useOrderStore((state) => state.loadOrders);
  const updateOrderStatus = useOrderStore((state) => state.updateOrderStatus);
  const localOrderLookup = useMemo(() => {
    const lookup = new Map<string, Record<string, unknown>>();
    localOrders.forEach((order) => {
      const record = order as unknown as Record<string, unknown>;
      getKdsRecordDedupeKeys(record).forEach((candidate) => {
        const key = normalizeKdsString(candidate);
        if (key) lookup.set(key, record);
      });
    });
    return lookup;
  }, [localOrders]);
  const [loading, setLoading] = useState(true);
  const [orders, setOrders] = useState<KitchenOrder[]>([]);
  const [stations, setStations] = useState<KdsStation[]>([]);
  const [stationFilter, setStationFilter] = useState<string>('all');
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isRealtimeConnected, setIsRealtimeConnected] = useState(false);
  const [displayCapabilities, setDisplayCapabilities] =
    useState<ExternalDisplayCapabilities | null>(null);
  const [displayNotice, setDisplayNotice] = useState<string | null>(null);
  const [displayError, setDisplayError] = useState<string | null>(null);
  const [isDisplayBusy, setIsDisplayBusy] = useState(false);
  const realtimeRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastOrdersSignatureRef = useRef<string>('');
  const lastStationsSignatureRef = useRef<string>('');

  const isDark = resolvedTheme === 'dark';
  const externalWindow = isKitchenExternalDisplayWindow();
  const activeExternalDisplay = isKitchenDisplayActive(displayCapabilities);
  const connectedDisplays = displayCapabilities?.displays || [];

  const fetchExternalDisplayCapabilities = useCallback(async () => {
    if (externalWindow) return;
    try {
      const result = await bridge.externalDisplay.getCapabilities();
      setDisplayCapabilities(result);
    } catch (err) {
      setDisplayCapabilities({
        success: false,
        supported: false,
        displays: [],
        error: err instanceof Error ? err.message : 'Failed to inspect connected displays',
      });
    }
  }, [bridge, externalWindow]);

  // Map API status values back to UI status values
  const mapApiStatusToUi = (apiStatus: string): KitchenOrder['status'] | null => {
    const statusMap: Record<string, KitchenOrder['status']> = {
      pending: 'pending',
      in_progress: 'preparing',
    };
    // Return null for completed tickets so they can be filtered out
    if (apiStatus === 'completed') return null;
    return statusMap[apiStatus] || 'pending';
  };

  // Format order type for display using i18n (handles both legacy and new formats)
  const formatOrderType = (type: string): string => {
    // Map to translation keys (use existing orderType namespace)
    const keyMap: Record<string, string> = {
      'dine-in': 'orderType.dineIn',
      'dine_in': 'orderType.dineIn',  // legacy
      'pickup': 'orderType.pickup',
      'takeaway': 'orderType.takeaway',
      'delivery': 'orderType.delivery',
      'drive-through': 'orderType.driveThrough',
      'room_service': 'orderType.roomService',
    };
    const key = keyMap[type];
    return key ? t(key, type) : type;  // fallback to raw type if no translation
  };

  // Get badge color for order type
  const getOrderTypeBadgeColor = (type: string): string => {
    const colors: Record<string, string> = {
      'dine-in': 'bg-blue-500/20 text-blue-500',
      'dine_in': 'bg-blue-500/20 text-blue-500',
      'pickup': 'bg-amber-500/20 text-amber-500',
      'takeaway': 'bg-green-500/20 text-green-500',
      'delivery': 'bg-purple-500/20 text-purple-500',
      'drive-through': 'bg-cyan-500/20 text-cyan-500',
      'room_service': 'bg-indigo-500/20 text-indigo-500',
    };
    return colors[type] || 'bg-gray-500/20 text-gray-500';
  };

  const fetchOrders = useCallback(async (showLoading = true) => {
    if (!branchId) {
      if (showLoading) {
        setLoading(false);
      }
      return;
    }
    if (showLoading) {
      setLoading(true);
    }
    setError(null);
    try {
      const statusParam = 'pending,preparing';
      const result = await bridge.adminApi.fetchFromAdmin(
        `/api/pos/kds?status=${statusParam}&include_live_drafts=true&scope=terminal`
      );

      if (result?.success && result?.data?.success && result?.data?.tickets) {
        if (result.data.config?.stations) {
          const mappedStations = result.data.config.stations.map((s: Record<string, unknown>) => ({
            id: s['id'] as string,
            name: s['name'] as string,
            station_type: s['station_type'] as string,
          }));
          const nextStationsSignature = buildStationsSignature(mappedStations);
          if (nextStationsSignature !== lastStationsSignatureRef.current) {
            setStations(mappedStations);
            lastStationsSignatureRef.current = nextStationsSignature;
          }
        }

        const ticketOrders: KitchenOrder[] = result.data.tickets
          .map((ticket: Record<string, unknown>) => {
            const localOrder =
              localOrderLookup.get(readKdsString(ticket, 'order_id')) ||
              localOrderLookup.get(readKdsString(ticket, 'client_order_id')) ||
              localOrderLookup.get(readKdsString(ticket, 'clientOrderId')) ||
              localOrderLookup.get(readKdsString(ticket, 'order_number')) ||
              localOrderLookup.get(readKdsString(ticket, 'ticket_number')) ||
              null;
            const ticketMatchesTerminal = terminalId
              ? matchesKdsTerminal(ticket, terminalId, localOrder)
              : true;
            if (isClosedKdsTicket(ticket, localOrder) || !ticketMatchesTerminal) {
              return null;
            }

            const status = mapApiStatusToUi(ticket['status'] as string);
            if (status === null) return null;
            const ticketItems = Array.isArray(ticket['items']) ? (ticket['items'] as Record<string, unknown>[]) : [];
            const visibleOrderNumber =
              getKdsVisibleOrderNumber(localOrder, ticket) ||
              readKdsString(ticket, 'order_id') ||
              readKdsString(ticket, 'id');
            return {
              id: ticket['id'] as string,
              sourceOrderId: readKdsString(localOrder, 'id') || readKdsString(ticket, 'order_id') || undefined,
              order_number: visibleOrderNumber,
              order_type: (ticket['order_type'] as KitchenOrder['order_type']) || 'takeaway',
              status,
              created_at: ticket['created_at'] as string,
              notes: ticket['notes'] as string | undefined,
              table_number: ticket['table_number'] as string | undefined,
              priority: (ticket['priority'] as 'normal' | 'rush' | 'vip') || 'normal',
              station_id: ticket['station_id'] as string | undefined,
              source: 'ticket',
              isDraft: false,
              draftSessionId: undefined,
              sourceTerminalId: undefined,
              dedupeKeys: [
                ...getKdsRecordDedupeKeys(ticket),
                ...getKdsRecordDedupeKeys(localOrder),
              ],
              items: ticketItems.map((item: Record<string, unknown>) => ({
                id: item['id'] as string,
                name: item['name'] as string || 'Unknown',
                quantity: item['quantity'] as number || 1,
                station: (item['station'] as string) || (ticket['station_id'] as string) || 'hot',
                status: (item['status'] as 'pending' | 'preparing' | 'ready') || 'pending',
                notes: item['notes'] as string | undefined,
                modifiers: item['modifiers'] as string[] | undefined
              }))
            };
          })
          .filter((order: KitchenOrder | null): order is KitchenOrder => order !== null);

        const liveDraftsPayload = Array.isArray(result.data.live_drafts)
          ? (result.data.live_drafts as Record<string, unknown>[])
          : [];

        const liveDraftOrders: KitchenOrder[] = liveDraftsPayload.map((draft: Record<string, unknown>) => {
          const sessionId = (draft['session_id'] as string | undefined) || '';
          const shortSession = sessionId ? sessionId.slice(0, 8).toUpperCase() : 'LIVE';
          const draftItemsRaw = Array.isArray(draft['items']) ? (draft['items'] as Record<string, unknown>[]) : [];
          return {
            id: `live-draft-${draft['id'] as string}`,
            order_number: (draft['customer_name'] as string) || `LIVE-${shortSession}`,
            order_type: ((draft['order_type'] as KitchenOrder['order_type']) || 'pickup'),
            status: 'pending',
            created_at: (draft['last_activity_at'] as string) || (draft['created_at'] as string) || new Date().toISOString(),
            notes: undefined,
            table_number: undefined,
            priority: 'normal',
            station_id: draft['station_id'] as string | undefined,
            source: 'live-draft',
            isDraft: true,
            draftSessionId: sessionId || undefined,
            sourceTerminalId: draft['source_terminal_id'] as string | undefined,
            items: draftItemsRaw.map((item: Record<string, unknown>, index: number) => ({
              id: (item['id'] as string) || `live-item-${index + 1}`,
              name: (item['name'] as string) || 'Draft Item',
              quantity: (item['quantity'] as number) || 1,
              station: (item['station_id'] as string) || (draft['station_id'] as string) || 'hot',
              status: 'pending',
              notes: item['notes'] as string | undefined,
              modifiers: item['modifiers'] as string[] | undefined,
            })),
          };
        });

        const seenOrderKeys = new Set(ticketOrders.flatMap(getKitchenOrderDedupeKeys));
        const localKitchenOrders = localOrders
          .map((order) => order as unknown as Record<string, unknown>)
          .filter((order) => isActiveLocalKitchenOrder(order))
          .filter((order) => (terminalId ? matchesKdsTerminal({}, terminalId, order) : true))
          .map(mapLocalOrderToKitchenOrder)
          .filter((order): order is KitchenOrder => order !== null)
          .filter((order) => {
            const keys = getKitchenOrderDedupeKeys(order);
            if (keys.some((key) => seenOrderKeys.has(key))) return false;
            keys.forEach((key) => seenOrderKeys.add(key));
            return true;
          });

        const kitchenOrders = [...ticketOrders, ...liveDraftOrders, ...localKitchenOrders];

        const filteredOrders = stationFilter === 'all'
          ? kitchenOrders
          : kitchenOrders.filter(order =>
              order.station_id === stationFilter ||
              order.items.some(item => item.station === stationFilter)
            );
        const nextOrdersSignature = buildOrdersSignature(filteredOrders);
        if (nextOrdersSignature !== lastOrdersSignatureRef.current) {
          setOrders(filteredOrders);
          lastOrdersSignatureRef.current = nextOrdersSignature;
        }
      } else {
        throw new Error(result?.data?.error || result?.error || 'Failed to fetch kitchen orders');
      }
    } catch (err) {
      console.error('Failed to fetch kitchen orders:', err);
      setError(err instanceof Error ? err.message : t('kitchen.loadError', 'Unable to load orders'));
      setOrders([]);
      lastOrdersSignatureRef.current = '';
    } finally {
      if (showLoading) {
        setLoading(false);
      }
    }
  }, [branchId, bridge, localOrderLookup, localOrders, stationFilter, t, terminalId]);

  useEffect(() => {
    void fetchExternalDisplayCapabilities();
    void loadLocalOrders().catch(() => {});
  }, [fetchExternalDisplayCapabilities, loadLocalOrders]);

  useEffect(() => {
    if (isIdentityResolving) {
      setLoading(true);
      setError(null);
      return;
    }

    if (!isIdentityReady) {
      setLoading(false);
      setOrders([]);
      setStations([]);
      lastOrdersSignatureRef.current = '';
      lastStationsSignatureRef.current = '';
      setError(null);
      return;
    }

    void fetchOrders(true);
  }, [fetchOrders, isIdentityReady, isIdentityResolving]);

  useEffect(() => {
    if (!autoRefresh || !isIdentityReady || !branchId) {
      setIsRealtimeConnected(false);
      return;
    }

    let disposed = false;

    const scheduleRealtimeRefresh = (delayMs = 180) => {
      if (disposed || realtimeRefreshTimerRef.current) {
        return;
      }
      realtimeRefreshTimerRef.current = setTimeout(() => {
        realtimeRefreshTimerRef.current = null;
        void fetchOrders(false);
      }, delayMs);
    };

    const unsubscribeRealtime = subscriptionManager.subscribe(KDS_REALTIME_SUBSCRIPTION_KEY, {
      table: 'kds_tickets',
      event: '*',
      filter: `branch_id=eq.${branchId}`,
      callback: (payload) => {
        const record = payload?.new || payload?.old;
        if (organizationId && record?.organization_id && record.organization_id !== organizationId) {
          return;
        }
        scheduleRealtimeRefresh(120);
      },
      onStatusChange: (status: SubscriptionStatus) => {
        if (status.status === 'active') {
          setIsRealtimeConnected(true);
          return;
        }
        setIsRealtimeConnected(false);
      },
    });

    return () => {
      disposed = true;
      unsubscribeRealtime();
      if (realtimeRefreshTimerRef.current) {
        clearTimeout(realtimeRefreshTimerRef.current);
        realtimeRefreshTimerRef.current = null;
      }
      setIsRealtimeConnected(false);
    };
  }, [autoRefresh, branchId, fetchOrders, isIdentityReady, organizationId]);

  useEffect(() => {
    if (!autoRefresh || !isIdentityReady || !branchId) {
      return;
    }

    const interval = setInterval(() => {
      void fetchOrders(false);
    }, KDS_FALLBACK_POLL_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [autoRefresh, branchId, fetchOrders, isIdentityReady]);

  // Auto-refresh from Rust-driven events when enabled.
  useEffect(() => {
    if (!autoRefresh) return;
    let disposed = false;
    let pendingTimer: ReturnType<typeof setTimeout> | null = null;
    let lastSyncRefreshAt = Date.now();

    const scheduleRefresh = (delayMs = 250) => {
      if (disposed || pendingTimer) return;
      pendingTimer = setTimeout(() => {
        pendingTimer = null;
        void fetchOrders(false);
      }, delayMs);
    };

    const handleOrderMutation = () => {
      scheduleRefresh(150);
    };

    const handleSyncStatus = () => {
      const now = Date.now();
      if (now - lastSyncRefreshAt < BACKGROUND_SYNC_REFRESH_MIN_MS) {
        return;
      }
      lastSyncRefreshAt = now;
      scheduleRefresh(300);
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
  }, [autoRefresh, fetchOrders]);

  const getTimeSinceOrder = (createdAt: string): string => {
    const diff = Date.now() - new Date(createdAt).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return t('kitchen.justNow', 'Just now');
    if (mins < 60) return `${mins} ${t('kitchen.min', 'min')}`;
    return `${Math.floor(mins / 60)}h ${mins % 60}m`;
  };

  const getTimeColor = (createdAt: string): string => {
    const diff = Date.now() - new Date(createdAt).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins > 20) return 'text-red-500';
    if (mins > 10) return 'text-yellow-500';
    return 'text-green-500';
  };

  const handleBumpOrder = async (orderId: string) => {
    const order = orders.find(o => o.id === orderId);
    if (!order) return;
    if (order.isDraft) {
      return;
    }
    // UI uses: pending -> preparing -> ready (clears from KDS)
    // API maps: preparing -> in_progress, ready -> completed
    // When status becomes 'ready', ticket disappears and order.status becomes 'ready'
    const newStatus = order.status === 'pending' ? 'preparing' : 'ready';

    // Optimistic update: remove from list if marking ready
    if (newStatus === 'ready') {
      setOrders(prev => prev.filter(o => o.id !== orderId));
    } else {
      setOrders(prev => prev.map(o => o.id === orderId ? { ...o, status: newStatus as 'pending' | 'preparing' } : o));
    }

    if (order.source === 'local-order') {
      const ok = await updateOrderStatus(order.sourceOrderId || order.id, newStatus);
      if (!ok) {
        fetchOrders();
      }
      return;
    }

    try {
      const result = await bridge.adminApi.fetchFromAdmin(
        `/api/pos/kds/${orderId}`,
        {
          method: 'PATCH',
          body: JSON.stringify({ status: newStatus }),
        }
      );

      // Note: fetchFromApi wraps responses in { success, data, status }
      if (result?.success && result?.data?.success) {
        if (soundEnabled) new Audio('/sounds/bump.mp3').play().catch(() => {});
        toast.success(t('kitchen.orderBumped', 'Order updated'));
        // Only refetch if not already removed (ready case already handled optimistically)
        if (newStatus !== 'ready') {
          fetchOrders();
        }
      } else {
        throw new Error(result?.data?.error || result?.error || 'Failed to update order');
      }
    } catch (error) {
      console.error('Failed to bump order:', error);
      toast.error(t('kitchen.bumpError', 'Failed to update order'));
      // Revert optimistic update on error
      fetchOrders();
    }
  };

  const openExternalDisplay = async (display?: ExternalDisplayInfo) => {
    setIsDisplayBusy(true);
    setDisplayNotice(null);
    setDisplayError(null);
    try {
      const result = await bridge.externalDisplay.open({
        contentType: KITCHEN_DISPLAY_CONTENT_TYPE,
        displayIndex: display?.index,
      });
      if (!result?.success) {
        throw new Error(result?.error || 'Failed to open kitchen display');
      }
      setDisplayNotice(
        t('kitchen.externalDisplay.running', 'Kitchen display is running on the selected monitor or TV.')
      );
      await fetchExternalDisplayCapabilities();
    } catch (err) {
      setDisplayError(
        err instanceof Error
          ? err.message
          : t('kitchen.externalDisplay.openFailed', 'Failed to open kitchen display')
      );
    } finally {
      setIsDisplayBusy(false);
    }
  };

  const closeExternalDisplay = async () => {
    setIsDisplayBusy(true);
    setDisplayNotice(null);
    setDisplayError(null);
    try {
      const result = await bridge.externalDisplay.close({ contentType: KITCHEN_DISPLAY_CONTENT_TYPE });
      if (!result?.success) {
        throw new Error(result?.error || 'Failed to close kitchen display');
      }
      setDisplayNotice(t('kitchen.externalDisplay.stopped', 'External kitchen display stopped.'));
      await fetchExternalDisplayCapabilities();
    } catch (err) {
      setDisplayError(
        err instanceof Error
          ? err.message
          : t('kitchen.externalDisplay.closeFailed', 'Failed to close kitchen display')
      );
    } finally {
      setIsDisplayBusy(false);
    }
  };

  const copyKdsTvLink = async () => {
    setDisplayNotice(null);
    setDisplayError(null);
    try {
      const result = await bridge.adminApi.fetchFromAdmin('/api/pos/kds-display', {
        method: 'POST',
        body: JSON.stringify({ action: 'pair' }),
      });
      const sessionId = result?.data?.pairing_session_id || result?.data?.pairingSessionId;
      if (!result?.success || !result?.data?.success || !sessionId) {
        throw new Error(result?.data?.error || result?.error || 'Failed to create KDS TV link');
      }

      const language = (i18n.language || 'en').split('-')[0];
      const theme = isDark ? 'dark' : 'light';
      const url = `${environment.ADMIN_DASHBOARD_URL.replace(/\/+$/, '')}/display/kds/${encodeURIComponent(
        sessionId
      )}?lang=${encodeURIComponent(language)}&theme=${encodeURIComponent(theme)}`;
      await bridge.clipboard.writeText(url);
      setDisplayNotice(
        t('kitchen.externalDisplay.tvLinkCopied', 'KDS TV link copied. Open it in a Smart TV browser or wireless receiver.')
      );
    } catch (err) {
      setDisplayError(
        err instanceof Error
          ? err.message
          : t('kitchen.externalDisplay.tvLinkFailed', 'Failed to create KDS TV link')
      );
    }
  };

  const StationIcon = ({ station }: { station: string }) => {
    switch (station) {
      case 'grill': return <Flame className="w-4 h-4 text-orange-500" />;
      case 'cold': return <Snowflake className="w-4 h-4 text-blue-500" />;
      case 'hot': return <Utensils className="w-4 h-4 text-red-500" />;
      case 'dessert': return <Coffee className="w-4 h-4 text-pink-500" />;
      case 'drinks': return <Coffee className="w-4 h-4 text-cyan-500" />;
      default: return <ChefHat className="w-4 h-4" />;
    }
  };

  const stats = {
    pending: orders.filter(o => o.status === 'pending').length,
    preparing: orders.filter(o => o.status === 'preparing').length,
    total: orders.length,
    avgTime: orders.length > 0 ? Math.round(orders.reduce((sum, o) => sum + (Date.now() - new Date(o.created_at).getTime()) / 60000, 0) / orders.length) : 0
  };
  const showMissingContext = !isIdentityResolving && !isIdentityReady;

  const OrderCard = ({ order }: { order: KitchenOrder }) => {
    const timeColor = getTimeColor(order.created_at);
    const isLiveDraft = order.isDraft;
    const orderLabel = isLiveDraft
      ? t('kitchen.liveDraft.badge', 'Live Draft')
      : formatCompactOrderNumberForDisplay(order.order_number);
    return (
      <motion.div
        initial={false}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.9 }}
        className={`p-4 rounded-xl border ${isDark ? 'bg-zinc-950 border-zinc-800' : 'bg-white border-gray-200'} ${order.priority === 'rush' ? 'ring-2 ring-red-500' : ''}`}
      >
        <div className="mb-3 flex items-start justify-between gap-3">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
            <span className="min-w-0 break-words text-xl font-bold leading-tight">
              {orderLabel}
            </span>
            <span className={`px-2 py-1 rounded-full text-xs font-medium ${getOrderTypeBadgeColor(order.order_type)}`}>
              {formatOrderType(order.order_type)}
            </span>
            {isLiveDraft && (
              <span className={`px-2 py-1 rounded-full text-xs font-medium ${isDark ? 'bg-cyan-500/20 text-cyan-300' : 'bg-cyan-100 text-cyan-700'}`}>
                {t('kitchen.liveDraft.subtitle', 'Live cart in progress')}
              </span>
            )}
            {order.table_number && <span className={`text-sm ${isDark ? 'text-zinc-400' : 'text-gray-600'}`}>{order.table_number}</span>}
          </div>
          <div className={`flex shrink-0 items-center gap-1 ${timeColor}`}>
            <Clock className="w-4 h-4" />
            <span className="text-sm font-medium">{getTimeSinceOrder(order.created_at)}</span>
          </div>
        </div>
        <div className="space-y-2 mb-4">
          {order.items.map((item) => (
            <div key={item.id} className={`flex items-center justify-between gap-2 p-2 rounded-lg ${isDark ? 'bg-zinc-800' : 'bg-gray-100'}`}>
              <div className="flex min-w-0 items-center gap-2">
                <StationIcon station={item.station} />
                <span className="font-medium">{item.quantity}x</span>
                <span className="min-w-0 break-words">{item.name}</span>
              </div>
              {item.notes && <span className={`text-xs ${isDark ? 'text-zinc-400' : 'text-gray-600'}`}>{item.notes}</span>}
            </div>
          ))}
        </div>
        {order.notes && (
          <div className={`mb-3 p-2 rounded-lg ${isDark ? 'bg-yellow-500/10 border border-yellow-500/30' : 'bg-yellow-50 border border-yellow-200'}`}>
            <p className="text-sm text-yellow-600">{order.notes}</p>
          </div>
        )}
        {isLiveDraft ? (
          <div className={`w-full py-3 rounded-xl text-center font-medium ${isDark ? 'bg-zinc-800 text-zinc-300' : 'bg-gray-100 text-gray-600'}`}>
            {t('kitchen.liveDraft.noAction', 'Waiting for checkout')}
          </div>
        ) : (
          <button
            onClick={() => handleBumpOrder(order.id)}
            className={`w-full py-3 rounded-xl font-medium transition-all ${order.status === 'pending' ? 'bg-blue-500 hover:bg-blue-600' : 'bg-green-500 hover:bg-green-600'} text-white`}
          >
            {order.status === 'pending' ? (
              <><Play className="w-4 h-4 inline mr-2" />{t('kitchen.startPreparing', 'Start Preparing')}</>
            ) : (
              <><CheckCircle className="w-4 h-4 inline mr-2" />{t('kitchen.markReady', 'Mark Ready')}</>
            )}
          </button>
        )}
      </motion.div>
    );
  };

  return (
    <div className={`h-full min-h-0 overflow-y-auto overflow-x-hidden scrollbar-hide p-4 md:p-5 ${isDark ? 'bg-black text-zinc-100' : 'bg-gray-50 text-gray-900'} ${externalWindow ? 'h-screen' : ''}`}>
      {/* Header + Stats Card */}
      <div className={`rounded-2xl border mb-5 px-4 py-4 ${isDark ? 'bg-zinc-950 border-zinc-800' : 'bg-white border-gray-200'}`}>
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <div className={`p-2 rounded-xl ${isDark ? 'bg-zinc-900 border border-zinc-700' : 'bg-gray-100 border border-gray-200'}`}>
            <ChefHat className={`w-6 h-6 ${isDark ? 'text-zinc-200' : 'text-gray-700'}`} />
          </div>
          <div>
            <h1 className="text-xl font-bold">{t('kitchen.title', 'Kitchen Display')}</h1>
            <p className={`text-sm ${isDark ? 'text-zinc-400' : 'text-gray-600'}`}>
              {t('kitchen.subtitle', 'Real-time order preparation')}
              {autoRefresh
                ? ` • ${isRealtimeConnected ? t('common.live', 'Live') : t('kitchen.pollingFallback', 'Polling fallback')}`
                : ''}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {!externalWindow && (
            <>
              <button
                type="button"
                onClick={() => void copyKdsTvLink()}
                className={`p-3 rounded-xl border ${isDark ? 'bg-zinc-900 border-zinc-700 hover:bg-zinc-800' : 'bg-white border-gray-300 hover:bg-gray-100'}`}
                title={t('kitchen.externalDisplay.copyTvLink', 'Copy TV link')}
                aria-label={t('kitchen.externalDisplay.copyTvLink', 'Copy TV link')}
              >
                <Copy className="w-5 h-5" />
              </button>
              {activeExternalDisplay ? (
                <button
                  type="button"
                  onClick={() => void closeExternalDisplay()}
                  disabled={isDisplayBusy}
                  className="p-3 rounded-xl border border-red-500/40 bg-red-500/10 text-red-300 hover:bg-red-500/20 disabled:opacity-60"
                  title={t('kitchen.externalDisplay.stop', 'Stop external display')}
                  aria-label={t('kitchen.externalDisplay.stop', 'Stop external display')}
                >
                  <X className="w-5 h-5" />
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => void openExternalDisplay(connectedDisplays[1] || connectedDisplays[0])}
                  disabled={isDisplayBusy}
                  className="p-3 rounded-xl border border-cyan-500/40 bg-cyan-500/10 text-cyan-300 hover:bg-cyan-500/20 disabled:opacity-60"
                  title={t('kitchen.externalDisplay.open', 'Open on connected display')}
                  aria-label={t('kitchen.externalDisplay.open', 'Open on connected display')}
                >
                  <ScreenShare className="w-5 h-5" />
                </button>
              )}
            </>
          )}
          <button onClick={() => setViewMode(viewMode === 'grid' ? 'list' : 'grid')} className={`p-3 rounded-xl border ${isDark ? 'bg-zinc-900 border-zinc-700 hover:bg-zinc-800' : 'bg-white border-gray-300 hover:bg-gray-100'}`}>
            {viewMode === 'grid' ? <List className="w-5 h-5" /> : <LayoutGrid className="w-5 h-5" />}
          </button>
          <button onClick={() => setSoundEnabled(!soundEnabled)} className={`p-3 rounded-xl border ${isDark ? 'bg-zinc-900 border-zinc-700 hover:bg-zinc-800' : 'bg-white border-gray-300 hover:bg-gray-100'}`}>
            {soundEnabled ? <Volume2 className="w-5 h-5" /> : <VolumeX className="w-5 h-5" />}
          </button>
          <button onClick={() => setAutoRefresh(!autoRefresh)} className={`p-3 rounded-xl border ${isDark ? 'bg-zinc-900 border-zinc-700 hover:bg-zinc-800' : 'bg-white border-gray-300 hover:bg-gray-100'} ${autoRefresh ? 'text-green-500' : ''}`}>
            {autoRefresh ? <Pause className="w-5 h-5" /> : <Play className="w-5 h-5" />}
          </button>
          <button
            onClick={() => {
              if (isIdentityReady) {
                void fetchOrders(true);
                return;
              }
              void refreshIdentity();
            }}
            className={`p-3 rounded-xl border ${isDark ? 'bg-zinc-900 border-zinc-700 hover:bg-zinc-800' : 'bg-white border-gray-300 hover:bg-gray-100'}`}
          >
            <RefreshCw className={`w-5 h-5 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-4 gap-3">
        <div className={`p-4 rounded-xl ${isDark ? 'bg-black border border-zinc-800' : 'bg-white border border-gray-200'}`}>
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-yellow-500/20"><AlertTriangle className="w-5 h-5 text-yellow-500" /></div>
            <div>
              <p className={`text-sm ${isDark ? 'text-zinc-400' : 'text-gray-600'}`}>{t('kitchen.pending', 'Pending')}</p>
              <p className="text-2xl font-bold">{stats.pending}</p>
            </div>
          </div>
        </div>
        <div className={`p-4 rounded-xl ${isDark ? 'bg-black border border-zinc-800' : 'bg-white border border-gray-200'}`}>
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-blue-500/20"><ChefHat className="w-5 h-5 text-blue-500" /></div>
            <div>
              <p className={`text-sm ${isDark ? 'text-zinc-400' : 'text-gray-600'}`}>{t('kitchen.preparing', 'Preparing')}</p>
              <p className="text-2xl font-bold">{stats.preparing}</p>
            </div>
          </div>
        </div>
        <div className={`p-4 rounded-xl ${isDark ? 'bg-black border border-zinc-800' : 'bg-white border border-gray-200'}`}>
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-green-500/20"><CheckCircle className="w-5 h-5 text-green-500" /></div>
            <div>
              <p className={`text-sm ${isDark ? 'text-zinc-400' : 'text-gray-600'}`}>{t('kitchen.total', 'Total')}</p>
              <p className="text-2xl font-bold">{stats.total}</p>
            </div>
          </div>
        </div>
        <div className={`p-4 rounded-xl ${isDark ? 'bg-black border border-zinc-800' : 'bg-white border border-gray-200'}`}>
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-cyan-500/20"><Timer className="w-5 h-5 text-cyan-500" /></div>
            <div>
              <p className={`text-sm ${isDark ? 'text-zinc-400' : 'text-gray-600'}`}>{t('kitchen.avgTime', 'Avg Time')}</p>
              <p className="text-2xl font-bold">{stats.avgTime} {t('kitchen.min', 'min')}</p>
            </div>
          </div>
        </div>
      </div>
      </div>

      {!externalWindow && connectedDisplays.length > 0 && (
        <div className={`rounded-2xl border mb-5 p-4 ${isDark ? 'bg-zinc-950 border-zinc-800' : 'bg-white border-gray-200'}`}>
          <div className="mb-3 flex items-center gap-2">
            <Monitor className="h-5 w-5 text-cyan-400" />
            <h2 className="font-bold">
              {t('kitchen.externalDisplay.connectedDisplays', 'Connected monitors and TVs')}
            </h2>
          </div>
          <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-hide">
            {connectedDisplays.map((display) => (
              <button
                key={display.index}
                type="button"
                onClick={() => void openExternalDisplay(display)}
                disabled={isDisplayBusy}
                className={`min-w-[210px] rounded-xl border px-3 py-3 text-left transition ${
                  isDark
                    ? 'border-zinc-700 bg-zinc-900 hover:bg-zinc-800'
                    : 'border-gray-200 bg-gray-50 hover:bg-gray-100'
                } disabled:opacity-60`}
              >
                <div className="font-semibold">{display.name}</div>
                <div className={isDark ? 'text-sm text-zinc-400' : 'text-sm text-gray-600'}>
                  {display.size?.width || 0} x {display.size?.height || 0}
                </div>
              </button>
            ))}
          </div>
          <p className={`mt-3 text-sm ${isDark ? 'text-zinc-400' : 'text-gray-600'}`}>
            {t(
              'kitchen.externalDisplay.help',
              'Cable displays and OS-level wireless displays appear here. For Smart TVs without monitor mode, copy the TV link.'
            )}
          </p>
        </div>
      )}

      {(displayNotice || displayError || displayCapabilities?.error) && !externalWindow && (
        <div
          className={`mb-5 rounded-xl border px-4 py-3 text-sm font-medium ${
            displayError || displayCapabilities?.error
              ? 'border-red-500/40 bg-red-500/10 text-red-200'
              : 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200'
          }`}
        >
          {displayError || displayCapabilities?.error || displayNotice}
        </div>
      )}

      {/* Station Filter */}
      <div className="flex gap-2 mb-5 overflow-x-auto pb-2 scrollbar-hide">
        {[{ id: 'all', name: t('kitchen.allStations', 'All'), station_type: 'all' } as KdsStation, ...stations].map((station) => (
          <button
            key={station.id}
            onClick={() => setStationFilter(station.id === 'all' ? 'all' : station.id)}
            className={`px-4 py-2 rounded-lg font-medium whitespace-nowrap transition-all border ${stationFilter === (station.id === 'all' ? 'all' : station.id) ? 'bg-cyan-500 text-white border-cyan-500' : isDark ? 'bg-zinc-950 text-zinc-300 border-zinc-800' : 'bg-white text-gray-600 border-gray-200'}`}
          >
            {station.id === 'all' ? t('kitchen.allStations', 'All') : station.name}
          </button>
        ))}
      </div>

      {/* Orders Grid */}
      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {[1, 2, 3, 4].map(i => (
            <div key={i} className={`p-6 rounded-xl border ${isDark ? 'bg-zinc-950 border-zinc-800' : 'bg-white border-gray-200'} animate-pulse`}>
              <div className={`h-6 rounded w-1/2 mb-4 ${isDark ? 'bg-zinc-800' : 'bg-gray-200'}`} />
              <div className="space-y-2">
                <div className={`h-10 rounded ${isDark ? 'bg-zinc-800' : 'bg-gray-200'}`} />
                <div className={`h-10 rounded ${isDark ? 'bg-zinc-800' : 'bg-gray-200'}`} />
              </div>
              <div className={`h-12 rounded mt-4 ${isDark ? 'bg-zinc-800' : 'bg-gray-200'}`} />
            </div>
          ))}
        </div>
      ) : showMissingContext ? (
        <div className={`p-12 rounded-xl text-center ${isDark ? 'bg-black border border-zinc-800' : 'bg-white border border-gray-200'}`}>
          <AlertTriangle className="w-16 h-16 mx-auto mb-4 text-amber-500 opacity-75" />
          <h3 className="text-xl font-semibold mb-2">
            {t('kitchen.contextMissing.title', 'Kitchen context is missing')}
          </h3>
          <p className={`mb-4 ${isDark ? 'text-zinc-400' : 'text-gray-600'}`}>
            {t(
              'kitchen.contextMissing.body',
              missing.branch
                ? 'This terminal is not assigned to a branch. Check terminal settings and try again.'
                : 'Kitchen context is incomplete. Check terminal settings and try again.'
            )}
          </p>
          <button
            onClick={() => {
              void refreshIdentity();
            }}
            className="px-6 py-2 rounded-lg bg-cyan-500 hover:bg-cyan-600 text-white font-medium transition-colors"
          >
            <RefreshCw className="w-4 h-4 inline mr-2" />
            {t('kitchen.contextMissing.action', 'Retry Context')}
          </button>
        </div>
      ) : error ? (
        <div className={`p-12 rounded-xl text-center ${isDark ? 'bg-black border border-zinc-800' : 'bg-white border border-gray-200'}`}>
          <AlertTriangle className="w-16 h-16 mx-auto mb-4 text-red-500 opacity-75" />
          <h3 className="text-xl font-semibold mb-2 text-red-500">{t('kitchen.loadError', 'Unable to Load Orders')}</h3>
          <p className={`mb-4 ${isDark ? 'text-zinc-400' : 'text-gray-600'}`}>{error}</p>
          <button
            onClick={() => {
              void fetchOrders(true);
            }}
            className="px-6 py-2 rounded-lg bg-cyan-500 hover:bg-cyan-600 text-white font-medium transition-colors"
          >
            <RefreshCw className="w-4 h-4 inline mr-2" />
            {t('common.retry', 'Retry')}
          </button>
        </div>
      ) : orders.length === 0 ? (
        <div className={`p-12 rounded-xl text-center ${isDark ? 'bg-black border border-zinc-800' : 'bg-white border border-gray-200'}`}>
          <ChefHat className="w-16 h-16 mx-auto mb-4 text-gray-400 opacity-50" />
          <h3 className="text-xl font-semibold mb-2">{t('kitchen.noOrders', 'No Active Orders')}</h3>
          <p className={isDark ? 'text-zinc-400' : 'text-gray-600'}>{t('kitchen.noOrdersDesc', 'New orders will appear here automatically')}</p>
        </div>
      ) : (
        <AnimatePresence initial={false}>
          <div className={viewMode === 'grid' ? 'grid grid-cols-[repeat(auto-fit,minmax(320px,1fr))] gap-4' : 'space-y-4'}>
            {orders.map((order) => (
              <OrderCard key={order.id} order={order} />
            ))}
          </div>
        </AnimatePresence>
      )}
    </div>
  );
};

export default KitchenDisplayPage;
