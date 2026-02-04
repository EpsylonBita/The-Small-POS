/**
 * Serial Port Discovery Service
 *
 * Discovers ECR payment terminals connected via USB serial ports.
 * Identifies devices by vendor ID and product ID.
 *
 * @module ecr/discovery/SerialDiscovery
 */

import { EventEmitter } from 'events';
import type {
  DiscoveredECRDevice,
  ECRSerialPortInfo,
} from '../../../../../shared/types/ecr';
import {
  ECRDeviceType,
  ECRConnectionType,
  ECRProtocol,
} from '../../../../../shared/types/ecr';
import { TERMINAL_IDENTIFIERS } from '../../../../../shared/ecr/protocols/constants';

/**
 * Events emitted by SerialDiscovery
 */
export enum SerialDiscoveryEvent {
  DEVICE_FOUND = 'device-found',
  DISCOVERY_COMPLETE = 'discovery-complete',
  ERROR = 'error',
}

/**
 * SerialDiscovery - Discovers ECR devices connected via USB serial
 */
export class SerialDiscovery extends EventEmitter {
  private isDiscovering: boolean = false;

  /**
   * Discover ECR devices on serial ports
   */
  async discover(timeout: number = 5000): Promise<DiscoveredECRDevice[]> {
    if (this.isDiscovering) {
      return [];
    }

    this.isDiscovering = true;
    const devices: DiscoveredECRDevice[] = [];

    try {
      const ports = await this.listPorts();

      for (const port of ports) {
        const device = this.identifyDevice(port);
        if (device) {
          devices.push(device);
          this.emit(SerialDiscoveryEvent.DEVICE_FOUND, device);
        }
      }

      this.emit(SerialDiscoveryEvent.DISCOVERY_COMPLETE, devices);
      return devices;
    } catch (error) {
      this.emit(SerialDiscoveryEvent.ERROR, error);
      throw error;
    } finally {
      this.isDiscovering = false;
    }
  }

  /**
   * List all available serial ports
   */
  async listPorts(): Promise<ECRSerialPortInfo[]> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { SerialPort } = require('serialport');
      const ports = await SerialPort.list();

      return ports.map((port: Record<string, string | undefined>) => ({
        path: port.path,
        manufacturer: port.manufacturer,
        serialNumber: port.serialNumber,
        vendorId: port.vendorId?.toLowerCase(),
        productId: port.productId?.toLowerCase(),
        pnpId: port.pnpId,
        locationId: port.locationId,
      }));
    } catch (error) {
      console.error('[SerialDiscovery] Failed to list ports:', error);
      return [];
    }
  }

  /**
   * Identify a device based on port information
   */
  private identifyDevice(port: ECRSerialPortInfo): DiscoveredECRDevice | null {
    const vendorId = port.vendorId?.toLowerCase();
    const productId = port.productId?.toLowerCase();

    // Try to identify by USB vendor/product ID
    const identification = this.identifyByUSBIds(vendorId, productId);

    if (identification) {
      return {
        name: identification.name,
        deviceType: ECRDeviceType.PAYMENT_TERMINAL,
        connectionType: ECRConnectionType.SERIAL_USB,
        connectionDetails: {
          type: ECRConnectionType.SERIAL_USB,
          port: port.path,
          vendorId: port.vendorId,
          productId: port.productId,
        },
        manufacturer: identification.manufacturer,
        model: identification.model,
        serialNumber: port.serialNumber,
        isConfigured: false,
      };
    }

    // For ports without known IDs, check if manufacturer suggests a payment terminal
    if (port.manufacturer) {
      const manufacturer = port.manufacturer.toLowerCase();
      if (
        manufacturer.includes('ingenico') ||
        manufacturer.includes('verifone') ||
        manufacturer.includes('pax')
      ) {
        return {
          name: `${port.manufacturer} Terminal`,
          deviceType: ECRDeviceType.PAYMENT_TERMINAL,
          connectionType: ECRConnectionType.SERIAL_USB,
          connectionDetails: {
            type: ECRConnectionType.SERIAL_USB,
            port: port.path,
            vendorId: port.vendorId,
            productId: port.productId,
          },
          manufacturer: port.manufacturer,
          serialNumber: port.serialNumber,
          isConfigured: false,
        };
      }
    }

    return null;
  }

  /**
   * Identify device by USB vendor and product IDs
   */
  private identifyByUSBIds(
    vendorId?: string,
    productId?: string
  ): { name: string; manufacturer: string; model?: string } | null {
    if (!vendorId) return null;

    // Check Ingenico
    if (vendorId === TERMINAL_IDENTIFIERS.USB.INGENICO.VENDOR_ID) {
      const products = TERMINAL_IDENTIFIERS.USB.INGENICO.PRODUCTS;
      let model: string | undefined;

      if (productId === products.ICT220) model = 'iCT220';
      else if (productId === products.ICT250) model = 'iCT250';
      else if (productId === products.MOVE3500) model = 'Move/3500';
      else if (productId === products.LANE3000) model = 'Lane/3000';

      return {
        name: model ? `Ingenico ${model}` : 'Ingenico Terminal',
        manufacturer: 'Ingenico',
        model,
      };
    }

    // Check Verifone
    if (vendorId === TERMINAL_IDENTIFIERS.USB.VERIFONE.VENDOR_ID) {
      const products = TERMINAL_IDENTIFIERS.USB.VERIFONE.PRODUCTS;
      let model: string | undefined;

      if (productId === products.VX520) model = 'VX520';
      else if (productId === products.VX680) model = 'VX680';
      else if (productId === products.P400) model = 'P400';
      else if (productId === products.M400) model = 'M400';

      return {
        name: model ? `Verifone ${model}` : 'Verifone Terminal',
        manufacturer: 'Verifone',
        model,
      };
    }

    // Check PAX
    if (vendorId === TERMINAL_IDENTIFIERS.USB.PAX.VENDOR_ID) {
      const products = TERMINAL_IDENTIFIERS.USB.PAX.PRODUCTS;
      let model: string | undefined;

      if (productId === products.A80) model = 'A80';
      else if (productId === products.A920) model = 'A920';
      else if (productId === products.S300) model = 'S300';
      else if (productId === products.D210) model = 'D210';

      return {
        name: model ? `PAX ${model}` : 'PAX Terminal',
        manufacturer: 'PAX',
        model,
      };
    }

    return null;
  }

  /**
   * Detect the likely protocol for a device
   */
  detectProtocol(device: DiscoveredECRDevice): ECRProtocol {
    const manufacturer = device.manufacturer?.toLowerCase();

    if (manufacturer?.includes('ingenico') || manufacturer?.includes('verifone')) {
      return ECRProtocol.ZVT; // European terminals typically use ZVT
    }

    if (manufacturer?.includes('pax')) {
      return ECRProtocol.PAX;
    }

    return ECRProtocol.GENERIC;
  }

  /**
   * Check if serial port discovery is supported on this system
   */
  isAvailable(): boolean {
    try {
      require('serialport');
      return true;
    } catch {
      return false;
    }
  }
}
