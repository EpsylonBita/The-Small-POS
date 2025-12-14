import { create } from 'zustand';
import { mapStatusForPOS, isValidOrderStatus } from '../../../../shared/types/order-status';
import toast from 'react-hot-toast';
import { ErrorFactory, ErrorHandler, withTimeout, withRetry, POSError } from '../../shared/utils/error-handler';
import { TIMING, RETRY, ERROR_MESSAGES } from '../../shared/constants';
import type { Order } from '../../shared/types/orders';
import { OrderService } from '../../services/OrderService';

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

// Define the order store interface
interface OrderStore {
  orders: Order[];
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
  returnCancelledToPending: (orderId: string) => Promise<boolean>;
  createOrder: (orderData: Partial<Order>) => Promise<{ success: boolean; orderId?: string; error?: string; savedForRetry?: boolean }>;
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

// Create the order store without subscribeWithSelector to avoid subscription conflicts
export const useOrderStore = create<OrderStore>()((set, get) => ({
    orders: [],
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
      // Check if we're in Electron environment
      if (typeof window !== 'undefined' && window.electronAPI) {
        console.log('📡 Setting up real-time order update listeners...');

        // Listen for real-time order updates from main process
        const handleOrderRealtimeUpdate = (orderData: any) => {
          console.log('📡 Received real-time order update (remote wins):', orderData);

          // Always accept remote: merge/overwrite local snapshot with remote payload
          set((state) => {
            const existingOrderIndex = state.orders.findIndex(order =>
              order.id === orderData.id ||
              order.supabase_id === orderData.id ||
              (order.order_number && orderData.order_number && order.order_number === orderData.order_number)
            );

            if (existingOrderIndex >= 0) {
              const current: any = state.orders[existingOrderIndex] as any;
              // Do not overwrite local pending changes
              if ((current as any).sync_status === 'pending' || (current as any).syncStatus === 'pending') {
                return { orders: state.orders };
              }
              // Only accept newer remote updates
              const currentTs = new Date((current as any).updatedAt || (current as any).updated_at || 0).getTime();
              const incomingTs = new Date((orderData as any).updated_at || (orderData as any).updatedAt || 0).getTime();
              if (incomingTs && currentTs && incomingTs <= currentTs) {
                return { orders: state.orders };
              }
              const updatedOrders = [...state.orders];
              const mappedStatus = (orderData as any).status ? mapStatusForPOS((orderData as any).status as any) : (current as any).status;
              const currentStatus = (current as any).status as string;
              // Treat delivered and cancelled as final and sticky; do not revert them due to incoming non-final statuses
              const currentFinal = ['completed','cancelled','delivered'].includes(currentStatus);
              const incomingFinal = ['completed','cancelled','delivered'].includes(mappedStatus as any);
              const nextStatus = currentFinal && !incomingFinal ? currentStatus : mappedStatus;
              updatedOrders[existingOrderIndex] = {
                ...updatedOrders[existingOrderIndex],
                ...orderData,
                status: nextStatus
              };
              return { orders: updatedOrders };
            } else {
              // Do not add remote-only orders; trigger refresh instead
              return { orders: state.orders };
            }
          });

          get()._invalidateCache();
        };

        // Listen for order status updates
        const handleOrderStatusUpdate = ({ orderId, status }: { orderId: string; status: string }) => {
          console.log('📡 Received order status update:', { orderId, status });

          const incomingMapped = mapStatusForPOS(status as any);
          set((state) => ({
            orders: state.orders.map(order =>
              order.id === orderId
                ? {
                    ...order,
                    // Preserve delivered/cancelled status from reverting due to any non-final push
                    status: (order.status === 'delivered' || order.status === 'cancelled') ? order.status : (incomingMapped as any),
                    updatedAt: new Date().toISOString()
                  }
                : order
            )
          }));

          get()._invalidateCache();
        };

        // Listen for new orders being created
        const handleOrderCreated = (orderData: any) => {
          console.log('📡 [useOrderStore] Received new order created:', orderData);

          // Validate order data
          if (!orderData || !orderData.id) {
            console.warn('⚠️ [useOrderStore] Invalid order data received:', orderData);
            return;
          }

          set((state) => {
            // Check if order already exists
            const existingOrderIndex = state.orders.findIndex(order => order.id === orderData.id);

            if (existingOrderIndex >= 0) {
              console.log('📡 [useOrderStore] Updating existing order:', orderData.id);
              // Update existing order
              const updatedOrders = [...state.orders];
              updatedOrders[existingOrderIndex] = { ...updatedOrders[existingOrderIndex], ...orderData };
              return { orders: updatedOrders };
            } else {
              console.log('📡 [useOrderStore] New remote order will be loaded from local DB, avoiding duplicate temp record');
              // Avoid adding remote-only record; local DB merge will load it on next refresh
              return { orders: state.orders };
            }
          });

          get()._invalidateCache();

          // Show toast notification for new order
          toast.success(`New order #${orderData.order_number || orderData.id.slice(0, 8)} received!`, {
            duration: 5000,
            icon: '🔔'
          });
        };

        // Listen for order deletions
        const handleOrderDelete = ({ orderId }: { orderId: string }) => {
          console.log('📡 Received order deletion:', { orderId });

          set((state) => ({
            orders: state.orders.filter(order => order.id !== orderId)
          }));

          get()._invalidateCache();
        };

        // Listen for payment status updates
        const handlePaymentUpdate = ({ orderId, paymentStatus, paymentMethod, transactionId }: any) => {
          console.log('📡 Received payment update:', { orderId, paymentStatus });

          set((state) => ({
            orders: state.orders.map(order =>
              order.id === orderId
                ? {
                    ...order,
                    paymentStatus,
                    paymentMethod: paymentMethod || order.paymentMethod,
                    paymentTransactionId: transactionId || order.paymentTransactionId,
                    updatedAt: new Date().toISOString()
                  }
                : order
            )
          }));

          get()._invalidateCache();
        };

        // Listen for sync conflicts
        const handleSyncConflict = async (conflictData: any) => {
          console.log('⚠️ Received sync conflict — auto accepting remote:', conflictData);

          // Try resolving via main if available
          try {
            if (window.electronAPI?.resolveOrderConflict) {
              await window.electronAPI.resolveOrderConflict(conflictData.id ?? conflictData.orderId, 'remote_wins');
            } else if (window.electronAPI?.resolveOrderConflictAlias) {
              await window.electronAPI.resolveOrderConflictAlias(conflictData.id ?? conflictData.orderId, 'remote_wins');
            } else if (window.electronAPI?.resolveOrderConflictAlt) {
              await window.electronAPI.resolveOrderConflictAlt(conflictData.id ?? conflictData.orderId, 'remote_wins');
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

          set((state) => ({
            conflicts: state.conflicts.filter(c => c.id !== conflictId)
          }));

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

        // Register IPC listeners
        window.electronAPI.onOrderRealtimeUpdate(handleOrderRealtimeUpdate);
        window.electronAPI.onOrderStatusUpdated(handleOrderStatusUpdate);
        window.electronAPI.onOrderDeleted(handleOrderDelete);
        window.electronAPI.onOrderPaymentUpdated(handlePaymentUpdate);

        // Register listener for new orders
        let unsubscribeOrderCreated: (() => void) | undefined;
        if (window.electronAPI.onOrderCreated) {
          unsubscribeOrderCreated = window.electronAPI.onOrderCreated(handleOrderCreated);
          console.log('✅ Registered order-created listener');
        }

        // Listen for orders cleared event
        const handleOrdersCleared = () => {
          console.log('🗑️  Orders cleared, refreshing...');
          set({ orders: [], conflicts: [] });
          get()._invalidateCache();
          toast.success('All orders cleared successfully');
        };

        // Register conflict and retry listeners
        if (window.electronAPI.ipcRenderer) {
          // Preload wrapper passes only the data argument to callbacks
          window.electronAPI.ipcRenderer.on('order-sync-conflict', handleSyncConflict);
          window.electronAPI.ipcRenderer.on('order-conflict-resolved', handleConflictResolved);
          window.electronAPI.ipcRenderer.on('sync-retry-scheduled', handleRetryScheduled);
          window.electronAPI.ipcRenderer.on('orders-cleared', handleOrdersCleared);
        }

        // Store cleanup functions
        eventListeners.push(
          () => window.electronAPI?.removeOrderRealtimeUpdateListener?.(handleOrderRealtimeUpdate),
          () => window.electronAPI?.removeOrderStatusUpdatedListener?.(handleOrderStatusUpdate),
          () => window.electronAPI?.removeOrderDeletedListener?.(handleOrderDelete),
          () => window.electronAPI?.removeOrderPaymentUpdatedListener?.(handlePaymentUpdate),
          () => unsubscribeOrderCreated?.(),
          () => window.electronAPI?.ipcRenderer?.removeAllListeners('order-sync-conflict'),
          () => window.electronAPI?.ipcRenderer?.removeAllListeners('order-conflict-resolved'),
          () => window.electronAPI?.ipcRenderer?.removeAllListeners('sync-retry-scheduled'),
          () => window.electronAPI?.ipcRenderer?.removeAllListeners('orders-cleared')
        );

        console.log('✅ Real-time order update listeners set up successfully');
      } else {
        console.log('⚠️ Electron API not available, skipping real-time listeners setup');
      }
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

        set({ orders });
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
        delivered: counts.delivered || 0
      } as any;

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
        return state.orders.find(order => order.id === orderId) || null;
      } catch (error) {
        console.error('Failed to get order by ID:', error);
        return null;
      }
    },

    updateOrderStatus: async (orderId: string, status: Order['status']) => {
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
        const mappedLocalStatus = mapStatusForPOS(status as any);
        set((state) => ({
          orders: state.orders.map(order =>
            order.id === orderId
              ? { ...order, status: mappedLocalStatus as any, updatedAt: new Date().toISOString() }
              : order
          )
        }));
        get()._invalidateCache();
        get()._setLoading(operation, false);

        toast.success('Order status updated');
        return true;
      } catch (error) {
        // Handle error
        const posError = errorHandler.handle(error);
        get()._setError(posError);
        get()._setLoading(operation, false);

        // Show user-friendly error message
        const userMessage = errorHandler.getUserMessage(posError);
        console.error('Failed to update order status:', userMessage);
        toast.error(userMessage || ERROR_MESSAGES.GENERIC_ERROR);

        return false;
      }
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

        // Wrap with timeout and retry
        const newOrder = await withRetry(async () => {
          return await withTimeout(
            orderService.createOrder(orderData),
            TIMING.ORDER_CREATE_TIMEOUT,
            'Create order'
          );
        }, RETRY.MAX_RETRY_ATTEMPTS, RETRY.RETRY_DELAY_MS);

        // Don't add to state here - the order-created IPC event will handle it
        // This prevents duplicate orders in the list
        get()._invalidateCache();
        get()._setLoading(operation, false);

        toast.success('Order created successfully');
        return { success: true, orderId: newOrder.id };
      } catch (error) {
        // Handle error
        const posError = errorHandler.handle(error);
        get()._setError(posError);
        get()._setLoading(operation, false);

        // Save order for retry if it's a network/timeout error
        let savedForRetry = false;
        try {
          const resp = await window.electronAPI?.saveOrderForRetry?.(orderData);
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
        const orders = await orderService.fetchOrders();

        // Only update if we got valid data
        if (orders && Array.isArray(orders)) {
          set({ orders });
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
         set((state) => ({
           orders: state.orders.map(order =>
             order.id === orderId
               ? {
                   ...order,
                   paymentStatus,
                   paymentMethod: paymentMethod || order.paymentMethod,
                   paymentTransactionId: transactionId || order.paymentTransactionId,
                   updatedAt: new Date().toISOString()
                 }
               : order
           )
         }));
         get()._invalidateCache();

         // TODO: Sync with backend when payment API is available
         return true;
       } catch (error) {
         console.error('Failed to update payment status:', error);
         return false;
       }
     },

     processPayment: async (orderId: string, paymentData: { method: Order['paymentMethod']; amount: number; [key: string]: any }) => {
       try {
         // Simulate payment processing for now
         const transactionId = `txn_${Date.now()}`;
         await get().updatePaymentStatus(orderId, 'completed', paymentData.method, transactionId);
         return { success: true, transactionId };
       } catch (error) {
         console.error('Failed to process payment:', error);
         return { success: false, error: 'Payment processing failed' };
       }
     },

    updatePreparationStatus: async (orderId: string, status: 'preparing' | 'ready' | 'completed') => {
      return await get().updateOrderStatus(orderId, status);
    },

         printKitchenTicket: async (orderId: string) => {
       try {
         // Simulate printing for now - TODO: implement kitchen printing API
         // Kitchen ticket printing would be implemented here
         return { success: true };
       } catch (error) {
         console.error('Failed to print kitchen ticket:', error);
         return { success: false, error: 'Printing failed' };
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
         set((state) => ({
           orders: state.orders.map(order =>
             order.id === orderId
               ? { ...order, estimatedTime, updatedAt: new Date().toISOString() }
               : order
           )
         }));
         get()._invalidateCache();

         // TODO: Sync with backend when estimated time API is available
         return true;
       } catch (error) {
         console.error('Failed to update estimated time:', error);
         return false;
       }
     },

    // Order approval methods
    approveOrder: async (orderId: string, estimatedTime?: number) => {
      const operation = `approveOrder_${orderId}`;
      get()._setLoading(operation, true);
      try {
        const result = await window.electronAPI?.approveOrder?.(orderId, estimatedTime);
        if (result?.success) {
          set((state) => ({
            orders: state.orders.map(order =>
              order.id === orderId
                ? { ...order, status: 'confirmed', estimatedTime: estimatedTime || 30, updatedAt: new Date().toISOString() }
                : order
            )
          }));
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
        const result = await window.electronAPI?.declineOrder?.(orderId, reason);
        if (result?.success) {
          set((state) => ({
            orders: state.orders.map(order =>
              order.id === orderId
                ? { ...order, status: 'cancelled', cancellationReason: reason, updatedAt: new Date().toISOString() }
                : order
            )
          }));
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
        const result = await window.electronAPI?.assignDriverToOrder?.(orderId, driverId, notes);
        if (result?.success) {
          set((state) => ({
            orders: state.orders.map(order =>
              order.id === orderId
                ? { ...order, status: 'completed', driverId, driverName: result.driverName, updatedAt: new Date().toISOString() }
                : order
            )
          }));
          // Persist final status via dedicated IPC
          try {
            await window.electronAPI?.invoke?.('order:update-status', { orderId, status: 'completed' });
          } catch (e) {
            console.warn('[useOrderStore] update-status failed after driver assignment', e);
          }
          get()._invalidateCache();
          toast.success(`Driver assigned: ${result.driverName}`);
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
        const resp = (await (window.electronAPI?.updateOrderType
          ? window.electronAPI.updateOrderType(orderId, 'pickup')
          : window.electronAPI?.invoke?.('order:update-type', orderId, 'pickup')));
        if (resp?.success) {
          set((state) => ({
            orders: state.orders.map(order =>
              order.id === (resp.orderId || orderId)
                ? { ...order, orderType: 'pickup', driverId: undefined, updatedAt: new Date().toISOString() }
                : order
            )
          }));
          get()._invalidateCache();
          toast.success('Converted to Pickup');
          return true;
        }
        const errMsg = typeof resp?.error === 'string'
          ? resp.error
          : (resp?.error?.userMessage || resp?.error?.message || (resp?.error ? JSON.stringify(resp.error) : 'Failed to convert'));
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
        const result = await window.electronAPI?.updateOrderPreparation?.(orderId, stage, progress);
        if (result?.success) {
          set((state) => ({
            orders: state.orders.map(order =>
              order.id === orderId
                ? { ...order, preparationProgress: progress, updatedAt: new Date().toISOString() }
                : order
            )
          }));
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
        if (
          window.electronAPI?.resolveOrderConflict ||
          window.electronAPI?.resolveOrderConflictAlias ||
          window.electronAPI?.resolveOrderConflictAlt
        ) {
          const result = window.electronAPI.resolveOrderConflict
            ? await window.electronAPI.resolveOrderConflict(conflictId, strategy)
            : window.electronAPI.resolveOrderConflictAlias
            ? await window.electronAPI.resolveOrderConflictAlias(conflictId, strategy)
            : await window.electronAPI.resolveOrderConflictAlt(conflictId, strategy);
          if (result) {
            // Remove resolved conflict
            set((state) => ({
              conflicts: state.conflicts.filter(c => c.id !== conflictId)
            }));
            return true;
          }
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
        if (
          window.electronAPI?.forceOrderSyncRetry ||
          window.electronAPI?.forceOrderSyncRetryAlias ||
          window.electronAPI?.forceOrderSyncRetryAlt
        ) {
          const result = window.electronAPI.forceOrderSyncRetry
            ? await window.electronAPI.forceOrderSyncRetry(orderId)
            : window.electronAPI.forceOrderSyncRetryAlias
            ? await window.electronAPI.forceOrderSyncRetryAlias(orderId)
            : await window.electronAPI.forceOrderSyncRetryAlt(orderId);
          if (result) {
            // Remove from retry map
            set((state) => {
              const newRetries = new Map(state.syncRetries);
              newRetries.delete(orderId);
              return { syncRetries: newRetries };
            });
            return true;
          }
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