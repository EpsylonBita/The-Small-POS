/**
 * useTables Hook
 *
 * Provides table data through terminal-authenticated POS routes only.
 */

import { useState, useEffect, useCallback } from 'react';
import type { RestaurantTable, TableAPIResponse, TableStatus } from '../types/tables';
import { transformTableFromAPI } from '../types/tables';
import { reservationsService } from '../services/ReservationsService';
import { getBridge, isBrowser, offEvent, onEvent } from '../../lib';
import { posApiGet, posApiPatch } from '../utils/api-helpers';

const TABLE_REFRESH_MIN_MS = 30000;

interface UseTablesOptions {
  branchId: string;
  organizationId: string;
  enabled?: boolean;
}

interface UseTablesReturn {
  tables: RestaurantTable[];
  isLoading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
  updateTableStatus: (tableId: string, status: TableStatus) => Promise<boolean>;
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export function useTables({
  branchId,
  organizationId,
  enabled = true,
}: UseTablesOptions): UseTablesReturn {
  const [tables, setTables] = useState<RestaurantTable[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const bridge = getBridge();

  const fetchTables = useCallback(async () => {
    if (!branchId || !organizationId || !enabled) {
      setTables([]);
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const result = isBrowser()
        ? await posApiGet<{ success?: boolean; tables?: TableAPIResponse[] }>('/api/pos/tables')
        : await bridge.tables.list();

      if (!result.success) {
        throw new Error(result.error || 'Failed to fetch tables');
      }

      const payload = (result.data ?? {}) as {
        success?: boolean;
        tables?: TableAPIResponse[];
        error?: string;
      };

      if (payload.success === false) {
        throw new Error(payload.error || 'Failed to fetch tables');
      }

      const tableRows = Array.isArray(payload.tables) ? payload.tables : [];
      setTables(tableRows.map((row) => transformTableFromAPI(row)));
    } catch (err) {
      console.error('[useTables] Failed to fetch tables:', formatError(err));
      setError(err instanceof Error ? err : new Error('Failed to fetch tables'));
      setTables([]);
    } finally {
      setIsLoading(false);
    }
  }, [branchId, organizationId, enabled, bridge]);

  const updateTableStatus = useCallback(
    async (tableId: string, status: TableStatus): Promise<boolean> => {
      try {
        setTables((prevTables) =>
          prevTables.map((table) =>
            table.id === tableId
              ? { ...table, status, updatedAt: new Date().toISOString() }
              : table,
          ),
        );

        const result = isBrowser()
          ? await posApiPatch<{ success?: boolean; error?: string }>(
              `/api/pos/tables/${tableId}`,
              { status },
            )
          : await bridge.tables.updateStatus(tableId, status);

        if (!result.success) {
          throw new Error(result.error || 'Failed to update table status');
        }

        const payload = (result.data ?? {}) as { success?: boolean; error?: string };
        if (payload.success === false) {
          throw new Error(payload.error || 'Failed to update table status');
        }

        return true;
      } catch (err) {
        console.error('[useTables] Failed to update table status:', formatError(err));
        await fetchTables();
        return false;
      }
    },
    [fetchTables, bridge],
  );

  useEffect(() => {
    const initializeTables = async () => {
      await fetchTables();

      if (branchId && organizationId) {
        reservationsService.setContext(branchId, organizationId);
        await reservationsService.syncTableStatusesForToday();
        await fetchTables();
      }
    };

    void initializeTables();
  }, [fetchTables, branchId, organizationId]);

  useEffect(() => {
    if (!enabled) return;

    let disposed = false;
    let pendingTimer: ReturnType<typeof setTimeout> | null = null;
    let lastSyncRefreshAt = Date.now();

    const scheduleRefresh = (delayMs = 250) => {
      if (disposed || pendingTimer) return;
      pendingTimer = setTimeout(() => {
        pendingTimer = null;
        void fetchTables();
      }, delayMs);
    };

    const handleSyncStatus = () => {
      const now = Date.now();
      if (now - lastSyncRefreshAt < TABLE_REFRESH_MIN_MS) {
        return;
      }
      lastSyncRefreshAt = now;
      scheduleRefresh(300);
    };

    const handleOrderMutation = () => {
      scheduleRefresh(150);
    };

    onEvent('sync:status', handleSyncStatus);
    onEvent('sync:complete', handleOrderMutation);
    onEvent('order-created', handleOrderMutation);
    onEvent('order-status-updated', handleOrderMutation);
    onEvent('order-deleted', handleOrderMutation);

    return () => {
      disposed = true;
      if (pendingTimer) clearTimeout(pendingTimer);
      offEvent('sync:status', handleSyncStatus);
      offEvent('sync:complete', handleOrderMutation);
      offEvent('order-created', handleOrderMutation);
      offEvent('order-status-updated', handleOrderMutation);
      offEvent('order-deleted', handleOrderMutation);
    };
  }, [fetchTables, enabled]);

  return {
    tables,
    isLoading,
    error,
    refetch: fetchTables,
    updateTableStatus,
  };
}

export default useTables;
