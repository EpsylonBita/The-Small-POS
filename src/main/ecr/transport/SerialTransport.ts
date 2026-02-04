/**
 * Serial USB Transport Implementation
 *
 * Handles serial port connections to ECR payment terminals via USB.
 * Uses the serialport npm package for cross-platform serial communication.
 *
 * @module ecr/transport/SerialTransport
 */

import {
  BaseECRTransport,
  ECRTransportState,
  ECRTransportEvent,
  type ECRTransportError,
} from './ECRTransport';
import type {
  ECRSerialConnectionDetails,
  ECRTransportOptions,
} from '../../../../../shared/types/ecr';

// Type definitions for serialport package
interface SerialPortOptions {
  path: string;
  baudRate: number;
  dataBits?: 5 | 6 | 7 | 8;
  stopBits?: 1 | 1.5 | 2;
  parity?: 'none' | 'even' | 'odd' | 'mark' | 'space';
  autoOpen?: boolean;
}

interface ISerialPort {
  open(callback?: (error?: Error | null) => void): void;
  close(callback?: (error?: Error | null) => void): void;
  write(data: Buffer | string, callback?: (error?: Error | null) => void): boolean;
  read(size?: number): Buffer | null;
  isOpen: boolean;
  on(event: 'open' | 'close', callback: () => void): this;
  on(event: 'data', callback: (data: Buffer) => void): this;
  on(event: 'error', callback: (error: Error) => void): this;
  removeAllListeners(): this;
}

type SerialPortConstructor = new (options: SerialPortOptions) => ISerialPort;

/**
 * Serial-specific transport options
 */
export interface SerialTransportOptions extends ECRTransportOptions {
  baudRate?: number;
  dataBits?: 5 | 6 | 7 | 8;
  stopBits?: 1 | 1.5 | 2;
  parity?: 'none' | 'even' | 'odd' | 'mark' | 'space';
}

/**
 * Default serial options for most payment terminals
 */
const DEFAULT_SERIAL_OPTIONS: Required<Pick<SerialTransportOptions, 'baudRate' | 'dataBits' | 'stopBits' | 'parity'>> = {
  baudRate: 9600, // Most terminals default to 9600, some use 115200
  dataBits: 8,
  stopBits: 1,
  parity: 'none',
};

/**
 * SerialTransport - Serial USB transport for ECR payment terminals
 *
 * Supports COM ports on Windows and /dev/ttyUSB* on Linux/Mac.
 */
export class SerialTransport extends BaseECRTransport {
  private port: ISerialPort | null = null;
  private portPath: string;
  private serialOptions: Required<Pick<SerialTransportOptions, 'baudRate' | 'dataBits' | 'stopBits' | 'parity'>>;
  private SerialPortClass: SerialPortConstructor | null = null;
  private receiveBuffer: Buffer = Buffer.alloc(0);
  private dataResolvers: Array<{
    resolve: (data: Buffer) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
    minLength: number;
  }> = [];

  constructor(
    connectionDetails: ECRSerialConnectionDetails,
    options?: SerialTransportOptions
  ) {
    super(options);
    this.portPath = connectionDetails.port;
    this.serialOptions = {
      baudRate: options?.baudRate ?? connectionDetails.baudRate ?? DEFAULT_SERIAL_OPTIONS.baudRate,
      dataBits: options?.dataBits ?? connectionDetails.dataBits ?? DEFAULT_SERIAL_OPTIONS.dataBits,
      stopBits: options?.stopBits ?? connectionDetails.stopBits ?? DEFAULT_SERIAL_OPTIONS.stopBits,
      parity: options?.parity ?? connectionDetails.parity ?? DEFAULT_SERIAL_OPTIONS.parity,
    };

    this.loadSerialPortModule();
  }

  /**
   * Load the serialport module dynamically
   */
  private loadSerialPortModule(): void {
    try {
      // Dynamic import to handle optional dependency
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { SerialPort } = require('serialport');
      this.SerialPortClass = SerialPort;
    } catch {
      this.SerialPortClass = null;
    }
  }

  /**
   * Get the serial port path
   */
  getPortPath(): string {
    return this.portPath;
  }

  /**
   * Get serial port options
   */
  getSerialOptions(): typeof this.serialOptions {
    return { ...this.serialOptions };
  }

