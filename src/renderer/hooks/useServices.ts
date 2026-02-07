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
import {
  servicesService,
  Service,
  ServiceCategory,
  ServiceFilters,
  ServiceStats,
} from '../services/ServicesService';

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
  const fetchData = useCallback(async () => {
    if (!branchId || !organizationId) {
      console.log('[useServices] Missing branchId or organizationId, skipping fetch');
      setServices([]);
      setCategories([]);
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    setError(null);

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
      setError(message);
      toast.error(message);
    } finally {
      setIsLoading(false);
    }
  }, [branchId, organizationId, filters]);

  // Initial fetch
  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Real-time updates
  useEffect(() => {
    if (!enableRealtime || !branchId) return;

    servicesService.subscribeToUpdates((updatedService) => {
      console.log('[useServices] Real-time update received:', updatedService.id);
      setServices((prev) => {
        const index = prev.findIndex((s) => s.id === updatedService.id);
        if (index >= 0) {
          const updated = [...prev];
          updated[index] = updatedService;
          return updated;
        }
        return [...prev, updatedService];
      });
    });

    return () => {
      servicesService.unsubscribeFromUpdates();
    };
  }, [enableRealtime, branchId]);

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

