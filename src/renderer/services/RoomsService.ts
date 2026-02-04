/**
 * RoomsService - POS Rooms Service
 *
 * Provides room management functionality for the POS system (Hotel Vertical).
 * Uses the Admin Dashboard API via IPC for proper authentication and audit logging.
 *
 * @since 2.1.0 - Migrated from direct Supabase to API via IPC
 */

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

// API response type (snake_case from server)
interface RoomFromAPI {
  id: string;
  organization_id: string;
  branch_id: string;
  room_number: string;
  room_type: RoomType;
  floor: number;
  status: RoomStatus;
  capacity: number;
  rate_per_night: number | null;
  amenities: string[];
  notes: string | null;
  current_guest_id?: string | null;
  current_guest_name?: string | null;
  checkout_date?: string | null;
  created_at: string;
  updated_at: string;
}

function transformFromAPI(data: RoomFromAPI): Room {
  return {
    id: data.id,
    organizationId: data.organization_id,
    branchId: data.branch_id,
    roomNumber: data.room_number,
    roomType: data.room_type || 'standard',
    floor: data.floor || 1,
    status: data.status || 'available',
    capacity: data.capacity || 2,
    ratePerNight: data.rate_per_night,
    amenities: data.amenities || [],
    notes: data.notes,
    currentGuestId: data.current_guest_id || null,
    currentGuestName: data.current_guest_name || null,
    checkoutDate: data.checkout_date || null,
    createdAt: data.created_at,
    updatedAt: data.updated_at,
  };
}


class RoomsService {
  private branchId: string = '';
  private organizationId: string = '';
  private realtimeUnsubscribe: (() => void) | null = null;

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

      console.log('[RoomsService] Fetching rooms via API:', {
        branchId: this.branchId,
        organizationId: this.organizationId,
      });

      // Build filter options for API
      const options: Record<string, string | number | undefined> = {};
      if (filters?.statusFilter && filters.statusFilter !== 'all') {
        options.status = filters.statusFilter;
      }
      if (filters?.floorFilter && filters.floorFilter !== 'all') {
        options.floor = filters.floorFilter;
      }
      if (filters?.roomTypeFilter && filters.roomTypeFilter !== 'all') {
        options.room_type = filters.roomTypeFilter;
      }

      // Use IPC to fetch rooms via API (proper auth & audit logging)
      const result = await (window as any).api.invoke('sync:fetch-rooms', options);

      if (!result.success) {
        console.error('[RoomsService] API error:', result.error);
        throw new Error(result.error || 'Failed to fetch rooms');
      }

      let rooms = (result.rooms || []).map((item: RoomFromAPI) => transformFromAPI(item));

      // Apply local search filter (not supported by API)
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
      console.log('[RoomsService] Updating room status via API:', roomId, newStatus);

      // Use IPC to update room via API (proper auth & audit logging)
      const result = await (window as any).api.invoke('sync:update-room-status', roomId, newStatus);

      if (!result.success) {
        console.error('[RoomsService] API error:', result.error);
        throw new Error(result.error || 'Failed to update room status');
      }

      return transformFromAPI(result.room);
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
    // Real-time updates are now handled via Supabase Realtime subscriptions
    // set up elsewhere (e.g., in the RoomsPage component or a dedicated sync service)
    // This method is kept for API compatibility but uses event-based updates
    if (this.realtimeUnsubscribe) {
      this.unsubscribeFromUpdates();
    }

    if (!this.branchId) {
      console.warn('[RoomsService] Cannot subscribe without branchId');
      return;
    }

    // Listen for room updates from the main process (if Supabase realtime is set up there)
    const handler = (_event: any, payload: { room: RoomFromAPI }) => {
      if (payload.room) {
        console.log('[RoomsService] Received room update via IPC');
        callback(transformFromAPI(payload.room));
      }
    };

    (window as any).api.on('rooms:updated', handler);
    this.realtimeUnsubscribe = () => {
      (window as any).api.off('rooms:updated', handler);
    };

    console.log('[RoomsService] Subscribed to room updates via IPC');
  }

  unsubscribeFromUpdates(): void {
    if (this.realtimeUnsubscribe) {
      this.realtimeUnsubscribe();
      this.realtimeUnsubscribe = null;
      console.log('[RoomsService] Unsubscribed from room updates');
    }
  }
}

export const roomsService = new RoomsService();
