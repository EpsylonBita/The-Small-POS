/**
 * AppointmentsService - POS Appointments Service
 *
 * Provides appointment management functionality for the POS system (Salon Vertical).
 * Uses Admin Dashboard API as primary data source with Supabase fallback for offline mode.
 * Supports both single-service and multi-service appointments.
 *
 * Task 17.2: Create POS appointments interface
 * Updated: Multi-service appointment support
 */

import { supabase, isSupabaseConfigured } from '../../shared/supabase';
import { posApiGet, posApiPost, posApiPatch } from '../utils/api-helpers';
import { isBrowser } from '../../lib';

// Types
export type AppointmentStatus = 'scheduled' | 'confirmed' | 'in_progress' | 'completed' | 'cancelled' | 'no_show';
export type AppointmentServiceStatus = 'pending' | 'in_progress' | 'completed' | 'skipped' | 'cancelled';

export interface AppointmentService {
  id: string;
  appointmentId: string;
  serviceId: string;
  staffId: string | null;
  sequenceOrder: number;
  startTime: string | null;
  endTime: string | null;
  durationMinutes: number;
  price: number;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  status: AppointmentServiceStatus;
  notes: string | null;
  // Resolved relations
  serviceName: string | null;
  staffName: string | null;
}

export interface AppointmentResource {
  id: string;
  appointmentId: string;
  resourceId: string | null;
  roomId: string | null;
  startTime: string;
  endTime: string;
  notes: string | null;
  // Resolved relations
  resourceName: string | null;
  resourceType: string | null;
  roomNumber: string | null;
}

export interface Appointment {
  id: string;
  organizationId: string;
  branchId: string;
  customerId: string | null;
  customerName: string | null;
  customerPhone: string | null;
  customerEmail: string | null;
  staffId: string | null;
  staffName: string | null;
  serviceId: string | null;
  serviceName: string | null;
  startTime: string;
  endTime: string;
  duration: number; // minutes
  status: AppointmentStatus;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  // Multi-service fields
  isMultiService: boolean;
  totalDurationMinutes: number | null;
  totalPrice: number | null;
  confirmedAt: string | null;
  checkedInAt: string | null;
  completedAt: string | null;
  // Nested data (for multi-service)
  services: AppointmentService[];
  resources: AppointmentResource[];
}

export interface AppointmentFilters {
  dateFrom?: string;
  dateTo?: string;
  statusFilter?: AppointmentStatus | 'all';
  staffFilter?: string | 'all';
  searchTerm?: string;
  includeServices?: boolean;
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

export interface CreateAppointmentInput {
  customerId?: string | null;
  customerName?: string;
  customerPhone?: string;
  customerEmail?: string;
  staffId?: string;
  serviceId?: string;
  startTime: string;
  endTime?: string;
  notes?: string;
  // Multi-service fields
  services?: Array<{
    serviceId: string;
    staffId?: string | null;
    durationMinutes?: number;
    price?: number;
    bufferBeforeMinutes?: number;
    bufferAfterMinutes?: number;
    notes?: string | null;
  }>;
  resources?: Array<{
    resourceId?: string;
    roomId?: string;
    startTime: string;
    endTime: string;
    notes?: string | null;
  }>;
}

// Transform API response to domain model
function transformServiceFromAPI(data: any): AppointmentService {
  let staffName: string | null = null;
  if (data.staff) {
    const firstName = data.staff.first_name || '';
    const lastName = data.staff.last_name || '';
    staffName = `${firstName} ${lastName}`.trim() || null;
  }

  return {
    id: data.id,
    appointmentId: data.appointment_id,
    serviceId: data.service_id,
    staffId: data.staff_id,
    sequenceOrder: data.sequence_order,
    startTime: data.start_time,
    endTime: data.end_time,
    durationMinutes: data.duration_minutes,
    price: data.price,
    bufferBeforeMinutes: data.buffer_before_minutes || 0,
    bufferAfterMinutes: data.buffer_after_minutes || 0,
    status: data.status || 'pending',
    notes: data.notes,
    serviceName: data.service?.name || null,
    staffName,
  };
}

function transformResourceFromAPI(data: any): AppointmentResource {
  return {
    id: data.id,
    appointmentId: data.appointment_id,
    resourceId: data.resource_id,
    roomId: data.room_id,
    startTime: data.start_time,
    endTime: data.end_time,
    notes: data.notes,
    resourceName: data.resource?.name || null,
    resourceType: data.resource?.resource_type || null,
    roomNumber: data.room?.room_number || null,
  };
}

function transformFromAPI(data: any): Appointment {
  const startTime = new Date(data.start_time);
  const endTime = new Date(data.end_time);
  // Use service duration if available, otherwise calculate from times
  const duration = data.service?.duration_minutes ||
                   data.total_duration_minutes ||
                   Math.round((endTime.getTime() - startTime.getTime()) / 60000);

  // Build staff name from first_name and last_name
  let staffName: string | null = null;
  if (data.staff) {
    const firstName = data.staff.first_name || '';
    const lastName = data.staff.last_name || '';
    staffName = `${firstName} ${lastName}`.trim() || null;
  }

  // Transform nested services and resources
  const services: AppointmentService[] = (data.appointment_services || []).map(transformServiceFromAPI);
  const resources: AppointmentResource[] = (data.appointment_resources || []).map(transformResourceFromAPI);

  return {
    id: data.id,
    organizationId: data.organization_id,
    branchId: data.branch_id,
    customerId: data.customer_id,
    customerName: data.customer_name || data.customer?.name || null,
    customerPhone: data.customer_phone || data.customer?.phone || null,
    customerEmail: data.customer_email || data.customer?.email || null,
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
    // Multi-service fields
    isMultiService: data.is_multi_service || false,
    totalDurationMinutes: data.total_duration_minutes || null,
    totalPrice: data.total_price || null,
    confirmedAt: data.confirmed_at || null,
    checkedInAt: data.checked_in_at || null,
    completedAt: data.completed_at || null,
    services,
    resources,
  };
}

class AppointmentsService {
  private branchId: string = '';
  private organizationId: string = '';
  private useApiPrimary: boolean = true; // Use API as primary, fallback to Supabase

