/**
 * useRooms Hook
 * 
 * React hook for managing rooms in the POS system (Hotel Vertical).
 * Provides data fetching, mutations, and real-time updates.
 * 
 * Task 17.1: Create POS rooms interface
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import {
  roomsService,
  getRoomEffectiveStatus,
  Room,
  RoomFilters,
  RoomStats,
  RoomStatus,
} from '../services/RoomsService';

interface UseRoomsProps {
  branchId: string;
  organizationId: string;
  filters?: RoomFilters;
  enableRealtime?: boolean;
}

interface UseRoomsReturn {
  // Data
  rooms: Room[];
  // The full, unfiltered branch room set (not narrowed by the grid's search/status/floor
  // filters). Action surfaces (create/check-in/reservation selectors and their selected-room
  // lookups) must use this so a grid search for one room can't hide every other room.
  allRooms: Room[];
  stats: RoomStats;
  floors: number[];
  isLoading: boolean;
  error: string | null;

  // Actions
  refetch: () => Promise<void>;
  updateStatus: (roomId: string, status: RoomStatus) => Promise<Room | null>;

  // Filters
  setFilters: (filters: RoomFilters) => void;
}

export function useRooms({
  branchId,
  organizationId,
  filters: externalFilters,
  enableRealtime = true,
}: UseRoomsProps): UseRoomsReturn {
  const { t } = useTranslation();
  const [allRooms, setAllRooms] = useState<Room[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [internalFilters, setFilters] = useState<RoomFilters>(externalFilters || {});

  // Use external filters if provided, otherwise use internal
  const filters = externalFilters || internalFilters;

  // Set context when branch/org changes
  useEffect(() => {
    if (branchId && organizationId) {
      roomsService.setContext(branchId, organizationId);
    }
  }, [branchId, organizationId]);

  // Fetch all rooms (without filters - we'll filter client-side for responsiveness)
  const fetchRooms = useCallback(async () => {
    if (!branchId) return;

    setIsLoading(true);
    setError(null);

    try {
      // Fetch all rooms without filters for client-side filtering
      const data = await roomsService.fetchRooms({});
      setAllRooms(data);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to fetch rooms';
      setError(message);
      console.error('Error fetching rooms:', err);
    } finally {
      setIsLoading(false);
    }
  }, [branchId]);

  // Apply filters client-side for instant responsiveness
  const rooms = useMemo(() => {
    let filtered = [...allRooms];
    
    const { statusFilter, floorFilter, roomTypeFilter, searchTerm } = filters;
    
    if (statusFilter && statusFilter !== 'all') {
      // Filter by the effective status the grid cards render, so the Reserved/Available
      // filters select exactly the rooms whose visible card matches the chosen status.
      filtered = filtered.filter(r => getRoomEffectiveStatus(r) === statusFilter);
    }
    if (floorFilter && floorFilter !== 'all') {
      filtered = filtered.filter(r => r.floor === floorFilter);
    }
    if (roomTypeFilter && roomTypeFilter !== 'all') {
      filtered = filtered.filter(r => r.roomType === roomTypeFilter);
    }
    if (searchTerm) {
      const term = searchTerm.toLowerCase();
      filtered = filtered.filter(r => 
        r.roomNumber.toLowerCase().includes(term) ||
        (r.currentGuestName && r.currentGuestName.toLowerCase().includes(term))
      );
    }
    
    return filtered;
  }, [allRooms, filters.statusFilter, filters.floorFilter, filters.roomTypeFilter, filters.searchTerm]);

  // Initial fetch and refetch on filter changes
  useEffect(() => {
    fetchRooms();
  }, [fetchRooms]);

  // Real-time subscription
  useEffect(() => {
    if (!enableRealtime || !branchId) return;

    roomsService.subscribeToUpdates((updatedRoom) => {
      setAllRooms((prev) => {
        const index = prev.findIndex((r) => r.id === updatedRoom.id);
        if (index >= 0) {
          const updated = [...prev];
          updated[index] = updatedRoom;
          return updated;
        }
        return prev;
      });
    });

    return () => {
      roomsService.unsubscribeFromUpdates();
    };
  }, [branchId, enableRealtime]);

  // Calculate stats from ALL rooms (not filtered)
  const stats = useMemo(() => {
    return roomsService.calculateStats(allRooms);
  }, [allRooms]);

  // Get unique floors from ALL rooms
  const floors = useMemo(() => {
    return roomsService.getUniqueFloors(allRooms);
  }, [allRooms]);

  // Update room status
  const updateStatus = useCallback(async (roomId: string, status: RoomStatus): Promise<Room | null> => {
    try {
      const updated = await roomsService.updateStatus(roomId, status);

      // An explicit manual status change is authoritative for display. Align the
      // server-computed effectiveStatus to the chosen status so the stats (which read
      // room.status) and the cards/modal summary (which read effectiveStatus || status)
      // agree immediately, instead of disagreeing until a refetch reconciles a lagging
      // effective_status. Returning this normalized room lets callers sync their own copy.
      const normalized: Room = { ...updated, status, effectiveStatus: status };

      // Update local state
      setAllRooms((prev) =>
        prev.map((r) => (r.id === roomId ? normalized : r))
      );

      const statusLabel = t(`roomsView.status.${status}`, { defaultValue: status });
      toast.success(
        t('roomsView.toasts.statusUpdated', {
          status: statusLabel,
          defaultValue: 'Room status updated to {{status}}',
        }),
      );
      return normalized;
    } catch (err) {
      toast.error(
        t('roomsView.toasts.statusUpdateFailed', { defaultValue: 'Failed to update room status' }),
      );
      return null;
    }
  }, [t]);

  return {
    rooms,
    allRooms,
    stats,
    floors,
    isLoading,
    error,
    refetch: fetchRooms,
    updateStatus,
    setFilters,
  };
}

export default useRooms;
