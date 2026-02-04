/**
 * ZVT Protocol Implementation
 *
 * German/European standard protocol for Ingenico and Verifone terminals.
 * Uses DLE/STX framing with TLV data encoding.
 *
 * Reference: https://github.com/Portalum/Portalum.Zvt
 *
 * @module ecr/protocols/ZVTProtocol
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
  ECRReceiptData,
} from '../../../../../shared/types/ecr';
import {
  ECRTransactionStatus,
  ECRDeviceState,
  ECRCardType,
  ECRCardEntryMethod,
} from '../../../../../shared/types/ecr';
import {
  ZVT,
  amountToBCD,
  bcdToAmount,
  calculateCRC16,
  getZVTResultMessage,
} from '../../../../../shared/ecr/protocols/constants';

/**
 * ZVT Protocol configuration
 */
export interface ZVTConfig extends ProtocolAdapterConfig {
  /** Terminal password (6 digits) */
  password?: number;
  /** Service byte options */
  serviceByte?: number;
  /** Print receipts on POS (not terminal) */
  printOnPOS?: boolean;
}

/**
 * ZVT APDU (Application Protocol Data Unit)
 */
interface ZVTAPDU {
  class: number;
  instruction: number;
  length: number;
  data: Buffer;
}

/**
 * ZVT Protocol implementation for European terminals
 */
export class ZVTProtocol extends BaseProtocolAdapter {
  private password: number;
  private serviceByte: number;
  private printOnPOS: boolean;
  private registrationComplete: boolean = false;
  private receiptLines: string[] = [];

  constructor(transport: BaseECRTransport, config?: ZVTConfig) {
    super(transport, config);
    this.password = config?.password ?? 0;
    this.serviceByte = config?.serviceByte ?? 0;
    this.printOnPOS = config?.printOnPOS ?? true;
  }

  /**
   * Initialize the protocol by sending registration command
   */
  async initialize(): Promise<void> {
    if (!this.transport.isConnected()) {
      throw new Error('Transport is not connected');
    }

    try {
      // Send registration command
      await this.sendRegistration();
      this.initialized = true;
      this.registrationComplete = true;
      this.debug('ZVT Protocol initialized successfully');
    } catch (error) {
      this.debug('ZVT initialization failed:', error);
      throw error;
    }
  }

  /**
   * Send registration/login command to terminal
   */
  private async sendRegistration(): Promise<void> {
    // Build registration data (BMP fields)
    const data = this.buildRegistrationData();

    // Send registration command
    const response = await this.sendCommand(
      ZVT.COMMANDS.REGISTRATION.class,
      ZVT.COMMANDS.REGISTRATION.instruction,
      data
    );

    // Check response
    if (!this.isPositiveCompletion(response)) {
      throw new Error('Registration failed: ' + this.getErrorMessage(response));
    }
  }

