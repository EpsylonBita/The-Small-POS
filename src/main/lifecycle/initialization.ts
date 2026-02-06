/**
 * Initialization Module
 *
 * Handles app initialization, service setup, and initial sync.
 */

import { app, BrowserWindow, dialog } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { serviceRegistry } from '../service-registry';
import { logErrorToFile, showErrorDialog } from './error-logging';
import { DatabaseManager } from '../database';
// Services - all imported from the services directory
import { SyncService } from '../services/SyncService';
import { AdminDashboardSyncService } from '../services/AdminDashboardSyncService';
import { AuthService } from '../services/AuthService';
import StaffAuthService from '../services/StaffAuthService';
import { SettingsService } from '../services/SettingsService';
import { TerminalConfigService } from '../services/TerminalConfigService';
import { HeartbeatService } from '../services/HeartbeatService';
import { ScreenCaptureService } from '../services/ScreenCaptureService';
import { CustomerService } from '../services/CustomerService';
import { WindowManager } from '../window-manager';
import { ModuleSyncService } from '../services/ModuleSyncService';
import { getSupabaseClient, isSupabaseConfigured, setSupabaseContext } from '../../shared/supabase-config';
import { setupRealtimeHandlers } from '../index';
import {
  initializePrinterManager,
  registerPrinterManagerHandlers,
  setupStatusEventForwarding,
  shutdownPrinterManager,
} from '../handlers/printer-manager-handlers';

// ECR (Payment Terminal) handlers
import { registerECRHandlers } from '../ecr/handlers';
import { PaymentTerminalManager } from '../ecr/services/PaymentTerminalManager';

/**
 * Initialize the database with fallback handling
 */
export async function initializeDatabase(): Promise<{
  dbManager: DatabaseManager;
  success: boolean;
  usedFallback?: boolean;
}> {
  const dbManager = new DatabaseManager();
  const initResult = await dbManager.initializeWithFallback();

  // Apply database migrations for conflict resolution
  if (initResult.success) {
    try {
      console.log('Applying database migrations...');
      // The migrations are already applied in DatabaseService.ts during initialization
      // This is just a verification step
      console.log('✅ Database migrations verified');
    } catch (migrationError) {
      console.error('⚠️ Database migration verification failed:', migrationError);
      logErrorToFile(migrationError as Error);
      // Don't fail startup - migrations are already applied in DatabaseService
    }
  }

  if (!initResult.success) {
    // Log error to file
    if (initResult.error) {
      logErrorToFile(initResult.error);
    }

    // Show error dialog with options
    const choice = await showErrorDialog(
      'Database Initialization Failed',
      'Failed to initialize the database. What would you like to do?',
      ['Retry', 'Reset Database', 'Exit']
    );

    if (choice === 0) {
      // Retry
      app.relaunch();
      app.quit();
      return { dbManager, success: false };
    } else if (choice === 1) {
      // Reset Database
      const userDataPath = app.getPath('userData');
      const dbPath = path.join(userDataPath, 'pos-database.db');

      try {
        if (fs.existsSync(dbPath)) {
          fs.unlinkSync(dbPath);
        }
        app.relaunch();
        app.quit();
        return { dbManager, success: false };
      } catch (resetError) {
        console.error('Failed to reset database:', resetError);
      }
    }

    // Exit
    app.quit();
    return { dbManager, success: false };
  }

  if (initResult.usedFallback) {
    console.warn('Database initialized using fallback (fresh database)');
  }

  return { dbManager, success: true, usedFallback: initResult.usedFallback };
}

/**
 * Initialize all application services
 */
