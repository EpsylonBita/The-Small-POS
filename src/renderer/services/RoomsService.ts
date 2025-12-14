/**
 * RoomsService - POS Rooms Service
 *
 * Provides room management functionality for the POS system (Hotel Vertical).
 * Uses direct Supabase access (same pattern as useTables).
 *
 * Task 17.1: Create POS rooms interface
 */

import { supabase, subscribeToTable, unsubscribeFromChannel } from '../../shared/supabase';

// Types
export type RoomStatus = 'available' | 'occupied' | 'cleaning' | 'maintenance' | 'reserved';
export type RoomType = 'standard' | 'deluxe' | 'suite' | 'penthouse' | 'accessible';

export interface Room {
  id: string;
  organizationId: string;
  branchId: string;
  roomNumber: string;
  roomType: RoomType;
  floor: number;
  status: RoomStatus;
  capacity: number;
  ratePerNight: number | null;
  amenities: string[];
  notes: string | null;
  currentGuestId: string | null;
  currentGuestName: string | null;
  checkoutDate: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RoomFilters {
  statusFilter?: RoomStatus | 'all';
  floorFilter?: number | 'all';
  roomTypeFilter?: RoomType | 'all';
  searchTerm?: string;
}

export interface RoomStats {
  totalRooms: number;
  availableRooms: number;
  occupiedRooms: number;
  cleaningRooms: number;
  maintenanceRooms: number;
  reservedRooms: number;
  occupancyRate: number;
}

function transformFromAPI(data: Record<string, unknown>): Room {
  return {
    id: data.id as string,
    organizationId: data.organization_id as string,
    branchId: data.branch_id as string,
    roomNumber: data.room_number as string,
    roomType: (data.room_type as RoomType) || 'standard',
    floor: (data.floor as number) || 1,
    status: (data.status as RoomStatus) || 'available',
    capacity: (data.capacity as number) || 2,
    ratePerNight: data.rate_per_night as number | null,
    amenities: (data.amenities as string[]) || [],
    notes: data.notes as string | null,
    currentGuestId: data.current_guest_id as string | null,
    currentGuestName: data.current_guest_name as string | null,
    checkoutDate: data.checkout_date as string | null,
    createdAt: data.created_at as string,
    updatedAt: data.updated_at as string,
  };
}


class RoomsService {
  private branchId: string = '';
  private organizationId: string = '';
  private realtimeChannel: ReturnType<typeof subscribeToTable> | null = null;

  setContext(branchId: string, organizationId: string): void {
    this.branchId = branchId;
    this.organizationId = organizationId;
  }

  async fetchRooms(filters?: RoomFilters): Promise<Room[]> {
    try {
      if (!this.branchId) {
        console.warn('[RoomsService] Missing branchId');
        return [];
      }

      console.log('[RoomsService] Fetching rooms from Supabase:', {
        branchId: this.branchId,
        organizationId: this.organizationId,
      });

      let query = (supabase as any)
        .from('rooms')
        .select('*')
        .eq('branch_id', this.branchId)
        .order('floor', { ascending: true })
        .order('room_number', { ascending: true });

      if (this.organizationId) {
        query = query.eq('organization_id', this.organizationId);
      }

      if (filters?.statusFilter && filters.statusFilter !== 'all') {
        query = query.eq('status', filters.statusFilter);
      }
      if (filters?.floorFilter && filters.floorFilter !== 'all') {
        query = query.eq('floor', filters.floorFilter);
      }
      if (filters?.roomTypeFilter && filters.roomTypeFilter !== 'all') {
        query = query.eq('room_type', filters.roomTypeFilter);
      }

      const { data, error } = await query;

      if (error) {
        console.error('[RoomsService] Supabase error:', error);
        throw error;
      }

      let rooms = (data || []).map((item: Record<string, unknown>) => transformFromAPI(item));

      if (filters?.searchTerm) {
        const term = filters.searchTerm.toLowerCase();
        rooms = rooms.filter(
          (r: Room) =>
            r.roomNumber.toLowerCase().includes(term) ||
            (r.currentGuestName && r.currentGuestName.toLowerCase().includes(term))
        );
      }

      console.log('[RoomsService] Fetched rooms:', rooms.length);
      return rooms;
    } catch (error) {
      console.error('[RoomsService] Failed to fetch rooms:', error);
      return [];
    }
  }

  async updateStatus(roomId: string, newStatus: RoomStatus): Promise<Room> {
    try {
      console.log('[RoomsService] Updating room status:', roomId, newStatus);

      const { data, error } = await (supabase as any)
        .from('rooms')
        .update({
          status: newStatus,
          updated_at: new Date().toISOString(),
        })
        .eq('id', roomId)
        .select()
        .single();

      if (error) {
        console.error('[RoomsService] Supabase error:', error);
        throw error;
      }

      return transformFromAPI(data as Record<string, unknown>);
    } catch (error) {
      console.error('[RoomsService] Failed to update room status:', error);
      throw error;
    }
  }

  calculateStats(rooms: Room[]): RoomStats {
    const stats: RoomStats = {
      totalRooms: rooms.length,
      availableRooms: 0,
      occupiedRooms: 0,
      cleaningRooms: 0,
      maintenanceRooms: 0,
      reservedRooms: 0,
      occupancyRate: 0,
    };

    rooms.forEach((r: Room) => {
      if (r.status === 'available') stats.availableRooms++;
      if (r.status === 'occupied') stats.occupiedRooms++;
      if (r.status === 'cleaning') stats.cleaningRooms++;
      if (r.status === 'maintenance') stats.maintenanceRooms++;
      if (r.status === 'reserved') stats.reservedRooms++;
    });

    if (stats.totalRooms > 0) {
      stats.occupancyRate = Math.round((stats.occupiedRooms / stats.totalRooms) * 100);
    }

    return stats;
  }

  getUniqueFloors(rooms: Room[]): number[] {
    return [...new Set(rooms.map((r: Room) => r.floor))].sort((a, b) => a - b);
  }

  subscribeToUpdates(callback: (room: Room) => void): void {
    if (this.realtimeChannel) {
      this.unsubscribeFromUpdates();
    }

    if (!this.branchId) {
      console.warn('[RoomsService] Cannot subscribe without branchId');
      return;
    }

    this.realtimeChannel = subscribeToTable(
      'rooms',
      (payload: { new?: Record<string, unknown> }) => {
        if (payload.new) {
          console.log('[RoomsService] Realtime update received');
          callback(transformFromAPI(payload.new));
        }
      },
      `branch_id=eq.${this.branchId}`
    );

    console.log('[RoomsService] Subscribed to realtime updates');
  }

  unsubscribeFromUpdates(): void {
    if (this.realtimeChannel) {
      unsubscribeFromChannel(this.realtimeChannel);
      this.realtimeChannel = null;
      console.log('[RoomsService] Unsubscribed from realtime updates');
    }
  }
}

export const roomsService = new RoomsService();
