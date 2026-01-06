import Database from 'better-sqlite3';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { Customer, CustomerAddress } from '../../shared/types/customer';
import { CustomerCacheService } from './CustomerCacheService';
import { CustomerSyncService } from '../../shared/services/CustomerSyncService';
import type { ConflictResult } from '../../shared/types/customer-sync';
import { isConflictResult } from '../../shared/types/customer-sync';

/**
 * CustomerService - Three-tier customer lookup system
 *
 * Tier 1: Admin Dashboard API (fast, cached, optimized)
 * Tier 2: Direct Supabase query (fallback when API is down)
 * Tier 3: SQLite local cache (offline fallback)
 *
 * This service runs in the main process and is exposed to renderer via IPC.
 */
export class CustomerService {
  private supabaseClient: SupabaseClient;
  private cacheService: CustomerCacheService;
  private syncService: CustomerSyncService;
  private readonly API_TIMEOUT_MS = 5000; // 5 seconds
  private readonly ADMIN_API_BASE_URL: string;
  private terminalId?: string;
  private organizationId?: string;
  private posApiKey?: string;

  constructor(
    database: Database.Database,
    supabaseUrl: string,
    supabaseAnonKey: string,
    adminApiBaseUrl?: string,
    terminalId?: string,
    organizationId?: string,
    posApiKey?: string
  ) {
    // Initialize Supabase client with provided credentials
    // Use placeholder values if not configured to allow app to start for onboarding
    const url = supabaseUrl || 'https://placeholder.supabase.co';
    const key = supabaseAnonKey || 'placeholder-key';
    this.supabaseClient = createClient(url, key);
    this.cacheService = new CustomerCacheService(database);
    this.ADMIN_API_BASE_URL = adminApiBaseUrl || 'http://localhost:3001/api';
    this.terminalId = terminalId;
    this.organizationId = organizationId;
    this.posApiKey = posApiKey;

    // Initialize CustomerSyncService
    this.syncService = new CustomerSyncService(
      this.supabaseClient as any,
      'pos-system',
      { terminalId, organizationId }
    );
  }

  /**
   * Lookup customer by phone number using three-tier fallback
   *
   * @param phone - Phone number to search (normalized)
   * @returns Customer object or null if not found
   */
  public async lookupByPhone(phone: string): Promise<Customer | null> {
    const normalizedPhone = this.syncService.normalizePhone(phone);

    // Tier 1: Try Admin Dashboard API
    try {
      const customer = await this.lookupViaAdminAPI(normalizedPhone);
      if (customer) {
        // Check for conflicts with sync service
        await this.detectAndHandleConflict(customer);
        // Cache the result
        this.cacheService.cacheCustomer(customer);
        return customer;
      }
    } catch (error) {
      console.warn('Admin API lookup failed, falling back to Supabase:', error);
    }

    // Tier 2a: Try SECURITY DEFINER RPC (returns addresses)
    try {
      const customerFromRpc = await this.lookupViaSupabaseRpc(normalizedPhone);
      if (customerFromRpc) {
        await this.detectAndHandleConflict(customerFromRpc);
        this.cacheService.cacheCustomer(customerFromRpc);
        return customerFromRpc;
      }
    } catch (error) {
      console.warn('Supabase RPC lookup failed, trying direct customers table:', error);
    }

    // Tier 2b: Try direct Supabase customers table (no addresses to avoid RLS)
    try {
      const customer = await this.lookupViaSupabase(normalizedPhone);
      if (customer) {
        await this.detectAndHandleConflict(customer as Customer);
        this.cacheService.cacheCustomer(customer as Customer);
        return customer as Customer;
      }
    } catch (error) {
      console.warn('Supabase lookup failed, falling back to cache:', error);
    }

    // Tier 3: Try SQLite cache
    try {
      const customer = this.cacheService.getCachedCustomer(normalizedPhone);
      if (customer) {
        console.info('Returning cached customer (offline mode)');
        return customer;
      }
    } catch (error) {
      console.error('Cache lookup failed:', error);
    }

    return null;
  }

  /**
   * Detect and handle conflicts between local cache and remote data
   */
  private async detectAndHandleConflict(customer: Customer): Promise<void> {
    try {
      // Get cached version if exists
      const cachedCustomer = this.cacheService.getCachedCustomer(customer.phone);

      if (cachedCustomer && cachedCustomer.version !== undefined && customer.version !== undefined) {
        const hasConflict = this.syncService.detectConflict(
          cachedCustomer.version,
          customer.version,
          cachedCustomer,
          customer
        );

        if (hasConflict) {
          // Emit conflict event (will be handled by main process)
          console.warn('Customer sync conflict detected:', {
            customerId: customer.id,
            localVersion: cachedCustomer.version,
            remoteVersion: customer.version
          });
        }
      }
    } catch (error) {
      console.error('Error detecting conflict:', error);
    }
  }

