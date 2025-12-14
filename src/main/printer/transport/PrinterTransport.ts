/**
 * Base Printer Transport Interface and Abstract Class
 *
 * Defines the common interface for all printer transport implementations
 * (Network, Bluetooth, USB) with connection state management and event handling.
 *
 * @module printer/transport/PrinterTransport
 *
 * Requirements: 2.2, 3.3, 4.2
 */

import { EventEmitter } from 'events';
import { TransportStatus, PrinterErrorCode } from '../types';

/**
 * Transport connection states
 */
export enum TransportState {
  DISCONNECTED = 'disconnected',
  CONNECTING = 'connecting',
  CONNECTED = 'connected',
  RECONNECTING = 'reconnecting',
  ERROR = 'error',
}

/**
 * Transport event types
 */
export enum TransportEvent {
  CONNECTED = 'connected',
  DISCONNECTED = 'disconnected',
  ERROR = 'error',
  DATA = 'data',
  STATE_CHANGE = 'stateChange',
}

/**
 * Transport error with additional context
 */
export interface TransportError {
  code: PrinterErrorCode;
  message: string;
  originalError?: Error;
  recoverable: boolean;
}

/**
 * Options for transport connection
 */
export interface TransportOptions {
  /** Connection timeout in milliseconds (default: 5000) */
  connectionTimeout?: number;
  /** Maximum retry attempts (default: 3) */
  maxRetries?: number;
  /** Base delay for exponential backoff in ms (default: 1000) */
  retryBaseDelay?: number;
  /** Auto-reconnect on disconnect (default: true) */
  autoReconnect?: boolean;
  /** Auto-reconnect timeout in ms (default: 30000) */
  reconnectTimeout?: number;
}

/**
 * Default transport options
 */
export const DEFAULT_TRANSPORT_OPTIONS: Required<TransportOptions> = {
  connectionTimeout: 5000,
  maxRetries: 3,
  retryBaseDelay: 1000,
  autoReconnect: true,
  reconnectTimeout: 30000,
};

/**
 * Interface for printer transport implementations
 *
 * Requirements: 2.2, 3.3, 4.2
 */
export interface IPrinterTransport {
  /** Connect to the printer */
  connect(): Promise<void>;

  /** Disconnect from the printer */
  disconnect(): Promise<void>;

  /** Check if currently connected */
  isConnected(): boolean;

  /** Send data to the printer */
  send(data: Buffer): Promise<void>;

  /** Get current transport status */
  getStatus(): TransportStatus;

  /** Get current connection state */
  getState(): TransportState;

  /** Register disconnect callback */
  onDisconnect(callback: () => void): void;

  /** Register error callback */
  onError(callback: (error: TransportError) => void): void;

  /** Register data received callback */
  onData(callback: (data: Buffer) => void): void;

  /** Remove all event listeners */
  removeAllListeners(): void;
}

/**
 * Abstract base class for printer transports
 *
 * Provides common functionality for connection state management,
 * event emission, and retry logic.
 *
 * Requirements: 2.2, 3.3, 4.2
 */
