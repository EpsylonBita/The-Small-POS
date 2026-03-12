/**
 * ServicesService - POS Services Service
 *
 * Provides service catalog management functionality for the POS system (Salon Vertical).
 * Uses authenticated POS routes only.
 */

import { getBridge, isBrowser } from '../../lib';
import { posApiGet } from '../utils/api-helpers';

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
  category?: ServiceCategory | null;
}

export interface ServiceCategory {
  id: string;
  organizationId: string;
  branchId: string | null;
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
    branchId: data.branch_id ?? null,
    name: data.name,
    description: data.description,
    sortOrder: data.sort_order || 0,
    isActive: data.is_active ?? true,
    createdAt: data.created_at,
    updatedAt: data.updated_at,
  };
}

class ServicesService {
  private bridge = getBridge();
  private branchId = '';
  private organizationId = '';

  setContext(branchId: string, organizationId: string): void {
    this.branchId = branchId;
    this.organizationId = organizationId;
  }

  async fetchServices(filters?: ServiceFilters): Promise<Service[]> {
    if (!this.branchId) {
      console.warn('[ServicesService] branchId not set, skipping fetch');
      return [];
    }

    try {
      const params: Record<string, string | boolean> = {};
      if (filters?.categoryFilter && filters.categoryFilter !== 'all') {
        params.category_id = filters.categoryFilter;
      }
      if (filters?.activeFilter !== undefined && filters.activeFilter !== 'all') {
        params.is_active = filters.activeFilter;
      }
      if (filters?.searchTerm) {
        params.search = filters.searchTerm;
      }

      const query = new URLSearchParams(
        Object.entries(params).map(([key, value]) => [key, String(value)]),
      ).toString();

      const result = isBrowser()
        ? await posApiGet<{ success?: boolean; services?: any[] }>(
            `/api/pos/services${query ? `?${query}` : ''}`,
          )
        : await this.bridge.services.list(params);

      if (!result.success) {
        console.error('[ServicesService] API error:', result.error);
        return [];
      }

      const payload = (result.data ?? {}) as { success?: boolean; services?: any[] };
      if (payload.success === false) {
        return [];
      }

      return (Array.isArray(payload.services) ? payload.services : []).map((service: any) => {
        const mapped = transformFromAPI(service);
        if (service?.category_name && !mapped.category) {
          mapped.category = {
            id: mapped.categoryId || '',
            organizationId: mapped.organizationId,
            branchId: mapped.branchId || null,
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
    } catch (error) {
      console.error('[ServicesService] Failed to fetch services:', error);
      return [];
    }
  }

  async fetchCategories(): Promise<ServiceCategory[]> {
    if (!this.branchId) {
      console.warn('[ServicesService] branchId not set, skipping category fetch');
      return [];
    }

    try {
      const result = isBrowser()
        ? await posApiGet<{ success?: boolean; categories?: any[] }>(
            '/api/pos/service-categories?is_active=true',
          )
        : await this.bridge.services.categories({ is_active: true });

      if (!result.success) {
        console.error('[ServicesService] API error fetching categories:', result.error);
        return [];
      }

      const payload = (result.data ?? {}) as { success?: boolean; categories?: any[] };
      if (payload.success === false) {
        return [];
      }

      return (Array.isArray(payload.categories) ? payload.categories : [])
        .filter((row: any) => row?.is_active !== false)
        .sort((a: any, b: any) => Number(a?.sort_order || 0) - Number(b?.sort_order || 0))
        .map(transformCategoryFromAPI);
    } catch (error) {
      console.error('[ServicesService] Failed to fetch categories:', error);
      return [];
    }
  }

  calculateStats(services: Service[]): ServiceStats {
    const activeServices = services.filter((service) => service.isActive);
    const totalPrice = services.reduce((sum, service) => sum + service.price, 0);
    const totalDuration = services.reduce((sum, service) => sum + service.durationMinutes, 0);

    return {
      totalServices: services.length,
      activeServices: activeServices.length,
      avgPrice: services.length > 0 ? Math.round(totalPrice / services.length) : 0,
      avgDuration: services.length > 0 ? Math.round(totalDuration / services.length) : 0,
    };
  }
}

export const servicesService = new ServicesService();
