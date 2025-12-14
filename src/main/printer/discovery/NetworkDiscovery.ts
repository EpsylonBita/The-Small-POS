/**
 * Network Printer Discovery Service
 * 
 * Discovers network printers using:
 * - mDNS/Bonjour for printers advertising print services
 * - Broadcast discovery on port 9100 (standard raw printing port)
 * 
 * @module printer/discovery
 * Requirements: 1.1, 5.1, 5.2
 */

import { DiscoveredPrinter, PrinterType } from '../types';
import { PrinterDiscovery, PrinterFoundCallback } from './PrinterDiscovery';
import Bonjour, { Service, Browser } from 'bonjour-service';
import * as net from 'net';
import * as os from 'os';

/**
 * Default port for raw printing (ESC/POS over TCP)
 */
const DEFAULT_PRINTER_PORT = 9100;

/**
 * Default discovery timeout in milliseconds
 */
const DEFAULT_TIMEOUT = 10000;

/**
 * Connection test timeout in milliseconds
 */
const CONNECTION_TEST_TIMEOUT = 2000;

/**
 * Service types to search for via mDNS
 */
const MDNS_SERVICE_TYPES = [
  'pdl-datastream', // Raw printing (port 9100)
  'ipp',            // Internet Printing Protocol
  'printer',        // Generic printer service
];

/**
 * Network printer discovery service using mDNS/Bonjour and broadcast scanning
 */
export class NetworkDiscovery implements PrinterDiscovery {
  private bonjour: Bonjour | null = null;
  private browsers: Browser[] = [];
  private discovering = false;
  private callbacks: PrinterFoundCallback[] = [];
  private discoveredPrinters: Map<string, DiscoveredPrinter> = new Map();
  private configuredAddresses: Set<string> = new Set();

  /**
   * Create a new NetworkDiscovery instance
   * @param configuredAddresses - Set of already configured printer addresses
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
   * Discover network printers using mDNS and broadcast scanning
   */
  async discover(timeout: number = DEFAULT_TIMEOUT): Promise<DiscoveredPrinter[]> {
    if (this.discovering) {
      throw new Error('Discovery already in progress');
    }

    this.discovering = true;
    this.discoveredPrinters.clear();

    try {
      // Run mDNS and broadcast discovery in parallel
      await Promise.all([
        this.discoverViaMdns(timeout),
        this.discoverViaBroadcast(timeout),
      ]);

      return Array.from(this.discoveredPrinters.values());
    } finally {
      this.stopDiscovery();
    }
  }