export abstract class BasePrinterTransport
  extends EventEmitter
  implements IPrinterTransport
{
  protected state: TransportState = TransportState.DISCONNECTED;
  protected options: Required<TransportOptions>;
  protected lastConnected?: Date;
  protected lastError?: string;
  protected retryCount: number = 0;
  protected reconnectTimer?: NodeJS.Timeout;

  constructor(options?: TransportOptions) {
    super();
    this.options = { ...DEFAULT_TRANSPORT_OPTIONS, ...options };
  }

  /**
   * Abstract method to establish the actual connection
   * Must be implemented by subclasses
   */
  protected abstract doConnect(): Promise<void>;

  /**
   * Abstract method to close the actual connection
   * Must be implemented by subclasses
   */
  protected abstract doDisconnect(): Promise<void>;

  /**
   * Abstract method to send data over the connection
   * Must be implemented by subclasses
   */
  protected abstract doSend(data: Buffer): Promise<void>;

  /**
   * Connect to the printer with retry logic
   *
   * Requirements: 2.2, 2.3, 3.3
   */
  async connect(): Promise<void> {
    if (this.state === TransportState.CONNECTED) {
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
        this.setState(TransportState.CONNECTING);

        // Create a timeout promise
        const timeoutPromise = new Promise<never>((_, reject) => {
          setTimeout(() => {
            reject(new Error(`Connection timeout after ${this.options.connectionTimeout}ms`));
          }, this.options.connectionTimeout);
        });

        // Race between connection and timeout
        await Promise.race([this.doConnect(), timeoutPromise]);

        // Connection successful
        this.setState(TransportState.CONNECTED);
        this.lastConnected = new Date();
        this.lastError = undefined;
        this.retryCount = 0;
        this.emit(TransportEvent.CONNECTED);
        return;
      } catch (error) {
        this.retryCount++;
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.lastError = errorMessage;

        if (this.retryCount > this.options.maxRetries) {
          this.setState(TransportState.ERROR);
          const transportError: TransportError = {
            code: PrinterErrorCode.CONNECTION_LOST,
            message: `Failed to connect after ${this.options.maxRetries} retries: ${errorMessage}`,
            originalError: error instanceof Error ? error : undefined,
            recoverable: true,
          };
          this.emit(TransportEvent.ERROR, transportError);
          throw new Error(transportError.message);
        }

        // Calculate exponential backoff delay
        const delay = this.options.retryBaseDelay * Math.pow(2, this.retryCount - 1);
        await this.sleep(delay);
      }
    }
  }

  /**
   * Disconnect from the printer
   *
   * Requirements: 2.2, 3.3, 4.2
   */
  async disconnect(): Promise<void> {
    this.clearReconnectTimer();

    if (
      this.state === TransportState.DISCONNECTED ||
      this.state === TransportState.ERROR
    ) {
      return;
    }

    try {
      await this.doDisconnect();
    } finally {
      this.setState(TransportState.DISCONNECTED);
      this.emit(TransportEvent.DISCONNECTED);
    }
  }

  /**
   * Check if currently connected
   */
  isConnected(): boolean {
    return this.state === TransportState.CONNECTED;
  }

  /**
   * Send data to the printer
   *
   * Requirements: 2.4, 3.4, 4.3
   */
  async send(data: Buffer): Promise<void> {
    if (!this.isConnected()) {
      throw new Error('Transport is not connected');
    }

    try {
      await this.doSend(data);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.lastError = errorMessage;

      const transportError: TransportError = {
        code: PrinterErrorCode.CONNECTION_LOST,
        message: `Send failed: ${errorMessage}`,
        originalError: error instanceof Error ? error : undefined,
        recoverable: true,
      };

      this.emit(TransportEvent.ERROR, transportError);
      this.handleConnectionLost();
      throw error;
    }
  }

  /**
   * Get current transport status
   */
  getStatus(): TransportStatus {
    return {
      connected: this.isConnected(),
      lastConnected: this.lastConnected,
      lastError: this.lastError,
    };
  }

  /**
   * Get current connection state
   */
  getState(): TransportState {
    return this.state;
  }

  /**
   * Register disconnect callback
   */
  onDisconnect(callback: () => void): void {
    this.on(TransportEvent.DISCONNECTED, callback);
  }

  /**
   * Register error callback
   */
  onError(callback: (error: TransportError) => void): void {
    this.on(TransportEvent.ERROR, callback);
  }

  /**
   * Register data received callback
   */
  onData(callback: (data: Buffer) => void): void {
    this.on(TransportEvent.DATA, callback);
  }

  /**
   * Handle connection lost - trigger auto-reconnect if enabled
   *
   * Requirements: 2.5, 3.5, 4.4
   */
  protected handleConnectionLost(): void {
    if (this.state === TransportState.DISCONNECTED) {
      return;
    }

    this.setState(TransportState.DISCONNECTED);
    this.emit(TransportEvent.DISCONNECTED);

    if (this.options.autoReconnect) {
      this.startReconnect();
    }
  }

  /**
   * Start auto-reconnection process
   *
   * Requirements: 3.5
   */
  protected startReconnect(): void {
    if (this.reconnectTimer) {
      return;
    }

    this.setState(TransportState.RECONNECTING);
    this.retryCount = 0;

    const startTime = Date.now();

    const attemptReconnect = async () => {
      const elapsed = Date.now() - startTime;

      if (elapsed >= this.options.reconnectTimeout) {
        this.clearReconnectTimer();
        this.setState(TransportState.ERROR);
        const transportError: TransportError = {
          code: PrinterErrorCode.CONNECTION_LOST,
          message: `Auto-reconnect timeout after ${this.options.reconnectTimeout}ms`,
          recoverable: false,
        };
        this.emit(TransportEvent.ERROR, transportError);
        return;
      }

      try {
        await this.attemptConnection();
        this.clearReconnectTimer();
      } catch {
        // Calculate next retry delay with exponential backoff
        const delay = Math.min(
          this.options.retryBaseDelay * Math.pow(2, this.retryCount),
          5000 // Cap at 5 seconds
        );
        this.reconnectTimer = setTimeout(attemptReconnect, delay);
      }
    };

    // Start first reconnect attempt after base delay
    this.reconnectTimer = setTimeout(attemptReconnect, this.options.retryBaseDelay);
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
  protected setState(newState: TransportState): void {
    const oldState = this.state;
    this.state = newState;
    if (oldState !== newState) {
      this.emit(TransportEvent.STATE_CHANGE, { oldState, newState });
    }
  }

  /**
   * Emit data received event
   */
  protected emitData(data: Buffer): void {
    this.emit(TransportEvent.DATA, data);
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
