/**
 * useRooms Hook
 * 
 * React hook for managing rooms in the POS system (Hotel Vertical).
 * Provides data fetching, mutations, and real-time updates.
 * 
 * Task 17.1: Create POS rooms interface
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import toast from 'react-hot-toast';
import {
  roomsService,
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
  stats: RoomStats;
  floors: number[];
  isLoading: boolean;
  error: string | null;

  // Actions
  refetch: () => Promise<void>;
  updateStatus: (roomId: string, status: RoomStatus) => Promise<boolean>;

  // Filters
  setFilters: (filters: RoomFilters) => void;
}

export function useRooms({
  branchId,
  organizationId,
  filters: externalFilters,
  enableRealtime = true,
}: UseRoomsProps): UseRoomsReturn {
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
      filtered = filtered.filter(r => r.status === statusFilter);
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
  const updateStatus = useCallback(async (roomId: string, status: RoomStatus): Promise<boolean> => {
    try {
      const updated = await roomsService.updateStatus(roomId, status);
      
      // Update local state
      setAllRooms((prev) =>
        prev.map((r) => (r.id === roomId ? updated : r))
      );
      
      toast.success(`Room status updated to ${status}`);
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to update status';
      toast.error(message);
      return false;
    }
  }, []);

  return {
    rooms,
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
