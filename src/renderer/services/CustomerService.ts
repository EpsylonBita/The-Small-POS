import { Customer } from '../../shared/types/customer';
import { getBridge, offEvent, onEvent } from '../../lib';
import {
  getCachedTerminalCredentials,
  refreshTerminalCredentialCache,
} from './terminal-credentials';

/**
 * CustomerService - Renderer-side customer service
 *
 * Exposes customer lookup functionality by calling the main-process
 * CustomerService via IPC (Electron's inter-process communication).
 *
 * This service runs in the renderer process and provides a clean API
 * for UI components to interact with customer data.
 */
class CustomerService {
  private bridge = getBridge();
  private terminalId: string = '';
  private lastUpdate: { customerId: string; timestamp: number } | null = null;

  constructor() {
    // Initialize from in-memory secure credential cache, then refresh via IPC.
    if (typeof window !== 'undefined') {
      this.terminalId = getCachedTerminalCredentials().terminalId || '';
      void refreshTerminalCredentialCache().then((resolved) => {
        if (resolved.terminalId) {
          this.terminalId = resolved.terminalId;
        }
      });
    }
  }

  /**
   * Set terminal ID for filtering self-originated events
   */
  setTerminalId(terminalId: string): void {
    this.terminalId = terminalId;
  }

  /**
   * Track an update as self-originated
   */
  private trackUpdate(customerId: string): void {
    this.lastUpdate = {
      customerId,
      timestamp: Date.now()
    };
  }

  /**
   * Check if an event is self-originated
   */
  private isSelfOriginated(customer: Customer): boolean {
    // Check if updated_by matches our terminal ID
    if (customer.updated_by === this.terminalId) {
      return true;
    }

    // Check if this is a recent update we made (within 2 second window)
    if (this.lastUpdate &&
        customer.id === this.lastUpdate.customerId &&
        Date.now() - this.lastUpdate.timestamp < 2000) {
      return true;
    }

    return false;
  }
  /**
   * Lookup customer by phone number
   *
   * Calls main process CustomerService which uses three-tier fallback:
   * 1. Admin Dashboard API
   * 2. Direct Supabase query
   * 3. SQLite local cache
   *
   * @param phone - Phone number to search
   * @returns Customer object or null if not found
   */
  async lookupByPhone(phone: string): Promise<Customer | null> {
    try {
      const customer = await this.bridge.customers.lookupByPhone(phone) as any;
      return customer || null;
    } catch (error) {
      console.error('Customer lookup failed:', error);
      throw error;
    }
  }

  /**
   * Search customers by name or phone (for autocomplete)
   *
   * @param query - Search query
   * @param limit - Maximum results to return (default: 10)
   * @returns Array of matching customers
   */
  async searchCustomers(query: string, limit: number = 10): Promise<Customer[]> {
    try {
      const customers = await this.bridge.customers.search(query) as any[];
      return customers.slice(0, limit) as Customer[];
    } catch (error) {
      console.error('Customer search failed:', error);
      return [];
    }
  }

  /**
   * Clear expired cache entries
   */
  async clearExpiredCache(): Promise<void> {
    try {
      await this.bridge.customers.clearCache();
    } catch (error) {
      console.error('Failed to clear expired cache:', error);
    }
  }

  /**
   * Get cache statistics
   */
  async getCacheStats(): Promise<{
    total: number;
    expired: number;
    valid: number;
  }> {
    try {
      const stats = await this.bridge.customers.getCacheStats();
      return stats || { total: 0, expired: 0, valid: 0 };
    } catch (error) {
      console.error('Failed to get cache stats:', error);
      return { total: 0, expired: 0, valid: 0 };
    }
  }

  /**
   * Invalidate cache for specific customer by phone
   *
   * @param phone - Phone number to invalidate
   */
  async invalidateCache(phone: string): Promise<void> {
    try {
      await this.bridge.customers.invalidateCache(phone);
    } catch (error) {
      console.error('Failed to invalidate cache:', error);
    }
  }