  private hasDesktopBridge(): boolean {
    return !isBrowser();
  }

  private canUseSupabaseFallback(): boolean {
    return !this.hasDesktopBridge() && isSupabaseConfigured();
  }

  /**
   * Set the current branch and organization context
   */
  setContext(branchId: string, organizationId: string): void {
    this.branchId = branchId;
    this.organizationId = organizationId;
  }

  /**
   * Fetch appointments with optional filters
   * Uses API as primary, falls back to Supabase if API fails
   */
  async fetchAppointments(filters?: AppointmentFilters): Promise<Appointment[]> {
    // Guard against empty branchId
    if (!this.branchId) {
      console.warn('[AppointmentsService] branchId not set, skipping fetch');
      return [];
    }

    console.log('[AppointmentsService] Fetching appointments for branch:', this.branchId);
    console.log('[AppointmentsService] Filters:', filters);

    // Try API first
    if (this.useApiPrimary) {
      const apiResult = await this.fetchFromApi(filters);
      if (apiResult !== null) {
        return apiResult;
      }
      console.warn('[AppointmentsService] API fetch failed, falling back to Supabase');
    }

    if (!this.canUseSupabaseFallback()) {
      console.warn('[AppointmentsService] Skipping Supabase fallback (IPC mode or Supabase not configured)');
      return [];
    }

    // Fallback to direct Supabase
    return this.fetchFromSupabase(filters);
  }

  /**
   * Fetch appointments from Admin Dashboard API
   */
  private async fetchFromApi(filters?: AppointmentFilters): Promise<Appointment[] | null> {
    try {
      // Build query params
      const params = new URLSearchParams();

      if (filters?.dateFrom) {
        // dateFrom is already YYYY-MM-DD local date string (no UTC conversion needed)
        params.set('date', filters.dateFrom);
      }
      if (filters?.statusFilter && filters.statusFilter !== 'all') {
        params.set('status', filters.statusFilter);
      }
      if (filters?.staffFilter && filters.staffFilter !== 'all') {
        params.set('staff_id', filters.staffFilter);
      }
      if (filters?.includeServices !== false) {
        params.set('include_services', 'true');
      }

      const queryString = params.toString();
      const endpoint = `/api/pos/appointments${queryString ? `?${queryString}` : ''}`;

      const result = await posApiGet<{ success: boolean; appointments: any[] }>(endpoint);

      if (!result.success || !result.data?.success) {
        console.error('[AppointmentsService] API error:', result.error);
        return null;
      }

      const transformed = (result.data.appointments || []).map(transformFromAPI);
      console.log('[AppointmentsService] API fetch successful:', transformed.length, 'appointments');
      return transformed;
    } catch (error) {
      console.error('[AppointmentsService] API fetch error:', error);
      return null;
    }
  }

