-- POS System Local SQLite Database Schema
-- This file documents the schema applied by DatabaseService.ts
-- Last updated: 2026-01-11

-- ============================================================================
-- FOREIGN KEY STRATEGY
-- ============================================================================
-- Foreign keys are ENABLED globally (PRAGMA foreign_keys = ON)
--
-- TABLE CATEGORIES:
-- 1. Supabase-Managed: Tables synced from cloud (staff, customers, subcategories_cache)
--    - References TO these tables have NO FK constraints
--    - Data may not exist locally when referenced
--
-- 2. Local-Only: Tables created entirely locally (orders, payment_*, sync_queue)
--    - FK constraints ENFORCED between local tables
--    - CASCADE DELETE for child records
--
-- 3. Hybrid: Tables with both local and Supabase references
--    - staff_shifts, driver_earnings, shift_expenses, staff_payments
--    - FKs only on local table references
--    - Supabase references (staff_id, driver_id) have NO FK
--
-- See: docs/database/sqlite-foreign-keys-strategy.md

-- ============================================================================
-- ORDERS TABLE (Local-Only)
-- ============================================================================
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  order_number TEXT UNIQUE NOT NULL,
  status TEXT NOT NULL,
  items TEXT NOT NULL,
  total_amount REAL NOT NULL,
  customer_name TEXT,
  customer_phone TEXT,
  customer_email TEXT,
  order_type TEXT NOT NULL,
  table_number TEXT,
  delivery_address TEXT,
  delivery_city TEXT,
  delivery_postal_code TEXT,
  delivery_floor TEXT,
  delivery_notes TEXT,
  name_on_ringer TEXT,
  special_instructions TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  estimated_time INTEGER,
  supabase_id TEXT,
  sync_status TEXT DEFAULT 'pending',
  payment_status TEXT DEFAULT 'pending',
  payment_method TEXT,
  payment_transaction_id TEXT,
  -- Versioning and sync metadata (added for conflict resolution)
  version INTEGER DEFAULT 1 NOT NULL,
  updated_by TEXT,
  last_synced_at TEXT,
  remote_version INTEGER,
  -- Hybrid Sync Routing Metadata
  routing_path TEXT, -- 'main', 'via_parent', 'direct_cloud'
  source_terminal_id TEXT, -- Original terminal ID if forwarded
  forwarded_at TEXT, -- Timestamp when forwarded
  -- Driver assignment (driver_id references Supabase - NO FK)
  driver_id TEXT,
  driver_name TEXT,
  staff_shift_id TEXT,
  staff_id TEXT, -- References Supabase staff - NO FK
  -- Discounts and tips
  discount_percentage REAL,
  discount_amount REAL,
  tip_amount REAL
);

CREATE INDEX IF NOT EXISTS idx_orders_sync_status ON orders(sync_status);
CREATE INDEX IF NOT EXISTS idx_orders_version ON orders(id, version);
CREATE INDEX IF NOT EXISTS idx_orders_supabase_id ON orders(supabase_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at);

-- ============================================================================
-- PAYMENT TRANSACTIONS TABLE (Local-Only)
-- FK: order_id -> orders(id) ON DELETE CASCADE
-- ============================================================================
CREATE TABLE IF NOT EXISTS payment_transactions (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  amount REAL NOT NULL,
  payment_method TEXT NOT NULL,
  status TEXT NOT NULL,
  gateway_transaction_id TEXT,
  gateway_response TEXT,
  processed_at TEXT NOT NULL,
  refunded_amount REAL DEFAULT 0,
  metadata TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_payment_transactions_order_id ON payment_transactions(order_id);
CREATE INDEX IF NOT EXISTS idx_payment_transactions_status ON payment_transactions(status);
CREATE INDEX IF NOT EXISTS idx_payment_transactions_created_at ON payment_transactions(created_at);

-- ============================================================================
-- PAYMENT RECEIPTS TABLE (Local-Only)
-- FK: transaction_id -> payment_transactions(id) ON DELETE CASCADE
-- ============================================================================
CREATE TABLE IF NOT EXISTS payment_receipts (
  id TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL,
  receipt_number TEXT UNIQUE NOT NULL,
  order_details TEXT NOT NULL,
  subtotal REAL NOT NULL,
  tax REAL NOT NULL,
  delivery_fee REAL DEFAULT 0,
  total_amount REAL NOT NULL,
  payment_method TEXT NOT NULL,
  cash_received REAL,
  change_given REAL,
  printed BOOLEAN DEFAULT FALSE,
  emailed BOOLEAN DEFAULT FALSE,
  email_address TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (transaction_id) REFERENCES payment_transactions(id) ON DELETE CASCADE
);

-- ============================================================================
-- PAYMENT REFUNDS TABLE (Local-Only)
-- FK: transaction_id -> payment_transactions(id) ON DELETE CASCADE
-- ============================================================================
CREATE TABLE IF NOT EXISTS payment_refunds (
  id TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL,
  amount REAL NOT NULL,
  reason TEXT,
  status TEXT NOT NULL,
  gateway_refund_id TEXT,
  processed_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (transaction_id) REFERENCES payment_transactions(id) ON DELETE CASCADE
);

-- ============================================================================
-- SYNC QUEUE TABLE (Local-Only, no FKs - references any table by name)
-- ============================================================================
CREATE TABLE IF NOT EXISTS sync_queue (
  id TEXT PRIMARY KEY,
  table_name TEXT NOT NULL,
  record_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('insert', 'update', 'delete')),
  data TEXT NOT NULL,
  created_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_attempt TEXT,
  error_message TEXT,
  -- Retry scheduling (added for exponential backoff)
  next_retry_at TEXT,
  retry_delay_ms INTEGER DEFAULT 5000,
  -- Conflict tracking
  has_conflict INTEGER DEFAULT 0,
  conflict_id TEXT,
  -- Routing Metadata
  routing_attempt INTEGER DEFAULT 0,
  routing_path TEXT
);

