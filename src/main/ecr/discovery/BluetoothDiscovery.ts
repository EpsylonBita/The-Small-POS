/**
 * Bluetooth Discovery Service
 *
 * Discovers ECR payment terminals via Bluetooth.
 * Identifies devices by name pattern matching.
 *
 * @module ecr/discovery/BluetoothDiscovery
 */

import { EventEmitter } from 'events';
import type {
  DiscoveredECRDevice,
  ECRBluetoothDeviceInfo,
} from '../../../../../shared/types/ecr';
import {
  ECRDeviceType,
  ECRConnectionType,
  ECRProtocol,
} from '../../../../../shared/types/ecr';
import { TERMINAL_IDENTIFIERS } from '../../../../../shared/ecr/protocols/constants';

/**
 * Interface for Bluetooth serial port scanner
 */
interface BluetoothSerialPort {
  inquire(): void;
  listPairedDevices(callback: (devices: BluetoothDevice[]) => void): void;
  on(event: 'found', callback: (address: string, name: string) => void): void;
  on(event: 'finished', callback: () => void): void;
  on(event: 'failure', callback: (error: Error) => void): void;
  removeAllListeners(): void;
}

interface BluetoothDevice {
  address: string;
  name: string;
}

/**
 * Events emitted by BluetoothDiscovery
 */
export enum BluetoothDiscoveryEvent {
  DEVICE_FOUND = 'device-found',
  DISCOVERY_COMPLETE = 'discovery-complete',
  ERROR = 'error',
}

/**
 * BluetoothDiscovery - Discovers ECR devices via Bluetooth
 */
export class BluetoothDiscovery extends EventEmitter {
  private isDiscovering: boolean = false;
  private btSerial: BluetoothSerialPort | null = null;

  constructor() {
    super();
    this.loadBluetoothModule();
  }

