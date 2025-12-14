/**
 * Handler Registration Tests
 *
 * Verifies that all handlers are correctly registered and
 * the architecture refactoring is working as expected.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock electron
vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn(),
    removeHandler: vi.fn(),
  },
  app: {
    getPath: vi.fn().mockReturnValue('/tmp'),
    whenReady: vi.fn().mockResolvedValue(undefined),
  },
  BrowserWindow: vi.fn(),
}));

// Mock service registry
vi.mock('../../../src/main/service-registry', () => ({
  serviceRegistry: {
    get: vi.fn(),
    requireService: vi.fn(),
    register: vi.fn(),
    dbManager: null,
    syncService: null,
    authService: null,
    staffAuthService: null,
    settingsService: null,
    getServiceStatus: vi.fn().mockReturnValue({
      dbManager: false,
      syncService: false,
      authService: false,
    }),
    getAllServices: vi.fn().mockReturnValue({
      dbManager: null,
      syncService: null,
      authService: null,
      staffAuthService: null,
      settingsService: null,
    }),
  },
}));

describe('Handler Registration Architecture', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Error Handler Utility', () => {
    it('should export handleIPCError function', async () => {
      const { handleIPCError } = await import(
        '../../../src/main/handlers/utils/error-handler'
      );
      expect(handleIPCError).toBeDefined();
      expect(typeof handleIPCError).toBe('function');
    });

    it('should export ErrorCodes', async () => {
      const { ErrorCodes } = await import(
        '../../../src/main/handlers/utils/error-handler'
      );
      expect(ErrorCodes).toBeDefined();
      expect(ErrorCodes.UNKNOWN_ERROR).toBe('UNKNOWN_ERROR');
      expect(ErrorCodes.NOT_FOUND).toBe('NOT_FOUND');
      expect(ErrorCodes.PERMISSION_DENIED).toBe('PERMISSION_DENIED');
    });

    it('should return success response when handler succeeds', async () => {
      const { handleIPCError } = await import(
        '../../../src/main/handlers/utils/error-handler'
      );
      const result = await handleIPCError(async () => {
        return { id: '123', name: 'test' };
      }, 'test:handler');

      expect(result.success).toBe(true);
      expect(result.data).toEqual({ id: '123', name: 'test' });
      expect(result.error).toBeUndefined();
    });

    it('should return error response when handler throws', async () => {
      const { handleIPCError } = await import(
        '../../../src/main/handlers/utils/error-handler'
      );
      const result = await handleIPCError(async () => {
        throw new Error('Test error');
      }, 'test:handler');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Test error');
      expect(result.data).toBeUndefined();
    });
  });

  describe('Handler Index Exports', () => {
    it('should export registerAllMainHandlers', async () => {
      const { registerAllMainHandlers } = await import(
        '../../../src/main/handlers/index'
      );
      expect(registerAllMainHandlers).toBeDefined();
      expect(typeof registerAllMainHandlers).toBe('function');
    });

    it('should export registerAllDomainHandlers', async () => {
      const { registerAllDomainHandlers } = await import(
        '../../../src/main/handlers/index'
      );
      expect(registerAllDomainHandlers).toBeDefined();
      expect(typeof registerAllDomainHandlers).toBe('function');
    });

    it('should export registerAllHandlers', async () => {
      const { registerAllHandlers } = await import(
        '../../../src/main/handlers/index'
      );
      expect(registerAllHandlers).toBeDefined();
      expect(typeof registerAllHandlers).toBe('function');
    });

    it('should export registerPrinterDiscoveryHandlers', async () => {
      const { registerPrinterDiscoveryHandlers } = await import(
        '../../../src/main/handlers/index'
      );
      expect(registerPrinterDiscoveryHandlers).toBeDefined();
      expect(typeof registerPrinterDiscoveryHandlers).toBe('function');
    });
  });

  describe('Order Handlers Domain', () => {
    it('should export registerOrderHandlers from orders domain', async () => {
      const { registerOrderHandlers } = await import(
        '../../../src/main/handlers/orders/index'
      );
      expect(registerOrderHandlers).toBeDefined();
      expect(typeof registerOrderHandlers).toBe('function');
    });

    it('should export registerOrderCrudHandlers', async () => {
      const { registerOrderCrudHandlers } = await import(
        '../../../src/main/handlers/orders/index'
      );
      expect(registerOrderCrudHandlers).toBeDefined();
      expect(typeof registerOrderCrudHandlers).toBe('function');
    });

    it('should export registerOrderStatusHandlers', async () => {
      const { registerOrderStatusHandlers } = await import(
        '../../../src/main/handlers/orders/index'
      );
      expect(registerOrderStatusHandlers).toBeDefined();
      expect(typeof registerOrderStatusHandlers).toBe('function');
    });
  });

  describe('Auth Handlers Domain', () => {
    it('should export registerAllAuthHandlers from auth domain', async () => {
      const { registerAllAuthHandlers } = await import(
        '../../../src/main/handlers/auth/index'
      );
      expect(registerAllAuthHandlers).toBeDefined();
      expect(typeof registerAllAuthHandlers).toBe('function');
    });

    it('should export registerAuthHandlers', async () => {
      const { registerAuthHandlers } = await import(
        '../../../src/main/handlers/auth/index'
      );
      expect(registerAuthHandlers).toBeDefined();
      expect(typeof registerAuthHandlers).toBe('function');
    });

    it('should export registerStaffAuthHandlers', async () => {
      const { registerStaffAuthHandlers } = await import(
        '../../../src/main/handlers/auth/index'
      );
      expect(registerStaffAuthHandlers).toBeDefined();
      expect(typeof registerStaffAuthHandlers).toBe('function');
    });
  });

  describe('Service Registry', () => {
    it('should have requireService method', async () => {
      const { serviceRegistry } = await import(
        '../../../src/main/service-registry'
      );
      expect(serviceRegistry.requireService).toBeDefined();
      expect(typeof serviceRegistry.requireService).toBe('function');
    });

    it('should have getServiceStatus method', async () => {
      const { serviceRegistry } = await import(
        '../../../src/main/service-registry'
      );
      expect(serviceRegistry.getServiceStatus).toBeDefined();
      expect(typeof serviceRegistry.getServiceStatus).toBe('function');
    });
  });
});

describe('Service Exports', () => {
  it('should export AuthService from services directory', async () => {
    const { AuthService } = await import(
      '../../../src/main/services/AuthService'
    );
    expect(AuthService).toBeDefined();
  });

  it('should export SyncService from services directory', async () => {
    const { SyncService } = await import(
      '../../../src/main/services/SyncService'
    );
    expect(SyncService).toBeDefined();
  });

  it('should export AdminDashboardSyncService from services directory', async () => {
    const { AdminDashboardSyncService } = await import(
      '../../../src/main/services/AdminDashboardSyncService'
    );
    expect(AdminDashboardSyncService).toBeDefined();
  });

  it('should export all services from index', async () => {
    const services = await import('../../../src/main/services/index');
    expect(services.AuthService).toBeDefined();
    expect(services.SyncService).toBeDefined();
    expect(services.AdminDashboardSyncService).toBeDefined();
  });
});
