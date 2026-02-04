/**
 * ECR IPC Handlers
 *
 * Electron IPC handlers for ECR device management and payment processing.
 *
 * @module ecr/handlers/ecr-handlers
 */

import { ipcMain, BrowserWindow } from 'electron';
import type { PaymentTerminalManager } from '../services/PaymentTerminalManager';
import { PaymentTerminalManagerEvent } from '../services/PaymentTerminalManager';
import type {
  ECRDevice,
  ECRTransactionResponse,
  ECRSettlementResult,
  DiscoveredECRDevice,
  ECRDeviceStatus,
} from '../../../../../shared/types/ecr';
import {
  ECRConnectionType,
} from '../../../../../shared/types/ecr';

// IPC Channel names
export const ECR_IPC_CHANNELS = {
  // Discovery
  DISCOVER_DEVICES: 'ecr:discover-devices',

  // Device configuration
  GET_DEVICES: 'ecr:get-devices',
  GET_DEVICE: 'ecr:get-device',
  ADD_DEVICE: 'ecr:add-device',
  UPDATE_DEVICE: 'ecr:update-device',
  REMOVE_DEVICE: 'ecr:remove-device',
  GET_DEFAULT_TERMINAL: 'ecr:get-default-terminal',

  // Connection management
  CONNECT_DEVICE: 'ecr:connect-device',
  DISCONNECT_DEVICE: 'ecr:disconnect-device',
  GET_DEVICE_STATUS: 'ecr:get-device-status',
  GET_ALL_STATUSES: 'ecr:get-all-statuses',

  // Transactions
  PROCESS_PAYMENT: 'ecr:process-payment',
  PROCESS_REFUND: 'ecr:process-refund',
  VOID_TRANSACTION: 'ecr:void-transaction',
  CANCEL_TRANSACTION: 'ecr:cancel-transaction',
  SETTLEMENT: 'ecr:settlement',

  // Transaction history
  GET_RECENT_TRANSACTIONS: 'ecr:get-recent-transactions',
  QUERY_TRANSACTIONS: 'ecr:query-transactions',
  GET_TRANSACTION_STATS: 'ecr:get-transaction-stats',
  GET_TRANSACTION_FOR_ORDER: 'ecr:get-transaction-for-order',

  // Events (renderer -> main subscription)
  SUBSCRIBE_EVENTS: 'ecr:subscribe-events',
  UNSUBSCRIBE_EVENTS: 'ecr:unsubscribe-events',

  // Events (main -> renderer broadcasts)
  EVENT_DEVICE_CONNECTED: 'ecr:event:device-connected',
  EVENT_DEVICE_DISCONNECTED: 'ecr:event:device-disconnected',
  EVENT_DEVICE_STATUS_CHANGED: 'ecr:event:device-status-changed',
  EVENT_TRANSACTION_STARTED: 'ecr:event:transaction-started',
  EVENT_TRANSACTION_STATUS: 'ecr:event:transaction-status',
  EVENT_TRANSACTION_COMPLETED: 'ecr:event:transaction-completed',
  EVENT_DISPLAY_MESSAGE: 'ecr:event:display-message',
  EVENT_ERROR: 'ecr:event:error',
} as const;

/**
 * Register ECR IPC handlers
 */
