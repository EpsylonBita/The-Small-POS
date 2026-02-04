/**
 * Generic ECR Protocol Implementation
 *
 * Basic byte-frame protocol supported by most terminals in "ECR mode".
 * Uses STX/ETX framing with LRC checksum.
 *
 * Frame format: STX + Length + Command + Data + LRC + ETX
 *
 * @module ecr/protocols/GenericECRProtocol
 */

import {
  BaseProtocolAdapter,
  ProtocolAdapterEvent,
  type ProtocolAdapterConfig,
  type TransactionProgressCallback,
} from './ProtocolAdapter';
import type { BaseECRTransport } from '../transport/ECRTransport';
import type {
  ECRTransactionRequest,
  ECRTransactionResponse,
  ECRDeviceStatus,
  ECRSettlementResult,
} from '../../../../../shared/types/ecr';
import {
  ECRTransactionType,
  ECRTransactionStatus,
  ECRDeviceState,
  ECRCardType,
  ECRCardEntryMethod,
} from '../../../../../shared/types/ecr';
import { GENERIC_ECR, calculateLRC } from '../../../../../shared/ecr/protocols/constants';

/**
 * Generic ECR Protocol configuration
 */
export interface GenericECRConfig extends ProtocolAdapterConfig {
  /** Use extended length field (3 bytes instead of 1) */
  extendedLength?: boolean;
}

/**
 * Generic ECR Protocol implementation
 */
export class GenericECRProtocol extends BaseProtocolAdapter {
  private extendedLength: boolean;

  constructor(transport: BaseECRTransport, config?: GenericECRConfig) {
    super(transport, config);
    this.extendedLength = config?.extendedLength ?? false;
  }

  /**
   * Initialize the protocol
   */
  async initialize(): Promise<void> {
    if (!this.transport.isConnected()) {
      throw new Error('Transport is not connected');
    }

    // Send a status inquiry to verify connection
    try {
      const status = await this.getStatus();
      this.initialized = status.state !== ECRDeviceState.ERROR;
      this.debug('Protocol initialized, status:', status.state);
    } catch (error) {
      this.debug('Failed to initialize:', error);
      throw new Error('Failed to initialize terminal connection');
    }
  }

  /**
   * Process a payment transaction
   */
  async processTransaction(
    request: ECRTransactionRequest,
    progressCallback?: TransactionProgressCallback
  ): Promise<ECRTransactionResponse> {
    if (!this.initialized) {
      throw new Error('Protocol not initialized');
    }

    this.currentTransaction = request;
    const startedAt = new Date();

    try {
      // Display starting message
      progressCallback?.({
        message: 'Connecting to terminal...',
        type: 'info',
      });

      // Determine command based on transaction type
      let command: number;
      switch (request.type) {
        case ECRTransactionType.SALE:
          command = GENERIC_ECR.COMMANDS.SALE;
          break;
        case ECRTransactionType.REFUND:
          command = GENERIC_ECR.COMMANDS.REFUND;
          break;
        case ECRTransactionType.VOID:
          command = GENERIC_ECR.COMMANDS.VOID;
          break;
        case ECRTransactionType.PRE_AUTH:
          command = GENERIC_ECR.COMMANDS.PRE_AUTH;
          break;
        case ECRTransactionType.PRE_AUTH_COMPLETION:
          command = GENERIC_ECR.COMMANDS.PRE_AUTH_COMPLETE;
          break;
        default:
          throw new Error(`Unsupported transaction type: ${request.type}`);
      }

      // Build transaction data
      const data = this.buildTransactionData(request);

      // Send command
      progressCallback?.({
        message: 'Please present card...',
        type: 'prompt',
      });

      const frame = this.buildFrame(command, data);
      await this.transport.send(frame);

      // Wait for response with timeout
      const response = await this.waitForResponse(
        request.transactionId,
        this.config.transactionTimeout,
        progressCallback
      );

      this.currentTransaction = undefined;
      return response;
    } catch (error) {
      this.currentTransaction = undefined;
      const errorMessage = error instanceof Error ? error.message : String(error);

      return {
        transactionId: request.transactionId,
        status: ECRTransactionStatus.ERROR,
        errorMessage,
        startedAt,
        completedAt: new Date(),
      };
    }
  }

  /**
   * Cancel the current transaction
   */
  async cancelTransaction(): Promise<void> {
    if (!this.currentTransaction) {
      return;
    }

    try {
      const frame = this.buildFrame(GENERIC_ECR.COMMANDS.ABORT, Buffer.alloc(0));
      await this.transport.send(frame);

      // Wait for acknowledgment
      const response = await this.transport.receive(GENERIC_ECR.TIMEOUTS.COMMAND);
      this.debug('Cancel response:', response);
    } catch (error) {
      this.debug('Cancel failed:', error);
    } finally {
      this.currentTransaction = undefined;
    }
  }

