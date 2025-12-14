/**
 * AppointmentsService - POS Appointments Service
 * 
 * Provides appointment management functionality for the POS system (Salon Vertical).
 * Uses direct Supabase connection for real-time data.
 * 
 * Task 17.2: Create POS appointments interface
 */

import { supabase, subscribeToTable, unsubscribeFromChannel } from '../../shared/supabase';

// Types
export type AppointmentStatus = 'scheduled' | 'confirmed' | 'in_progress' | 'completed' | 'cancelled' | 'no_show';

export interface Appointment {
  id: string;
  organizationId: string;
  branchId: string;
  customerId: string | null;
  customerName: string | null;
  customerPhone: string | null;
  staffId: string;
  staffName: string | null;
  serviceId: string;
  serviceName: string | null;
  startTime: string;
  endTime: string;
  duration: number; // minutes
  status: AppointmentStatus;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AppointmentFilters {
  dateFrom?: string;
  dateTo?: string;
  statusFilter?: AppointmentStatus | 'all';
  staffFilter?: string | 'all';
  searchTerm?: string;
}

export interface AppointmentStats {
  total: number;
  scheduled: number;
  confirmed: number;
  inProgress: number;
  completed: number;
  cancelled: number;
  noShow: number;
}

// Transform API response to domain model
function transformFromAPI(data: any): Appointment {
  const startTime = new Date(data.start_time);
  const endTime = new Date(data.end_time);
  // Use service duration if available, otherwise calculate from times
  const duration = data.service?.duration_minutes || Math.round((endTime.getTime() - startTime.getTime()) / 60000);

  // Build staff name from first_name and last_name
  let staffName: string | null = null;
  if (data.staff) {
    const firstName = data.staff.first_name || '';
    const lastName = data.staff.last_name || '';
    staffName = `${firstName} ${lastName}`.trim() || null;
  }

  return {
    id: data.id,
    organizationId: data.organization_id,
    branchId: data.branch_id,
    customerId: data.customer_id,
    customerName: data.customer_name || data.customer?.name || null,
    customerPhone: data.customer_phone || data.customer?.phone || null,
    staffId: data.staff_id,
    staffName: data.staff_name || staffName,
    serviceId: data.service_id,
    serviceName: data.service_name || data.service?.name || null,
    startTime: data.start_time,
    endTime: data.end_time,
    duration,
    status: data.status || 'scheduled',
    notes: data.notes,
    createdAt: data.created_at,
    updatedAt: data.updated_at,
  };
}

class AppointmentsService {
  private branchId: string = '';
  private organizationId: string = '';
  private realtimeChannel: any = null;

  /**
   * Set the current branch and organization context
   */
  setContext(branchId: string, organizationId: string): void {
    this.branchId = branchId;
    this.organizationId = organizationId;
  }

  /**
   * Fetch appointments with optional filters
   */
  async fetchAppointments(filters?: AppointmentFilters): Promise<Appointment[]> {
    // Guard against empty branchId to prevent invalid UUID errors
    if (!this.branchId) {
      console.warn('[AppointmentsService] branchId not set, skipping fetch');
      return [];
    }

    console.log('[AppointmentsService] Fetching appointments for branch:', this.branchId);
    console.log('[AppointmentsService] Filters:', filters);

    try {
      let query = supabase
        .from('appointments')
        .select(`
          *,
          customer:customer_id(id, name, email, phone),
          staff:staff_id(id, first_name, last_name, staff_code),
          service:service_id(id, name, duration_minutes, price)
        `)
        .eq('branch_id', this.branchId)
        .order('start_time', { ascending: true });

      if (filters?.dateFrom) {
        query = query.gte('start_time', filters.dateFrom);
      }
      if (filters?.dateTo) {
        query = query.lte('start_time', filters.dateTo);
      }
      if (filters?.statusFilter && filters.statusFilter !== 'all') {
        query = query.eq('status', filters.statusFilter);
      }
      if (filters?.staffFilter && filters.staffFilter !== 'all') {
        query = query.eq('staff_id', filters.staffFilter);
      }
      if (filters?.searchTerm) {
        query = query.or(
          `customer_name.ilike.%${filters.searchTerm}%`
        );
      }

      const { data, error } = await query;

      console.log('[AppointmentsService] Query result:', { data, error });

      if (error) {
        console.error('[AppointmentsService] Error fetching appointments:', error);
        throw error;
      }

      const transformed = (data || []).map(transformFromAPI);
      console.log('[AppointmentsService] Transformed appointments:', transformed.length);
      return transformed;
    } catch (error) {
      console.error('[AppointmentsService] Failed to fetch appointments:', error);
      return [];
    }
  }

