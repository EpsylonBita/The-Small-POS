/**
 * ECR Configuration Store
 *
 * Manages persistence of ECR device configurations in SQLite.
 *
 * @module ecr/services/ECRConfigStore
 */

import type Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import type {
  ECRDevice,
  SerializedECRDevice,
} from '../../../../../shared/types/ecr';
import {
  ECRDeviceType,
  ECRConnectionType,
  ECRProtocol,
  serializeECRDevice,
  deserializeECRDevice,
} from '../../../../../shared/types/ecr';
import { initializeECRSchema, isECRSchemaInitialized } from './ECRDatabaseSchema';

/**
 * ECRConfigStore - Manages ECR device configurations
 */
export class ECRConfigStore {
  private db: Database.Database;
  private initialized: boolean = false;

  constructor(db: Database.Database) {
    this.db = db;
  }

  /**
   * Initialize the config store
   */
  initialize(): void {
    if (this.initialized) return;

    if (!isECRSchemaInitialized(this.db)) {
      initializeECRSchema(this.db);
    }

    this.initialized = true;
  }

  /**
   * Save a new device configuration
   */
  save(
    config: Omit<ECRDevice, 'id' | 'createdAt' | 'updatedAt'>
  ): ECRDevice {
    this.ensureInitialized();

    const device: ECRDevice = {
      ...config,
      id: uuidv4(),
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    // If this is being set as default, clear other defaults of same type
    if (device.isDefault) {
      this.clearDefaultsForType(device.deviceType);
    }

    const serialized = serializeECRDevice(device);

    this.db.prepare(`
      INSERT INTO ecr_devices (
        id, name, device_type, connection_type, connection_details,
        protocol, terminal_id, merchant_id, is_default, enabled,
        settings, created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      )
    `).run(
      serialized.id,
      serialized.name,
      serialized.device_type,
      serialized.connection_type,
      serialized.connection_details,
      serialized.protocol,
      serialized.terminal_id,
      serialized.merchant_id,
      serialized.is_default,
      serialized.enabled,
      serialized.settings,
      serialized.created_at,
      serialized.updated_at
    );

    return device;
  }

  /**
   * Load a device by ID
   */
  load(id: string): ECRDevice | null {
    this.ensureInitialized();

    const row = this.db.prepare(`
      SELECT * FROM ecr_devices WHERE id = ?
    `).get(id) as SerializedECRDevice | undefined;

    if (!row) return null;

    return deserializeECRDevice(row);
  }

  /**
   * Update a device configuration
   */
  update(
    id: string,
    updates: Partial<Omit<ECRDevice, 'id' | 'createdAt'>>
  ): ECRDevice | null {
    this.ensureInitialized();

    const existing = this.load(id);
    if (!existing) return null;

    // If setting as default, clear other defaults of same type
    if (updates.isDefault && !existing.isDefault) {
      this.clearDefaultsForType(existing.deviceType);
    }

    const updated: ECRDevice = {
      ...existing,
      ...updates,
      updatedAt: new Date(),
    };

    const serialized = serializeECRDevice(updated);

    this.db.prepare(`
      UPDATE ecr_devices SET
        name = ?,
        device_type = ?,
        connection_type = ?,
        connection_details = ?,
        protocol = ?,
        terminal_id = ?,
        merchant_id = ?,
        is_default = ?,
        enabled = ?,
        settings = ?,
        updated_at = ?
      WHERE id = ?
    `).run(
      serialized.name,
      serialized.device_type,
      serialized.connection_type,
      serialized.connection_details,
      serialized.protocol,
      serialized.terminal_id,
      serialized.merchant_id,
      serialized.is_default,
      serialized.enabled,
      serialized.settings,
      serialized.updated_at,
      id
    );

    return updated;
  }

  /**
   * Delete a device configuration
   */
  delete(id: string): boolean {
    this.ensureInitialized();

    const result = this.db.prepare(`
      DELETE FROM ecr_devices WHERE id = ?
    `).run(id);

    return result.changes > 0;
  }

  /**
   * Get all device configurations
   */
  getAll(): ECRDevice[] {
    this.ensureInitialized();

    const rows = this.db.prepare(`
      SELECT * FROM ecr_devices ORDER BY name
    `).all() as SerializedECRDevice[];

    return rows.map(deserializeECRDevice);
  }

  /**
   * Get all enabled devices
   */
  getEnabled(): ECRDevice[] {
    this.ensureInitialized();

    const rows = this.db.prepare(`
      SELECT * FROM ecr_devices WHERE enabled = 1 ORDER BY name
    `).all() as SerializedECRDevice[];

    return rows.map(deserializeECRDevice);
  }

  /**
   * Get devices by type
   */
  getByType(deviceType: ECRDeviceType): ECRDevice[] {
    this.ensureInitialized();

    const rows = this.db.prepare(`
      SELECT * FROM ecr_devices
      WHERE device_type = ? AND enabled = 1
      ORDER BY is_default DESC, name
    `).all(deviceType) as SerializedECRDevice[];

    return rows.map(deserializeECRDevice);
  }

  /**
   * Get the default payment terminal
   */
  getDefaultTerminal(): ECRDevice | null {
    this.ensureInitialized();

    const row = this.db.prepare(`
      SELECT * FROM ecr_devices
      WHERE device_type = 'payment_terminal' AND is_default = 1 AND enabled = 1
      LIMIT 1
    `).get() as SerializedECRDevice | undefined;

    if (!row) {
      // Fall back to any enabled terminal
      const fallback = this.db.prepare(`
        SELECT * FROM ecr_devices
        WHERE device_type = 'payment_terminal' AND enabled = 1
        ORDER BY name LIMIT 1
      `).get() as SerializedECRDevice | undefined;

      return fallback ? deserializeECRDevice(fallback) : null;
    }

    return deserializeECRDevice(row);
  }

  /**
   * Get the default cash drawer
   */
  getDefaultCashDrawer(): ECRDevice | null {
    this.ensureInitialized();

    const row = this.db.prepare(`
      SELECT * FROM ecr_devices
      WHERE device_type = 'cash_drawer' AND is_default = 1 AND enabled = 1
      LIMIT 1
    `).get() as SerializedECRDevice | undefined;

    if (!row) {
      const fallback = this.db.prepare(`
        SELECT * FROM ecr_devices
        WHERE device_type = 'cash_drawer' AND enabled = 1
        ORDER BY name LIMIT 1
      `).get() as SerializedECRDevice | undefined;

      return fallback ? deserializeECRDevice(fallback) : null;
    }

    return deserializeECRDevice(row);
  }

  /**
   * Check if a device name already exists
   */
  nameExists(name: string, excludeId?: string): boolean {
    this.ensureInitialized();

    if (excludeId) {
      const row = this.db.prepare(`
        SELECT id FROM ecr_devices WHERE name = ? AND id != ?
      `).get(name, excludeId);
      return !!row;
    }

    const row = this.db.prepare(`
      SELECT id FROM ecr_devices WHERE name = ?
    `).get(name);
    return !!row;
  }

  /**
   * Clear default flag for devices of a specific type
   */
  private clearDefaultsForType(deviceType: ECRDeviceType): void {
    this.db.prepare(`
      UPDATE ecr_devices SET is_default = 0 WHERE device_type = ?
    `).run(deviceType);
  }

  /**
   * Export all configurations
   */
  exportAll(): object[] {
    const devices = this.getAll();
    return devices.map((d) => ({
      ...d,
      // Don't include DB-generated fields in export
      id: undefined,
      createdAt: undefined,
      updatedAt: undefined,
    }));
  }

  /**
   * Import configurations
   */
  importAll(
    configs: Array<Omit<ECRDevice, 'id' | 'createdAt' | 'updatedAt'>>,
    replace: boolean = false
  ): number {
    if (replace) {
      this.db.prepare(`DELETE FROM ecr_devices`).run();
    }

    let imported = 0;
    for (const config of configs) {
      try {
        if (!replace && this.nameExists(config.name)) {
          continue;
        }
        this.save(config);
        imported++;
      } catch (error) {
        console.warn('[ECRConfigStore] Failed to import device:', config.name, error);
      }
    }

    return imported;
  }

  /**
   * Ensure store is initialized
   */
  private ensureInitialized(): void {
    if (!this.initialized) {
      this.initialize();
    }
  }
}
