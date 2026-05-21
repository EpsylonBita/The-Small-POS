/**
 * useTables Hook
 *
 * Provides table data through terminal-authenticated POS routes only.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import type { RestaurantTable, TableAPIResponse, TableStatus } from '../types/tables';
import { transformTableFromAPI } from '../types/tables';
import { reservationsService } from '../services/ReservationsService';
import { getBridge, isBrowser, offEvent, onEvent } from '../../lib';
import { posApiGet, posApiPatch } from '../utils/api-helpers';
import { buildOptimisticOccupiedTable } from '../utils/tableOrderFlow';

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
  updateTableStatus: (
    tableId: string,
    status: TableStatus,
    workflow?: Record<string, unknown>,
  ) => Promise<boolean>;
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
  const optimisticTableOverridesRef = useRef<Record<string, Partial<RestaurantTable>>>({});
  const bridge = getBridge();

  const mergeOptimisticTableOverrides = useCallback((nextTables: RestaurantTable[]) => {
    const overrides = optimisticTableOverridesRef.current;
    return nextTables.map((table) => {
      const override = overrides[table.id];
      if (!override) {
        return table;
      }

      return {
        ...table,
        ...override,
        currentOrderId: table.currentOrderId || override.currentOrderId,
        tableSessionId: table.tableSessionId || override.tableSessionId || null,
        guestCount: table.guestCount ?? override.guestCount ?? null,
        currentWaiterId: table.currentWaiterId || override.currentWaiterId || null,
        currentWaiterName: table.currentWaiterName || override.currentWaiterName || null,
        occupiedSince: table.occupiedSince || override.occupiedSince,
        floorLevel: table.floorLevel ?? override.floorLevel ?? null,
        section: table.section ?? override.section ?? null,
        balance: table.balance || override.balance || null,
        unpaidBalance: table.unpaidBalance || override.unpaidBalance || 0,
      };
    });
  }, []);

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
      setTables(mergeOptimisticTableOverrides(tableRows.map((row) => transformTableFromAPI(row))));
    } catch (err) {
      console.error('[useTables] Failed to fetch tables:', formatError(err));
      setError(err instanceof Error ? err : new Error('Failed to fetch tables'));
      setTables([]);
    } finally {
      setIsLoading(false);
    }
  }, [branchId, organizationId, enabled, bridge, mergeOptimisticTableOverrides]);

  const updateTableStatus = useCallback(
    async (
      tableId: string,
      status: TableStatus,
      workflow: Record<string, unknown> = {},
    ): Promise<boolean> => {
      const nextUpdatedAt = new Date().toISOString();
      if (status === 'occupied') {
        optimisticTableOverridesRef.current[tableId] = {
          status,
          updatedAt: nextUpdatedAt,
          currentOrderId: typeof workflow.current_order_id === 'string'
            ? workflow.current_order_id
            : optimisticTableOverridesRef.current[tableId]?.currentOrderId,
          tableSessionId: typeof workflow.table_session_id === 'string'
            ? workflow.table_session_id
            : optimisticTableOverridesRef.current[tableId]?.tableSessionId || null,
          guestCount: typeof workflow.guest_count === 'number'
            ? workflow.guest_count
            : optimisticTableOverridesRef.current[tableId]?.guestCount ?? null,
          occupiedSince: typeof workflow.occupied_since === 'string'
            ? workflow.occupied_since
            : optimisticTableOverridesRef.current[tableId]?.occupiedSince || nextUpdatedAt,
          currentWaiterId: typeof workflow.current_waiter_id === 'string'
            ? workflow.current_waiter_id
            : optimisticTableOverridesRef.current[tableId]?.currentWaiterId || null,
          currentWaiterName: typeof workflow.current_waiter_name === 'string'
            ? workflow.current_waiter_name
            : optimisticTableOverridesRef.current[tableId]?.currentWaiterName || null,
        };
      } else {
        delete optimisticTableOverridesRef.current[tableId];
      }

      try {
        setTables((prevTables) =>
          prevTables.map((table) =>
            table.id === tableId
              ? status === 'occupied'
                ? {
                    ...buildOptimisticOccupiedTable(table, {
                      orderId: typeof workflow.current_order_id === 'string'
                        ? workflow.current_order_id
                        : table.currentOrderId,
                      tableSessionId: typeof workflow.table_session_id === 'string'
                        ? workflow.table_session_id
                        : table.tableSessionId,
                      guestCount: workflow.guest_count ?? table.guestCount ?? 1,
                      occupiedSince: typeof workflow.occupied_since === 'string'
                        ? workflow.occupied_since
                        : table.occupiedSince ?? new Date().toISOString(),
                    }),
                    updatedAt: nextUpdatedAt,
                    currentWaiterId: typeof workflow.current_waiter_id === 'string'
                      ? workflow.current_waiter_id
                      : table.currentWaiterId,
                    currentWaiterName: typeof workflow.current_waiter_name === 'string'
                      ? workflow.current_waiter_name
                      : table.currentWaiterName,
                  }
                : {
                    ...table,
                    status,
                    updatedAt: nextUpdatedAt,
                    currentOrderId: typeof workflow.current_order_id === 'string'
                      ? workflow.current_order_id
                      : table.currentOrderId,
                    tableSessionId: typeof workflow.table_session_id === 'string'
                      ? workflow.table_session_id
                      : table.tableSessionId,
                    guestCount: typeof workflow.guest_count === 'number'
                      ? workflow.guest_count
                      : table.guestCount,
                    currentWaiterId: typeof workflow.current_waiter_id === 'string'
                      ? workflow.current_waiter_id
                      : table.currentWaiterId,
                    currentWaiterName: typeof workflow.current_waiter_name === 'string'
                      ? workflow.current_waiter_name
                      : table.currentWaiterName,
                  }
              : table,
          ),
        );

        const result = isBrowser()
          ? await posApiPatch<{ success?: boolean; error?: string }>(
              `/api/pos/tables/${tableId}`,
              { status, ...workflow },
            )
          : await bridge.tables.updateStatus(tableId, status, workflow);

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
        if (status === 'occupied') {
          setError(err instanceof Error ? err : new Error('Failed to update table status'));
          return false;
        }
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
