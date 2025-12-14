/**
 * ReservationsService - POS Reservations Service
 * 
 * Provides reservation management functionality for the POS system.
 * Uses direct Supabase connection for real-time data.
 * 
 * Requirements:
 * - 4.3: Store reservation with 'pending' status
 * - 4.6: Generate unique reservation number in format RES-YYYYMMDD-XXXX
 * 
 * **Feature: pos-tables-reservations-sync, Property 5: Reservation Number Format**
 * **Validates: Requirements 4.6**
 */

import { supabase, subscribeToTable, unsubscribeFromChannel } from '../../shared/supabase';

// Re-export utility functions for convenience
export { 
  generateReservationNumber, 
  validateReservationNumberFormat, 
  parseReservationNumber,
  isReservationWithinMinutes,
  isReservationLate
} from '../utils/reservationUtils';

// Types
export type ReservationStatus = 'pending' | 'confirmed' | 'seated' | 'completed' | 'no_show' | 'cancelled';

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

// Transform API response to domain model
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

class ReservationsService {
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
   * Fetch reservations with optional filters
   * For room reservations, also fetches reservations where the date range overlaps with check_in/check_out dates
   */
  async fetchReservations(filters?: ReservationFilters): Promise<Reservation[]> {
    try {
      // Fetch table reservations (filtered by reservation_date)
      let tableQuery = supabase
        .from('reservations')
        .select('*')
        .eq('branch_id', this.branchId)
        .not('table_id', 'is', null)
        .order('reservation_datetime', { ascending: true });

      if (filters?.dateFrom) {
        tableQuery = tableQuery.gte('reservation_date', filters.dateFrom);
      }
      if (filters?.dateTo) {
        tableQuery = tableQuery.lte('reservation_date', filters.dateTo);
      }
      if (filters?.statusFilter && filters.statusFilter !== 'all') {
        tableQuery = tableQuery.eq('status', filters.statusFilter);
      }
      if (filters?.searchTerm) {
        tableQuery = tableQuery.or(
          `customer_name.ilike.%${filters.searchTerm}%,customer_phone.ilike.%${filters.searchTerm}%`
        );
      }

      // Fetch room reservations
      // For room reservations, show all active/upcoming reservations
      // The date filter is less strict - show reservations that are:
      // 1. Currently active (check_in <= today AND check_out >= today)
      // 2. Upcoming (check_in is in the future)
      // 3. Recently completed (check_out was recent)
      let roomQuery = supabase
        .from('reservations')
        .select('*')
        .eq('branch_id', this.branchId)
        .not('room_id', 'is', null)
        .in('status', ['pending', 'confirmed', 'seated']) // Only active reservations
        .order('check_in_date', { ascending: true });

      // For room reservations with a single day filter (Today/Tomorrow), 
      // show all reservations where check_out hasn't passed yet
      if (filters?.dateFrom) {
        roomQuery = roomQuery.gte('check_out_date', filters.dateFrom);
      }
      // For week view, also limit to reservations starting within the range
      if (filters?.dateFrom !== filters?.dateTo && filters?.dateTo) {
        // Week view - show reservations that overlap with the week
        // Already filtered by check_out >= dateFrom above
        // No additional filter needed - we want to see all active reservations
      }
      if (filters?.statusFilter && filters.statusFilter !== 'all') {
        roomQuery = roomQuery.eq('status', filters.statusFilter);
      }
      if (filters?.searchTerm) {
        roomQuery = roomQuery.or(
          `customer_name.ilike.%${filters.searchTerm}%,customer_phone.ilike.%${filters.searchTerm}%`
        );
      }

      // Execute both queries
      const [tableResult, roomResult] = await Promise.all([tableQuery, roomQuery]);

      if (tableResult.error) {
        console.error('Error fetching table reservations:', tableResult.error);
      }
      if (roomResult.error) {
        console.error('Error fetching room reservations:', roomResult.error);
      }

      // Combine results
      const tableData = tableResult.data || [];
      const roomData = roomResult.data || [];
      const data = [...tableData, ...roomData];

      // Sort combined results by datetime
      return data.map(transformFromAPI).sort((a, b) => 
        new Date(a.reservationDatetime || a.checkInDate || '').getTime() - 
        new Date(b.reservationDatetime || b.checkInDate || '').getTime()
      );
    } catch (error) {
      console.error('Failed to fetch reservations:', error);
      return [];
    }
  }