CREATE INDEX IF NOT EXISTS idx_sync_queue_next_retry ON sync_queue(next_retry_at);
CREATE INDEX IF NOT EXISTS idx_sync_queue_conflict ON sync_queue(has_conflict);
CREATE INDEX IF NOT EXISTS idx_sync_queue_attempts ON sync_queue(attempts);
CREATE INDEX IF NOT EXISTS idx_sync_queue_created_at ON sync_queue(created_at);
CREATE INDEX IF NOT EXISTS idx_sync_queue_table_record ON sync_queue(table_name, record_id);

-- ============================================================================
-- ORDER SYNC CONFLICTS TABLE (Local-Only)
-- ============================================================================
CREATE TABLE IF NOT EXISTS order_sync_conflicts (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  local_version INTEGER NOT NULL,
  remote_version INTEGER NOT NULL,
  local_data TEXT NOT NULL,
  remote_data TEXT NOT NULL,
  conflict_type TEXT NOT NULL CHECK (conflict_type IN ('version_mismatch', 'simultaneous_update', 'pending_local_changes')),
  resolution_strategy TEXT CHECK (resolution_strategy IN ('local_wins', 'remote_wins', 'manual_merge', 'force_update')),
  resolved INTEGER DEFAULT 0,
  resolved_at TEXT,
  resolved_by TEXT,
  terminal_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_conflicts_unresolved ON order_sync_conflicts(resolved, created_at);
CREATE INDEX IF NOT EXISTS idx_conflicts_order ON order_sync_conflicts(order_id);
CREATE INDEX IF NOT EXISTS idx_conflicts_terminal ON order_sync_conflicts(terminal_id);

-- ============================================================================
-- TERMINAL SETTINGS TABLE (Supabase-Managed cache)
-- ============================================================================
CREATE TABLE IF NOT EXISTS terminal_settings (
  terminal_id TEXT PRIMARY KEY,
  branch_id TEXT,
  organization_id TEXT,
  business_type TEXT,
  settings TEXT NOT NULL,
  version INTEGER DEFAULT 1,
  updated_at TEXT NOT NULL,
  synced_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_terminal_settings_organization ON terminal_settings(organization_id);

-- ============================================================================
-- STAFF TABLE (Supabase-Managed cache)
-- ============================================================================
CREATE TABLE IF NOT EXISTS staff (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  staff_code TEXT UNIQUE,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  email TEXT UNIQUE,
  phone TEXT,
  role_id TEXT,
  branch_id TEXT,
  department TEXT,
  employment_type TEXT DEFAULT 'full-time',
  hire_date TEXT,
  hourly_rate REAL,
  pin_hash TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  can_login_pos INTEGER NOT NULL DEFAULT 1,
  last_login_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_staff_branch ON staff(branch_id);
CREATE INDEX IF NOT EXISTS idx_staff_role ON staff(role_id);
CREATE INDEX IF NOT EXISTS idx_staff_active ON staff(is_active);

-- ============================================================================
-- STAFF SESSIONS TABLE (Hybrid)
-- Note: staff_id references Supabase staff - NO FK constraint
-- ============================================================================
CREATE TABLE IF NOT EXISTS staff_sessions (
  id TEXT PRIMARY KEY,
  staff_id TEXT NOT NULL, -- References Supabase staff - NO FK
  pin_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'staff')),
  login_time TEXT NOT NULL,
  logout_time TEXT,
  is_active BOOLEAN NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_staff_sessions_staff_id ON staff_sessions(staff_id);
CREATE INDEX IF NOT EXISTS idx_staff_sessions_active ON staff_sessions(is_active);

-- ============================================================================
-- STAFF SHIFTS TABLE (Hybrid)
-- Note: staff_id references Supabase staff - NO FK constraint
-- This table IS referenced by other local tables (driver_earnings, etc.)
-- ============================================================================
CREATE TABLE IF NOT EXISTS staff_shifts (
  id TEXT PRIMARY KEY,
  staff_id TEXT NOT NULL, -- References Supabase staff - NO FK
  staff_name TEXT,
  branch_id TEXT,
  terminal_id TEXT,
  role_type TEXT NOT NULL CHECK (role_type IN ('cashier', 'manager', 'driver', 'kitchen', 'server')),
  check_in_time TEXT NOT NULL,
  check_out_time TEXT,
  scheduled_start TEXT,
  scheduled_end TEXT,
  opening_cash_amount REAL DEFAULT 0,
  closing_cash_amount REAL,
  expected_cash_amount REAL,
  cash_variance REAL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed', 'abandoned')),
  total_orders_count INTEGER DEFAULT 0,
  total_sales_amount REAL DEFAULT 0,
  total_cash_sales REAL DEFAULT 0,
  total_card_sales REAL DEFAULT 0,
  payment_amount REAL,
  calculation_version INTEGER DEFAULT 2,
  is_day_start INTEGER DEFAULT 0,
  is_transfer_pending INTEGER DEFAULT 0,
  notes TEXT,
  closed_by TEXT,
  transferred_to_cashier_shift_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_staff_shifts_staff ON staff_shifts(staff_id);
CREATE INDEX IF NOT EXISTS idx_staff_shifts_branch ON staff_shifts(branch_id);
CREATE INDEX IF NOT EXISTS idx_staff_shifts_status ON staff_shifts(status);
CREATE INDEX IF NOT EXISTS idx_staff_shifts_check_in ON staff_shifts(check_in_time);
CREATE INDEX IF NOT EXISTS idx_staff_shifts_role_type ON staff_shifts(role_type);
CREATE INDEX IF NOT EXISTS idx_staff_shifts_terminal ON staff_shifts(terminal_id);

-- ============================================================================
-- CASH DRAWER SESSIONS TABLE (Hybrid)
-- FK: staff_shift_id -> staff_shifts(id) ON DELETE CASCADE
-- Note: cashier_id references Supabase staff - NO FK
-- ============================================================================
CREATE TABLE IF NOT EXISTS cash_drawer_sessions (
  id TEXT PRIMARY KEY,
  staff_shift_id TEXT NOT NULL UNIQUE,
  cashier_id TEXT NOT NULL, -- References Supabase staff - NO FK
  branch_id TEXT NOT NULL,
  terminal_id TEXT NOT NULL,
  opening_amount REAL NOT NULL DEFAULT 0,
  closing_amount REAL,
  expected_amount REAL,
  variance_amount REAL,
  total_cash_sales REAL DEFAULT 0,
  total_card_sales REAL DEFAULT 0,
  total_refunds REAL DEFAULT 0,
  total_expenses REAL DEFAULT 0,
  cash_drops REAL DEFAULT 0,
  driver_cash_given REAL DEFAULT 0,
  driver_cash_returned REAL DEFAULT 0,
  total_staff_payments REAL DEFAULT 0,
  opened_at TEXT NOT NULL,
  closed_at TEXT,
  reconciled INTEGER DEFAULT 0,
  reconciled_at TEXT,
  reconciled_by TEXT,
  reconciliation_notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(staff_shift_id) REFERENCES staff_shifts(id) ON DELETE CASCADE,
  CHECK(closed_at IS NULL OR closed_at >= opened_at),
  CHECK(reconciled = 0 OR(reconciled_at IS NOT NULL AND reconciled_by IS NOT NULL))
);

-- ============================================================================
-- SHIFT EXPENSES TABLE (Hybrid)
-- FK: staff_shift_id -> staff_shifts(id) ON DELETE CASCADE
-- Note: staff_id references Supabase staff - NO FK
-- ============================================================================
CREATE TABLE IF NOT EXISTS shift_expenses (
  id TEXT PRIMARY KEY,
  staff_shift_id TEXT NOT NULL,
  staff_id TEXT NOT NULL, -- References Supabase staff - NO FK
  branch_id TEXT NOT NULL,
  expense_type TEXT NOT NULL CHECK(expense_type IN('supplies', 'maintenance', 'petty_cash', 'refund', 'other')),
  amount REAL NOT NULL,
  description TEXT NOT NULL,
  receipt_number TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN('pending', 'approved', 'rejected')),
  approved_by TEXT,
  approved_at TEXT,
  rejection_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(staff_shift_id) REFERENCES staff_shifts(id) ON DELETE CASCADE,
  CHECK(status != 'approved' OR(approved_by IS NOT NULL AND approved_at IS NOT NULL)),
  CHECK(status != 'rejected' OR rejection_reason IS NOT NULL)
);

-- ============================================================================
-- DRIVER EARNINGS TABLE (Hybrid)
-- FK: staff_shift_id -> staff_shifts(id) ON DELETE SET NULL
-- FK: order_id -> orders(id) ON DELETE CASCADE
-- Note: driver_id references Supabase staff - NO FK
-- ============================================================================
CREATE TABLE IF NOT EXISTS driver_earnings (
  id TEXT PRIMARY KEY,
  driver_id TEXT NOT NULL, -- References Supabase staff - NO FK
  staff_shift_id TEXT,
  order_id TEXT UNIQUE NOT NULL,
  branch_id TEXT NOT NULL,
  delivery_fee REAL DEFAULT 0,
  tip_amount REAL DEFAULT 0,
  total_earning REAL NOT NULL,
  payment_method TEXT NOT NULL CHECK(payment_method IN('cash', 'card', 'mixed')),
  cash_collected REAL DEFAULT 0,
  card_amount REAL DEFAULT 0,
  cash_to_return REAL DEFAULT 0,
  order_details TEXT,
  settled INTEGER DEFAULT 0,
  settled_at TEXT,
  settlement_batch_id TEXT,
  is_transferred INTEGER DEFAULT 0,
  supabase_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(staff_shift_id) REFERENCES staff_shifts(id) ON DELETE SET NULL,
  FOREIGN KEY(order_id) REFERENCES orders(id) ON DELETE CASCADE,
  CHECK(total_earning = delivery_fee + tip_amount),
  CHECK(settled = 0 OR settled_at IS NOT NULL)
);

-- ============================================================================
-- STAFF PAYMENTS TABLE (Hybrid)
-- FK: staff_shift_id -> staff_shifts(id) ON DELETE SET NULL
-- FK: paid_by_cashier_shift_id -> staff_shifts(id) ON DELETE CASCADE
-- Note: paid_to_staff_id references Supabase staff - NO FK
-- ============================================================================
CREATE TABLE IF NOT EXISTS staff_payments (
  id TEXT PRIMARY KEY,
  staff_shift_id TEXT,
  paid_to_staff_id TEXT NOT NULL, -- References Supabase staff - NO FK
  paid_by_cashier_shift_id TEXT NOT NULL,
  amount REAL NOT NULL CHECK (amount > 0),
  payment_type TEXT NOT NULL CHECK (payment_type IN ('wage', 'tip', 'bonus', 'advance', 'other')),
  notes TEXT,
  supabase_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (staff_shift_id) REFERENCES staff_shifts(id) ON DELETE SET NULL,
  FOREIGN KEY (paid_by_cashier_shift_id) REFERENCES staff_shifts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_staff_payments_staff_shift ON staff_payments(staff_shift_id);
CREATE INDEX IF NOT EXISTS idx_staff_payments_paid_to ON staff_payments(paid_to_staff_id);
CREATE INDEX IF NOT EXISTS idx_staff_payments_paid_by ON staff_payments(paid_by_cashier_shift_id);
CREATE INDEX IF NOT EXISTS idx_staff_payments_created_at ON staff_payments(created_at);
CREATE INDEX IF NOT EXISTS idx_staff_payments_payment_type ON staff_payments(payment_type);

-- ============================================================================
-- SUBCATEGORIES CACHE TABLE (Supabase-Managed cache)
-- ============================================================================
CREATE TABLE IF NOT EXISTS subcategories_cache (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  name_en TEXT,
  name_el TEXT,
  category_id TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_subcategories_cache_updated ON subcategories_cache(updated_at);
CREATE INDEX IF NOT EXISTS idx_subcategories_cache_category ON subcategories_cache(category_id);

-- ============================================================================
-- ORDER RETRY QUEUE TABLE (Local-Only, no FKs - stores serialized data)
-- ============================================================================
CREATE TABLE IF NOT EXISTS order_retry_queue (
  id TEXT PRIMARY KEY,
  order_data TEXT NOT NULL,
  created_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_attempt TEXT,
  error_message TEXT
);

CREATE INDEX IF NOT EXISTS idx_order_retry_queue_attempts ON order_retry_queue(attempts);
CREATE INDEX IF NOT EXISTS idx_order_retry_queue_created_at ON order_retry_queue(created_at);

-- ============================================================================
-- LOCAL SETTINGS CACHE TABLE (Local-Only)
-- ============================================================================
CREATE TABLE IF NOT EXISTS local_settings (
  id TEXT PRIMARY KEY,
  setting_category TEXT NOT NULL,
  setting_key TEXT NOT NULL,
  setting_value TEXT NOT NULL,
  last_sync TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(setting_category, setting_key)
);

-- ============================================================================
-- POS LOCAL CONFIG TABLE (Local-Only)
-- ============================================================================
CREATE TABLE IF NOT EXISTS pos_local_config (
  id TEXT PRIMARY KEY,
  terminal_id TEXT NOT NULL,
  config_key TEXT NOT NULL,
  config_value TEXT NOT NULL,
  last_sync TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(terminal_id, config_key)
);

-- ============================================================================
-- MIGRATION NOTES
-- ============================================================================
-- Version 1.0 (Initial schema)
-- - Basic orders, sync_queue, payment tables
--
-- Version 2.0 (2025-01-14 - Conflict Resolution)
-- - Added version, updated_by, last_synced_at, remote_version to orders
-- - Added next_retry_at, retry_delay_ms, has_conflict, conflict_id to sync_queue
-- - Created order_sync_conflicts table
-- - Added indexes for performance
--
-- Version 3.0 (2025-11-15 - Multi-Tenant Support)
-- - Added terminal_settings table for caching Supabase configuration
-- - Added organization_id column to terminal_settings for multi-tenant isolation
-- - Organization ID is derived from branches.organization_id via branch_id
-- - Cached locally for offline operation and reduced API calls
-- - Used in all API requests to ensure organization-scoped data access
-- - Added business_type column to terminal_settings for caching organization vertical type
-- - Business type is derived from organizations.business_type via organization_id
-- - Used by POS to determine which modules and UI layouts to display
--
-- DEFAULT BUSINESS TYPE:
-- When an organization exists but has no resolvable business_type (null in database)
-- and there is no cached value, the system defaults to 'fast_food'.
-- This ensures terminals receive a reasonable module set for new installs.
-- Administrators should configure the correct business_type via the admin dashboard.
-- The POS will emit a 'terminal-config-warning' IPC event when this fallback is used.
--
-- Version 4.0 (2025-12-23 - Item Name Resolution)
-- - Added subcategories_cache table for offline item name resolution
-- - Used by print handlers to resolve item names when orders lack embedded names
-- - Synced from Supabase subcategories table during admin dashboard sync
--
-- Version 5.0 (2026-01-08 - Checkout Calculation Fixes)
-- - Added calculation_version column to staff_shifts table
-- - Version 1: Legacy formula (potentially buggy with double-counting)
-- - Version 2: Corrected formula (staff payments informational only)
-- - New shifts default to version 2, old shifts default to version 1 (NULL)
-- - Formula reference:
--   * Driver/Waiter: startingAmount + cashCollected - expenses - payment = return
--   * Cashier v2: opening + sales - refunds - expenses - drops - driverGiven + driverReturned + inheritedDrivers = expected
--   * Staff payments NOT deducted from cashier expected amount (informational only)
--
-- Version 6.0 (2026-01-11 - Foreign Key Enforcement)
-- - ENABLED foreign keys globally (PRAGMA foreign_keys = ON)
-- - Added FK constraints with ON DELETE CASCADE/SET NULL for local table relationships:
--   * payment_transactions.order_id -> orders(id) CASCADE
--   * payment_receipts.transaction_id -> payment_transactions(id) CASCADE
--   * payment_refunds.transaction_id -> payment_transactions(id) CASCADE
--   * cash_drawer_sessions.staff_shift_id -> staff_shifts(id) CASCADE
--   * shift_expenses.staff_shift_id -> staff_shifts(id) CASCADE
--   * driver_earnings.staff_shift_id -> staff_shifts(id) SET NULL
--   * driver_earnings.order_id -> orders(id) CASCADE
--   * staff_payments.staff_shift_id -> staff_shifts(id) SET NULL
--   * staff_payments.paid_by_cashier_shift_id -> staff_shifts(id) CASCADE
-- - NO FK constraints on Supabase-managed references (staff_id, driver_id, customer_id)
-- - Added DataIntegrityService for Supabase reference validation
-- - Added OrphanedRecordCleanup for automated cleanup
-- - See: docs/database/sqlite-foreign-keys-strategy.md
