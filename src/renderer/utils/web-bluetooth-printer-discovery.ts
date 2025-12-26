/**
 * Web Bluetooth Printer Discovery Utility
 *
 * Uses the Web Bluetooth API to discover Bluetooth printers.
 * This works in Electron's renderer process when Bluetooth permissions are enabled.
 *
 * Requirements: Electron 35+ with Web Bluetooth enabled
 */

// Type definitions for Web Bluetooth API
declare global {
  interface Navigator {
    bluetooth?: {
      requestDevice(options: RequestDeviceOptions): Promise<BluetoothDevice>;
      getAvailability(): Promise<boolean>;
    };
  }

  interface RequestDeviceOptions {
    acceptAllDevices?: boolean;
    filters?: BluetoothLEScanFilter[];
    optionalServices?: string[];
  }

  interface BluetoothLEScanFilter {
    services?: string[];
    name?: string;
    namePrefix?: string;
  }

  interface BluetoothDevice {
    id: string;
    name?: string;
    gatt?: BluetoothRemoteGATTServer;
    watchAdvertisements?(): Promise<void>;
    forget?(): Promise<void>;
  }

  interface BluetoothRemoteGATTServer {
    connected: boolean;
    device: BluetoothDevice;
    connect(): Promise<BluetoothRemoteGATTServer>;
    disconnect(): void;
    getPrimaryService(service: string): Promise<any>;
  }
}

export interface BluetoothPrinterDevice {
  name: string;
  address: string; // Bluetooth device ID
  deviceName: string;
  type: 'bluetooth';
  isConfigured: boolean;
}

/**
 * Check if Web Bluetooth is available
 */
export function isWebBluetoothAvailable(): boolean {
  return 'bluetooth' in navigator;
}

/**
 * Discover Bluetooth printers using Web Bluetooth API
 *
 * @returns Promise<BluetoothPrinterDevice[]> - Array of discovered printer devices
 */
export async function discoverBluetoothPrinters(): Promise<BluetoothPrinterDevice[]> {
  if (!isWebBluetoothAvailable()) {
    console.warn('[WebBluetooth] Web Bluetooth API not available');
    return [];
  }

  try {
    console.log('[WebBluetooth] Requesting Bluetooth devices...');

    // Request Bluetooth devices
    // We use optional services to allow communication with any device
    const device = await navigator.bluetooth!.requestDevice({
      // Accept all devices - Electron will filter them in select-bluetooth-device event
      acceptAllDevices: true,
      optionalServices: ['battery_service', 'device_information'] // Common services
    });

    console.log('[WebBluetooth] Device selected:', device.name, device.id);

    // Create discovered printer object
    const printer: BluetoothPrinterDevice = {
      name: device.name || `Bluetooth Printer (${device.id.substring(0, 8)})`,
      address: device.id, // Use device ID as address
      deviceName: device.name || 'Unknown',
      type: 'bluetooth',
      isConfigured: false // The calling code should check this
    };

    return [printer];
  } catch (error: any) {
    // User cancelled the picker or no devices found
    if (error.name === 'NotFoundError') {
      console.log('[WebBluetooth] No Bluetooth devices found or user cancelled');
      return [];
    }

    // Permission denied
    if (error.name === 'SecurityError' || error.name === 'NotAllowedError') {
      console.error('[WebBluetooth] Bluetooth permission denied:', error);
      throw new Error('Bluetooth permission denied. Please enable Bluetooth permissions.');
    }

    // Other errors
    console.error('[WebBluetooth] Discovery error:', error);
    throw new Error(`Bluetooth discovery failed: ${error.message}`);
  }
}

/**
 * Get Bluetooth status
 *
 * @returns Promise with availability status
 */
export async function getBluetoothStatus(): Promise<{ available: boolean; error?: string }> {
  if (!isWebBluetoothAvailable()) {
    return {
      available: false,
      error: 'Web Bluetooth API not available. This browser/platform does not support Bluetooth.'
    };
  }

  try {
    // Check if Bluetooth is available on the system
    const available = await navigator.bluetooth!.getAvailability();

    if (!available) {
      return {
        available: false,
        error: 'Bluetooth is not available on this system. Please ensure Bluetooth is enabled.'
      };
    }

    return { available: true };
  } catch (error: any) {
    return {
      available: false,
      error: `Failed to check Bluetooth availability: ${error.message}`
    };
  }
}