  /**
   * Stop any ongoing discovery
   */
  stopDiscovery(): void {
    this.discovering = false;

    // Stop all mDNS browsers
    for (const browser of this.browsers) {
      try {
        browser.stop();
      } catch {
        // Ignore errors when stopping
      }
    }
    this.browsers = [];

    // Destroy bonjour instance
    if (this.bonjour) {
      try {
        this.bonjour.destroy();
      } catch {
        // Ignore errors when destroying
      }
      this.bonjour = null;
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
   * Discover printers via mDNS/Bonjour
   */
  private async discoverViaMdns(timeout: number): Promise<void> {
    return new Promise((resolve) => {
      try {
        this.bonjour = new Bonjour();

        // Search for each service type
        for (const serviceType of MDNS_SERVICE_TYPES) {
          const browser = this.bonjour.find({ type: serviceType }, (service: Service) => {
            this.handleMdnsService(service);
          });
          this.browsers.push(browser);
        }

        // Resolve after timeout
        setTimeout(() => {
          resolve();
        }, timeout);
      } catch (error) {
        // mDNS may not be available on all systems
        console.warn('mDNS discovery failed:', error);
        resolve();
      }
    });
  }

  /**
   * Handle a discovered mDNS service
   */
  private handleMdnsService(service: Service): void {
    if (!this.discovering) return;

    // Extract IP address from service
    const addresses = service.addresses || [];
    const ipv4Address = addresses.find((addr: string) => net.isIPv4(addr));
    
    if (!ipv4Address) return;

    const port = service.port || DEFAULT_PRINTER_PORT;
    const key = `${ipv4Address}:${port}`;

    // Skip if already discovered
    if (this.discoveredPrinters.has(key)) return;

    const printer: DiscoveredPrinter = {
      name: service.name || `Network Printer (${ipv4Address})`,
      type: PrinterType.WIFI, // mDNS typically indicates WiFi printers
      address: ipv4Address,
      port: port,
      model: service.txt?.['ty'] || service.txt?.['product'] || undefined,
      manufacturer: service.txt?.['usb_MFG'] || service.txt?.['mfg'] || undefined,
      isConfigured: this.configuredAddresses.has(ipv4Address) || 
                    this.configuredAddresses.has(key),
    };

    this.addDiscoveredPrinter(key, printer);
  }

  /**
   * Discover printers via broadcast scanning on port 9100
   */
  private async discoverViaBroadcast(timeout: number): Promise<void> {
    const localSubnets = this.getLocalSubnets();
    const scanPromises: Promise<void>[] = [];

    for (const subnet of localSubnets) {
      // Scan common printer IP ranges in the subnet
      // Only scan last 50 addresses to keep it fast
      for (let i = 1; i <= 50; i++) {
        const ip = `${subnet}.${i}`;
        scanPromises.push(this.testPrinterConnection(ip, DEFAULT_PRINTER_PORT, timeout));
      }
      // Also scan common printer addresses (100-110, 200-210)
      for (let i = 100; i <= 110; i++) {
        const ip = `${subnet}.${i}`;
        scanPromises.push(this.testPrinterConnection(ip, DEFAULT_PRINTER_PORT, timeout));
      }
      for (let i = 200; i <= 210; i++) {
        const ip = `${subnet}.${i}`;
        scanPromises.push(this.testPrinterConnection(ip, DEFAULT_PRINTER_PORT, timeout));
      }
    }

    // Wait for all scans to complete (with individual timeouts)
    await Promise.allSettled(scanPromises);
  }

  /**
   * Test if a printer is available at the given IP and port
   */
  private async testPrinterConnection(ip: string, port: number, _timeout: number): Promise<void> {
    return new Promise((resolve) => {
      if (!this.discovering) {
        resolve();
        return;
      }

      const socket = new net.Socket();
      const key = `${ip}:${port}`;

      // Skip if already discovered
      if (this.discoveredPrinters.has(key)) {
        resolve();
        return;
      }

      socket.setTimeout(CONNECTION_TEST_TIMEOUT);

      socket.on('connect', () => {
        // Found a printer!
        const printer: DiscoveredPrinter = {
          name: `Network Printer (${ip})`,
          type: PrinterType.NETWORK,
          address: ip,
          port: port,
          isConfigured: this.configuredAddresses.has(ip) || 
                        this.configuredAddresses.has(key),
        };

        this.addDiscoveredPrinter(key, printer);
        socket.destroy();
        resolve();
      });

      socket.on('error', () => {
        socket.destroy();
        resolve();
      });

      socket.on('timeout', () => {
        socket.destroy();
        resolve();
      });

      try {
        socket.connect(port, ip);
      } catch {
        resolve();
      }
    });
  }

  /**
   * Get local network subnets (first 3 octets)
   */
  private getLocalSubnets(): string[] {
    const subnets: Set<string> = new Set();
    const interfaces = os.networkInterfaces();

    for (const name in interfaces) {
      const iface = interfaces[name];
      if (!iface) continue;

      for (const addr of iface) {
        // Only consider IPv4, non-internal addresses
        if (addr.family === 'IPv4' && !addr.internal) {
          const parts = addr.address.split('.');
          if (parts.length === 4) {
            subnets.add(`${parts[0]}.${parts[1]}.${parts[2]}`);
          }
        }
      }
    }

    return Array.from(subnets);
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
}