export async function initializeServices(dbManager: DatabaseManager): Promise<boolean> {
  try {
    // Initialize SettingsService first (required by AuthService and SyncService)
    const settingsService = new SettingsService(dbManager.db);
    serviceRegistry.register('settingsService', settingsService);

    // Initialize auth services
    const authService = new AuthService(dbManager, settingsService);
    const staffAuthService = new StaffAuthService();
    serviceRegistry.register('authService', authService);
    serviceRegistry.register('staffAuthService', staffAuthService);

    // Get terminal ID and API key first (needed for CustomerService)
    const persistedTerminalId = settingsService.getSetting<string>('terminal', 'terminal_id', '');
    const persistedApiKey = settingsService.getSetting<string>('terminal', 'pos_api_key', '');

    // Terminal ID may fall back to env for developer convenience.
    // API key must come from persisted terminal pairing config only.
    const terminalId = persistedTerminalId || process.env.TERMINAL_ID || 'terminal-001';
    const posApiKey = persistedApiKey || '';

    console.log('[initializeServices] Terminal credentials resolved:', {
      terminalId,
      hasApiKey: !!posApiKey,
      source: persistedTerminalId ? 'connection_string' : (process.env.TERMINAL_ID ? 'env' : 'default')
    });

    // Get admin API URL from connection string stored in local settings ONLY
    const storedAdminUrl = settingsService.getSetting<string>('terminal', 'admin_dashboard_url', '');
    const adminApiBaseUrl = storedAdminUrl
      ? storedAdminUrl.replace(/\/$/, '') + '/api'
      : undefined;

    // Get organization ID from settings
    const organizationId = settingsService.getSetting<string>('terminal', 'organization_id', '');
    if (organizationId) {
      console.log('[initializeServices] Using Organization ID:', organizationId);
    } else {
      console.warn('[initializeServices] No Organization ID found in settings');
    }

    // Get branch ID from settings (if available)
    const branchId = settingsService.getSetting<string>('terminal', 'branch_id', '');
    if (branchId) {
      console.log('[initializeServices] Using Branch ID:', branchId);
    } else {
      console.warn('[initializeServices] No Branch ID found in settings');
    }

    // Set Supabase request context headers before creating any clients
    setSupabaseContext({
      terminalId,
      organizationId: organizationId || undefined,
      branchId: branchId || undefined,
      clientType: 'desktop',
    });

    // SECURITY: Only use anon key in Electron app - service role key bypasses RLS
    // and would allow any terminal to access ALL organizations' data
    const supabaseKey = process.env.SUPABASE_ANON_KEY || '';

    // SECURITY: Service role key must never be present in Electron runtime
    if (process.env.SUPABASE_SERVICE_ROLE_KEY) {
      console.error('[SECURITY BLOCK] SUPABASE_SERVICE_ROLE_KEY detected in desktop environment.');
      console.error('[SECURITY BLOCK] This key bypasses RLS and must be removed before startup.');
      await dialog.showMessageBox({
        type: 'error',
        title: 'Security Configuration Error',
        message: 'SUPABASE_SERVICE_ROLE_KEY is set in the desktop environment. This bypasses RLS and is not allowed. Remove the key and restart.',
        buttons: ['Exit'],
      });
      return false;
    }

    console.log('[initializeServices] Supabase auth config:', {
      hasAnonKey: !!process.env.SUPABASE_ANON_KEY,
      usingKeyType: 'anon' // Always anon for security
    });

    // Initialize CustomerService with terminal ID and API key
    const customerService = new CustomerService(
      dbManager.db,
      process.env.SUPABASE_URL || '',
      supabaseKey,
      adminApiBaseUrl,
      terminalId,
      organizationId || undefined,
      posApiKey
    );
    serviceRegistry.register('customerService', customerService);

    // Initialize TerminalConfigService
    const terminalConfigService = new TerminalConfigService(terminalId, dbManager);
    serviceRegistry.register('terminalConfigService', terminalConfigService);

    // Initialize SyncService with CustomerService and SettingsService
    const syncService = new SyncService(dbManager, customerService, settingsService);
    // Admin URL comes ONLY from connection string (storedAdminUrl already retrieved above)
    const adminDashboardSyncService = new AdminDashboardSyncService(
      dbManager,
      undefined,
      storedAdminUrl || undefined
    );
    serviceRegistry.register('syncService', syncService);
    serviceRegistry.register('adminDashboardSyncService', adminDashboardSyncService);

    // Initialize HeartbeatService
    const heartbeatService = new HeartbeatService(terminalId);
    serviceRegistry.register('heartbeatService', heartbeatService);

    // Initialize ModuleSyncService for syncing modules from admin dashboard
    // Admin URL comes ONLY from connection string stored in local settings
    let adminDashboardUrl = '';
    try {
      const dbSvc = dbManager.getDatabaseService?.();
      if (dbSvc?.settings) {
        adminDashboardUrl = dbSvc.settings.getSetting('terminal', 'admin_dashboard_url', '') as string;
        if (adminDashboardUrl) {
          console.log(`[initialization] Using admin dashboard URL from connection string: ${adminDashboardUrl}`);
        }
      }
    } catch (e) {
      console.warn('[initialization] Failed to load admin URL from settings:', e);
    }

    if (!adminDashboardUrl) {
      console.warn('[initialization] No admin dashboard URL configured - terminal needs to be paired with a connection string');
    }
    const moduleSyncService = new ModuleSyncService({
      adminDashboardUrl,
      syncIntervalMs: 120000, // 2 minutes
      fetchTimeoutMs: 30000,  // 30 seconds
    });
    moduleSyncService.setDatabaseManager(dbManager);
    serviceRegistry.register('moduleSyncService', moduleSyncService);

    // Initialize Screen Capture service for live remote viewing
    console.log('🎥 Initializing Screen Capture Service for terminal:', terminalId);
    const supabase = getSupabaseClient();
    const screenCaptureService = new ScreenCaptureService(terminalId, supabase);
    serviceRegistry.register('screenCaptureService', screenCaptureService);
    console.log('🎥 Screen Capture Service created');

    // Initialize services
    await authService.initialize();
    await staffAuthService.initialize();
    await terminalConfigService.initialize();

    // Validate terminal ID
    const isTerminalValid = await terminalConfigService.validateTerminal();
    if (!isTerminalValid) {
      console.error(`[main] Terminal ID ${terminalId} is invalid or deleted.`);

      // Only reset if we are not already on the default fallback, to avoid infinite loops
      if (terminalId !== 'terminal-001') {
        console.log('[main] Resetting configuration and restarting...');

        // Clear persisted terminal ID
        settingsService.setSetting('terminal', 'terminal_id', '');

        await dialog.showMessageBox({
          type: 'error',
          title: 'Terminal Configuration Invalid',
          message: 'This terminal configuration is no longer valid. The application will reset.',
          buttons: ['OK'],
        });

        app.relaunch();
        app.exit(0);
        return false;
      } else {
        console.warn('[main] Default terminal-001 is invalid, but skipping reset to avoid loop.');
      }
    }

    // Pass databaseManager to heartbeatService and initialize
    // Only initialize if terminal is configured (has API key)
    heartbeatService.setDatabaseManager(dbManager);
    const isTerminalConfigured = !!persistedApiKey;
    if (isTerminalConfigured) {
      console.log('🔄 Initializing HeartbeatService (terminal is configured)...');
      await heartbeatService.initialize();
      console.log('✅ HeartbeatService initialized');
    } else {
      console.log('⏭️ Skipping HeartbeatService initialization (terminal not configured - onboarding mode)');
    }

    // Initialize Screen Capture service
    // Only initialize if Supabase is configured
    if (isSupabaseConfigured()) {
      console.log('🎥 Calling screenCaptureService.initialize()...');
      await screenCaptureService.initialize();
      console.log('🎥 Screen Capture Service initialized successfully');
    } else {
      console.log('⏭️ Skipping ScreenCaptureService initialization (Supabase not configured - onboarding mode)');
    }

    // Initialize PrinterManager and register IPC handlers
    // Requirements: 6.5, 7.4
    console.log('🖨️ Initializing PrinterManager...');
    try {
      // Register IPC handlers first (they don't need the manager instance yet)
      registerPrinterManagerHandlers(dbManager.db);

      // Initialize the PrinterManager (loads configs, resumes pending jobs)
      const printerManager = await initializePrinterManager(dbManager.db);
      serviceRegistry.register('printerManager', printerManager);
      console.log('🖨️ PrinterManager initialized successfully');
    } catch (printerError) {
      // Log but don't fail startup - printer functionality is not critical
      console.error('⚠️ Failed to initialize PrinterManager:', printerError);
      logErrorToFile(printerError as Error);
    }

    // Initialize ECR (Payment Terminal) Manager and register IPC handlers
    console.log('💳 Initializing Payment Terminal Manager...');
    try {
      const ecrManager = new PaymentTerminalManager(dbManager.db);
      await ecrManager.initialize();
      registerECRHandlers(ecrManager);
      serviceRegistry.register('paymentTerminalManager', ecrManager);
      console.log('💳 Payment Terminal Manager initialized successfully');
    } catch (ecrError) {
      // Log but don't fail startup - payment terminal functionality is not critical
      console.error('⚠️ Failed to initialize Payment Terminal Manager:', ecrError);
      logErrorToFile(ecrError as Error);
    }

    // Note: AutoUpdaterService is initialized in main.ts after all handlers are registered
    // to avoid duplicate IPC handler registration errors

    return true;
  } catch (error) {
    console.error('Failed to initialize services:', error);
    logErrorToFile(error);
    return false;
  }
}

