/**
 * ModuleService Types (POS-local stub)
 */

export interface AcquiredModule {
  moduleId: string;
  moduleName: string;
  isActive: boolean;
  isPosEnabled: boolean;
  purchasedAt?: string;
  expiresAt?: string | null;
}

export interface ModuleChangeEvent {
  eventType: 'INSERT' | 'UPDATE' | 'DELETE';
  module: AcquiredModule;
  organizationId: string;
}
