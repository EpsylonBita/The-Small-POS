/**
 * AppointmentsService - POS Appointments Service
 *
 * Provides appointment management functionality for the POS system (Salon Vertical).
 * Uses authenticated POS routes only.
 */

import { getBridge, isBrowser } from '../../lib';
import { posApiGet, posApiPatch, posApiPost } from '../utils/api-helpers';
import {
  offlineCreateAppointment,
  offlineUpdateAppointmentStatus,
} from './offline-mutations';

export type AppointmentStatus =
  | 'scheduled'
  | 'confirmed'
  | 'in_progress'
  | 'completed'
  | 'cancelled'
  | 'no_show';
export type AppointmentServiceStatus =
  | 'pending'
  | 'in_progress'
  | 'completed'
  | 'skipped'
  | 'cancelled';

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
  duration: number;
  status: AppointmentStatus;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  isMultiService: boolean;
  totalDurationMinutes: number | null;
  totalPrice: number | null;
  confirmedAt: string | null;
  checkedInAt: string | null;
  completedAt: string | null;
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
  const duration =
    data.service?.duration_minutes ||
    data.total_duration_minutes ||
    Math.round((endTime.getTime() - startTime.getTime()) / 60000);

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
    isMultiService: data.is_multi_service || false,
    totalDurationMinutes: data.total_duration_minutes || null,
    totalPrice: data.total_price || null,
    confirmedAt: data.confirmed_at || null,
    checkedInAt: data.checked_in_at || null,
    completedAt: data.completed_at || null,
    services: (data.appointment_services || []).map(transformServiceFromAPI),
    resources: (data.appointment_resources || []).map(transformResourceFromAPI),
  };
}

type AppointmentListResponse = {
  success?: boolean;
  appointments?: any[];
};

type AppointmentSingleResponse = {
  success?: boolean;
  appointment?: any;
  error?: string;
};

function buildAppointmentQuery(filters?: AppointmentFilters): URLSearchParams {
  const params = new URLSearchParams();

  if (filters?.dateFrom) {
    if (filters.dateFrom === filters.dateTo) {
      params.set('date', filters.dateFrom);
    } else {
      params.set('date_from', filters.dateFrom);
    }
  }
  if (filters?.dateTo && filters.dateTo !== filters.dateFrom) {
    params.set('date_to', filters.dateTo);
  }
  if (filters?.statusFilter && filters.statusFilter !== 'all') {
    params.set('status', filters.statusFilter);
  }
  if (filters?.staffFilter && filters.staffFilter !== 'all') {
    params.set('staff_id', filters.staffFilter);
  }
  if (filters?.searchTerm) {
    params.set('search', filters.searchTerm);
  }
  if (filters?.includeServices) {
    params.set('include_services', 'true');
  }

  return params;
}

class AppointmentsService {
  private bridge = getBridge();
  private branchId = '';
  private organizationId = '';
  private useApiPrimary = true;

  setContext(branchId: string, organizationId: string): void {
    this.branchId = branchId;
    this.organizationId = organizationId;
  }

  async fetchAppointments(filters?: AppointmentFilters): Promise<Appointment[]> {
    if (!this.branchId) {
      console.warn('[AppointmentsService] branchId not set, skipping fetch');
      return [];
    }

    const apiResult = await this.fetchFromApi(filters);
    return apiResult ?? [];
  }

  private async fetchFromApi(filters?: AppointmentFilters): Promise<Appointment[] | null> {
    try {
      const params = buildAppointmentQuery(filters);
      const query = params.toString();
      const endpoint = `/api/pos/appointments${query ? `?${query}` : ''}`;

      const result = isBrowser()
        ? await posApiGet<AppointmentListResponse>(endpoint)
        : await this.bridge.appointments.list(Object.fromEntries(params.entries()));

      if (!result.success) {
        console.error('[AppointmentsService] API error:', result.error);
        return null;
      }

      const payload = (result.data ?? {}) as AppointmentListResponse;
      if (payload.success === false) {
        console.error('[AppointmentsService] API payload error:', payload);
        return null;
      }

      const appointments = Array.isArray(payload.appointments) ? payload.appointments : [];
      return appointments.map(transformFromAPI);
    } catch (error) {
      console.error('[AppointmentsService] API fetch error:', error);
      return null;
    }
  }

  async updateStatus(
    appointmentId: string,
    status: AppointmentStatus,
    cancellationReason?: string,
  ): Promise<Appointment> {
    const apiResult = await this.updateStatusViaApi(appointmentId, status, cancellationReason);
    if (apiResult === null) {
      throw new Error('Unable to update appointment status via POS API');
    }
    return apiResult;
  }

