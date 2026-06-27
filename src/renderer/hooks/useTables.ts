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
import {
  buildOptimisticOccupiedTable,
  buildReleasedTableAfterSettlement,
  shouldApplyOptimisticTableOverride,
} from '../utils/tableOrderFlow';

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
      if (!shouldApplyOptimisticTableOverride(table, override)) {
        delete overrides[table.id];
        return table;
      }

      // Release override: the table was cleared after a final payment. Apply the
      // released projection wholesale so a stale read-after-write refetch can't
      // resurrect the occupied/unpaid state before the server reflects the close.
      if ((override as Record<string, unknown>).__released === true) {
        return buildReleasedTableAfterSettlement(
          table,
          override.status === 'cleaning' ? 'cleaning' : 'available',
        );
      }

      const tableOrderTotal = Number(table.balance?.order_total || 0);
      const overrideOrderTotal = Number(override.balance?.order_total || 0);
      const forceBalanceOverride = (override as Record<string, unknown>).__forceBalanceOverride === true;
      const balance =
        forceBalanceOverride
          ? override.balance || table.balance || null
          : tableOrderTotal > 0 || overrideOrderTotal <= 0
          ? table.balance || override.balance || null
          : override.balance || table.balance || null;
      const unpaidBalance =
        forceBalanceOverride
          ? override.unpaidBalance ?? table.unpaidBalance ?? 0
          : tableOrderTotal > 0 || overrideOrderTotal <= 0
          ? table.unpaidBalance ?? override.unpaidBalance ?? 0
          : override.unpaidBalance ?? table.unpaidBalance ?? 0;

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
        balance,
        unpaidBalance,
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
      // Release request: an explicit, durable "release this table" (e.g. recovering
      // a stale reserved table, or releasing after no-show/cancel). It stores a
      // __released override so the optimistic clear survives an immediate stale
      // refetch that still reports the prior status, instead of being deleted.
      const releaseRequested =
        workflow.__release === true && (status === 'available' || status === 'cleaning');
      const workflowForServer: Record<string, unknown> = { ...workflow };
      delete workflowForServer.__release;

      if (status === 'occupied') {
        const occupiedProjection = buildOptimisticOccupiedTable({}, {
          orderId: typeof workflow.current_order_id === 'string'
            ? workflow.current_order_id
            : optimisticTableOverridesRef.current[tableId]?.currentOrderId,
          tableSessionId: typeof workflow.table_session_id === 'string'
            ? workflow.table_session_id
            : optimisticTableOverridesRef.current[tableId]?.tableSessionId || null,
          guestCount: workflow.guest_count ?? optimisticTableOverridesRef.current[tableId]?.guestCount ?? null,
          occupiedSince: typeof workflow.occupied_since === 'string'
            ? workflow.occupied_since
            : optimisticTableOverridesRef.current[tableId]?.occupiedSince || nextUpdatedAt,
          orderTotal: workflow.order_total ?? workflow.orderTotal,
          paidTotal: workflow.paid_total ?? workflow.paidTotal,
          tipTotal: workflow.tip_total ?? workflow.tipTotal,
        });
        optimisticTableOverridesRef.current[tableId] = {
          ...occupiedProjection,
          updatedAt: nextUpdatedAt,
          currentWaiterId: typeof workflow.current_waiter_id === 'string'
            ? workflow.current_waiter_id
            : optimisticTableOverridesRef.current[tableId]?.currentWaiterId || null,
          currentWaiterName: typeof workflow.current_waiter_name === 'string'
            ? workflow.current_waiter_name
            : optimisticTableOverridesRef.current[tableId]?.currentWaiterName || null,
        };
      } else if (releaseRequested) {
        // Durable release override: survives the immediate (possibly stale) refetch
        // that still reports the prior reserved/occupied status, until the server
        // reflects the released status. mergeOptimisticTableOverrides drops it then.
        optimisticTableOverridesRef.current[tableId] = {
          status,
          currentOrderId: undefined,
          tableSessionId: null,
          guestCount: null,
          occupiedSince: undefined,
          unpaidBalance: 0,
          balance: null,
          __released: true,
        } as Partial<RestaurantTable> & { __released: true };
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
                      orderTotal: workflow.order_total ?? workflow.orderTotal,
                      paidTotal: workflow.paid_total ?? workflow.paidTotal,
                      tipTotal: workflow.tip_total ?? workflow.tipTotal,
                    }),
                    updatedAt: nextUpdatedAt,
                    currentWaiterId: typeof workflow.current_waiter_id === 'string'
                      ? workflow.current_waiter_id
                      : table.currentWaiterId,
                    currentWaiterName: typeof workflow.current_waiter_name === 'string'
                      ? workflow.current_waiter_name
                      : table.currentWaiterName,
                  }
                : releaseRequested
                ? buildReleasedTableAfterSettlement(
                    table,
                    status === 'cleaning' ? 'cleaning' : 'available',
                  )
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
              { status, ...workflowForServer },
            )
          : await bridge.tables.updateStatus(tableId, status, workflowForServer);

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
        // The release failed: drop the optimistic release override so the next
        // fetch reflects the true (still reserved/occupied) server state instead
        // of a phantom "released" projection.
        if (releaseRequested) {
          delete optimisticTableOverridesRef.current[tableId];
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

    const handleTableSessionSettled = (payload: {
      tableId?: string | null;
      releaseStatus?: string | null;
    }) => {
      const tableId = typeof payload?.tableId === 'string' ? payload.tableId.trim() : '';
      const releaseStatus = payload?.releaseStatus === 'cleaning' ? 'cleaning' : 'available';
      if (!tableId) {
        scheduleRefresh(150);
        return;
      }
      // Store a release override so the optimistic clear survives the immediate
      // (possibly stale) refetch the close flow fires, until the server reflects
      // the released table. mergeOptimisticTableOverrides drops it once that lands.
      optimisticTableOverridesRef.current[tableId] = {
        status: releaseStatus,
        currentOrderId: undefined,
        tableSessionId: null,
        guestCount: null,
        occupiedSince: undefined,
        unpaidBalance: 0,
        balance: null,
        __released: true,
      } as Partial<RestaurantTable> & { __released: true };
      setTables((prevTables) =>
        prevTables.map((table) =>
          table.id === tableId ? buildReleasedTableAfterSettlement(table, releaseStatus) : table,
        ),
      );
      scheduleRefresh(150);
    };

    const handleTableSessionBalanceUpdated = (payload: {
      tableId?: string | null;
      orderId?: string | null;
      tableSessionId?: string | null;
      guestCount?: unknown;
      occupiedSince?: string | null;
      orderTotal?: unknown;
      paidTotal?: unknown;
      tipTotal?: unknown;
    }) => {
      const tableId = typeof payload?.tableId === 'string' ? payload.tableId.trim() : '';
      if (!tableId) {
        scheduleRefresh(150);
        return;
      }

      const projection = {
        ...buildOptimisticOccupiedTable({}, {
          orderId: payload.orderId,
          tableSessionId: payload.tableSessionId,
          guestCount: payload.guestCount,
          occupiedSince: payload.occupiedSince || new Date().toISOString(),
          orderTotal: payload.orderTotal,
          paidTotal: payload.paidTotal,
          tipTotal: payload.tipTotal,
        }),
        __forceBalanceOverride: true,
        updatedAt: new Date().toISOString(),
      } as Partial<RestaurantTable> & { __forceBalanceOverride: true; updatedAt: string };

      optimisticTableOverridesRef.current[tableId] = {
        ...optimisticTableOverridesRef.current[tableId],
        ...projection,
      };
      setTables((prevTables) =>
        prevTables.map((table) =>
          table.id === tableId
            ? {
                ...table,
                ...projection,
                currentOrderId: projection.currentOrderId || table.currentOrderId,
                tableSessionId: projection.tableSessionId || table.tableSessionId || null,
                guestCount: projection.guestCount ?? table.guestCount ?? null,
                occupiedSince: projection.occupiedSince || table.occupiedSince,
              }
            : table,
        ),
      );
      scheduleRefresh(150);
    };

    onEvent('sync:status', handleSyncStatus);
    onEvent('sync:complete', handleOrderMutation);
    onEvent('order-created', handleOrderMutation);
    onEvent('order-status-updated', handleOrderMutation);
    onEvent('order-deleted', handleOrderMutation);
    onEvent('table-session-settled', handleTableSessionSettled);
    onEvent('table-session-balance-updated', handleTableSessionBalanceUpdated);

    return () => {
      disposed = true;
      if (pendingTimer) clearTimeout(pendingTimer);
      offEvent('sync:status', handleSyncStatus);
      offEvent('sync:complete', handleOrderMutation);
      offEvent('order-created', handleOrderMutation);
      offEvent('order-status-updated', handleOrderMutation);
      offEvent('order-deleted', handleOrderMutation);
      offEvent('table-session-settled', handleTableSessionSettled);
      offEvent('table-session-balance-updated', handleTableSessionBalanceUpdated);
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
