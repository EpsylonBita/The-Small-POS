import { ipcMain } from 'electron';
import * as bcrypt from 'bcryptjs';
import { serviceRegistry } from '../../service-registry';
import { handleIPCError, IPCError } from '../utils';

export function registerAuthHandlers(): void {
  // Remove existing handlers to prevent double registration
  const handlers = [
    'auth:login',
    'auth:logout',
    'auth:get-current-session',
    'auth:validate-session',
    'auth:has-permission',
    'auth:get-session-stats',
    'auth:setup-pin',
  ];
  handlers.forEach(handler => ipcMain.removeHandler(handler));

  // Login with staff PIN / ID
  ipcMain.handle('auth:login', async (_event, { pin, staffId }) => {
    return handleIPCError(async () => {
      console.log('[auth:login] IPC handler called - PIN empty:', pin === '', 'staffId:', staffId);
      const authService = serviceRegistry.requireService('authService');

      const result = await authService.login(pin, staffId);
      console.log('[auth:login] AuthService.login result:', JSON.stringify(result, null, 2));

      if (!result.success) {
        throw new IPCError(result.error || 'Login failed');
      }

      console.log('[auth:login] Login successful, building user response object...');

      // Get terminal settings from service registry
      const terminalConfigService = serviceRegistry.get('terminalConfigService');
      const settingsService = serviceRegistry.get('dbManager')?.getDatabaseService?.()?.settings;

      // Get branchId and terminalId from settings
      const terminalId = settingsService?.getSetting<string>('terminal', 'terminal_id', '')
        || terminalConfigService?.getTerminalId()
        || process.env.TERMINAL_ID
        || 'terminal-001';

      const branchId = terminalConfigService?.getBranchId()
        || settingsService?.getSetting<string>('terminal', 'branch_id', '')
        || process.env.DEFAULT_BRANCH_ID
        || null;

      // Return user data (wrapper adds success: true)
      const userData = {
        user: {
          staffId: result.staffId,
          staffName: result.role === 'admin' ? 'Administrator' : 'Staff',
          sessionId: result.sessionId,
          role: {
            name: result.role,
            permissions: result.role === 'admin'
              ? ['view_orders', 'update_order_status', 'create_order', 'delete_order', 'view_reports', 'manage_staff', 'system_settings', 'force_sync']
              : ['view_orders', 'update_order_status', 'create_order']
          },
          branchId,
          terminalId,
        }
      };
      console.log('[auth:login] Returning success response with user:', JSON.stringify(userData.user, null, 2));
      return userData;
    }, 'auth:login');
  });

  // Logout current session
  ipcMain.handle('auth:logout', async () => {
    return handleIPCError(async () => {
      const authService = serviceRegistry.requireService('authService');
      await authService.logout();
    }, 'auth:logout');
  });

  // Get current session
  ipcMain.handle('auth:get-current-session', async () => {
    return handleIPCError(async () => {
      const authService = serviceRegistry.requireService('authService');
      return await authService.getCurrentSession();
    }, 'auth:get-current-session');
  });

  // Validate a given session ID
  ipcMain.handle('auth:validate-session', async (_event, { sessionId }) => {
    return handleIPCError(async () => {
      const authService = serviceRegistry.requireService('authService');
      const isValid = await authService.validateSession(sessionId);
      return { isValid };
    }, 'auth:validate-session');
  });

  // Check permission for a given action
  ipcMain.handle('auth:has-permission', async (_event, { action }) => {
    return handleIPCError(async () => {
      const authService = serviceRegistry.requireService('authService');
      const hasPermission = await authService.hasPermission(action);
      return { hasPermission };
    }, 'auth:has-permission');
  });

  // Aggregate session statistics for admin views
  ipcMain.handle('auth:get-session-stats', async () => {
    return handleIPCError(async () => {
      const authService = serviceRegistry.requireService('authService');
      return await authService.getSessionStats();
    }, 'auth:get-session-stats');
  });

  // Setup PIN for first-time use (called from login page)
  ipcMain.handle('auth:setup-pin', async (_event, { adminPin, staffPin }) => {
    return handleIPCError(async () => {
      console.log('[auth:setup-pin] Setting up PINs...');

      const settingsService = serviceRegistry.get('settingsService');
      if (!settingsService) {
        throw new IPCError('Settings service not available');
      }

      // Validate PINs
      if (!adminPin || adminPin.length < 6 || !/^\d+$/.test(adminPin)) {
        throw new IPCError('Admin PIN must be at least 6 digits');
      }
      if (!staffPin || staffPin.length < 6 || !/^\d+$/.test(staffPin)) {
        throw new IPCError('Staff PIN must be at least 6 digits');
      }

      // Hash the PINs with bcrypt
      const BCRYPT_ROUNDS = 10;
      const adminPinHash = await bcrypt.hash(adminPin, BCRYPT_ROUNDS);
      const staffPinHash = await bcrypt.hash(staffPin, BCRYPT_ROUNDS);

      // Save hashed PINs to settings
      settingsService.setSetting('staff', 'admin_pin_hash', adminPinHash);
      settingsService.setSetting('staff', 'staff_pin_hash', staffPinHash);
      settingsService.setSetting('terminal', 'pin_reset_required', false);

      // Best-effort: clear reset flag in Admin Dashboard
      try {
        const adminSync = serviceRegistry.get('adminDashboardSyncService');
        if (adminSync) {
          const result = await adminSync.pushSettingsToAdmin('terminal', { pin_reset_required: false }, true);
          if (!result?.success) {
            console.warn('[auth:setup-pin] Failed to clear pin_reset_required in admin:', result?.error);
          }
        }
      } catch (err) {
        console.warn('[auth:setup-pin] Admin reset flag sync failed:', err);
      }

      console.log('[auth:setup-pin] PINs configured successfully');
      return { success: true };
    }, 'auth:setup-pin');
  });
}