export function registerECRHandlers(manager: PaymentTerminalManager): void {
  // =========================================================================
  // Discovery
  // =========================================================================

  ipcMain.handle(
    ECR_IPC_CHANNELS.DISCOVER_DEVICES,
    async (
      _event,
      connectionTypes?: ECRConnectionType[],
      timeout?: number
    ): Promise<DiscoveredECRDevice[]> => {
      return manager.discoverDevices(connectionTypes, timeout);
    }
  );

  // =========================================================================
  // Device Configuration
  // =========================================================================

  ipcMain.handle(
    ECR_IPC_CHANNELS.GET_DEVICES,
    async (): Promise<ECRDevice[]> => {
      return manager.getDevices();
    }
  );

  ipcMain.handle(
    ECR_IPC_CHANNELS.GET_DEVICE,
    async (_event, deviceId: string): Promise<ECRDevice | null> => {
      return manager.getDevice(deviceId);
    }
  );

  ipcMain.handle(
    ECR_IPC_CHANNELS.ADD_DEVICE,
    async (
      _event,
      config: Omit<ECRDevice, 'id' | 'createdAt' | 'updatedAt'>
    ): Promise<ECRDevice> => {
      return manager.addDevice(config);
    }
  );

  ipcMain.handle(
    ECR_IPC_CHANNELS.UPDATE_DEVICE,
    async (
      _event,
      deviceId: string,
      updates: Partial<Omit<ECRDevice, 'id' | 'createdAt'>>
    ): Promise<ECRDevice | null> => {
      return manager.updateDevice(deviceId, updates);
    }
  );

  ipcMain.handle(
    ECR_IPC_CHANNELS.REMOVE_DEVICE,
    async (_event, deviceId: string): Promise<boolean> => {
      return manager.removeDevice(deviceId);
    }
  );

  ipcMain.handle(
    ECR_IPC_CHANNELS.GET_DEFAULT_TERMINAL,
    async (): Promise<ECRDevice | null> => {
      return manager.getDefaultTerminal();
    }
  );

  // =========================================================================
  // Connection Management
  // =========================================================================

  ipcMain.handle(
    ECR_IPC_CHANNELS.CONNECT_DEVICE,
    async (_event, deviceId: string): Promise<void> => {
      return manager.connectDevice(deviceId);
    }
  );

  ipcMain.handle(
    ECR_IPC_CHANNELS.DISCONNECT_DEVICE,
    async (_event, deviceId: string): Promise<void> => {
      return manager.disconnectDevice(deviceId);
    }
  );

  ipcMain.handle(
    ECR_IPC_CHANNELS.GET_DEVICE_STATUS,
    async (_event, deviceId: string): Promise<ECRDeviceStatus | null> => {
      return manager.getDeviceStatus(deviceId);
    }
  );

  ipcMain.handle(
    ECR_IPC_CHANNELS.GET_ALL_STATUSES,
    async (): Promise<Record<string, ECRDeviceStatus>> => {
      const statuses = manager.getAllDeviceStatuses();
      const result: Record<string, ECRDeviceStatus> = {};
      statuses.forEach((status, id) => {
        result[id] = status;
      });
      return result;
    }
  );

  // =========================================================================
  // Transactions
  // =========================================================================

  ipcMain.handle(
    ECR_IPC_CHANNELS.PROCESS_PAYMENT,
    async (
      _event,
      amount: number,
      options?: {
        deviceId?: string;
        orderId?: string;
        tipAmount?: number;
        currency?: string;
        reference?: string;
      }
    ): Promise<ECRTransactionResponse> => {
      return manager.processPayment(amount, options);
    }
  );

  ipcMain.handle(
    ECR_IPC_CHANNELS.PROCESS_REFUND,
    async (
      _event,
      amount: number,
      options?: {
        deviceId?: string;
        orderId?: string;
        originalTransactionId?: string;
        currency?: string;
      }
    ): Promise<ECRTransactionResponse> => {
      return manager.processRefund(amount, options);
    }
  );

  ipcMain.handle(
    ECR_IPC_CHANNELS.VOID_TRANSACTION,
    async (
      _event,
      transactionId: string,
      deviceId?: string
    ): Promise<ECRTransactionResponse> => {
      return manager.voidTransaction(transactionId, deviceId);
    }
  );

  ipcMain.handle(
    ECR_IPC_CHANNELS.CANCEL_TRANSACTION,
    async (_event, deviceId: string): Promise<void> => {
      return manager.cancelTransaction(deviceId);
    }
  );

  ipcMain.handle(
    ECR_IPC_CHANNELS.SETTLEMENT,
    async (_event, deviceId?: string): Promise<ECRSettlementResult> => {
      return manager.settlement(deviceId);
    }
  );

  // =========================================================================
  // Transaction History
  // =========================================================================

  ipcMain.handle(
    ECR_IPC_CHANNELS.GET_RECENT_TRANSACTIONS,
    async (_event, limit?: number) => {
      return manager.getRecentTransactions(limit);
    }
  );

  ipcMain.handle(
    ECR_IPC_CHANNELS.QUERY_TRANSACTIONS,
    async (_event, filters: any) => {
      // Convert date strings back to Date objects
      if (filters.startDate) {
        filters.startDate = new Date(filters.startDate);
      }
      if (filters.endDate) {
        filters.endDate = new Date(filters.endDate);
      }
      return manager.queryTransactions(filters);
    }
  );

  ipcMain.handle(
    ECR_IPC_CHANNELS.GET_TRANSACTION_STATS,
    async (_event, filters?: any) => {
      if (filters) {
        if (filters.startDate) {
          filters.startDate = new Date(filters.startDate);
        }
        if (filters.endDate) {
          filters.endDate = new Date(filters.endDate);
        }
      }
      return manager.getTransactionStats(filters);
    }
  );

  ipcMain.handle(
    ECR_IPC_CHANNELS.GET_TRANSACTION_FOR_ORDER,
    async (_event, orderId: string) => {
      return manager.getTransactionForOrder(orderId);
    }
  );

  // =========================================================================
  // Event Broadcasting
  // =========================================================================

  // Set up event broadcasting to renderer
  setupEventBroadcasting(manager);
}

