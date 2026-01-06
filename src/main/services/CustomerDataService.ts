import Database from 'better-sqlite3';
import { BaseService } from './BaseService';
import type { Customer, CustomerAddress } from '../../shared/types/customer';

/**
 * CustomerDataService - Local SQLite persistence for customers and addresses
 * 
 * Provides durable local storage for customer data synced from Supabase.
 * Supports optimistic locking via version fields.
 */
export class CustomerDataService extends BaseService {
  constructor(database: Database.Database) {
    super(database);
    this.initializeTables();
  }

  /**
   * Initialize customers and customer_addresses tables
   */
  private initializeTables(): void {
    // Customers table
    this.db.prepare(`
      CREATE TABLE IF NOT EXISTS customers (
        id TEXT PRIMARY KEY,
        name TEXT,
        full_name TEXT,
        phone TEXT NOT NULL,
        email TEXT,
        loyalty_points INTEGER DEFAULT 0,
        total_orders INTEGER DEFAULT 0,
        last_order_date TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        version INTEGER DEFAULT 1,
        updated_by TEXT,
        last_synced_at TEXT,
        deleted_at TEXT,
        is_banned INTEGER DEFAULT 0,
        ban_reason TEXT,
        banned_at TEXT
      )
    `).run();

    // Add is_banned column if it doesn't exist (for existing databases)
    try {
      this.db.prepare(`ALTER TABLE customers ADD COLUMN is_banned INTEGER DEFAULT 0`).run();
    } catch (error: any) {
      // Column already exists, ignore error
      if (!error.message?.includes('duplicate column name')) {
        console.warn('Error adding is_banned column:', error);
      }
    }

    // Add address and postal_code columns if they don't exist (for delivery address fallback)
    try {
      this.db.prepare(`ALTER TABLE customers ADD COLUMN address TEXT`).run();
    } catch (error: any) {
      if (!error.message?.includes('duplicate column name')) {
        console.warn('Error adding address column:', error);
      }
    }
    try {
      this.db.prepare(`ALTER TABLE customers ADD COLUMN postal_code TEXT`).run();
    } catch (error: any) {
      if (!error.message?.includes('duplicate column name')) {
        console.warn('Error adding postal_code column:', error);
      }
    }

    // Add ban_reason column if it doesn't exist (for existing databases)
    try {
      this.db.prepare(`ALTER TABLE customers ADD COLUMN ban_reason TEXT`).run();
    } catch (error: any) {
      if (!error.message?.includes('duplicate column name')) {
        console.warn('Error adding ban_reason column:', error);
      }
    }

    // Add banned_at column if it doesn't exist (for existing databases)
    try {
      this.db.prepare(`ALTER TABLE customers ADD COLUMN banned_at TEXT`).run();
    } catch (error: any) {
      if (!error.message?.includes('duplicate column name')) {
        console.warn('Error adding banned_at column:', error);
      }
    }

    // Customer addresses table
    this.db.prepare(`
      CREATE TABLE IF NOT EXISTS customer_addresses (
        id TEXT PRIMARY KEY,
        customer_id TEXT NOT NULL,
        street TEXT NOT NULL,
        street_address TEXT,
        city TEXT NOT NULL,
        postal_code TEXT,
        country TEXT,
        floor_number TEXT,
        address_type TEXT DEFAULT 'delivery',
        is_default INTEGER DEFAULT 0,
        delivery_notes TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        version INTEGER DEFAULT 1,
        deleted_at TEXT,
        FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
      )
    `).run();

    // Create indexes
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers(phone);
      CREATE INDEX IF NOT EXISTS idx_customers_email ON customers(email);
      CREATE INDEX IF NOT EXISTS idx_customers_deleted ON customers(deleted_at);
      CREATE INDEX IF NOT EXISTS idx_customer_addresses_customer_id ON customer_addresses(customer_id);
      CREATE INDEX IF NOT EXISTS idx_customer_addresses_default ON customer_addresses(is_default);
    `);

    console.info('Customer data tables initialized');
  }

  /**
   * Upsert customer to local database
   * Implements optimistic locking via version field
   */
  public async upsertCustomer(customer: Partial<Customer>): Promise<void> {
    if (!customer.id || !customer.phone) {
      throw new Error('Customer must have id and phone');
    }

    try {
      // Check existing version for optimistic locking
      const existing = this.getCustomerById(customer.id);

      if (existing) {
        const localVersion = existing.version || 1;
        const remoteVersion = customer.version || 1;

        // Skip if remote is older than local
        if (remoteVersion < localVersion) {
          console.warn(`[CustomerDataService] Skipping update: remote version ${remoteVersion} < local ${localVersion}`);
          return;
        }

        // Skip if same version but local is newer by timestamp
        if (remoteVersion === localVersion && existing.updated_at && customer.updated_at) {
          if (existing.updated_at >= customer.updated_at) {
            console.warn(`[CustomerDataService] Skipping update: local timestamp is newer`);
            return;
          }
        }
      }

      // Upsert customer
      this.db.prepare(`
        INSERT OR REPLACE INTO customers (
          id, name, full_name, phone, email, address, postal_code, loyalty_points,
          total_orders, last_order_date, created_at, updated_at,
          version, updated_by, last_synced_at, is_banned, ban_reason, banned_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        customer.id,
        customer.name || customer.full_name,
        customer.full_name || customer.name,
        customer.phone,
        customer.email || null,
        (customer as any).address || null,
        (customer as any).postal_code || null,
        customer.loyalty_points || 0,
        customer.total_orders || 0,
        customer.last_order_date || null,
        customer.created_at || new Date().toISOString(),
        customer.updated_at || new Date().toISOString(),
        customer.version || 1,
        customer.updated_by || null,
        new Date().toISOString(),
        customer.is_banned ? 1 : 0,
        customer.ban_reason || null,
        customer.banned_at || null
      );

      // Upsert addresses if provided
      if (customer.addresses && Array.isArray(customer.addresses)) {
        for (const address of customer.addresses) {
          await this.upsertAddress({ ...address, customer_id: customer.id });
        }
      }

      console.log(`[CustomerDataService] Upserted customer ${customer.id}`);

      // Queue for sync to Supabase
      this.addToSyncQueue('customers', customer.id, existing ? 'update' : 'insert', {
        id: customer.id,
        full_name: customer.full_name || customer.name,
        name: customer.name || customer.full_name,
        phone: customer.phone,
        email: customer.email || null,
        address: (customer as any).address || null,
        postal_code: (customer as any).postal_code || null,
        loyalty_points: customer.loyalty_points || 0,
        total_orders: customer.total_orders || 0,
        last_order_date: customer.last_order_date || null,
        version: customer.version || 1,
        updated_by: customer.updated_by || 'pos-system',
        created_at: customer.created_at,
        updated_at: customer.updated_at
      });
    } catch (error) {
      console.error('[CustomerDataService] Failed to upsert customer:', error);
      throw error;
    }
  }

  /**
   * Upsert customer address to local database
   */
  public async upsertAddress(address: Partial<CustomerAddress>): Promise<void> {
    if (!address.id || !address.customer_id) {
      throw new Error('Address must have id and customer_id');
    }

    try {
      this.db.prepare(`
        INSERT OR REPLACE INTO customer_addresses (
          id, customer_id, street, street_address, city, postal_code,
          country, floor_number, address_type, is_default, delivery_notes,
          created_at, updated_at, version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        address.id,
        address.customer_id,
        address.street || null,
        address.street || null,
        address.city || '',
        address.postal_code || null,
        address.country || null,
        address.floor_number || null,
        address.address_type || 'delivery',
        address.is_default ? 1 : 0,
        address.delivery_notes || null,
        address.created_at || new Date().toISOString(),
        address.updated_at || new Date().toISOString(),
        address.version || 1
      );

      console.log(`[CustomerDataService] Upserted address ${address.id}`);

      // Queue for sync to Supabase
      this.addToSyncQueue('customer_addresses', address.id, 'update', {
        id: address.id,
        customer_id: address.customer_id,
        street_address: address.street,
        street: address.street,
        city: address.city || '',
        postal_code: address.postal_code || null,
        country: address.country || null,
        floor_number: address.floor_number || null,
        address_type: address.address_type || 'delivery',
        is_default: !!address.is_default,
        delivery_notes: address.delivery_notes || null,
        version: address.version || 1,
        created_at: address.created_at,
        updated_at: address.updated_at
      });
    } catch (error) {
      console.error('[CustomerDataService] Failed to upsert address:', error);
      throw error;
    }
  }

  /**
   * Delete customer (soft delete by setting deleted_at)
   */
  public async deleteCustomer(customerId: string): Promise<void> {
    try {
      this.db.prepare(`
        UPDATE customers
        SET deleted_at = ?
        WHERE id = ?
      `).run(new Date().toISOString(), customerId);

      console.log(`[CustomerDataService] Soft-deleted customer ${customerId}`);
    } catch (error) {
      console.error('[CustomerDataService] Failed to delete customer:', error);
      throw error;
    }
  }

  /**
   * Delete address (soft delete by setting deleted_at)
   */
  public async deleteAddress(addressId: string): Promise<void> {
    try {
      this.db.prepare(`
        UPDATE customer_addresses
        SET deleted_at = ?
        WHERE id = ?
      `).run(new Date().toISOString(), addressId);

      console.log(`[CustomerDataService] Soft-deleted address ${addressId}`);
    } catch (error) {
      console.error('[CustomerDataService] Failed to delete address:', error);
      throw error;
    }
  }

  /**
   * Get customer by ID
   */
  public getCustomerById(customerId: string): Customer | null {
    try {
      const row = this.db.prepare(`
        SELECT * FROM customers
        WHERE id = ? AND deleted_at IS NULL
      `).get(customerId) as any;

      if (!row) return null;

      // Get addresses
      const addresses = this.getCustomerAddresses(customerId);

      return this.normalizeCustomer(row, addresses);
    } catch (error) {
      console.error('[CustomerDataService] Failed to get customer by ID:', error);
      return null;
    }
  }

  /**
   * Lookup customer by phone number
   */
  public async lookupCustomerByPhone(phone: string): Promise<Customer | null> {
    try {
      const row = this.db.prepare(`
        SELECT * FROM customers
        WHERE phone = ? AND deleted_at IS NULL
        LIMIT 1
      `).get(phone) as any;

      if (!row) return null;

      // Get addresses
      const addresses = this.getCustomerAddresses(row.id);

      return this.normalizeCustomer(row, addresses);
    } catch (error) {
      console.error('[CustomerDataService] Failed to lookup customer by phone:', error);
      return null;
    }
  }

  /**
   * Get customer addresses
   */
  private getCustomerAddresses(customerId: string): CustomerAddress[] {
    try {
      const rows = this.db.prepare(`
        SELECT * FROM customer_addresses
        WHERE customer_id = ? AND deleted_at IS NULL
        ORDER BY is_default DESC, created_at ASC
      `).all(customerId) as any[];

      return rows.map(row => ({
        id: row.id,
        customer_id: row.customer_id,
        street: row.street || row.street_address,
        street_address: row.street_address || row.street,
        city: row.city,
        postal_code: row.postal_code,
        country: row.country,
        floor_number: row.floor_number,
        address_type: row.address_type,
        is_default: Boolean(row.is_default),
        delivery_notes: row.delivery_notes,
        created_at: row.created_at,
        updated_at: row.updated_at,
        version: row.version
      }));
    } catch (error) {
      console.error('[CustomerDataService] Failed to get customer addresses:', error);
      return [];
    }
  }

  /**
   * Normalize customer data from DB row
   */
  private normalizeCustomer(row: any, addresses: CustomerAddress[]): Customer {
    return {
      id: row.id,
      name: row.name || row.full_name,
      full_name: row.full_name || row.name,
      phone: row.phone,
      email: row.email,
      // Include legacy address field for delivery order fallback
      address: row.address || null,
      postal_code: row.postal_code || null,
      loyalty_points: row.loyalty_points || 0,
      addresses,
      created_at: row.created_at,
      updated_at: row.updated_at,
      total_orders: row.total_orders || 0,
      last_order_date: row.last_order_date,
      version: row.version,
      updated_by: row.updated_by,
      last_synced_at: row.last_synced_at,
      is_banned: Boolean(row.is_banned),
      ban_reason: row.ban_reason || null,
      banned_at: row.banned_at || null
    };
  }
}

