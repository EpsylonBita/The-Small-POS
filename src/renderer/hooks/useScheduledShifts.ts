/**
 * Hook for fetching scheduled shifts from admin dashboard
 * Syncs pre-planned shifts created in admin dashboard to POS
 */

import { useState, useEffect, useCallback } from 'react';
import type { ScheduledShift, GetScheduledShiftsParams } from '../types/shift';
import { getBridge, offEvent, onEvent } from '../../lib';

interface UseScheduledShiftsOptions {
  branchId: string;
  startDate?: Date;
  endDate?: Date;
  staffId?: string;
  autoRefresh?: boolean;
  refreshInterval?: number; // in milliseconds
}

interface UseScheduledShiftsResult {
  scheduledShifts: ScheduledShift[];
  loading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
}

/**
 * Fetches scheduled shifts from the admin dashboard's salon_staff_shifts table
 * These are pre-planned shifts that staff should follow
 */
export function useScheduledShifts(options: UseScheduledShiftsOptions): UseScheduledShiftsResult {
  const bridge = getBridge();
  const {
    branchId,
    startDate,
    endDate,
    staffId,
    autoRefresh = false,
    refreshInterval = 60000, // 1 minute default
  } = options;

  const [scheduledShifts, setScheduledShifts] = useState<ScheduledShift[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchScheduledShifts = useCallback(async () => {
    if (!branchId) {
      setScheduledShifts([]);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      // Calculate date range if not provided
      const start = startDate || new Date();
      const end = endDate || (() => {
        const d = new Date();
        d.setDate(d.getDate() + 7); // Default to 7 days ahead
        return d;
      })();

      const params: GetScheduledShiftsParams = {
        branchId,
        startDate: start.toISOString(),
        endDate: end.toISOString(),
        staffId,
      };

      const result: any = await bridge.shifts.getScheduledShifts(params);

      if (Array.isArray(result)) {
        setScheduledShifts(result);
      } else if (result?.error) {
        setError(result.error);
        setScheduledShifts([]);
      } else {
        setScheduledShifts([]);
      }
    } catch (err: any) {
      console.error('[useScheduledShifts] Error fetching scheduled shifts:', err);
      setError(err.message || 'Failed to fetch scheduled shifts');
      setScheduledShifts([]);
    } finally {
      setLoading(false);
    }
  }, [branchId, startDate, endDate, staffId, bridge.shifts]);

  // Initial fetch
  useEffect(() => {
    fetchScheduledShifts();
  }, [fetchScheduledShifts]);

  // Auto-refresh if enabled
  useEffect(() => {
    if (!autoRefresh || !branchId) return;

    let disposed = false;
    let pendingTimer: ReturnType<typeof setTimeout> | null = null;
    let lastRefreshAt = Date.now();

    const scheduleRefresh = (delayMs = 250) => {
      if (disposed || pendingTimer) return;
      pendingTimer = setTimeout(() => {
        pendingTimer = null;
        lastRefreshAt = Date.now();
        void fetchScheduledShifts();
      }, delayMs);
    };

    const handleSyncStatus = () => {
      const now = Date.now();
      if (now - lastRefreshAt < refreshInterval) {
        return;
      }
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
  }, [autoRefresh, refreshInterval, branchId, fetchScheduledShifts]);

  return {
    scheduledShifts,
    loading,
    error,
    refetch: fetchScheduledShifts,
  };
}

/**
 * Fetches today's scheduled shifts for a branch
 * Convenience hook for quick access to today's schedule
 */
export function useTodayScheduledShifts(branchId: string): UseScheduledShiftsResult {
  const bridge = getBridge();
  const [scheduledShifts, setScheduledShifts] = useState<ScheduledShift[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchTodayShifts = useCallback(async () => {
    if (!branchId) {
      setScheduledShifts([]);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const result: any = await bridge.shifts.getTodayScheduledShifts(branchId);

      if (Array.isArray(result)) {
        setScheduledShifts(result);
      } else if (result?.error) {
        setError(result.error);
        setScheduledShifts([]);
      } else {
        setScheduledShifts([]);
      }
    } catch (err: any) {
      console.error('[useTodayScheduledShifts] Error fetching today\'s shifts:', err);
      setError(err.message || 'Failed to fetch today\'s scheduled shifts');
      setScheduledShifts([]);
    } finally {
      setLoading(false);
    }
  }, [branchId, bridge.shifts]);

  useEffect(() => {
    fetchTodayShifts();
  }, [fetchTodayShifts]);

  return {
    scheduledShifts,
    loading,
    error,
    refetch: fetchTodayShifts,
  };
}

export default useScheduledShifts;
