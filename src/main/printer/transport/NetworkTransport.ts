/**
 * Network Transport Implementation
 *
 * Handles TCP/IP socket connections to network printers.
 * Supports both wired network and WiFi printers on port 9100.
 *
 * @module printer/transport/NetworkTransport
 *
 * Requirements: 2.2, 2.3, 2.4, 5.3
 */

import * as net from 'net';
import {
  BasePrinterTransport,
  TransportOptions,
  TransportState,
  TransportError,
  TransportEvent,
} from './PrinterTransport';
import { PrinterErrorCode, NetworkConnectionDetails } from '../types';

/**
 * Network-specific transport options
 */
export interface NetworkTransportOptions extends TransportOptions {
  /** Keep-alive interval in ms (default: 10000) */
  keepAliveInterval?: number;
  /** Enable TCP keep-alive (default: true) */
  enableKeepAlive?: boolean;
  /** TCP no-delay option (default: true) */
  noDelay?: boolean;
}

/**
 * Default network transport options
 */
const DEFAULT_NETWORK_OPTIONS: NetworkTransportOptions = {
  connectionTimeout: 5000,
  maxRetries: 3,
  retryBaseDelay: 1000,
  autoReconnect: true,
  reconnectTimeout: 30000,
  keepAliveInterval: 10000,
  enableKeepAlive: true,
  noDelay: true,
};

/**
 * NetworkTransport - TCP/IP socket transport for network printers
 *
 * Requirements: 2.2, 2.3, 2.4, 5.3
 */
export class NetworkTransport extends BasePrinterTransport {
  private socket: net.Socket | null = null;
  private ip: string;
  private port: number;
  private hostname?: string;
  private networkOptions: NetworkTransportOptions;

  /**
   * Create a new NetworkTransport
   *
   * @param connectionDetails - Network connection details (IP, port, hostname)
   * @param options - Transport options
   */
  constructor(
    connectionDetails: NetworkConnectionDetails,
    options?: NetworkTransportOptions
  ) {
    super(options);
    this.ip = connectionDetails.ip;
    this.port = connectionDetails.port || 9100;
    this.hostname = connectionDetails.hostname;
    this.networkOptions = { ...DEFAULT_NETWORK_OPTIONS, ...options };
  }

  /**
   * Get the IP address
   */
  getIp(): string {
    return this.ip;
  }

  /**
   * Get the port number
   */
  getPort(): number {
    return this.port;
  }

  /**
   * Update connection details (for DHCP IP changes)
   *
   * Requirements: 5.4
   */
  updateConnectionDetails(ip: string, port?: number): void {
    this.ip = ip;
    if (port !== undefined) {
      this.port = port;
    }
  }

  /**
   * Establish TCP socket connection
   *
   * Requirements: 2.2
   */
  protected async doConnect(): Promise<void> {
    return new Promise((resolve, reject) => {
      // Clean up any existing socket
      this.cleanupSocket();

      // Create new socket
      this.socket = new net.Socket();

      // Configure socket options
      if (this.networkOptions.noDelay) {
        this.socket.setNoDelay(true);
      }

      if (this.networkOptions.enableKeepAlive) {
        this.socket.setKeepAlive(true, this.networkOptions.keepAliveInterval);
      }

      // Set up event handlers
      this.socket.once('connect', () => {
        this.setupSocketListeners();
        resolve();
      });

      this.socket.once('error', (error: Error) => {
        this.cleanupSocket();
        reject(error);
      });

      // Attempt connection
      this.socket.connect(this.port, this.ip);
    });
  }

  /**
   * Close TCP socket connection
   *
   * Requirements: 2.2
   */
  protected async doDisconnect(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.socket) {
        resolve();
        return;
      }

      // Set a timeout for graceful close
      const closeTimeout = setTimeout(() => {
        this.cleanupSocket();
        resolve();
      }, 1000);

      this.socket.once('close', () => {
        clearTimeout(closeTimeout);
        this.cleanupSocket();
        resolve();
      });

      // End the socket gracefully
      this.socket.end();
    });
  }

  /**
   * Send data over TCP socket
   *
   * Requirements: 2.4
   */
  protected async doSend(data: Buffer): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.socket || this.socket.destroyed) {
        reject(new Error('Socket is not connected'));
        return;
      }

      this.socket.write(data, (error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }

  /**
   * Set up socket event listeners after connection
   */
  private setupSocketListeners(): void {
    if (!this.socket) return;

    // Handle incoming data
    this.socket.on('data', (data: Buffer) => {
      this.emitData(data);
    });

    // Handle socket close
    this.socket.on('close', (hadError: boolean) => {
      if (this.state === TransportState.CONNECTED) {
        this.lastError = hadError ? 'Socket closed with error' : 'Socket closed';
        this.handleConnectionLost();
      }
    });

    // Handle socket errors
    this.socket.on('error', (error: Error) => {
      this.lastError = error.message;
      const transportError: TransportError = {
        code: PrinterErrorCode.CONNECTION_LOST,
        message: `Socket error: ${error.message}`,
        originalError: error,
        recoverable: true,
      };
      this.emit(TransportEvent.ERROR, transportError);
    });

    // Handle socket timeout
    this.socket.on('timeout', () => {
      this.lastError = 'Socket timeout';
      const transportError: TransportError = {
        code: PrinterErrorCode.CONNECTION_LOST,
        message: 'Socket timeout - no activity',
        recoverable: true,
      };
      this.emit(TransportEvent.ERROR, transportError);
    });
  }

  /**
   * Clean up socket resources
   */
  private cleanupSocket(): void {
    if (this.socket) {
      this.socket.removeAllListeners();
      if (!this.socket.destroyed) {
        this.socket.destroy();
      }
      this.socket = null;
    }
  }

  /**
   * Check if the socket is writable
   */
  isWritable(): boolean {
    return this.socket !== null && !this.socket.destroyed && this.socket.writable;
  }

  /**
   * Get socket local address info
   */
  getLocalAddress(): { address: string; port: number } | null {
    if (!this.socket) return null;
    return {
      address: this.socket.localAddress || '',
      port: this.socket.localPort || 0,
    };
  }

  /**
   * Get socket remote address info
   */
  getRemoteAddress(): { address: string; port: number } | null {
    if (!this.socket) return null;
    return {
      address: this.socket.remoteAddress || this.ip,
      port: this.socket.remotePort || this.port,
    };
  }

  /**
   * Clean up resources
   */
  destroy(): void {
    this.cleanupSocket();
    super.destroy();
  }
}
