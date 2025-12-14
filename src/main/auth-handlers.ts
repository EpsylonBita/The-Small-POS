import { ipcMain } from 'electron';
import { AuthService } from './auth-service';
import { serviceRegistry } from './service-registry';

/**
 * Registers authentication-related IPC handlers.
 *
 * This was extracted from main.ts to keep the main process bootstrap slim.
 */
export function registerAuthHandlers(authService: AuthService): void {
  // Login with staff PIN / ID
  ipcMain.handle('auth:login', async (_event, { pin, staffId }) => {
    console.log('[auth:login] IPC handler called - PIN empty:', pin === '', 'PIN value:', pin === '' ? '(empty)' : '(provided)', 'staffId:', staffId);
    try {
      const result = await authService.login(pin, staffId);
      console.log('[auth:login] AuthService.login result:', JSON.stringify(result, null, 2));

      if (result.success) {
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

        // Return in the format expected by App.tsx
        const response = {
          success: true,
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
        console.log('[auth:login] Returning success response with user:', JSON.stringify(response.user, null, 2));
        return response;
      }

      console.log('[auth:login] Returning non-success result:', JSON.stringify(result, null, 2));
      return result;
    } catch (error) {
      console.error('[auth:login] Caught exception:', error);
      return { success: false, error: 'Login failed' };
    }
  });

  // Logout current session
  ipcMain.handle('auth:logout', async () => {
    try {
      await authService.logout();
      return { success: true };
    } catch (error) {
      console.error('Auth logout error:', error);
      return { success: false, error: 'Logout failed' };
    }
  });

  // Get current session
  ipcMain.handle('auth:get-current-session', async () => {
    try {
      const session = await authService.getCurrentSession();
      return session;
    } catch (error) {
      console.error('Get session error:', error);
      return null;
    }
  });

  // Validate a given session ID
  ipcMain.handle('auth:validate-session', async (_event, { sessionId }) => {
    try {
      const isValid = await authService.validateSession(sessionId);
      return { isValid };
    } catch (error) {
      console.error('Validate session error:', error);
      return { isValid: false };
    }
  });

  // Check permission for a given action
  ipcMain.handle('auth:has-permission', async (_event, { action }) => {
    try {
      const hasPermission = await authService.hasPermission(action);
      return { hasPermission };
    } catch (error) {
      console.error('Check permission error:', error);
      return { hasPermission: false };
    }
  });

  // Aggregate session statistics for admin views
  ipcMain.handle('auth:get-session-stats', async () => {
    try {
      const stats = await authService.getSessionStats();
      return stats;
    } catch (error) {
      console.error('Get session stats error:', error);
      return null;
    }
  });
}

