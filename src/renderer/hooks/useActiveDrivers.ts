import { useState, useEffect, useCallback } from 'react';

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
      // Check if electronAPI is available (supports either getActiveDrivers or drivers:get-active)
      if (!window.electronAPI?.getActiveDrivers && !window.electronAPI?.driversGetActive) {
        console.warn('electronAPI.getActiveDrivers not available');
        setDrivers([]);
        setIsLoading(false);
        return;
      }

      const result = window.electronAPI.getActiveDrivers
        ? await window.electronAPI.getActiveDrivers(branchId)
        : await window.electronAPI.driversGetActive(branchId);

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
  }, [branchId]);

  // Fetch drivers when branchId changes
  useEffect(() => {
    fetchDrivers();
  }, [fetchDrivers]);

  // Auto-refresh functionality (optional)
  useEffect(() => {
    if (!autoRefresh || !branchId) {
      return;
    }

    // Refresh every 30 seconds
    const intervalId = setInterval(() => {
      fetchDrivers();
    }, 30000);

    // Cleanup interval on unmount
    return () => {
      clearInterval(intervalId);
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

