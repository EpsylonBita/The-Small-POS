/**
 * ECR Protocol Adapter Interface
 *
 * Defines the interface that all ECR protocol implementations must follow.
 *
 * @module ecr/protocols/ProtocolAdapter
 */

import { EventEmitter } from 'events';
import type {
  ECRTransactionRequest,
  ECRTransactionResponse,
  ECRDeviceStatus,
  ECRSettlementResult,
  ECRDisplayMessage,
} from '../../../../../shared/types/ecr';
import type { BaseECRTransport } from '../transport/ECRTransport';

/**
 * Protocol adapter events
 */
export enum ProtocolAdapterEvent {
  /** Display message from terminal */
  DISPLAY = 'display',
  /** Receipt to print */
  PRINT_RECEIPT = 'print-receipt',
  /** Transaction status update */
  STATUS_UPDATE = 'status-update',
  /** Error occurred */
  ERROR = 'error',
}

/**
 * Transaction progress callback
 */
export type TransactionProgressCallback = (message: ECRDisplayMessage) => void;

/**
 * Protocol adapter configuration
 */
export interface ProtocolAdapterConfig {
  /** Terminal ID (for protocols that need it) */
  terminalId?: string;
  /** Merchant ID (for protocols that need it) */
  merchantId?: string;
  /** Transaction timeout in ms */
  transactionTimeout?: number;
  /** Password for ZVT terminals */
  password?: number;
  /** Enable debug logging */
  debug?: boolean;
}

/**
 * Default configuration
 */
export const DEFAULT_PROTOCOL_CONFIG: Required<ProtocolAdapterConfig> = {
  terminalId: '',
  merchantId: '',
  transactionTimeout: 60000,
  password: 0,
  debug: false,
};

/**
 * Abstract base class for protocol adapters
 */
export abstract class BaseProtocolAdapter extends EventEmitter {
  protected transport: BaseECRTransport;
  protected config: Required<ProtocolAdapterConfig>;
  protected initialized: boolean = false;
  protected currentTransaction?: ECRTransactionRequest;

  constructor(transport: BaseECRTransport, config?: ProtocolAdapterConfig) {
    super();
    this.transport = transport;
    this.config = { ...DEFAULT_PROTOCOL_CONFIG, ...config };
  }

  /**
   * Initialize the protocol (registration, login, etc.)
   */
  abstract initialize(): Promise<void>;

  /**
   * Process a payment transaction
   */
  abstract processTransaction(
    request: ECRTransactionRequest,
    progressCallback?: TransactionProgressCallback
  ): Promise<ECRTransactionResponse>;

  /**
   * Cancel the current transaction
   */
  abstract cancelTransaction(): Promise<void>;

  /**
   * Get device status
   */
  abstract getStatus(): Promise<ECRDeviceStatus>;

  /**
   * Perform end-of-day settlement
   */
  abstract settlement(): Promise<ECRSettlementResult>;

  /**
   * Abort any ongoing operation
   */
  abstract abort(): Promise<void>;

  /**
   * Check if protocol is initialized
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Check if transport is connected
   */
  isConnected(): boolean {
    return this.transport.isConnected();
  }

  /**
   * Get the underlying transport
   */
  getTransport(): BaseECRTransport {
    return this.transport;
  }

  /**
   * Emit a display message
   */
  protected emitDisplay(message: ECRDisplayMessage): void {
    this.emit(ProtocolAdapterEvent.DISPLAY, message);
  }

  /**
   * Emit a print receipt event
   */
  protected emitPrintReceipt(receiptLines: string[], isMerchantCopy: boolean): void {
    this.emit(ProtocolAdapterEvent.PRINT_RECEIPT, { lines: receiptLines, isMerchantCopy });
  }

  /**
   * Log debug message if debug is enabled
   */
  protected debug(message: string, ...args: unknown[]): void {
    if (this.config.debug) {
      console.log(`[${this.constructor.name}] ${message}`, ...args);
    }
  }

  /**
   * Clean up resources
   */
  destroy(): void {
    this.removeAllListeners();
    this.initialized = false;
  }
}