  /**
   * Refresh customer data by invalidating cache and looking up again
   *
   * @param phone - Phone number to refresh
   * @returns Fresh customer data or null if not found
   */
  async refreshCustomer(phone: string): Promise<Customer | null> {
    try {
      // Invalidate cache first
      await this.invalidateCache(phone);

      // Lookup again to get fresh data
      return await this.lookupByPhone(phone);
    } catch (error) {
      console.error('Failed to refresh customer:', error);
      return null;
    }
  }
  // Create customer
  async createCustomer(data: Partial<Customer>): Promise<Customer> {
    const result = await this.bridge.customers.create(data as any);
    const created = (result?.data ?? (result as any)?.customer ?? result) as Customer;
    if (created?.id) {
      this.trackUpdate(created.id);
    }
    return created;
  }

  // Update customer with optimistic locking
  async updateCustomer(customerId: string, updates: Partial<Customer>, currentVersion: number): Promise<any> {
    const result = await this.bridge.customers.update(customerId, updates as any, currentVersion);
    if ((result as any)?.success !== false) {
      this.trackUpdate(customerId);
    }
    return result;
  }

  // Add customer address
  async addCustomerAddress(customerId: string, address: any): Promise<any> {
    const created = await this.bridge.customers.addAddress(customerId, address);
    return created;
  }

  // Update customer address with optimistic locking
  async updateCustomerAddress(addressId: string, updates: any, currentVersion: number): Promise<any> {
    const result = await this.bridge.customers.updateAddress(addressId, updates, currentVersion);
    return result;
  }

  // Resolve conflict
  async resolveCustomerConflict(conflictId: string, strategy: string, data?: Partial<Customer>): Promise<any> {
    return await this.bridge.customers.resolveConflict(conflictId, strategy, data);
  }

  // Get conflicts
  async getCustomerConflicts(filters?: any): Promise<any[]> {
    const conflicts = await this.bridge.customers.getConflicts(filters);
    return conflicts || [];
  }

  // Listen for conflict detected
  onConflictDetected(callback: (conflict: any) => void): () => void {
    const listener = (data: any) => callback(data);
    onEvent('customer-sync-conflict', listener);
    return () => offEvent('customer-sync-conflict', listener);
  }

  /**
   * Listen for customer created events
   * Filters out self-originated events
   *
   * @param callback - Function to call when customer is created
   * @returns Cleanup function to remove listener
   */
  onCustomerCreated(callback: (customer: Customer) => void): () => void {
    const listener = (data: any) => {
      // Filter out self-originated events
      if (this.isSelfOriginated(data)) {
        console.log('Ignoring self-originated customer-created event');
        return;
      }
      callback(data);
    };
    onEvent('customer-created', listener);

    return () => {
      offEvent('customer-created', listener);
    };
  }

  /**
   * Listen for customer updated events
   * Filters out self-originated events
   *
   * @param callback - Function to call when customer is updated
   * @returns Cleanup function to remove listener
   */
  onCustomerUpdated(callback: (customer: Customer) => void): () => void {
    const listener = (data: any) => {
      // Filter out self-originated events
      if (this.isSelfOriginated(data)) {
        console.log('Ignoring self-originated customer-updated event');
        return;
      }
      callback(data);
    };
    onEvent('customer-updated', listener);

    return () => {
      offEvent('customer-updated', listener);
    };
  }

  /**
   * Listen for customer deleted events
   * Filters out self-originated events
   *
   * @param callback - Function to call when customer is deleted
   * @returns Cleanup function to remove listener
   */
  onCustomerDeleted(callback: (data: { id: string; phone: string }) => void): () => void {
    const listener = (data: any) => {
      // For delete events, we can't check updated_by, so only check recent updates
      if (this.lastUpdate &&
          data.id === this.lastUpdate.customerId &&
          Date.now() - this.lastUpdate.timestamp < 2000) {
        console.log('Ignoring self-originated customer-deleted event');
        return;
      }
      callback(data);
    };
    onEvent('customer-deleted', listener);

    return () => {
      offEvent('customer-deleted', listener);
    };
  }
}

// Export singleton instance
export const customerService = new CustomerService();

