// Shared customer type definitions for the POS system
// Used by both main and renderer processes

/**
 * CustomerAddress - Address information for a customer
 *
 * Maps to Supabase customer_addresses table:
 * - street_address is the canonical field (matches DB column)
 * - street is a deprecated alias kept for backward compatibility
 * - customer_id is the foreign key to customers table
 * - address_type: 'delivery' | 'home' | 'work' | 'other'
 */
export interface CustomerAddress {
  id: string;
  customer_id?: string;
  /** Canonical field matching the Supabase `street_address` column. */
  street_address: string;
  /** @deprecated Use `street_address` instead. Kept as alias for backward compatibility. */
  street?: string;
  city: string;
  postal_code: string;
  country?: string;
  floor_number?: string;
  address_type?: 'delivery' | 'home' | 'work' | 'other';
  is_default: boolean;
  delivery_notes?: string;
  notes?: string; // Alias for delivery_notes (Supabase field name)
  name_on_ringer?: string; // Name to display on delivery ringer
  coordinates?:
    | { lat: number; lng: number }
    | { type: 'Point'; coordinates: [number, number] }
    | null;
  latitude?: number | null;
  longitude?: number | null;
  created_at?: string;
  updated_at?: string;
  // Sync metadata
  version?: number;
}

/**
 * Customer - Main customer entity
 * 
 * Data normalization:
 * - name is normalized from Supabase full_name field
 * - full_name is the Supabase field name (kept for compatibility)
 * - addresses array comes from customer_addresses table join
 * - total_orders and last_order_date are computed fields (not in DB)
 * 
 * Optional fields may not be present depending on data source:
 * - Admin API may return different fields than Supabase
 * - SQLite cache stores the full normalized object
 */
export interface Customer {
  id: string;
  name: string; // Normalized from full_name
  full_name?: string; // Supabase field name
  phone: string;
  email?: string;
  // Legacy address field (simple string) - used for delivery fallback
  address?: string | null;
  postal_code?: string | null;
  loyalty_points?: number;
  addresses?: CustomerAddress[];
  created_at?: string;
  updated_at?: string;
  total_orders?: number; // Computed field
  last_order_date?: string; // Computed field
  is_banned?: boolean; // Ban status
  ban_reason?: string; // Reason for banning the customer
  banned_at?: string; // Timestamp when customer was banned
  // Ringer name - name displayed on doorbell for delivery
  name_on_ringer?: string;
  ringer_name?: string; // Alias for name_on_ringer (Supabase field name)
  coordinates?:
    | { lat: number; lng: number }
    | { type: 'Point'; coordinates: [number, number] }
    | null;
  latitude?: number | null;
  longitude?: number | null;
  // Branch association
  branch_id?: string;
  // Sync metadata
  version?: number;
  updated_by?: string;
  last_synced_at?: string;
}

export interface CustomerInfo {
  name: string;
  phone: string;
  email?: string;
  address?: {
    street: string;
    city: string;
    postalCode: string;
    coordinates?: {
      lat: number;
      lng: number;
    };
  };
  notes?: string;
}

export interface CustomerLookupResult {
  found: boolean;
  customer?: Customer;
  isNew?: boolean;
}

export interface CustomerSearchHistory {
  phone: string;
  timestamp: string;
  found: boolean;
}

/**
 * Normalize a raw address object so that `street_address` is always populated.
 * Maps the legacy `street` field into `street_address` when the canonical field
 * is missing or empty. Use at sync/API boundaries.
 */
export function normalizeCustomerAddressFields<
  T extends Partial<Pick<CustomerAddress, 'street' | 'street_address'>>,
>(address: T): T & { street_address: string } {
  const streetAddress =
    (address.street_address ?? '').trim() ||
    (address.street ?? '').trim();
  return { ...address, street_address: streetAddress, street: streetAddress };
}

// Re-export commonly used customer types
export type { Customer as CustomerType };
export type { CustomerInfo as CustomerInfoType };
export type { CustomerAddress as AddressType };

