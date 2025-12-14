/**
 * useReservations Hook
 * 
 * React hook for managing reservations in the POS system.
 * Provides data fetching, mutations, and real-time updates.
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import toast from 'react-hot-toast';
import {
  reservationsService,
  Reservation,
  ReservationFilters,
  ReservationStats,
  ReservationStatus,
  CreateReservationDto,
} from '../services/ReservationsService';

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
  const fetchReservations = useCallback(async () => {
    if (!branchId) return;

    setIsLoading(true);
    setError(null);

    try {
      const data = await reservationsService.fetchReservations(filters);
      setReservations(data);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to fetch reservations';
      setError(message);
      console.error('Error fetching reservations:', err);
    } finally {
      setIsLoading(false);
    }
  }, [branchId, filters.dateFrom, filters.dateTo, filters.statusFilter, filters.searchTerm]);

  // Initial fetch and refetch on filter changes
  useEffect(() => {
    fetchReservations();
  }, [fetchReservations]);

  // Real-time subscription
  useEffect(() => {
    if (!enableRealtime || !branchId) return;

    reservationsService.subscribeToUpdates((updatedReservation) => {
      setReservations((prev) => {
        const index = prev.findIndex((r) => r.id === updatedReservation.id);
        if (index >= 0) {
          // Update existing reservation
          const updated = [...prev];
          updated[index] = updatedReservation;
          return updated;
        } else {
          // Add new reservation
          return [...prev, updatedReservation].sort(
            (a, b) => new Date(a.reservationDatetime).getTime() - new Date(b.reservationDatetime).getTime()
          );
        }
      });
    });

    return () => {
      reservationsService.unsubscribeFromUpdates();
    };
  }, [branchId, enableRealtime]);

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
