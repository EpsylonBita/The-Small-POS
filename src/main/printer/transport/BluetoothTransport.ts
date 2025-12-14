/**
 * Bluetooth Transport Implementation
 *
 * Handles Bluetooth Serial Port Profile (SPP) connections to Bluetooth printers.
 * Supports auto-reconnection with 30-second timeout.
 *
 * @module printer/transport/BluetoothTransport
 *
 * Requirements: 3.3, 3.4, 3.5
 */

import {
  BasePrinterTransport,
  TransportOptions,
  TransportState,
  TransportError,
  TransportEvent,
} from './PrinterTransport';
import { PrinterErrorCode, BluetoothConnectionDetails } from '../types';

/**
 * Bluetooth-specific transport options
 */
export interface BluetoothTransportOptions extends TransportOptions {
  /** Auto-reconnect timeout in ms (default: 30000 - 30 seconds) */
  reconnectTimeout?: number;
}

/**
 * Default Bluetooth transport options
 */
const DEFAULT_BLUETOOTH_OPTIONS: BluetoothTransportOptions = {
  connectionTimeout: 10000, // Bluetooth can be slower to connect
  maxRetries: 3,
  retryBaseDelay: 1000,
  autoReconnect: true,
  reconnectTimeout: 30000, // 30 seconds as per requirements
};

/**
 * Interface for Bluetooth serial port connection
 * This abstracts the bluetooth-serial-port package
 */
interface BluetoothSerialPort {
  connect(
    address: string,
    channel: number,
    successCallback: () => void,
    errorCallback: (error: Error) => void
  ): void;
  write(buffer: Buffer, callback: (error?: Error) => void): void;
  close(): void;
  on(event: 'data', callback: (data: Buffer) => void): void;
  on(event: 'close', callback: () => void): void;
  on(event: 'error', callback: (error: Error) => void): void;
  on(event: 'failure', callback: (error: Error) => void): void;
  on(event: string, callback: (...args: unknown[]) => void): void;
  removeAllListeners(): void;
  isOpen(): boolean;
}

/**
 * Factory function type for creating Bluetooth serial port instances
 */
type BluetoothSerialPortFactory = () => BluetoothSerialPort;

/**
 * BluetoothTransport - Bluetooth SPP transport for Bluetooth printers
 *
 * Requirements: 3.3, 3.4, 3.5
 */
export class BluetoothTransport extends BasePrinterTransport {
  private connection: BluetoothSerialPort | null = null;
  private address: string;
  private channel: number;
  private deviceName?: string;
  private bluetoothOptions: BluetoothTransportOptions;
  private serialPortFactory: BluetoothSerialPortFactory | null = null;

  /**
   * Create a new BluetoothTransport
   *
   * @param connectionDetails - Bluetooth connection details (MAC address, channel)
   * @param options - Transport options
   */
  constructor(
    connectionDetails: BluetoothConnectionDetails,
    options?: BluetoothTransportOptions
  ) {
    super({ ...DEFAULT_BLUETOOTH_OPTIONS, ...options });
    this.address = connectionDetails.address;
    this.channel = connectionDetails.channel || 1;
    this.deviceName = connectionDetails.deviceName;
    this.bluetoothOptions = { ...DEFAULT_BLUETOOTH_OPTIONS, ...options };

    // Try to load bluetooth-serial-port dynamically
    this.loadBluetoothModule();
  }

  /**
   * Load the bluetooth-serial-port module dynamically
   * This allows the transport to work even if the module isn't installed
   */
  private loadBluetoothModule(): void {
    try {
      // Dynamic import to handle optional dependency
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const BluetoothSerialPortModule = require('bluetooth-serial-port');
      this.serialPortFactory = () =>
        new BluetoothSerialPortModule.BluetoothSerialPort() as BluetoothSerialPort;
    } catch {
      // Module not available - will throw on connect attempt
      this.serialPortFactory = null;
    }
  }

  /**
   * Set a custom serial port factory (for testing)
   */
  setSerialPortFactory(factory: BluetoothSerialPortFactory): void {
    this.serialPortFactory = factory;
  }

  /**
   * Get the Bluetooth MAC address
   */
  getAddress(): string {
    return this.address;
  }

  /**
   * Get the RFCOMM channel
   */
  getChannel(): number {
    return this.channel;
  }

  /**
   * Get the device name
   */
  getDeviceName(): string | undefined {
    return this.deviceName;
  }

  /**
   * Establish Bluetooth serial port connection
   *
   * Requirements: 3.3
   */
  protected async doConnect(): Promise<void> {
    if (!this.serialPortFactory) {
      throw new Error(
        'Bluetooth serial port module not available. Please install bluetooth-serial-port package.'
      );
    }

    return new Promise((resolve, reject) => {
      // Clean up any existing connection
      this.cleanupConnection();

      // Create new connection
      this.connection = this.serialPortFactory!();

      // Set up event handlers before connecting
      this.setupConnectionListeners();

      // Attempt connection
      this.connection.connect(
        this.address,
        this.channel,
        () => {
          // Connection successful
          resolve();
        },
        (error: Error) => {
          // Connection failed
          this.cleanupConnection();
          reject(error);
        }
      );
    });
  }

  /**
   * Close Bluetooth serial port connection
   *
   * Requirements: 3.3
   */
  protected async doDisconnect(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.connection) {
        resolve();
        return;
      }

      try {
        this.connection.close();
      } catch {
        // Ignore close errors
      }

      this.cleanupConnection();
      resolve();
    });
  }

  /**
   * Send data over Bluetooth serial port
   *
   * Requirements: 3.4
   */
  protected async doSend(data: Buffer): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.connection) {
        reject(new Error('Bluetooth connection is not established'));
        return;
      }

      this.connection.write(data, (error?: Error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }

  /**
   * Set up connection event listeners
   */
  private setupConnectionListeners(): void {
    if (!this.connection) return;

    // Handle incoming data
    this.connection.on('data', (data: Buffer) => {
      this.emitData(data);
    });

    // Handle connection close
    this.connection.on('close', () => {
      if (this.state === TransportState.CONNECTED) {
        this.lastError = 'Bluetooth connection closed';
        this.handleConnectionLost();
      }
    });

    // Handle connection errors
    this.connection.on('error', (error: Error) => {
      this.lastError = error.message;
      const transportError: TransportError = {
        code: PrinterErrorCode.CONNECTION_LOST,
        message: `Bluetooth error: ${error.message}`,
        originalError: error,
        recoverable: true,
      };
      this.emit(TransportEvent.ERROR, transportError);
    });

    // Handle disconnection
    this.connection.on('failure', (error: Error) => {
      this.lastError = error.message;
      if (this.state === TransportState.CONNECTED) {
        this.handleConnectionLost();
      }
    });
  }

  /**
   * Clean up connection resources
   */
  private cleanupConnection(): void {
    if (this.connection) {
      try {
        this.connection.removeAllListeners();
        if (this.connection.isOpen()) {
          this.connection.close();
        }
      } catch {
        // Ignore cleanup errors
      }
      this.connection = null;
    }
  }

  /**
   * Check if Bluetooth module is available
   */
  isBluetoothAvailable(): boolean {
    return this.serialPortFactory !== null;
  }

  /**
   * Clean up resources
   */
  destroy(): void {
    this.cleanupConnection();
    super.destroy();
  }
}
