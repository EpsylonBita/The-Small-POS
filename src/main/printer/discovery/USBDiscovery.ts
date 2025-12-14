/**
 * USB Printer Discovery Service
 * 
 * Discovers USB printers using:
 * - usb package for direct USB device enumeration
 * - System printer list for spooler-based printers
 * 
 * @module printer/discovery
 * Requirements: 1.3, 4.1
 */

import { DiscoveredPrinter, PrinterType } from '../types';
import { PrinterDiscovery, PrinterFoundCallback } from './PrinterDiscovery';
import * as usb from 'usb';

/**
 * Known thermal printer vendor IDs
 */
const KNOWN_PRINTER_VENDORS: Record<number, string> = {
  0x04b8: 'Epson',
  0x0519: 'Star Micronics',
  0x1504: 'Bixolon',
  0x0dd4: 'Custom',
  0x0fe6: 'Citizen',
  0x0a5f: 'Zebra',
  0x04f9: 'Brother',
  0x0416: 'Winbond',
  0x067b: 'Prolific', // USB-Serial adapters often used with printers
  0x1a86: 'QinHeng', // CH340 USB-Serial
  0x10c4: 'Silicon Labs', // CP210x USB-Serial
  0x0403: 'FTDI', // USB-Serial adapters
};

/**
 * USB device class for printers
 */
const USB_CLASS_PRINTER = 7;

/**
 * USB Printer discovery service
 */
export class USBDiscovery implements PrinterDiscovery {
  private discovering = false;
  private callbacks: PrinterFoundCallback[] = [];
  private discoveredPrinters: Map<string, DiscoveredPrinter> = new Map();
  private configuredDevices: Set<string> = new Set();

  /**
   * Create a new USBDiscovery instance
   * @param configuredDevices - Set of already configured device identifiers (vendorId:productId)
   */
  constructor(configuredDevices?: Set<string>) {
    if (configuredDevices) {
      this.configuredDevices = configuredDevices;
    }
  }

  /**
   * Set the list of already configured device identifiers
   */
  setConfiguredDevices(devices: Set<string>): void {
    this.configuredDevices = devices;
  }

  /**
   * Discover USB printers
   */
  async discover(_timeout?: number): Promise<DiscoveredPrinter[]> {
    if (this.discovering) {
      throw new Error('Discovery already in progress');
    }

    this.discovering = true;
    this.discoveredPrinters.clear();

    try {
      // Discover via USB library
      await this.discoverViaUsb();

      // Also try to get system printers
      await this.discoverSystemPrinters();

      return Array.from(this.discoveredPrinters.values());
    } finally {
      this.discovering = false;
    }
  }

  /**
   * Discover printers via USB library
   */
  private async discoverViaUsb(): Promise<void> {
    try {
      const devices = usb.getDeviceList();

      for (const device of devices) {
        if (!this.discovering) break;

        const descriptor = device.deviceDescriptor;
        const vendorId = descriptor.idVendor;
        const productId = descriptor.idProduct;

        // Check if this is a known printer vendor or has printer class
        const isKnownVendor = vendorId in KNOWN_PRINTER_VENDORS;
        const isPrinterClass = this.isPrinterClass(device);

        if (isKnownVendor || isPrinterClass) {
          const printer = await this.createPrinterFromDevice(device);
          if (printer) {
            const key = `${vendorId}:${productId}`;
            this.addDiscoveredPrinter(key, printer);
          }
        }
      }
    } catch (error) {
      console.error('USB discovery error:', error);
    }
  }

  /**
   * Check if a USB device has the printer class
   */
  private isPrinterClass(device: usb.Device): boolean {
    const descriptor = device.deviceDescriptor;
    
    // Check device class
    if (descriptor.bDeviceClass === USB_CLASS_PRINTER) {
      return true;
    }

    // Check interface classes
    try {
      device.open();
      const configDescriptor = device.configDescriptor;
      
      if (configDescriptor && configDescriptor.interfaces) {
        for (const iface of configDescriptor.interfaces) {
          for (const alt of iface) {
            if (alt.bInterfaceClass === USB_CLASS_PRINTER) {
              device.close();
              return true;
            }
          }
        }
      }
      device.close();
    } catch {
      // Device may not be accessible
    }

    return false;
  }

