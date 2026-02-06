/**
 * Handler Registration Tests
 *
 * Verifies that all handlers are correctly registered and
 * the architecture refactoring is working as expected.
 */

// Mock electron
jest.mock('electron', () => ({
  ipcMain: {
    handle: jest.fn(),
    removeHandler: jest.fn(),
  },
  app: {
    getPath: jest.fn().mockReturnValue('/tmp'),
    whenReady: jest.fn().mockResolvedValue(undefined),
  },
  BrowserWindow: jest.fn(),
}));

// Mock service registry
jest.mock('../../../src/main/service-registry', () => ({
  serviceRegistry: {
    get: jest.fn(),
    requireService: jest.fn(),
    register: jest.fn(),
    dbManager: null,
    syncService: null,
    authService: null,
    staffAuthService: null,
    settingsService: null,
    getServiceStatus: jest.fn().mockReturnValue({
      dbManager: false,
      syncService: false,
      authService: false,
    }),
    getAllServices: jest.fn().mockReturnValue({
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
    jest.clearAllMocks();
  });

  describe('Error Handler Utility', () => {
    it('should export handleIPCError function', () => {
      const { handleIPCError } = require('../../../src/main/handlers/utils/error-handler');
      expect(handleIPCError).toBeDefined();
      expect(typeof handleIPCError).toBe('function');
    });

    it('should export ErrorCodes', () => {
      const { ErrorCodes } = require('../../../src/main/handlers/utils/error-handler');
      expect(ErrorCodes).toBeDefined();
      expect(ErrorCodes.UNKNOWN_ERROR).toBe('UNKNOWN_ERROR');
      expect(ErrorCodes.NOT_FOUND).toBe('NOT_FOUND');
      expect(ErrorCodes.PERMISSION_DENIED).toBe('PERMISSION_DENIED');
    });

    it('should return success response when handler succeeds', async () => {
      const { handleIPCError } = require('../../../src/main/handlers/utils/error-handler');
      const result = await handleIPCError(async () => {
        return { id: '123', name: 'test' };
      }, 'test:handler');

      expect(result.success).toBe(true);
      expect(result.data).toEqual({ id: '123', name: 'test' });
      expect(result.error).toBeUndefined();
    });

    it('should return error response when handler throws', async () => {
      const { handleIPCError } = require('../../../src/main/handlers/utils/error-handler');
      const result = await handleIPCError(async () => {
        throw new Error('Test error');
      }, 'test:handler');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Test error');
      expect(result.data).toBeUndefined();
    });
  });

  describe('Handler Index Exports', () => {
    it('should export registerAllMainHandlers', () => {
      const { registerAllMainHandlers } = require('../../../src/main/handlers/index');
      expect(registerAllMainHandlers).toBeDefined();
      expect(typeof registerAllMainHandlers).toBe('function');
    });

    it('should export registerAllDomainHandlers', () => {
      const { registerAllDomainHandlers } = require('../../../src/main/handlers/index');
      expect(registerAllDomainHandlers).toBeDefined();
      expect(typeof registerAllDomainHandlers).toBe('function');
    });

    it('should export registerAllHandlers', () => {
      const { registerAllHandlers } = require('../../../src/main/handlers/index');
      expect(registerAllHandlers).toBeDefined();
      expect(typeof registerAllHandlers).toBe('function');
    });

    it('should export registerPrinterDiscoveryHandlers', () => {
      const { registerPrinterDiscoveryHandlers } = require('../../../src/main/handlers/index');
      expect(registerPrinterDiscoveryHandlers).toBeDefined();
      expect(typeof registerPrinterDiscoveryHandlers).toBe('function');
    });
  });

  describe('Order Handlers Domain', () => {
    it('should export registerOrderHandlers from orders domain', () => {
      const { registerOrderHandlers } = require('../../../src/main/handlers/orders/index');
      expect(registerOrderHandlers).toBeDefined();
      expect(typeof registerOrderHandlers).toBe('function');
    });

    it('should export registerOrderCrudHandlers', () => {
      const { registerOrderCrudHandlers } = require('../../../src/main/handlers/orders/index');
      expect(registerOrderCrudHandlers).toBeDefined();
      expect(typeof registerOrderCrudHandlers).toBe('function');
    });

    it('should export registerOrderStatusHandlers', () => {
      const { registerOrderStatusHandlers } = require('../../../src/main/handlers/orders/index');
      expect(registerOrderStatusHandlers).toBeDefined();
      expect(typeof registerOrderStatusHandlers).toBe('function');
    });
  });

  describe('Auth Handlers Domain', () => {
    it('should export registerAllAuthHandlers from auth domain', () => {
      const { registerAllAuthHandlers } = require('../../../src/main/handlers/auth/index');
      expect(registerAllAuthHandlers).toBeDefined();
      expect(typeof registerAllAuthHandlers).toBe('function');
    });

    it('should export registerAuthHandlers', () => {
      const { registerAuthHandlers } = require('../../../src/main/handlers/auth/index');
      expect(registerAuthHandlers).toBeDefined();
      expect(typeof registerAuthHandlers).toBe('function');
    });

    it('should export registerStaffAuthHandlers', () => {
      const { registerStaffAuthHandlers } = require('../../../src/main/handlers/auth/index');
      expect(registerStaffAuthHandlers).toBeDefined();
      expect(typeof registerStaffAuthHandlers).toBe('function');
    });
  });

  describe('Service Registry', () => {
    it('should have requireService method', () => {
      const { serviceRegistry } = require('../../../src/main/service-registry');
      expect(serviceRegistry.requireService).toBeDefined();
      expect(typeof serviceRegistry.requireService).toBe('function');
    });

    it('should have getServiceStatus method', () => {
      const { serviceRegistry } = require('../../../src/main/service-registry');
      expect(serviceRegistry.getServiceStatus).toBeDefined();
      expect(typeof serviceRegistry.getServiceStatus).toBe('function');
    });
  });
});

describe('Service Exports', () => {
  it('should export AuthService from services directory', () => {
    const { AuthService } = require('../../../src/main/services/AuthService');
    expect(AuthService).toBeDefined();
  });

  it('should export SyncService from services directory', () => {
    const { SyncService } = require('../../../src/main/services/SyncService');
    expect(SyncService).toBeDefined();
  });

  it('should export AdminDashboardSyncService from services directory', () => {
    const { AdminDashboardSyncService } = require('../../../src/main/services/AdminDashboardSyncService');
    expect(AdminDashboardSyncService).toBeDefined();
  });

  it('should export all services from index', () => {
    const services = require('../../../src/main/services/index');
    expect(services.AuthService).toBeDefined();
    expect(services.SyncService).toBeDefined();
    expect(services.AdminDashboardSyncService).toBeDefined();
  });
});
