/**
 * Printer Configuration Store Service
 *
 * Handles persistence of printer configurations to SQLite database.
 * Provides CRUD operations for printer configurations with JSON serialization
 * of connection details.
 *
 * @module printer/services/PrinterConfigStore
 *
 * Requirements: 8.1, 8.2, 8.3, 8.4
 */

import type Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import {
  PrinterConfig,
  SerializedPrinterConfig,
  PrinterRole,
  PrinterType,
  PaperSize,
  ConnectionDetails,
} from '../types';
import {
  serializePrinterConfig,
  deserializePrinterConfig,
} from '../types/serialization';
import { initializePrinterTables, checkPrinterTablesExist, migratePrintersTableForSystemType } from './PrinterDatabaseSchema';

/**
 * Database row type for printers table
 */
interface PrinterRow {
  id: string;
  name: string;
  type: string;
  connection_details: string;
  paper_size: string;
  character_set: string;
  role: string;
  is_default: number;
  fallback_printer_id: string | null;
  enabled: number;
  created_at: string;
  updated_at: string;
}

/**
 * Convert database row to SerializedPrinterConfig
 */
function rowToSerialized(row: PrinterRow): SerializedPrinterConfig {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    connectionDetails: row.connection_details,
    paperSize: row.paper_size,
    characterSet: row.character_set,
    role: row.role,
    isDefault: row.is_default,
    fallbackPrinterId: row.fallback_printer_id,
    enabled: row.enabled,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * PrinterConfigStore - Manages printer configuration persistence
 */
export class PrinterConfigStore {
  private db: Database.Database;
  private initialized: boolean = false;

  constructor(db: Database.Database) {
    this.db = db;
  }

  /**
   * Initialize the printer tables if they don't exist
   */
  initialize(): void {
    if (this.initialized) return;

    const tables = checkPrinterTablesExist(this.db);
    if (!tables.printers || !tables.printQueue || !tables.printJobHistory) {
      initializePrinterTables(this.db);
    } else {
      // Run migration to add 'system' type support if needed
      migratePrintersTableForSystemType(this.db);
    }

    this.initialized = true;
  }

  /**
   * Save a new printer configuration
   * @param config - Printer configuration (id will be generated if not provided)
   * @returns The saved printer configuration with generated id
   *
   * Requirements: 8.1
   */
  save(config: Omit<PrinterConfig, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }): PrinterConfig {
    this.initialize();

    const now = new Date();
    const fullConfig: PrinterConfig = {
      ...config,
      id: config.id || uuidv4(),
      createdAt: now,
      updatedAt: now,
    };

    const serialized = serializePrinterConfig(fullConfig);

    const stmt = this.db.prepare(`
      INSERT INTO printers (
        id, name, type, connection_details, paper_size, character_set,
        role, is_default, fallback_printer_id, enabled, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      serialized.id,
      serialized.name,
      serialized.type,
      serialized.connectionDetails,
      serialized.paperSize,
      serialized.characterSet,
      serialized.role,
      serialized.isDefault,
      serialized.fallbackPrinterId,
      serialized.enabled,
      serialized.createdAt,
      serialized.updatedAt
    );

    // If this printer is set as default, unset other defaults for the same role
    if (fullConfig.isDefault) {
      this.unsetOtherDefaults(fullConfig.id, fullConfig.role);
    }

    return fullConfig;
  }

  /**
   * Load a printer configuration by ID
   * @param id - Printer ID
   * @returns The printer configuration or null if not found
   *
   * Requirements: 8.2
   */
  load(id: string): PrinterConfig | null {
    this.initialize();

    const stmt = this.db.prepare(`
      SELECT * FROM printers WHERE id = ?
    `);

    const row = stmt.get(id) as PrinterRow | undefined;
    if (!row) return null;

    return deserializePrinterConfig(rowToSerialized(row));
  }

  /**
   * Update an existing printer configuration
   * @param id - Printer ID
   * @param updates - Partial configuration updates
   * @returns The updated printer configuration or null if not found
   *
   * Requirements: 8.3
   */
  update(id: string, updates: Partial<Omit<PrinterConfig, 'id' | 'createdAt'>>): PrinterConfig | null {
    this.initialize();

    const existing = this.load(id);
    if (!existing) return null;

    const updatedConfig: PrinterConfig = {
      ...existing,
      ...updates,
      id: existing.id, // Ensure ID cannot be changed
      createdAt: existing.createdAt, // Ensure createdAt cannot be changed
      updatedAt: new Date(),
    };

    const serialized = serializePrinterConfig(updatedConfig);

    const stmt = this.db.prepare(`
      UPDATE printers SET
        name = ?,
        type = ?,
        connection_details = ?,
        paper_size = ?,
        character_set = ?,
        role = ?,
        is_default = ?,
        fallback_printer_id = ?,
        enabled = ?,
        updated_at = ?
      WHERE id = ?
    `);

    stmt.run(
      serialized.name,
      serialized.type,
      serialized.connectionDetails,
      serialized.paperSize,
      serialized.characterSet,
      serialized.role,
      serialized.isDefault,
      serialized.fallbackPrinterId,
      serialized.enabled,
      serialized.updatedAt,
      serialized.id
    );

    // If this printer is set as default, unset other defaults for the same role
    if (updatedConfig.isDefault) {
      this.unsetOtherDefaults(updatedConfig.id, updatedConfig.role);
    }

    return updatedConfig;
  }

  /**
   * Delete a printer configuration
   * @param id - Printer ID
   * @returns true if deleted, false if not found
   *
   * Requirements: 8.4
   */
  delete(id: string): boolean {
    this.initialize();

    // First, clear any fallback references to this printer
    const clearFallbackStmt = this.db.prepare(`
      UPDATE printers SET fallback_printer_id = NULL WHERE fallback_printer_id = ?
    `);
    clearFallbackStmt.run(id);

    // Then delete the printer
    const stmt = this.db.prepare(`
      DELETE FROM printers WHERE id = ?
    `);

    const result = stmt.run(id);
    return result.changes > 0;
  }

  /**
   * Get all printer configurations
   * @returns Array of all printer configurations
   *
   * Requirements: 8.2
   */
  getAll(): PrinterConfig[] {
    this.initialize();

    const stmt = this.db.prepare(`
      SELECT * FROM printers ORDER BY name ASC
    `);

    const rows = stmt.all() as PrinterRow[];
    return rows.map((row) => deserializePrinterConfig(rowToSerialized(row)));
  }

  /**
   * Get printer configurations by role
   * @param role - Printer role to filter by
   * @returns Array of printer configurations with the specified role
   *
   * Requirements: 9.1
   */
  getByRole(role: PrinterRole): PrinterConfig[] {
    this.initialize();

    const stmt = this.db.prepare(`
      SELECT * FROM printers WHERE role = ? ORDER BY is_default DESC, name ASC
    `);

    const rows = stmt.all(role) as PrinterRow[];
    return rows.map((row) => deserializePrinterConfig(rowToSerialized(row)));
  }

  /**
   * Get the default printer for a specific role
   * @param role - Printer role
   * @returns The default printer for the role, or null if none set
   */
  getDefaultForRole(role: PrinterRole): PrinterConfig | null {
    this.initialize();

    const stmt = this.db.prepare(`
      SELECT * FROM printers WHERE role = ? AND is_default = 1 AND enabled = 1 LIMIT 1
    `);

    const row = stmt.get(role) as PrinterRow | undefined;
    if (!row) return null;

    return deserializePrinterConfig(rowToSerialized(row));
  }

  /**
   * Get enabled printers only
   * @returns Array of enabled printer configurations
   */
  getEnabled(): PrinterConfig[] {
    this.initialize();

    const stmt = this.db.prepare(`
      SELECT * FROM printers WHERE enabled = 1 ORDER BY name ASC
    `);

    const rows = stmt.all() as PrinterRow[];
    return rows.map((row) => deserializePrinterConfig(rowToSerialized(row)));
  }

  /**
   * Check if a printer with the given name already exists
   * @param name - Printer name to check
   * @param excludeId - Optional ID to exclude from check (for updates)
   * @returns true if name exists
   */
  nameExists(name: string, excludeId?: string): boolean {
    this.initialize();

    const stmt = excludeId
      ? this.db.prepare(`SELECT 1 FROM printers WHERE name = ? AND id != ? LIMIT 1`)
      : this.db.prepare(`SELECT 1 FROM printers WHERE name = ? LIMIT 1`);

    const result = excludeId ? stmt.get(name, excludeId) : stmt.get(name);
    return !!result;
  }

  /**
   * Get count of printers
   * @returns Total number of configured printers
   */
  count(): number {
    this.initialize();

    const stmt = this.db.prepare(`SELECT COUNT(*) as count FROM printers`);
    const result = stmt.get() as { count: number };
    return result.count;
  }

  /**
   * Unset default flag for other printers with the same role
   * @param excludeId - ID of printer to keep as default
   * @param role - Printer role
   */
  private unsetOtherDefaults(excludeId: string, role: PrinterRole): void {
    const stmt = this.db.prepare(`
      UPDATE printers SET is_default = 0 WHERE role = ? AND id != ? AND is_default = 1
    `);
    stmt.run(role, excludeId);
  }

  /**
   * Export all printer configurations for settings backup
   * @returns Array of serialized printer configurations
   *
   * Requirements: 8.5
   */
  exportAll(): SerializedPrinterConfig[] {
    this.initialize();

    const configs = this.getAll();
    return configs.map(serializePrinterConfig);
  }

  /**
   * Import printer configurations from settings backup
   * @param configs - Array of serialized printer configurations
   * @param replace - If true, replace existing configs; if false, merge
   * @returns Number of configurations imported
   *
   * Requirements: 8.5
   */
  importAll(configs: SerializedPrinterConfig[], replace: boolean = false): number {
    this.initialize();

    if (replace) {
      // Clear existing configurations
      this.db.exec(`DELETE FROM printers`);
    }

    let imported = 0;
    for (const serialized of configs) {
      try {
        const config = deserializePrinterConfig(serialized);

        if (replace || !this.load(config.id)) {
          // Insert or replace
          const stmt = this.db.prepare(`
            INSERT OR REPLACE INTO printers (
              id, name, type, connection_details, paper_size, character_set,
              role, is_default, fallback_printer_id, enabled, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `);

          stmt.run(
            serialized.id,
            serialized.name,
            serialized.type,
            serialized.connectionDetails,
            serialized.paperSize,
            serialized.characterSet,
            serialized.role,
            serialized.isDefault,
            serialized.fallbackPrinterId,
            serialized.enabled,
            serialized.createdAt,
            serialized.updatedAt
          );

          imported++;
        }
      } catch (error) {
        console.error(`[PrinterConfigStore] Failed to import config ${serialized.id}:`, error);
      }
    }

    return imported;
  }
}
