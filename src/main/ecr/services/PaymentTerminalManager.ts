/**
 * Payment Terminal Manager
 *
 * Central orchestrator for ECR operations including device discovery,
 * configuration, connection management, and transaction processing.
 *
 * @module ecr/services/PaymentTerminalManager
 */

import { EventEmitter } from 'events';
import type Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import type {
  ECRDevice,
  ECRTransactionRequest,
  ECRTransactionResponse,
  ECRDeviceStatus,
  ECRSettlementResult,
  DiscoveredECRDevice,
} from '../../../../../shared/types/ecr';
import {
  ECRDeviceType,
  ECRConnectionType,
  ECRProtocol,
  ECRTransactionType,
  ECRTransactionStatus,
  ECRDeviceState,
} from '../../../../../shared/types/ecr';
import { ECRConfigStore } from './ECRConfigStore';
import { TransactionLogService, type TransactionFilters } from './TransactionLogService';
import { PaymentTerminalService, PaymentTerminalServiceEvent } from './PaymentTerminalService';
import { SerialDiscovery, BluetoothDiscovery } from '../discovery';

/**
 * Events emitted by PaymentTerminalManager
 */
export enum PaymentTerminalManagerEvent {
  DEVICE_ADDED = 'device-added',
  DEVICE_UPDATED = 'device-updated',
  DEVICE_REMOVED = 'device-removed',
  DEVICE_CONNECTED = 'device-connected',
  DEVICE_DISCONNECTED = 'device-disconnected',
  DEVICE_STATUS_CHANGED = 'device-status-changed',
  TRANSACTION_STARTED = 'transaction-started',
  TRANSACTION_STATUS = 'transaction-status',
  TRANSACTION_COMPLETED = 'transaction-completed',
  DISPLAY_MESSAGE = 'display-message',
  PRINT_RECEIPT = 'print-receipt',
  DISCOVERY_STARTED = 'discovery-started',
  DISCOVERY_COMPLETED = 'discovery-completed',
  ERROR = 'error',
}

/**
 * Manager options
 */
export interface PaymentTerminalManagerOptions {
  /** Auto-connect to enabled terminals on initialization */
  autoConnect?: boolean;
  /** Polling interval for status checks (ms) */
  statusCheckInterval?: number;
}

/**
 * Default options
 */
const DEFAULT_OPTIONS: Required<PaymentTerminalManagerOptions> = {
  autoConnect: true,
  statusCheckInterval: 30000, // 30 seconds
};

/**
 * PaymentTerminalManager - Main orchestrator for ECR operations
 */
export class PaymentTerminalManager extends EventEmitter {
  private db: Database.Database;
  private options: Required<PaymentTerminalManagerOptions>;
  private configStore: ECRConfigStore;
  private transactionLog: TransactionLogService;
  private terminalService: PaymentTerminalService;
  private serialDiscovery: SerialDiscovery;
  private bluetoothDiscovery: BluetoothDiscovery;
  private deviceStatuses: Map<string, ECRDeviceStatus> = new Map();
  private statusCheckTimer?: NodeJS.Timeout;
  private initialized: boolean = false;

  constructor(db: Database.Database, options?: PaymentTerminalManagerOptions) {
    super();
    this.db = db;
    this.options = { ...DEFAULT_OPTIONS, ...options };

    // Initialize services
    this.configStore = new ECRConfigStore(db);
    this.transactionLog = new TransactionLogService(db);
    this.terminalService = new PaymentTerminalService(this.transactionLog);
    this.serialDiscovery = new SerialDiscovery();
    this.bluetoothDiscovery = new BluetoothDiscovery();

    // Forward terminal service events
    this.setupEventForwarding();
  }

  /**
   * Initialize the manager
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    // Initialize config store
    this.configStore.initialize();

    // Auto-connect to enabled terminals
    if (this.options.autoConnect) {
      await this.connectToEnabledDevices();
    }

    // Start status monitoring
    this.startStatusMonitoring();

    this.initialized = true;
  }

  /**
   * Shutdown the manager
   */
  async shutdown(): Promise<void> {
    this.stopStatusMonitoring();
    await this.terminalService.disconnectAll();
    this.removeAllListeners();
    this.initialized = false;
  }

  // =========================================================================
  // Device Discovery
  // =========================================================================

