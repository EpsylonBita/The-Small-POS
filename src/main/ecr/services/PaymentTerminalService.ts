/**
 * Payment Terminal Service
 *
 * Handles payment terminal transaction operations including
 * sale, refund, void, and settlement.
 *
 * @module ecr/services/PaymentTerminalService
 */

import { EventEmitter } from 'events';
import type {
  ECRDevice,
  ECRTransactionRequest,
  ECRTransactionResponse,
  ECRDeviceStatus,
  ECRSettlementResult,
  ECRDisplayMessage,
} from '../../../../../shared/types/ecr';
import {
  ECRProtocol,
  ECRTransactionStatus,
  ECRDeviceState,
} from '../../../../../shared/types/ecr';
import type { BaseECRTransport } from '../transport/ECRTransport';
import {
  SerialTransport,
  BluetoothTransport,
  NetworkTransport,
} from '../transport';
import {
  BaseProtocolAdapter,
  GenericECRProtocol,
  ZVTProtocol,
  PAXProtocol,
  ProtocolAdapterEvent,
  type ProtocolAdapterConfig,
} from '../protocols';
import type { TransactionLogService } from './TransactionLogService';

/**
 * Events emitted by PaymentTerminalService
 */
export enum PaymentTerminalServiceEvent {
  CONNECTING = 'connecting',
  CONNECTED = 'connected',
  DISCONNECTED = 'disconnected',
  TRANSACTION_STARTED = 'transaction-started',
  TRANSACTION_STATUS = 'transaction-status',
  TRANSACTION_COMPLETED = 'transaction-completed',
  DISPLAY_MESSAGE = 'display-message',
  PRINT_RECEIPT = 'print-receipt',
  ERROR = 'error',
}

/**
 * Terminal connection state
 */
interface TerminalConnection {
  device: ECRDevice;
  transport: BaseECRTransport;
  protocol: BaseProtocolAdapter;
  status: ECRDeviceStatus;
}

/**
 * PaymentTerminalService - Manages terminal connections and transactions
 */
export class PaymentTerminalService extends EventEmitter {
  private transactionLog: TransactionLogService;
  private connections: Map<string, TerminalConnection> = new Map();
  private activeTransactions: Map<string, string> = new Map(); // transactionId -> deviceId

  constructor(transactionLog: TransactionLogService) {
    super();
    this.transactionLog = transactionLog;
  }

  /**
   * Connect to a payment terminal
   */
  async connect(device: ECRDevice): Promise<void> {
    if (this.connections.has(device.id)) {
      // Already connected
      return;
    }

    this.emit(PaymentTerminalServiceEvent.CONNECTING, device.id);

    try {
      // Create transport
      const transport = this.createTransport(device);

      // Connect transport
      await transport.connect();

      // Create protocol adapter
      const protocol = this.createProtocol(device, transport);

      // Set up protocol event forwarding
      protocol.on(ProtocolAdapterEvent.DISPLAY, (message: ECRDisplayMessage) => {
        this.emit(PaymentTerminalServiceEvent.DISPLAY_MESSAGE, device.id, message);
      });

      protocol.on(ProtocolAdapterEvent.PRINT_RECEIPT, (data: { lines: string[]; isMerchantCopy: boolean }) => {
        this.emit(PaymentTerminalServiceEvent.PRINT_RECEIPT, device.id, data);
      });

      // Initialize protocol
      await protocol.initialize();

      // Store connection
      const connection: TerminalConnection = {
        device,
        transport,
        protocol,
        status: {
          deviceId: device.id,
          state: ECRDeviceState.CONNECTED,
          isOnline: true,
          lastSeen: new Date(),
        },
      };

      this.connections.set(device.id, connection);
      this.emit(PaymentTerminalServiceEvent.CONNECTED, device.id);
    } catch (error) {
      this.emit(PaymentTerminalServiceEvent.ERROR, device.id, error);
      throw error;
    }
  }

  /**
   * Disconnect from a payment terminal
   */
  async disconnect(deviceId: string): Promise<void> {
    const connection = this.connections.get(deviceId);
    if (!connection) return;

    try {
      connection.protocol.destroy();
      await connection.transport.disconnect();
    } catch (error) {
      console.error(`[PaymentTerminalService] Error disconnecting ${deviceId}:`, error);
    } finally {
      this.connections.delete(deviceId);
      this.emit(PaymentTerminalServiceEvent.DISCONNECTED, deviceId);
    }
  }

  /**
   * Check if terminal is connected
   */
  isConnected(deviceId: string): boolean {
    const connection = this.connections.get(deviceId);
    return !!connection && connection.transport.isConnected();
  }