  /**
   * Fetch a single reservation by ID
   */
  async fetchReservationById(reservationId: string): Promise<Reservation | null> {
    try {
      const { data, error } = await supabase
        .from('reservations')
        .select('*')
        .eq('id', reservationId)
        .single();

      if (error) {
        console.error('Error fetching reservation:', error);
        return null;
      }

      return data ? transformFromAPI(data) : null;
    } catch (error) {
      console.error('Failed to fetch reservation:', error);
      return null;
    }
  }

  /**
   * Create a new reservation
   * 
   * Requirements:
   * - 4.3: Store reservation with 'pending' status
   * - 4.6: Generate unique reservation number in format RES-YYYYMMDD-XXXX
   * 
   * Note: The database trigger generates the reservation_number automatically.
   * The client-side generation is available for testing and fallback purposes.
   */
  async createReservation(data: CreateReservationDto): Promise<Reservation> {
    try {
      // Combine date and time into datetime
      const reservationDatetime = `${data.reservationDate}T${data.reservationTime}`;
      
      const insertData = {
        organization_id: this.organizationId,
        branch_id: this.branchId,
        customer_name: data.customerName,
        customer_phone: data.customerPhone,
        customer_email: data.customerEmail || null,
        party_size: data.partySize,
        reservation_date: data.reservationDate,
        reservation_time: data.reservationTime,
        reservation_datetime: reservationDatetime,
        duration_minutes: data.durationMinutes || 90,
        table_id: data.tableId || null,
        room_id: data.roomId || null,
        room_number: data.roomNumber || null,
        check_in_date: data.checkInDate || null,
        check_out_date: data.checkOutDate || null,
        customer_id: data.customerId || null,
        special_requests: data.specialRequests || null,
        notes: data.notes || null,
        status: 'pending', // Requirements 4.3: Store with 'pending' status
      };

      const { data: reservation, error } = await supabase
        .from('reservations')
        .insert(insertData)
        .select()
        .single();

      if (error) {
        console.error('Error creating reservation:', error);
        throw error;
      }

      return transformFromAPI(reservation);
    } catch (error) {
      console.error('Failed to create reservation:', error);
      throw error;
    }
  }

  /**
   * Update reservation status
   */
  async updateStatus(
    reservationId: string,
    status: ReservationStatus,
    metadata?: { cancellationReason?: string }
  ): Promise<Reservation> {
    try {
      const updateData: any = {
        status,
        updated_at: new Date().toISOString(),
      };

      const now = new Date().toISOString();
      if (status === 'confirmed') {
        updateData.confirmed_at = now;
      } else if (status === 'seated') {
        updateData.seated_at = now;
      } else if (status === 'completed') {
        updateData.completed_at = now;
      } else if (status === 'cancelled') {
        updateData.cancelled_at = now;
        updateData.cancellation_reason = metadata?.cancellationReason || null;
      }

      const { data: reservation, error } = await supabase
        .from('reservations')
        .update(updateData)
        .eq('id', reservationId)
        .select()
        .single();

      if (error) {
        console.error('Error updating reservation status:', error);
        throw error;
      }

      return transformFromAPI(reservation);
    } catch (error) {
      console.error('Failed to update reservation status:', error);
      throw error;
    }
  }

  /**
   * Assign a table to a reservation
   */
  async assignTable(reservationId: string, tableId: string): Promise<Reservation> {
    try {
      const { data: reservation, error } = await supabase
        .from('reservations')
        .update({
          table_id: tableId,
          updated_at: new Date().toISOString(),
        })
        .eq('id', reservationId)
        .select()
        .single();

      if (error) {
        console.error('Error assigning table:', error);
        throw error;
      }

      return transformFromAPI(reservation);
    } catch (error) {
      console.error('Failed to assign table:', error);
      throw error;
    }
  }

