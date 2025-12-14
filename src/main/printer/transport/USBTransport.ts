/**
 * USB Transport Implementation
 *
 * Handles USB connections to thermal printers.
 * Supports both direct USB communication and system spooler fallback.
 *
 * @module printer/transport/USBTransport
 *
 * Requirements: 4.2, 4.3, 4.4, 4.5
 */

import {
  BasePrinterTransport,
  TransportOptions,
  TransportState,
  TransportError,
  TransportEvent,
} from './PrinterTransport';
import { PrinterErrorCode, USBConnectionDetails } from '../types';

/**
 * USB-specific transport options
 */
export interface USBTransportOptions extends TransportOptions {
  /** Use system spooler instead of direct USB (default: false) */
  useSystemSpooler?: boolean;
  /** Interface number for USB device (default: 0) */
  interfaceNumber?: number;
  /** Endpoint address for USB device (default: auto-detect) */
  endpointAddress?: number;
}

/**
 * Default USB transport options
 */
const DEFAULT_USB_OPTIONS: USBTransportOptions = {
  connectionTimeout: 5000,
  maxRetries: 3,
  retryBaseDelay: 1000,
  autoReconnect: true,
  reconnectTimeout: 30000,
  useSystemSpooler: false,
  interfaceNumber: 0,
};

/**
 * Interface for USB device
 * Abstracts the usb package
 */
interface USBDevice {
  open(): void;
  close(): void;
  interfaces: USBInterface[];
  deviceDescriptor: {
    idVendor: number;
    idProduct: number;
  };
}

interface USBInterface {
  claim(): void;
  release(closeEndpoints?: boolean, callback?: (error?: Error) => void): void;
  endpoints: USBEndpoint[];
  isKernelDriverActive(): boolean;
  detachKernelDriver(): void;
}

interface USBEndpoint {
  direction: 'in' | 'out';
  address: number;
  transfer(data: Buffer, callback: (error?: Error) => void): void;
  transferType: number;
}

/**
 * Interface for system printer
 * Abstracts the printer package
 */
interface SystemPrinter {
  print(data: string | Buffer, options?: { printer?: string }): Promise<void>;
  getPrinters(): Promise<{ name: string; isDefault: boolean }[]>;
}

/**
 * USBTransport - USB transport for USB printers
 *
 * Requirements: 4.2, 4.3, 4.4, 4.5
 */
export class USBTransport extends BasePrinterTransport {
  private device: USBDevice | null = null;
  private interface: USBInterface | null = null;
  private endpoint: USBEndpoint | null = null;
  private vendorId: number;
  private productId: number;
  private systemName?: string;
  private devicePath?: string;
  private usbOptions: USBTransportOptions;
  private usbModule: { findByIds: (vid: number, pid: number) => USBDevice | undefined } | null = null;
  private printerModule: SystemPrinter | null = null;
  private useSpooler: boolean;

  /**
   * Create a new USBTransport
   *
   * @param connectionDetails - USB connection details (vendor ID, product ID)
   * @param options - Transport options
   */
  constructor(
    connectionDetails: USBConnectionDetails,
    options?: USBTransportOptions
  ) {
    super({ ...DEFAULT_USB_OPTIONS, ...options });
    this.vendorId = connectionDetails.vendorId;
    this.productId = connectionDetails.productId;
    this.systemName = connectionDetails.systemName;
    this.devicePath = connectionDetails.path;
    this.usbOptions = { ...DEFAULT_USB_OPTIONS, ...options };
    this.useSpooler = this.usbOptions.useSystemSpooler || false;

    // Try to load USB and printer modules dynamically
    this.loadModules();
  }

  /**
   * Load the usb and printer modules dynamically
   */
  private loadModules(): void {
    // Try to load usb module
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      this.usbModule = require('usb');
    } catch {
      this.usbModule = null;
    }

