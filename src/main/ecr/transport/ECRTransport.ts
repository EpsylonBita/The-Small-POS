/**
 * ECR Transport Base Class
 *
 * Abstract base class for ECR device transport implementations.
 * Handles connection state management, event emission, and retry logic.
 *
 * @module ecr/transport/ECRTransport
 */

import { EventEmitter } from 'events';
import type {
  ECRTransportStatus,
  ECRTransportOptions,
} from '../../../../../shared/types/ecr';

// ============================================================================
// Enums and Constants
// ============================================================================

/**
 * Transport connection states
 */
export enum ECRTransportState {
  DISCONNECTED = 'disconnected',
  CONNECTING = 'connecting',
  CONNECTED = 'connected',
  RECONNECTING = 'reconnecting',
  ERROR = 'error',
}

/**
 * Transport event types
 */
export enum ECRTransportEvent {
  CONNECTED = 'connected',
  DISCONNECTED = 'disconnected',
  ERROR = 'error',
  DATA = 'data',
  STATE_CHANGE = 'stateChange',
}

/**
 * Transport error with context
 */
export interface ECRTransportError {
  code: string;
  message: string;
  originalError?: Error;
  recoverable: boolean;
}

/**
 * Default transport options
 */
export const DEFAULT_ECR_TRANSPORT_OPTIONS: Required<ECRTransportOptions> = {
  connectionTimeout: 5000,
  readTimeout: 5000,
  writeTimeout: 3000,
  maxRetries: 3,
  retryDelay: 1000,
  autoReconnect: true,
  reconnectTimeout: 30000,
};

// ============================================================================
// Base ECR Transport Class
// ============================================================================

/**
 * Abstract base class for ECR transport implementations
 *
 * Provides common functionality for connection state management,
 * event emission, and retry logic.
 */
export abstract class BaseECRTransport extends EventEmitter {
  protected state: ECRTransportState = ECRTransportState.DISCONNECTED;
  protected options: Required<ECRTransportOptions>;
  protected lastConnected?: Date;
  protected lastError?: string;
  protected retryCount: number = 0;
  protected reconnectTimer?: NodeJS.Timeout;
  protected bytesReceived: number = 0;
  protected bytesSent: number = 0;

  constructor(options?: ECRTransportOptions) {
    super();
    this.options = { ...DEFAULT_ECR_TRANSPORT_OPTIONS, ...options };
  }

  /**
   * Abstract method to establish the actual connection
   */
  protected abstract doConnect(): Promise<void>;

  /**
   * Abstract method to close the actual connection
   */
  protected abstract doDisconnect(): Promise<void>;

  /**
   * Abstract method to send data over the connection
   */
  protected abstract doSend(data: Buffer): Promise<void>;

  /**
   * Abstract method to receive data (with timeout)
   */
  protected abstract doReceive(timeout?: number): Promise<Buffer>;

  /**
   * Connect to the ECR device with retry logic
   */
  async connect(): Promise<void> {
    if (this.state === ECRTransportState.CONNECTED) {
      return;
    }

    this.clearReconnectTimer();
    this.retryCount = 0;

    await this.attemptConnection();
  }

  /**
   * Attempt connection with exponential backoff retry
   */
  protected async attemptConnection(): Promise<void> {
    while (this.retryCount <= this.options.maxRetries) {
      try {
        this.setState(ECRTransportState.CONNECTING);

        // Create a timeout promise
        const timeoutPromise = new Promise<never>((_, reject) => {
          setTimeout(() => {
            reject(new Error(`Connection timeout after ${this.options.connectionTimeout}ms`));
          }, this.options.connectionTimeout);
        });

        // Race between connection and timeout
        await Promise.race([this.doConnect(), timeoutPromise]);

        // Connection successful
        this.setState(ECRTransportState.CONNECTED);
        this.lastConnected = new Date();
        this.lastError = undefined;
        this.retryCount = 0;
        this.emit(ECRTransportEvent.CONNECTED);
        return;
      } catch (error) {
        this.retryCount++;
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.lastError = errorMessage;

        if (this.retryCount > this.options.maxRetries) {
          this.setState(ECRTransportState.ERROR);
          const transportError: ECRTransportError = {
            code: 'CONNECTION_FAILED',
            message: `Failed to connect after ${this.options.maxRetries} retries: ${errorMessage}`,
            originalError: error instanceof Error ? error : undefined,
            recoverable: true,
          };
          this.emit(ECRTransportEvent.ERROR, transportError);
          throw new Error(transportError.message);
        }

        // Calculate exponential backoff delay
        const delay = this.options.retryDelay * Math.pow(2, this.retryCount - 1);
        await this.sleep(delay);
      }
    }
  }

  /**
   * Disconnect from the ECR device
   */
  async disconnect(): Promise<void> {
    this.clearReconnectTimer();

    if (
      this.state === ECRTransportState.DISCONNECTED ||
      this.state === ECRTransportState.ERROR
    ) {
      return;
    }

    try {
      await this.doDisconnect();
    } finally {
      this.setState(ECRTransportState.DISCONNECTED);
      this.emit(ECRTransportEvent.DISCONNECTED);
    }
  }