  /**
   * Calculate statistics from reservations
   */
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

    reservations.forEach((r) => {
      if (r.status === 'confirmed') stats.confirmed++;
      if (r.status === 'pending') stats.pending++;
      if (r.status === 'seated') stats.seated++;
      if (r.status === 'completed') stats.completed++;
      if (r.status === 'no_show') stats.noShow++;
      if (r.status === 'cancelled') stats.cancelled++;

      // Count guests for active reservations
      if (['confirmed', 'pending', 'seated'].includes(r.status)) {
        stats.totalGuests += r.partySize;
      }
    });

    return stats;
  }

  /**
   * Subscribe to real-time reservation updates
   */
  subscribeToUpdates(callback: (reservation: Reservation) => void): void {
    if (this.realtimeChannel) {
      this.unsubscribeFromUpdates();
    }

    this.realtimeChannel = subscribeToTable(
      'reservations',
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

  /**
   * Update table status to 'reserved' if reservation is within threshold
   * 
   * **Feature: pos-tables-reservations-sync, Property 6: Near-Time Reservation Table Status**
   * **Validates: Requirements 4.4**
   * 
   * Requirements 4.4: Update table status to 'reserved' if reservation time is within 30 minutes
   * 
   * @param tableId - The table ID to update
   * @param reservationDatetime - The reservation datetime string
   * @param minutesThreshold - Minutes threshold (default 30)
   * @returns true if table was updated, false otherwise
   */
  async updateTableStatusIfNearTime(
    tableId: string,
    reservationDatetime: string,
    minutesThreshold: number = 30
  ): Promise<boolean> {
    try {
      const reservationTime = new Date(reservationDatetime);
      const now = new Date();
      
      // Check if reservation is within threshold
      const diffMs = reservationTime.getTime() - now.getTime();
      const diffMinutes = diffMs / (1000 * 60);
      
      // Only update if reservation is in the future and within threshold
      // Also allow slightly past reservations (up to 5 minutes) for edge cases
      if (diffMinutes >= -5 && diffMinutes <= minutesThreshold) {
        const { error } = await supabase
          .from('restaurant_tables')
          .update({
            status: 'reserved',
            updated_at: new Date().toISOString(),
          })
          .eq('id', tableId)
          .eq('branch_id', this.branchId);

        if (error) {
          console.error('Error updating table status:', error);
          return false;
        }

        return true;
      }

      return false;
    } catch (error) {
      console.error('Failed to update table status for near-time reservation:', error);
      return false;
    }
  }

  /**
   * Create a reservation and update table status if it's for today
   * 
   * **Feature: pos-tables-reservations-sync, Property 6: Near-Time Reservation Table Status**
   * **Validates: Requirements 4.4**
   * 
   * This is a convenience method that combines reservation creation with
   * automatic table status update for today's reservations.
   */
  async createReservationWithTableUpdate(data: CreateReservationDto): Promise<Reservation> {
    // Create the reservation first
    const reservation = await this.createReservation(data);

    // If a table is assigned and reservation is for today, update table status to reserved
    if (data.tableId) {
      const today = new Date().toISOString().split('T')[0];
      if (data.reservationDate === today) {
        await this.updateTableStatusToReserved(data.tableId);
      }
    }

    return reservation;
  }

  /**
   * Update table status to 'reserved'
   */
  async updateTableStatusToReserved(tableId: string): Promise<boolean> {
    try {
      const { error } = await supabase
        .from('restaurant_tables')
        .update({
          status: 'reserved',
          updated_at: new Date().toISOString(),
        })
        .eq('id', tableId)
        .eq('branch_id', this.branchId);

      if (error) {
        console.error('Error updating table status to reserved:', error);
        return false;
      }

      return true;
    } catch (error) {
      console.error('Failed to update table status to reserved:', error);
      return false;
    }
  }

  /**
   * Get all reservations for a specific table
   */
  async getReservationsForTable(tableId: string): Promise<Reservation[]> {
    try {
      const { data, error } = await supabase
        .from('reservations')
        .select('*')
        .eq('table_id', tableId)
        .eq('branch_id', this.branchId)
        .in('status', ['pending', 'confirmed'])
        .order('reservation_datetime', { ascending: true });

      if (error) {
        console.error('Error fetching reservations for table:', error);
        return [];
      }

      return (data || []).map(transformFromAPI);
    } catch (error) {
      console.error('Failed to fetch reservations for table:', error);
      return [];
    }
  }

  /**
   * Get today's reservation for a specific table (if any)
   */
  async getTodayReservationForTable(tableId: string): Promise<Reservation | null> {
    try {
      const today = new Date().toISOString().split('T')[0];
      
      const { data, error } = await supabase
        .from('reservations')
        .select('*')
        .eq('table_id', tableId)
        .eq('branch_id', this.branchId)
        .eq('reservation_date', today)
        .in('status', ['pending', 'confirmed'])
        .order('reservation_time', { ascending: true })
        .limit(1);

      if (error) {
        console.error('Error fetching today reservation for table:', error);
        return null;
      }

      return data && data.length > 0 ? transformFromAPI(data[0]) : null;
    } catch (error) {
      console.error('Failed to fetch today reservation for table:', error);
      return null;
    }
  }

  /**
   * Check for reservation conflicts at a specific date/time for a table
   * Returns conflicting reservations if any exist
   */
  async checkReservationConflicts(
    tableId: string,
    reservationDate: string,
    reservationTime: string,
    durationMinutes: number = 90
  ): Promise<Reservation[]> {
    try {
      // Get all reservations for this table on the same date
      const { data, error } = await supabase
        .from('reservations')
        .select('*')
        .eq('table_id', tableId)
        .eq('branch_id', this.branchId)
        .eq('reservation_date', reservationDate)
        .in('status', ['pending', 'confirmed']);

      if (error) {
        console.error('Error checking reservation conflicts:', error);
        return [];
      }

      if (!data || data.length === 0) {
        return [];
      }

      // Check for time overlaps
      const newStartTime = new Date(`${reservationDate}T${reservationTime}`);
      const newEndTime = new Date(newStartTime.getTime() + durationMinutes * 60 * 1000);

      const conflicts = data.filter((res: any) => {
        const existingStartTime = new Date(`${res.reservation_date}T${res.reservation_time}`);
        const existingEndTime = new Date(existingStartTime.getTime() + (res.duration_minutes || 90) * 60 * 1000);

        // Check if times overlap
        return (newStartTime < existingEndTime && newEndTime > existingStartTime);
      });

      return conflicts.map(transformFromAPI);
    } catch (error) {
      console.error('Failed to check reservation conflicts:', error);
      return [];
    }
  }

  /**
   * Cancel a reservation
   */
  async cancelReservation(reservationId: string, reason?: string): Promise<Reservation> {
    return this.updateStatus(reservationId, 'cancelled', { cancellationReason: reason });
  }

  /**
   * Update all table statuses based on today's reservations
   * Call this on app startup or periodically to sync table statuses
   */
  async syncTableStatusesForToday(): Promise<void> {
    try {
      const today = new Date().toISOString().split('T')[0];
      
      // Get all today's active reservations with table assignments
      const { data: reservations, error } = await supabase
        .from('reservations')
        .select('table_id')
        .eq('branch_id', this.branchId)
        .eq('reservation_date', today)
        .in('status', ['pending', 'confirmed'])
        .not('table_id', 'is', null);

      if (error) {
        console.error('Error fetching today reservations:', error);
        return;
      }

      if (!reservations || reservations.length === 0) {
        return;
      }

      // Get unique table IDs
      const tableIds = [...new Set(reservations.map((r: any) => r.table_id))];

      // Update all these tables to 'reserved' status
      for (const tableId of tableIds) {
        await this.updateTableStatusToReserved(tableId as string);
      }

      console.log(`✅ Synced ${tableIds.length} table(s) to reserved status for today's reservations`);
    } catch (error) {
      console.error('Failed to sync table statuses for today:', error);
    }
  }
}

// Export singleton instance
export const reservationsService = new ReservationsService();
