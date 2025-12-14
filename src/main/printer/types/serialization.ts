/**
 * Printer Configuration Serialization
 *
 * Functions for serializing and deserializing printer configurations
 * for database storage.
 *
 * @module printer/types/serialization
 */

import {
  PrinterConfig,
  SerializedPrinterConfig,
  ConnectionDetails,
  PrinterType,
  PrinterRole,
  PaperSize,
} from './index';

/**
 * Serialize a PrinterConfig to a format suitable for SQLite storage
 */
export function serializePrinterConfig(
  config: PrinterConfig
): SerializedPrinterConfig {
  return {
    id: config.id,
    name: config.name,
    type: config.type,
    connectionDetails: JSON.stringify(config.connectionDetails),
    paperSize: config.paperSize,
    characterSet: config.characterSet,
    role: config.role,
    isDefault: config.isDefault ? 1 : 0,
    fallbackPrinterId: config.fallbackPrinterId ?? null,
    enabled: config.enabled ? 1 : 0,
    createdAt: config.createdAt.toISOString(),
    updatedAt: config.updatedAt.toISOString(),
  };
}

/**
 * Deserialize a SerializedPrinterConfig from SQLite storage to PrinterConfig
 */
export function deserializePrinterConfig(
  serialized: SerializedPrinterConfig
): PrinterConfig {
  return {
    id: serialized.id,
    name: serialized.name,
    type: serialized.type as PrinterType,
    connectionDetails: JSON.parse(serialized.connectionDetails) as ConnectionDetails,
    paperSize: serialized.paperSize as PaperSize,
    characterSet: serialized.characterSet,
    role: serialized.role as PrinterRole,
    isDefault: serialized.isDefault === 1,
    fallbackPrinterId: serialized.fallbackPrinterId ?? undefined,
    enabled: serialized.enabled === 1,
    createdAt: new Date(serialized.createdAt),
    updatedAt: new Date(serialized.updatedAt),
  };
}

/**
 * Check if two PrinterConfig objects are equivalent
 * (handles Date comparison and optional fields)
 */
export function arePrinterConfigsEqual(
  a: PrinterConfig,
  b: PrinterConfig
): boolean {
  // Compare primitive fields
  if (
    a.id !== b.id ||
    a.name !== b.name ||
    a.type !== b.type ||
    a.paperSize !== b.paperSize ||
    a.characterSet !== b.characterSet ||
    a.role !== b.role ||
    a.isDefault !== b.isDefault ||
    a.enabled !== b.enabled
  ) {
    return false;
  }

  // Compare optional fallbackPrinterId
  if (a.fallbackPrinterId !== b.fallbackPrinterId) {
    return false;
  }

  // Compare dates (using ISO string for precision)
  if (
    a.createdAt.toISOString() !== b.createdAt.toISOString() ||
    a.updatedAt.toISOString() !== b.updatedAt.toISOString()
  ) {
    return false;
  }

  // Compare connection details
  return areConnectionDetailsEqual(a.connectionDetails, b.connectionDetails);
}

/**
 * Check if two ConnectionDetails objects are equivalent
 */
export function areConnectionDetailsEqual(
  a: ConnectionDetails,
  b: ConnectionDetails
): boolean {
  if (a.type !== b.type) {
    return false;
  }

  // Deep comparison using JSON serialization
  return JSON.stringify(a) === JSON.stringify(b);
}
