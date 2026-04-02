import { createElement } from 'react';
import { create } from 'zustand';
import { mapStatusForPOS, isValidOrderStatus } from '../../shared/types/order-status';
import toast from 'react-hot-toast';
import { Bell } from 'lucide-react';
import { ErrorFactory, ErrorHandler, withTimeout, withRetry, POSError } from '../../shared/utils/error-handler';
import { TIMING, RETRY, ERROR_MESSAGES } from '../../shared/constants';
import type { Order } from '../../shared/types/orders';
import { OrderService } from '../../services/OrderService';
import { getBridge, offEvent, onEvent } from '../../lib';
import {
  extractPaymentIntegrityPayload,
  summarizeUnsettledPaymentBlockers,
} from '../../lib/payment-integrity';
import type { PaymentIntegrityErrorPayload } from '../../lib/ipc-contracts';
import { pollFiscalReceiptStatus } from '../services/fiscal-status';
import { sortOrdersOldestFirst } from '../utils/order-sorting';

// Track self-created order IDs to suppress "new order received" toasts for own orders.
// Since Rust no longer emits order_created for self-created orders, this is a safety net
// in case order_save_from_remote echoes back our own order.
const _recentlyCreatedOrderIds = new Set<string>();

// Conflict and retry interfaces
interface OrderConflict {
  id: string;
  orderId: string;
  localVersion: number;
  remoteVersion: number;
  conflictType: string;
  createdAt: string;
}

interface SyncRetryInfo {
  orderId: string;
  attempts: number;
  maxAttempts: number;
  nextRetryAt: string;
  retryDelayMs: number;
  lastError?: string;
}

interface UpdateOrderStatusDetailedResult {
  success: boolean;
  errorMessage?: string;
  paymentIntegrityPayload?: PaymentIntegrityErrorPayload | null;
}

// IPC response interfaces for bridge calls
interface IpcResult {
  success?: boolean;
  error?: string;
  orderId?: string;
  status?: string;
  data?: {
    orderId?: string;
    driverName?: string;
    earningCreated?: boolean;
    status?: string;
  };
  driverName?: string;
  earningCreated?: boolean;
}

// IPC result for operations that return complex error objects
interface IpcResultWithDetailedError {
  success?: boolean;
  error?: string | { userMessage?: string; message?: string };
  orderId?: string;
  status?: string;
  data?: { orderId?: string; status?: string };
}

// Define the order store interface
interface OrderStore {
  orders: Order[];
  pendingExternalOrders: Order[];
  selectedOrder: Order | null;
  isLoading: boolean;
  error: POSError | null;
  loadingOperations: Set<string>;
  filter: {
    status: string;
    orderType: string;
    searchTerm: string;
  };

  // Conflict and retry state
  conflicts: OrderConflict[];
  syncRetries: Map<string, SyncRetryInfo>;

  // Cached/computed values
  _filteredOrders: Order[] | null;
  _orderCounts: { pending: number; preparing: number; ready: number; completed: number; cancelled: number } | null;

  // Actions
  initializeOrders: () => Promise<void>;
  loadOrders: () => Promise<void>;
  getOrderById: (orderId: string) => Promise<Order | null>;
  updateOrderStatus: (orderId: string, status: Order['status']) => Promise<boolean>;
  updateOrderStatusDetailed: (
    orderId: string,
    status: Order['status'],
  ) => Promise<UpdateOrderStatusDetailedResult>;
  returnCancelledToPending: (orderId: string) => Promise<boolean>;
  createOrder: (orderData: Partial<Order>) => Promise<{ success: boolean; orderId?: string; orderNumber?: string; error?: string; savedForRetry?: boolean }>;
  setSelectedOrder: (order: Order | null) => void;
  setFilter: (filter: Partial<OrderStore['filter']>) => void;
  getFilteredOrders: () => Order[];
  getOrderCounts: () => { pending: number; preparing: number; ready: number; completed: number; cancelled: number };
  refreshOrders: () => Promise<void>;
  /** Silent refresh that updates orders without triggering loading state - ideal for background polling */
  silentRefresh: () => Promise<void>;
  updatePaymentStatus: (orderId: string, paymentStatus: NonNullable<Order['paymentStatus']>, paymentMethod?: Order['paymentMethod'], transactionId?: string) => Promise<boolean>;
  processPayment: (orderId: string, paymentData: { method: Order['paymentMethod']; amount: number; [key: string]: any }) => Promise<{ success: boolean; transactionId?: string; error?: string }>;

  // Kitchen operations
  updatePreparationStatus: (orderId: string, status: 'preparing' | 'ready' | 'completed') => Promise<boolean>;
  printKitchenTicket: (orderId: string) => Promise<{ success: boolean; error?: string }>;
  getKitchenOrders: () => Order[];
  updateEstimatedTime: (orderId: string, estimatedTime: number) => Promise<boolean>;

  // Order approval operations
  approveOrder: (orderId: string, estimatedTime?: number) => Promise<boolean>;
  declineOrder: (orderId: string, reason: string) => Promise<boolean>;
  assignDriver: (orderId: string, driverId: string, notes?: string) => Promise<boolean>;
  convertToPickup: (orderId: string) => Promise<boolean>;
  updatePreparationProgress: (orderId: string, stage: string, progress: number) => Promise<boolean>;

  // Error handling
  getLastError: (operation?: string) => POSError | null;
  clearError: () => void;
  isOperationLoading: (operation: string) => boolean;

  // Conflict resolution
  getConflicts: () => OrderConflict[];
  resolveConflict: (conflictId: string, strategy: string) => Promise<boolean>;
  hasConflict: (orderId: string) => boolean;
  getSyncRetryInfo: (orderId: string) => SyncRetryInfo | null;
  getRetryCountdown: (orderId: string) => number | null;
  forceRetrySync: (orderId: string) => Promise<boolean>;

  // Internal methods
  _invalidateCache: () => void;
  _cleanup: () => void;
  _setupRealtimeListeners: () => void;
  _setLoading: (operation: string, loading: boolean) => void;
  _setError: (error: POSError | null) => void;
}

// Event listener cleanup registry
let eventListeners: Array<() => void> = [];

// Store initialization flag to prevent multiple subscriptions
let isStoreInitialized = false;

// Error handler instance
const errorHandler = ErrorHandler.getInstance();
const bridge = getBridge();

const INTERNAL_PLUGINS = new Set(['pos', 'web', 'android-ios', 'kiosk']);

const getOrderPlugin = (order: Order): string | null => {
  return (
    order.plugin ||
    order.order_plugin ||
    order.platform ||
    order.order_platform ||
    null
  );
};