  /**
   * Fetch appointments directly from Supabase (offline fallback)
   */
  private async fetchFromSupabase(filters?: AppointmentFilters): Promise<Appointment[]> {
    try {
      let query = supabase
        .from('appointments')
        .select(`
          *,
          customer:customer_id(id, name, email, phone),
          staff:staff_id(id, first_name, last_name, staff_code),
          service:service_id(id, name, duration_minutes, price),
          appointment_services(
            *,
            service:service_id(id, name, duration_minutes, price),
            staff:staff_id(id, first_name, last_name, staff_code)
          ),
          appointment_resources(
            *,
            resource:resource_id(id, name, resource_type, capacity),
            room:room_id(id, room_number, room_type)
          )
        `)
        .eq('branch_id', this.branchId)
        .order('start_time', { ascending: true });

      // dateFrom/dateTo are YYYY-MM-DD local date strings — build UTC boundaries
      if (filters?.dateFrom) {
        const dayStart = new Date(`${filters.dateFrom}T00:00:00`); // Local midnight
        query = query.gte('start_time', dayStart.toISOString());
      }
      if (filters?.dateTo) {
        const dayEnd = new Date(`${filters.dateTo}T23:59:59.999`); // Local end of day
        query = query.lte('start_time', dayEnd.toISOString());
      }
      if (filters?.statusFilter && filters.statusFilter !== 'all') {
        query = query.eq('status', filters.statusFilter);
      }
      if (filters?.staffFilter && filters.staffFilter !== 'all') {
        query = query.eq('staff_id', filters.staffFilter);
      }
      if (filters?.searchTerm) {
        query = query.or(`customer_name.ilike.%${filters.searchTerm}%`);
      }

      const { data, error } = await query;

      if (error) {
        console.error('[AppointmentsService] Supabase error:', error);
        throw error;
      }

      const transformed = (data || []).map(transformFromAPI);
      console.log('[AppointmentsService] Supabase fetch successful:', transformed.length, 'appointments');
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
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth() + 1).padStart(2, '0');
    const dd = String(today.getDate()).padStart(2, '0');
    const dateStr = `${yyyy}-${mm}-${dd}`;

    return this.fetchAppointments({
      dateFrom: dateStr,
      dateTo: dateStr,
    });
  }

  /**
   * Update appointment status with lifecycle timestamps
   */
  async updateStatus(appointmentId: string, status: AppointmentStatus, cancellationReason?: string): Promise<Appointment> {
    // Try API first
    if (this.useApiPrimary) {
      const apiResult = await this.updateStatusViaApi(appointmentId, status, cancellationReason);
      if (apiResult !== null) {
        return apiResult;
      }
      console.warn('[AppointmentsService] API status update failed, falling back to Supabase');
    }

    if (!this.canUseSupabaseFallback()) {
      throw new Error('Unable to update appointment status: API unavailable and Supabase fallback disabled');
    }

    // Fallback to direct Supabase
    return this.updateStatusViaSupabase(appointmentId, status);
  }

  private async updateStatusViaApi(
    appointmentId: string,
    status: AppointmentStatus,
    cancellationReason?: string
  ): Promise<Appointment | null> {
    try {
      const body: Record<string, unknown> = { status };
      if (cancellationReason) {
        body.cancellation_reason = cancellationReason;
      }

      const result = await posApiPatch<{ success: boolean; appointment: any }>(
        `/api/pos/appointments/${appointmentId}/status`,
        body
      );

      if (!result.success || !result.data?.success) {
        console.error('[AppointmentsService] API status update error:', result.error);
        return null;
      }

      return transformFromAPI(result.data.appointment);
    } catch (error) {
      console.error('[AppointmentsService] API status update error:', error);
      return null;
    }
  }