    // Try to load printer module for system spooler
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      this.printerModule = require('pdf-to-printer');
    } catch {
      this.printerModule = null;
    }
  }

  /**
   * Set USB module (for testing)
   */
  setUsbModule(module: { findByIds: (vid: number, pid: number) => USBDevice | undefined }): void {
    this.usbModule = module;
  }

  /**
   * Set printer module (for testing)
   */
  setPrinterModule(module: SystemPrinter): void {
    this.printerModule = module;
  }

  /**
   * Get the vendor ID
   */
  getVendorId(): number {
    return this.vendorId;
  }

  /**
   * Get the product ID
   */
  getProductId(): number {
    return this.productId;
  }

  /**
   * Get the system printer name
   */
  getSystemName(): string | undefined {
    return this.systemName;
  }

  /**
   * Check if using system spooler
   */
  isUsingSystemSpooler(): boolean {
    return this.useSpooler;
  }

  /**
   * Establish USB connection
   *
   * Requirements: 4.2
   */
  protected async doConnect(): Promise<void> {
    // Clean up any existing connection
    this.cleanupConnection();

    if (this.useSpooler) {
      // Using system spooler - just verify printer exists
      await this.connectViaSpooler();
    } else {
      // Direct USB connection
      await this.connectDirectUSB();
    }
  }

  /**
   * Connect via system spooler
   */
  private async connectViaSpooler(): Promise<void> {
    if (!this.printerModule) {
      throw new Error(
        'Printer module not available. Please install pdf-to-printer package or use direct USB.'
      );
    }

    if (!this.systemName) {
      throw new Error('System printer name is required for spooler mode');
    }

    // Verify printer exists in system
    try {
      const printers = await this.printerModule.getPrinters();
      const printerExists = printers.some((p) => p.name === this.systemName);

      if (!printerExists) {
        throw new Error(`Printer "${this.systemName}" not found in system`);
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes('not found')) {
        throw error;
      }
      // If we can't list printers, assume it exists and try anyway
    }
  }

  /**
   * Connect directly to USB device
   */
  private async connectDirectUSB(): Promise<void> {
    if (!this.usbModule) {
      // Fall back to system spooler if USB module not available
      if (this.systemName && this.printerModule) {
        this.useSpooler = true;
        await this.connectViaSpooler();
        return;
      }
      throw new Error(
        'USB module not available. Please install usb package or configure system printer name.'
      );
    }

    // Find USB device
    this.device = this.usbModule.findByIds(this.vendorId, this.productId) || null;

    if (!this.device) {
      throw new Error(
        `USB device not found (VID: 0x${this.vendorId.toString(16)}, PID: 0x${this.productId.toString(16)})`
      );
    }

    try {
      // Open device
      this.device.open();

      // Get interface
      const interfaceNum = this.usbOptions.interfaceNumber || 0;
      if (!this.device.interfaces || this.device.interfaces.length <= interfaceNum) {
        throw new Error(`Interface ${interfaceNum} not found on device`);
      }

      this.interface = this.device.interfaces[interfaceNum];

      // Detach kernel driver if necessary (Linux)
      try {
        if (this.interface.isKernelDriverActive()) {
          this.interface.detachKernelDriver();
        }
      } catch {
        // Ignore - may not be supported on all platforms
      }

      // Claim interface
      this.interface.claim();

      // Find OUT endpoint for sending data
      this.endpoint = this.findOutEndpoint();

      if (!this.endpoint) {
        throw new Error('No OUT endpoint found on USB device');
      }
    } catch (error) {
      this.cleanupConnection();
      throw error;
    }
  }

  /**
   * Find the OUT endpoint for sending data
   */
  private findOutEndpoint(): USBEndpoint | null {
    if (!this.interface) return null;

    // If endpoint address is specified, use it
    if (this.usbOptions.endpointAddress !== undefined) {
      return (
        this.interface.endpoints.find(
          (ep) => ep.address === this.usbOptions.endpointAddress
        ) || null
      );
    }

    // Find first OUT endpoint (bulk transfer preferred)
    const bulkOut = this.interface.endpoints.find(
      (ep) => ep.direction === 'out' && ep.transferType === 2 // Bulk transfer
    );

    if (bulkOut) return bulkOut;

    // Fall back to any OUT endpoint
    return this.interface.endpoints.find((ep) => ep.direction === 'out') || null;
  }

  /**
   * Close USB connection
   *
   * Requirements: 4.2
   */
  protected async doDisconnect(): Promise<void> {
    this.cleanupConnection();
  }

  /**
   * Send data over USB
   *
   * Requirements: 4.3
   */
  protected async doSend(data: Buffer): Promise<void> {
    if (this.useSpooler) {
      await this.sendViaSpooler(data);
    } else {
      await this.sendDirectUSB(data);
    }
  }

  /**
   * Send data via system spooler
   */
  private async sendViaSpooler(data: Buffer): Promise<void> {
    if (!this.printerModule) {
      throw new Error('Printer module not available');
    }

    if (!this.systemName) {
      throw new Error('System printer name is required');
    }

    await this.printerModule.print(data, { printer: this.systemName });
  }

  /**
   * Send data directly to USB device
   */
  private async sendDirectUSB(data: Buffer): Promise<void> {
    if (!this.endpoint) {
      throw new Error('USB endpoint not available');
    }

    return new Promise((resolve, reject) => {
      this.endpoint!.transfer(data, (error?: Error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }

  /**
   * Clean up USB connection resources
   */
  private cleanupConnection(): void {
    // Release interface
    if (this.interface) {
      try {
        this.interface.release(true);
      } catch {
        // Ignore release errors
      }
      this.interface = null;
    }

    // Close device
    if (this.device) {
      try {
        this.device.close();
      } catch {
        // Ignore close errors
      }
      this.device = null;
    }

    this.endpoint = null;
  }

  /**
   * Handle device disconnect event
   *
   * Requirements: 4.4
   */
  handleDeviceDisconnect(): void {
    if (this.state === TransportState.CONNECTED) {
      this.lastError = 'USB device disconnected';
      this.cleanupConnection();
      this.handleConnectionLost();
    }
  }

  /**
   * Handle device reconnect event
   *
   * Requirements: 4.5
   */
  async handleDeviceReconnect(): Promise<void> {
    if (
      this.state === TransportState.DISCONNECTED ||
      this.state === TransportState.RECONNECTING
    ) {
      try {
        await this.connect();
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const transportError: TransportError = {
          code: PrinterErrorCode.CONNECTION_LOST,
          message: `Failed to reconnect: ${errorMessage}`,
          originalError: error instanceof Error ? error : undefined,
          recoverable: true,
        };
        this.emit(TransportEvent.ERROR, transportError);
      }
    }
  }

  /**
   * Check if USB module is available
   */
  isUSBAvailable(): boolean {
    return this.usbModule !== null;
  }

  /**
   * Check if system spooler is available
   */
  isSpoolerAvailable(): boolean {
    return this.printerModule !== null;
  }

  /**
   * Clean up resources
   */
  destroy(): void {
    this.cleanupConnection();
    super.destroy();
  }
}
