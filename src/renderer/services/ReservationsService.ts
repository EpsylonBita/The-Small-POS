/**
 * ReservationsService - POS Reservations Service
 *
 * Provides reservation management functionality for the POS system.
 * Uses typed terminal-authenticated POS routes only.
 */

import { getBridge, isBrowser } from '../../lib';
import { posApiGet, posApiPatch, posApiPost } from '../utils/api-helpers';
import { toLocalDateString } from '../utils/date';

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export {
  generateReservationNumber,
  validateReservationNumberFormat,
  parseReservationNumber,
  isReservationWithinMinutes,
  isReservationLate,
} from '../utils/reservationUtils';

export type ReservationStatus =
  | 'pending'
  | 'confirmed'
  | 'seated'
  | 'completed'
  | 'no_show'
  | 'cancelled';

export interface Reservation {
  id: string;
  organizationId: string;
  branchId: string;
  reservationNumber: string;
  customerId: string | null;
  customerName: string;
  customerPhone: string;
  customerEmail: string | null;
  partySize: number;
  tableId: string | null;
  tableNumber?: number;
  roomId: string | null;
  roomNumber?: string;
  checkInDate: string | null;
  checkOutDate: string | null;
  reservationDate: string;
  reservationTime: string;
  reservationDatetime: string;
  durationMinutes: number;
  status: ReservationStatus;
  specialRequests: string | null;
  notes: string | null;
  confirmedAt: string | null;
  seatedAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  cancellationReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ReservationFilters {
  dateFrom?: string;
  dateTo?: string;
  statusFilter?: ReservationStatus | 'all';
  searchTerm?: string;
}

export interface ReservationStats {
  total: number;
  confirmed: number;
  pending: number;
  seated: number;
  completed: number;
  noShow: number;
  cancelled: number;
  totalGuests: number;
}

export interface CreateReservationDto {
  customerName: string;
  customerPhone: string;
  customerEmail?: string;
  partySize: number;
  reservationDate: string;
  reservationTime: string;
  durationMinutes?: number;
  tableId?: string;
  roomId?: string;
  roomNumber?: string;
  checkInDate?: string;
  checkOutDate?: string;
  customerId?: string;
  specialRequests?: string;
  notes?: string;
}

function transformFromAPI(data: any): Reservation {
  return {
    id: data.id,
    organizationId: data.organization_id,
    branchId: data.branch_id,
    reservationNumber: data.reservation_number,
    customerId: data.customer_id,
    customerName: data.customer_name,
    customerPhone: data.customer_phone,
    customerEmail: data.customer_email,
    partySize: data.party_size,
    tableId: data.table_id,
    tableNumber: data.table_number,
    roomId: data.room_id,
    roomNumber: data.room_number,
    checkInDate: data.check_in_date,
    checkOutDate: data.check_out_date,
    reservationDate: data.reservation_date,
    reservationTime: data.reservation_time,
    reservationDatetime: data.reservation_datetime,
    durationMinutes: data.duration_minutes,
    status: data.status,
    specialRequests: data.special_requests,
    notes: data.notes,
    confirmedAt: data.confirmed_at,
    seatedAt: data.seated_at,
    completedAt: data.completed_at,
    cancelledAt: data.cancelled_at,
    cancellationReason: data.cancellation_reason,
    createdAt: data.created_at,
    updatedAt: data.updated_at,
  };
}

function buildQueryString(params: Record<string, string | undefined>): string {
  const search = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (typeof value === 'string' && value.trim()) {
      search.set(key, value);
    }
  });
  const query = search.toString();
  return query ? `?${query}` : '';
}

function listDatesInclusive(start: string, end: string): string[] {
  if (!start || !end || start === end) {
    return start ? [start] : [];
  }

  const dates: string[] = [];
  const cursor = new Date(`${start}T00:00:00`);
  const target = new Date(`${end}T00:00:00`);

  while (cursor <= target) {
    const yyyy = cursor.getFullYear();
    const mm = String(cursor.getMonth() + 1).padStart(2, '0');
    const dd = String(cursor.getDate()).padStart(2, '0');
    dates.push(`${yyyy}-${mm}-${dd}`);
    cursor.setDate(cursor.getDate() + 1);
  }

  return dates;
}

class ReservationsService {
  private bridge = getBridge();
  private branchId = '';
  private organizationId = '';

  setContext(branchId: string, organizationId: string): void {
    this.branchId = branchId;
    this.organizationId = organizationId;
  }

