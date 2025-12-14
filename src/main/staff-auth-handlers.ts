import { ipcMain } from 'electron';
import StaffAuthService from './staff-auth-service';

interface StaffAuthHandlerDeps {
  staffAuthService: StaffAuthService;
}

/**
 * Registers staff-auth:* IPC handlers.
 *
 * Extracted from main.ts to reduce main-process bloat and keep staff auth
 * concerns encapsulated.
 */
export function registerStaffAuthHandlers({ staffAuthService }: StaffAuthHandlerDeps): void {
  ipcMain.handle('staff-auth:authenticate-pin', async (_event, pin: string, staffId?: string, terminalId?: string, branchId?: string) => {
    try {
      return await staffAuthService.authenticateWithPIN(pin, staffId, terminalId, branchId);
    } catch (error) {
      console.error('Staff auth PIN error:', error);
      return { success: false, error: 'Authentication failed' };
    }
  });

  ipcMain.handle('staff-auth:get-session', async () => {
    try {
      return await staffAuthService.getCurrentSession();
    } catch (error) {
      console.error('Staff auth get session error:', error);
      return null;
    }
  });

  ipcMain.handle('staff-auth:get-current', async () => {
    try {
      return await staffAuthService.getCurrentStaff();
    } catch (error) {
      console.error('Staff auth get current error:', error);
      return null;
    }
  });

  ipcMain.handle('staff-auth:has-permission', async (_event, permission: string) => {
    try {
      return await staffAuthService.hasPermission(permission);
    } catch (error) {
      console.error('Staff auth has permission error:', error);
      return false;
    }
  });

  ipcMain.handle('staff-auth:has-any-permission', async (_event, permissions: string[]) => {
    try {
      return await staffAuthService.hasAnyPermission(permissions);
    } catch (error) {
      console.error('Staff auth has any permission error:', error);
      return false;
    }
  });

  ipcMain.handle('staff-auth:logout', async () => {
    try {
      return await staffAuthService.logout();
    } catch (error) {
      console.error('Staff auth logout error:', error);
      return { success: false, error: 'Logout failed' };
    }
  });

  ipcMain.handle('staff-auth:validate-session', async () => {
    try {
      return await staffAuthService.validateSession();
    } catch (error) {
      console.error('Staff auth validate session error:', error);
      return { valid: false };
    }
  });

  ipcMain.handle('staff-auth:track-activity', async (_event, activityType: string, resourceType: string | null, resourceId: string | null, action: string, details?: Record<string, any>, result?: string) => {
    try {
      return await staffAuthService.trackActivity(activityType, resourceType, resourceId, action, details, result);
    } catch (error) {
      console.error('Staff auth track activity error:', error);
      return { success: false };
    }
  });
}

