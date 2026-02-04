/**
 * PAX Protocol Implementation
 *
 * Protocol for PAX Android-based terminals (A80, A920, etc.).
 * Uses STX/ETX framing with field separators.
 *
 * @module ecr/protocols/PAXProtocol
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
  ECRTransactionStatus,
  ECRDeviceState,
  ECRCardType,
  ECRCardEntryMethod,
} from '../../../../../shared/types/ecr';
import { PAX, getPAXResultMessage } from '../../../../../shared/ecr/protocols/constants';

/**
 * PAX Protocol configuration
 */
export interface PAXConfig extends ProtocolAdapterConfig {
  /** EDC type (credit, debit, etc.) */
  edcType?: string;
}

/**
 * PAX Protocol implementation
 */
export class PAXProtocol extends BaseProtocolAdapter {
  private edcType: string;

  constructor(transport: BaseECRTransport, config?: PAXConfig) {
    super(transport, config);
    this.edcType = config?.edcType ?? 'CREDIT';
  }

  /**
   * Initialize the protocol
   */
  async initialize(): Promise<void> {
    if (!this.transport.isConnected()) {
      throw new Error('Transport is not connected');
    }

    try {
      // Send initialize command
      const response = await this.sendCommand(PAX.COMMANDS.INITIALIZE, []);

      if (!this.isSuccess(response)) {
        throw new Error('Initialization failed: ' + this.getResponseMessage(response));
      }

      this.initialized = true;
      this.debug('PAX Protocol initialized successfully');
    } catch (error) {
      this.debug('PAX initialization failed:', error);
      throw error;
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
      progressCallback?.({
        message: 'Connecting to terminal...',
        type: 'info',
      });

      // Determine command based on transaction type
      let command: string;
      switch (request.type) {
        case 'sale':
          command = PAX.COMMANDS.DO_CREDIT;
          break;
        case 'refund':
          command = PAX.COMMANDS.DO_REFUND;
          break;
        case 'void':
          command = PAX.COMMANDS.DO_VOID;
          break;
        case 'pre_auth':
          command = PAX.COMMANDS.DO_PRE_AUTH;
          break;
        case 'pre_auth_completion':
          command = PAX.COMMANDS.DO_POST_AUTH;
          break;
        default:
          throw new Error(`Unsupported transaction type: ${request.type}`);
      }

      // Build transaction fields
      const fields = this.buildTransactionFields(request);

      progressCallback?.({
        message: 'Please present card...',
        type: 'prompt',
      });

      // Send command and wait for response
      const response = await this.sendCommand(command, fields, this.config.transactionTimeout);

      this.currentTransaction = undefined;

      return this.parseTransactionResponse(request.transactionId, response, startedAt);
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
    // PAX doesn't have a cancel command - transactions must complete or timeout
    this.currentTransaction = undefined;
  }

  /**
   * Get device status
   */
  async getStatus(): Promise<ECRDeviceStatus> {
    try {
      const response = await this.sendCommand(PAX.COMMANDS.GET_INFO, []);
      const isOnline = this.isSuccess(response);

      return {
        deviceId: this.config.terminalId || '',
        state: isOnline ? ECRDeviceState.CONNECTED : ECRDeviceState.ERROR,
        isOnline,
        lastSeen: new Date(),
      };
    } catch (error) {
      return {
        deviceId: this.config.terminalId || '',
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
      const response = await this.sendCommand(
        PAX.COMMANDS.BATCH_CLOSE,
        [],
        PAX.TIMEOUTS.SETTLEMENT
      );

      const success = this.isSuccess(response);

      return {
        success,
        timestamp: new Date(),
        errorMessage: success ? undefined : this.getResponseMessage(response),
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
      await this.sendCommand(PAX.COMMANDS.RESET, [], PAX.TIMEOUTS.RESPONSE);
    } catch {
      // Ignore errors on abort
    }
  }

  /**
   * Build transaction fields for PAX
   */
  private buildTransactionFields(request: ECRTransactionRequest): string[] {
    const fields: string[] = [];

    // Field 1: Transaction type
    fields.push(this.getTransType(request.type));

    // Field 2: Amount (in cents)
    fields.push(request.amount.toString());

    // Field 3: Tip amount (optional)
    fields.push(request.tipAmount?.toString() || '0');

    // Field 4: Cashback (optional)
    fields.push(request.cashbackAmount?.toString() || '0');

    // Field 5: Reference number
    fields.push(request.reference || request.transactionId.slice(0, 16));

    // Field 6: EDC type
    fields.push(this.edcType);

    // Field 7: Invoice number
    fields.push(request.orderId || '');

    return fields;
  }

  /**
   * Get transaction type code
   */
  private getTransType(type: string): string {
    switch (type) {
      case 'sale':
        return PAX.TRANS_TYPES.SALE;
      case 'void':
        return PAX.TRANS_TYPES.VOID;
      case 'refund':
        return PAX.TRANS_TYPES.RETURN;
      case 'pre_auth':
        return PAX.TRANS_TYPES.AUTH_ONLY;
      case 'pre_auth_completion':
        return PAX.TRANS_TYPES.POST_AUTH;
      default:
        return PAX.TRANS_TYPES.SALE;
    }
  }

  /**
   * Send a PAX command
   */
  private async sendCommand(
    command: string,
    fields: string[],
    timeout: number = PAX.TIMEOUTS.RESPONSE
  ): Promise<string[]> {
    const frame = this.buildFrame(command, fields);
    this.debug('TX:', frame.toString('hex'));

    await this.transport.send(frame);

    const response = await this.transport.receive(timeout);
    this.debug('RX:', response.toString('hex'));

    return this.parseFrame(response);
  }

  /**
   * Build a PAX frame
   */
  private buildFrame(command: string, fields: string[]): Buffer {
    const parts: Buffer[] = [];

    // STX
    parts.push(Buffer.from([PAX.STX]));

    // Command
    parts.push(Buffer.from(command, 'ascii'));

    // Field separator before fields
    parts.push(Buffer.from([PAX.FS]));

    // Protocol version (1.28)
    parts.push(Buffer.from('1.28', 'ascii'));

    // Fields with separators
    for (const field of fields) {
      parts.push(Buffer.from([PAX.FS]));
      parts.push(Buffer.from(field, 'ascii'));
    }

    // ETX
    parts.push(Buffer.from([PAX.ETX]));

    const message = Buffer.concat(parts);

    // Calculate LRC
    let lrc = 0;
    for (let i = 1; i < message.length; i++) {
      lrc ^= message[i];
    }

    return Buffer.concat([message, Buffer.from([lrc])]);
  }

  /**
   * Parse a PAX frame
   */
  private parseFrame(data: Buffer): string[] {
    if (data.length < 4 || data[0] !== PAX.STX) {
      throw new Error('Invalid PAX frame');
    }

    // Find ETX
    let etxIndex = data.indexOf(PAX.ETX);
    if (etxIndex === -1) {
      throw new Error('ETX not found in PAX frame');
    }

    // Extract message content (between STX and ETX)
    const content = data.slice(1, etxIndex).toString('ascii');

    // Split by field separator
    const parts = content.split(String.fromCharCode(PAX.FS));

    return parts;
  }

  /**
   * Check if response indicates success
   */
  private isSuccess(response: string[]): boolean {
    if (response.length < 2) return false;

    // Response code is typically in position 1 (after command echo)
    const responseCode = response[1];
    return (
      responseCode === PAX.RESPONSE_CODES.APPROVED ||
      responseCode === PAX.RESPONSE_CODES.PARTIALLY_APPROVED
    );
  }

  /**
   * Get response message
   */
  private getResponseMessage(response: string[]): string {
    if (response.length < 2) return 'Unknown response';

    const code = response[1];
    return getPAXResultMessage(code);
  }

  /**
   * Parse transaction response
   */
  private parseTransactionResponse(
    transactionId: string,
    response: string[],
    startedAt: Date
  ): ECRTransactionResponse {
    const completedAt = new Date();

    if (response.length < 2) {
      return {
        transactionId,
        status: ECRTransactionStatus.ERROR,
        errorMessage: 'Invalid response',
        startedAt,
        completedAt,
      };
    }

    const responseCode = response[1];
    let status: ECRTransactionStatus;
    let errorMessage: string | undefined;

    // Map response code to status
    switch (responseCode) {
      case PAX.RESPONSE_CODES.APPROVED:
        status = ECRTransactionStatus.APPROVED;
        break;
      case PAX.RESPONSE_CODES.PARTIALLY_APPROVED:
        status = ECRTransactionStatus.APPROVED;
        break;
      case PAX.RESPONSE_CODES.DECLINED:
        status = ECRTransactionStatus.DECLINED;
        errorMessage = 'Transaction declined';
        break;
      case PAX.RESPONSE_CODES.USER_CANCELLED:
        status = ECRTransactionStatus.CANCELLED;
        errorMessage = 'Cancelled by user';
        break;
      case PAX.RESPONSE_CODES.HOST_TIMEOUT:
        status = ECRTransactionStatus.TIMEOUT;
        errorMessage = 'Host timeout';
        break;
      default:
        status = ECRTransactionStatus.ERROR;
        errorMessage = getPAXResultMessage(responseCode);
    }

    // Parse additional fields if available
    let authorizationCode: string | undefined;
    let cardLastFour: string | undefined;
    let cardType: ECRCardType | undefined;
    let entryMethod: ECRCardEntryMethod | undefined;
    let terminalReference: string | undefined;

    // PAX response fields (positions may vary by command)
    // Typical order: Command, Status, HostCode, HostMessage, AuthCode, ...
    if (response.length > 4) {
      authorizationCode = response[4] || undefined;
    }
    if (response.length > 5) {
      terminalReference = response[5] || undefined;
    }
    if (response.length > 8) {
      cardLastFour = response[8]?.slice(-4) || undefined;
    }
    if (response.length > 9) {
      cardType = this.parseCardType(response[9]);
    }
    if (response.length > 10) {
      entryMethod = this.parseEntryMethod(response[10]);
    }

    return {
      transactionId,
      terminalReference,
      status,
      authorizationCode,
      cardType,
      cardLastFour,
      entryMethod,
      errorMessage,
      errorCode: responseCode,
      startedAt,
      completedAt,
    };
  }

  /**
   * Parse card type
   */
  private parseCardType(type?: string): ECRCardType {
    if (!type) return ECRCardType.UNKNOWN;

    const upper = type.toUpperCase();
    if (upper.includes('VISA')) return ECRCardType.VISA;
    if (upper.includes('MASTER')) return ECRCardType.MASTERCARD;
    if (upper.includes('AMEX')) return ECRCardType.AMEX;
    if (upper.includes('DISCOVER')) return ECRCardType.DISCOVER;
    if (upper.includes('DINERS')) return ECRCardType.DINERS;
    if (upper.includes('MAESTRO')) return ECRCardType.MAESTRO;

    return ECRCardType.UNKNOWN;
  }

  /**
   * Parse entry method
   */
  private parseEntryMethod(method?: string): ECRCardEntryMethod {
    if (!method) return ECRCardEntryMethod.UNKNOWN;

    switch (method.toUpperCase()) {
      case PAX.ENTRY_MODES.CHIP:
      case 'C':
        return ECRCardEntryMethod.CHIP;
      case PAX.ENTRY_MODES.CONTACTLESS:
      case 'L':
        return ECRCardEntryMethod.CONTACTLESS;
      case PAX.ENTRY_MODES.SWIPE:
      case 'S':
        return ECRCardEntryMethod.SWIPE;
      case PAX.ENTRY_MODES.MANUAL:
      case 'M':
        return ECRCardEntryMethod.MANUAL;
      default:
        return ECRCardEntryMethod.UNKNOWN;
    }
  }
}
