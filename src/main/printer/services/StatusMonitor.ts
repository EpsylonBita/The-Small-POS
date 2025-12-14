/**
 * Status Monitor Service
 *
 * Monitors printer connectivity and status with periodic checking,
 * state machine management, and event emission on status changes.
 *
 * @module printer/services/StatusMonitor
 *
 * Requirements: 7.1, 7.2, 7.3, 7.4
 */

import { EventEmitter } from 'events';
import {
  PrinterStatus,
  PrinterState,
  PrinterErrorCode,
  StatusChangeCallback,
} from '../types';

/**
 * Default monitoring interval in milliseconds (30 seconds)
 */
export const DEFAULT_MONITORING_INTERVAL = 30000;

/**
 * Status monitor events
 */
export enum StatusMonitorEvent {
  STATUS_CHANGE = 'statusChange',
  ERROR = 'error',
}

/**
 * Error code to user-friendly message mapping
 *
 * Requirements: 7.3, 10.3
 */
export const ERROR_CODE_MESSAGES: Record<PrinterErrorCode, string> = {
  [PrinterErrorCode.PAPER_OUT]: 'Printer is out of paper. Please load a new paper roll.',
  [PrinterErrorCode.COVER_OPEN]: 'Printer cover is open. Please close the cover to continue printing.',
  [PrinterErrorCode.PAPER_JAM]: 'Paper jam detected. Please clear the jam and restart the printer.',
  [PrinterErrorCode.CUTTER_ERROR]: 'Paper cutter malfunction. Please check the cutter mechanism.',
  [PrinterErrorCode.OVERHEATED]: 'Printer has overheated. Please allow it to cool down before continuing.',
  [PrinterErrorCode.CONNECTION_LOST]: 'Connection to printer lost. Please check the network or cable connection.',
  [PrinterErrorCode.UNKNOWN]: 'An unknown printer error occurred. Please check the printer status.',
};

/**
 * Maps a printer error code to a user-friendly message
 *
 * @param errorCode - The printer error code
 * @returns A user-friendly error message
 *
 * Requirements: 7.3, 10.3
 */
export function getErrorMessage(errorCode: PrinterErrorCode): string {
  return ERROR_CODE_MESSAGES[errorCode] || ERROR_CODE_MESSAGES[PrinterErrorCode.UNKNOWN];
}

/**
 * Validates that a state is a valid PrinterState
 */
export function isValidPrinterState(state: string): state is PrinterState {
  return Object.values(PrinterState).includes(state as PrinterState);
}

/**
 * Interface for status check provider
 * Allows dependency injection for testing
 */
export interface StatusCheckProvider {
  /**
   * Check the status of a printer
   * @param printerId - The printer ID to check
   * @returns Promise resolving to the printer status
   */
  checkPrinterStatus(printerId: string): Promise<PrinterStatus>;
}

/**
 * Interface for queue length provider
 * Allows dependency injection for testing
 */
export interface QueueLengthProvider {
  /**
   * Get the queue length for a printer
   * @param printerId - The printer ID
   * @returns The number of jobs in the queue
   */
  getQueueLength(printerId: string): number;
}

/**
 * Monitored printer entry
 */
interface MonitoredPrinter {
  printerId: string;
  intervalMs: number;
  timer?: NodeJS.Timeout;
  lastStatus: PrinterStatus;
}

/**
 * StatusMonitor - Monitors printer connectivity and status
 *
 * Implements periodic status checking with configurable intervals,
 * maintains a state machine for printer states, and emits events
 * on status changes.
 *
 * Requirements: 7.1, 7.2, 7.4
 */
export class StatusMonitor extends EventEmitter {
  private monitoredPrinters: Map<string, MonitoredPrinter> = new Map();
  private statusCheckProvider?: StatusCheckProvider;
  private queueLengthProvider?: QueueLengthProvider;
  private statusCallbacks: StatusChangeCallback[] = [];

  constructor(
    statusCheckProvider?: StatusCheckProvider,
    queueLengthProvider?: QueueLengthProvider
  ) {
    super();
    this.statusCheckProvider = statusCheckProvider;
    this.queueLengthProvider = queueLengthProvider;
  }

  /**
   * Set the status check provider
   */
  setStatusCheckProvider(provider: StatusCheckProvider): void {
    this.statusCheckProvider = provider;
  }

