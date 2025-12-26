import { SupabaseClient } from '@supabase/supabase-js'
import type {
  Customer,
  CustomerAddress,
  CustomerConflict,
  ConflictResult,
  ConflictResolutionResult,
  ConflictFilters,
  ConflictType,
  ResolutionStrategy,
  CustomerLookupOptions
} from '../types/customer-sync'

type SupabaseCustomer = any
type SupabaseCustomerAddress = any
type SupabaseConflict = any

/**
 * CustomerSyncService
 *
 * Provides unified customer synchronization across all platforms:
 * - Admin Dashboard
 * - POS System
 * - Customer Web
 * - Customer Mobile
 *
 * Features:
 * - Phone number normalization and lookup
 * - Optimistic locking with version control
 * - Conflict detection and resolution
 * - Address management
 * - Platform-agnostic (Node.js, Electron, Browser)
 */
export class CustomerSyncService {
  private supabase: SupabaseClient<any>
  private source: 'admin-dashboard' | 'pos-system' | 'customer-web' | 'customer-mobile'
  private terminalId?: string
  private organizationId?: string
  private onConflictCallback?: (conflict: CustomerConflict) => void

  constructor(
    supabaseClient: SupabaseClient<any>,
    source: 'admin-dashboard' | 'pos-system' | 'customer-web' | 'customer-mobile',
    options?: {
      terminalId?: string
      organizationId?: string
      onConflict?: (conflict: CustomerConflict) => void
    }
  ) {
    this.supabase = supabaseClient
    this.source = source
    this.terminalId = options?.terminalId
    this.organizationId = options?.organizationId
    this.onConflictCallback = options?.onConflict
  }

  /**
   * European country codes (without leading zeros)
   * Used for phone normalization across all European countries
   */
  private static readonly EUROPEAN_COUNTRY_CODES = [
    '30',  // Greece
    '31',  // Netherlands
    '32',  // Belgium
    '33',  // France
    '34',  // Spain
    '35',  // Portugal (351), Ireland (353), etc.
    '36',  // Hungary
    '37',  // Lithuania (370), Latvia (371), Estonia (372), Moldova (373)
    '38',  // Slovenia (386), Croatia (385), Bosnia (387), Serbia (381), Montenegro (382), Kosovo (383)
    '39',  // Italy
    '40',  // Romania
    '41',  // Switzerland
    '42',  // Czech Republic (420), Slovakia (421)
    '43',  // Austria
    '44',  // United Kingdom
    '45',  // Denmark
    '46',  // Sweden
    '47',  // Norway
    '48',  // Poland
    '49',  // Germany
    '90',  // Turkey
    '35',  // Portugal area codes
    '351', // Portugal
    '352', // Luxembourg
    '353', // Ireland
    '354', // Iceland
    '355', // Albania
    '356', // Malta
    '357', // Cyprus
    '358', // Finland
    '359', // Bulgaria
    '370', // Lithuania
    '371', // Latvia
    '372', // Estonia
    '373', // Moldova
    '374', // Armenia
    '375', // Belarus
    '376', // Andorra
    '377', // Monaco
    '378', // San Marino
    '379', // Vatican
    '380', // Ukraine
    '381', // Serbia
    '382', // Montenegro
    '383', // Kosovo
    '385', // Croatia
    '386', // Slovenia
    '387', // Bosnia
    '389', // North Macedonia
    '420', // Czech Republic
    '421', // Slovakia
    '423', // Liechtenstein
  ]


  /**
   * Normalize phone number to consistent format
   * Removes spaces, dashes, parentheses, and European country codes
   * Example: "+30 694 812 8474" → "6948128474"
   * Example: "+44 20 7946 0958" → "2079460958"
   * Example: "+49 30 12345678" → "3012345678"
   */
  normalizePhone(phone: string): string {
    if (!phone) return ''

    // Remove all non-digit characters
    let normalized = phone.replace(/\D/g, '')

    // Remove leading 00 prefix (international dialing format)
    if (normalized.startsWith('00')) {
      normalized = normalized.substring(2)
    }

    // Remove European country codes (try longer codes first for accuracy)
    // Sort by length descending to match longer codes first (e.g., 351 before 35)
    const sortedCodes = [...CustomerSyncService.EUROPEAN_COUNTRY_CODES].sort((a, b) => b.length - a.length)
    
    for (const code of sortedCodes) {
      if (normalized.startsWith(code) && normalized.length > 10) {
        normalized = normalized.substring(code.length)
        break
      }
    }

    // Remove leading zero if present (common in many European countries)
    if (normalized.startsWith('0')) {
      normalized = normalized.substring(1)
    }

    return normalized
  }

