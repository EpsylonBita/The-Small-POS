/**
 * Bluetooth Printer Discovery Service
 * 
 * Discovers Bluetooth printers using:
 * - bluetooth-serial-port for SPP device enumeration
 * - Filters for Serial Port Profile (SPP) capable devices
 * 
 * @module printer/discovery
 * Requirements: 1.2, 3.1
 */

import { DiscoveredPrinter, PrinterType } from '../types';
import { PrinterDiscovery, PrinterFoundCallback } from './PrinterDiscovery';

/**
 * Default discovery timeout in milliseconds
 */
const DEFAULT_TIMEOUT = 15000;

/**
 * Common Bluetooth printer manufacturer prefixes
 */
const PRINTER_NAME_PATTERNS = [
  /printer/i,
  /thermal/i,
  /receipt/i,
  /pos/i,
  /epson/i,
  /star/i,
  /bixolon/i,
  /citizen/i,
  /zebra/i,
  /brother/i,
  /tsp/i,      // Star TSP series
  /tm-/i,      // Epson TM series
  /srp-/i,     // Bixolon SRP series
  /ct-/i,      // Citizen CT series
];

/**
 * Bluetooth device info from bluetooth-serial-port
 */
interface BluetoothDevice {
  address: string;
  name: string;
  services?: Array<{
    channel: number;
    name?: string;
  }>;
}

/**
 * Bluetooth printer discovery service using bluetooth-serial-port
 */
export class BluetoothDiscovery implements PrinterDiscovery {
  private discovering = false;
  private callbacks: PrinterFoundCallback[] = [];
  private discoveredPrinters: Map<string, DiscoveredPrinter> = new Map();
  private configuredAddresses: Set<string> = new Set();
  private btSerial: unknown = null;
  private inquireTimeout: ReturnType<typeof setTimeout> | null = null;

  /**
   * Create a new BluetoothDiscovery instance
   * @param configuredAddresses - Set of already configured printer MAC addresses
   */
  constructor(configuredAddresses?: Set<string>) {
    if (configuredAddresses) {
      this.configuredAddresses = configuredAddresses;
    }
  }

  /**
   * Set the list of already configured printer addresses
   */
  setConfiguredAddresses(addresses: Set<string>): void {
    this.configuredAddresses = addresses;
  }

  /**
   * Initialize the Bluetooth serial port module
   * This is done lazily because the module may not be available on all systems
   */
  private async initBluetooth(): Promise<unknown> {
    if (this.btSerial) {
      return this.btSerial;
    }

    try {
      // Dynamic import to handle optional dependency
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const BluetoothSerialPort = require('bluetooth-serial-port');
      this.btSerial = new BluetoothSerialPort.BluetoothSerialPort();
      return this.btSerial;
    } catch (error) {
      console.warn('Bluetooth serial port module not available:', error);
      return null;
    }
  }

  /**
   * Discover Bluetooth printers
   */
  async discover(timeout: number = DEFAULT_TIMEOUT): Promise<DiscoveredPrinter[]> {
    if (this.discovering) {
      throw new Error('Discovery already in progress');
    }

    this.discovering = true;
    this.discoveredPrinters.clear();

    try {
      const btSerial = await this.initBluetooth();
      
      if (!btSerial) {
        console.warn('Bluetooth not available on this system');
        return [];
      }

      await this.performInquiry(btSerial, timeout);
      return Array.from(this.discoveredPrinters.values());
    } catch (error) {
      console.error('Bluetooth discovery error:', error);
      return Array.from(this.discoveredPrinters.values());
    } finally {
      this.stopDiscovery();
    }
  }

  /**
   * Perform Bluetooth device inquiry
   */
  private async performInquiry(btSerial: unknown, timeout: number): Promise<void> {
    return new Promise((resolve) => {
      const bt = btSerial as {
        inquire: () => void;
        on: (event: string, callback: (...args: unknown[]) => void) => void;
        removeAllListeners: (event: string) => void;
        findSerialPortChannel: (
          address: string,
          callback: (channel: number) => void,
          errorCallback: () => void
        ) => void;
      };

      // Set timeout for inquiry
      this.inquireTimeout = setTimeout(() => {
        this.stopDiscovery();
        resolve();
      }, timeout);

      // Handle found devices
      bt.on('found', (address: unknown, name: unknown) => {
        if (!this.discovering) return;

        const addrStr = String(address);
        const nameStr = String(name);

        // Check if this looks like a printer
        if (this.isPotentialPrinter(nameStr)) {
          this.handleFoundDevice({ address: addrStr, name: nameStr }, bt);
        }
      });

      // Handle inquiry completion
      bt.on('finished', () => {
        if (this.inquireTimeout) {
          clearTimeout(this.inquireTimeout);
          this.inquireTimeout = null;
        }
        resolve();
      });

      // Start inquiry
      try {
        bt.inquire();
      } catch (error) {
        console.error('Failed to start Bluetooth inquiry:', error);
        resolve();
      }
    });
  }