  /**
   * Set the queue length provider
   */
  setQueueLengthProvider(provider: QueueLengthProvider): void {
    this.queueLengthProvider = provider;
  }


  /**
   * Start monitoring a printer with periodic status checks
   *
   * @param printerId - The printer ID to monitor
   * @param intervalMs - Check interval in milliseconds (default: 30000)
   *
   * Requirements: 7.1
   */
  startMonitoring(printerId: string, intervalMs: number = DEFAULT_MONITORING_INTERVAL): void {
    // Stop existing monitoring if any
    this.stopMonitoring(printerId);

    // Create initial status
    const initialStatus: PrinterStatus = {
      printerId,
      state: PrinterState.OFFLINE,
      lastSeen: new Date(),
      queueLength: this.getQueueLengthForPrinter(printerId),
    };

    const monitoredPrinter: MonitoredPrinter = {
      printerId,
      intervalMs,
      lastStatus: initialStatus,
    };

    // Start periodic checking
    monitoredPrinter.timer = setInterval(() => {
      this.performStatusCheck(printerId);
    }, intervalMs);

    this.monitoredPrinters.set(printerId, monitoredPrinter);

    // Perform initial check
    this.performStatusCheck(printerId);
  }

  /**
   * Stop monitoring a printer
   *
   * @param printerId - The printer ID to stop monitoring
   */
  stopMonitoring(printerId: string): void {
    const monitored = this.monitoredPrinters.get(printerId);
    if (monitored?.timer) {
      clearInterval(monitored.timer);
    }
    this.monitoredPrinters.delete(printerId);
  }

  /**
   * Stop monitoring all printers
   */
  stopAllMonitoring(): void {
    for (const [printerId] of this.monitoredPrinters) {
      this.stopMonitoring(printerId);
    }
  }

  /**
   * Check the status of a specific printer
   *
   * @param printerId - The printer ID to check
   * @returns Promise resolving to the printer status
   *
   * Requirements: 7.2
   */
  async checkStatus(printerId: string): Promise<PrinterStatus> {
    if (this.statusCheckProvider) {
      try {
        const status = await this.statusCheckProvider.checkPrinterStatus(printerId);
        this.updateStatus(printerId, status);
        return status;
      } catch (error) {
        const errorStatus = this.createErrorStatus(printerId, error);
        this.updateStatus(printerId, errorStatus);
        return errorStatus;
      }
    }

    // Return cached status if no provider
    const monitored = this.monitoredPrinters.get(printerId);
    if (monitored) {
      return monitored.lastStatus;
    }

    // Return default offline status
    return {
      printerId,
      state: PrinterState.OFFLINE,
      lastSeen: new Date(),
      queueLength: this.getQueueLengthForPrinter(printerId),
    };
  }

  /**
   * Register a callback for status changes
   *
   * @param callback - Function to call when status changes
   *
   * Requirements: 7.4
   */
  onStatusChange(callback: StatusChangeCallback): void {
    this.statusCallbacks.push(callback);
    this.on(StatusMonitorEvent.STATUS_CHANGE, callback);
  }

  /**
   * Remove a status change callback
   *
   * @param callback - The callback to remove
   */
  offStatusChange(callback: StatusChangeCallback): void {
    const index = this.statusCallbacks.indexOf(callback);
    if (index !== -1) {
      this.statusCallbacks.splice(index, 1);
    }
    this.off(StatusMonitorEvent.STATUS_CHANGE, callback);
  }

  /**
   * Get the current status of a monitored printer
   *
   * @param printerId - The printer ID
   * @returns The current status or null if not monitored
   */
  getCurrentStatus(printerId: string): PrinterStatus | null {
    const monitored = this.monitoredPrinters.get(printerId);
    return monitored?.lastStatus ?? null;
  }

  /**
   * Get all monitored printer statuses
   *
   * @returns Map of printer IDs to their statuses
   */
  getAllStatuses(): Map<string, PrinterStatus> {
    const statuses = new Map<string, PrinterStatus>();
    for (const [printerId, monitored] of this.monitoredPrinters) {
      statuses.set(printerId, monitored.lastStatus);
    }
    return statuses;
  }