  /**
   * Lookup customer by phone number
   * Uses normalized phone for consistent results
   */
  async lookupByPhone(
    phone: string,
    options?: CustomerLookupOptions
  ): Promise<Customer | null> {
    try {
      const normalizedPhone = this.normalizePhone(phone)
      if (!normalizedPhone) return null

      // Query customer by normalized phone
      let query = this.supabase
        .from('customers')
        .select(
          options?.includeAddresses !== false
            ? `
              *,
              customer_addresses (*)
            `
            : '*'
        )
        .eq('phone', normalizedPhone)
        .single()

      const { data, error } = await query

      if (error) {
        if (error.code === 'PGRST116') {
          // Not found
          return null
        }
        throw error
      }

      return this.normalizeCustomerData(data)
    } catch (error) {
      console.error('[CustomerSyncService] Error in lookupByPhone:', error)
      throw error
    }
  }

  /**
   * Create new customer with version=1
   */
  async createCustomer(data: Partial<Customer>): Promise<Customer> {
    try {
      // Normalize phone if provided
      // Build DB-safe payload (snake_case) and remove non-existent columns
      const customerData: any = {
        phone: data.phone ? this.normalizePhone(data.phone) : null,
        version: 1,
        updated_by: this.source,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }

      if (this.organizationId) {
        customerData.organization_id = this.organizationId
      }

      // Map name field (DB column is 'name', not 'full_name')
      if ((data as any).full_name || (data as any).name) {
        customerData.name = (data as any).name || (data as any).full_name
      }
      if ((data as any).email !== undefined) {
        customerData.email = (data as any).email
      }
      if ((data as any).loyalty_points !== undefined) {
        customerData.loyalty_points = (data as any).loyalty_points
      }

      const { data: created, error } = await this.supabase
        .from('customers')
        .insert(customerData)
        .select()
        .single()

      if (error) throw error

      return this.normalizeCustomerData(created)
    } catch (error) {
      console.error('[CustomerSyncService] Error in createCustomer:', error)
      throw error
    }
  }

  /**
   * Update customer with optimistic locking
   * Returns updated customer or conflict result
   */
  async updateCustomer(
    customerId: string,
    updates: Partial<Customer>,
    currentVersion: number
  ): Promise<Customer | ConflictResult> {
    try {
      // Normalize phone if provided
      // Build DB-safe payload (snake_case) without non-existent columns
      const updateData: any = {
        updated_by: this.source,
        updated_at: new Date().toISOString()
      }

      if ((updates as any).phone !== undefined) {
        updateData.phone = updates.phone ? this.normalizePhone(updates.phone) : null
      }
      // Map name field (DB column is 'name', not 'full_name')
      if ((updates as any).full_name || (updates as any).name) {
        updateData.name = (updates as any).name || (updates as any).full_name
      }
      if ((updates as any).email !== undefined) {
        updateData.email = (updates as any).email
      }
      if ((updates as any).loyalty_points !== undefined) {
        updateData.loyalty_points = (updates as any).loyalty_points
      }
      // Valid customer table fields only (address-related fields are in customer_addresses table)
      if ((updates as any).address !== undefined) {
        updateData.address = (updates as any).address
      }
      if ((updates as any).postal_code !== undefined) {
        updateData.postal_code = (updates as any).postal_code
      }
      if ((updates as any).notes !== undefined) {
        updateData.notes = (updates as any).notes
      }
      if ((updates as any).ringer_name !== undefined) {
        updateData.ringer_name = (updates as any).ringer_name
      }
      // Note: city, floor_number, coordinates belong to customer_addresses table, not customers

      // Remove undefined values
      Object.keys(updateData).forEach(key => {
        if (updateData[key] === undefined) {
          delete updateData[key]
        }
      })

      // Skip version check if currentVersion is -1 (legacy customer without version)
      const skipVersionCheck = currentVersion === -1

      // For version check, we need to handle NULL versions in the database
      // If version is 1 (default), also try matching NULL for legacy customers
      let query;
      if (skipVersionCheck) {
        // Force update without version check
        query = this.supabase
          .from('customers')
          .update(updateData)
          .eq('id', customerId)
      } else if (currentVersion === 1) {
        // Version 1 might mean the DB has NULL or 1, try both
        query = this.supabase
          .from('customers')
          .update({ ...updateData, version: 2 })
          .eq('id', customerId)
          .or(`version.eq.1,version.is.null`)
      } else {
        // Normal version check
        query = this.supabase
          .from('customers')
          .update({ ...updateData, version: currentVersion + 1 })
          .eq('id', customerId)
          .eq('version', currentVersion)
      }

      // Attempt update
      const { data: updated, error } = await query
        .select()
        .single()

      if (error) {
        // Check if this is a version conflict
        if (error.code === 'PGRST116') {
          // No rows returned - version mismatch
          const { data: remoteCustomer } = await this.supabase
            .from('customers')
            .select('*')
            .eq('id', customerId)
            .single()

          if (remoteCustomer) {
            // Create conflict record
            const conflictId = await this.createConflictRecord(
              customerId,
              currentVersion,
              remoteCustomer.version,
              updateData,
              remoteCustomer,
              'version_mismatch'
            )

            const conflict: ConflictResult = {
              conflict: true,
              conflictId,
              localData: { ...updateData, id: customerId, version: currentVersion } as Customer,
              remoteData: this.normalizeCustomerData(remoteCustomer),
              localVersion: currentVersion,
              remoteVersion: remoteCustomer.version
            }

            // Emit conflict event
            if (this.onConflictCallback) {
              this.onConflictCallback(await this.getConflictById(conflictId))
            }

            return conflict
          }
        }
        throw error
      }

      return this.normalizeCustomerData(updated)
    } catch (error) {
      console.error('[CustomerSyncService] Error in updateCustomer:', error)
      throw error
    }
  }