  private async updateStatusViaApi(
    appointmentId: string,
    status: AppointmentStatus,
    cancellationReason?: string,
  ): Promise<Appointment | null> {
    try {
      const body: Record<string, unknown> = { status };
      if (cancellationReason) {
        body.cancellation_reason = cancellationReason;
      }

      const result = isBrowser()
        ? await posApiPatch<AppointmentSingleResponse>(
            `/api/pos/appointments/${appointmentId}/status`,
            body,
          )
        : {
            success: true,
            data: await offlineUpdateAppointmentStatus({
              appointmentId,
              ...body,
            }),
          };

      if (!result.success) {
        const bridgeError = 'error' in result ? result.error : undefined;
        console.error('[AppointmentsService] API status update error:', bridgeError);
        return null;
      }

      const payload = (result.data ?? {}) as AppointmentSingleResponse;
      if (payload.success === false || !payload.appointment) {
        console.error('[AppointmentsService] API status update payload error:', payload);
        return null;
      }

      return transformFromAPI(payload.appointment);
    } catch (error) {
      console.error('[AppointmentsService] API status update error:', error);
      return null;
    }
  }

  async createAppointment(data: CreateAppointmentInput): Promise<Appointment> {
    const apiResult = await this.createAppointmentViaApi(data);
    if (apiResult === null) {
      throw new Error('Unable to create appointment via POS API');
    }
    return apiResult;
  }

  private async createAppointmentViaApi(
    data: CreateAppointmentInput,
  ): Promise<Appointment | null> {
    try {
      const isMultiService = !!(data.services && data.services.length > 0);
      const body: Record<string, unknown> = {
        customer_id: data.customerId || null,
        customer_name: data.customerName || null,
        customer_phone: data.customerPhone || null,
        customer_email: data.customerEmail || null,
        notes: data.notes || null,
      };

      if (isMultiService) {
        body.start_time = data.startTime;
        body.services = (data.services || []).map((service) => ({
          service_id: service.serviceId,
          staff_id: service.staffId || null,
          duration_minutes: service.durationMinutes,
          price: service.price,
          buffer_before_minutes: service.bufferBeforeMinutes ?? 0,
          buffer_after_minutes: service.bufferAfterMinutes ?? 0,
          notes: service.notes ?? null,
        }));
        if (data.resources?.length) {
          body.resources = data.resources.map((resource) => ({
            resource_id: resource.resourceId,
            room_id: resource.roomId,
            start_time: resource.startTime,
            end_time: resource.endTime,
            notes: resource.notes ?? null,
          }));
        }
      } else {
        body.staff_id = data.staffId;
        body.service_id = data.serviceId;
        body.start_time = data.startTime;
        body.end_time = data.endTime;
      }

      const result = isBrowser()
        ? await posApiPost<AppointmentSingleResponse>('/api/pos/appointments', body)
        : {
            success: true,
            data: await offlineCreateAppointment(body),
          };

      if (!result.success || !result.data) {
        const bridgeError = 'error' in result ? result.error : undefined;
        console.error('[AppointmentsService] API create error:', bridgeError);
        return null;
      }

      const payload = result.data as AppointmentSingleResponse;
      if (payload.success === false) {
        console.error('[AppointmentsService] API create payload error:', payload.error);
        return null;
      }

      const appointmentData = payload.appointment || payload;
      return transformFromAPI(appointmentData);
    } catch (error) {
      console.error('[AppointmentsService] API create error:', error);
      return null;
    }
  }

  async checkIn(appointmentId: string): Promise<Appointment> {
    return this.updateStatus(appointmentId, 'in_progress');
  }

  async complete(appointmentId: string): Promise<Appointment> {
    return this.updateStatus(appointmentId, 'completed');
  }

  async confirm(appointmentId: string): Promise<Appointment> {
    return this.updateStatus(appointmentId, 'confirmed');
  }

  async cancel(appointmentId: string, reason?: string): Promise<Appointment> {
    return this.updateStatus(appointmentId, 'cancelled', reason);
  }

  async markNoShow(appointmentId: string): Promise<Appointment> {
    return this.updateStatus(appointmentId, 'no_show');
  }

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

    appointments.forEach((appointment) => {
      if (appointment.status === 'scheduled') stats.scheduled++;
      if (appointment.status === 'confirmed') stats.confirmed++;
      if (appointment.status === 'in_progress') stats.inProgress++;
      if (appointment.status === 'completed') stats.completed++;
      if (appointment.status === 'cancelled') stats.cancelled++;
      if (appointment.status === 'no_show') stats.noShow++;
    });

    return stats;
  }

  getUniqueStaff(appointments: Appointment[]): { id: string; name: string }[] {
    const staffMap = new Map<string, string>();

    appointments.forEach((appointment) => {
      if (appointment.staffId && appointment.staffName) {
        staffMap.set(appointment.staffId, appointment.staffName);
      }

      appointment.services?.forEach((service) => {
        if (service.staffId && service.staffName) {
          staffMap.set(service.staffId, service.staffName);
        }
      });
    });

    return Array.from(staffMap.entries()).map(([id, name]) => ({ id, name }));
  }

  isApiAvailable(): boolean {
    return this.useApiPrimary;
  }

  setUseApi(useApi: boolean): void {
    this.useApiPrimary = useApi;
  }
}

export const appointmentsService = new AppointmentsService();
