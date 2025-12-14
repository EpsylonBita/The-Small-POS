/**
 * CustomerSyncService (POS-local stub)
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export interface CustomerSyncOptions {
  terminalId?: string;
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

  async syncCustomer(customer: any): Promise<void> {
    // Stub - actual sync handled by main process
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
