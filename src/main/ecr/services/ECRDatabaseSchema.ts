/**
 * ECR Database Schema
 *
 * SQLite schema for ECR device configuration and transaction storage.
 *
 * @module ecr/services/ECRDatabaseSchema
 */

import type Database from 'better-sqlite3';

/**
 * Initialize ECR database tables
 */
export function initializeECRSchema(db: Database.Database): void {
  // ECR Devices table
  db.exec(`
    CREATE TABLE IF NOT EXISTS ecr_devices (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      device_type TEXT NOT NULL CHECK (device_type IN ('payment_terminal', 'cash_drawer')),
      connection_type TEXT NOT NULL CHECK (connection_type IN ('bluetooth', 'serial_usb', 'network')),
      connection_details TEXT NOT NULL,
      protocol TEXT DEFAULT 'generic' CHECK (protocol IN ('generic', 'zvt', 'pax')),
      terminal_id TEXT,
      merchant_id TEXT,
      is_default INTEGER DEFAULT 0,
      enabled INTEGER DEFAULT 1,
      settings TEXT DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // ECR Transactions table
  db.exec(`
    CREATE TABLE IF NOT EXISTS ecr_transactions (
      id TEXT PRIMARY KEY,
      device_id TEXT NOT NULL,
      order_id TEXT,
      transaction_type TEXT NOT NULL CHECK (transaction_type IN ('sale', 'refund', 'void', 'pre_auth', 'pre_auth_completion')),
      amount INTEGER NOT NULL,
      tip_amount INTEGER,
      currency TEXT DEFAULT 'EUR',
      status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'approved', 'declined', 'error', 'timeout', 'cancelled')),
      authorization_code TEXT,
      terminal_reference TEXT,
      card_type TEXT,
      card_last_four TEXT,
      entry_method TEXT,
      cardholder_name TEXT,
      customer_receipt_data TEXT,
      merchant_receipt_data TEXT,
      error_message TEXT,
      error_code TEXT,
      raw_response TEXT,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (device_id) REFERENCES ecr_devices(id) ON DELETE CASCADE
    )
  `);

  // Indexes for faster queries
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_ecr_transactions_device_id ON ecr_transactions(device_id);
    CREATE INDEX IF NOT EXISTS idx_ecr_transactions_order_id ON ecr_transactions(order_id);
    CREATE INDEX IF NOT EXISTS idx_ecr_transactions_status ON ecr_transactions(status);
    CREATE INDEX IF NOT EXISTS idx_ecr_transactions_started_at ON ecr_transactions(started_at);
  `);
}

/**
 * Check if ECR schema is initialized
 */
export function isECRSchemaInitialized(db: Database.Database): boolean {
  const result = db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type='table' AND name='ecr_devices'
  `).get();
  return !!result;
}