  /**
   * Load the bluetooth-serial-port module
   */
  private loadBluetoothModule(): void {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const BluetoothSerialPort = require('bluetooth-serial-port');
      this.btSerial = new BluetoothSerialPort.BluetoothSerialPort();
    } catch {
      this.btSerial = null;
    }
  }

  /**
   * Discover ECR devices via Bluetooth
   */
  async discover(timeout: number = 10000): Promise<DiscoveredECRDevice[]> {
    if (this.isDiscovering) {
      return [];
    }

    if (!this.btSerial) {
      throw new Error(
        'Bluetooth module not available. Please install bluetooth-serial-port package.'
      );
    }

    this.isDiscovering = true;
    const devices: DiscoveredECRDevice[] = [];
    const foundAddresses = new Set<string>();

    return new Promise((resolve, reject) => {
      // Set up timeout
      const timeoutHandle = setTimeout(() => {
        this.btSerial?.removeAllListeners();
        this.isDiscovering = false;
        this.emit(BluetoothDiscoveryEvent.DISCOVERY_COMPLETE, devices);
        resolve(devices);
      }, timeout);

      // First, get paired devices
      this.btSerial!.listPairedDevices((pairedDevices: BluetoothDevice[]) => {
        for (const device of pairedDevices) {
          if (this.isPaymentTerminal(device.name)) {
            foundAddresses.add(device.address);
            const ecrDevice = this.createDevice(device.address, device.name, true);
            devices.push(ecrDevice);
            this.emit(BluetoothDiscoveryEvent.DEVICE_FOUND, ecrDevice);
          }
        }
      });

      // Then scan for new devices
      this.btSerial!.on('found', (address: string, name: string) => {
        if (!foundAddresses.has(address) && this.isPaymentTerminal(name)) {
          foundAddresses.add(address);
          const device = this.createDevice(address, name, false);
          devices.push(device);
          this.emit(BluetoothDiscoveryEvent.DEVICE_FOUND, device);
        }
      });

      this.btSerial!.on('finished', () => {
        clearTimeout(timeoutHandle);
        this.btSerial?.removeAllListeners();
        this.isDiscovering = false;
        this.emit(BluetoothDiscoveryEvent.DISCOVERY_COMPLETE, devices);
        resolve(devices);
      });

      this.btSerial!.on('failure', (error: Error) => {
        clearTimeout(timeoutHandle);
        this.btSerial?.removeAllListeners();
        this.isDiscovering = false;
        this.emit(BluetoothDiscoveryEvent.ERROR, error);
        reject(error);
      });

      // Start inquiry
      try {
        this.btSerial!.inquire();
      } catch (error) {
        clearTimeout(timeoutHandle);
        this.isDiscovering = false;
        reject(error);
      }
    });
  }

  /**
   * Get list of paired Bluetooth devices that appear to be payment terminals
   */
  async getPairedTerminals(): Promise<DiscoveredECRDevice[]> {
    if (!this.btSerial) {
      return [];
    }

    return new Promise((resolve) => {
      const devices: DiscoveredECRDevice[] = [];

      this.btSerial!.listPairedDevices((pairedDevices: BluetoothDevice[]) => {
        for (const device of pairedDevices) {
          if (this.isPaymentTerminal(device.name)) {
            devices.push(this.createDevice(device.address, device.name, true));
          }
        }
        resolve(devices);
      });
    });
  }

  /**
   * Check if a device name matches known payment terminal patterns
   */
  private isPaymentTerminal(name: string): boolean {
    if (!name) return false;

    const patterns = TERMINAL_IDENTIFIERS.BLUETOOTH;

    return (
      patterns.INGENICO.test(name) ||
      patterns.VERIFONE.test(name) ||
      patterns.PAX.test(name) ||
      patterns.GENERIC.test(name)
    );
  }

  /**
   * Identify manufacturer from device name
   */
  private identifyManufacturer(name: string): { manufacturer: string; model?: string } {
    const patterns = TERMINAL_IDENTIFIERS.BLUETOOTH;

    if (patterns.INGENICO.test(name)) {
      const match = name.match(/^(iCT|iPP|iSMP|iSC|Move|Lane)[\s-]?(\S*)/i);
      return {
        manufacturer: 'Ingenico',
        model: match ? `${match[1]} ${match[2] || ''}`.trim() : undefined,
      };
    }

    if (patterns.VERIFONE.test(name)) {
      const match = name.match(/^(VX|P400|M400|e355|Carbon)[\s-]?(\S*)/i);
      return {
        manufacturer: 'Verifone',
        model: match ? `${match[1]} ${match[2] || ''}`.trim() : undefined,
      };
    }

    if (patterns.PAX.test(name)) {
      const match = name.match(/^(PAX[\s-]?)?(A80|A920|S300|D210|E\d+)/i);
      return {
        manufacturer: 'PAX',
        model: match ? match[2] : undefined,
      };
    }

    return { manufacturer: 'Unknown' };
  }

  /**
   * Create a DiscoveredECRDevice from Bluetooth info
   */
  private createDevice(address: string, name: string, paired: boolean): DiscoveredECRDevice {
    const identification = this.identifyManufacturer(name);

    return {
      name: name || `Terminal ${address.slice(-5)}`,
      deviceType: ECRDeviceType.PAYMENT_TERMINAL,
      connectionType: ECRConnectionType.BLUETOOTH,
      connectionDetails: {
        type: ECRConnectionType.BLUETOOTH,
        address,
        deviceName: name,
      },
      manufacturer: identification.manufacturer,
      model: identification.model,
      isConfigured: false,
    };
  }

  /**
   * Detect the likely protocol for a device
   */
  detectProtocol(device: DiscoveredECRDevice): ECRProtocol {
    const manufacturer = device.manufacturer?.toLowerCase();

    if (manufacturer === 'ingenico' || manufacturer === 'verifone') {
      return ECRProtocol.ZVT;
    }

    if (manufacturer === 'pax') {
      return ECRProtocol.PAX;
    }

    return ECRProtocol.GENERIC;
  }

  /**
   * Check if Bluetooth is available on this system
   */
  async isBluetoothAvailable(): Promise<{ available: boolean; error?: string }> {
    if (!this.btSerial) {
      return {
        available: false,
        error: 'Bluetooth module not installed',
      };
    }

    // The bluetooth-serial-port module doesn't provide a direct way to check
    // Bluetooth availability, so we just check if the module loaded
    return { available: true };
  }

  /**
   * Check if module is loaded
   */
  isAvailable(): boolean {
    return this.btSerial !== null;
  }
}