  private async updateStatusViaSupabase(appointmentId: string, status: AppointmentStatus): Promise<Appointment> {
    try {
      // Fix 6: Add lifecycle timestamps in offline fallback
      const now = new Date().toISOString();
      const updateData: Record<string, string> = {
        status,
        updated_at: now,
      };

      // Set appropriate lifecycle timestamp based on status
      switch (status) {
        case 'confirmed':
          updateData.confirmed_at = now;
          break;
        case 'in_progress':
          updateData.checked_in_at = now;
          break;
        case 'completed':
          updateData.completed_at = now;
          break;
        case 'cancelled':
        case 'no_show':
          updateData.cancelled_at = now;
          break;
      }

      const { data: appointment, error } = await supabase
        .from('appointments')
        .update(updateData)
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
   * Create a new appointment (single or multi-service)
   */
  async createAppointment(data: CreateAppointmentInput): Promise<Appointment> {
    if (!this.branchId || !this.organizationId) {
      throw new Error('Branch and organization context not set');
    }

    // Try API first
    if (this.useApiPrimary) {
      const apiResult = await this.createAppointmentViaApi(data);
      if (apiResult !== null) {
        return apiResult;
      }
      console.warn('[AppointmentsService] API create failed, falling back to Supabase');
    }

    if (!this.canUseSupabaseFallback()) {
      throw new Error('Unable to create appointment: API unavailable and Supabase fallback disabled');
    }

    // Fallback to direct Supabase (single-service only)
    return this.createAppointmentViaSupabase(data);
  }

  private async createAppointmentViaApi(data: CreateAppointmentInput): Promise<Appointment | null> {
    try {
      // Determine if this is a multi-service appointment
      const isMultiService = data.services && data.services.length > 0;

      let body: Record<string, unknown>;

      if (isMultiService) {
        // Multi-service format
        body = {
          branch_id: this.branchId,
          customer_id: data.customerId || null,
          customer_name: data.customerName || null,
          customer_phone: data.customerPhone || null,
          customer_email: data.customerEmail || null,
          start_time: data.startTime,
          notes: data.notes || null,
          services: data.services!.map(s => ({
            service_id: s.serviceId,
            staff_id: s.staffId || null,
            duration_minutes: s.durationMinutes,
            price: s.price,
            buffer_before_minutes: s.bufferBeforeMinutes || 0,
            buffer_after_minutes: s.bufferAfterMinutes || 0,
            notes: s.notes || null,
          })),
          resources: data.resources?.map(r => ({
            resource_id: r.resourceId,
            room_id: r.roomId,
            start_time: r.startTime,
            end_time: r.endTime,
            notes: r.notes || null,
          })),
        };
      } else {
        // Single-service format
        if (!data.staffId || !data.serviceId || !data.endTime) {
          throw new Error('Single-service appointment requires staffId, serviceId, and endTime');
        }
        body = {
          branch_id: this.branchId,
          customer_id: data.customerId || null,
          customer_name: data.customerName || null,
          customer_phone: data.customerPhone || null,
          customer_email: data.customerEmail || null,
          staff_id: data.staffId,
          service_id: data.serviceId,
          start_time: data.startTime,
          end_time: data.endTime,
          status: 'scheduled',
          notes: data.notes || null,
        };
      }

      const result = await posApiPost<{ success: boolean; appointment?: any; error?: string }>(
        '/api/pos/appointments',
        body
      );

      if (!result.success || !result.data) {
        console.error('[AppointmentsService] API create error:', result.error);
        return null;
      }

      // Handle both API response formats (direct object or nested)
      const appointmentData = result.data.appointment || result.data;
      return transformFromAPI(appointmentData);
    } catch (error) {
      console.error('[AppointmentsService] API create error:', error);
      return null;
    }
  }

  private async createAppointmentViaSupabase(data: CreateAppointmentInput): Promise<Appointment> {
    // Supabase fallback only supports single-service
    if (!data.staffId || !data.serviceId || !data.endTime) {
      throw new Error('Single-service appointment requires staffId, serviceId, and endTime');
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
          is_multi_service: false,
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
   * Confirm an appointment
   */
  async confirm(appointmentId: string): Promise<Appointment> {
    return this.updateStatus(appointmentId, 'confirmed');
  }

  /**
   * Cancel an appointment
   */
  async cancel(appointmentId: string, reason?: string): Promise<Appointment> {
    return this.updateStatus(appointmentId, 'cancelled', reason);
  }

  /**
   * Mark as no-show
   */
  async markNoShow(appointmentId: string): Promise<Appointment> {
    return this.updateStatus(appointmentId, 'no_show');
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
      // Check main appointment staff
      if (a.staffId && a.staffName) {
        staffMap.set(a.staffId, a.staffName);
      }
      // Check multi-service staff
      a.services?.forEach(s => {
        if (s.staffId && s.staffName) {
          staffMap.set(s.staffId, s.staffName);
        }
      });
    });

    return Array.from(staffMap.entries()).map(([id, name]) => ({ id, name }));
  }

  /**
   * Check if API mode is available
   */
  isApiAvailable(): boolean {
    return this.useApiPrimary;
  }

  /**
   * Set whether to use API as primary (for testing/debugging)
   */
  setUseApi(useApi: boolean): void {
    this.useApiPrimary = useApi;
  }
}

// Export singleton instance
export const appointmentsService = new AppointmentsService();
