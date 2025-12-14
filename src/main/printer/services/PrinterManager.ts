/**
 * Printer Manager (Main Orchestrator)
 *
 * Central component that coordinates all printer operations including
 * discovery, configuration, job submission, routing, and status monitoring.
 *
 * @module printer/services/PrinterManager
 *
 * Requirements: All (1.1-10.5)
 */

import { EventEmitter } from 'events';
import type Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';

import {
  PrinterConfig,
  PrinterType,
  PrinterRole,
  PrinterState,
  PrinterStatus,
  PrinterErrorCode,
  PrintJob,
  PrintJobType,
  PrintJobResult,
  QueuedJob,
  QueuedJobStatus,
  DiscoveredPrinter,
  TestPrintResult,
  PrinterDiagnostics,
  ConnectionDetails,
  isNetworkConnectionDetails,
  isBluetoothConnectionDetails,
  isUSBConnectionDetails,
  isRawEscPosData,
} from '../types';
import { validatePrinterConfig } from '../types/validation';

import { PrinterConfigStore } from './PrinterConfigStore';
import { PrintQueueService } from './PrintQueueService';
import {
  JobRouter,
  PrinterStatusProvider,
  RoutingEntry,
  CategoryRoutingEntry,
  FallbackEntry,
} from './JobRouter';
import {
  StatusMonitor,
  StatusMonitorEvent,
  StatusCheckProvider,
  QueueLengthProvider,
  getErrorMessage,
} from './StatusMonitor';
import { ReceiptGenerator, EscPosBuilder } from './escpos';

import {
  NetworkDiscovery,
  BluetoothDiscovery,
  USBDiscovery,
  PrinterDiscovery,
} from '../discovery';

import {
  IPrinterTransport,
  NetworkTransport,
  BluetoothTransport,
  USBTransport,
  TransportState,
  TransportEvent,
} from '../transport';

// ============================================================================
// Constants
// ============================================================================

/** Maximum retry attempts for print jobs */
const MAX_RETRY_ATTEMPTS = 3;

/** Default discovery timeout in milliseconds */
const DEFAULT_DISCOVERY_TIMEOUT = 10000;

/** Job processing interval in milliseconds */
const JOB_PROCESSING_INTERVAL = 1000;

// ============================================================================
// Events
// ============================================================================

/**
 * Events emitted by PrinterManager
 */
export enum PrinterManagerEvent {
  PRINTER_ADDED = 'printerAdded',
  PRINTER_UPDATED = 'printerUpdated',
  PRINTER_REMOVED = 'printerRemoved',
  PRINTER_STATUS_CHANGED = 'printerStatusChanged',
  JOB_SUBMITTED = 'jobSubmitted',
  JOB_STARTED = 'jobStarted',
  JOB_COMPLETED = 'jobCompleted',
  JOB_FAILED = 'jobFailed',
  JOB_RETRYING = 'jobRetrying',
  DISCOVERY_STARTED = 'discoveryStarted',
  DISCOVERY_COMPLETED = 'discoveryCompleted',
  ERROR = 'error',
}

// ============================================================================
// Types
// ============================================================================

/**
 * Options for PrinterManager initialization
 */
export interface PrinterManagerOptions {
  /** Auto-start job processing on initialization */
  autoStartProcessing?: boolean;
  /** Auto-connect to configured printers on initialization */
  autoConnect?: boolean;
  /** Job processing interval in milliseconds */
  processingInterval?: number;
}

/**
 * Default options
 */
const DEFAULT_OPTIONS: Required<PrinterManagerOptions> = {
  autoStartProcessing: true,
  autoConnect: true,
  processingInterval: JOB_PROCESSING_INTERVAL,
};


// ============================================================================
// PrinterManager Class
// ============================================================================

/**
 * PrinterManager - Main orchestrator for all printer operations
 *
 * Integrates:
 * - PrinterConfigStore for configuration persistence
 * - PrintQueueService for job queuing
 * - JobRouter for job routing
 * - StatusMonitor for status monitoring
 * - Discovery services for printer discovery
 * - Transport layer for printer communication
 *
 * Requirements: All
 */