  /**
   * Add address for customer
   */
  async addAddress(
    customerId: string,
    address: Partial<CustomerAddress>
  ): Promise<CustomerAddress> {
    try {
      // Build DB-safe address payload (snake_case)
      const addressData: any = {
        customer_id: customerId,
        version: 1,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }

      if (this.organizationId) {
        addressData.organization_id = this.organizationId
      }

      // Field mappings
      if ((address as any).street_address || (address as any).street) {
        addressData.street_address = (address as any).street_address || (address as any).street
      }
      if ((address as any).city !== undefined) addressData.city = (address as any).city
      if ((address as any).postal_code !== undefined) addressData.postal_code = (address as any).postal_code
      if ((address as any).country !== undefined) addressData.country = (address as any).country
      if ((address as any).floor_number !== undefined) addressData.floor_number = (address as any).floor_number
      if ((address as any).address_type !== undefined) addressData.address_type = (address as any).address_type
      if ((address as any).is_default !== undefined) addressData.is_default = (address as any).is_default
      // Notes field - DB column is 'notes' (not 'delivery_notes')
      if ((address as any).notes !== undefined || (address as any).delivery_notes !== undefined) {
        addressData.notes = (address as any).notes !== undefined 
          ? (address as any).notes 
          : (address as any).delivery_notes
      }

      const { data: created, error } = await this.supabase
        .from('customer_addresses')
        .insert(addressData)
        .select()
        .single()

      if (error) throw error

      return this.normalizeAddressData(created)
    } catch (error) {
      console.error('[CustomerSyncService] Error in addAddress:', error)
      throw error
    }
  }

  /**
   * Update address with optimistic locking
   */
  async updateAddress(
    addressId: string,
    updates: Partial<CustomerAddress>,
    currentVersion: number
  ): Promise<CustomerAddress | ConflictResult> {
    try {
      // Build DB-safe address update payload (snake_case)
      const updateData: any = {
        updated_at: new Date().toISOString()
      }

      if ((updates as any).street_address || (updates as any).street) {
        updateData.street_address = (updates as any).street_address || (updates as any).street
      }
      if ((updates as any).city !== undefined) updateData.city = (updates as any).city
      if ((updates as any).postal_code !== undefined) updateData.postal_code = (updates as any).postal_code
      if ((updates as any).country !== undefined) updateData.country = (updates as any).country
      if ((updates as any).floor_number !== undefined) updateData.floor_number = (updates as any).floor_number
      if ((updates as any).address_type !== undefined) updateData.address_type = (updates as any).address_type
      if ((updates as any).is_default !== undefined) updateData.is_default = (updates as any).is_default
      // Notes field - DB column is 'notes' (not 'delivery_notes')
      if ((updates as any).notes !== undefined || (updates as any).delivery_notes !== undefined) {
        updateData.notes = (updates as any).notes !== undefined 
          ? (updates as any).notes 
          : (updates as any).delivery_notes
      }

      // Remove undefined values
      Object.keys(updateData).forEach(key => {
        if (updateData[key] === undefined) {
          delete updateData[key]
        }
      })

      // Increment version for optimistic locking
      updateData.version = currentVersion + 1

      const { data: updated, error } = await this.supabase
        .from('customer_addresses')
        .update(updateData)
        .eq('id', addressId)
        .eq('version', currentVersion)
        .select()
        .single()

      if (error) {
        if (error.code === 'PGRST116') {
          // Version conflict for address
          const { data: remoteAddress } = await this.supabase
            .from('customer_addresses')
            .select('*')
            .eq('id', addressId)
            .single()

          if (remoteAddress) {
            // Create conflict record with address context
            const conflictId = await this.createConflictRecord(
              remoteAddress.customer_id,
              currentVersion,
              remoteAddress.version,
              { ...updateData, id: addressId, version: currentVersion },
              remoteAddress,
              'version_mismatch'
            )

            if (this.onConflictCallback) {
              this.onConflictCallback(await this.getConflictById(conflictId))
            }

            return {
              conflict: true,
              conflictId,
              localData: { ...updateData, id: addressId, version: currentVersion } as any,
              remoteData: this.normalizeAddressData(remoteAddress) as any,
              localVersion: currentVersion,
              remoteVersion: remoteAddress.version
            }
          }
        }
        throw error
      }

      return this.normalizeAddressData(updated)
    } catch (error) {
      console.error('[CustomerSyncService] Error in updateAddress:', error)
      throw error
    }
  }

