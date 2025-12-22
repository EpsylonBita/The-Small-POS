import type { BrowserWindow } from 'electron'
import type { SupabaseClient } from '@supabase/supabase-js'
import { getSupabaseClient } from '../shared/supabase-config'
import type { DatabaseManager } from '../main/database'
import { CustomerSyncService } from '../shared/services/CustomerSyncService'

/**
 * RealtimeCustomerHandler
 * Subscribes to customers and customer_addresses changes.
 */
export class RealtimeCustomerHandler {
  private branchId: string | null
  private terminalId: string
  private mainWindow: BrowserWindow | null
  private dbManager: DatabaseManager
  private channels: any[] = []
  private client: SupabaseClient
  private syncService: CustomerSyncService

  constructor(
    branchId: string | null,
    terminalId: string,
    mainWindow: BrowserWindow | null,
    dbManager: DatabaseManager
  ) {
    this.branchId = branchId
    this.terminalId = terminalId
    this.mainWindow = mainWindow
    this.dbManager = dbManager
    this.client = getSupabaseClient()
    // Initialize sync service for conflict detection and recording
    this.syncService = new CustomerSyncService(this.client as any, 'pos-system', {
      terminalId: this.terminalId,
      onConflict: (conflict) => {
        // Bubble conflict event to renderer
        this.emit('customer-sync-conflict', 'customer_sync_conflicts', { eventType: 'INSERT', new: conflict })
      }
    })
  }

  async initialize(): Promise<void> {
    // Customers
    const customersCh = this.client
      .channel(`customers_rt_${this.terminalId}_${Date.now()}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'customers' } as any,
        (payload) => this.handleCustomerChange(payload)
      )
      .subscribe()

    // Customer addresses
    const addressesCh = this.client
      .channel(`cust_addr_rt_${this.terminalId}_${Date.now()}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'customer_addresses' } as any,
        (payload) => this.handleCustomerAddressChange(payload)
      )
      .subscribe()