  /**
   * Get device status
   */
  async getStatus(): Promise<ECRDeviceStatus> {
    try {
      const frame = this.buildFrame(GENERIC_ECR.COMMANDS.STATUS, Buffer.alloc(0));
      await this.transport.send(frame);

      const response = await this.transport.receive(GENERIC_ECR.TIMEOUTS.COMMAND);
      const parsed = this.parseFrame(response);

      if (!parsed) {
        return {
          deviceId: '',
          state: ECRDeviceState.ERROR,
          isOnline: false,
          errorMessage: 'Invalid response',
        };
      }

      // Parse status from response
      const isOnline = parsed.data.length > 0 && parsed.data[0] === 0x00;

      return {
        deviceId: '',
        state: isOnline ? ECRDeviceState.CONNECTED : ECRDeviceState.ERROR,
        isOnline,
        lastSeen: new Date(),
      };
    } catch (error) {
      return {
        deviceId: '',
        state: ECRDeviceState.ERROR,
        isOnline: false,
        errorMessage: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Perform end-of-day settlement
   */
  async settlement(): Promise<ECRSettlementResult> {
    if (!this.initialized) {
      throw new Error('Protocol not initialized');
    }

    try {
      const frame = this.buildFrame(GENERIC_ECR.COMMANDS.SETTLEMENT, Buffer.alloc(0));
      await this.transport.send(frame);

      const response = await this.transport.receive(GENERIC_ECR.TIMEOUTS.TRANSACTION);
      const parsed = this.parseFrame(response);

      if (!parsed) {
        return {
          success: false,
          errorMessage: 'Invalid response',
          timestamp: new Date(),
        };
      }

      const success = parsed.data.length > 0 && parsed.data[0] === GENERIC_ECR.RESPONSE_CODES.APPROVED;

      return {
        success,
        timestamp: new Date(),
      };
    } catch (error) {
      return {
        success: false,
        errorMessage: error instanceof Error ? error.message : String(error),
        timestamp: new Date(),
      };
    }
  }

  /**
   * Abort any ongoing operation
   */
  async abort(): Promise<void> {
    try {
      const frame = this.buildFrame(GENERIC_ECR.COMMANDS.ABORT, Buffer.alloc(0));
      await this.transport.send(frame);
      await this.transport.receive(GENERIC_ECR.TIMEOUTS.COMMAND);
    } catch {
      // Ignore errors on abort
    }
  }

  /**
   * Build a protocol frame
   */
  private buildFrame(command: number, data: Buffer): Buffer {
    const length = data.length + 1; // Command + data

    let frame: Buffer;

    if (this.extendedLength) {
      // Extended length: 3 bytes
      frame = Buffer.alloc(7 + data.length);
      frame[0] = GENERIC_ECR.STX;
      frame[1] = (length >> 16) & 0xff;
      frame[2] = (length >> 8) & 0xff;
      frame[3] = length & 0xff;
      frame[4] = command;
      data.copy(frame, 5);
      frame[5 + data.length] = calculateLRC(frame.slice(1, 5 + data.length));
      frame[6 + data.length] = GENERIC_ECR.ETX;
    } else {
      // Standard length: 1 byte
      frame = Buffer.alloc(5 + data.length);
      frame[0] = GENERIC_ECR.STX;
      frame[1] = length & 0xff;
      frame[2] = command;
      data.copy(frame, 3);
      frame[3 + data.length] = calculateLRC(frame.slice(1, 3 + data.length));
      frame[4 + data.length] = GENERIC_ECR.ETX;
    }

    return frame;
  }

  /**
   * Parse a response frame
   */
  private parseFrame(data: Buffer): { command: number; data: Buffer } | null {
    if (data.length < 5 || data[0] !== GENERIC_ECR.STX) {
      return null;
    }

    let length: number;
    let dataOffset: number;

    if (this.extendedLength) {
      length = (data[1] << 16) | (data[2] << 8) | data[3];
      dataOffset = 5;
    } else {
      length = data[1];
      dataOffset = 3;
    }

    const command = data[dataOffset - 1];
    const payloadLength = length - 1;
    const payload = data.slice(dataOffset, dataOffset + payloadLength);

    // Verify LRC
    const expectedLrc = data[dataOffset + payloadLength];
    const actualLrc = calculateLRC(data.slice(1, dataOffset + payloadLength));

    if (expectedLrc !== actualLrc) {
      this.debug('LRC mismatch:', expectedLrc, '!=', actualLrc);
      return null;
    }

    return { command, data: payload };
  }

  /**
   * Build transaction data payload
   */
  private buildTransactionData(request: ECRTransactionRequest): Buffer {
    // Amount as 4 bytes (big endian, in cents)
    const amount = Buffer.alloc(4);
    amount.writeUInt32BE(request.amount, 0);

    // Currency code (default EUR = 978)
    const currencyCode = request.currency === 'EUR' ? 978 : 840; // EUR or USD
    const currency = Buffer.alloc(2);
    currency.writeUInt16BE(currencyCode, 0);

    // Reference (padded/truncated to 20 bytes)
    const reference = Buffer.alloc(20);
    const refStr = request.reference || request.transactionId;
    Buffer.from(refStr.slice(0, 20)).copy(reference);

    return Buffer.concat([amount, currency, reference]);
  }

  /**
   * Wait for transaction response with status updates
   */
  private async waitForResponse(
    transactionId: string,
    timeout: number,
    progressCallback?: TransactionProgressCallback
  ): Promise<ECRTransactionResponse> {
    const startTime = Date.now();
    const startedAt = new Date(startTime);

    while (Date.now() - startTime < timeout) {
      try {
        const response = await this.transport.receive(5000);
        const parsed = this.parseFrame(response);

        if (!parsed) {
          continue;
        }

        // Check for intermediate status messages
        if (this.isStatusMessage(parsed.command)) {
          const message = this.parseStatusMessage(parsed.data);
          progressCallback?.(message);
          this.emitDisplay(message);
          continue;
        }

        // Parse final response
        return this.parseTransactionResponse(transactionId, parsed, startedAt);
      } catch (error) {
        // Timeout on receive, continue waiting
        if (Date.now() - startTime >= timeout) {
          throw new Error('Transaction timeout');
        }
      }
    }

    return {
      transactionId,
      status: ECRTransactionStatus.TIMEOUT,
      errorMessage: 'Transaction timeout',
      startedAt,
      completedAt: new Date(),
    };
  }

  /**
   * Check if command is a status message
   */
  private isStatusMessage(command: number): boolean {
    return command >= 0x10 && command <= 0x1f;
  }

  /**
   * Parse status message from terminal
   */
  private parseStatusMessage(data: Buffer): {
    message: string;
    type: 'info' | 'prompt' | 'warning' | 'error';
  } {
    const text = data.toString('ascii').replace(/\0/g, '').trim();
    return {
      message: text || 'Processing...',
      type: 'info',
    };
  }

  /**
   * Parse transaction response
   */
  private parseTransactionResponse(
    transactionId: string,
    parsed: { command: number; data: Buffer },
    startedAt: Date
  ): ECRTransactionResponse {
    const responseCode = parsed.data[0];
    const completedAt = new Date();

    // Determine status from response code
    let status: ECRTransactionStatus;
    let errorMessage: string | undefined;

    switch (responseCode) {
      case GENERIC_ECR.RESPONSE_CODES.APPROVED:
        status = ECRTransactionStatus.APPROVED;
        break;
      case GENERIC_ECR.RESPONSE_CODES.DECLINED:
        status = ECRTransactionStatus.DECLINED;
        errorMessage = 'Transaction declined';
        break;
      case GENERIC_ECR.RESPONSE_CODES.CANCELLED:
        status = ECRTransactionStatus.CANCELLED;
        errorMessage = 'Transaction cancelled';
        break;
      case GENERIC_ECR.RESPONSE_CODES.TIMEOUT:
        status = ECRTransactionStatus.TIMEOUT;
        errorMessage = 'Terminal timeout';
        break;
      default:
        status = ECRTransactionStatus.ERROR;
        errorMessage = `Unknown response code: ${responseCode}`;
    }

    // Extract additional data if approved
    let authorizationCode: string | undefined;
    let cardLastFour: string | undefined;
    let cardType: ECRCardType | undefined;
    let entryMethod: ECRCardEntryMethod | undefined;

    if (status === ECRTransactionStatus.APPROVED && parsed.data.length > 1) {
      // Parse authorization code (bytes 1-6)
      if (parsed.data.length >= 7) {
        authorizationCode = parsed.data.slice(1, 7).toString('ascii').trim();
      }

      // Parse card info (bytes 7+)
      if (parsed.data.length >= 11) {
        cardLastFour = parsed.data.slice(7, 11).toString('ascii');
      }

      if (parsed.data.length >= 12) {
        const cardTypeCode = parsed.data[11];
        cardType = this.parseCardType(cardTypeCode);
      }

      if (parsed.data.length >= 13) {
        const entryCode = parsed.data[12];
        entryMethod = this.parseEntryMethod(entryCode);
      }
    }

    return {
      transactionId,
      status,
      authorizationCode,
      cardType,
      cardLastFour,
      entryMethod,
      errorMessage,
      startedAt,
      completedAt,
    };
  }

  /**
   * Parse card type from code
   */
  private parseCardType(code: number): ECRCardType {
    switch (code) {
      case 0x01:
        return ECRCardType.VISA;
      case 0x02:
        return ECRCardType.MASTERCARD;
      case 0x03:
        return ECRCardType.AMEX;
      case 0x04:
        return ECRCardType.DISCOVER;
      case 0x05:
        return ECRCardType.DINERS;
      case 0x06:
        return ECRCardType.MAESTRO;
      default:
        return ECRCardType.UNKNOWN;
    }
  }

  /**
   * Parse entry method from code
   */
  private parseEntryMethod(code: number): ECRCardEntryMethod {
    switch (code) {
      case 0x01:
        return ECRCardEntryMethod.CHIP;
      case 0x02:
        return ECRCardEntryMethod.CONTACTLESS;
      case 0x03:
        return ECRCardEntryMethod.SWIPE;
      case 0x04:
        return ECRCardEntryMethod.MANUAL;
      default:
        return ECRCardEntryMethod.UNKNOWN;
    }
  }
}