  private async listReservations(params?: {
    date?: string;
    status?: string;
    search?: string;
    table_id?: string;
  }): Promise<{ reservations: any[]; error?: string }> {
    const query = buildQueryString({
      date: params?.date,
      status: params?.status,
      search: params?.search,
      table_id: params?.table_id,
    });

    const result = isBrowser()
      ? await posApiGet<{ success?: boolean; reservations?: any[]; error?: string }>(
          `/api/pos/reservations${query}`,
        )
      : await this.bridge.reservations.list(params);

    if (!result.success) {
      return { reservations: [], error: result.error || 'Failed to fetch reservations' };
    }

    const payload = (result.data ?? {}) as {
      success?: boolean;
      reservations?: any[];
      error?: string;
    };

    if (payload.success === false) {
      return { reservations: [], error: payload.error || 'Failed to fetch reservations' };
    }

    return {
      reservations: Array.isArray(payload.reservations) ? payload.reservations : [],
    };
  }

  private async getReservation(reservationId: string): Promise<{ reservation?: any; error?: string }> {
    const result = isBrowser()
      ? await posApiGet<{ success?: boolean; reservation?: any; error?: string }>(
          `/api/pos/reservations/${reservationId}`,
        )
      : await this.bridge.reservations.get(reservationId);

    if (!result.success) {
      return { error: result.error || 'Failed to fetch reservation' };
    }

    const payload = (result.data ?? {}) as {
      success?: boolean;
      reservation?: any;
      error?: string;
    };

    if (payload.success === false) {
      return { error: payload.error || 'Failed to fetch reservation' };
    }

    return { reservation: payload.reservation };
  }

  private async createReservationRequest(payload: Record<string, unknown>) {
    const result = isBrowser()
      ? await posApiPost<{ success?: boolean; reservation?: any; error?: string }>(
          '/api/pos/reservations',
          payload,
        )
      : await this.bridge.reservations.create(payload);

    if (!result.success) {
      throw new Error(result.error || 'Failed to create reservation');
    }

    const body = (result.data ?? {}) as {
      success?: boolean;
      reservation?: any;
      error?: string;
      message?: string;
    };

    if (body.success === false || !body.reservation) {
      throw new Error(body.error || body.message || 'Failed to create reservation');
    }

    return body.reservation;
  }

  private async updateReservationRequest(
    reservationId: string,
    payload: Record<string, unknown>,
  ) {
    const result = isBrowser()
      ? await posApiPatch<{ success?: boolean; reservation?: any; error?: string }>(
          `/api/pos/reservations/${reservationId}`,
          payload,
        )
      : await this.bridge.reservations.update(reservationId, payload);

    if (!result.success) {
      throw new Error(result.error || 'Failed to update reservation');
    }

    const body = (result.data ?? {}) as {
      success?: boolean;
      reservation?: any;
      error?: string;
      message?: string;
    };

    if (body.success === false || !body.reservation) {
      throw new Error(body.error || body.message || 'Failed to update reservation');
    }

    return body.reservation;
  }

  async fetchReservations(filters?: ReservationFilters): Promise<Reservation[]> {
    try {
      if (!this.branchId) {
        return [];
      }

      const search = filters?.searchTerm || undefined;
      const status =
        filters?.statusFilter && filters.statusFilter !== 'all'
          ? filters.statusFilter
          : undefined;

      let rows: any[] = [];
      const rangeDates =
        filters?.dateFrom && filters?.dateTo
          ? listDatesInclusive(filters.dateFrom, filters.dateTo)
          : [];

      if (rangeDates.length > 1) {
        const responses = await Promise.all(
          rangeDates.map((date) =>
            this.listReservations({
              date,
              status,
              search,
            }),
          ),
        );

        const errors = responses.map((response) => response.error).filter(Boolean);
        if (errors.length > 0) {
          console.warn('[ReservationsService] Range reservation fetch returned errors:', errors);
        }

        const deduped = new Map<string, any>();
        responses.forEach((response) => {
          response.reservations.forEach((reservation) => {
            if (reservation?.id) {
              deduped.set(String(reservation.id), reservation);
            }
          });
        });
        rows = Array.from(deduped.values());
      } else {
        const response = await this.listReservations({
          date: filters?.dateFrom || filters?.dateTo,
          status,
          search,
        });

        if (response.error) {
          console.error('[ReservationsService] Failed to fetch reservations:', response.error);
          return [];
        }

        rows = response.reservations;
      }

      return rows
        .map(transformFromAPI)
        .sort(
          (a, b) =>
            new Date(a.reservationDatetime || a.checkInDate || '').getTime() -
            new Date(b.reservationDatetime || b.checkInDate || '').getTime(),
        );
    } catch (error) {
      console.error('[ReservationsService] Failed to fetch reservations:', formatError(error));
      return [];
    }
  }