  /**
   * Process a payment transaction
   */
  async processTransaction(
    request: ECRTransactionRequest,
    progressCallback?: TransactionProgressCallback
  ): Promise<ECRTransactionResponse> {
    if (!this.initialized || !this.registrationComplete) {
      throw new Error('Protocol not initialized');
    }

    this.currentTransaction = request;
    this.receiptLines = [];
    const startedAt = new Date();

    try {
      progressCallback?.({
        message: 'Connecting to terminal...',
        type: 'info',
      });

      // Determine command based on transaction type
      let commandClass: number;
      let commandInstruction: number;

      switch (request.type) {
        case 'sale':
          commandClass = ZVT.COMMANDS.AUTHORIZATION.class;
          commandInstruction = ZVT.COMMANDS.AUTHORIZATION.instruction;
          break;
        case 'refund':
          commandClass = ZVT.COMMANDS.REFUND.class;
          commandInstruction = ZVT.COMMANDS.REFUND.instruction;
          break;
        case 'void':
          commandClass = ZVT.COMMANDS.REVERSAL.class;
          commandInstruction = ZVT.COMMANDS.REVERSAL.instruction;
          break;
        case 'pre_auth':
          commandClass = ZVT.COMMANDS.PRE_AUTHORIZATION.class;
          commandInstruction = ZVT.COMMANDS.PRE_AUTHORIZATION.instruction;
          break;
        default:
          throw new Error(`Unsupported transaction type: ${request.type}`);
      }

      // Build transaction data
      const data = this.buildTransactionData(request);

      progressCallback?.({
        message: 'Please present card...',
        type: 'prompt',
      });

      // Send command and process response
      const response = await this.processTransactionCommand(
        commandClass,
        commandInstruction,
        data,
        progressCallback
      );

      this.currentTransaction = undefined;

      return {
        transactionId: request.transactionId,
        status: response.status ?? ECRTransactionStatus.ERROR,
        ...response,
        startedAt,
        completedAt: new Date(),
        customerReceiptData: this.receiptLines.length > 0 ? {
          lines: [...this.receiptLines],
        } : undefined,
      };
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
      await this.sendCommand(
        ZVT.COMMANDS.ABORT.class,
        ZVT.COMMANDS.ABORT.instruction,
        Buffer.alloc(0)
      );
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
      const response = await this.sendCommand(
        ZVT.COMMANDS.STATUS_ENQUIRY.class,
        ZVT.COMMANDS.STATUS_ENQUIRY.instruction,
        Buffer.alloc(0)
      );

      const isOnline = this.isPositiveCompletion(response);

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
        ZVT.COMMANDS.END_OF_DAY.class,
        ZVT.COMMANDS.END_OF_DAY.instruction,
        Buffer.alloc(0),
        ZVT.TIMEOUTS.SETTLEMENT
      );

      const success = this.isPositiveCompletion(response);

      // Parse totals if available
      let transactionCount: number | undefined;
      let totalAmount: number | undefined;

      if (success && response.data.length > 0) {
        const tlv = this.parseTLV(response.data);
        if (tlv.has(ZVT.BMP.TRACE_NUMBER)) {
          transactionCount = parseInt(tlv.get(ZVT.BMP.TRACE_NUMBER)!.toString('hex'), 10);
        }
        if (tlv.has(ZVT.BMP.AMOUNT)) {
          totalAmount = bcdToAmount(tlv.get(ZVT.BMP.AMOUNT)!);
        }
      }

      return {
        success,
        transactionCount,
        totalAmount,
        timestamp: new Date(),
        errorMessage: success ? undefined : this.getErrorMessage(response),
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
      await this.sendCommand(
        ZVT.COMMANDS.ABORT.class,
        ZVT.COMMANDS.ABORT.instruction,
        Buffer.alloc(0),
        ZVT.TIMEOUTS.ABORT
      );
    } catch {
      // Ignore errors on abort
    }
  }

  /**
   * Build registration data
   */
  private buildRegistrationData(): Buffer {
    const parts: Buffer[] = [];

    // Password (6 bytes BCD)
    parts.push(Buffer.from([ZVT.BMP.TIMEOUT]));
    parts.push(amountToBCD(this.password).slice(0, 3));

    // Config byte
    const configByte = this.printOnPOS ? 0x86 : 0x06;
    parts.push(Buffer.from([ZVT.BMP.SERVICE_BYTE, configByte]));

    // Currency (EUR = 978)
    parts.push(Buffer.from([ZVT.BMP.CURRENCY_CODE]));
    parts.push(Buffer.from([0x09, 0x78])); // BCD 0978

    return Buffer.concat(parts);
  }

  /**
   * Build transaction data
   */
  private buildTransactionData(request: ECRTransactionRequest): Buffer {
    const parts: Buffer[] = [];

    // Amount (BMP 04, 6 bytes BCD)
    parts.push(Buffer.from([ZVT.BMP.AMOUNT]));
    parts.push(amountToBCD(request.amount));

    // Currency (BMP 49)
    const currencyCode = request.currency === 'EUR' ? 978 : 840;
    parts.push(Buffer.from([ZVT.BMP.CURRENCY_CODE]));
    parts.push(Buffer.from([
      Math.floor(currencyCode / 100),
      currencyCode % 100,
    ]));

    // Trace number if provided
    if (request.reference) {
      const trace = parseInt(request.reference.replace(/\D/g, '').slice(0, 6), 10) || 0;
      parts.push(Buffer.from([ZVT.BMP.TRACE_NUMBER]));
      parts.push(amountToBCD(trace).slice(3, 6));
    }

    return Buffer.concat(parts);
  }

