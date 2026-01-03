/**
 * Services Index Module
 *
 * Exports all services from the services directory.
 * This is the canonical location for service imports.
 */

// Core services
export { BaseService } from './BaseService';
export { DatabaseService } from './DatabaseService';

// Authentication services
export { AuthService } from './AuthService';
export type { AuthResult, SessionInfo } from './AuthService';
export { StaffAuthService } from './StaffAuthService';
export type { StaffAuthResult, StaffSession, StaffMember } from './StaffAuthService';

// Sync services
export { SyncService } from './SyncService';
export type { SyncStatus, EnhancedSyncRequest, TerminalHeartbeatData } from './SyncService';
export { AdminDashboardSyncService } from './AdminDashboardSyncService';
export type { AdminDashboardSyncStatus, TerminalHeartbeat } from './AdminDashboardSyncService';

// Domain services
export { OrderService } from './OrderService';
export { StaffService } from './StaffService';
export { SyncQueueService } from './SyncQueueService';
export { SettingsService } from './SettingsService';
export { PaymentService } from './PaymentService';
export { CustomerService } from './CustomerService';

// Terminal services
export { TerminalConfigService } from './TerminalConfigService';
export { HeartbeatService } from './HeartbeatService';
export { ScreenCaptureService } from './ScreenCaptureService';

// Module services
export { ModuleSyncService } from './ModuleSyncService';
export type { ModuleSyncServiceConfig, ModuleSyncResult } from './ModuleSyncService';

// Feature services
export { FeatureService } from './FeatureService';
export type { TerminalFeatures, TerminalType, TerminalConfig } from './FeatureService';

// Report services
export { ReportService } from './ReportService';

// Print services
export { PrintService } from './PrintService';

// Export types from shared types for consistency
export type {
  Order,
  OrderItem,
  OrderStatus,
  OrderType,
  PaymentStatus,
  PaymentMethod
} from '../../shared/types/orders';

export type {
  User,
  LoginCredentials,
  LoginResult,
  AuthResult as SharedAuthResult,
  StaffSession as SharedStaffSession,
  StaffInfo
} from '../../shared/types/auth';

export type {
  SyncQueue,
  SyncResult,
  LocalSettings,
  POSLocalConfig,
  PaymentTransaction,
  PaymentReceipt,
  PaymentRefund
} from '../../shared/types/database';