const getExternalPluginOrderId = (order: Order): string | null => {
  return (
    order.external_plugin_order_id ||
    order.external_platform_order_id ||
    null
  );
};

const isPendingExternalOrder = (order: Order): boolean => {
  const plugin = getOrderPlugin(order);
  const externalId = getExternalPluginOrderId(order);
  return (
    order?.status === 'pending' &&
    !!externalId &&
    !!plugin &&
    !INTERNAL_PLUGINS.has(plugin)
  );
};

const isGhostOrder = (order?: Partial<Order> | null): boolean => {
  if (!order) return false;
  const value: unknown = order.is_ghost;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value === 1;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    return normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on';
  }
  return false;
};

const getOrderUniqueKey = (order: Order): string => {
  const plugin = getOrderPlugin(order);
  const externalId = getExternalPluginOrderId(order);
  if (externalId && plugin) {
    return `ext:${plugin}:${externalId}`;
  }
  const orderNumber = order.order_number || order.orderNumber;
  if (orderNumber) {
    return `ord:${orderNumber}`;
  }
  const supabaseId = order.supabase_id;
  if (supabaseId) {
    return `sup:${supabaseId}`;
  }
  return `id:${order?.id || Math.random().toString(36).slice(2)}`;
};

const dedupeOrders = (orders: Order[]): Order[] => {
  const byKey = new Map<string, Order>();

  const getOrderKeys = (order: Order): string[] => {
    const keys: string[] = [];
    if (order?.id) keys.push(`id:${order.id}`);

    const plugin = getOrderPlugin(order);
    const externalId = getExternalPluginOrderId(order);
    if (externalId && plugin) keys.push(`ext:${plugin}:${externalId}`);

    const orderNumber = order.order_number || order.orderNumber;
    if (orderNumber) keys.push(`ord:${orderNumber}`);

    const supabaseId = order.supabase_id;
    if (supabaseId) keys.push(`sup:${supabaseId}`);

    return keys;
  };

  const chooseOrder = (existing: Order, incoming: Order): Order => {
    const existingStatus = existing.sync_status || existing.syncStatus;
    const incomingStatus = incoming.sync_status || incoming.syncStatus;
    if (existingStatus === 'pending' && incomingStatus !== 'pending') return existing;
    if (incomingStatus === 'pending' && existingStatus !== 'pending') return incoming;

    const existingTs = new Date(existing.updated_at || existing.updatedAt || existing.created_at || existing.createdAt || 0).getTime();
    const incomingTs = new Date(incoming.updated_at || incoming.updatedAt || incoming.created_at || incoming.createdAt || 0).getTime();
    return incomingTs >= existingTs ? incoming : existing;
  };

  const replaceOrderReferences = (from: Order, to: Order) => {
    if (from === to) return;
    for (const [key, value] of byKey.entries()) {
      if (value === from) {
        byKey.set(key, to);
      }
    }
  };

  orders.forEach((order) => {
    const keys = getOrderKeys(order);
    if (keys.length === 0) {
      byKey.set(`rand:${Math.random().toString(36).slice(2)}`, order);
      return;
    }

    const existingKey = keys.find((key) => byKey.has(key));
    if (!existingKey) {
      keys.forEach((key) => byKey.set(key, order));
      return;
    }

    const existing = byKey.get(existingKey);
    if (!existing) {
      keys.forEach((key) => byKey.set(key, order));
      return;
    }

    const chosen = chooseOrder(existing, order);
    const other = chosen === existing ? order : existing;
    replaceOrderReferences(other, chosen);
    keys.forEach((key) => byKey.set(key, chosen));
  });

  return Array.from(new Set(byKey.values()));
};

const splitOrdersForQueue = (orders: Order[]): { visible: Order[]; pendingExternal: Order[] } => {
  const uniqueOrders = dedupeOrders(orders);
  const visible: Order[] = [];
  const pendingExternal: Order[] = [];

  uniqueOrders.forEach((order) => {
    if (isGhostOrder(order)) {
      return;
    }
    visible.push(order);
    if (isPendingExternalOrder(order)) {
      pendingExternal.push(order);
    }
  });

  pendingExternal.sort((a, b) => {
    const aTime = new Date(a.created_at || a.createdAt || 0).getTime();
    const bTime = new Date(b.created_at || b.createdAt || 0).getTime();
    return aTime - bTime;
  });

  return { visible: sortOrdersOldestFirst(visible), pendingExternal };
};

const splitOrdersForState = (orders: Order[]): { orders: Order[]; pendingExternalOrders: Order[] } => {
  const split = splitOrdersForQueue(orders);
  return { orders: split.visible, pendingExternalOrders: split.pendingExternal };
};

const invokeElectronIpc = async (channel: string, ...args: any[]): Promise<any> => {
  return bridge.invoke(channel, ...args);
};

const findOrderInState = (state: Pick<OrderStore, 'orders' | 'pendingExternalOrders'>, orderId: string): Order | null => {
  const combined = [...state.orders, ...state.pendingExternalOrders];
  return combined.find((order) => order.id === orderId) || null;
};

const findOrderIndex = (orders: Order[], incoming: Partial<Order>): number => {
  return orders.findIndex((order) =>
    order.id === incoming.id ||
    order.supabase_id === incoming.id ||
    order.supabase_id === incoming.supabase_id ||
    (order.order_number && incoming.order_number && order.order_number === incoming.order_number) ||
    (order.orderNumber && incoming.orderNumber && order.orderNumber === incoming.orderNumber)
  );
};

