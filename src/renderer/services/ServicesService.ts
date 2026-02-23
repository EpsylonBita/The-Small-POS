/**
 * ServicesService - POS Services Service
 * 
 * Provides service catalog management functionality for the POS system (Salon Vertical).
 * In Tauri, uses admin dashboard API via main-process IPC (terminal-authenticated).
 * Falls back to direct Supabase only in non-Tauri browser contexts.
 * 
 * Follows the same pattern as AppointmentsService.
 */

import { supabase } from '../../shared/supabase';
import { getBridge, isBrowser } from '../../lib';

type IpcInvoke = (channel: string, ...args: any[]) => Promise<any>;

function getIpcInvoke(): IpcInvoke | null {
  if (isBrowser()) return null;
  const bridge = getBridge();
  return bridge.invoke.bind(bridge);
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

// Types
export interface Service {
  id: string;
  organizationId: string;
  branchId: string;
  categoryId: string | null;
  name: string;
  description: string | null;
  durationMinutes: number;
  price: number;
  isActive: boolean;
  staffIds: string[];
  createdAt: string;
  updatedAt: string;
  // Nested category
  category?: ServiceCategory | null;
}

export interface ServiceCategory {
  id: string;
  organizationId: string;
  branchId: string;
  name: string;
  description: string | null;
  sortOrder: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ServiceFilters {
  categoryFilter?: string | 'all';
  activeFilter?: boolean | 'all';
  searchTerm?: string;
}

export interface ServiceStats {
  totalServices: number;
  activeServices: number;
  avgPrice: number;
  avgDuration: number;
}

// Transform API response to domain model
function transformFromAPI(data: any): Service {
  return {
    id: data.id,
    organizationId: data.organization_id,
    branchId: data.branch_id,
    categoryId: data.category_id,
    name: data.name,
    description: data.description,
    durationMinutes: data.duration_minutes,
    price: parseFloat(data.price) || 0,
    isActive: data.is_active,
    staffIds: data.staff_ids || [],
    createdAt: data.created_at,
    updatedAt: data.updated_at,
    category: data.category ? transformCategoryFromAPI(data.category) : null,
  };
}

function transformCategoryFromAPI(data: any): ServiceCategory {
  return {
    id: data.id,
    organizationId: data.organization_id,
    branchId: data.branch_id,
    name: data.name,
    description: data.description,
    sortOrder: data.sort_order || 0,
    isActive: data.is_active,
    createdAt: data.created_at,
    updatedAt: data.updated_at,
  };
}

class ServicesService {
  private branchId: string = '';
  private organizationId: string = '';

  private buildServicesApiPath(filters?: ServiceFilters): string {
    const params = new URLSearchParams();

    if (filters?.categoryFilter && filters.categoryFilter !== 'all') {
      params.set('category_id', filters.categoryFilter);
    }
    if (filters?.activeFilter !== undefined && filters.activeFilter !== 'all') {
      params.set('is_active', String(filters.activeFilter));
    }
    if (filters?.searchTerm) {
      params.set('search', filters.searchTerm);
    }

    const query = params.toString();
    return `/api/pos/services${query ? `?${query}` : ''}`;
  }

  private applyServiceFilters(services: any[], filters?: ServiceFilters): any[] {
    const activeFilter: boolean | 'all' = filters?.activeFilter ?? true;

    const search = typeof filters?.searchTerm === 'string' ? filters.searchTerm.trim().toLowerCase() : '';

    return services
      .filter((service) => {
        // Mirror server behavior: include branch-specific records and org-wide records.
        const belongsToBranch = !service?.branch_id || service.branch_id === this.branchId;
        if (!belongsToBranch) return false;

        if (activeFilter !== 'all' && service?.is_active !== activeFilter) return false;

        if (filters?.categoryFilter && filters.categoryFilter !== 'all') {
          if (service?.category_id !== filters.categoryFilter) return false;
        }

        if (search) {
          const name = String(service?.name || '').toLowerCase();
          const description = String(service?.description || '').toLowerCase();
          if (!name.includes(search) && !description.includes(search)) return false;
        }

        return true;
      })
      .sort((a, b) => String(a?.name || '').localeCompare(String(b?.name || '')));
  }

  /**
   * Set the current branch and organization context
   */
  setContext(branchId: string, organizationId: string): void {
    this.branchId = branchId;
    this.organizationId = organizationId;
  }

  /**
   * Fetch services with optional filters
   */
  async fetchServices(filters?: ServiceFilters): Promise<Service[]> {
    if (!this.branchId) {
      console.warn('[ServicesService] branchId not set, skipping fetch');
      return [];
    }

    console.log('[ServicesService] Fetching services for branch:', this.branchId);

    try {
      const invoke = getIpcInvoke();
      if (invoke) {
        const path = this.buildServicesApiPath(filters);
        const result = await invoke('api:fetch-from-admin', path);

        if (result?.success && result?.data?.success !== false) {
          const apiServices = Array.isArray(result?.data?.services) ? result.data.services : [];
          return apiServices.map((service: any) => {
            const mapped = transformFromAPI(service);
            if (service?.category_name && !mapped.category) {
              mapped.category = {
                id: mapped.categoryId || '',
                organizationId: mapped.organizationId,
                branchId: mapped.branchId,
                name: service.category_name,
                description: null,
                sortOrder: 0,
                isActive: true,
                createdAt: mapped.createdAt,
                updatedAt: mapped.updatedAt,
              };
            }
            return mapped;
          });
        }

        console.warn(
          '[ServicesService] /api/pos/services failed, falling back to /api/pos/sync/services:',
          formatError(result?.error || result?.data?.error || result)
        );

        const fallback = await invoke('api:fetch-from-admin', '/api/pos/sync/services?limit=1000');
        if (!fallback?.success || fallback?.data?.success === false) {
          console.error(
            '[ServicesService] Fallback sync API error fetching services:',
            formatError(fallback?.error || fallback?.data?.error || fallback)
          );
          return [];
        }

        const syncRows = Array.isArray(fallback?.data?.data) ? fallback.data.data : [];
        const filteredRows = this.applyServiceFilters(syncRows, filters);
        return filteredRows.map((service: any) => {
          const mapped = transformFromAPI(service);
          if (service?.category_name && !mapped.category) {
            mapped.category = {
              id: mapped.categoryId || '',
              organizationId: mapped.organizationId,
              branchId: mapped.branchId,
              name: service.category_name,
              description: null,
              sortOrder: 0,
              isActive: true,
              createdAt: mapped.createdAt,
              updatedAt: mapped.updatedAt,
            };
          }
          return mapped;
        });
      }

      let query = supabase
        .from('services')
        .select(`
          *,
          category:category_id(id, name, description, sort_order, is_active, organization_id, branch_id, created_at, updated_at)
        `)
        .eq('branch_id', this.branchId)
        .order('name', { ascending: true });

      if (filters?.categoryFilter && filters.categoryFilter !== 'all') {
        query = query.eq('category_id', filters.categoryFilter);
      }
      if (filters?.activeFilter !== undefined && filters.activeFilter !== 'all') {
        query = query.eq('is_active', filters.activeFilter);
      }
      if (filters?.searchTerm) {
        query = query.or(
          `name.ilike.%${filters.searchTerm}%,description.ilike.%${filters.searchTerm}%`
        );
      }

      const { data, error } = await query;

      if (error) {
        console.error('[ServicesService] Error fetching services:', formatError(error));
        // Handle table not existing gracefully
        if (error.code === '42P01' || error.message?.includes('does not exist')) {
          console.warn('[ServicesService] services table does not exist');
          return [];
        }
        throw error;
      }

      return (data || []).map(transformFromAPI);
    } catch (error) {
      console.error('[ServicesService] Failed to fetch services:', formatError(error));
      return [];
    }
  }

  /**
   * Fetch service categories
   */
  async fetchCategories(): Promise<ServiceCategory[]> {
    if (!this.branchId) {
      console.warn('[ServicesService] branchId not set, skipping category fetch');
      return [];
    }

    try {
      const invoke = getIpcInvoke();
      if (invoke) {
        const result = await invoke('api:fetch-from-admin', '/api/pos/sync/service_categories?limit=500');
        if (!result?.success || result?.data?.success === false) {
          console.error(
            '[ServicesService] API error fetching categories:',
            formatError(result?.error || result?.data?.error || result)
          );
          return [];
        }

        const rows = Array.isArray(result?.data?.data) ? result.data.data : [];
        return rows
          .filter((row: any) => row?.is_active !== false)
          .sort((a: any, b: any) => Number(a?.sort_order || 0) - Number(b?.sort_order || 0))
          .map(transformCategoryFromAPI);
      }

      const { data, error } = await supabase
        .from('service_categories')
        .select('*')
        .eq('branch_id', this.branchId)
        .eq('is_active', true)
        .order('sort_order', { ascending: true });

      if (error) {
        if (error.code === '42P01' || error.message?.includes('does not exist')) {
          return [];
        }
        throw error;
      }

      return (data || []).map(transformCategoryFromAPI);
    } catch (error) {
      console.error('[ServicesService] Failed to fetch categories:', formatError(error));
      return [];
    }
  }

  /**
   * Calculate statistics from services
   */
  calculateStats(services: Service[]): ServiceStats {
    const activeServices = services.filter(s => s.isActive);
    const totalPrice = services.reduce((sum, s) => sum + s.price, 0);
    const totalDuration = services.reduce((sum, s) => sum + s.durationMinutes, 0);

    return {
      totalServices: services.length,
      activeServices: activeServices.length,
      avgPrice: services.length > 0 ? Math.round(totalPrice / services.length) : 0,
      avgDuration: services.length > 0 ? Math.round(totalDuration / services.length) : 0,
    };
  }

}

// Export singleton instance
export const servicesService = new ServicesService();