  /**
   * Discover available ECR devices
   */
  async discoverDevices(
    connectionTypes?: ECRConnectionType[],
    timeout: number = 10000
  ): Promise<DiscoveredECRDevice[]> {
    this.emit(PaymentTerminalManagerEvent.DISCOVERY_STARTED, connectionTypes);

    const types = connectionTypes || [ECRConnectionType.SERIAL_USB, ECRConnectionType.BLUETOOTH];
    const discoveryPromises: Promise<DiscoveredECRDevice[]>[] = [];

    // Get configured device addresses to mark as configured
    const configuredAddresses = new Set(
      this.configStore.getAll().map((d) => this.getDeviceAddress(d))
    );

    if (types.includes(ECRConnectionType.SERIAL_USB)) {
      discoveryPromises.push(this.serialDiscovery.discover(timeout));
    }

    if (types.includes(ECRConnectionType.BLUETOOTH)) {
      discoveryPromises.push(this.bluetoothDiscovery.discover(timeout));
    }

    const results = await Promise.allSettled(discoveryPromises);
    const allDevices: DiscoveredECRDevice[] = [];

    for (const result of results) {
      if (result.status === 'fulfilled') {
        for (const device of result.value) {
          const address = this.getDiscoveredDeviceAddress(device);
          device.isConfigured = configuredAddresses.has(address);
          allDevices.push(device);
        }
      }
    }

    this.emit(PaymentTerminalManagerEvent.DISCOVERY_COMPLETED, allDevices);
    return allDevices;
  }

  // =========================================================================
  // Device Configuration
  // =========================================================================

  /**
   * Add a new device configuration
   */
  addDevice(
    config: Omit<ECRDevice, 'id' | 'createdAt' | 'updatedAt'>
  ): ECRDevice {
    const device = this.configStore.save(config);

    // Initialize status
    this.deviceStatuses.set(device.id, {
      deviceId: device.id,
      state: ECRDeviceState.DISCONNECTED,
      isOnline: false,
    });

    this.emit(PaymentTerminalManagerEvent.DEVICE_ADDED, device);

    // Auto-connect if enabled
    if (device.enabled && this.options.autoConnect) {
      this.connectDevice(device.id).catch((error) => {
        console.warn(`[PaymentTerminalManager] Failed to connect to ${device.name}:`, error);
      });
    }

    return device;
  }

  /**
   * Update a device configuration
   */
  updateDevice(
    deviceId: string,
    updates: Partial<Omit<ECRDevice, 'id' | 'createdAt'>>
  ): ECRDevice | null {
    const existing = this.configStore.load(deviceId);
    if (!existing) return null;

    // Disconnect if connection details changed
    const connectionChanged = updates.connectionDetails !== undefined;
    if (connectionChanged && this.terminalService.isConnected(deviceId)) {
      this.terminalService.disconnect(deviceId).catch(() => {});
    }

    const updated = this.configStore.update(deviceId, updates);

    if (updated) {
      this.emit(PaymentTerminalManagerEvent.DEVICE_UPDATED, updated);

      // Reconnect if needed
      if (connectionChanged && updated.enabled && this.options.autoConnect) {
        this.connectDevice(deviceId).catch(() => {});
      }
    }

    return updated;
  }

  /**
   * Remove a device configuration
   */
  async removeDevice(deviceId: string): Promise<boolean> {
    // Disconnect first
    await this.terminalService.disconnect(deviceId);

    // Remove config
    const deleted = this.configStore.delete(deviceId);

    if (deleted) {
      this.deviceStatuses.delete(deviceId);
      this.emit(PaymentTerminalManagerEvent.DEVICE_REMOVED, deviceId);
    }

    return deleted;
  }

  /**
   * Get all device configurations
   */
  getDevices(): ECRDevice[] {
    return this.configStore.getAll();
  }

  /**
   * Get a specific device configuration
   */
  getDevice(deviceId: string): ECRDevice | null {
    return this.configStore.load(deviceId);
  }

  /**
   * Get payment terminals
   */
  getPaymentTerminals(): ECRDevice[] {
    return this.configStore.getByType(ECRDeviceType.PAYMENT_TERMINAL);
  }

  /**
   * Get the default payment terminal
   */
  getDefaultTerminal(): ECRDevice | null {
    return this.configStore.getDefaultTerminal();
  }

  // =========================================================================
  // Connection Management
  // =========================================================================

  /**
   * Connect to a device
   */
  async connectDevice(deviceId: string): Promise<void> {
    const device = this.configStore.load(deviceId);
    if (!device) {
      throw new Error(`Device ${deviceId} not found`);
    }

    await this.terminalService.connect(device);

    // Update status
    const status = await this.terminalService.getStatus(deviceId);
    this.deviceStatuses.set(deviceId, status);
    this.emit(PaymentTerminalManagerEvent.DEVICE_STATUS_CHANGED, deviceId, status);
  }