  /**
   * Manually update the status of a printer
   * This is useful for external status updates (e.g., from transport events)
   *
   * @param printerId - The printer ID
   * @param newState - The new printer state
   * @param errorCode - Optional error code
   * @param errorMessage - Optional error message
   *
   * Requirements: 7.2, 7.4
   */
  updatePrinterState(
    printerId: string,
    newState: PrinterState,
    errorCode?: PrinterErrorCode,
    errorMessage?: string
  ): void {
    const newStatus: PrinterStatus = {
      printerId,
      state: newState,
      errorCode,
      errorMessage: errorMessage ?? (errorCode ? getErrorMessage(errorCode) : undefined),
      lastSeen: new Date(),
      queueLength: this.getQueueLengthForPrinter(printerId),
    };

    this.updateStatus(printerId, newStatus);
  }

  /**
   * Check if a printer is currently being monitored
   *
   * @param printerId - The printer ID
   * @returns true if the printer is being monitored
   */
  isMonitoring(printerId: string): boolean {
    return this.monitoredPrinters.has(printerId);
  }

  /**
   * Get the list of monitored printer IDs
   *
   * @returns Array of printer IDs being monitored
   */
  getMonitoredPrinters(): string[] {
    return Array.from(this.monitoredPrinters.keys());
  }

  /**
   * Perform a status check for a printer
   * @private
   */
  private async performStatusCheck(printerId: string): Promise<void> {
    try {
      await this.checkStatus(printerId);
    } catch (error) {
      this.emit(StatusMonitorEvent.ERROR, { printerId, error });
    }
  }

  /**
   * Update the status of a printer and emit events if changed
   * @private
   *
   * Requirements: 7.4
   */
  private updateStatus(printerId: string, newStatus: PrinterStatus): void {
    let monitored = this.monitoredPrinters.get(printerId);

    if (!monitored) {
      // Create a new monitored entry if not exists
      monitored = {
        printerId,
        intervalMs: DEFAULT_MONITORING_INTERVAL,
        lastStatus: newStatus,
      };
      this.monitoredPrinters.set(printerId, monitored);
    }

    const oldStatus = monitored.lastStatus;
    const hasStateChanged = oldStatus.state !== newStatus.state;
    const hasErrorChanged = oldStatus.errorCode !== newStatus.errorCode;

    // Update the stored status
    monitored.lastStatus = newStatus;

    // Emit status change event if state or error changed
    if (hasStateChanged || hasErrorChanged) {
      this.emit(StatusMonitorEvent.STATUS_CHANGE, printerId, newStatus);
    }
  }

  /**
   * Create an error status from an exception
   * @private
   */
  private createErrorStatus(printerId: string, error: unknown): PrinterStatus {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorCode = this.inferErrorCode(errorMessage);

    return {
      printerId,
      state: PrinterState.ERROR,
      errorCode,
      errorMessage: getErrorMessage(errorCode),
      lastSeen: new Date(),
      queueLength: this.getQueueLengthForPrinter(printerId),
    };
  }

  /**
   * Infer error code from error message
   * @private
   */
  private inferErrorCode(errorMessage: string): PrinterErrorCode {
    const lowerMessage = errorMessage.toLowerCase();

    if (lowerMessage.includes('paper') && (lowerMessage.includes('out') || lowerMessage.includes('empty'))) {
      return PrinterErrorCode.PAPER_OUT;
    }
    if (lowerMessage.includes('cover') && lowerMessage.includes('open')) {
      return PrinterErrorCode.COVER_OPEN;
    }
    if (lowerMessage.includes('jam')) {
      return PrinterErrorCode.PAPER_JAM;
    }
    if (lowerMessage.includes('cutter')) {
      return PrinterErrorCode.CUTTER_ERROR;
    }
    if (lowerMessage.includes('overheat') || lowerMessage.includes('temperature')) {
      return PrinterErrorCode.OVERHEATED;
    }
    if (lowerMessage.includes('connection') || lowerMessage.includes('timeout') || lowerMessage.includes('disconnect')) {
      return PrinterErrorCode.CONNECTION_LOST;
    }

    return PrinterErrorCode.UNKNOWN;
  }

  /**
   * Get queue length for a printer
   * @private
   */
  private getQueueLengthForPrinter(printerId: string): number {
    if (this.queueLengthProvider) {
      return this.queueLengthProvider.getQueueLength(printerId);
    }
    return 0;
  }

  /**
   * Clean up resources
   */
  destroy(): void {
    this.stopAllMonitoring();
    this.removeAllListeners();
    this.statusCallbacks = [];
  }
}
