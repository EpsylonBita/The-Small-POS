/**
 * Network (TCP) Transport Implementation
 *
 * Handles TCP connections to ECR payment terminals over the network.
 * Typically used for ZVT protocol on port 20007.
 *
 * @module ecr/transport/NetworkTransport
 */

import * as net from 'net';
import {
  BaseECRTransport,
  ECRTransportState,
  ECRTransportEvent,
  type ECRTransportError,
} from './ECRTransport';
import type {
  ECRNetworkConnectionDetails,
  ECRTransportOptions,
} from '../../../../../shared/types/ecr';
import { ZVT } from '../../../../../shared/ecr/protocols/constants';

/**
 * Network-specific transport options
 */
export interface NetworkTransportOptions extends ECRTransportOptions {
  /** Keep-alive interval in ms (0 to disable) */
  keepAliveInterval?: number;
  /** TCP no-delay option (disable Nagle's algorithm) */
  noDelay?: boolean;
}

/**
 * Default network transport options
 */
const DEFAULT_NETWORK_OPTIONS: Partial<NetworkTransportOptions> = {
  connectionTimeout: 5000,
  readTimeout: 5000,
  keepAliveInterval: 30000,
  noDelay: true,
};

/**
 * NetworkTransport - TCP transport for ECR payment terminals
 *
 * Supports ZVT protocol terminals on network (typically port 20007).
 */
export class NetworkTransport extends BaseECRTransport {
  private socket: net.Socket | null = null;
  private ip: string;
  private port: number;
  private hostname?: string;
  private networkOptions: NetworkTransportOptions;
  private receiveBuffer: Buffer = Buffer.alloc(0);
  private dataResolvers: Array<{
    resolve: (data: Buffer) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
  }> = [];

  constructor(
    connectionDetails: ECRNetworkConnectionDetails,
    options?: NetworkTransportOptions
  ) {
    super({ ...DEFAULT_NETWORK_OPTIONS, ...options });
    this.ip = connectionDetails.ip;
    this.port = connectionDetails.port ?? ZVT.DEFAULT_PORT;
    this.hostname = connectionDetails.hostname;
    this.networkOptions = { ...DEFAULT_NETWORK_OPTIONS, ...options };
  }

  /**
   * Get the IP address
   */
  getIP(): string {
    return this.ip;
  }

  /**
   * Get the port number
   */
  getPort(): number {
    return this.port;
  }

  /**
   * Get the hostname (if using mDNS)
   */
  getHostname(): string | undefined {
    return this.hostname;
  }

  /**
   * Establish TCP connection
   */
  protected async doConnect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.cleanupSocket();

      this.socket = new net.Socket();

      // Configure socket options
      if (this.networkOptions.noDelay) {
        this.socket.setNoDelay(true);
      }

      if (this.networkOptions.keepAliveInterval && this.networkOptions.keepAliveInterval > 0) {
        this.socket.setKeepAlive(true, this.networkOptions.keepAliveInterval);
      }

      this.setupSocketListeners(resolve, reject);

      // Connect to the terminal
      this.socket.connect(this.port, this.ip);
    });
  }

  /**
   * Close TCP connection
   */
  protected async doDisconnect(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.socket || this.socket.destroyed) {
        this.cleanupSocket();
        resolve();
        return;
      }

      // Set up close handler
      this.socket.once('close', () => {
        this.cleanupSocket();
        resolve();
      });

      // End the connection gracefully
      this.socket.end();

      // Force destroy after timeout
      setTimeout(() => {
        if (this.socket && !this.socket.destroyed) {
          this.socket.destroy();
        }
        this.cleanupSocket();
        resolve();
      }, 1000);
    });
  }

  /**
   * Send data over TCP
   */
  protected async doSend(data: Buffer): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.socket || this.socket.destroyed) {
        reject(new Error('Socket is not connected'));
        return;
      }

      this.socket.write(data, (error?: Error | null) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }

  /**
   * Receive data from TCP with timeout
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
   * Receive exactly the specified number of bytes
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
   * Set up socket event listeners
   */
  private setupSocketListeners(
    connectResolve: () => void,
    connectReject: (error: Error) => void
  ): void {
    if (!this.socket) return;

    let connected = false;

    this.socket.once('connect', () => {
      connected = true;
      connectResolve();
    });

    this.socket.on('data', (data: Buffer) => {
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

    this.socket.on('close', (hadError: boolean) => {
      if (this.state === ECRTransportState.CONNECTED) {
        this.lastError = hadError ? 'Connection closed with error' : 'Connection closed';
        this.handleConnectionLost();
      }
    });

    this.socket.on('error', (error: Error) => {
      this.lastError = error.message;

      if (!connected) {
        connectReject(error);
        return;
      }

      const transportError: ECRTransportError = {
        code: 'NETWORK_ERROR',
        message: `Network error: ${error.message}`,
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

    this.socket.on('timeout', () => {
      this.lastError = 'Socket timeout';
      const transportError: ECRTransportError = {
        code: 'NETWORK_TIMEOUT',
        message: 'Socket timeout',
        recoverable: true,
      };
      this.emit(ECRTransportEvent.ERROR, transportError);
    });
  }

  /**
   * Clean up socket resources
   */
  private cleanupSocket(): void {
    if (this.socket) {
      try {
        this.socket.removeAllListeners();
        if (!this.socket.destroyed) {
          this.socket.destroy();
        }
      } catch {
        // Ignore cleanup errors
      }
      this.socket = null;
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
   * Get local address info
   */
  getLocalAddress(): { address: string; port: number } | null {
    if (!this.socket) return null;
    const addr = this.socket.address();
    if (typeof addr === 'string' || !('address' in addr)) return null;
    return { address: addr.address, port: addr.port };
  }

  /**
   * Clean up resources
   */
  destroy(): void {
    this.cleanupSocket();
    super.destroy();
  }
}