  async fetchReservationById(reservationId: string): Promise<Reservation | null> {
    try {
      const response = await this.getReservation(reservationId);
      if (!response.reservation) {
        if (response.error) {
          console.error('[ReservationsService] Error fetching reservation:', response.error);
        }
        return null;
      }

      return transformFromAPI(response.reservation);
    } catch (error) {
      console.error('[ReservationsService] Failed to fetch reservation:', formatError(error));
      return null;
    }
  }

  async createReservation(data: CreateReservationDto): Promise<Reservation> {
    const reservation = await this.createReservationRequest({
      customerName: data.customerName,
      customerPhone: data.customerPhone,
      customerEmail: data.customerEmail || undefined,
      partySize: data.partySize,
      reservationDate: data.reservationDate,
      reservationTime: data.reservationTime,
      durationMinutes: data.durationMinutes || 90,
      tableId: data.tableId || undefined,
      roomId: data.roomId || undefined,
      roomNumber: data.roomNumber || undefined,
      checkInDate: data.checkInDate || undefined,
      checkOutDate: data.checkOutDate || undefined,
      customerId: data.customerId || undefined,
      specialRequests: data.specialRequests || undefined,
      notes: data.notes || undefined,
    });

    return transformFromAPI(reservation);
  }

  async updateStatus(
    reservationId: string,
    status: ReservationStatus,
    metadata?: { cancellationReason?: string },
  ): Promise<Reservation> {
    const reservation = await this.updateReservationRequest(reservationId, {
      status,
      cancellation_reason: metadata?.cancellationReason,
    });

    return transformFromAPI(reservation);
  }

  async assignTable(reservationId: string, tableId: string): Promise<Reservation> {
    const reservation = await this.updateReservationRequest(reservationId, {
      table_id: tableId,
    });

    return transformFromAPI(reservation);
  }

  calculateStats(reservations: Reservation[]): ReservationStats {
    const stats: ReservationStats = {
      total: reservations.length,
      confirmed: 0,
      pending: 0,
      seated: 0,
      completed: 0,
      noShow: 0,
      cancelled: 0,
      totalGuests: 0,
    };

    reservations.forEach((reservation) => {
      if (reservation.status === 'confirmed') stats.confirmed++;
      if (reservation.status === 'pending') stats.pending++;
      if (reservation.status === 'seated') stats.seated++;
      if (reservation.status === 'completed') stats.completed++;
      if (reservation.status === 'no_show') stats.noShow++;
      if (reservation.status === 'cancelled') stats.cancelled++;

      if (['confirmed', 'pending', 'seated'].includes(reservation.status)) {
        stats.totalGuests += reservation.partySize;
      }
    });

    return stats;
  }

  async updateTableStatus(tableId: string, status: string): Promise<boolean> {
    try {
      const result = isBrowser()
        ? await posApiPatch<{ success?: boolean; error?: string }>(
            `/api/pos/tables/${tableId}`,
            { status },
          )
        : await this.bridge.tables.updateStatus(tableId, status);

      if (!result.success) {
        console.error('[ReservationsService] Failed to update table status:', result.error);
        return false;
      }

      const payload = (result.data ?? {}) as { success?: boolean; error?: string };
      if (payload.success === false) {
        console.error('[ReservationsService] Failed to update table status:', payload.error);
        return false;
      }

      return true;
    } catch (error) {
      console.error('[ReservationsService] Failed to update table status:', formatError(error));
      return false;
    }
  }

  async updateTableStatusIfNearTime(
    tableId: string,
    reservationDatetime: string,
    minutesThreshold = 30,
  ): Promise<boolean> {
    try {
      const reservationTime = new Date(reservationDatetime);
      const now = new Date();
      const diffMinutes = (reservationTime.getTime() - now.getTime()) / (1000 * 60);

      if (diffMinutes >= -5 && diffMinutes <= minutesThreshold) {
        return this.updateTableStatusToReserved(tableId);
      }

      return false;
    } catch (error) {
      console.error(
        '[ReservationsService] Failed to update table status for near-time reservation:',
        formatError(error),
      );
      return false;
    }
  }