  /**
   * Get today's appointments
   */
  async getTodaysAppointments(): Promise<Appointment[]> {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    return this.fetchAppointments({
      dateFrom: today.toISOString(),
      dateTo: tomorrow.toISOString(),
    });
  }

  /**
   * Update appointment status (check-in functionality)
   */
  async updateStatus(appointmentId: string, status: AppointmentStatus): Promise<Appointment> {
    try {
      const { data: appointment, error } = await supabase
        .from('appointments')
        .update({
          status,
          updated_at: new Date().toISOString(),
        })
        .eq('id', appointmentId)
        .select(`
          *,
          customer:customer_id(id, name, email, phone),
          staff:staff_id(id, first_name, last_name, staff_code),
          service:service_id(id, name, duration_minutes, price)
        `)
        .single();

      if (error) {
        console.error('Error updating appointment status:', error);
        throw error;
      }

      return transformFromAPI(appointment);
    } catch (error) {
      console.error('Failed to update appointment status:', error);
      throw error;
    }
  }

  /**
   * Create a new appointment
   */
  async createAppointment(data: {
    customerId?: string | null;
    customerName?: string;
    customerPhone?: string;
    staffId: string;
    serviceId: string;
    startTime: string;
    endTime: string;
    notes?: string;
  }): Promise<Appointment> {
    if (!this.branchId || !this.organizationId) {
      throw new Error('Branch and organization context not set');
    }

    try {
      const { data: appointment, error } = await supabase
        .from('appointments')
        .insert({
          organization_id: this.organizationId,
          branch_id: this.branchId,
          customer_id: data.customerId || null,
          customer_name: data.customerName || null,
          customer_phone: data.customerPhone || null,
          staff_id: data.staffId,
          service_id: data.serviceId,
          start_time: data.startTime,
          end_time: data.endTime,
          status: 'scheduled',
          notes: data.notes || null,
        })
        .select(`
          *,
          customer:customer_id(id, name, email, phone),
          staff:staff_id(id, first_name, last_name, staff_code),
          service:service_id(id, name, duration_minutes, price)
        `)
        .single();

      if (error) {
        console.error('[AppointmentsService] Error creating appointment:', error);
        throw error;
      }

      return transformFromAPI(appointment);
    } catch (error) {
      console.error('[AppointmentsService] Failed to create appointment:', error);
      throw error;
    }
  }

  /**
   * Check-in an appointment (mark as in_progress)
   */
  async checkIn(appointmentId: string): Promise<Appointment> {
    return this.updateStatus(appointmentId, 'in_progress');
  }

  /**
   * Complete an appointment
   */
  async complete(appointmentId: string): Promise<Appointment> {
    return this.updateStatus(appointmentId, 'completed');
  }

  /**
   * Calculate statistics from appointments
   */
  calculateStats(appointments: Appointment[]): AppointmentStats {
    const stats: AppointmentStats = {
      total: appointments.length,
      scheduled: 0,
      confirmed: 0,
      inProgress: 0,
      completed: 0,
      cancelled: 0,
      noShow: 0,
    };

    appointments.forEach((a) => {
      if (a.status === 'scheduled') stats.scheduled++;
      if (a.status === 'confirmed') stats.confirmed++;
      if (a.status === 'in_progress') stats.inProgress++;
      if (a.status === 'completed') stats.completed++;
      if (a.status === 'cancelled') stats.cancelled++;
      if (a.status === 'no_show') stats.noShow++;
    });

    return stats;
  }

  /**
   * Get unique staff members for filter dropdown
   */
  getUniqueStaff(appointments: Appointment[]): { id: string; name: string }[] {
    const staffMap = new Map<string, string>();
    appointments.forEach(a => {
      if (a.staffId && a.staffName) {
        staffMap.set(a.staffId, a.staffName);
      }
    });
    return Array.from(staffMap.entries()).map(([id, name]) => ({ id, name }));
  }

  /**
   * Subscribe to real-time appointment updates
   */
  subscribeToUpdates(callback: (appointment: Appointment) => void): void {
    if (this.realtimeChannel) {
      this.unsubscribeFromUpdates();
    }

    this.realtimeChannel = subscribeToTable(
      'appointments',
      (payload: any) => {
        if (payload.new) {
          callback(transformFromAPI(payload.new));
        }
      },
      `branch_id=eq.${this.branchId}`
    );
  }

  /**
   * Unsubscribe from real-time updates
   */
  unsubscribeFromUpdates(): void {
    if (this.realtimeChannel) {
      unsubscribeFromChannel(this.realtimeChannel);
      this.realtimeChannel = null;
    }
  }
}

// Export singleton instance
export const appointmentsService = new AppointmentsService();
