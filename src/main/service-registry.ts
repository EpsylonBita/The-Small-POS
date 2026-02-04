/**
 * Service Registry - Centralized singleton for all POS services
 *
 * Provides type-safe access to services from any module.
 * Services are registered during app initialization and can be accessed
 * from IPC handlers and other modules without circular dependencies.
 */

import { BrowserWindow } from 'electron';
import type { DatabaseManager } from './database';
// Services now in services/ directory
import type { SyncService } from './services/SyncService';
import type { AdminDashboardSyncService } from './services/AdminDashboardSyncService';
import type { AuthService } from './services/AuthService';
import type { StaffAuthService } from './services/StaffAuthService';
import type { SettingsService } from './services/SettingsService';
import type { TerminalConfigService } from './services/TerminalConfigService';
import type { HeartbeatService } from './services/HeartbeatService';
import type { ScreenCaptureService } from './services/ScreenCaptureService';
import type { CustomerService } from './services/CustomerService';
import type { WindowManager } from './window-manager';
import type { ModuleSyncService } from './services/ModuleSyncService';
import type { PrinterManager } from './printer/services/PrinterManager';
import type { FeatureService } from './services/FeatureService';
import type { AutoUpdaterService } from './auto-updater';
import type { PaymentTerminalManager } from './ecr/services/PaymentTerminalManager';

export interface ServiceInstances {
  dbManager: DatabaseManager | null;
  syncService: SyncService | null;
  adminDashboardSyncService: AdminDashboardSyncService | null;
  authService: AuthService | null;
  staffAuthService: StaffAuthService | null;
  settingsService: SettingsService | null;
  terminalConfigService: TerminalConfigService | null;
  heartbeatService: HeartbeatService | null;
  screenCaptureService: ScreenCaptureService | null;
  customerService: CustomerService | null;
  windowManager: WindowManager | null;
  mainWindow: BrowserWindow | null;
  moduleSyncService: ModuleSyncService | null;
  printerManager: PrinterManager | null;
  featureService: FeatureService | null;
  autoUpdaterService: AutoUpdaterService | null;
  paymentTerminalManager: PaymentTerminalManager | null;
}

class ServiceRegistry {
  private static instance: ServiceRegistry;

  private services: ServiceInstances = {
    dbManager: null,
    syncService: null,
    adminDashboardSyncService: null,
    authService: null,
    staffAuthService: null,
    settingsService: null,
    terminalConfigService: null,
    heartbeatService: null,
    screenCaptureService: null,
    customerService: null,
    windowManager: null,
    mainWindow: null,
    moduleSyncService: null,
    printerManager: null,
    featureService: null,
    autoUpdaterService: null,
    paymentTerminalManager: null,
  };

  // Cleanup function for realtime handlers
  private realtimeCleanup: (() => Promise<void> | void) | null = null;

  // Guard to prevent re-entrant quit loop
  private isQuitting = false;

  private constructor() { }

  static getInstance(): ServiceRegistry {
    if (!ServiceRegistry.instance) {
      ServiceRegistry.instance = new ServiceRegistry();
    }
    return ServiceRegistry.instance;
  }

  // Register services
  register<K extends keyof ServiceInstances>(key: K, service: ServiceInstances[K]): void {
    this.services[key] = service;
  }

  // Get services with type safety
  get<K extends keyof ServiceInstances>(key: K): ServiceInstances[K] {
    return this.services[key];
  }

  // Convenience getters for common services
  get dbManager(): DatabaseManager | null {
    return this.services.dbManager;
  }

  get syncService(): SyncService | null {
    return this.services.syncService;
  }

  get adminDashboardSyncService(): AdminDashboardSyncService | null {
    return this.services.adminDashboardSyncService;
  }

  get authService(): AuthService | null {
    return this.services.authService;
  }

  get staffAuthService(): StaffAuthService | null {
    return this.services.staffAuthService;
  }

  get settingsService(): SettingsService | null {
    return this.services.settingsService;
  }

  get terminalConfigService(): TerminalConfigService | null {
    return this.services.terminalConfigService;
  }

  get heartbeatService(): HeartbeatService | null {
    return this.services.heartbeatService;
  }

  get screenCaptureService(): ScreenCaptureService | null {
    return this.services.screenCaptureService;
  }

  get customerService(): CustomerService | null {
    return this.services.customerService;
  }

  get windowManager(): WindowManager | null {
    return this.services.windowManager;
  }

  get mainWindow(): BrowserWindow | null {
    return this.services.mainWindow;
  }

  get moduleSyncService(): ModuleSyncService | null {
    return this.services.moduleSyncService;
  }

  get printerManager(): PrinterManager | null {
    return this.services.printerManager;
  }

  get featureService(): FeatureService | null {
    return this.services.featureService;
  }

  get autoUpdaterService(): AutoUpdaterService | null {
    return this.services.autoUpdaterService;
  }

  // Realtime cleanup management
  setRealtimeCleanup(cleanup: (() => Promise<void> | void) | null): void {
    this.realtimeCleanup = cleanup;
  }

  getRealtimeCleanup(): (() => Promise<void> | void) | null {
    return this.realtimeCleanup;
  }

  // Quitting state management
  setIsQuitting(value: boolean): void {
    this.isQuitting = value;
  }

  getIsQuitting(): boolean {
    return this.isQuitting;
  }

  // Get all services (useful for debugging)
  getAllServices(): ServiceInstances {
    return { ...this.services };
  }

  // Check if a service is registered
  has<K extends keyof ServiceInstances>(key: K): boolean {
    return this.services[key] !== null;
  }

  /**
   * Get a required service, throwing an error if not registered.
   * Use this in handlers that need guaranteed service availability.
   */
  requireService<K extends keyof ServiceInstances>(key: K): NonNullable<ServiceInstances[K]> {
    const service = this.services[key];
    if (!service) {
      throw new Error(`Required service '${key}' is not registered`);
    }
    return service as NonNullable<ServiceInstances[K]>;
  }

  /**
   * Get the status of all registered services.
   * Useful for debugging and health checks.
   */
  getServiceStatus(): Record<keyof ServiceInstances, boolean> {
    const status: any = {};
    for (const key in this.services) {
      status[key as keyof ServiceInstances] = this.services[key as keyof ServiceInstances] !== null;
    }
    return status;
  }
}

// Export singleton instance
export const serviceRegistry = ServiceRegistry.getInstance();

// Export type for external use
export type { ServiceRegistry };