  /**
   * Delete address
   */
  async deleteAddress(addressId: string): Promise<void> {
    try {
      const { error } = await this.supabase
        .from('customer_addresses')
        .delete()
        .eq('id', addressId)

      if (error) throw error
    } catch (error) {
      console.error('[CustomerSyncService] Error in deleteAddress:', error)
      throw error
    }
  }

  /**
   * Detect if there's a version conflict
   */
  detectConflict(
    localVersion: number,
    remoteVersion: number,
    localData?: any,
    remoteData?: any
  ): boolean {
    // If remote version is less than local, it's stale
    if (remoteVersion < localVersion) {
      return false // Skip update, local is newer
    }

    // If remote version equals local, check timestamps
    if (remoteVersion === localVersion) {
      if (localData?.updated_at && remoteData?.updated_at) {
        const localTime = new Date(localData.updated_at).getTime()
        const remoteTime = new Date(remoteData.updated_at).getTime()

        // If remote updated_at is strictly newer, treat as conflict
        if (remoteTime > localTime) {
          return true
        }
      }
      return false // Same version or remote older/equal timestamp
    }

    // Remote version is greater - potential conflict
    return true
  }


  /**
   * Create conflict record in database
   */
  async createConflictRecord(
    customerId: string,
    localVersion: number,
    remoteVersion: number,
    localData: any,
    remoteData: any,
    conflictType: ConflictType
  ): Promise<string> {
    try {
      const conflictData: any = {
        customer_id: customerId,
        local_version: localVersion,
        remote_version: remoteVersion,
        local_data: localData,
        remote_data: remoteData,
        conflict_type: conflictType,
        terminal_id: this.terminalId,
        resolved: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }

      // Add organization_id (required field)
      if (this.organizationId) {
        conflictData.organization_id = this.organizationId
      } else if (remoteData?.organization_id) {
        conflictData.organization_id = remoteData.organization_id
      }

      const { data: conflict, error } = await this.supabase
        .from('customer_sync_conflicts')
        .insert(conflictData)
        .select()
        .single()

      if (error) throw error

      return conflict.id
    } catch (error) {
      console.error('[CustomerSyncService] Error in createConflictRecord:', error)
      throw error
    }
  }

