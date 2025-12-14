/**
 * Handlers Index Module
 *
 * Exports all handler registration functions.
 * This is the central module for IPC handler registration.
 */

// System handlers
import { registerWindowHandlers } from './window-handlers';
import { registerGeolocationHandlers } from './geolocation-handlers';
import { registerSystemHandlers } from './system-handlers';
import { registerAppControlHandlers } from './app-control-handlers';
import { registerClipboardHandlers } from './clipboard-handlers';
import { registerScreenCaptureHandlers } from './screen-capture-handlers';

// Domain handlers (refactored to use serviceRegistry)
import { registerOrderHandlers } from './orders';
import { registerAllAuthHandlers, registerAuthHandlers, registerStaffAuthHandlers } from './auth';
import { registerPaymentHandlers } from './payment/payment-handlers';
import { registerShiftHandlers } from './shift/shift-handlers';
import { registerReportHandlers } from './report/report-handlers';
import { registerMenuHandlers } from './menu/menu-handlers';
import { registerPrintHandlers } from './print/print-handlers';
import { registerCustomerHandlers } from './customers/customer-handlers';
import { registerSettingsHandlers } from './settings/settings-handlers';
import { registerOrderPreparationHandlers } from './orders/order-preparation-handlers';
import { registerOrderConflictHandlers } from './orders/order-conflict-handlers';
import { registerCoreSyncHandlers, setupAdminSyncHandlers } from './sync/admin-sync-handlers';

// Settings and configuration handlers
import { registerSettingsMainHandlers } from './settings-main-handlers';
import { registerTerminalConfigHandlers } from './terminal-config-handlers';

// Order-related handlers (existing modular)
import { registerOrderMainHandlers } from './order-main-handlers';

// Delivery and driver handlers
import { registerDriverHandlers } from './driver-handlers';
import { registerDeliveryZoneHandlers } from './delivery-zone-handlers';

// Module handlers
import { registerModuleHandlers } from './module-handlers';

// Printer manager handlers
import {
  registerPrinterManagerHandlers,
  initializePrinterManager,
  shutdownPrinterManager,
  setupStatusEventForwarding,
  getPrinterManagerInstance,
  PRINTER_IPC_CHANNELS,
} from './printer-manager-handlers';

// Printer discovery handlers (migrated from ipc-router.ts)
import { registerPrinterDiscoveryHandlers } from './printer-discovery-handlers';

// Re-export all handlers
export {
  // System handlers
  registerWindowHandlers,
  registerGeolocationHandlers,
  registerSystemHandlers,
  registerAppControlHandlers,
  registerClipboardHandlers,
  registerScreenCaptureHandlers,

  // Domain handlers (refactored)
  registerOrderHandlers,
  registerAllAuthHandlers,
  registerAuthHandlers,
  registerStaffAuthHandlers,
  registerPaymentHandlers,
  registerShiftHandlers,
  registerReportHandlers,
  registerMenuHandlers,
  registerPrintHandlers,
  registerCustomerHandlers,
  registerSettingsHandlers,
  registerOrderPreparationHandlers,
  registerOrderConflictHandlers,
  registerCoreSyncHandlers,
  setupAdminSyncHandlers,

  // Settings and configuration
  registerSettingsMainHandlers,
  registerTerminalConfigHandlers,

  // Order-related (existing)
  registerOrderMainHandlers,

  // Delivery and drivers
  registerDriverHandlers,
  registerDeliveryZoneHandlers,

  // Modules
  registerModuleHandlers,

  // Printer manager exports
  registerPrinterManagerHandlers,
  initializePrinterManager,
  shutdownPrinterManager,
  setupStatusEventForwarding,
  getPrinterManagerInstance,
  PRINTER_IPC_CHANNELS,

  // Printer discovery (migrated from ipc-router.ts)
  registerPrinterDiscoveryHandlers,
};

// Export utilities
export * from './utils';

/**
 * Register all main handlers (basic system handlers)
 *
 * These handlers have no service dependencies and can be registered immediately.
 */
export function registerAllMainHandlers(): void {
  // System handlers (no service dependencies)
  registerClipboardHandlers();
  registerWindowHandlers();
  registerGeolocationHandlers();
  registerSystemHandlers();
  registerAppControlHandlers();
  registerScreenCaptureHandlers();

  // Settings handlers (basic config)
  registerSettingsMainHandlers();
  registerTerminalConfigHandlers();

  // Delivery and driver handlers
  registerDriverHandlers();
  registerDeliveryZoneHandlers();

  // Module handlers
  registerModuleHandlers();

  // Order main handlers (existing)
  registerOrderMainHandlers();

  console.log('[Handlers] ✅ All main handlers registered');
}

/**
 * Register all domain handlers (require services to be initialized)
 *
 * These handlers depend on services being registered in serviceRegistry.
 * Call this AFTER services have been initialized.
 */
export function registerAllDomainHandlers(): void {
  // Domain handlers using serviceRegistry
  registerOrderHandlers();
  registerAllAuthHandlers();
  registerPaymentHandlers();
  registerShiftHandlers();
  registerReportHandlers();
  registerMenuHandlers();
  registerPrintHandlers();
  registerCustomerHandlers();
  registerSettingsHandlers();
  registerOrderPreparationHandlers();
  registerOrderConflictHandlers();
  registerCoreSyncHandlers();
  setupAdminSyncHandlers();
  registerPrinterDiscoveryHandlers();

  console.log('[Handlers] ✅ All domain handlers registered');
}

/**
 * Register ALL handlers (convenience function)
 *
 * Registers both main handlers and domain handlers.
 * Services must be initialized before calling this.
 */
export function registerAllHandlers(): void {
  registerAllMainHandlers();
  registerAllDomainHandlers();

  console.log('[Handlers] ✅ All handlers registered');
}
