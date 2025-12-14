/**
 * Printer Transport Module
 *
 * Contains transport layer implementations for printer communication:
 * - BasePrinterTransport (abstract base class)
 * - NetworkTransport (TCP/IP)
 * - BluetoothTransport (SPP)
 * - USBTransport (direct USB / system spooler)
 *
 * @module printer/transport
 *
 * Requirements: 2.2, 2.3, 2.4, 3.3, 3.4, 3.5, 4.2, 4.3, 4.4, 4.5
 */

// Base transport interface and abstract class
export type {
  IPrinterTransport,
  TransportError,
  TransportOptions,
} from './PrinterTransport';

export {
  BasePrinterTransport,
  TransportState,
  TransportEvent,
  DEFAULT_TRANSPORT_OPTIONS,
} from './PrinterTransport';

// Network transport (TCP/IP)
export type { NetworkTransportOptions } from './NetworkTransport';
export { NetworkTransport } from './NetworkTransport';

// Bluetooth transport (SPP)
export type { BluetoothTransportOptions } from './BluetoothTransport';
export { BluetoothTransport } from './BluetoothTransport';

// USB transport (direct USB / system spooler)
export type { USBTransportOptions } from './USBTransport';
export { USBTransport } from './USBTransport';
