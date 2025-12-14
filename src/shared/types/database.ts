// Database types for POS System
// Simplified version focusing on POS-specific needs

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

// Sync queue interface
export interface SyncQueue {
  id: string;
  table_name: string;
  record_id: string;
  operation: 'INSERT' | 'UPDATE' | 'DELETE';
  data: Json;
  created_at: string;
  synced_at?: string;
  sync_status: 'pending' | 'synced' | 'failed';
  retry_count: number;
  error_message?: string;
}

// Sync result interface
export interface SyncResult {
  success: boolean;
  synced_count: number;
  failed_count: number;
  errors: string[];
}

// Local settings interface
export interface LocalSettings {
  id: string;
  setting_category: string;
  setting_key: string;
  setting_value: string; // JSON string
  last_sync: string;
  created_at: string;
  updated_at: string;
}

// POS configuration interface
export interface POSLocalConfig {
  id: string;
  terminal_id: string;
  config_key: string;
  config_value: string;
  last_sync: string;
  created_at: string;
  updated_at: string;
}

// Setting categories
export type SettingCategory = 
  | 'terminal' 
  | 'printer' 
  | 'tax' 
  | 'discount' 
  | 'receipt' 
  | 'payment' 
  | 'inventory' 
  | 'staff' 
  | 'restaurant';

// Payment transaction interface
export interface PaymentTransaction {
  id: string;
  order_id: string;
  amount: number;
  payment_method: string;
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'refunded';
  transaction_id?: string;
  processed_at?: string;
  created_at: string;
  updated_at: string;
}

// Payment receipt interface
export interface PaymentReceipt {
  id: string;
  transaction_id: string;
  receipt_data: Json;
  printed_at?: string;
  created_at: string;
}

// Payment refund interface
export interface PaymentRefund {
  id: string;
  transaction_id: string;
  amount: number;
  reason?: string;
  processed_at?: string;
  created_at: string;
}