// Create the order store without subscribeWithSelector to avoid subscription conflicts
export const useOrderStore = create<OrderStore>()((set, get) => ({
    orders: [],
    pendingExternalOrders: [],
    selectedOrder: null,
    isLoading: false,
    error: null,
    loadingOperations: new Set<string>(),
    filter: {
      status: 'all',
      orderType: 'all',
      searchTerm: ''
    },

    // Convenience: reactivate cancelled order back to pending
    returnCancelledToPending: async (orderId: string) => {
      return await get().updateOrderStatus(orderId, 'pending');
    },

    // Conflict and retry state
    conflicts: [],
    syncRetries: new Map<string, SyncRetryInfo>(),

    // Cached values
    _filteredOrders: null,
    _orderCounts: null,

    // Error handling methods
    getLastError: (operation?: string) => {
      return get().error;
    },

    clearError: () => {
      set({ error: null });
    },

    isOperationLoading: (operation: string) => {
      return get().loadingOperations.has(operation);
    },

    _setLoading: (operation: string, loading: boolean) => {
      set((state) => {
        const newLoadingOps = new Set(state.loadingOperations);
        if (loading) {
          newLoadingOps.add(operation);
        } else {
          newLoadingOps.delete(operation);
        }
        return {
          loadingOperations: newLoadingOps,
          isLoading: newLoadingOps.size > 0
        };
      });
    },

    _setError: (error: POSError | null) => {
      set({ error });
    },

    _invalidateCache: () => {
      set({ _filteredOrders: null, _orderCounts: null });
    },

    _cleanup: () => {
      // Clean up all event listeners
      eventListeners.forEach(cleanup => cleanup());
      eventListeners = [];

      // Reset initialization flag
      isStoreInitialized = false;
      console.log('🧹 Order store cleaned up');
    },

    _setupRealtimeListeners: () => {
      if (typeof window === 'undefined') {
        console.log('⚠️ Renderer context unavailable, skipping real-time listeners setup');
        return;
      }

      console.log('📡 Setting up real-time order update listeners...');

      // Listen for real-time order updates from main process
      const handleOrderRealtimeUpdate = (orderData: Partial<Order>) => {
        console.log('📡 Received real-time order update (remote wins):', orderData);

        // Always accept remote: merge/overwrite local snapshot with remote payload
        set((state) => {
          const combined = [...state.orders, ...state.pendingExternalOrders];
          const existingOrderIndex = combined.findIndex(order =>
            order.id === orderData.id ||
            order.supabase_id === orderData.id ||
            (order.order_number && orderData.order_number && order.order_number === orderData.order_number)
          );

          if (existingOrderIndex >= 0) {
            const current = combined[existingOrderIndex];
            // Do not overwrite local pending changes
            if (current.sync_status === 'pending' || current.syncStatus === 'pending') {
              return { orders: state.orders, pendingExternalOrders: state.pendingExternalOrders };
            }
            // Only accept newer remote updates
            const currentTs = new Date(current.updatedAt || current.updated_at || 0).getTime();
            const incomingTs = new Date(orderData.updated_at || orderData.updatedAt || 0).getTime();
            if (incomingTs && currentTs && incomingTs <= currentTs) {
              return { orders: state.orders, pendingExternalOrders: state.pendingExternalOrders };
            }
            const updatedOrders = [...combined];
            const mappedStatus = orderData.status ? mapStatusForPOS(orderData.status) : current.status;
            const currentStatus = current.status as string;
            // Treat delivered and cancelled as final and sticky; do not revert them due to incoming non-final statuses
            const currentFinal = ['completed', 'cancelled', 'delivered'].includes(currentStatus);
            const incomingFinal = ['completed', 'cancelled', 'delivered'].includes(mappedStatus);
            const currentCancelled = currentStatus === 'cancelled' || currentStatus === 'canceled';
            const nextStatus = currentCancelled && mappedStatus !== 'cancelled'
              ? currentStatus
              : (currentFinal && !incomingFinal ? currentStatus : mappedStatus);
            updatedOrders[existingOrderIndex] = {
              ...updatedOrders[existingOrderIndex],
              ...orderData,
              status: nextStatus
            } as Order;
            const split = splitOrdersForQueue(updatedOrders);
            return { orders: split.visible, pendingExternalOrders: split.pendingExternal };
          } else {
            // Do not add remote-only orders; trigger refresh instead
            return { orders: state.orders, pendingExternalOrders: state.pendingExternalOrders };
          }
        });

        get()._invalidateCache();
      };

      // Listen for order status updates
      const handleOrderStatusUpdate = ({ orderId, status }: { orderId: string; status: string }) => {
        console.log('📡 Received order status update:', { orderId, status });

        const incomingMapped = mapStatusForPOS(status) as Order['status'];
        set((state) => {
          const combined = [...state.orders, ...state.pendingExternalOrders];
          const updated = combined.map(order =>
            order.id === orderId
              ? (() => {
                  const currentStatus = String(order.status || '').toLowerCase();
                  const isStickyFinal = currentStatus === 'delivered' || currentStatus === 'cancelled' || currentStatus === 'canceled';
                  return {
                    ...order,
                    // Preserve delivered/cancelled status from reverting due to any non-final push
                    status: isStickyFinal ? order.status : incomingMapped,
                    updatedAt: new Date().toISOString()
                  };
                })()
              : order
          );
          const split = splitOrdersForQueue(updated);
          return { orders: split.visible, pendingExternalOrders: split.pendingExternal };
        });

        get()._invalidateCache();
      };

      // Listen for new orders from OTHER terminals (order_save_from_remote only).
      // Self-created orders are added to state directly in createOrder().
      const handleOrderCreated = (orderData: any) => {
        if (!orderData || !orderData.id) {
          console.warn('⚠️ [useOrderStore] Invalid order data received:', orderData);
          return;
        }

        // Skip self-created orders (safety net)
        if (_recentlyCreatedOrderIds.has(orderData.id)) return;

        console.log('📡 [useOrderStore] Received remote order:', orderData.id);

        set((state) => {
          const combined = [...state.orders, ...state.pendingExternalOrders];
          const existingOrderIndex = findOrderIndex(combined, orderData);

          if (existingOrderIndex >= 0) {
            const updatedOrders = [...combined];
            updatedOrders[existingOrderIndex] = { ...updatedOrders[existingOrderIndex], ...orderData };
            return splitOrdersForState(updatedOrders as Order[]);
          }

          return splitOrdersForState([...combined, orderData] as Order[]);
        });

        get()._invalidateCache();

        // Show toast for remote orders only
        toast.success(`New order #${orderData.order_number || orderData.id.slice(0, 8)} received!`, {
          duration: 5000,
          icon: createElement(Bell, { className: 'w-4 h-4 text-blue-500' })
        });
      };

      // Listen for order updates (e.g., after editing items)
      const handleOrderUpdated = (orderData: Partial<Order> & { id: string }) => {
        console.log('📡 [useOrderStore] Received order updated:', orderData);

        // Validate order data
        if (!orderData || !orderData.id) {
          console.warn('⚠️ [useOrderStore] Invalid order update data received:', orderData);
          return;
        }

        set((state) => {
          const combined = [...state.orders, ...state.pendingExternalOrders];
          const existingOrderIndex = findOrderIndex(combined, orderData);

          if (existingOrderIndex >= 0) {
            console.log('📡 [useOrderStore] Updating order in state:', orderData.id);
            const updatedOrders = [...combined];
            const currentStatus = updatedOrders[existingOrderIndex].status as string;
            const incomingStatus = orderData.status
              ? mapStatusForPOS(orderData.status)
              : currentStatus;
            updatedOrders[existingOrderIndex] = {
              ...updatedOrders[existingOrderIndex],
              ...orderData,
              status: (currentStatus === 'cancelled' || currentStatus === 'canceled') && incomingStatus !== 'cancelled'
                ? currentStatus
                : incomingStatus,
              items: orderData.items || updatedOrders[existingOrderIndex].items,
              totalAmount: orderData.totalAmount ?? orderData.total_amount ?? updatedOrders[existingOrderIndex].totalAmount,
            } as Order;
            return splitOrdersForState(updatedOrders);
          }

          console.log('📡 [useOrderStore] Order not found in state, skipping update:', orderData.id);
          return { orders: state.orders, pendingExternalOrders: state.pendingExternalOrders };
        });

        get()._invalidateCache();
      };

      // Listen for order deletions (handles both direct orderId and realtime payload formats)
      const handleOrderDelete = (data: { orderId?: string; old?: { id: string } }) => {
        // Support both formats: { orderId } or { old: { id } } from realtime
        const orderId = data.orderId || data.old?.id;

        if (!orderId) {
          console.warn('📡 Received order deletion with no orderId:', data);
          return;
        }

        console.log('📡 Received order deletion:', { orderId });

        set((state) => {
          const combined = [...state.orders, ...state.pendingExternalOrders];
          const updatedOrders = combined.filter(order => order.id !== orderId);
          return splitOrdersForState(updatedOrders as Order[]);
        });

        get()._invalidateCache();
      };

      // Listen for payment status updates
      const handlePaymentUpdate = ({ orderId, paymentStatus, paymentMethod, transactionId }: any) => {
        console.log('📡 Received payment update:', { orderId, paymentStatus });

        set((state) => {
          const combined = [...state.orders, ...state.pendingExternalOrders];
          const updatedOrders = combined.map(order =>
            order.id === orderId
              ? {
                  ...order,
                  paymentStatus,
                  paymentMethod: paymentMethod || order.paymentMethod,
                  paymentTransactionId: transactionId || order.paymentTransactionId,
                  updatedAt: new Date().toISOString()
                }
              : order
          );
          return splitOrdersForState(updatedOrders as Order[]);
        });

        get()._invalidateCache();
      };

      // Listen for sync conflicts
      const handleSyncConflict = async (conflictData: any) => {
        console.log('⚠️ Received sync conflict — auto accepting remote:', conflictData);

        // Try resolving via main
        try {
          const conflictId = conflictData?.id ?? conflictData?.orderId;
          if (conflictId) {
            await bridge.orders.resolveConflict(conflictId, 'remote_wins');
          }
        } catch (e) {
          console.warn('Auto-resolve via main failed, will refresh orders:', e);
        }

        // Always refresh from server to ensure remote wins locally
        try {
          await get().loadOrders();
        } catch {}

        // Clear any existing conflicts from UI state
        set({ conflicts: [] });
      };

      // Listen for conflict resolutions
      const handleConflictResolved = ({ conflictId, orderId, strategy }: any) => {
        console.log('✅ Conflict resolved:', { conflictId, orderId, strategy });

        // Remove resolved conflict from state
        set((state) => ({
          ...state,
          conflicts: state.conflicts.filter(c => c.id !== conflictId && c.orderId !== orderId)
        }));

        get()._invalidateCache();
        toast.success(`Conflict resolved using ${strategy} strategy`);
      };

      // Listen for retry scheduling
      const handleRetryScheduled = ({ orderId, nextRetryAt, retryDelayMs, attempts }: any) => {
        console.log('🔄 Retry scheduled:', { orderId, nextRetryAt, retryDelayMs, attempts });

        set((state) => {
          const newRetries = new Map(state.syncRetries);
          newRetries.set(orderId, {
            orderId,
            nextRetryAt,
            retryDelayMs,
            attempts: attempts || (state.syncRetries.get(orderId)?.attempts || 0) + 1,
            maxAttempts: 5
          });
          return { syncRetries: newRetries };
        });
      };

      // Listen for orders cleared event
      const handleOrdersCleared = () => {
        console.log('🗑️  Orders cleared, refreshing...');
        set({ orders: [], pendingExternalOrders: [], conflicts: [] });
        get()._invalidateCache();
      };

      onEvent('order-realtime-update', handleOrderRealtimeUpdate);
      onEvent('order-status-updated', handleOrderStatusUpdate);
      onEvent('order-payment-updated', handlePaymentUpdate);
      onEvent('order-created', handleOrderCreated);
      onEvent('order-updated', handleOrderUpdated);
      onEvent('order-deleted', handleOrderDelete);
      onEvent('order-sync-conflict', handleSyncConflict);
      onEvent('order-conflict-resolved', handleConflictResolved);
      onEvent('sync-retry-scheduled', handleRetryScheduled);
      onEvent('orders-cleared', handleOrdersCleared);

      // Store cleanup functions
      eventListeners.push(
        () => offEvent('order-realtime-update', handleOrderRealtimeUpdate),
        () => offEvent('order-status-updated', handleOrderStatusUpdate),
        () => offEvent('order-payment-updated', handlePaymentUpdate),
        () => offEvent('order-created', handleOrderCreated),
        () => offEvent('order-updated', handleOrderUpdated),
        () => offEvent('order-deleted', handleOrderDelete),
        () => offEvent('order-sync-conflict', handleSyncConflict),
        () => offEvent('order-conflict-resolved', handleConflictResolved),
        () => offEvent('sync-retry-scheduled', handleRetryScheduled),
        () => offEvent('orders-cleared', handleOrdersCleared)
      );

      console.log('✅ Real-time order update listeners set up successfully');
    },

    initializeOrders: async () => {
      // Prevent multiple initializations
      if (isStoreInitialized) {
        console.log('📊 Order store already initialized, skipping...');
        return;
      }

      console.log('📊 Initializing order store...');
      isStoreInitialized = true;

      try {
        await get().loadOrders();

        // Set up real-time IPC listeners for order updates from main process
        get()._setupRealtimeListeners();

        console.log('✅ Order store initialized successfully with real-time updates');
      } catch (error) {
        console.error('❌ Failed to initialize order store:', error);
        isStoreInitialized = false; // Reset flag on error
        throw error;
      }
    },

    loadOrders: async () => {
      const operation = 'loadOrders';
      get()._setLoading(operation, true);
      get().clearError();

      try {
        const orderService = OrderService.getInstance();

        // Wrap with timeout and retry
        const orders = await withRetry(async () => {
          return await withTimeout(
            orderService.fetchOrders(),
            TIMING.DATABASE_QUERY_TIMEOUT,
            'Load orders'
          );
        }, RETRY.MAX_RETRY_ATTEMPTS, RETRY.RETRY_DELAY_MS);

        set(splitOrdersForState(orders));
        get()._invalidateCache();
        get()._setLoading(operation, false);
      } catch (error) {
        // Handle error
        const posError = errorHandler.handle(error);
        get()._setError(posError);
        get()._setLoading(operation, false);

        // Show user-friendly error message
        const userMessage = errorHandler.getUserMessage(posError);
        console.error('Failed to load orders:', userMessage);
        toast.error(userMessage || ERROR_MESSAGES.GENERIC_ERROR);
      }
    },

    // Optimized filtered orders with caching
    getFilteredOrders: () => {
      const state = get();

      // Return cached result if available
      if (state._filteredOrders !== null) {
        return state._filteredOrders;
      }

      let filtered = state.orders;

      // Apply status filter
      if (state.filter.status !== 'all') {
        filtered = filtered.filter(order => order.status === state.filter.status);
      }

      // Apply order type filter
      if (state.filter.orderType !== 'all') {
        filtered = filtered.filter(order => order.orderType === state.filter.orderType);
      }

      // Apply search filter
      if (state.filter.searchTerm) {
        const searchTerm = state.filter.searchTerm.toLowerCase();
        filtered = filtered.filter(order =>
          order.orderNumber.toLowerCase().includes(searchTerm) ||
          order.customerName?.toLowerCase().includes(searchTerm) ||
          order.customerPhone?.includes(searchTerm)
        );
      }

      // Cache the result
      set({ _filteredOrders: filtered });
      return filtered;
    },

    // Optimized order counts with caching
    getOrderCounts: () => {
      const state = get();

      // Use cached result if available
      if (state._orderCounts !== null) {
        return state._orderCounts;
      }

      const counts = state.orders.reduce((acc, order) => {
        acc[order.status] = (acc[order.status] || 0) + 1;
        return acc;
      }, {} as Record<string, number>);

      const result = {
        pending: counts.pending || 0,
        preparing: counts.preparing || 0,
        ready: counts.ready || 0,
        completed: counts.completed || 0,
        cancelled: counts.cancelled || 0,
      };

      // Cache the result
      set({ _orderCounts: result });
      return result;
    },

    setFilter: (newFilter) => {
      set((state) => ({
        filter: { ...state.filter, ...newFilter }
      }));
      get()._invalidateCache();
    },

    getOrderById: async (orderId: string) => {
      try {
        // Use local state since electron API is simplified
        const state = get();
        return (
          state.orders.find(order => order.id === orderId) ||
          state.pendingExternalOrders.find(order => order.id === orderId) ||
          null
        );
      } catch (error) {
        console.error('Failed to get order by ID:', error);
        return null;
      }
    },

    updateOrderStatusDetailed: async (orderId: string, status: Order['status']) => {
      const operation = `updateOrderStatus_${orderId}`;
      get()._setLoading(operation, true);
      get().clearError();

      try {
        // Validate inputs
        if (!orderId) {
          throw ErrorFactory.validation('Order ID is required');
        }

        const orderService = OrderService.getInstance();

        // Wrap with timeout
        await withTimeout(
          orderService.updateOrderStatus(orderId, status),
          TIMING.DATABASE_QUERY_TIMEOUT,
          'Update order status'
        );

        // Update local state after successful API call
        const mappedLocalStatus = mapStatusForPOS(status) as Order['status'];
      set((state) => {
        const combined = [...state.orders, ...state.pendingExternalOrders];
        const updatedOrders = combined.map(order =>
          order.id === orderId
            ? {
                ...order,
                status: mappedLocalStatus,
                updatedAt: new Date().toISOString(),
                sync_status: 'pending' as const,
                syncStatus: 'pending' as const
              }
            : order
        );
        return splitOrdersForState(updatedOrders);
      });


        get()._invalidateCache();
        get()._setLoading(operation, false);
        return { success: true };
      } catch (error) {
        const paymentIntegrityPayload =
          ((error as any)?.paymentIntegrityPayload as PaymentIntegrityErrorPayload | undefined) ||
          extractPaymentIntegrityPayload((error as any)?.details) ||
          extractPaymentIntegrityPayload((error as any)?.cause) ||
          extractPaymentIntegrityPayload((error as any)?.message) ||
          extractPaymentIntegrityPayload(error);
        if (paymentIntegrityPayload) {
          get()._setLoading(operation, false);
          return {
            success: false,
            errorMessage:
              paymentIntegrityPayload.error ||
              paymentIntegrityPayload.message ||
              summarizeUnsettledPaymentBlockers(paymentIntegrityPayload.blockers || []) ||
              'Order status update blocked by unsettled payment',
            paymentIntegrityPayload,
          };
        }

        // Handle error
        const posError = errorHandler.handle(error);
        get()._setError(posError);
        get()._setLoading(operation, false);
        return {
          success: false,
          errorMessage:
            errorHandler.getUserMessage(posError) || ERROR_MESSAGES.GENERIC_ERROR,
        };
      }
    },

    updateOrderStatus: async (orderId: string, status: Order['status']) => {
      const result = await get().updateOrderStatusDetailed(orderId, status);
      if (result.success) {
        toast.success('Order status updated');
        return true;
      }

      if (!result.paymentIntegrityPayload) {
        console.error('Failed to update order status:', result.errorMessage);
        toast.error(result.errorMessage || ERROR_MESSAGES.GENERIC_ERROR);
      }

      return false;
    },

    createOrder: async (orderData: Partial<Order>) => {
      const operation = 'createOrder';
      get()._setLoading(operation, true);
      get().clearError();

      try {
        // Validate order data
        if (!orderData.items || orderData.items.length === 0) {
          throw ErrorFactory.validation('Order must contain at least one item');
        }

        const orderService = OrderService.getInstance();

        // Create is side-effectful; keep timeout protection but do not retry.
        const newOrder = await withTimeout(
          orderService.createOrder(orderData),
          TIMING.ORDER_CREATE_TIMEOUT,
          'Create order'
        );

        // Track the ID so handleOrderCreated ignores any echo from remote sync
        if (newOrder.id) {
          _recentlyCreatedOrderIds.add(newOrder.id);
          setTimeout(() => _recentlyCreatedOrderIds.delete(newOrder.id), 30000);
        }

        // Add to state directly (no IPC event for self-created orders)
        if (newOrder.id) {
          set((state) => {
            const combined = [...state.orders, ...state.pendingExternalOrders];
            const orderForState = { ...orderData, ...newOrder, id: newOrder.id } as Order;
            return splitOrdersForState([orderForState, ...combined]);
          });
        }

        get()._invalidateCache();
        get()._setLoading(operation, false);

        if (newOrder.id && !isGhostOrder(orderData)) {
          pollFiscalReceiptStatus(newOrder.id, { timeoutMs: 30000, intervalMs: 2500 })
            .then((fiscalStatus) => {
              if (!fiscalStatus) {
                return;
              }

              if (fiscalStatus.status === 'NEEDS_FIX' || fiscalStatus.status === 'REJECTED') {
                console.warn('[useOrderStore] Fiscal submission requires attention', {
                  orderId: newOrder.id,
                  status: fiscalStatus.status,
                  error: fiscalStatus.error,
                  errorCode: fiscalStatus.error_code,
                });
              }
            })
            .catch((error) => {
              console.debug('[useOrderStore] Fiscal status polling skipped', {
                orderId: newOrder.id,
                error: error instanceof Error ? error.message : String(error),
              });
            });
        }

        return { success: true, orderId: newOrder.id, orderNumber: newOrder.orderNumber || newOrder.order_number };
      } catch (error) {
        // Handle error
        const posError = errorHandler.handle(error);
        get()._setError(posError);
        get()._setLoading(operation, false);

        // Save order for retry if it's a network/timeout error
        let savedForRetry = false;
        try {
          const resp = await bridge.orders.saveForRetry(orderData as Partial<Order>) as unknown as IpcResult;
          savedForRetry = !!resp?.success;
        } catch {}

        const userMessage = errorHandler.getUserMessage(posError);
        if (savedForRetry) {
          toast((t) => 'Order saved and will retry automatically when online');
        }

        return { success: false, error: userMessage, savedForRetry };
      }
    },

    setSelectedOrder: (order) => set({ selectedOrder: order }),

    refreshOrders: async () => {
      await get().loadOrders();
    },

    // Silent refresh - updates orders in background without loading states or toast errors
    // Ideal for fast polling (1-2 sec) without UI flicker
        silentRefresh: async () => {
      try {
        const orderService = OrderService.getInstance();
        const fetchedOrders = await orderService.fetchOrders();

        // Only update if we got valid data
        if (fetchedOrders && Array.isArray(fetchedOrders)) {
          set((state) => {
            const combinedCurrent = [...state.orders, ...state.pendingExternalOrders];
            const effectiveFetchedOrders = fetchedOrders.map((fetchedOrder) => {
              const fetchedOrderNumber = fetchedOrder.orderNumber || fetchedOrder.order_number;
              const fetchedSupabaseId = fetchedOrder.supabase_id;
              const localMatch = combinedCurrent.find((order) => {
                const orderNumber = order.orderNumber || order.order_number;
                const supabaseId = order.supabase_id;
                return order.id === fetchedOrder.id
                  || (fetchedOrderNumber && orderNumber === fetchedOrderNumber)
                  || (fetchedSupabaseId && supabaseId === fetchedSupabaseId);
              });

              if (!localMatch) return fetchedOrder;

              const localStatus = String(localMatch.status || '').toLowerCase();
              const fetchedStatus = String(fetchedOrder.status || '').toLowerCase();
              const keepLocalCancelled = (localStatus === 'cancelled' || localStatus === 'canceled')
                && fetchedStatus !== 'cancelled'
                && fetchedStatus !== 'canceled';

              return keepLocalCancelled
                ? { ...fetchedOrder, status: localMatch.status, updatedAt: localMatch.updatedAt || localMatch.updated_at }
                : fetchedOrder;
            });

            // Create lookup maps using multiple identifiers for proper deduplication
            // Orders can have different IDs locally vs in Supabase, but order_number is consistent
            const fetchedOrdersById = new Map(effectiveFetchedOrders.map(o => [o.id, o]));
            const fetchedOrdersByOrderNumber = new Map(
              effectiveFetchedOrders.filter(o => o.orderNumber || o.order_number)
                .map(o => [o.orderNumber || o.order_number, o])
            );
            const fetchedOrdersBySupabaseId = new Map(
              effectiveFetchedOrders.filter(o => o.supabase_id)
                .map(o => [o.supabase_id, o])
            );

            // Helper to check if an order exists in fetched results using any identifier
            const existsInFetched = (order: Order) => {
              const orderNum = order.orderNumber || order.order_number;
              const supabaseId = order.supabase_id;
              return fetchedOrdersById.has(order.id) ||
                     (orderNum && fetchedOrdersByOrderNumber.has(orderNum)) ||
                     (supabaseId && fetchedOrdersBySupabaseId.has(supabaseId));
            };

            // Preserve any orders in current state that aren't in the fetched list
            // This prevents race conditions where a newly created order hasn't been
            // committed to the database yet when silentRefresh runs
            const preservedOrders = combinedCurrent.filter(order => {
              // Keep orders that are not in the fetched list AND were created recently (within last 30 seconds)
              // This handles the race condition where order is created but not yet in DB query results
              if (!existsInFetched(order)) {
                const createdAt = new Date(order.createdAt || order.created_at || 0).getTime();
                const now = Date.now();
                const isRecent = (now - createdAt) < 30000; // 30 seconds
                if (isRecent) {
                  console.log(`[silentRefresh] Preserving recent order not in DB: ${order.id}, orderNumber: ${order.orderNumber || order.order_number}`);
                  return true;
                }
              }
              return false;
            });

            // Merge: fetched orders + preserved recent orders
            const mergedOrders = [...effectiveFetchedOrders, ...preservedOrders];

            // Remove duplicates using order_number as primary key (consistent across local and remote)
            // Fall back to id if order_number is not available
            const uniqueOrders = Array.from(
              new Map(mergedOrders.map(o => {
                const key = o.orderNumber || o.order_number || o.id;
                return [key, o];
              })).values()
            );

            return splitOrdersForState(uniqueOrders);
          });
          get()._invalidateCache();
        }
      } catch (error) {
        // Silently ignore errors during background refresh
        // Don't show toasts or set error states
        console.debug('Silent refresh failed (will retry):', error);
      }
    },

    updatePaymentStatus: async (orderId: string, paymentStatus: NonNullable<Order['paymentStatus']>, paymentMethod?: Order['paymentMethod'], transactionId?: string) => {
      try {
        // Update local state optimistically
        set((state) => {
          const combined = [...state.orders, ...state.pendingExternalOrders];
          const updatedOrders = combined.map(order =>
            order.id === orderId
              ? {
                  ...order,
                  paymentStatus,
                  paymentMethod: paymentMethod || order.paymentMethod,
                  paymentTransactionId: transactionId || order.paymentTransactionId,
                  updatedAt: new Date().toISOString()
                }
              : order
          );
          return splitOrdersForState(updatedOrders as Order[]);
        });


        get()._invalidateCache();

        const response = await invokeElectronIpc('payment:update-payment-status', {
          orderId,
          paymentStatus,
          paymentMethod,
          transactionId,
        });

        if (!response?.success) {
          throw new Error(response?.error || 'Failed to persist payment status');
        }

        return true;
      } catch (error) {
        console.error('Failed to update payment status:', error);
        try {
          await get().silentRefresh();
        } catch (refreshError) {
          console.debug('Silent refresh after payment update failure also failed:', refreshError);
        }
        return false;
      }
    },

     processPayment: async (orderId: string, paymentData: { method: Order['paymentMethod']; amount: number; [key: string]: any }) => {
       try {
         const normalizedMethod = paymentData.method === 'cash' || paymentData.method === 'card'
           ? paymentData.method
           : 'other';
         const transactionId = paymentData.transactionId || paymentData.transactionRef || `txn_${Date.now()}`;
         const response = await invokeElectronIpc('payment:record', {
           orderId,
           method: normalizedMethod,
           amount: paymentData.amount,
           currency: paymentData.currency || 'EUR',
           cashReceived: paymentData.cashReceived,
           changeGiven: paymentData.changeGiven,
           transactionRef: transactionId,
           discountAmount: paymentData.discountAmount,
           terminalApproved: paymentData.terminalApproved,
           terminalDeviceId: paymentData.terminalDeviceId,
           items: paymentData.items,
         });

         if (!response?.success) {
           throw new Error(response?.error || 'Payment processing failed');
         }

         await get().silentRefresh();
         return { success: true, transactionId };
       } catch (error) {
         console.error('Failed to process payment:', error);
         return { success: false, error: error instanceof Error ? error.message : 'Payment processing failed' };
       }
     },

    updatePreparationStatus: async (orderId: string, status: 'preparing' | 'ready' | 'completed') => {
      return await get().updateOrderStatus(orderId, status);
    },

    printKitchenTicket: async (orderId: string) => {
      try {
        const order = findOrderInState(get(), orderId);
        if (!order) {
          throw new Error('Order not found');
        }

        const result = await invokeElectronIpc('kitchen:print-ticket', {
          id: order.id,
          orderId: order.id,
          orderNumber: order.orderNumber || order.order_number,
          customerName: order.customerName || order.customer_name || 'Walk-in',
          orderType: order.orderType || order.order_type || 'pickup',
          tableNumber: order.tableNumber || order.table_number || null,
          notes: order.notes || order.special_instructions || null,
          createdAt: order.createdAt || order.created_at || new Date().toISOString(),
          estimatedTime: order.estimatedTime || order.estimated_time || null,
          items: order.items || [],
        });

        if (!result?.success) {
          throw new Error(result?.error || 'Kitchen print failed');
        }

        return { success: true };
      } catch (error) {
        console.error('Failed to print kitchen ticket:', error);
        return { success: false, error: error instanceof Error ? error.message : 'Printing failed' };
      }
    },

    getKitchenOrders: () => {
      const state = get();
      return state.orders.filter(order =>
        ['pending', 'preparing', 'ready'].includes(order.status)
      );
    },

    updateEstimatedTime: async (orderId: string, estimatedTime: number) => {
      try {
        // Update local state optimistically
        set((state) => {
          const combined = [...state.orders, ...state.pendingExternalOrders];
          const updatedOrders = combined.map(order =>
            order.id === orderId
              ? { ...order, estimatedTime, updatedAt: new Date().toISOString() }
              : order
          );
          return splitOrdersForState(updatedOrders);
        });


        get()._invalidateCache();

        const order = findOrderInState(get(), orderId);
        if (!order) {
          throw new Error('Order not found');
        }

        const currentStatus = mapStatusForPOS(order.status);
        const response = await invokeElectronIpc('order:update-status', {
          orderId,
          status: currentStatus,
          estimatedTime,
        });

        if (!response?.success) {
          throw new Error(response?.error || 'Failed to persist estimated time');
        }

        return true;
      } catch (error) {
        console.error('Failed to update estimated time:', error);
        try {
          await get().silentRefresh();
        } catch (refreshError) {
          console.debug('Silent refresh after estimated time update failure also failed:', refreshError);
        }
        return false;
      }
    },

    // Order approval methods
    approveOrder: async (orderId: string, estimatedTime?: number) => {
      const operation = `approveOrder_${orderId}`;
      get()._setLoading(operation, true);
      try {
        const result = await bridge.orders.approve(orderId, estimatedTime);
        if (result?.success) {
      set((state) => {
        const combined = [...state.orders, ...state.pendingExternalOrders];
        const updatedOrders = combined.map(order =>
          order.id === orderId
            ? { ...order, status: 'confirmed', estimatedTime: estimatedTime || 20, updatedAt: new Date().toISOString() }
            : order
        );
        return splitOrdersForState(updatedOrders as Order[]);
      });


          get()._invalidateCache();
          toast.success('Order approved');
          return true;
        }
        throw new Error(result?.error || 'Failed to approve order');
      } catch (error) {
        const posError = ErrorFactory.businessLogic('Failed to approve order', { error });
        get()._setError(posError);
        toast.error('Failed to approve order');
        return false;
      } finally {
        get()._setLoading(operation, false);
      }
    },

    declineOrder: async (orderId: string, reason: string) => {
      const operation = `declineOrder_${orderId}`;
      get()._setLoading(operation, true);
      try {
        const result = await bridge.orders.decline(orderId, reason);
        if (result?.success) {
      set((state) => {
        const combined = [...state.orders, ...state.pendingExternalOrders];
        const updatedOrders = combined.map(order =>
          order.id === orderId
            ? {
                ...order,
                status: 'cancelled',
                cancellationReason: reason,
                updatedAt: new Date().toISOString(),
                sync_status: 'pending',
                syncStatus: 'pending'
              }
            : order
        );
        return splitOrdersForState(updatedOrders as Order[]);
      });


          get()._invalidateCache();
          toast.success('Order declined');
          return true;
        }
        throw new Error(result?.error || 'Failed to decline order');
      } catch (error) {
        const posError = ErrorFactory.businessLogic('Failed to decline order', { error });
        get()._setError(posError);
        toast.error('Failed to decline order');
        return false;
      } finally {
        get()._setLoading(operation, false);
      }
    },

    assignDriver: async (orderId: string, driverId: string, notes?: string) => {
      const operation = `assignDriver_${orderId}`;
      get()._setLoading(operation, true);
      try {
        const result = await bridge.orders.assignDriver(orderId, driverId, notes) as unknown as IpcResult;
        const driverName = String(result?.driverName || result?.data?.driverName || '').trim();
        if (result?.success) {
      set((state) => {
        const combined = [...state.orders, ...state.pendingExternalOrders];
        const updatedOrders = combined.map(order =>
          order.id === orderId
            ? (() => {
                const currentStatus = String(order.status || '').toLowerCase();
                const isCancelled = currentStatus === 'cancelled' || currentStatus === 'canceled';
                const isFinal = currentStatus === 'completed' || currentStatus === 'delivered';
                const serverStatus = String(result?.data?.status || result?.status || '').trim().toLowerCase();
                const nextStatus = isCancelled
                  ? order.status
                  : (serverStatus
                    ? (mapStatusForPOS(serverStatus) as Order['status'])
                    : (isFinal ? order.status : 'delivered' as const));
                return {
                  ...order,
                  status: nextStatus,
                  orderType: 'delivery' as const,
                  order_type: 'delivery' as const,
                  driverId,
                  driver_id: driverId,
                  driverName: driverName || order.driverName || '',
                  driver_name: driverName || (order as any).driver_name || '',
                  updatedAt: new Date().toISOString(),
                  sync_status: 'pending' as const,
                  syncStatus: 'pending' as const
                };
              })()
            : order
        );
        return splitOrdersForState(updatedOrders);
      });


          get()._invalidateCache();
          toast.success(driverName ? `Driver assigned: ${driverName}` : 'Driver assigned');
          return true;
        }
        throw new Error(result?.error || 'Failed to assign driver');
      } catch (error) {
        const posError = ErrorFactory.businessLogic('Failed to assign driver', { error });
        get()._setError(posError);
        toast.error('Failed to assign driver');
        return false;
      } finally {
        get()._setLoading(operation, false);
      }
    },

    convertToPickup: async (orderId: string) => {
      const operation = `convertToPickup_${orderId}`;
      get()._setLoading(operation, true);
      try {
        const resp = await bridge.orders.updateType(orderId, 'pickup') as unknown as IpcResultWithDetailedError;
        if (resp?.success) {
      const updatedOrderId = resp?.orderId || resp?.data?.orderId || orderId;
      set((state) => {
        const combined = [...state.orders, ...state.pendingExternalOrders];
        const updatedOrders = combined.map(order =>
          order.id === updatedOrderId
            ? (() => {
                const currentStatus = String(order.status || '').toLowerCase();
                const isFinal = currentStatus === 'completed' || currentStatus === 'delivered';
                const serverStatus = String(resp?.data?.status || resp?.status || '').trim().toLowerCase();
                return {
                  ...order,
                  orderType: 'pickup' as const,
                  order_type: 'pickup' as const,
                  status: serverStatus
                    ? (mapStatusForPOS(serverStatus) as Order['status'])
                    : (!isFinal && currentStatus === 'out_for_delivery' ? 'ready' as const : order.status),
                  driverId: undefined,
                  driver_id: undefined,
                  driverName: '',
                  driver_name: '',
                  updatedAt: new Date().toISOString(),
                  sync_status: 'pending' as const,
                  syncStatus: 'pending' as const
                };
              })()
            : order
        );
        return splitOrdersForState(updatedOrders);
      });


          get()._invalidateCache();
          toast.success('Converted to Pickup');
          return true;
        }
        const rawError = resp?.error;
        let errMsg: string;
        if (typeof rawError === 'string') {
          errMsg = rawError;
        } else if (rawError && typeof rawError === 'object') {
          errMsg = rawError.userMessage || rawError.message || JSON.stringify(rawError);
        } else {
          errMsg = 'Failed to convert';
        }
        throw new Error(errMsg);
      } catch (error: any) {
        const message = error?.message || 'Failed to convert to Pickup';
        const posError = ErrorFactory.businessLogic('Failed to convert to pickup', { error });
        get()._setError(posError);
        toast.error(message);
        return false;
      } finally {
        get()._setLoading(operation, false);
      }
    },



    updatePreparationProgress: async (orderId: string, stage: string, progress: number) => {
      const operation = `updateProgress_${orderId}`;
      get()._setLoading(operation, true);
      try {
        const result = await bridge.orders.updatePreparation(orderId, stage, progress);
        if (result?.success) {
      set((state) => {
        const combined = [...state.orders, ...state.pendingExternalOrders];
        const updatedOrders = combined.map(order =>
          order.id === orderId
            ? { ...order, preparationProgress: progress, updatedAt: new Date().toISOString() }
            : order
        );
        return splitOrdersForState(updatedOrders);
      });


          get()._invalidateCache();
          return true;
        }
        throw new Error(result?.error || 'Failed to update preparation progress');
      } catch (error) {
        console.error('Failed to update preparation progress:', error);
        return false;
      } finally {
        get()._setLoading(operation, false);
      }
    },

    // Conflict resolution methods
    getConflicts: () => {
      return get().conflicts;
    },

    resolveConflict: async (conflictId: string, strategy: string) => {
      try {
        const result = await bridge.orders.resolveConflict(conflictId, strategy) as unknown as IpcResult;
        if (result?.success !== false) {
          // Remove resolved conflict from state
          set((state) => ({
            ...state,
            conflicts: state.conflicts.filter(c => c.id !== conflictId)
          }));
          return true;
        }
        return false;
      } catch (error) {
        console.error('Failed to resolve conflict:', error);
        return false;
      }
    },

    hasConflict: (orderId: string) => {
      return get().conflicts.some(c => c.orderId === orderId);
    },

    getSyncRetryInfo: (orderId: string) => {
      return get().syncRetries.get(orderId) || null;
    },

    getRetryCountdown: (orderId: string) => {
      const retryInfo = get().syncRetries.get(orderId);
      if (!retryInfo) return null;

      const nextRetry = new Date(retryInfo.nextRetryAt).getTime();
      const now = Date.now();
      const secondsUntilRetry = Math.max(0, Math.floor((nextRetry - now) / 1000));

      return secondsUntilRetry;
    },

    forceRetrySync: async (orderId: string) => {
      try {
        const result = await bridge.orders.forceSyncRetry(orderId) as unknown as IpcResult;
        if (result?.success !== false) {
          // Remove from retry map
          set((state) => {
            const newRetries = new Map(state.syncRetries);
            newRetries.delete(orderId);
            return { syncRetries: newRetries };
          });
          return true;
        }
        return false;
      } catch (error) {
        console.error('Failed to force retry sync:', error);
        return false;
      }
    }
  }));

// Export cleanup function for component unmounting
export const cleanupOrderStore = () => {
  const store = useOrderStore.getState();
  store._cleanup();
};