  /**
   * Tier 1: Lookup via Admin Dashboard API (POS endpoint)
   */
  private async lookupViaAdminAPI(phone: string): Promise<Customer | null> {
    const url = `${this.ADMIN_API_BASE_URL}/pos/customers?phone=${encodeURIComponent(phone)}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.API_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'x-pos-api-key': this.posApiKey || '',
          'x-terminal-id': this.terminalId || '',
        },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        if (response.status === 404) {
          return null;
        }
        throw new Error(`Admin API returned ${response.status}`);
      }

      const result = await response.json();
      
      // Debug: Log the raw API response
      console.log('[CustomerService] Raw API response:', JSON.stringify({
        success: result?.success,
        hasCustomer: !!result?.customer,
        customerRingerName: result?.customer?.ringer_name,
        customerNameOnRinger: result?.customer?.name_on_ringer,
        addressCount: result?.customer?.addresses?.length,
        firstAddressNotes: result?.customer?.addresses?.[0]?.notes
      }));

      // Support both shapes:
      // A) { success, data: { customer, hasConflict } }
      // B) { success, customer, hasConflict }
      const customerPayload = result?.data?.customer || result?.customer;
      if (result?.success && customerPayload) {
        return this.normalizeCustomerData(customerPayload);
      }

      return null;
    } catch (error) {
      clearTimeout(timeoutId);
      throw error;
    }
  }

  /**
   * Tier 2a: Lookup via SECURITY DEFINER RPC (returns addresses)
   */
  private async lookupViaSupabaseRpc(phone: string): Promise<Customer | null> {
    const { data, error } = await this.supabaseClient.rpc('pos_lookup_customer_by_phone', { p_phone: phone });
    if (error) {
      throw error;
    }
    if (data && (data as any).found && (data as any).customer) {
      return this.normalizeCustomerData((data as any).customer);
    }
    return null;
  }

  /**
   * Tier 2: Lookup via direct Supabase query
   */
  private async lookupViaSupabase(phone: string): Promise<Customer | null> {
    const { data, error } = await this.supabaseClient
      .from('customers')
      .select(`
        id,
        name,
        phone,
        email,
        loyalty_points,
        total_orders,
        is_banned,
        ban_reason,
        banned_at,
        created_at,
        updated_at,
        version,
        updated_by,
        last_synced_at
      `)
      .eq('phone', phone)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        // Not found
        return null;
      }
      throw error;
    }

    if (!data) {
      return null;
    }

    return this.normalizeCustomerData(data);
  }

  /**
   * Normalize customer data from Supabase schema to UI format
   *
   * Handles:
   * - full_name → name mapping
   * - customer_addresses → addresses mapping
   * - street_address → street mapping
   * - notes → delivery_notes mapping
   * - ringer_name → name_on_ringer mapping
   * - Merges addresses from both data.customer_addresses and data.addresses
   * - Adding computed fields (total_orders, last_order_date)
   */
  private normalizeCustomerData(data: any): Customer {
    // Merge addresses from both customer_addresses and addresses fields
    const src = data.customer_addresses ?? data.addresses ?? [];

    const addresses: CustomerAddress[] = src.map((addr: any) => ({
      id: addr.id,
      customer_id: addr.customer_id,
      street: addr.street_address || addr.street, // Handle both field names
      street_address: addr.street_address || addr.street, // Also include street_address for compatibility
      city: addr.city,
      postal_code: addr.postal_code,
      floor_number: addr.floor_number,
      address_type: addr.address_type,
      is_default: Boolean(addr.is_default), // Ensure boolean
      delivery_notes: addr.delivery_notes || addr.notes, // Map notes → delivery_notes
      notes: addr.notes || addr.delivery_notes, // Also include notes for frontend compatibility
      created_at: addr.created_at,
      updated_at: addr.updated_at,
      version: addr.version,
    }));

    return {
      id: data.id,
      name: data.name || data.full_name, // Use name field from Supabase
      full_name: data.name || data.full_name, // Map to full_name for compatibility
      phone: data.phone,
      email: data.email,
      loyalty_points: data.loyalty_points || 0,
      addresses: addresses.length > 0 ? addresses : [], // Return empty array if no addresses
      created_at: data.created_at,
      updated_at: data.updated_at,
      total_orders: data.total_orders || 0,
      last_order_date: data.last_order_date,
      is_banned: Boolean(data.is_banned),
      ban_reason: data.ban_reason || null, // Reason for banning the customer
      banned_at: data.banned_at || null, // Timestamp when customer was banned
      // Ringer name - map from ringer_name or name_on_ringer
      name_on_ringer: data.ringer_name || data.name_on_ringer,
      ringer_name: data.ringer_name || data.name_on_ringer,
      // Sync metadata - default version to 1 for legacy customers without version
      version: data.version ?? 1,
      updated_by: data.updated_by,
      last_synced_at: data.last_synced_at,
    };
  }

  /**
   * Normalize phone number for consistent lookup
   * Wrapper around CustomerSyncService.normalizePhone for backward compatibility
   *
   * @param phone - Phone number to normalize
   * @returns Normalized phone number
   */
  private normalizePhone(phone: string): string {
    return this.syncService.normalizePhone(phone);
  }

  /**
   * Create new customer
   *
   * @param data - Customer data
   * @returns Created customer
   */
  public async createCustomer(data: Partial<Customer>): Promise<Customer> {
    const customer = await this.syncService.createCustomer(data as any);
    // Cache the created customer
    this.cacheService.cacheCustomer(customer as any as Customer);
    return customer as any as Customer;
  }

  /**
   * Update customer with optimistic locking
   *
   * @param customerId - Customer ID to update
   * @param updates - Fields to update
   * @param currentVersion - Current version for optimistic locking
   * @returns Updated customer or conflict result
   */
  public async updateCustomer(
    customerId: string,
    updates: Partial<Customer>,
    currentVersion: number
  ): Promise<Customer | ConflictResult> {
    const result = await this.syncService.updateCustomer(customerId, updates as any, currentVersion);

    if (isConflictResult(result)) {
      // Return conflict to be handled by caller
      return result as any;
    }

    // Update cache on success
    this.cacheService.cacheCustomer(result as any as Customer);
    return result as any as Customer;
  }

  /**
   * Add address to customer
   *
   * @param customerId - Customer ID
   * @param address - Address data
   * @returns Created address
   */
  public async addAddress(
    customerId: string,
    address: Partial<CustomerAddress>
  ): Promise<CustomerAddress> {
    return await this.syncService.addAddress(customerId, address as any) as any as CustomerAddress;
  }

  /**
   * Update customer address with optimistic locking
   *
   * @param addressId - Address ID to update
   * @param updates - Fields to update
   * @param currentVersion - Current version for optimistic locking
   * @returns Updated address or conflict result
   */
  public async updateAddress(
    addressId: string,
    updates: Partial<CustomerAddress>,
    currentVersion: number
  ): Promise<CustomerAddress | ConflictResult> {
    return await this.syncService.updateAddress(addressId, updates as any, currentVersion) as any;
  }

  /**
   * Search customers by name or phone (for autocomplete)
   *
   * @param query - Search query
   * @param limit - Maximum results to return
   * @returns Array of matching customers
   */
  public async searchCustomers(query: string, limit: number = 1000): Promise<Customer[]> {
    try {
      // Try Admin API first
      const url = `${this.ADMIN_API_BASE_URL}/customers?search=${encodeURIComponent(query)}&limit=${limit}`;

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.API_TIMEOUT_MS);

      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
        },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (response.ok) {
        const result = await response.json();
        // Admin API returns { data: Customer[], pagination: {...} }
        return (result.data || []).map((c: any) => this.normalizeCustomerData(c));
      }
    } catch (error) {
      console.warn('Admin API search failed, falling back to Supabase:', error);
    }

    // Fallback to Supabase
    try {
      let supabaseQuery = this.supabaseClient
        .from('customers')
        .select(`
          id,
          name,
          phone,
          email,
          loyalty_points,
          total_orders,
          is_banned,
          ban_reason,
          banned_at,
          created_at,
          updated_at,
          version,
          updated_by,
          last_synced_at
        `);

      // If query is provided, filter by name or phone
      // If query is empty, fetch all customers
      if (query && query.trim()) {
        supabaseQuery = supabaseQuery.or(`name.ilike.%${query}%,phone.ilike.%${query}%`);
      }

      const { data, error } = await supabaseQuery
        .order('created_at', { ascending: false })
        .limit(limit);

      if (error) {
        throw error;
      }

      return (data || []).map((c: any) => this.normalizeCustomerData(c));
    } catch (error) {
      console.error('Customer search failed:', error);
      return [];
    }
  }

  /**
   * Clear expired cache entries
   */
  public clearExpiredCache(): void {
    this.cacheService.clearExpiredCache();
  }

  /**
   * Get cache statistics
   */
  public getCacheStats() {
    return this.cacheService.getCacheStats();
  }

  /**
   * Update customer cache with new data
   *
   * @param customer - Customer object to cache
   */
  public updateCustomerCache(customer: Customer): void {
    this.cacheService.cacheCustomer(customer);
  }

  /**
   * Invalidate cache by customer ID
   *
   * @param customerId - Customer ID to invalidate
   */
  public invalidateCacheById(customerId: string): void {
    this.cacheService.invalidateCustomerById(customerId);
  }

  /**
   * Invalidate cache by phone number
   *
   * @param phone - Phone number to invalidate
   */
  public invalidateCache(phone: string): void {
    this.cacheService.invalidateCustomer(phone);
  }

  /**
   * Get cached customer by phone (for sync service)
   *
   * @param phone - Phone number to lookup
   * @returns Customer object or null if not found/expired
   */
  public getCachedCustomer(phone: string): Customer | null {
    return this.cacheService.getCachedCustomer(phone);
  }

  /**
   * Resolve a customer conflict via sync service
   */
  public async resolveCustomerConflict(conflictId: string, strategy: string, data?: Partial<Customer>): Promise<any> {
    return await (this.syncService as any).resolveConflict(conflictId, strategy as any, data as any);
  }

  /**
   * Get customer conflicts via sync service
   */
  public async getCustomerConflicts(filters?: any): Promise<any[]> {
    return await (this.syncService as any).getConflicts(filters);
  }
}