    this.channels.push(customersCh, addressesCh)
  }

  private async handleCustomerChange(payload: any) {
    // Supabase realtime uses 'eventType' property
    const eventType = payload.eventType || payload.event
    const customer = payload.new || payload.old

    // Sync to local DB
    if (customer) {
      try {
        await this.syncCustomerToLocalDB(customer, eventType)
      } catch (error) {
        console.error('[RealtimeCustomerHandler] Failed to sync customer to local DB:', error)
      }
    }

    // Map eventType to specific IPC events
    let ipcEvent = 'realtime-customer-update'
    if (eventType === 'INSERT') {
      ipcEvent = 'customer-created'
    } else if (eventType === 'UPDATE') {
      ipcEvent = 'customer-updated'
    } else if (eventType === 'DELETE') {
      ipcEvent = 'customer-deleted'
    }

    // Normalize payload to always include eventType
    const normalizedPayload = {
      ...payload,
      eventType: eventType
    }

    this.emit(ipcEvent, 'customers', normalizedPayload)
  }

  private async handleCustomerAddressChange(payload: any) {
    // Supabase realtime uses 'eventType' property
    const eventType = payload.eventType || payload.event
    const address = payload.new || payload.old

    // Sync to local DB
    if (address) {
      try {
        await this.syncAddressToLocalDB(address, eventType)
      } catch (error) {
        console.error('[RealtimeCustomerHandler] Failed to sync address to local DB:', error)
      }
    }

    // Map eventType to specific IPC events
    let ipcEvent = 'realtime-customer-address-update'
    if (eventType === 'INSERT') {
      ipcEvent = 'customer-address-created'
    } else if (eventType === 'UPDATE') {
      ipcEvent = 'customer-address-updated'
    } else if (eventType === 'DELETE') {
      ipcEvent = 'customer-address-deleted'
    }

    // Normalize payload to always include eventType
    const normalizedPayload = {
      ...payload,
      eventType: eventType
    }

    this.emit(ipcEvent, 'customer_addresses', normalizedPayload)
  }

  /**
   * Sync customer to local database
   * Uses CustomerDataService for durable local persistence
   */
  private async syncCustomerToLocalDB(customer: any, eventType: string): Promise<void> {
    try {
      // Get customer data service from database manager
      const customerService = this.dbManager.getDatabaseService().customers;

      if (!customerService) {
        console.warn('[RealtimeCustomerHandler] CustomerDataService not available');
        return;
      }

      if (eventType === 'INSERT' || eventType === 'UPDATE') {
        // Normalize customer data
        const normalizedCustomer = {
          id: customer.id,
          name: customer.full_name || customer.name,
          full_name: customer.full_name || customer.name,
          phone: customer.phone,
          email: customer.email,
          loyalty_points: customer.loyalty_points || 0,
          addresses: customer.customer_addresses || customer.addresses || [],
          created_at: customer.created_at,
          updated_at: customer.updated_at,
          total_orders: customer.total_orders || 0,
          last_order_date: customer.last_order_date,
          version: customer.version,
          updated_by: customer.updated_by,
          last_synced_at: new Date().toISOString(),
        };

        // Conflict detection against local cache
        const existing = await customerService.getCustomerById(customer.id);
        if (existing && existing.version !== undefined && normalizedCustomer.version !== undefined) {
          const hasConflict = this.syncService.detectConflict(
            existing.version,
            normalizedCustomer.version,
            existing,
            normalizedCustomer
          );

          if (hasConflict) {
            // Create conflict record and emit event; skip local upsert
            const conflictId = await this.syncService.createConflictRecord(
              customer.id,
              existing.version,
              normalizedCustomer.version,
              existing,
              normalizedCustomer,
              'version_mismatch'
            );
            this.emit('customer-sync-conflict', 'customer_sync_conflicts', { eventType: 'INSERT', new: { id: conflictId } });
            return;
          }
        }

        // Upsert to local DB (with optimistic locking inside)
        await customerService.upsertCustomer(normalizedCustomer);
        console.log(`[RealtimeCustomerHandler] Synced customer ${customer.id} to local DB`);
      } else if (eventType === 'DELETE') {
        // Soft delete customer
        await customerService.deleteCustomer(customer.id);
        console.log(`[RealtimeCustomerHandler] Deleted customer ${customer.id} from local DB`);
      }
    } catch (error) {
      console.error('[RealtimeCustomerHandler] Failed to sync customer to local DB:', error);
      // Don't throw - log and continue to avoid crashing on schema mismatches
    }
  }

  /**
   * Sync customer address to local database
   * Can upsert/delete addresses directly
   */
  private async syncAddressToLocalDB(address: any, eventType: string): Promise<void> {
    try {
      // Get customer data service
      const customerService = this.dbManager.getDatabaseService().customers;

      if (!customerService) {
        console.warn('[RealtimeCustomerHandler] CustomerDataService not available');
        return;
      }

      const customerId = address.customer_id;

      if (!customerId) {
        console.warn('[RealtimeCustomerHandler] Address missing customer_id, cannot sync');
        return;
      }

      if (eventType === 'INSERT' || eventType === 'UPDATE') {
        // Normalize address data
        const normalizedAddress = {
          id: address.id,
          customer_id: customerId,
          street: address.street_address || address.street,
          street_address: address.street_address || address.street,
          city: address.city,
          postal_code: address.postal_code,
          country: address.country,
          floor_number: address.floor_number,
          address_type: address.address_type,
          is_default: address.is_default,
          delivery_notes: address.delivery_notes,
          created_at: address.created_at,
          updated_at: address.updated_at,
          version: address.version
        };

        // Conflict detection for address using local snapshot
        const localCustomer = await this.dbManager.getDatabaseService().customers.getCustomerById(customerId);
        const localAddr = localCustomer?.addresses?.find((a: any) => a.id === address.id);
        if (localAddr && localAddr.version !== undefined && normalizedAddress.version !== undefined) {
          const hasConflict = this.syncService.detectConflict(
            localAddr.version,
            normalizedAddress.version,
            localAddr,
            normalizedAddress
          );
          if (hasConflict) {
            const conflictId = await this.syncService.createConflictRecord(
              customerId,
              localAddr.version,
              normalizedAddress.version,
              localAddr,
              normalizedAddress,
              'version_mismatch'
            );
            this.emit('customer-sync-conflict', 'customer_sync_conflicts', { eventType: 'INSERT', new: { id: conflictId } });
            return;
          }
        }

        // Upsert address
        await customerService.upsertAddress(normalizedAddress);
        console.log(`[RealtimeCustomerHandler] Synced address ${address.id} to local DB`);
      } else if (eventType === 'DELETE') {
        // Soft delete address
        await customerService.deleteAddress(address.id);
        console.log(`[RealtimeCustomerHandler] Deleted address ${address.id} from local DB`);
      }
    } catch (error) {
      console.error('[RealtimeCustomerHandler] Failed to sync address to local DB:', error);
      // Don't throw - log and continue to avoid crashing on schema mismatches
    }
  }

  async cleanup(): Promise<void> {
    try {
      for (const ch of this.channels) {
        try { this.client.removeChannel(ch) } catch {}
      }
    } finally {
      this.channels = []
    }
  }

  /**
   * Lookup customer by phone number
   * First queries local DB, then falls back to remote if not found
   */
  public async lookupCustomerByPhone(phone: string): Promise<any | null> {
    try {
      // Try local DB first
      const customerService = this.dbManager.getDatabaseService().customers;

      if (customerService) {
        const localCustomer = await customerService.lookupCustomerByPhone(phone);
        if (localCustomer) {
          console.log(`[RealtimeCustomerHandler] Found customer ${localCustomer.id} in local DB`);
          return localCustomer;
        }
      }

      // Fallback to remote Supabase query
      console.log(`[RealtimeCustomerHandler] Customer not found locally, querying Supabase...`);
      const { data: customer, error } = await this.client
        .from('customers')
        .select(`
          id,
          full_name,
          phone,
          email,
          loyalty_points,
          created_at,
          updated_at,
          version,
          updated_by,
          last_synced_at,
          customer_addresses (
            id,
            customer_id,
            street_address,
            city,
            postal_code,
            country,
            floor_number,
            address_type,
            is_default,
            delivery_notes,
            created_at,
            updated_at,
            version
          )
        `)
        .eq('phone', phone)
        .single();

      if (error || !customer) {
        console.log(`[RealtimeCustomerHandler] Customer not found for phone ${phone}`);
        return null;
      }

      // Cache the remote result locally
      await this.syncCustomerToLocalDB(customer, 'UPDATE');

      return customer;
    } catch (error) {
      console.error('[RealtimeCustomerHandler] Failed to lookup customer by phone:', error);
      return null;
    }
  }

  private emit(ipcChannel: string, table: string, payload: any) {
    try {
      // Validate payload before sending
      if (!payload || !payload.eventType) {
        console.warn(`[RealtimeCustomerHandler] Attempted to emit ${ipcChannel} with invalid payload:`, payload);
        return;
      }

      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send(ipcChannel, {
          eventType: payload.eventType,
          table,
          branchId: this.branchId,
          terminalId: this.terminalId,
          new: payload.new || null,
          old: payload.old || null,
        })
      }
    } catch (err) {
      console.error(`[RealtimeCustomerHandler] emit failed: ${ipcChannel}`, err)
    }
  }
}