/**
 * Set up event broadcasting from manager to renderer windows
 */
function setupEventBroadcasting(manager: PaymentTerminalManager): void {
  const broadcast = (channel: string, ...args: unknown[]) => {
    BrowserWindow.getAllWindows().forEach((win) => {
      if (!win.isDestroyed()) {
        win.webContents.send(channel, ...args);
      }
    });
  };

  manager.on(PaymentTerminalManagerEvent.DEVICE_CONNECTED, (deviceId) => {
    broadcast(ECR_IPC_CHANNELS.EVENT_DEVICE_CONNECTED, deviceId);
  });

  manager.on(PaymentTerminalManagerEvent.DEVICE_DISCONNECTED, (deviceId) => {
    broadcast(ECR_IPC_CHANNELS.EVENT_DEVICE_DISCONNECTED, deviceId);
  });

  manager.on(PaymentTerminalManagerEvent.DEVICE_STATUS_CHANGED, (deviceId, status) => {
    broadcast(ECR_IPC_CHANNELS.EVENT_DEVICE_STATUS_CHANGED, deviceId, status);
  });

  manager.on(PaymentTerminalManagerEvent.TRANSACTION_STARTED, (data) => {
    broadcast(ECR_IPC_CHANNELS.EVENT_TRANSACTION_STARTED, data);
  });

  manager.on(PaymentTerminalManagerEvent.TRANSACTION_STATUS, (data) => {
    broadcast(ECR_IPC_CHANNELS.EVENT_TRANSACTION_STATUS, data);
  });

  manager.on(PaymentTerminalManagerEvent.TRANSACTION_COMPLETED, (data) => {
    broadcast(ECR_IPC_CHANNELS.EVENT_TRANSACTION_COMPLETED, data);
  });

  manager.on(PaymentTerminalManagerEvent.DISPLAY_MESSAGE, (deviceId, message) => {
    broadcast(ECR_IPC_CHANNELS.EVENT_DISPLAY_MESSAGE, deviceId, message);
  });

  manager.on(PaymentTerminalManagerEvent.ERROR, (deviceId, error) => {
    broadcast(ECR_IPC_CHANNELS.EVENT_ERROR, deviceId, error instanceof Error ? error.message : String(error));
  });
}

/**
 * Unregister ECR IPC handlers
 */
export function unregisterECRHandlers(): void {
  Object.values(ECR_IPC_CHANNELS).forEach((channel) => {
    if (!channel.includes(':event:')) {
      ipcMain.removeHandler(channel);
    }
  });
}
