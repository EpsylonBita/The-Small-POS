/**
 * useAppointments Hook
 * 
 * React hook for managing appointments in the POS system (Salon Vertical).
 * Provides data fetching, mutations, and real-time updates.
 * 
 * Task 17.2: Create POS appointments interface
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import toast from 'react-hot-toast';
import {
  appointmentsService,
  Appointment,
  AppointmentFilters,
  AppointmentStats,
  AppointmentStatus,
} from '../services/AppointmentsService';

interface UseAppointmentsProps {
  branchId: string;
  organizationId: string;
  filters?: AppointmentFilters;
  enableRealtime?: boolean;
}

interface CreateAppointmentData {
  customerId?: string | null;
  customerName?: string;
  customerPhone?: string;
  staffId: string;
  serviceId: string;
  startTime: string;
  endTime: string;
  notes?: string;
}

interface UseAppointmentsReturn {
  // Data
  appointments: Appointment[];
  stats: AppointmentStats;
  staff: { id: string; name: string }[];
  isLoading: boolean;
  error: string | null;

  // Actions
  refetch: () => Promise<void>;
  createAppointment: (data: CreateAppointmentData) => Promise<Appointment | null>;
  updateStatus: (appointmentId: string, status: AppointmentStatus) => Promise<boolean>;
  checkIn: (appointmentId: string) => Promise<boolean>;
  complete: (appointmentId: string) => Promise<boolean>;

  // Filters
  setFilters: (filters: AppointmentFilters) => void;
}

export function useAppointments({
  branchId,
  organizationId,
  filters: propFilters,
  enableRealtime = true,
}: UseAppointmentsProps): UseAppointmentsReturn {
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState<AppointmentFilters>(propFilters || {});

  // Sync filters when prop changes
  useEffect(() => {
    if (propFilters) {
      setFilters(propFilters);
    }
  }, [propFilters]);

  // Set context when branch/org changes
  useEffect(() => {
    if (branchId && organizationId) {
      appointmentsService.setContext(branchId, organizationId);
    }
  }, [branchId, organizationId]);

  // Fetch appointments
  const fetchAppointments = useCallback(async () => {
    if (!branchId || branchId.trim() === '') {
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      console.log('[useAppointments] Fetching with branchId:', branchId, 'filters:', filters);
      const data = await appointmentsService.fetchAppointments(filters);
      console.log('[useAppointments] Fetched appointments:', data.length);
      setAppointments(data);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to fetch appointments';
      setError(message);
      console.error('Error fetching appointments:', err);
    } finally {
      setIsLoading(false);
    }
  }, [branchId, filters]);

  // Initial fetch and refetch on filter changes
  useEffect(() => {
    fetchAppointments();
  }, [fetchAppointments]);

  // Real-time subscription
  useEffect(() => {
    if (!enableRealtime || !branchId || branchId.trim() === '') return;

    appointmentsService.subscribeToUpdates((updatedAppointment) => {
      setAppointments((prev) => {
        const index = prev.findIndex((a) => a.id === updatedAppointment.id);
        if (index >= 0) {
          const updated = [...prev];
          updated[index] = updatedAppointment;
          return updated;
        }
        return [...prev, updatedAppointment].sort(
          (a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime()
        );
      });
    });

    return () => {
      appointmentsService.unsubscribeFromUpdates();
    };
  }, [branchId, enableRealtime]);

  // Calculate stats
  const stats = useMemo(() => {
    return appointmentsService.calculateStats(appointments);
  }, [appointments]);

  // Get unique staff
  const staff = useMemo(() => {
    return appointmentsService.getUniqueStaff(appointments);
  }, [appointments]);

  // Create new appointment
  const createAppointment = useCallback(async (data: CreateAppointmentData): Promise<Appointment | null> => {
    try {
      const newAppointment = await appointmentsService.createAppointment(data);
      
      // Add to local state
      setAppointments((prev) => 
        [...prev, newAppointment].sort(
          (a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime()
        )
      );
      
      toast.success('Appointment created successfully');
      return newAppointment;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create appointment';
      toast.error(message);
      return null;
    }
  }, []);

  // Update appointment status
  const updateStatus = useCallback(async (
    appointmentId: string,
    status: AppointmentStatus
  ): Promise<boolean> => {
    try {
      const updated = await appointmentsService.updateStatus(appointmentId, status);
      
      // Update local state
      setAppointments((prev) =>
        prev.map((a) => (a.id === appointmentId ? updated : a))
      );
      
      toast.success(`Appointment ${status.replace('_', ' ')}`);
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to update status';
      toast.error(message);
      return false;
    }
  }, []);

  // Check-in appointment
  const checkIn = useCallback(async (appointmentId: string): Promise<boolean> => {
    try {
      const updated = await appointmentsService.checkIn(appointmentId);
      
      setAppointments((prev) =>
        prev.map((a) => (a.id === appointmentId ? updated : a))
      );
      
      toast.success('Customer checked in');
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to check in';
      toast.error(message);
      return false;
    }
  }, []);

  // Complete appointment
  const complete = useCallback(async (appointmentId: string): Promise<boolean> => {
    try {
      const updated = await appointmentsService.complete(appointmentId);
      
      setAppointments((prev) =>
        prev.map((a) => (a.id === appointmentId ? updated : a))
      );
      
      toast.success('Appointment completed');
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to complete';
      toast.error(message);
      return false;
    }
  }, []);

  return {
    appointments,
    stats,
    staff,
    isLoading,
    error,
    refetch: fetchAppointments,
    createAppointment,
    updateStatus,
    checkIn,
    complete,
    setFilters,
  };
}

export default useAppointments;
