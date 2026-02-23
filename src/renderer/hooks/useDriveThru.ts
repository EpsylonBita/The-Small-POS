/**
 * useDriveThru Hook
 * 
 * React hook for managing drive-through lanes and orders in the POS system (Fast-food Vertical).
 * Provides data fetching, mutations, and real-time updates.
 * 
 * Task 17.3: Create POS drive-through interface
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import toast from 'react-hot-toast';
import { offEvent, onEvent } from '../../lib';
import {
  driveThruService,
  DriveThruLane,
  DriveThruOrder,
  DriveThruStats,
  DriveThruOrderStatus,
} from '../services/DriveThruService';

const EVENT_REFRESH_THROTTLE_MS = 5000;

interface UseDriveThruProps {
  branchId: string;
  organizationId: string;
  enableRealtime?: boolean;
}

interface UseDriveThruReturn {
  // Data
  lanes: DriveThruLane[];
  orders: DriveThruOrder[];
  stats: DriveThruStats;
  isLoading: boolean;
  error: string | null;

  // Actions
  refetch: () => Promise<void>;
  updateOrderStatus: (orderId: string, status: DriveThruOrderStatus) => Promise<boolean>;
  moveToNextStage: (orderId: string, currentStatus: DriveThruOrderStatus) => Promise<boolean>;
  moveToPrevStage: (orderId: string, currentStatus: DriveThruOrderStatus) => Promise<boolean>;

  // Helpers
  getOrdersByLane: (laneId: string) => DriveThruOrder[];
  getOrdersByStatus: (status: DriveThruOrderStatus) => DriveThruOrder[];
  getElapsedTime: (arrivedAt: string) => string;
  getTimerColor: (arrivedAt: string) => 'green' | 'yellow' | 'red';
}

export function useDriveThru({
  branchId,
  organizationId,
  enableRealtime = true,
}: UseDriveThruProps): UseDriveThruReturn {
  const [lanes, setLanes] = useState<DriveThruLane[]>([]);
  const [orders, setOrders] = useState<DriveThruOrder[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Set context when branch/org changes
  useEffect(() => {
    if (branchId && organizationId) {
      driveThruService.setContext(branchId, organizationId);
    }
  }, [branchId, organizationId]);

  // Fetch lanes and orders
  const fetchData = useCallback(async (options: { silent?: boolean } = {}) => {
    const { silent = false } = options;
    if (!branchId) return;

    if (!silent) {
      setIsLoading(true);
      setError(null);
    }

    try {
      const [lanesData, ordersData] = await Promise.all([
        driveThruService.fetchLanes(),
        driveThruService.fetchOrders(),
      ]);
      setLanes(lanesData);
      setOrders(ordersData);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to fetch drive-thru data';
      if (!silent) {
        setError(message);
      }
      console.error('Error fetching drive-thru data:', err);
    } finally {
      if (!silent) {
        setIsLoading(false);
      }
    }
  }, [branchId]);

  // Initial fetch
  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Refresh from native sync/order events instead of direct renderer realtime subscriptions.
  useEffect(() => {
    if (!enableRealtime || !branchId) return;

    let disposed = false;
    let pendingTimer: ReturnType<typeof setTimeout> | null = null;
    let lastRefreshAt = 0;

    const scheduleRefresh = () => {
      if (disposed) return;

      const now = Date.now();
      const elapsed = now - lastRefreshAt;

      if (elapsed >= EVENT_REFRESH_THROTTLE_MS) {
        lastRefreshAt = now;
        void fetchData({ silent: true });
        return;
      }

      if (pendingTimer) return;

      pendingTimer = setTimeout(() => {
        pendingTimer = null;
        if (disposed) return;
        lastRefreshAt = Date.now();
        void fetchData({ silent: true });
      }, EVENT_REFRESH_THROTTLE_MS - elapsed);
    };

    const handleSyncStatus = (status?: { inProgress?: boolean }) => {
      if (status && status.inProgress) return;
      scheduleRefresh();
    };
    const handleSyncComplete = () => scheduleRefresh();
    const handleOrderMutation = () => scheduleRefresh();

    onEvent('sync:status', handleSyncStatus);
    onEvent('sync:complete', handleSyncComplete);
    onEvent('order-created', handleOrderMutation);
    onEvent('order-status-updated', handleOrderMutation);
    onEvent('order-deleted', handleOrderMutation);

    return () => {
      disposed = true;
      if (pendingTimer) {
        clearTimeout(pendingTimer);
      }
      offEvent('sync:status', handleSyncStatus);
      offEvent('sync:complete', handleSyncComplete);
      offEvent('order-created', handleOrderMutation);
      offEvent('order-status-updated', handleOrderMutation);
      offEvent('order-deleted', handleOrderMutation);
    };
  }, [branchId, enableRealtime, fetchData]);

  // Calculate stats
  const stats = useMemo(() => {
    return driveThruService.calculateStats(lanes, orders);
  }, [lanes, orders]);

  // Update order status
  const updateOrderStatus = useCallback(async (
    orderId: string,
    status: DriveThruOrderStatus
  ): Promise<boolean> => {
    try {
      const updated = await driveThruService.updateOrderStatus(orderId, status);
      
      // Update local state
      if (status === 'served') {
        setOrders((prev) => prev.filter((o) => o.id !== orderId));
      } else {
        setOrders((prev) =>
          prev.map((o) => (o.id === orderId ? updated : o))
        );
      }
      
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to update order';
      toast.error(message);
      return false;
    }
  }, []);

  // Move to next stage
  const moveToNextStage = useCallback(async (
    orderId: string,
    currentStatus: DriveThruOrderStatus
  ): Promise<boolean> => {
    try {
      const updated = await driveThruService.moveToNextStage(orderId, currentStatus);
      
      if (updated.status === 'served') {
        setOrders((prev) => prev.filter((o) => o.id !== orderId));
        toast.success('Order completed');
      } else {
        setOrders((prev) =>
          prev.map((o) => (o.id === orderId ? updated : o))
        );
      }
      
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to move order';
      toast.error(message);
      return false;
    }
  }, []);

  // Move to previous stage
  const moveToPrevStage = useCallback(async (
    orderId: string,
    currentStatus: DriveThruOrderStatus
  ): Promise<boolean> => {
    try {
      const updated = await driveThruService.moveToPrevStage(orderId, currentStatus);
      
      setOrders((prev) =>
        prev.map((o) => (o.id === orderId ? updated : o))
      );
      
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to move order';
      toast.error(message);
      return false;
    }
  }, []);

  // Get orders by lane
  const getOrdersByLane = useCallback((laneId: string): DriveThruOrder[] => {
    return orders.filter((o) => o.laneId === laneId);
  }, [orders]);

  // Get orders by status
  const getOrdersByStatus = useCallback((status: DriveThruOrderStatus): DriveThruOrder[] => {
    return orders.filter((o) => o.status === status);
  }, [orders]);

  return {
    lanes,
    orders,
    stats,
    isLoading,
    error,
    refetch: fetchData,
    updateOrderStatus,
    moveToNextStage,
    moveToPrevStage,
    getOrdersByLane,
    getOrdersByStatus,
    getElapsedTime: driveThruService.getElapsedTime,
    getTimerColor: driveThruService.getTimerColor,
  };
}

export default useDriveThru;