  /**
   * Get terminal status
   */
  async getStatus(deviceId: string): Promise<ECRDeviceStatus> {
    const connection = this.connections.get(deviceId);
    if (!connection) {
      return {
        deviceId,
        state: ECRDeviceState.DISCONNECTED,
        isOnline: false,
      };
    }

    try {
      const status = await connection.protocol.getStatus();
      connection.status = status;
      return status;
    } catch (error) {
      return {
        deviceId,
        state: ECRDeviceState.ERROR,
        isOnline: false,
        errorMessage: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Process a payment transaction
   */
  async processTransaction(
    deviceId: string,
    request: ECRTransactionRequest
  ): Promise<ECRTransactionResponse> {
    const connection = this.connections.get(deviceId);
    if (!connection) {
      throw new Error(`Terminal ${deviceId} is not connected`);
    }

    if (this.activeTransactions.has(request.transactionId)) {
      throw new Error('Transaction already in progress');
    }

    // Create transaction record
    const txRecord = this.transactionLog.create(request, deviceId);
    this.activeTransactions.set(request.transactionId, deviceId);

    this.emit(PaymentTerminalServiceEvent.TRANSACTION_STARTED, {
      deviceId,
      transactionId: request.transactionId,
      type: request.type,
      amount: request.amount,
    });

    try {
      // Update status to processing
      this.transactionLog.updateStatus(request.transactionId, ECRTransactionStatus.PROCESSING);

      // Process transaction with progress callback
      const response = await connection.protocol.processTransaction(
        request,
        (message) => {
          this.emit(PaymentTerminalServiceEvent.TRANSACTION_STATUS, {
            transactionId: request.transactionId,
            message,
          });
          this.emit(PaymentTerminalServiceEvent.DISPLAY_MESSAGE, deviceId, message);
        }
      );

      // Update transaction record
      this.transactionLog.updateWithResponse(request.transactionId, response);

      this.emit(PaymentTerminalServiceEvent.TRANSACTION_COMPLETED, {
        deviceId,
        transactionId: request.transactionId,
        response,
      });

      return response;
    } catch (error) {
      const errorResponse: ECRTransactionResponse = {
        transactionId: request.transactionId,
        status: ECRTransactionStatus.ERROR,
        errorMessage: error instanceof Error ? error.message : String(error),
        startedAt: txRecord.startedAt,
        completedAt: new Date(),
      };

      this.transactionLog.updateWithResponse(request.transactionId, errorResponse);

      this.emit(PaymentTerminalServiceEvent.ERROR, deviceId, error);

      return errorResponse;
    } finally {
      this.activeTransactions.delete(request.transactionId);
    }
  }

  /**
   * Cancel the current transaction on a terminal
   */
  async cancelTransaction(deviceId: string): Promise<void> {
    const connection = this.connections.get(deviceId);
    if (!connection) return;

    await connection.protocol.cancelTransaction();

    // Update any active transaction for this device
    for (const [txId, dId] of this.activeTransactions) {
      if (dId === deviceId) {
        this.transactionLog.updateStatus(txId, ECRTransactionStatus.CANCELLED);
        this.activeTransactions.delete(txId);
      }
    }
  }

  /**
   * Perform end-of-day settlement
   */
  async settlement(deviceId: string): Promise<ECRSettlementResult> {
    const connection = this.connections.get(deviceId);
    if (!connection) {
      throw new Error(`Terminal ${deviceId} is not connected`);
    }

    return connection.protocol.settlement();
  }

  /**
   * Abort any ongoing operation
   */
  async abort(deviceId: string): Promise<void> {
    const connection = this.connections.get(deviceId);
    if (!connection) return;

    await connection.protocol.abort();
  }

  /**
   * Get all connected terminal IDs
   */
  getConnectedDevices(): string[] {
    return Array.from(this.connections.keys());
  }

  /**
   * Disconnect all terminals
   */
  async disconnectAll(): Promise<void> {
    const deviceIds = Array.from(this.connections.keys());
    await Promise.all(deviceIds.map((id) => this.disconnect(id)));
  }

  /**
   * Create transport for a device
   */
  private createTransport(device: ECRDevice): BaseECRTransport {
    const details = device.connectionDetails;

    switch (details.type) {
      case 'serial_usb':
        return new SerialTransport(details);
      case 'bluetooth':
        return new BluetoothTransport(details);
      case 'network':
        return new NetworkTransport(details);
      default:
        throw new Error(`Unsupported connection type: ${(details as any).type}`);
    }
  }

  /**
   * Create protocol adapter for a device
   */
  private createProtocol(device: ECRDevice, transport: BaseECRTransport): BaseProtocolAdapter {
    const config: ProtocolAdapterConfig = {
      terminalId: device.terminalId,
      merchantId: device.merchantId,
      transactionTimeout: (device.settings as any)?.transactionTimeout ?? 60000,
      debug: process.env.NODE_ENV === 'development', // Only enable in development
    };

    switch (device.protocol) {
      case ECRProtocol.ZVT:
        return new ZVTProtocol(transport, {
          ...config,
          password: (device.settings as any)?.password ?? 0,
          printOnPOS: (device.settings as any)?.printOnTerminal === false,
        });

      case ECRProtocol.PAX:
        return new PAXProtocol(transport, config);

      case ECRProtocol.GENERIC:
      default:
        return new GenericECRProtocol(transport, config);
    }
  }
}