  /**
   * Process a transaction command and handle intermediate messages
   */
  private async processTransactionCommand(
    commandClass: number,
    commandInstruction: number,
    data: Buffer,
    progressCallback?: TransactionProgressCallback
  ): Promise<Partial<ECRTransactionResponse>> {
    const timeout = this.config.transactionTimeout;
    const startTime = Date.now();

    // Send the command
    await this.sendAPDU({
      class: commandClass,
      instruction: commandInstruction,
      length: data.length,
      data,
    });

    // Wait for completion
    while (Date.now() - startTime < timeout) {
      const response = await this.receiveAPDU(5000);

      // Handle intermediate status messages
      if (
        response.class === ZVT.INTERMEDIATE_STATUS.PLEASE_WAIT.class &&
        response.instruction === ZVT.INTERMEDIATE_STATUS.PLEASE_WAIT.instruction
      ) {
        const message = this.parseIntermediateStatus(response.data);
        progressCallback?.(message);
        this.emitDisplay(message);

        // Send ACK
        await this.sendACK();
        continue;
      }

      // Handle print requests
      if (response.class === ZVT.COMMANDS.PRINT_LINE.class) {
        const lines = this.parsePrintData(response.data);
        this.receiptLines.push(...lines);

        // Emit print event
        this.emitPrintReceipt(lines, false);

        // Send ACK
        await this.sendACK();
        continue;
      }

      // Handle completion message
      if (
        response.class === ZVT.COMMANDS.COMPLETION.class &&
        response.instruction === ZVT.COMMANDS.COMPLETION.instruction
      ) {
        await this.sendACK();
        return this.parseCompletionResponse(response);
      }

      // Check for status enquiry response
      if (response.class === 0x04) {
        await this.sendACK();
        return this.parseStatusResponse(response);
      }

      // Positive acknowledgment
      if (response.class === 0x80 && response.instruction === 0x00) {
        continue; // Wait for completion
      }

      // Negative acknowledgment
      if (response.class === 0x84 && response.instruction === 0x00) {
        const errorCode = response.data.length > 0 ? response.data[0] : 0xff;
        return {
          status: ECRTransactionStatus.ERROR,
          errorMessage: getZVTResultMessage(errorCode),
          errorCode: errorCode.toString(16),
        };
      }
    }

    return {
      status: ECRTransactionStatus.TIMEOUT,
      errorMessage: 'Transaction timeout',
    };
  }

  /**
   * Send a ZVT command and wait for acknowledgment
   */
  private async sendCommand(
    commandClass: number,
    instruction: number,
    data: Buffer,
    timeout?: number
  ): Promise<ZVTAPDU> {
    await this.sendAPDU({
      class: commandClass,
      instruction,
      length: data.length,
      data,
    });

    return this.receiveAPDU(timeout ?? ZVT.TIMEOUTS.STATUS);
  }

  /**
   * Send an APDU to the terminal
   */
  private async sendAPDU(apdu: ZVTAPDU): Promise<void> {
    const frame = this.buildFrame(apdu);
    this.debug('TX:', frame.toString('hex'));
    await this.transport.send(frame);
  }

  /**
   * Receive an APDU from the terminal
   */
  private async receiveAPDU(timeout: number): Promise<ZVTAPDU> {
    const data = await this.transport.receive(timeout);
    this.debug('RX:', data.toString('hex'));
    return this.parseFrame(data);
  }

  /**
   * Send ACK to terminal
   */
  private async sendACK(): Promise<void> {
    const ack = Buffer.from([0x80, 0x00, 0x00]);
    await this.transport.send(ack);
  }

  /**
   * Build a ZVT frame
   */
  private buildFrame(apdu: ZVTAPDU): Buffer {
    if (apdu.length <= 254) {
      // Short form
      const frame = Buffer.alloc(3 + apdu.length);
      frame[0] = apdu.class;
      frame[1] = apdu.instruction;
      frame[2] = apdu.length;
      apdu.data.copy(frame, 3);
      return frame;
    } else {
      // Extended form
      const frame = Buffer.alloc(5 + apdu.length);
      frame[0] = apdu.class;
      frame[1] = apdu.instruction;
      frame[2] = 0xff;
      frame.writeUInt16BE(apdu.length, 3);
      apdu.data.copy(frame, 5);
      return frame;
    }
  }

