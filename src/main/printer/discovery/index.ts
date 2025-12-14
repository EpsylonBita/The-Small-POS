/**
 * Printer Discovery Module
 * 
 * Contains services for discovering printers via different connection types:
 * - Network (mDNS/Bonjour, broadcast)
 * - Bluetooth (SPP enumeration)
 * - USB (device enumeration)
 * 
 * @module printer/discovery
 */

// Base interface and utilities
export type { 
  PrinterDiscovery, 
  PrinterFoundCallback,
} from './PrinterDiscovery';

export { formatDiscoveredPrinter } from './PrinterDiscovery';

// Discovery implementations
export { NetworkDiscovery } from './NetworkDiscovery';
export { BluetoothDiscovery } from './BluetoothDiscovery';
export { USBDiscovery } from './USBDiscovery';
