/**
 * Bluetooth Transport Implementation
 *
 * Handles Bluetooth Serial Port Profile (SPP) connections to ECR payment terminals.
 * Uses the bluetooth-serial-port npm package for cross-platform Bluetooth communication.
 *
 * @module ecr/transport/BluetoothTransport
 */

import {
  BaseECRTransport,
  ECRTransportState,
  ECRTransportEvent,
  type ECRTransportError,
} from './ECRTransport';
import type {
  ECRBluetoothConnectionDetails,
  ECRTransportOptions,
} from '../../../../../shared/types/ecr';

/**
 * Interface for Bluetooth serial port connection
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

type BluetoothSerialPortFactory = () => BluetoothSerialPort;

/**
 * Bluetooth-specific transport options
 */
export interface BluetoothTransportOptions extends ECRTransportOptions {
  /** RFCOMM channel (default 1) */
  channel?: number;
}

/**
 * Default Bluetooth transport options
 */
const DEFAULT_BLUETOOTH_OPTIONS: Partial<BluetoothTransportOptions> = {
  connectionTimeout: 10000, // Bluetooth can be slower
  channel: 1,
};

/**
 * BluetoothTransport - Bluetooth SPP transport for ECR payment terminals
 *
 * Supports Bluetooth terminals from Ingenico, Verifone, and PAX.
 */
export class BluetoothTransport extends BaseECRTransport {
  private connection: BluetoothSerialPort | null = null;
  private address: string;
  private channel: number;
  private deviceName?: string;
  private serialPortFactory: BluetoothSerialPortFactory | null = null;
  private receiveBuffer: Buffer = Buffer.alloc(0);
  private dataResolvers: Array<{
    resolve: (data: Buffer) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
  }> = [];

  constructor(
    connectionDetails: ECRBluetoothConnectionDetails,
    options?: BluetoothTransportOptions
  ) {
    super({ ...DEFAULT_BLUETOOTH_OPTIONS, ...options });
    this.address = connectionDetails.address;
    this.channel = connectionDetails.channel ?? options?.channel ?? 1;
    this.deviceName = connectionDetails.deviceName;

    this.loadBluetoothModule();
  }

  /**
   * Load the bluetooth-serial-port module dynamically
   */
  private loadBluetoothModule(): void {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const BluetoothSerialPortModule = require('bluetooth-serial-port');
      this.serialPortFactory = () =>
        new BluetoothSerialPortModule.BluetoothSerialPort() as BluetoothSerialPort;
    } catch {
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
   * Check if Bluetooth module is available
   */
  isBluetoothAvailable(): boolean {
    return this.serialPortFactory !== null;
  }

  /**
   * Establish Bluetooth serial port connection
   */
  protected async doConnect(): Promise<void> {
    if (!this.serialPortFactory) {
      throw new Error(
        'Bluetooth serial port module not available. Please install bluetooth-serial-port package.'
      );
    }

    return new Promise((resolve, reject) => {
      this.cleanupConnection();

      this.connection = this.serialPortFactory!();
      this.setupConnectionListeners();

      this.connection.connect(
        this.address,
        this.channel,
        () => {
          resolve();
        },
        (error: Error) => {
          this.cleanupConnection();
          reject(error);
        }
      );
    });
  }

  /**
   * Close Bluetooth serial port connection
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
   * Receive data from Bluetooth with timeout
   */
  protected async doReceive(timeout?: number): Promise<Buffer> {
    const readTimeout = timeout ?? this.options.readTimeout;

    return new Promise((resolve, reject) => {
      // Check if we already have data in buffer
      if (this.receiveBuffer.length > 0) {
        const data = this.receiveBuffer;
        this.receiveBuffer = Buffer.alloc(0);
        resolve(data);
        return;
      }

      // Set up timeout
      const timeoutHandle = setTimeout(() => {
        const index = this.dataResolvers.findIndex(
          (r) => r.timeout === timeoutHandle
        );
        if (index !== -1) {
          this.dataResolvers.splice(index, 1);
        }
        reject(new Error(`Receive timeout after ${readTimeout}ms`));
      }, readTimeout);

      // Queue the resolver
      this.dataResolvers.push({
        resolve: (data: Buffer) => {
          clearTimeout(timeoutHandle);
          resolve(data);
        },
        reject: (error: Error) => {
          clearTimeout(timeoutHandle);
          reject(error);
        },
        timeout: timeoutHandle,
      });
    });
  }

  /**
   * Set up connection event listeners
   */
  private setupConnectionListeners(): void {
    if (!this.connection) return;

    this.connection.on('data', (data: Buffer) => {
      // If we have pending resolvers, resolve the first one
      if (this.dataResolvers.length > 0) {
        const resolver = this.dataResolvers.shift()!;
        resolver.resolve(data);
      } else {
        // Buffer the data
        this.receiveBuffer = Buffer.concat([this.receiveBuffer, data]);
        this.emitData(data);
      }
    });

    this.connection.on('close', () => {
      if (this.state === ECRTransportState.CONNECTED) {
        this.lastError = 'Bluetooth connection closed';
        this.handleConnectionLost();
      }
    });

    this.connection.on('error', (error: Error) => {
      this.lastError = error.message;
      const transportError: ECRTransportError = {
        code: 'BLUETOOTH_ERROR',
        message: `Bluetooth error: ${error.message}`,
        originalError: error,
        recoverable: true,
      };
      this.emit(ECRTransportEvent.ERROR, transportError);

      // Reject all pending receivers
      for (const resolver of this.dataResolvers) {
        clearTimeout(resolver.timeout);
        resolver.reject(error);
      }
      this.dataResolvers = [];
    });

    this.connection.on('failure', (error: Error) => {
      this.lastError = error.message;
      if (this.state === ECRTransportState.CONNECTED) {
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

    // Clear receive buffer and resolvers
    this.receiveBuffer = Buffer.alloc(0);
    for (const resolver of this.dataResolvers) {
      clearTimeout(resolver.timeout);
    }
    this.dataResolvers = [];
  }

  /**
   * Flush the receive buffer
   */
  flushReceiveBuffer(): void {
    this.receiveBuffer = Buffer.alloc(0);
  }

  /**
   * Clean up resources
   */
  destroy(): void {
    this.cleanupConnection();
    super.destroy();
  }
}
