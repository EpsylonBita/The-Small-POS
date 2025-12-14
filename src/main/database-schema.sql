-- POS System Local SQLite Database Schema
-- This file documents the schema applied by DatabaseService.ts
-- Last updated: 2025-01-14

-- ============================================================================
-- ORDERS TABLE
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
  forwarded_at TEXT -- Timestamp when forwarded
);

CREATE INDEX IF NOT EXISTS idx_orders_sync_status ON orders(sync_status);
CREATE INDEX IF NOT EXISTS idx_orders_version ON orders(id, version);
CREATE INDEX IF NOT EXISTS idx_orders_supabase_id ON orders(supabase_id);

-- ============================================================================
-- SYNC QUEUE TABLE
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

-- ============================================================================
-- ORDER SYNC CONFLICTS TABLE
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
-- TERMINAL SETTINGS TABLE (for caching Supabase configuration per terminal)
-- NOTE: This documents the actual table used by TerminalConfigService in the
--       Electron POS app. Do not change the schema here without updating the
--       service implementation.
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

