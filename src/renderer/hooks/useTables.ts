/**
 * useTables Hook
 * 
 * Provides real-time table data with Supabase subscriptions.
 * Requirements: 1.6 - Update counts and lists on data changes within 2 seconds
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import type { RestaurantTable, TableAPIResponse, TableStatus } from '../types/tables';
import { transformTableFromAPI } from '../types/tables';
import { supabase } from '../lib/supabase';
import { reservationsService } from '../services/ReservationsService';

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

/**
 * Hook for managing restaurant tables with real-time sync
 */
export function useTables({ branchId, organizationId, enabled = true }: UseTablesOptions): UseTablesReturn {
  const [tables, setTables] = useState<RestaurantTable[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const subscriptionRef = useRef<(() => void) | null>(null);

  // Fetch tables from the database
  const fetchTables = useCallback(async () => {
    if (!branchId || !organizationId || !enabled) {
      setTables([]);
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      // Fetch directly from Supabase
      const { data, error: fetchError } = await (supabase as any)
        .from('restaurant_tables')
        .select('*')
        .eq('branch_id', branchId)
        .eq('organization_id', organizationId)
        .order('table_number', { ascending: true });

      if (fetchError) {
        console.error('Failed to fetch tables from Supabase:', fetchError);
        setError(new Error(fetchError.message));
        setTables([]);
      } else if (data && Array.isArray(data)) {
        const transformedTables = data.map((t: any) => transformTableFromAPI(t as TableAPIResponse));
        setTables(transformedTables);
      } else {
        setTables([]);
      }
    } catch (err) {
      console.error('Failed to fetch tables:', err);
      setError(err instanceof Error ? err : new Error('Failed to fetch tables'));
      setTables([]);
    } finally {
      setIsLoading(false);
    }
  }, [branchId, organizationId, enabled]);

  // Set up real-time subscription
  const setupRealtimeSubscription = useCallback(() => {
    if (!branchId || !organizationId || !enabled) return;

    // Clean up existing subscription
    if (subscriptionRef.current) {
      subscriptionRef.current();
      subscriptionRef.current = null;
    }

    try {
      // Subscribe directly to Supabase realtime
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
            console.log('📡 Table realtime event:', payload.eventType, payload.new);
            
            setTables(prevTables => {
              switch (payload.eventType) {
                case 'INSERT': {
                  const newTable = transformTableFromAPI(payload.new as TableAPIResponse);
                  // Check if table already exists
                  if (prevTables.some(t => t.id === newTable.id)) {
                    return prevTables;
                  }
                  return [...prevTables, newTable];
                }
                case 'UPDATE': {
                  const updatedTable = transformTableFromAPI(payload.new as TableAPIResponse);
                  return prevTables.map(t => 
                    t.id === updatedTable.id ? updatedTable : t
                  );
                }
                case 'DELETE': {
                  const deletedId = (payload.old as any)?.id;
                  return prevTables.filter(t => t.id !== deletedId);
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
      console.log('✅ Table realtime subscription set up via Supabase');
    } catch (err) {
      console.error('Failed to set up table subscription:', err);
    }
  }, [branchId, organizationId, enabled]);

  // Update table status
  const updateTableStatus = useCallback(async (tableId: string, status: TableStatus): Promise<boolean> => {
    try {
      // Optimistic update
      setTables(prevTables =>
        prevTables.map(t =>
          t.id === tableId
            ? { ...t, status, updatedAt: new Date().toISOString() }
            : t
        )
      );

      // Update directly in Supabase
      // Use type assertion since restaurant_tables may not be in generated types yet
      const { error: updateError } = await (supabase as any)
        .from('restaurant_tables')
        .update({ 
          status, 
          updated_at: new Date().toISOString() 
        })
        .eq('id', tableId);

      if (updateError) {
        console.error('Failed to update table status:', updateError);
        // Revert on failure
        await fetchTables();
        return false;
      }

      return true;
    } catch (err) {
      console.error('Failed to update table status:', err);
      // Revert on error
      await fetchTables();
      return false;
    }
  }, [fetchTables]);

  // Initial fetch and sync table statuses for today's reservations
  useEffect(() => {
    const initializeTables = async () => {
      await fetchTables();
      
      // Sync table statuses based on today's reservations
      if (branchId && organizationId) {
        reservationsService.setContext(branchId, organizationId);
        await reservationsService.syncTableStatusesForToday();
        // Refetch to get updated statuses
        await fetchTables();
      }
    };
    
    initializeTables();
  }, [fetchTables, branchId, organizationId]);

  // Set up realtime subscription
  useEffect(() => {
    setupRealtimeSubscription();

    return () => {
      if (subscriptionRef.current) {
        subscriptionRef.current();
        subscriptionRef.current = null;
      }
    };
  }, [setupRealtimeSubscription]);

  // Auto-refresh every 30 seconds as backup
  useEffect(() => {
    if (!enabled) return;

    const intervalId = setInterval(() => {
      console.log('🔄 Auto-refreshing tables...');
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