  async createReservationWithTableUpdate(data: CreateReservationDto): Promise<Reservation> {
    const reservation = await this.createReservation(data);

    if (data.tableId) {
      const today = toLocalDateString();
      if (data.reservationDate === today) {
        await this.updateTableStatusToReserved(data.tableId);
      }
    }

    return reservation;
  }

  async updateTableStatusToReserved(tableId: string): Promise<boolean> {
    return this.updateTableStatus(tableId, 'reserved');
  }

  async getReservationsForTable(tableId: string): Promise<Reservation[]> {
    try {
      const response = await this.listReservations({ table_id: tableId });
      if (response.error) {
        console.error('[ReservationsService] Error fetching reservations for table:', response.error);
        return [];
      }

      return response.reservations
        .filter((reservation) => ['pending', 'confirmed'].includes(reservation?.status))
        .map(transformFromAPI)
        .sort(
          (a, b) =>
            new Date(a.reservationDatetime || '').getTime() -
            new Date(b.reservationDatetime || '').getTime(),
        );
    } catch (error) {
      console.error('[ReservationsService] Failed to fetch reservations for table:', formatError(error));
      return [];
    }
  }

  async getTodayReservationForTable(tableId: string): Promise<Reservation | null> {
    try {
      const today = toLocalDateString();
      const response = await this.listReservations({ date: today, table_id: tableId });
      if (response.error) {
        console.error(
          '[ReservationsService] Error fetching today reservation for table:',
          response.error,
        );
        return null;
      }

      const filtered = response.reservations
        .filter((reservation) => ['pending', 'confirmed'].includes(reservation?.status))
        .sort(
          (a, b) =>
            new Date(a?.reservation_datetime || '').getTime() -
            new Date(b?.reservation_datetime || '').getTime(),
        );

      return filtered.length > 0 ? transformFromAPI(filtered[0]) : null;
    } catch (error) {
      console.error('[ReservationsService] Failed to fetch today reservation for table:', formatError(error));
      return null;
    }
  }

  async checkReservationConflicts(
    tableId: string,
    reservationDate: string,
    reservationTime: string,
    durationMinutes = 90,
  ): Promise<Reservation[]> {
    try {
      const response = await this.listReservations({
        date: reservationDate,
        table_id: tableId,
      });

      if (response.error) {
        console.error('[ReservationsService] Error checking reservation conflicts:', response.error);
        return [];
      }

      const newStartTime = new Date(`${reservationDate}T${reservationTime}`);
      const newEndTime = new Date(newStartTime.getTime() + durationMinutes * 60 * 1000);

      return response.reservations
        .filter(
          (reservation) =>
            ['pending', 'confirmed'].includes(reservation?.status) &&
            reservation?.reservation_date === reservationDate,
        )
        .filter((reservation) => {
          const existingStartTime = new Date(
            `${reservation.reservation_date}T${reservation.reservation_time}`,
          );
          const existingEndTime = new Date(
            existingStartTime.getTime() +
              (Number(reservation.duration_minutes || 90) * 60 * 1000),
          );
          return newStartTime < existingEndTime && newEndTime > existingStartTime;
        })
        .map(transformFromAPI);
    } catch (error) {
      console.error('[ReservationsService] Failed to check reservation conflicts:', formatError(error));
      return [];
    }
  }

  async cancelReservation(reservationId: string, reason?: string): Promise<Reservation> {
    return this.updateStatus(reservationId, 'cancelled', { cancellationReason: reason });
  }

  async syncTableStatusesForToday(): Promise<void> {
    try {
      const today = toLocalDateString();
      const response = await this.listReservations({ date: today });
      if (response.error) {
        console.error('[ReservationsService] Error fetching today reservations:', response.error);
        return;
      }

      const tableIds = [
        ...new Set(
          response.reservations
            .filter(
              (reservation) =>
                reservation?.table_id &&
                reservation?.reservation_date === today &&
                ['pending', 'confirmed'].includes(reservation?.status),
            )
            .map((reservation) => String(reservation.table_id)),
        ),
      ];

      for (const tableId of tableIds) {
        await this.updateTableStatusToReserved(tableId);
      }

      if (tableIds.length > 0) {
        console.log(
          `[ReservationsService] Synced ${tableIds.length} table(s) to reserved status for today's reservations`,
        );
      }
    } catch (error) {
      console.error(
        '[ReservationsService] Failed to sync table statuses for today:',
        formatError(error),
      );
    }
  }
}

export const reservationsService = new ReservationsService();