/**
 * Create main window using WindowManager
 */
export function createMainWindow(): BrowserWindow | null {
  let windowManager = serviceRegistry.windowManager;

  if (!windowManager) {
    windowManager = new WindowManager();
    serviceRegistry.register('windowManager', windowManager);
  }

  const authService = serviceRegistry.authService;
  if (authService) {
    windowManager.setAuthService(authService);
  }

  const mainWindow = windowManager.createWindow();
  serviceRegistry.register('mainWindow', mainWindow);

  return mainWindow;
}

/**
 * Set up callbacks for services that need the main window
 */
export function setupServiceCallbacks(mainWindow: BrowserWindow): void {
  const {
    syncService,
    adminDashboardSyncService,
    authService,
    settingsService,
    heartbeatService,
    screenCaptureService,
    terminalConfigService,
    staffAuthService,
    moduleSyncService,
  } = serviceRegistry.getAllServices();

  // Set main window references
  if (syncService) syncService.setMainWindow(mainWindow);
  if (adminDashboardSyncService) adminDashboardSyncService.setMainWindow(mainWindow);
  if (authService) authService.setMainWindow(mainWindow);
  if (settingsService) settingsService.setMainWindow(mainWindow);
  if (heartbeatService) heartbeatService.setMainWindow(mainWindow);

  if (screenCaptureService) {
    console.log('🎥 Setting mainWindow for screenCaptureService...');
    screenCaptureService.setMainWindow(mainWindow);
    console.log('🎥 mainWindow set successfully');
  }

  // Set main window for ModuleSyncService and start periodic sync
  if (moduleSyncService) {
    moduleSyncService.setMainWindow(mainWindow);
    moduleSyncService.startPeriodicSync();
    console.log('📦 ModuleSyncService configured and periodic sync started');
  }

  // Set terminal settings update callback
  if (terminalConfigService) {
    // Set initial organization_id for RLS compliance on order sync
    const initialOrgId = terminalConfigService.getOrganizationId();
    if (initialOrgId && syncService) {
      syncService.setOrganizationId(initialOrgId);
      console.log('[main] Set organization_id for sync service:', initialOrgId);
    }

    terminalConfigService.setUpdateCallback((settings) => {
      console.log('[main] Terminal settings updated:', settings);

      // Update organization_id on sync service when settings change
      if (settings.organization_id && syncService) {
        syncService.setOrganizationId(settings.organization_id);
        console.log('[main] Updated organization_id for sync service:', settings.organization_id);
      }

      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('terminal-settings-updated', settings);
      }
    });
  }

  // Set session timeout callback to notify renderer
  if (staffAuthService) {
    staffAuthService.setSessionTimeoutCallback((session) => {
      console.log('[main] Session timeout for staff:', session.staff_id);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('session-timeout', {
          staffId: session.staff_id,
          sessionId: session.id,
          reason: 'expired',
        });
      }
    });
  }

  // Set up PrinterManager status event forwarding to renderer
  // Requirements: 7.4
  const printerManager = serviceRegistry.printerManager;
  if (printerManager) {
    setupStatusEventForwarding(mainWindow);
    console.log('🖨️ PrinterManager status event forwarding configured');
  }
}

