import { useState, useEffect, useCallback } from 'react';
import { getBridge, offEvent, onEvent } from '../../lib';

interface ActiveDriver {
  id: string;
  shiftId: string;
  status: 'available' | 'busy';
  checkInTime: string;
}

interface UseActiveDriversReturn {
  drivers: ActiveDriver[];
  isLoading: boolean;
  error: string | null;
  refreshDrivers: () => Promise<void>;
}
const DRIVER_REFRESH_MIN_MS = 30000;

/**
 * Custom hook for fetching active drivers in a branch
 * 
 * Fetches the list of active drivers for a given branch and provides auto-refresh capability.
 * Optionally auto-refreshes every 30 seconds to keep driver availability status up-to-date.
 * 
 * @param {string} branchId - The ID of the branch to fetch drivers for
 * @param {boolean} autoRefresh - Whether to auto-refresh drivers every 30 seconds (default: false)
 * @returns {UseActiveDriversReturn} Object containing drivers array, loading state, error state, and refresh function
 * 
 * @example
 * ```tsx
 * const { drivers, isLoading, error, refreshDrivers } = useActiveDrivers(branchId);
 * 
 * if (isLoading) return <div>Loading drivers...</div>;
 * if (error) return <div>Error: {error}</div>;
 * 
 * return (
 *   <select>
 *     {drivers.map(driver => (
 *       <option key={driver.id} value={driver.id}>
 *         Driver {driver.id} - {driver.status}
 *       </option>
 *     ))}
 *   </select>
 * );
 * ```
 */
export function useActiveDrivers(
  branchId: string,
  autoRefresh: boolean = false
): UseActiveDriversReturn {
  const bridge = getBridge();
  const [drivers, setDrivers] = useState<ActiveDriver[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const fetchDrivers = useCallback(async () => {
    if (!branchId) {
      setDrivers([]);
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const result = await bridge.drivers.getActive(branchId);

      // Normalize response: accept array or { success, data, error }
      let list: any[] = [];
      if (Array.isArray(result)) {
        list = result;
      } else if (result && typeof result === 'object') {
        const r: any = result as any;
        if (Array.isArray(r.data)) {
          list = r.data;
        }
        if (r.success === false && r.error) {
          setError(String(r.error));
        }
      }

      if (!Array.isArray(list)) {
        console.warn('Invalid drivers data received, using empty array');
        list = [];
      }
      setDrivers(list as ActiveDriver[]);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to fetch active drivers';
      console.error('Error fetching active drivers:', err);
      setError(errorMessage);
      // Return empty array on error
      setDrivers([]);
    } finally {
      setIsLoading(false);
    }
  }, [branchId, bridge.drivers]);

  // Fetch drivers when branchId changes
  useEffect(() => {
    fetchDrivers();
  }, [fetchDrivers]);

  // Auto-refresh functionality (optional)
  useEffect(() => {
    if (!autoRefresh || !branchId) {
      return;
    }

    let disposed = false;
    let pendingTimer: ReturnType<typeof setTimeout> | null = null;
    let lastSyncRefreshAt = Date.now();

    const scheduleRefresh = (delayMs = 250) => {
      if (disposed || pendingTimer) return;
      pendingTimer = setTimeout(() => {
        pendingTimer = null;
        void fetchDrivers();
      }, delayMs);
    };

    const handleSyncStatus = () => {
      const now = Date.now();
      if (now - lastSyncRefreshAt < DRIVER_REFRESH_MIN_MS) {
        return;
      }
      lastSyncRefreshAt = now;
      scheduleRefresh(300);
    };

    const handleShiftUpdated = () => {
      scheduleRefresh(150);
    };

    onEvent('sync:status', handleSyncStatus);
    onEvent('sync:complete', handleShiftUpdated);
    onEvent('shift-updated', handleShiftUpdated);

    return () => {
      disposed = true;
      if (pendingTimer) clearTimeout(pendingTimer);
      offEvent('sync:status', handleSyncStatus);
      offEvent('sync:complete', handleShiftUpdated);
      offEvent('shift-updated', handleShiftUpdated);
    };
  }, [autoRefresh, branchId, fetchDrivers]);

  const refreshDrivers = async () => {
    await fetchDrivers();
  };

  return {
    drivers,
    isLoading,
    error,
    refreshDrivers
  };
}