  /**
   * Create a DiscoveredPrinter from a USB device
   */
  private async createPrinterFromDevice(device: usb.Device): Promise<DiscoveredPrinter | null> {
    const descriptor = device.deviceDescriptor;
    const vendorId = descriptor.idVendor;
    const productId = descriptor.idProduct;
    const key = `${vendorId}:${productId}`;

    // Get device strings if possible
    let manufacturer = KNOWN_PRINTER_VENDORS[vendorId] || undefined;
    let productName: string | undefined;

    try {
      device.open();
      
      if (descriptor.iManufacturer) {
        manufacturer = await this.getStringDescriptor(device, descriptor.iManufacturer) || manufacturer;
      }
      
      if (descriptor.iProduct) {
        productName = await this.getStringDescriptor(device, descriptor.iProduct);
      }
      
      device.close();
    } catch {
      // Device may not be accessible for string descriptors
    }

    const name = productName || 
                 (manufacturer ? `${manufacturer} Printer` : `USB Printer (${vendorId.toString(16)}:${productId.toString(16)})`);

    return {
      name,
      type: PrinterType.USB,
      address: key, // vendorId:productId as address
      model: productName,
      manufacturer,
      isConfigured: this.configuredDevices.has(key),
    };
  }

  /**
   * Get a string descriptor from a USB device
   */
  private async getStringDescriptor(device: usb.Device, index: number): Promise<string | undefined> {
    return new Promise((resolve) => {
      try {
        device.getStringDescriptor(index, (error, data) => {
          if (error || !data) {
            resolve(undefined);
          } else {
            resolve(data);
          }
        });
      } catch {
        resolve(undefined);
      }
    });
  }

  /**
   * Discover system printers (via OS print spooler)
   */
  private async discoverSystemPrinters(): Promise<void> {
    try {
      // Try to use the printer package for system printer enumeration
      // This is a dynamic import since it may not be available
      const printerModule = await this.loadPrinterModule();
      
      if (!printerModule) return;

      const printers = await this.getSystemPrinters(printerModule);
      
      for (const printer of printers) {
        if (!this.discovering) break;

        // Only include printers that look like thermal/receipt printers
        if (this.isLikelyThermalPrinter(printer.name)) {
          const key = `system:${printer.name}`;
          
          if (!this.discoveredPrinters.has(key)) {
            const discovered: DiscoveredPrinter = {
              name: printer.name,
              type: PrinterType.USB, // System printers are typically USB
              address: printer.name, // Use name as address for system printers
              isConfigured: this.configuredDevices.has(key) || 
                            this.configuredDevices.has(printer.name),
            };

            this.addDiscoveredPrinter(key, discovered);
          }
        }
      }
    } catch (error) {
      console.warn('System printer discovery not available:', error);
    }
  }

  /**
   * Load the printer module dynamically
   */
  private async loadPrinterModule(): Promise<unknown> {
    try {
      // Try pdf-to-printer for Windows
      const pdfToPrinter = await import('pdf-to-printer');
      return pdfToPrinter;
    } catch {
      return null;
    }
  }

  /**
   * Get list of system printers
   */
  private async getSystemPrinters(printerModule: unknown): Promise<Array<{ name: string }>> {
    try {
      const module = printerModule as { getPrinters: () => Promise<Array<{ name: string }>> };
      if (typeof module.getPrinters === 'function') {
        return await module.getPrinters();
      }
    } catch {
      // Ignore errors
    }
    return [];
  }

  /**
   * Check if a printer name suggests it's a thermal/receipt printer
   */
  private isLikelyThermalPrinter(name: string): boolean {
    const lowerName = name.toLowerCase();
    const thermalPatterns = [
      'thermal',
      'receipt',
      'pos',
      'epson',
      'star',
      'bixolon',
      'citizen',
      'zebra',
      'tsp',
      'tm-',
      'srp-',
      'ct-',
    ];

    return thermalPatterns.some(pattern => lowerName.includes(pattern));
  }

  /**
   * Stop any ongoing discovery
   */
  stopDiscovery(): void {
    this.discovering = false;
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
   * Listen for USB device attach/detach events
   */
  startHotplugMonitoring(
    onAttach?: (printer: DiscoveredPrinter) => void,
    onDetach?: (vendorId: number, productId: number) => void
  ): void {
    // Use usb.usb for the event emitter in newer versions of the usb package
    const usbEvents = usb.usb;
    
    usbEvents.on('attach', async (device: usb.Device) => {
      const descriptor = device.deviceDescriptor;
      const vendorId = descriptor.idVendor;
      
      if (vendorId in KNOWN_PRINTER_VENDORS || this.isPrinterClass(device)) {
        const printer = await this.createPrinterFromDevice(device);
        if (printer && onAttach) {
          onAttach(printer);
        }
      }
    });

    usbEvents.on('detach', (device: usb.Device) => {
      const descriptor = device.deviceDescriptor;
      if (onDetach) {
        onDetach(descriptor.idVendor, descriptor.idProduct);
      }
    });
  }

  /**
   * Stop hotplug monitoring
   */
  stopHotplugMonitoring(): void {
    const usbEvents = usb.usb;
    usbEvents.removeAllListeners('attach');
    usbEvents.removeAllListeners('detach');
  }
}
