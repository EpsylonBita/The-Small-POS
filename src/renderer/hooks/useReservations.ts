/**
 * useReservations Hook
 * 
 * React hook for managing reservations in the POS system.
 * Provides data fetching, mutations, and real-time updates.
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import toast from 'react-hot-toast';
import { offEvent, onEvent } from '../../lib';
import {
  reservationsService,
  Reservation,
  ReservationFilters,
  ReservationStats,
  ReservationStatus,
  CreateReservationDto,
} from '../services/ReservationsService';

const EVENT_REFRESH_THROTTLE_MS = 5000;

interface UseReservationsProps {
  branchId: string;
  organizationId: string;
  filters?: ReservationFilters;
  enableRealtime?: boolean;
}

interface UseReservationsReturn {
  // Data
  reservations: Reservation[];
  stats: ReservationStats;
  isLoading: boolean;
  error: string | null;

  // Actions
  refetch: () => Promise<void>;
  createReservation: (data: CreateReservationDto) => Promise<Reservation | null>;
  updateStatus: (reservationId: string, status: ReservationStatus, reason?: string) => Promise<boolean>;
  assignTable: (reservationId: string, tableId: string) => Promise<boolean>;

  // Filters
  setFilters: (filters: ReservationFilters) => void;
}

export function useReservations({
  branchId,
  organizationId,
  filters: externalFilters,
  enableRealtime = true,
}: UseReservationsProps): UseReservationsReturn {
  const [reservations, setReservations] = useState<Reservation[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [internalFilters, setFilters] = useState<ReservationFilters>(externalFilters || {});

  // Use external filters if provided, otherwise use internal
  const filters = externalFilters || internalFilters;

  // Set context when branch/org changes
  useEffect(() => {
    if (branchId && organizationId) {
      reservationsService.setContext(branchId, organizationId);
    }
  }, [branchId, organizationId]);

  // Fetch reservations when filters change
  const fetchReservations = useCallback(async (options: { silent?: boolean } = {}) => {
    const { silent = false } = options;
    if (!branchId) return;

    if (!silent) {
      setIsLoading(true);
      setError(null);
    }

    try {
      const data = await reservationsService.fetchReservations(filters);
      setReservations(data);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to fetch reservations';
      if (!silent) {
        setError(message);
      }
      console.error('Error fetching reservations:', err);
    } finally {
      if (!silent) {
        setIsLoading(false);
      }
    }
  }, [branchId, filters.dateFrom, filters.dateTo, filters.statusFilter, filters.searchTerm]);

  // Initial fetch and refetch on filter changes
  useEffect(() => {
    fetchReservations();
  }, [fetchReservations]);

  // Refresh from native sync/order events with throttling.
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
        void fetchReservations({ silent: true });
        return;
      }

      if (pendingTimer) return;

      pendingTimer = setTimeout(() => {
        pendingTimer = null;
        if (disposed) return;
        lastRefreshAt = Date.now();
        void fetchReservations({ silent: true });
      }, EVENT_REFRESH_THROTTLE_MS - elapsed);
    };

    const handleSyncStatus = (status?: { inProgress?: boolean }) => {
      if (status?.inProgress) return;
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
  }, [branchId, enableRealtime, fetchReservations]);

  // Calculate stats
  const stats = useMemo(() => {
    return reservationsService.calculateStats(reservations);
  }, [reservations]);

  // Create reservation
  const createReservation = useCallback(async (data: CreateReservationDto): Promise<Reservation | null> => {
    try {
      const reservation = await reservationsService.createReservation(data);
      toast.success('Reservation created successfully');
      
      // Add to local state
      setReservations((prev) => 
        [...prev, reservation].sort(
          (a, b) => new Date(a.reservationDatetime).getTime() - new Date(b.reservationDatetime).getTime()
        )
      );
      
      return reservation;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create reservation';
      toast.error(message);
      return null;
    }
  }, []);

  // Update status
  const updateStatus = useCallback(async (
    reservationId: string,
    status: ReservationStatus,
    reason?: string
  ): Promise<boolean> => {
    try {
      const updated = await reservationsService.updateStatus(reservationId, status, {
        cancellationReason: reason,
      });
      
      // Update local state
      setReservations((prev) =>
        prev.map((r) => (r.id === reservationId ? updated : r))
      );
      
      toast.success(`Reservation ${status}`);
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to update status';
      toast.error(message);
      return false;
    }
  }, []);

  // Assign table
  const assignTable = useCallback(async (reservationId: string, tableId: string): Promise<boolean> => {
    try {
      const updated = await reservationsService.assignTable(reservationId, tableId);
      
      // Update local state
      setReservations((prev) =>
        prev.map((r) => (r.id === reservationId ? updated : r))
      );
      
      toast.success('Table assigned');
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to assign table';
      toast.error(message);
      return false;
    }
  }, []);

  return {
    reservations,
    stats,
    isLoading,
    error,
    refetch: fetchReservations,
    createReservation,
    updateStatus,
    assignTable,
    setFilters,
  };
}

export default useReservations;