  /**
   * Disconnect from a device
   */
  async disconnectDevice(deviceId: string): Promise<void> {
    await this.terminalService.disconnect(deviceId);

    // Update status
    const status: ECRDeviceStatus = {
      deviceId,
      state: ECRDeviceState.DISCONNECTED,
      isOnline: false,
    };
    this.deviceStatuses.set(deviceId, status);
    this.emit(PaymentTerminalManagerEvent.DEVICE_STATUS_CHANGED, deviceId, status);
  }

  /**
   * Check if a device is connected
   */
  isDeviceConnected(deviceId: string): boolean {
    return this.terminalService.isConnected(deviceId);
  }

  /**
   * Get device status
   */
  getDeviceStatus(deviceId: string): ECRDeviceStatus | null {
    return this.deviceStatuses.get(deviceId) ?? null;
  }

  /**
   * Get all device statuses
   */
  getAllDeviceStatuses(): Map<string, ECRDeviceStatus> {
    return new Map(this.deviceStatuses);
  }

  // =========================================================================
  // Transactions
  // =========================================================================

  /**
   * Process a card payment
   */
  async processPayment(
    amount: number,
    options: {
      deviceId?: string;
      orderId?: string;
      tipAmount?: number;
      currency?: string;
      reference?: string;
    } = {}
  ): Promise<ECRTransactionResponse> {
    // Get terminal to use
    const deviceId = options.deviceId ?? this.configStore.getDefaultTerminal()?.id;
    if (!deviceId) {
      throw new Error('No payment terminal available');
    }

    // Ensure connected
    if (!this.terminalService.isConnected(deviceId)) {
      await this.connectDevice(deviceId);
    }

    // Build transaction request
    const request: ECRTransactionRequest = {
      transactionId: uuidv4(),
      type: ECRTransactionType.SALE,
      amount,
      currency: options.currency ?? 'EUR',
      orderId: options.orderId,
      tipAmount: options.tipAmount,
      reference: options.reference,
    };

    return this.terminalService.processTransaction(deviceId, request);
  }

  /**
   * Process a refund
   */
  async processRefund(
    amount: number,
    options: {
      deviceId?: string;
      orderId?: string;
      originalTransactionId?: string;
      currency?: string;
    } = {}
  ): Promise<ECRTransactionResponse> {
    const deviceId = options.deviceId ?? this.configStore.getDefaultTerminal()?.id;
    if (!deviceId) {
      throw new Error('No payment terminal available');
    }

    if (!this.terminalService.isConnected(deviceId)) {
      await this.connectDevice(deviceId);
    }

    const request: ECRTransactionRequest = {
      transactionId: uuidv4(),
      type: ECRTransactionType.REFUND,
      amount,
      currency: options.currency ?? 'EUR',
      orderId: options.orderId,
      originalTransactionId: options.originalTransactionId,
    };

    return this.terminalService.processTransaction(deviceId, request);
  }

  /**
   * Void a transaction
   */
  async voidTransaction(
    transactionId: string,
    deviceId?: string
  ): Promise<ECRTransactionResponse> {
    // Get original transaction
    const original = this.transactionLog.getById(transactionId);
    if (!original) {
      throw new Error('Original transaction not found');
    }

    const targetDeviceId = deviceId ?? original.deviceId;

    if (!this.terminalService.isConnected(targetDeviceId)) {
      await this.connectDevice(targetDeviceId);
    }

    const request: ECRTransactionRequest = {
      transactionId: uuidv4(),
      type: ECRTransactionType.VOID,
      amount: original.amount,
      currency: original.currency,
      originalTransactionId: transactionId,
      orderId: original.orderId,
    };

    return this.terminalService.processTransaction(targetDeviceId, request);
  }

  /**
   * Cancel ongoing transaction
   */
  async cancelTransaction(deviceId: string): Promise<void> {
    await this.terminalService.cancelTransaction(deviceId);
  }

  /**
   * Perform end-of-day settlement
   */
  async settlement(deviceId?: string): Promise<ECRSettlementResult> {
    const targetDeviceId = deviceId ?? this.configStore.getDefaultTerminal()?.id;
    if (!targetDeviceId) {
      throw new Error('No payment terminal available');
    }

    if (!this.terminalService.isConnected(targetDeviceId)) {
      await this.connectDevice(targetDeviceId);
    }

    return this.terminalService.settlement(targetDeviceId);
  }

  // =========================================================================
  // Transaction History
  // =========================================================================

  /**
   * Get recent transactions
   */
  getRecentTransactions(limit: number = 20) {
    return this.transactionLog.getRecent(limit);
  }

  /**
   * Query transactions
   */
  queryTransactions(filters: TransactionFilters) {
    return this.transactionLog.query(filters);
  }