  /**
   * Check if currently connected
   */
  isConnected(): boolean {
    return this.state === ECRTransportState.CONNECTED;
  }

  /**
   * Send data to the ECR device
   */
  async send(data: Buffer): Promise<void> {
    if (!this.isConnected()) {
      throw new Error('Transport is not connected');
    }

    try {
      await this.doSend(data);
      this.bytesSent += data.length;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.lastError = errorMessage;

      const transportError: ECRTransportError = {
        code: 'SEND_FAILED',
        message: `Send failed: ${errorMessage}`,
        originalError: error instanceof Error ? error : undefined,
        recoverable: true,
      };

      this.emit(ECRTransportEvent.ERROR, transportError);
      this.handleConnectionLost();
      throw error;
    }
  }

  /**
   * Receive data from the ECR device
   */
  async receive(timeout?: number): Promise<Buffer> {
    if (!this.isConnected()) {
      throw new Error('Transport is not connected');
    }

    try {
      const data = await this.doReceive(timeout ?? this.options.readTimeout);
      this.bytesReceived += data.length;
      return data;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.lastError = errorMessage;

      const transportError: ECRTransportError = {
        code: 'RECEIVE_FAILED',
        message: `Receive failed: ${errorMessage}`,
        originalError: error instanceof Error ? error : undefined,
        recoverable: true,
      };

      this.emit(ECRTransportEvent.ERROR, transportError);
      throw error;
    }
  }

  /**
   * Send data and wait for response
   */
  async sendAndReceive(data: Buffer, timeout?: number): Promise<Buffer> {
    await this.send(data);
    return this.receive(timeout);
  }

  /**
   * Get current transport status
   */
  getStatus(): ECRTransportStatus {
    return {
      connected: this.isConnected(),
      lastConnected: this.lastConnected,
      lastError: this.lastError,
      bytesReceived: this.bytesReceived,
      bytesSent: this.bytesSent,
    };
  }

  /**
   * Get current connection state
   */
  getState(): ECRTransportState {
    return this.state;
  }

  /**
   * Register disconnect callback
   */
  onDisconnect(callback: () => void): void {
    this.on(ECRTransportEvent.DISCONNECTED, callback);
  }

  /**
   * Register error callback
   */
  onError(callback: (error: ECRTransportError) => void): void {
    this.on(ECRTransportEvent.ERROR, callback);
  }

  /**
   * Register data received callback
   */
  onData(callback: (data: Buffer) => void): void {
    this.on(ECRTransportEvent.DATA, callback);
  }

  /**
   * Handle connection lost - trigger auto-reconnect if enabled
   */
  protected handleConnectionLost(): void {
    if (this.state === ECRTransportState.DISCONNECTED) {
      return;
    }

    this.setState(ECRTransportState.DISCONNECTED);
    this.emit(ECRTransportEvent.DISCONNECTED);

    if (this.options.autoReconnect) {
      this.startReconnect();
    }
  }

  /**
   * Start auto-reconnection process
   */
  protected startReconnect(): void {
    if (this.reconnectTimer) {
      return;
    }

    this.setState(ECRTransportState.RECONNECTING);
    this.retryCount = 0;

    const startTime = Date.now();

    const attemptReconnect = async () => {
      const elapsed = Date.now() - startTime;

      if (elapsed >= this.options.reconnectTimeout) {
        this.clearReconnectTimer();
        this.setState(ECRTransportState.ERROR);
        const transportError: ECRTransportError = {
          code: 'RECONNECT_TIMEOUT',
          message: `Auto-reconnect timeout after ${this.options.reconnectTimeout}ms`,
          recoverable: false,
        };
        this.emit(ECRTransportEvent.ERROR, transportError);
        return;
      }

      try {
        await this.attemptConnection();
        this.clearReconnectTimer();
      } catch {
        // Calculate next retry delay with exponential backoff
        const delay = Math.min(
          this.options.retryDelay * Math.pow(2, this.retryCount),
          5000 // Cap at 5 seconds
        );
        this.reconnectTimer = setTimeout(attemptReconnect, delay);
      }
    };

    // Start first reconnect attempt after base delay
    this.reconnectTimer = setTimeout(attemptReconnect, this.options.retryDelay);
  }

  /**
   * Clear reconnect timer
   */
  protected clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }

  /**
   * Set state and emit state change event
   */
  protected setState(newState: ECRTransportState): void {
    const oldState = this.state;
    this.state = newState;
    if (oldState !== newState) {
      this.emit(ECRTransportEvent.STATE_CHANGE, { oldState, newState });
    }
  }

  /**
   * Emit data received event
   */
  protected emitData(data: Buffer): void {
    this.emit(ECRTransportEvent.DATA, data);
  }

  /**
   * Helper to sleep for a given duration
   */
  protected sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Clean up resources
   */
  destroy(): void {
    this.clearReconnectTimer();
    this.removeAllListeners();
  }
}