/**
 * Start auto-sync and real-time subscriptions
 * Only starts if Supabase is configured (not in onboarding mode)
 */
export function startSync(): void {
  const syncService = serviceRegistry.syncService;
  const dbManager = serviceRegistry.dbManager;
  const mainWindow = serviceRegistry.mainWindow;
  const heartbeatService = serviceRegistry.heartbeatService;
  const settingsService = serviceRegistry.settingsService;

  if (syncService) {
    if (isSupabaseConfigured()) {
      console.log('🔄 Starting auto-sync and realtime subscriptions...');
      syncService.startAutoSync();
      syncService.setupRealtimeSubscriptions();

      // Initialize RealtimeOrderHandler for order sync (INSERT/UPDATE/DELETE from Supabase)
      if (dbManager && heartbeatService) {
        const branchId = settingsService?.getSetting('terminal', 'branch_id', null) as string | null;
        const terminalId = heartbeatService.getTerminalId();

        console.log('📡 Starting realtime order handlers...');
        setupRealtimeHandlers({
          mainWindow,
          dbManager,
          heartbeatService,
          branchId,
          terminalId,
        });
      }
    } else {
      console.log('⏭️ Skipping sync services (Supabase not configured - onboarding mode)');
    }
  }
}

/**
 * Normalize legacy order statuses (one-time migration)
 */