  /**
   * Handle a found Bluetooth device
   */
  private handleFoundDevice(
    device: BluetoothDevice,
    bt: {
      findSerialPortChannel: (
        address: string,
        callback: (channel: number) => void,
        errorCallback: () => void
      ) => void;
    }
  ): void {
    const key = device.address.toUpperCase();

    // Skip if already discovered
    if (this.discoveredPrinters.has(key)) return;

    // Try to find the serial port channel
    this.findSerialChannel(device.address, bt).then((channel) => {
      const printer: DiscoveredPrinter = {
        name: device.name || `Bluetooth Printer (${device.address})`,
        type: PrinterType.BLUETOOTH,
        address: device.address,
        port: channel || 1, // Default to channel 1 if not found
        isConfigured: this.configuredAddresses.has(device.address) ||
                      this.configuredAddresses.has(key),
      };

      this.addDiscoveredPrinter(key, printer);
    });
  }

  /**
   * Find the serial port channel for a Bluetooth device
   */
  private async findSerialChannel(
    address: string,
    bt: {
      findSerialPortChannel: (
        address: string,
        callback: (channel: number) => void,
        errorCallback: () => void
      ) => void;
    }
  ): Promise<number | null> {
    return new Promise((resolve) => {
      try {
        bt.findSerialPortChannel(
          address,
          (channel: number) => {
            resolve(channel);
          },
          () => {
            // Error finding channel, use default
            resolve(null);
          }
        );
      } catch {
        resolve(null);
      }
    });
  }

  /**
   * Check if a device name suggests it might be a printer
   */
  private isPotentialPrinter(name: string): boolean {
    if (!name) return false;
    
    return PRINTER_NAME_PATTERNS.some(pattern => pattern.test(name));
  }

  /**
   * Stop any ongoing discovery
   */
  stopDiscovery(): void {
    this.discovering = false;

    if (this.inquireTimeout) {
      clearTimeout(this.inquireTimeout);
      this.inquireTimeout = null;
    }

    // Clean up Bluetooth listeners
    if (this.btSerial) {
      try {
        const bt = this.btSerial as {
          removeAllListeners: (event: string) => void;
        };
        bt.removeAllListeners('found');
        bt.removeAllListeners('finished');
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  /**
   * Register a callback for printer discovery events
   */
  onPrinterFound(callback: PrinterFoundCallback): void {
    this.callbacks.push(callback);
  }

  /**
   * Check if discovery is in progress
   */
  isDiscovering(): boolean {
    return this.discovering;
  }

  /**
   * Add a discovered printer and notify callbacks
   */
  private addDiscoveredPrinter(key: string, printer: DiscoveredPrinter): void {
    if (this.discoveredPrinters.has(key)) return;

    this.discoveredPrinters.set(key, printer);

    // Notify all callbacks
    for (const callback of this.callbacks) {
      try {
        callback(printer);
      } catch (error) {
        console.error('Error in printer found callback:', error);
      }
    }
  }

  /**
   * Get list of paired Bluetooth devices that might be printers
   * This is a faster alternative to full discovery for already-paired devices
   */
  async getPairedPrinters(): Promise<DiscoveredPrinter[]> {
    const printers: DiscoveredPrinter[] = [];

    try {
      const btSerial = await this.initBluetooth();
      if (!btSerial) return printers;

      const bt = btSerial as {
        listPairedDevices: (callback: (devices: BluetoothDevice[]) => void) => void;
      };

      return new Promise((resolve) => {
        bt.listPairedDevices((devices: BluetoothDevice[]) => {
          for (const device of devices) {
            if (this.isPotentialPrinter(device.name)) {
              printers.push({
                name: device.name || `Bluetooth Printer (${device.address})`,
                type: PrinterType.BLUETOOTH,
                address: device.address,
                port: device.services?.[0]?.channel || 1,
                isConfigured: this.configuredAddresses.has(device.address) ||
                              this.configuredAddresses.has(device.address.toUpperCase()),
              });
            }
          }
          resolve(printers);
        });
      });
    } catch (error) {
      console.error('Error listing paired devices:', error);
      return printers;
    }
  }
}