  /**
   * Parse a ZVT frame
   */
  private parseFrame(data: Buffer): ZVTAPDU {
    if (data.length < 3) {
      throw new Error('Frame too short');
    }

    const classCode = data[0];
    const instruction = data[1];
    let length: number;
    let dataOffset: number;

    if (data[2] === 0xff) {
      // Extended length
      if (data.length < 5) {
        throw new Error('Extended length frame too short');
      }
      length = data.readUInt16BE(3);
      dataOffset = 5;
    } else {
      length = data[2];
      dataOffset = 3;
    }

    const payload = data.slice(dataOffset, dataOffset + length);

    return {
      class: classCode,
      instruction,
      length,
      data: payload,
    };
  }

  /**
   * Check if response is positive completion
   */
  private isPositiveCompletion(apdu: ZVTAPDU): boolean {
    return (
      (apdu.class === 0x80 && apdu.instruction === 0x00) ||
      (apdu.class === 0x06 && apdu.instruction === 0x0f)
    );
  }

  /**
   * Parse intermediate status message
   */
  private parseIntermediateStatus(data: Buffer): {
    message: string;
    type: 'info' | 'prompt' | 'warning' | 'error';
  } {
    const tlv = this.parseTLV(data);

    let message = 'Processing...';
    if (tlv.has(ZVT.BMP.ADDITIONAL_TEXT)) {
      message = tlv.get(ZVT.BMP.ADDITIONAL_TEXT)!.toString('latin1').trim();
    }

    return { message, type: 'info' };
  }

  /**
   * Parse print data
   */
  private parsePrintData(data: Buffer): string[] {
    const lines: string[] = [];
    let offset = 0;

    while (offset < data.length) {
      // Find line terminator (0x00 or 0x0A)
      let end = offset;
      while (end < data.length && data[end] !== 0x00 && data[end] !== 0x0a) {
        end++;
      }

      if (end > offset) {
        const line = data.slice(offset, end).toString('latin1');
        lines.push(line);
      }

      offset = end + 1;
    }

    return lines;
  }

  /**
   * Parse completion response
   */
  private parseCompletionResponse(apdu: ZVTAPDU): Partial<ECRTransactionResponse> {
    const tlv = this.parseTLV(apdu.data);

    // Check result code
    let status: ECRTransactionStatus = ECRTransactionStatus.APPROVED;
    let errorMessage: string | undefined;
    let errorCode: string | undefined;

    if (tlv.has(ZVT.BMP.RESULT_CODE)) {
      const resultCode = tlv.get(ZVT.BMP.RESULT_CODE)![0];
      if (resultCode !== ZVT.RESULT_CODES.SUCCESS) {
        status = this.mapResultCodeToStatus(resultCode);
        errorMessage = getZVTResultMessage(resultCode);
        errorCode = resultCode.toString(16);
      }
    }

    // Parse card info
    let cardLastFour: string | undefined;
    let cardType: ECRCardType | undefined;
    let authorizationCode: string | undefined;
    let entryMethod: ECRCardEntryMethod | undefined;

    if (tlv.has(ZVT.BMP.CARD_PAN)) {
      const pan = tlv.get(ZVT.BMP.CARD_PAN)!.toString('hex');
      cardLastFour = pan.slice(-4);
    }

    if (tlv.has(ZVT.BMP.CARD_TYPE_ID)) {
      cardType = this.parseCardType(tlv.get(ZVT.BMP.CARD_TYPE_ID)![0]);
    }

    if (tlv.has(ZVT.BMP.AUTH_CODE)) {
      authorizationCode = tlv.get(ZVT.BMP.AUTH_CODE)!.toString('ascii').trim();
    }

    if (tlv.has(ZVT.BMP.PAYMENT_TYPE)) {
      entryMethod = this.parsePaymentType(tlv.get(ZVT.BMP.PAYMENT_TYPE)![0]);
    }

    return {
      status,
      authorizationCode,
      cardType,
      cardLastFour,
      entryMethod,
      errorMessage,
      errorCode,
    };
  }