  /**
   * Resolve conflict with specified strategy
   */
  async resolveConflict(
    conflictId: string,
    strategy: ResolutionStrategy,
    resolvedData?: Partial<Customer>
  ): Promise<ConflictResolutionResult> {
    try {
      // Get conflict
      const conflict = await this.getConflictById(conflictId)
      if (!conflict) {
        return {
          success: false,
          error: 'Conflict not found'
        }
      }

      let finalData: any

      switch (strategy) {
        case 'local_wins':
          finalData = conflict.local_data
          break

        case 'remote_wins':
          finalData = conflict.remote_data
          break

        case 'manual_merge':
          if (!resolvedData) {
            return {
              success: false,
              error: 'Resolved data required for manual_merge strategy'
            }
          }
          finalData = resolvedData
          break

        case 'force_update':
          finalData = resolvedData || conflict.local_data
          break

        default:
          return {
            success: false,
            error: `Unknown resolution strategy: ${strategy}`
          }
      }

      // Update customer with resolved data
      // Use max version + 1 to ensure update goes through
      const newVersion = Math.max(conflict.local_version, conflict.remote_version) + 1

      const { data: updatedCustomer, error: updateError } = await this.supabase
        .from('customers')
        .update({
          ...finalData,
          version: newVersion,
          updated_by: this.source,
          updated_at: new Date().toISOString()
        })
        .eq('id', conflict.customer_id)
        .select()
        .single()

      if (updateError) {
        return {
          success: false,
          error: updateError.message
        }
      }

      // Mark conflict as resolved
      await this.supabase
        .from('customer_sync_conflicts')
        .update({
          resolved: true,
          resolution_strategy: strategy,
          resolved_at: new Date().toISOString(),
          resolved_by: this.source,
          updated_at: new Date().toISOString()
        })
        .eq('id', conflictId)

      return {
        success: true,
        resolvedCustomer: this.normalizeCustomerData(updatedCustomer)
      }
    } catch (error) {
      console.error('[CustomerSyncService] Error in resolveConflict:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      }
    }
  }

  /**
   * Get conflicts with filters
   */
  async getConflicts(filters?: ConflictFilters): Promise<CustomerConflict[]> {
    try {
      let query = this.supabase
        .from('customer_sync_conflicts')
        .select('*')
        .order('created_at', { ascending: false })

      if (filters?.terminalId) {
        query = query.eq('terminal_id', filters.terminalId)
      }

      if (filters?.resolved !== undefined) {
        query = query.eq('resolved', filters.resolved)
      }

      if (filters?.conflictType) {
        query = query.eq('conflict_type', filters.conflictType)
      }

      if (filters?.customerId) {
        query = query.eq('customer_id', filters.customerId)
      }

      if (filters?.dateFrom) {
        query = query.gte('created_at', filters.dateFrom)
      }

      if (filters?.dateTo) {
        query = query.lte('created_at', filters.dateTo)
      }

      // Pagination
      if (filters?.page && filters?.pageSize) {
        const from = (filters.page - 1) * filters.pageSize
        const to = from + filters.pageSize - 1
        query = query.range(from, to)
      }

      const { data, error } = await query

      if (error) throw error

      return (data || []).map(this.normalizeConflictData)
    } catch (error) {
      console.error('[CustomerSyncService] Error in getConflicts:', error)
      throw error
    }
  }

  /**
   * Get single conflict by ID
   */
  private async getConflictById(conflictId: string): Promise<CustomerConflict> {
    const { data, error } = await this.supabase
      .from('customer_sync_conflicts')
      .select('*')
      .eq('id', conflictId)
      .single()

    if (error) throw error

    return this.normalizeConflictData(data)
  }

  /**
   * Normalize customer data from database format to unified format
   */
  private normalizeCustomerData(data: any): Customer {
    return {
      id: data.id,
      name: data.name || data.full_name,
      full_name: data.full_name || data.name,
      phone: data.phone,
      email: data.email,
      loyalty_points: data.loyalty_points || 0,
      total_orders: data.total_orders || 0,
      last_order_date: data.last_order_date,
      addresses: data.customer_addresses?.map(this.normalizeAddressData) || [],
      version: data.version,
      updated_by: data.updated_by,
      last_synced_at: data.last_synced_at,
      created_at: data.created_at,
      updated_at: data.updated_at
    }
  }

  /**
   * Normalize address data from database format to unified format
   */
  private normalizeAddressData(data: any): CustomerAddress {
    return {
      id: data.id,
      customer_id: data.customer_id,
      street: data.street,
      street_address: data.street_address || data.street,
      city: data.city,
      postal_code: data.postal_code,
      country: data.country,
      floor_number: data.floor_number,
      address_type: data.address_type,
      is_default: data.is_default,
      delivery_notes: data.delivery_notes !== undefined ? data.delivery_notes : (data.notes !== undefined ? data.notes : null),
      notes: data.notes !== undefined ? data.notes : (data.delivery_notes !== undefined ? data.delivery_notes : null),
      version: data.version,
      created_at: data.created_at,
      updated_at: data.updated_at
    }
  }

  /**
   * Normalize conflict data
   */
  private normalizeConflictData(data: SupabaseConflict): CustomerConflict {
    return {
      id: data.id,
      customer_id: data.customer_id,
      local_version: data.local_version,
      remote_version: data.remote_version,
      local_data: data.local_data as any,
      remote_data: data.remote_data as any,
      conflict_type: data.conflict_type as ConflictType,
      resolution_strategy: data.resolution_strategy as ResolutionStrategy | null,
      resolved: data.resolved,
      resolved_at: data.resolved_at,
      resolved_by: data.resolved_by,
      terminal_id: data.terminal_id,
      created_at: data.created_at,
      updated_at: data.updated_at
    }
  }
}