  /**
   * Get transaction statistics
   */
  getTransactionStats(filters?: Omit<TransactionFilters, 'limit' | 'offset'>) {
    return this.transactionLog.getStats(filters);
  }

  /**
   * Get transaction for order
   */
  getTransactionForOrder(orderId: string) {
    return this.transactionLog.getApprovedForOrder(orderId);
  }

  // =========================================================================
  // Private Methods
  // =========================================================================

  /**
   * Connect to all enabled devices
   */
  private async connectToEnabledDevices(): Promise<void> {
    const devices = this.configStore.getEnabled();

    for (const device of devices) {
      if (device.deviceType === ECRDeviceType.PAYMENT_TERMINAL) {
        try {
          await this.connectDevice(device.id);
        } catch (error) {
          console.warn(`[PaymentTerminalManager] Failed to connect to ${device.name}:`, error);
        }
      }
    }
  }

  /**
   * Start status monitoring
   */
  private startStatusMonitoring(): void {
    if (this.statusCheckTimer) return;

    this.statusCheckTimer = setInterval(async () => {
      const connectedIds = this.terminalService.getConnectedDevices();

      for (const deviceId of connectedIds) {
        try {
          const status = await this.terminalService.getStatus(deviceId);
          const previous = this.deviceStatuses.get(deviceId);

          if (!previous || previous.state !== status.state) {
            this.deviceStatuses.set(deviceId, status);
            this.emit(PaymentTerminalManagerEvent.DEVICE_STATUS_CHANGED, deviceId, status);
          }
        } catch (error) {
          console.warn(`[PaymentTerminalManager] Status check failed for ${deviceId}:`, error);
        }
      }
    }, this.options.statusCheckInterval);
  }

  /**
   * Stop status monitoring
   */
  private stopStatusMonitoring(): void {
    if (this.statusCheckTimer) {
      clearInterval(this.statusCheckTimer);
      this.statusCheckTimer = undefined;
    }
  }

  /**
   * Set up event forwarding from terminal service
   */
  private setupEventForwarding(): void {
    this.terminalService.on(PaymentTerminalServiceEvent.CONNECTED, (deviceId) => {
      this.emit(PaymentTerminalManagerEvent.DEVICE_CONNECTED, deviceId);
    });

    this.terminalService.on(PaymentTerminalServiceEvent.DISCONNECTED, (deviceId) => {
      this.emit(PaymentTerminalManagerEvent.DEVICE_DISCONNECTED, deviceId);
    });

    this.terminalService.on(PaymentTerminalServiceEvent.TRANSACTION_STARTED, (data) => {
      this.emit(PaymentTerminalManagerEvent.TRANSACTION_STARTED, data);
    });

    this.terminalService.on(PaymentTerminalServiceEvent.TRANSACTION_STATUS, (data) => {
      this.emit(PaymentTerminalManagerEvent.TRANSACTION_STATUS, data);
    });

    this.terminalService.on(PaymentTerminalServiceEvent.TRANSACTION_COMPLETED, (data) => {
      this.emit(PaymentTerminalManagerEvent.TRANSACTION_COMPLETED, data);
    });

    this.terminalService.on(PaymentTerminalServiceEvent.DISPLAY_MESSAGE, (deviceId, message) => {
      this.emit(PaymentTerminalManagerEvent.DISPLAY_MESSAGE, deviceId, message);
    });

    this.terminalService.on(PaymentTerminalServiceEvent.PRINT_RECEIPT, (deviceId, data) => {
      this.emit(PaymentTerminalManagerEvent.PRINT_RECEIPT, deviceId, data);
    });

    this.terminalService.on(PaymentTerminalServiceEvent.ERROR, (deviceId, error) => {
      this.emit(PaymentTerminalManagerEvent.ERROR, deviceId, error);
    });
  }

  /**
   * Get address string from device config
   */
  private getDeviceAddress(device: ECRDevice): string {
    const details = device.connectionDetails;
    switch (details.type) {
      case 'bluetooth':
        return details.address;
      case 'serial_usb':
        return details.port;
      case 'network':
        return `${details.ip}:${details.port}`;
      default:
        return '';
    }
  }

  /**
   * Get address from discovered device
   */
  private getDiscoveredDeviceAddress(device: DiscoveredECRDevice): string {
    const details = device.connectionDetails;
    if ('address' in details && details.address) {
      return details.address;
    }
    if ('ip' in details && details.ip) {
      const port = 'port' in details ? details.port : 20007;
      return `${details.ip}:${port}`;
    }
    if ('port' in details && details.port) {
      return String(details.port);
    }
    return '';
  }
}