export class PrinterManager
  extends EventEmitter
  implements PrinterStatusProvider, StatusCheckProvider, QueueLengthProvider
{
  private db: Database.Database;
  private options: Required<PrinterManagerOptions>;

  // Services
  private configStore: PrinterConfigStore;
  private queueService: PrintQueueService;
  private jobRouter: JobRouter;
  private statusMonitor: StatusMonitor;
  private receiptGenerator: ReceiptGenerator;

  // Discovery services
  private networkDiscovery: NetworkDiscovery;
  private bluetoothDiscovery: BluetoothDiscovery;
  private usbDiscovery: USBDiscovery;

  // Active transports (printerId -> transport)
  private transports: Map<string, IPrinterTransport> = new Map();

  // Printer status cache
  private printerStatuses: Map<string, PrinterStatus> = new Map();

  // Job processing state
  private processingTimer?: NodeJS.Timeout;
  private isProcessing: boolean = false;
  private initialized: boolean = false;

  constructor(db: Database.Database, options?: PrinterManagerOptions) {
    super();
    this.db = db;
    this.options = { ...DEFAULT_OPTIONS, ...options };

    // Initialize services
    this.configStore = new PrinterConfigStore(db);
    this.queueService = new PrintQueueService(db);
    this.jobRouter = new JobRouter(this);
    this.statusMonitor = new StatusMonitor(this, this);
    this.receiptGenerator = new ReceiptGenerator();

    // Initialize discovery services
    this.networkDiscovery = new NetworkDiscovery();
    this.bluetoothDiscovery = new BluetoothDiscovery();
    this.usbDiscovery = new USBDiscovery();

    // Set up status monitor event forwarding
    this.statusMonitor.on(StatusMonitorEvent.STATUS_CHANGE, (printerId: string, status: PrinterStatus) => {
      this.printerStatuses.set(printerId, status);
      this.emit(PrinterManagerEvent.PRINTER_STATUS_CHANGED, printerId, status);
    });
  }

  // ==========================================================================
  // Initialization and Lifecycle
  // ==========================================================================

  /**
   * Initialize the PrinterManager
   * - Loads saved configurations
   * - Resumes pending jobs
   * - Connects to configured printers
   * - Starts job processing
   *
   * Requirements: 6.5, 8.2
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    // Initialize stores
    this.configStore.initialize();
    this.queueService.initialize();

    // Load printer configurations and set up routing
    await this.loadConfigurations();

    // Perform startup recovery
    await this.performStartupRecovery();

    // Auto-connect to printers if enabled
    if (this.options.autoConnect) {
      await this.connectToAllPrinters();
    }

    // Start job processing if enabled
    if (this.options.autoStartProcessing) {
      this.startJobProcessing();
    }

    this.initialized = true;
  }

  /**
   * Shutdown the PrinterManager
   * - Stops job processing
   * - Disconnects all printers
   * - Cleans up resources
   */
  async shutdown(): Promise<void> {
    this.stopJobProcessing();
    this.statusMonitor.stopAllMonitoring();

    // Disconnect all transports
    for (const [printerId, transport] of this.transports) {
      try {
        await transport.disconnect();
      } catch (error) {
        console.error(`[PrinterManager] Error disconnecting printer ${printerId}:`, error);
      }
    }
    this.transports.clear();

    this.removeAllListeners();
    this.initialized = false;
  }

  /**
   * Load printer configurations and set up routing
   */
  private async loadConfigurations(): Promise<void> {
    const printers = this.configStore.getAll();

    for (const printer of printers) {
      // Initialize status for each printer
      this.printerStatuses.set(printer.id, {
        printerId: printer.id,
        state: PrinterState.OFFLINE,
        lastSeen: new Date(),
        queueLength: 0,
      });

      // Set up routing based on role
      const jobType = this.roleToJobType(printer.role);
      if (jobType && printer.enabled) {
        this.jobRouter.setRouting(jobType, printer.id);
      }

      // Set up fallback if configured
      if (printer.fallbackPrinterId) {
        this.jobRouter.setFallback(printer.id, printer.fallbackPrinterId);
      }

      // Set default printer
      if (printer.isDefault) {
        this.jobRouter.setDefaultPrinter(printer.id);
      }
    }
  }

  /**
   * Perform startup recovery - resume pending jobs
   *
   * Requirements: 6.5
   */
  private async performStartupRecovery(): Promise<void> {
    // Reset any jobs that were in 'printing' state (interrupted by crash/restart)
    const resetCount = this.queueService.resetPrintingJobs();
    if (resetCount > 0) {
      console.log(`[PrinterManager] Reset ${resetCount} interrupted jobs to pending`);
    }

    // Get pending jobs count
    const pendingJobs = this.queueService.getPendingJobs();
    if (pendingJobs.length > 0) {
      console.log(`[PrinterManager] Found ${pendingJobs.length} pending jobs to process`);
    }
  }

  /**
   * Connect to all enabled printers
   */
  private async connectToAllPrinters(): Promise<void> {
    const printers = this.configStore.getEnabled();

    for (const printer of printers) {
      try {
        await this.connectToPrinter(printer);
      } catch (error) {
        console.error(`[PrinterManager] Failed to connect to printer ${printer.name}:`, error);
      }
    }
  }

  // ==========================================================================
  // Discovery Methods
  // ==========================================================================

  /**
   * Discover available printers
   * @param types - Optional array of printer types to discover
   * @param timeout - Discovery timeout in milliseconds
   * @returns Array of discovered printers
   *
   * Requirements: 1.1, 1.2, 1.3, 1.4
   */
  async discoverPrinters(
    types?: PrinterType[],
    timeout: number = DEFAULT_DISCOVERY_TIMEOUT
  ): Promise<DiscoveredPrinter[]> {
    this.emit(PrinterManagerEvent.DISCOVERY_STARTED, types);

    const discoveryTypes = types || [PrinterType.NETWORK, PrinterType.BLUETOOTH, PrinterType.USB];
    const discoveryPromises: Promise<DiscoveredPrinter[]>[] = [];

    // Get configured printer addresses for marking as configured
    const configuredAddresses = new Set(
      this.configStore.getAll().map((p) => this.getAddressFromConfig(p))
    );

    if (discoveryTypes.includes(PrinterType.NETWORK) || discoveryTypes.includes(PrinterType.WIFI)) {
      discoveryPromises.push(this.networkDiscovery.discover(timeout));
    }

    if (discoveryTypes.includes(PrinterType.BLUETOOTH)) {
      discoveryPromises.push(this.bluetoothDiscovery.discover(timeout));
    }

    if (discoveryTypes.includes(PrinterType.USB)) {
      discoveryPromises.push(this.usbDiscovery.discover(timeout));
    }

    const results = await Promise.allSettled(discoveryPromises);
    const allPrinters: DiscoveredPrinter[] = [];

    for (const result of results) {
      if (result.status === 'fulfilled') {
        for (const printer of result.value) {
          // Mark as configured if address matches
          printer.isConfigured = configuredAddresses.has(printer.address);
          allPrinters.push(printer);
        }
      }
    }

    this.emit(PrinterManagerEvent.DISCOVERY_COMPLETED, allPrinters);
    return allPrinters;
  }

  /**
   * Get address string from printer config for comparison
   */
  private getAddressFromConfig(config: PrinterConfig): string {
    const details = config.connectionDetails;
    if (isNetworkConnectionDetails(details)) {
      return details.ip;
    } else if (isBluetoothConnectionDetails(details)) {
      return details.address;
    } else if (isUSBConnectionDetails(details)) {
      return `${details.vendorId}:${details.productId}`;
    }
    return '';
  }


  // ==========================================================================
  // Configuration Methods (Task 12.2)
  // ==========================================================================

  /**
   * Add a new printer configuration
   * @param config - Printer configuration (without id, createdAt, updatedAt)
   * @returns The saved printer configuration with generated id
   *
   * Requirements: 8.1
   */
  async addPrinter(
    config: Omit<PrinterConfig, 'id' | 'createdAt' | 'updatedAt'>
  ): Promise<PrinterConfig> {
    // Validate configuration
    const validationResult = validatePrinterConfig({
      ...config,
      id: 'temp-id', // Provide temp ID for validation
      createdAt: new Date(),
      updatedAt: new Date(),
    } as PrinterConfig);
    if (!validationResult.valid) {
      throw new Error(`Invalid printer configuration: ${validationResult.errors.join(', ')}`);
    }

    // Check for duplicate name
    if (this.configStore.nameExists(config.name)) {
      throw new Error(`A printer with name "${config.name}" already exists`);
    }

    // Save configuration
    const savedConfig = this.configStore.save(config);

    // Initialize status
    this.printerStatuses.set(savedConfig.id, {
      printerId: savedConfig.id,
      state: PrinterState.OFFLINE,
      lastSeen: new Date(),
      queueLength: 0,
    });

    // Set up routing if enabled
    if (savedConfig.enabled) {
      const jobType = this.roleToJobType(savedConfig.role);
      if (jobType) {
        this.jobRouter.setRouting(jobType, savedConfig.id);
      }

      if (savedConfig.fallbackPrinterId) {
        this.jobRouter.setFallback(savedConfig.id, savedConfig.fallbackPrinterId);
      }

      if (savedConfig.isDefault) {
        this.jobRouter.setDefaultPrinter(savedConfig.id);
      }
    }

    // Try to connect to the printer
    if (savedConfig.enabled && this.options.autoConnect) {
      try {
        await this.connectToPrinter(savedConfig);
      } catch (error) {
        console.warn(`[PrinterManager] Could not connect to new printer ${savedConfig.name}:`, error);
      }
    }

    this.emit(PrinterManagerEvent.PRINTER_ADDED, savedConfig);
    return savedConfig;
  }

  /**
   * Update an existing printer configuration
   * @param printerId - The printer ID to update
   * @param updates - Partial configuration updates
   * @returns The updated printer configuration
   *
   * Requirements: 8.3
   */
  async updatePrinter(
    printerId: string,
    updates: Partial<Omit<PrinterConfig, 'id' | 'createdAt'>>
  ): Promise<PrinterConfig> {
    const existing = this.configStore.load(printerId);
    if (!existing) {
      throw new Error(`Printer with ID "${printerId}" not found`);
    }

    // Check for duplicate name if name is being changed
    if (updates.name && updates.name !== existing.name) {
      if (this.configStore.nameExists(updates.name, printerId)) {
        throw new Error(`A printer with name "${updates.name}" already exists`);
      }
    }

    // Validate merged configuration
    const mergedConfig = { ...existing, ...updates };
    const validationResult = validatePrinterConfig(mergedConfig);
    if (!validationResult.valid) {
      throw new Error(`Invalid printer configuration: ${validationResult.errors.join(', ')}`);
    }

    // Disconnect if connection details changed
    const connectionChanged = updates.connectionDetails !== undefined;
    if (connectionChanged && this.transports.has(printerId)) {
      await this.disconnectFromPrinter(printerId);
    }

    // Update configuration
    const updatedConfig = this.configStore.update(printerId, updates);
    if (!updatedConfig) {
      throw new Error(`Failed to update printer ${printerId}`);
    }

    // Update routing
    this.updateRouting(updatedConfig);

    // Reconnect if connection details changed and printer is enabled
    if (connectionChanged && updatedConfig.enabled && this.options.autoConnect) {
      try {
        await this.connectToPrinter(updatedConfig);
      } catch (error) {
        console.warn(`[PrinterManager] Could not reconnect to printer ${updatedConfig.name}:`, error);
      }
    }

    this.emit(PrinterManagerEvent.PRINTER_UPDATED, updatedConfig);
    return updatedConfig;
  }

  /**
   * Remove a printer configuration
   * @param printerId - The printer ID to remove
   * @returns true if removed successfully
   *
   * Requirements: 8.4
   */
  async removePrinter(printerId: string): Promise<boolean> {
    const existing = this.configStore.load(printerId);
    if (!existing) {
      return false;
    }

    // Disconnect if connected
    if (this.transports.has(printerId)) {
      await this.disconnectFromPrinter(printerId);
    }

    // Stop monitoring
    this.statusMonitor.stopMonitoring(printerId);

    // Remove from routing
    this.removeFromRouting(printerId);

    // Delete configuration
    const deleted = this.configStore.delete(printerId);

    // Remove status
    this.printerStatuses.delete(printerId);

    if (deleted) {
      this.emit(PrinterManagerEvent.PRINTER_REMOVED, printerId);
    }

    return deleted;
  }

  /**
   * Get all printer configurations
   * @returns Array of all printer configurations
   *
   * Requirements: 8.2
   */
  getPrinters(): PrinterConfig[] {
    return this.configStore.getAll();
  }

  /**
   * Get a specific printer configuration
   * @param printerId - The printer ID
   * @returns The printer configuration or null if not found
   */
  getPrinter(printerId: string): PrinterConfig | null {
    return this.configStore.load(printerId);
  }

  /**
   * Get printers by role
   * @param role - The printer role
   * @returns Array of printers with the specified role
   */
  getPrintersByRole(role: PrinterRole): PrinterConfig[] {
    return this.configStore.getByRole(role);
  }

  /**
   * Update routing for a printer
   */
  private updateRouting(config: PrinterConfig): void {
    const jobType = this.roleToJobType(config.role);

    if (config.enabled && jobType) {
      this.jobRouter.setRouting(jobType, config.id);
    } else if (jobType) {
      // Check if this printer was the one routed for this job type
      const currentRouting = this.jobRouter.getRoutingForType(jobType);
      if (currentRouting === config.id) {
        this.jobRouter.removeRouting(jobType);
      }
    }

    // Update fallback
    if (config.fallbackPrinterId) {
      this.jobRouter.setFallback(config.id, config.fallbackPrinterId);
    } else {
      this.jobRouter.removeFallback(config.id);
    }

    // Update default
    if (config.isDefault) {
      this.jobRouter.setDefaultPrinter(config.id);
    }
  }

  /**
   * Remove a printer from all routing
   */
  private removeFromRouting(printerId: string): void {
    // Remove from job type routing
    const routing = this.jobRouter.getRouting();
    for (const [jobType, routedPrinterId] of routing) {
      if (routedPrinterId === printerId) {
        this.jobRouter.removeRouting(jobType);
      }
    }

    // Remove from category routing
    const categoryRouting = this.jobRouter.getCategoryRouting();
    for (const [category, routedPrinterId] of categoryRouting) {
      if (routedPrinterId === printerId) {
        this.jobRouter.removeCategoryRouting(category);
      }
    }

    // Remove fallback
    this.jobRouter.removeFallback(printerId);

    // Clear default if this was the default
    if (this.jobRouter.getDefaultPrinter() === printerId) {
      this.jobRouter.setDefaultPrinter('');
    }
  }

  /**
   * Convert printer role to job type
   */
  private roleToJobType(role: PrinterRole): PrintJobType | null {
    switch (role) {
      case PrinterRole.RECEIPT:
        return PrintJobType.RECEIPT;
      case PrinterRole.KITCHEN:
        return PrintJobType.KITCHEN_TICKET;
      case PrinterRole.BAR:
        return PrintJobType.KITCHEN_TICKET;
      case PrinterRole.LABEL:
        return PrintJobType.LABEL;
      default:
        return null;
    }
  }


  // ==========================================================================
  // Print Job Methods (Task 12.3)
  // ==========================================================================

  /**
   * Submit a print job for processing
   * @param job - The print job to submit
   * @returns The result of job submission
   *
   * Requirements: 6.1, 6.2, 9.2
   */
  async submitPrintJob(job: PrintJob): Promise<PrintJobResult> {
    try {
      // Ensure job has an ID
      const jobWithId: PrintJob = {
        ...job,
        id: job.id || uuidv4(),
        createdAt: job.createdAt || new Date(),
      };

      // Route the job (with potential splitting for kitchen tickets)
      const routingResults = this.jobRouter.routeJobWithSplitting(jobWithId);

      const results: PrintJobResult[] = [];

      for (const { job: routedJob, routing } of routingResults) {
        // Enqueue the job
        const queuedJobId = this.queueService.enqueue(routedJob, routing.printerId);

        results.push({
          success: true,
          jobId: queuedJobId,
          printerId: routing.printerId,
        });

        this.emit(PrinterManagerEvent.JOB_SUBMITTED, {
          jobId: queuedJobId,
          printerId: routing.printerId,
          usedFallback: routing.usedFallback,
        });
      }

      // Return the first result (or aggregate for split jobs)
      if (results.length === 1) {
        return results[0];
      }

      return {
        success: true,
        jobId: jobWithId.id,
        printerId: results.map((r) => r.printerId).join(','),
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        jobId: job.id || '',
        error: errorMessage,
      };
    }
  }

  /**
   * Cancel a print job
   * @param jobId - The job ID to cancel
   * @returns true if cancelled successfully
   *
   * Requirements: 6.4
   */
  async cancelPrintJob(jobId: string): Promise<boolean> {
    const job = this.queueService.getJob(jobId);
    if (!job) {
      return false;
    }

    // Can only cancel pending jobs
    if (job.status !== QueuedJobStatus.PENDING) {
      throw new Error(`Cannot cancel job in ${job.status} status`);
    }

    return this.queueService.removeJob(jobId);
  }

  /**
   * Retry a failed print job
   * @param jobId - The job ID to retry
   * @returns The result of the retry
   *
   * Requirements: 6.3
   */
  async retryPrintJob(jobId: string): Promise<PrintJobResult> {
    const job = this.queueService.getJob(jobId);
    if (!job) {
      return {
        success: false,
        jobId,
        error: 'Job not found',
      };
    }

    // Reset retry count and status
    this.queueService.incrementRetry(jobId);

    return {
      success: true,
      jobId,
      printerId: job.printerId,
    };
  }

  // ==========================================================================
  // Job Processing Loop
  // ==========================================================================

  /**
   * Start the job processing loop
   */
  startJobProcessing(): void {
    if (this.processingTimer) return;

    this.processingTimer = setInterval(() => {
      this.processNextJob();
    }, this.options.processingInterval);
  }

  /**
   * Stop the job processing loop
   */
  stopJobProcessing(): void {
    if (this.processingTimer) {
      clearInterval(this.processingTimer);
      this.processingTimer = undefined;
    }
  }

  /**
   * Process the next job in the queue
   */
  private async processNextJob(): Promise<void> {
    if (this.isProcessing) return;

    this.isProcessing = true;

    try {
      // Get enabled printers
      const enabledPrinters = this.configStore.getEnabled();

      for (const printer of enabledPrinters) {
        // Check if printer is online
        const status = this.printerStatuses.get(printer.id);
        if (!status || status.state !== PrinterState.ONLINE) {
          continue;
        }

        // Get next job for this printer
        const job = this.queueService.dequeue(printer.id);
        if (!job) continue;

        this.emit(PrinterManagerEvent.JOB_STARTED, job);

        try {
          await this.executeJob(job, printer);
          this.queueService.markComplete(job.id);
          this.emit(PrinterManagerEvent.JOB_COMPLETED, job);
        } catch (error) {
          await this.handleJobFailure(job, error);
        }
      }
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Execute a print job
   */
  private async executeJob(job: QueuedJob, printer: PrinterConfig): Promise<void> {
    const transport = this.transports.get(printer.id);
    if (!transport || !transport.isConnected()) {
      throw new Error('Printer not connected');
    }

    // Generate ESC/POS data
    let printData: Buffer;

    if (isRawEscPosData(job.data)) {
      printData = job.data.buffer;
    } else {
      printData = this.generatePrintData(job, printer);
    }

    // Send to printer
    await transport.send(printData);
  }

  /**
   * Generate print data from job
   */
  private generatePrintData(job: QueuedJob, printer: PrinterConfig): Buffer {
    this.receiptGenerator.setConfig({ paperSize: printer.paperSize });

    switch (job.type) {
      case PrintJobType.RECEIPT:
        return this.receiptGenerator.generateReceipt(job.data as any);
      case PrintJobType.KITCHEN_TICKET:
        return this.receiptGenerator.generateKitchenTicket(job.data as any);
      case PrintJobType.TEST:
        return this.receiptGenerator.generateTestPrint(printer.name);
      default:
        // For other types, create a simple text print
        const builder = new EscPosBuilder(printer.paperSize);
        builder.initialize().textLine(JSON.stringify(job.data)).cut();
        return builder.build();
    }
  }

  /**
   * Handle job failure with retry logic
   *
   * Requirements: 6.3
   */
  private async handleJobFailure(job: QueuedJob, error: unknown): Promise<void> {
    const errorMessage = error instanceof Error ? error.message : String(error);
    this.queueService.setLastError(job.id, errorMessage);

    if (job.retryCount < MAX_RETRY_ATTEMPTS) {
      // Retry the job
      const newRetryCount = this.queueService.incrementRetry(job.id);
      this.emit(PrinterManagerEvent.JOB_RETRYING, {
        job,
        retryCount: newRetryCount,
        error: errorMessage,
      });
    } else {
      // Mark as failed
      this.queueService.markFailed(job.id, errorMessage);
      this.emit(PrinterManagerEvent.JOB_FAILED, {
        job,
        error: errorMessage,
      });
    }
  }

  // ==========================================================================
  // Transport Management
  // ==========================================================================

  /**
   * Connect to a printer
   */
  private async connectToPrinter(config: PrinterConfig): Promise<void> {
    // Create appropriate transport
    const transport = this.createTransport(config);

    // Set up event handlers
    transport.onDisconnect(() => {
      this.handlePrinterDisconnect(config.id);
    });

    transport.onError((error) => {
      this.handlePrinterError(config.id, error);
    });

    // Connect
    await transport.connect();

    // Store transport
    this.transports.set(config.id, transport);

    // Update status
    this.updatePrinterStatus(config.id, PrinterState.ONLINE);

    // Start monitoring
    this.statusMonitor.startMonitoring(config.id);
  }

  /**
   * Disconnect from a printer
   */
  private async disconnectFromPrinter(printerId: string): Promise<void> {
    const transport = this.transports.get(printerId);
    if (transport) {
      await transport.disconnect();
      this.transports.delete(printerId);
    }

    this.statusMonitor.stopMonitoring(printerId);
    this.updatePrinterStatus(printerId, PrinterState.OFFLINE);
  }

  /**
   * Create a transport for a printer configuration
   */
  private createTransport(config: PrinterConfig): IPrinterTransport {
    const details = config.connectionDetails;

    if (isNetworkConnectionDetails(details)) {
      return new NetworkTransport(details);
    } else if (isBluetoothConnectionDetails(details)) {
      return new BluetoothTransport(details);
    } else if (isUSBConnectionDetails(details)) {
      return new USBTransport(details);
    }

    throw new Error(`Unsupported connection type: ${(details as any).type}`);
  }

  /**
   * Handle printer disconnect
   */
  private handlePrinterDisconnect(printerId: string): void {
    this.updatePrinterStatus(printerId, PrinterState.OFFLINE);
    this.transports.delete(printerId);
  }

  /**
   * Handle printer error
   */
  private handlePrinterError(printerId: string, error: any): void {
    const errorCode = error.code || PrinterErrorCode.UNKNOWN;
    const errorMessage = error.message || getErrorMessage(errorCode);

    this.statusMonitor.updatePrinterState(printerId, PrinterState.ERROR, errorCode, errorMessage);
    this.emit(PrinterManagerEvent.ERROR, { printerId, error });
  }

  /**
   * Update printer status
   */
  private updatePrinterStatus(printerId: string, state: PrinterState): void {
    const currentStatus = this.printerStatuses.get(printerId);
    const newStatus: PrinterStatus = {
      printerId,
      state,
      lastSeen: new Date(),
      queueLength: this.getQueueLength(printerId),
      errorCode: currentStatus?.errorCode,
      errorMessage: currentStatus?.errorMessage,
    };

    if (state === PrinterState.ONLINE || state === PrinterState.OFFLINE) {
      delete newStatus.errorCode;
      delete newStatus.errorMessage;
    }

    this.printerStatuses.set(printerId, newStatus);
    this.emit(PrinterManagerEvent.PRINTER_STATUS_CHANGED, printerId, newStatus);
  }


  // ==========================================================================
  // Status Methods
  // ==========================================================================

  /**
   * Get the status of a specific printer
   * @param printerId - The printer ID
   * @returns The printer status
   */
  getPrinterStatus(printerId: string): PrinterStatus | null {
    return this.printerStatuses.get(printerId) || null;
  }

  /**
   * Get all printer statuses
   * @returns Map of printer IDs to their statuses
   */
  getAllPrinterStatuses(): Map<string, PrinterStatus> {
    return new Map(this.printerStatuses);
  }

  /**
   * Register a callback for status changes
   * @param callback - Function to call when status changes
   */
  onStatusChange(callback: (printerId: string, status: PrinterStatus) => void): void {
    this.on(PrinterManagerEvent.PRINTER_STATUS_CHANGED, callback);
  }

  // ==========================================================================
  // PrinterStatusProvider Implementation (for JobRouter)
  // ==========================================================================

  /**
   * Get printer config (for JobRouter)
   */
  getPrinterConfig(printerId: string): PrinterConfig | null {
    return this.configStore.load(printerId);
  }

  // ==========================================================================
  // StatusCheckProvider Implementation (for StatusMonitor)
  // ==========================================================================

  /**
   * Check printer status (for StatusMonitor)
   */
  async checkPrinterStatus(printerId: string): Promise<PrinterStatus> {
    const transport = this.transports.get(printerId);
    const config = this.configStore.load(printerId);

    if (!config) {
      return {
        printerId,
        state: PrinterState.OFFLINE,
        lastSeen: new Date(),
        queueLength: 0,
      };
    }

    let state: PrinterState;
    let errorCode: PrinterErrorCode | undefined;
    let errorMessage: string | undefined;

    if (!transport) {
      state = PrinterState.OFFLINE;
    } else if (!transport.isConnected()) {
      state = PrinterState.OFFLINE;
    } else {
      const transportStatus = transport.getStatus();
      if (transportStatus.lastError) {
        state = PrinterState.ERROR;
        errorCode = PrinterErrorCode.UNKNOWN;
        errorMessage = transportStatus.lastError;
      } else {
        state = PrinterState.ONLINE;
      }
    }

    return {
      printerId,
      state,
      errorCode,
      errorMessage,
      lastSeen: new Date(),
      queueLength: this.getQueueLength(printerId),
    };
  }

  // ==========================================================================
  // QueueLengthProvider Implementation (for StatusMonitor)
  // ==========================================================================

  /**
   * Get queue length for a printer (for StatusMonitor)
   */
  getQueueLength(printerId: string): number {
    return this.queueService.getQueueLength(printerId, QueuedJobStatus.PENDING);
  }

  // ==========================================================================
  // Test Print and Diagnostics
  // ==========================================================================

  /**
   * Send a test print to a printer
   * @param printerId - The printer ID
   * @returns The test print result
   *
   * Requirements: 10.1, 10.2
   */
  async testPrint(printerId: string): Promise<TestPrintResult> {
    const config = this.configStore.load(printerId);
    if (!config) {
      return {
        success: false,
        printerId,
        error: 'Printer not found',
      };
    }

    const startTime = Date.now();

    try {
      // Create test print job
      const testJob: PrintJob = {
        id: uuidv4(),
        type: PrintJobType.TEST,
        data: {} as any,
        priority: 10, // High priority
        createdAt: new Date(),
      };

      // Generate test print data
      const printData = this.receiptGenerator.generateTestPrint(config.name);

      // Get or create transport
      let transport = this.transports.get(printerId);
      if (!transport || !transport.isConnected()) {
        // Try to connect
        await this.connectToPrinter(config);
        transport = this.transports.get(printerId);
      }

      if (!transport || !transport.isConnected()) {
        return {
          success: false,
          printerId,
          error: 'Could not connect to printer',
        };
      }

      // Send test print
      await transport.send(printData);

      const latencyMs = Date.now() - startTime;

      return {
        success: true,
        printerId,
        latencyMs,
      };
    } catch (error) {
      return {
        success: false,
        printerId,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Get diagnostics for a printer
   * @param printerId - The printer ID
   * @returns Printer diagnostics
   *
   * Requirements: 10.2, 10.5
   */
  async getDiagnostics(printerId: string): Promise<PrinterDiagnostics> {
    const config = this.configStore.load(printerId);
    if (!config) {
      throw new Error('Printer not found');
    }

    const transport = this.transports.get(printerId);
    let connectionLatencyMs: number | undefined;

    if (transport && transport.isConnected()) {
      // Measure latency with a simple status check
      const startTime = Date.now();
      try {
        await transport.getStatus();
        connectionLatencyMs = Date.now() - startTime;
      } catch {
        // Ignore errors
      }
    }

    // Get recent job statistics from the queue service
    // Requirements: 10.5 - Display recent print job history with success/failure status
    const recentJobs = this.queueService.getRecentJobStats(printerId);

    return {
      printerId,
      connectionType: config.type,
      connectionLatencyMs,
      recentJobs,
    };
  }

  // ==========================================================================
  // Routing Configuration
  // ==========================================================================

  /**
   * Set routing for a job type
   */
  setRouting(jobType: PrintJobType, printerId: string): void {
    this.jobRouter.setRouting(jobType, printerId);
  }

  /**
   * Set category routing for kitchen items
   */
  setCategoryRouting(category: string, printerId: string): void {
    this.jobRouter.setCategoryRouting(category, printerId);
  }

  /**
   * Set fallback printer
   */
  setFallback(primaryPrinterId: string, fallbackPrinterId: string): void {
    this.jobRouter.setFallback(primaryPrinterId, fallbackPrinterId);
  }

  /**
   * Get routing configuration
   */
  getRoutingConfig(): {
    routing: RoutingEntry[];
    categoryRouting: CategoryRoutingEntry[];
    fallbacks: FallbackEntry[];
    defaultPrinterId: string | null;
  } {
    return this.jobRouter.exportConfig();
  }

  /**
   * Import routing configuration
   */
  importRoutingConfig(config: {
    routing?: RoutingEntry[];
    categoryRouting?: CategoryRoutingEntry[];
    fallbacks?: FallbackEntry[];
    defaultPrinterId?: string | null;
  }): void {
    this.jobRouter.importConfig(config);
  }

  // ==========================================================================
  // Settings Export/Import
  // ==========================================================================

  /**
   * Export all printer settings
   *
   * Requirements: 8.5
   */
  exportSettings(): {
    printers: any[];
    routing: any;
  } {
    return {
      printers: this.configStore.exportAll(),
      routing: this.jobRouter.exportConfig(),
    };
  }

  /**
   * Import printer settings
   *
   * Requirements: 8.5
   */
  importSettings(
    settings: { printers?: any[]; routing?: any },
    replace: boolean = false
  ): { printersImported: number } {
    let printersImported = 0;

    if (settings.printers) {
      printersImported = this.configStore.importAll(settings.printers, replace);
    }

    if (settings.routing) {
      this.jobRouter.importConfig(settings.routing);
    }

    return { printersImported };
  }
}