  /**
   * Parse status response
   */
  private parseStatusResponse(apdu: ZVTAPDU): Partial<ECRTransactionResponse> {
    const tlv = this.parseTLV(apdu.data);

    let status: ECRTransactionStatus = ECRTransactionStatus.APPROVED;
    let errorMessage: string | undefined;

    if (tlv.has(ZVT.BMP.RESULT_CODE)) {
      const resultCode = tlv.get(ZVT.BMP.RESULT_CODE)![0];
      if (resultCode !== ZVT.RESULT_CODES.SUCCESS) {
        status = this.mapResultCodeToStatus(resultCode);
        errorMessage = getZVTResultMessage(resultCode);
      }
    }

    return { status, errorMessage };
  }

  /**
   * Parse TLV data
   */
  private parseTLV(data: Buffer): Map<number, Buffer> {
    const result = new Map<number, Buffer>();
    let offset = 0;

    while (offset < data.length) {
      const tag = data[offset++];
      if (offset >= data.length) break;

      const length = data[offset++];
      if (offset + length > data.length) break;

      const value = data.slice(offset, offset + length);
      result.set(tag, value);
      offset += length;
    }

    return result;
  }

  /**
   * Map ZVT result code to transaction status
   */
  private mapResultCodeToStatus(code: number): ECRTransactionStatus {
    switch (code) {
      case ZVT.RESULT_CODES.SUCCESS:
        return ECRTransactionStatus.APPROVED;
      case ZVT.RESULT_CODES.DECLINED:
      case ZVT.RESULT_CODES.CARD_NOT_ACCEPTED:
      case ZVT.RESULT_CODES.CARD_EXPIRED:
      case ZVT.RESULT_CODES.CARD_BLOCKED:
      case ZVT.RESULT_CODES.CARD_INVALID:
      case ZVT.RESULT_CODES.PIN_WRONG:
      case ZVT.RESULT_CODES.PIN_BLOCKED:
        return ECRTransactionStatus.DECLINED;
      case ZVT.RESULT_CODES.ABORT:
        return ECRTransactionStatus.CANCELLED;
      case ZVT.RESULT_CODES.HOST_TIMEOUT:
        return ECRTransactionStatus.TIMEOUT;
      default:
        return ECRTransactionStatus.ERROR;
    }
  }

  /**
   * Parse card type from ZVT code
   */
  private parseCardType(code: number): ECRCardType {
    // ZVT card type IDs vary by acquirer, this is a simplified mapping
    switch (code) {
      case 0x02:
        return ECRCardType.VISA;
      case 0x03:
        return ECRCardType.MASTERCARD;
      case 0x04:
        return ECRCardType.AMEX;
      case 0x06:
        return ECRCardType.MAESTRO;
      default:
        return ECRCardType.UNKNOWN;
    }
  }

  /**
   * Parse payment type to entry method
   */
  private parsePaymentType(code: number): ECRCardEntryMethod {
    switch (code) {
      case ZVT.PAYMENT_TYPES.CONTACT_CHIP:
        return ECRCardEntryMethod.CHIP;
      case ZVT.PAYMENT_TYPES.CONTACTLESS:
        return ECRCardEntryMethod.CONTACTLESS;
      case ZVT.PAYMENT_TYPES.MAGNETIC_STRIPE:
        return ECRCardEntryMethod.SWIPE;
      case ZVT.PAYMENT_TYPES.MANUAL_ENTRY:
        return ECRCardEntryMethod.MANUAL;
      default:
        return ECRCardEntryMethod.UNKNOWN;
    }
  }

  /**
   * Get error message from response
   */
  private getErrorMessage(apdu: ZVTAPDU): string {
    const tlv = this.parseTLV(apdu.data);

    if (tlv.has(ZVT.BMP.RESULT_CODE)) {
      const code = tlv.get(ZVT.BMP.RESULT_CODE)![0];
      return getZVTResultMessage(code);
    }

    if (tlv.has(ZVT.BMP.ADDITIONAL_TEXT)) {
      return tlv.get(ZVT.BMP.ADDITIONAL_TEXT)!.toString('latin1').trim();
    }

    return 'Unknown error';
  }
}
