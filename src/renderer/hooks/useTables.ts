/**
 * useTables Hook
 *
 * Provides real-time table data with authenticated POS sync APIs in Electron
 * and Supabase fallback for non-Electron contexts.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import type { RestaurantTable, TableAPIResponse, TableStatus } from '../types/tables';
import { transformTableFromAPI } from '../types/tables';
import { supabase } from '../lib/supabase';
import { reservationsService } from '../services/ReservationsService';

type IpcInvoke = (channel: string, ...args: any[]) => Promise<any>;

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

function getIpcInvoke(): IpcInvoke | null {
  if (typeof window === 'undefined') return null;

  const w = window as any;
  if (typeof w?.electronAPI?.invoke === 'function') {
    return w.electronAPI.invoke.bind(w.electronAPI);
  }
  if (typeof w?.electronAPI?.ipcRenderer?.invoke === 'function') {
    return w.electronAPI.ipcRenderer.invoke.bind(w.electronAPI.ipcRenderer);
  }
  if (typeof w?.electron?.ipcRenderer?.invoke === 'function') {
    return w.electron.ipcRenderer.invoke.bind(w.electron.ipcRenderer);
  }
  return null;
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

/**
 * Hook for managing restaurant tables
 */
export function useTables({ branchId, organizationId, enabled = true }: UseTablesOptions): UseTablesReturn {
  const [tables, setTables] = useState<RestaurantTable[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const subscriptionRef = useRef<(() => void) | null>(null);

  const fetchTables = useCallback(async () => {
    if (!branchId || !organizationId || !enabled) {
      setTables([]);
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const invoke = getIpcInvoke();
      if (invoke) {
        const result = await invoke('sync:fetch-tables');
        if (!result?.success) {
          throw new Error(result?.error || 'Failed to fetch tables via sync IPC');
        }

        const tableRows = Array.isArray(result.tables) ? result.tables : [];
        const transformedTables = tableRows.map((t: any) => transformTableFromAPI(t as TableAPIResponse));
        setTables(transformedTables);
        return;
      }

      // Fallback for non-Electron contexts
      const { data, error: fetchError } = await (supabase as any)
        .from('restaurant_tables')
        .select('*')
        .eq('branch_id', branchId)
        .eq('organization_id', organizationId)
        .order('table_number', { ascending: true });

      if (fetchError) {
        throw new Error(fetchError.message);
      }

      const transformedTables = Array.isArray(data)
        ? data.map((t: any) => transformTableFromAPI(t as TableAPIResponse))
        : [];
      setTables(transformedTables);
    } catch (err) {
      console.error('[useTables] Failed to fetch tables:', formatError(err));
      setError(err instanceof Error ? err : new Error('Failed to fetch tables'));
      setTables([]);
    } finally {
      setIsLoading(false);
    }
  }, [branchId, organizationId, enabled]);

  const setupRealtimeSubscription = useCallback(() => {
    if (!branchId || !organizationId || !enabled) return;

    if (subscriptionRef.current) {
      subscriptionRef.current();
      subscriptionRef.current = null;
    }

    // In Electron, realtime updates are coordinated by main-process sync and polling.
    if (getIpcInvoke()) {
      return;
    }

    try {
      const channel = supabase
        .channel(`tables-${branchId}`)
        .on(
          'postgres_changes',
          {
            event: '*',
            schema: 'public',
            table: 'restaurant_tables',
            filter: `branch_id=eq.${branchId}`,
          },
          (payload) => {
            console.log('[useTables] Table realtime event:', payload.eventType);

            setTables((prevTables) => {
              switch (payload.eventType) {
                case 'INSERT': {
                  const newTable = transformTableFromAPI(payload.new as TableAPIResponse);
                  if (prevTables.some((t) => t.id === newTable.id)) {
                    return prevTables;
                  }
                  return [...prevTables, newTable];
                }
                case 'UPDATE': {
                  const updatedTable = transformTableFromAPI(payload.new as TableAPIResponse);
                  return prevTables.map((t) => (t.id === updatedTable.id ? updatedTable : t));
                }
                case 'DELETE': {
                  const deletedId = (payload.old as any)?.id;
                  return prevTables.filter((t) => t.id !== deletedId);
                }
                default:
                  return prevTables;
              }
            });
          }
        )
        .subscribe();

      subscriptionRef.current = () => {
        supabase.removeChannel(channel);
      };
      console.log('[useTables] Table realtime subscription set up via Supabase');
    } catch (err) {
      console.error('[useTables] Failed to set up table subscription:', formatError(err));
    }
  }, [branchId, organizationId, enabled]);

  const updateTableStatus = useCallback(async (tableId: string, status: TableStatus): Promise<boolean> => {
    try {
      setTables((prevTables) =>
        prevTables.map((t) =>
          t.id === tableId
            ? { ...t, status, updatedAt: new Date().toISOString() }
            : t
        )
      );

      const invoke = getIpcInvoke();
      if (invoke) {
        const result = await invoke('api:fetch-from-admin', `/api/pos/tables/${tableId}`, {
          method: 'PATCH',
          body: { status },
        });

        if (!result?.success || result?.data?.success === false) {
          throw new Error(result?.error || result?.data?.error || 'Failed to update table status via API');
        }

        return true;
      }

      // Fallback for non-Electron contexts
      const { error: updateError } = await (supabase as any)
        .from('restaurant_tables')
        .update({
          status,
          updated_at: new Date().toISOString(),
        })
        .eq('id', tableId);

      if (updateError) {
        throw updateError;
      }

      return true;
    } catch (err) {
      console.error('[useTables] Failed to update table status:', formatError(err));
      await fetchTables();
      return false;
    }
  }, [fetchTables]);

  useEffect(() => {
    const initializeTables = async () => {
      await fetchTables();

      if (branchId && organizationId) {
        reservationsService.setContext(branchId, organizationId);
        await reservationsService.syncTableStatusesForToday();
        await fetchTables();
      }
    };

    initializeTables();
  }, [fetchTables, branchId, organizationId]);

  useEffect(() => {
    setupRealtimeSubscription();

    return () => {
      if (subscriptionRef.current) {
        subscriptionRef.current();
        subscriptionRef.current = null;
      }
    };
  }, [setupRealtimeSubscription]);

  useEffect(() => {
    if (!enabled) return;

    const intervalId = setInterval(() => {
      console.log('[useTables] Auto-refreshing tables');
      fetchTables();
    }, 30000);

    return () => clearInterval(intervalId);
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