  /**
   * Check if serialport module is available
   */
  isSerialPortAvailable(): boolean {
    return this.SerialPortClass !== null;
  }

  /**
   * Establish serial port connection
   */
  protected async doConnect(): Promise<void> {
    if (!this.SerialPortClass) {
      throw new Error(
        'Serial port module not available. Please install serialport package: npm install serialport'
      );
    }

    return new Promise((resolve, reject) => {
      this.cleanupPort();

      try {
        this.port = new this.SerialPortClass!({
          path: this.portPath,
          baudRate: this.serialOptions.baudRate,
          dataBits: this.serialOptions.dataBits,
          stopBits: this.serialOptions.stopBits,
          parity: this.serialOptions.parity,
          autoOpen: false,
        });

        this.setupPortListeners();

        this.port.open((error?: Error | null) => {
          if (error) {
            this.cleanupPort();
            reject(error);
          } else {
            resolve();
          }
        });
      } catch (error) {
        this.cleanupPort();
        reject(error);
      }
    });
  }

  /**
   * Close serial port connection
   */
  protected async doDisconnect(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.port || !this.port.isOpen) {
        this.cleanupPort();
        resolve();
        return;
      }

      this.port.close((error?: Error | null) => {
        if (error) {
          console.warn('[SerialTransport] Error closing port:', error);
        }
        this.cleanupPort();
        resolve();
      });
    });
  }

  /**
   * Send data over serial port
   */
  protected async doSend(data: Buffer): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.port || !this.port.isOpen) {
        reject(new Error('Serial port is not open'));
        return;
      }

      this.port.write(data, (error?: Error | null) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }

  /**
   * Receive data from serial port with timeout
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
        minLength: 1,
      });
    });
  }

  /**
   * Receive a specific number of bytes
   */
  async receiveExact(length: number, timeout?: number): Promise<Buffer> {
    const readTimeout = timeout ?? this.options.readTimeout;
    const result = Buffer.alloc(length);
    let offset = 0;
    const startTime = Date.now();

    while (offset < length) {
      const elapsed = Date.now() - startTime;
      if (elapsed >= readTimeout) {
        throw new Error(`Receive timeout after ${readTimeout}ms (got ${offset}/${length} bytes)`);
      }

      const data = await this.doReceive(readTimeout - elapsed);
      const copyLength = Math.min(data.length, length - offset);
      data.copy(result, offset, 0, copyLength);
      offset += copyLength;

      // If we got more data than needed, buffer the rest
      if (data.length > copyLength) {
        this.receiveBuffer = Buffer.concat([
          this.receiveBuffer,
          data.slice(copyLength),
        ]);
      }
    }

    return result;
  }

  /**
   * Set up port event listeners
   */
  private setupPortListeners(): void {
    if (!this.port) return;

    this.port.on('data', (data: Buffer) => {
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

    this.port.on('close', () => {
      if (this.state === ECRTransportState.CONNECTED) {
        this.lastError = 'Serial port closed';
        this.handleConnectionLost();
      }
    });

    this.port.on('error', (error: Error) => {
      this.lastError = error.message;
      const transportError: ECRTransportError = {
        code: 'SERIAL_ERROR',
        message: `Serial port error: ${error.message}`,
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
  }

  /**
   * Clean up port resources
   */
  private cleanupPort(): void {
    if (this.port) {
      try {
        this.port.removeAllListeners();
        if (this.port.isOpen) {
          this.port.close();
        }
      } catch {
        // Ignore cleanup errors
      }
      this.port = null;
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
    this.cleanupPort();
    super.destroy();
  }
}

/**
 * List available serial ports (static utility)
 */
export async function listSerialPorts(): Promise<Array<{
  path: string;
  manufacturer?: string;
  serialNumber?: string;
  vendorId?: string;
  productId?: string;
  pnpId?: string;
}>> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { SerialPort } = require('serialport');
    const ports = await SerialPort.list();
    return ports.map((port: Record<string, string | undefined>) => ({
      path: port.path,
      manufacturer: port.manufacturer,
      serialNumber: port.serialNumber,
      vendorId: port.vendorId,
      productId: port.productId,
      pnpId: port.pnpId,
    }));
  } catch (error) {
    console.error('[SerialTransport] Failed to list serial ports:', error);
    return [];
  }
}
