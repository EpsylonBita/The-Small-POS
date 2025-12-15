/**
 * CustomerSyncService (POS-local stub)
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export interface CustomerSyncOptions {
  terminalId?: string;
  organizationId?: string;
  onConflict?: (conflict: any) => void;
}

export class CustomerSyncService {
  private client: SupabaseClient;
  private source: string;
  private options: CustomerSyncOptions;

  constructor(client: SupabaseClient, source: string, options: CustomerSyncOptions = {}) {
    this.client = client;
    this.source = source;
    this.options = options;
  }

  /**
   * Normalize phone number to standard format
   */
  normalizePhone(phone: string): string {
    // Remove all non-digit characters
    return phone.replace(/\D/g, '');
  }

  async syncCustomer(customer: any): Promise<void> {
    // Stub - actual sync handled by main process
  }

  async createCustomer(customer: any): Promise<any> {
    // Stub - return the customer as-is
    return customer;
  }

  async updateCustomer(customerId: string, updates: any, currentVersion: number): Promise<any> {
    // Stub - return updates merged with id
    return { id: customerId, ...updates, version: currentVersion + 1 };
  }

  async addAddress(customerId: string, address: any): Promise<any> {
    // Stub - return address with generated id
    return { id: `addr-${Date.now()}`, customer_id: customerId, ...address };
  }

  async updateAddress(addressId: string, updates: any, currentVersion: number): Promise<any> {
    // Stub - return updates merged with id
    return { id: addressId, ...updates, version: currentVersion + 1 };
  }

  async detectConflicts(customerId: string): Promise<any[]> {
    return [];
  }

  detectConflict(
    localVersion: number,
    remoteVersion: number,
    localData: any,
    remoteData: any
  ): boolean {
    // Simple version comparison - conflict if versions differ
    return localVersion !== remoteVersion;
  }

  async createConflictRecord(
    customerId: string,
    localVersion: number,
    remoteVersion: number,
    localData: any,
    remoteData: any,
    conflictType: string
  ): Promise<string> {
    // Stub - return a fake conflict ID
    console.warn('[CustomerSyncService] Conflict detected but not recorded (stub):', {
      customerId,
      localVersion,
      remoteVersion,
      conflictType
    });
    return `conflict-${Date.now()}`;
  }
}
