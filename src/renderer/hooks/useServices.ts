/**
 * useServices Hook
 * 
 * React hook for managing services in the POS system (Salon Vertical).
 * Provides data fetching, filtering, and real-time updates.
 * 
 * Follows the same pattern as useAppointments.ts
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import toast from 'react-hot-toast';
import { offEvent, onEvent } from '../../lib';
import {
  servicesService,
  Service,
  ServiceCategory,
  ServiceFilters,
  ServiceStats,
} from '../services/ServicesService';

const EVENT_REFRESH_THROTTLE_MS = 5000;

interface UseServicesProps {
  branchId: string;
  organizationId: string;
  filters?: ServiceFilters;
  enableRealtime?: boolean;
}

interface UseServicesReturn {
  services: Service[];
  categories: ServiceCategory[];
  stats: ServiceStats;
  isLoading: boolean;
  error: string | null;
  filters: ServiceFilters;
  setFilters: (filters: ServiceFilters) => void;
  refetch: () => Promise<void>;
}

export function useServices({
  branchId,
  organizationId,
  filters: propFilters,
  enableRealtime = true,
}: UseServicesProps): UseServicesReturn {
  const [services, setServices] = useState<Service[]>([]);
  const [categories, setCategories] = useState<ServiceCategory[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState<ServiceFilters>(propFilters || {});

  // Sync filters when prop changes
  useEffect(() => {
    if (propFilters) {
      setFilters(propFilters);
    }
  }, [propFilters]);

  // Set context when branch/org changes
  useEffect(() => {
    if (branchId && organizationId) {
      servicesService.setContext(branchId, organizationId);
    }
  }, [branchId, organizationId]);

  // Fetch services
  const fetchData = useCallback(async (options: { silent?: boolean } = {}) => {
    const { silent = false } = options;
    if (!branchId || !organizationId) {
      console.log('[useServices] Missing branchId or organizationId, skipping fetch');
      setServices([]);
      setCategories([]);
      if (!silent) {
        setIsLoading(false);
      }
      return;
    }

    if (!silent) {
      setIsLoading(true);
      setError(null);
    }

    try {
      console.log('[useServices] Fetching data for branch:', branchId);
      
      // Fetch services and categories in parallel
      const [servicesData, categoriesData] = await Promise.all([
        servicesService.fetchServices(filters),
        servicesService.fetchCategories(),
      ]);

      console.log('[useServices] Fetched services:', servicesData.length);
      console.log('[useServices] Fetched categories:', categoriesData.length);

      const categoryById = new Map(categoriesData.map((category) => [category.id, category]));
      const normalizedServices = servicesData.map((service) => {
        if (service.category || !service.categoryId) return service;
        const category = categoryById.get(service.categoryId);
        return category ? { ...service, category } : service;
      });

      setServices(normalizedServices);
      setCategories(categoriesData);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load services';
      console.error('[useServices] Error:', message);
      if (!silent) {
        setError(message);
        toast.error(message);
      }
    } finally {
      if (!silent) {
        setIsLoading(false);
      }
    }
  }, [branchId, organizationId, filters]);

  // Initial fetch
  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Refresh from native sync/order events with throttling.
  useEffect(() => {
    if (!enableRealtime || !branchId) return;

    let disposed = false;
    let pendingTimer: ReturnType<typeof setTimeout> | null = null;
    let lastRefreshAt = 0;

    const scheduleRefresh = () => {
      if (disposed) return;
      const now = Date.now();
      const elapsed = now - lastRefreshAt;

      if (elapsed >= EVENT_REFRESH_THROTTLE_MS) {
        lastRefreshAt = now;
        void fetchData({ silent: true });
        return;
      }

      if (pendingTimer) return;
      pendingTimer = setTimeout(() => {
        pendingTimer = null;
        if (disposed) return;
        lastRefreshAt = Date.now();
        void fetchData({ silent: true });
      }, EVENT_REFRESH_THROTTLE_MS - elapsed);
    };

    const handleSyncStatus = (status?: { inProgress?: boolean }) => {
      if (status?.inProgress) return;
      scheduleRefresh();
    };
    const handleSyncComplete = () => scheduleRefresh();
    const handleOrderMutation = () => scheduleRefresh();

    onEvent('sync:status', handleSyncStatus);
    onEvent('sync:complete', handleSyncComplete);
    onEvent('order-created', handleOrderMutation);
    onEvent('order-status-updated', handleOrderMutation);
    onEvent('order-deleted', handleOrderMutation);

    return () => {
      disposed = true;
      if (pendingTimer) {
        clearTimeout(pendingTimer);
      }
      offEvent('sync:status', handleSyncStatus);
      offEvent('sync:complete', handleSyncComplete);
      offEvent('order-created', handleOrderMutation);
      offEvent('order-status-updated', handleOrderMutation);
      offEvent('order-deleted', handleOrderMutation);
    };
  }, [enableRealtime, branchId, fetchData]);

  // Calculate stats
  const stats = useMemo(() => {
    return servicesService.calculateStats(services);
  }, [services]);

  return {
    services,
    categories,
    stats,
    isLoading,
    error,
    filters,
    setFilters,
    refetch: fetchData,
  };
}

export default useServices;