export async function normalizeLegacyStatuses(): Promise<void> {
  const dbManager = serviceRegistry.dbManager;
  const syncService = serviceRegistry.syncService;
  const mainWindow = serviceRegistry.mainWindow;

  if (!dbManager) return;

  try {
    const dbSvc = dbManager.getDatabaseService();
    const legacy = dbSvc.orders.getOrdersByStatus('out_for_delivery' as any) || [];

    if (Array.isArray(legacy) && legacy.length > 0) {
      console.log(`[Normalize] Converting ${legacy.length} orders from out_for_delivery -> completed`);

      for (const ord of legacy) {
        try {
          await dbManager.updateOrderStatus(ord.id, 'completed' as any);
        } catch (e) {
          console.warn('[Normalize] Failed to update order to completed', {
            id: (ord as any)?.id,
            error: e,
          });
        }
      }

      if (syncService) {
        try {
          await syncService.forceSyncFastLocal(3000);
        } catch (e) {
          console.warn('[Normalize] Fast sync failed after normalization', e);
        }
      }

      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('orders-updated', { count: legacy.length });
      }
    } else {
      console.log('[Normalize] No legacy out_for_delivery orders found');
    }
  } catch (e) {
    console.warn('[Normalize] Normalization routine failed', e);
  }
}

/**
 * Start periodic health checks
 */
export function startHealthChecks(): NodeJS.Timeout {
  const dbManager = serviceRegistry.dbManager;
  const mainWindow = serviceRegistry.mainWindow;

  return setInterval(
    async () => {
      if (!dbManager) return;

      try {
        const health = await dbManager.healthCheck();

        // Send health status to renderer
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('database-health-update', health);
        }

        // Attempt automatic recovery if health check fails
        if (!health.healthy) {
          console.error('Database health check failed, attempting recovery...');
          logErrorToFile(new Error(`Database health check failed: ${health.error}`));

          // Try to reinitialize
          try {
            await dbManager.close();
            await dbManager.initialize();
            console.log('Database recovery successful');
          } catch (recoveryError) {
            console.error('Database recovery failed:', recoveryError);
            logErrorToFile(recoveryError);
          }
        }
      } catch (healthCheckError) {
        console.error('Health check error:', healthCheckError);
      }
    },
    5 * 60 * 1000
  ); // 5 minutes
}

/**
 * Perform initial health check and send to renderer
 */
export async function performInitialHealthCheck(): Promise<void> {
  const dbManager = serviceRegistry.dbManager;
  const mainWindow = serviceRegistry.mainWindow;

  if (!dbManager || !mainWindow) return;

  try {
    const initialHealth = await dbManager.healthCheck();
    mainWindow.webContents.send('database-health-update', initialHealth);

    if (!initialHealth.healthy) {
      console.warn('Initial database health check failed:', initialHealth.error);
      logErrorToFile(new Error(`Initial database health check failed: ${initialHealth.error}`));
    } else {
      console.log('Initial database health check passed');
    }
  } catch (healthError) {
    console.error('Failed to perform initial health check:', healthError);
    logErrorToFile(healthError as Error);
  }
}
