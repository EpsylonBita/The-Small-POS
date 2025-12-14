import { Customer } from '../../shared/types/customer';

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
  private terminalId: string = '';
  private lastUpdate: { customerId: string; timestamp: number } | null = null;

  constructor() {
    // Get terminal ID from localStorage or generate one
    if (typeof window !== 'undefined') {
      this.terminalId = localStorage.getItem('terminal_id') || '';
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
      const customer = await window.electronAPI?.customerLookupByPhone?.(phone);
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
      const customers = await window.electronAPI?.customerSearch?.(query);
      return customers || [];
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
      await window.electronAPI?.customerClearCache?.();
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
      const stats = await window.electronAPI?.customerGetCacheStats?.();
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
      await window.electronAPI?.customerInvalidateCache?.(phone);
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
    const created = await window.electronAPI?.customerCreate?.(data)
    return created as Customer
  }

  // Update customer with optimistic locking
  async updateCustomer(customerId: string, updates: Partial<Customer>, currentVersion: number): Promise<any> {
    const result = await window.electronAPI?.customerUpdate?.(customerId, updates, currentVersion)
    return result
  }

  // Add customer address
  async addCustomerAddress(customerId: string, address: any): Promise<any> {
    const created = await window.electronAPI?.customerAddAddress?.(customerId, address)
    return created
  }

  // Update customer address with optimistic locking
  async updateCustomerAddress(addressId: string, updates: any, currentVersion: number): Promise<any> {
    const result = await window.electronAPI?.customerUpdateAddress?.(addressId, updates, currentVersion)
    return result
  }

  // Resolve conflict
  async resolveCustomerConflict(conflictId: string, strategy: string, data?: Partial<Customer>): Promise<any> {
    return await window.electronAPI?.customerResolveConflict?.(conflictId, strategy, data)
  }

  // Get conflicts
  async getCustomerConflicts(filters?: any): Promise<any[]> {
    const conflicts = await window.electronAPI?.customerGetConflicts?.(filters)
    return conflicts || []
  }

  // Listen for conflict detected
  onConflictDetected(callback: (conflict: any) => void): () => void {
    const listener = (data: any) => callback(data)
    window.electronAPI?.onCustomerConflictDetected?.(listener)
    return () => window.electronAPI?.removeCustomerConflictDetectedListener?.(listener)
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
    window.electronAPI?.onCustomerCreated?.(listener);

    return () => {
      window.electronAPI?.removeCustomerCreatedListener?.(listener);
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
    window.electronAPI?.onCustomerUpdated?.(listener);

    return () => {
      window.electronAPI?.removeCustomerUpdatedListener?.(listener);
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
    window.electronAPI?.onCustomerDeleted?.(listener);

    return () => {
      window.electronAPI?.removeCustomerDeletedListener?.(listener);
    };
  }
}

// Export singleton instance
export const customerService = new CustomerService();

