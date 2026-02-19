/**
 * DatabaseManager stub for Tauri.
 * In Electron, this wraps better-sqlite3 in the main process.
 * In Tauri, the SQLite database is managed by the Rust backend.
 * This stub exists only to satisfy TypeScript imports from copied services.
 */

export class DatabaseManager {
  get db(): unknown {
    throw new Error('DatabaseManager is not available in Tauri. Use Rust-side SQLite.');
  }

  getDatabaseService(): any {
    throw new Error('DatabaseManager is not available in Tauri. Use Rust-side SQLite.');
  }
}

// Re-export placeholder types
export interface Order {
  id: string;
  [key: string]: any;
}

export interface OrderItem {
  id: string;
  [key: string]: any;
}

export interface StaffSession {
  id: string;
  [key: string]: any;
}

export interface SyncQueue {
  id: string;
  [key: string]: any;
}

export interface LocalSettings {
  [key: string]: any;
}

export interface POSLocalConfig {
  [key: string]: any;
}

export interface PaymentTransaction {
  id: string;
  [key: string]: any;
}

export interface PaymentReceipt {
  id: string;
  [key: string]: any;
}

export interface PaymentRefund {
  id: string;
  [key: string]: any;
}
