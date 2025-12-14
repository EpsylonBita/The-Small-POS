/**
 * ServicesService - POS Services Service
 * 
 * Provides service catalog management functionality for the POS system (Salon Vertical).
 * Uses direct Supabase connection for real-time data.
 * 
 * Follows the same pattern as AppointmentsService.
 */

import { supabase, subscribeToTable, unsubscribeFromChannel } from '../../shared/supabase';

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
  private realtimeChannel: any = null;

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
        console.error('[ServicesService] Error fetching services:', error);
        // Handle table not existing gracefully
        if (error.code === '42P01' || error.message?.includes('does not exist')) {
          console.warn('[ServicesService] services table does not exist');
          return [];
        }
        throw error;
      }

      return (data || []).map(transformFromAPI);
    } catch (error) {
      console.error('[ServicesService] Failed to fetch services:', error);
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
      console.error('[ServicesService] Failed to fetch categories:', error);
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

  /**
   * Subscribe to real-time service updates
   */
  subscribeToUpdates(callback: (service: Service) => void): void {
    if (this.realtimeChannel) {
      this.unsubscribeFromUpdates();
    }

    this.realtimeChannel = subscribeToTable(
      'services',
      (payload: any) => {
        if (payload.new) {
          callback(transformFromAPI(payload.new));
        }
      },
      `branch_id=eq.${this.branchId}`
    );
  }

  /**
   * Unsubscribe from real-time updates
   */
  unsubscribeFromUpdates(): void {
    if (this.realtimeChannel) {
      unsubscribeFromChannel(this.realtimeChannel);
      this.realtimeChannel = null;
    }
  }
}

// Export singleton instance
export const servicesService = new ServicesService();

