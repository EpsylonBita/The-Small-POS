/**
 * Staff Authentication Handlers
 *
 * Handles staff authentication operations with Supabase integration.
 * Uses serviceRegistry for dependency access.
 */

import { ipcMain } from 'electron';
import { serviceRegistry } from '../../service-registry';
import { handleIPCError } from '../utils';

export function registerStaffAuthHandlers(): void {
  // Remove existing handlers to prevent double registration
  const handlers = [
    'staff-auth:authenticate-pin',
    'staff-auth:get-session',
    'staff-auth:get-current',
    'staff-auth:has-permission',
    'staff-auth:has-any-permission',
    'staff-auth:logout',
    'staff-auth:validate-session',
    'staff-auth:track-activity',
  ];
  handlers.forEach(handler => ipcMain.removeHandler(handler));

  // Authenticate with PIN
  ipcMain.handle('staff-auth:authenticate-pin', async (_event, pin: string, staffId?: string, terminalId?: string, branchId?: string) => {
    return handleIPCError(async () => {
      const staffAuthService = serviceRegistry.requireService('staffAuthService');
      const res = await staffAuthService.authenticateWithPIN(pin, staffId, terminalId, branchId);
      // staffAuthService.authenticateWithPIN returns complex object, but handleIPCError will wrap it in 'data'.
      // If the service returns { success, ... }, the response will be { success: true, data: { success: ... } }
      // Ideally we should normalize, but following pattern of "wrap body".
      return res;
    }, 'staff-auth:authenticate-pin');
  });

  // Get current session
  ipcMain.handle('staff-auth:get-session', async () => {
    return handleIPCError(async () => {
      const staffAuthService = serviceRegistry.requireService('staffAuthService');
      return staffAuthService.getCurrentSession();
    }, 'staff-auth:get-session');
  });

  // Get current staff member
  ipcMain.handle('staff-auth:get-current', async () => {
    return handleIPCError(async () => {
      const staffAuthService = serviceRegistry.requireService('staffAuthService');
      return await staffAuthService.getCurrentStaff();
    }, 'staff-auth:get-current');
  });

  // Check permission
  ipcMain.handle('staff-auth:has-permission', async (_event, permission: string) => {
    return handleIPCError(async () => {
      const staffAuthService = serviceRegistry.requireService('staffAuthService');
      return await staffAuthService.hasPermission(permission);
    }, 'staff-auth:has-permission');
  });

  // Check any permission
  ipcMain.handle('staff-auth:has-any-permission', async (_event, permissions: string[]) => {
    return handleIPCError(async () => {
      const staffAuthService = serviceRegistry.requireService('staffAuthService');
      return await staffAuthService.hasAnyPermission(permissions);
    }, 'staff-auth:has-any-permission');
  });

  // Logout
  ipcMain.handle('staff-auth:logout', async () => {
    return handleIPCError(async () => {
      const staffAuthService = serviceRegistry.requireService('staffAuthService');
      await staffAuthService.logout();
    }, 'staff-auth:logout');
  });

  // Validate session
  ipcMain.handle('staff-auth:validate-session', async () => {
    return handleIPCError(async () => {
      const staffAuthService = serviceRegistry.requireService('staffAuthService');
      return await staffAuthService.validateSession();
    }, 'staff-auth:validate-session');
  });

  // Track activity
  ipcMain.handle('staff-auth:track-activity', async (_event, activityType: string, resourceType: string | null, resourceId: string | null, action: string, details?: Record<string, any>, result?: string) => {
    return handleIPCError(async () => {
      const staffAuthService = serviceRegistry.requireService('staffAuthService');
      await staffAuthService.trackActivity(activityType, resourceType, resourceId, action, details, result);
    }, 'staff-auth:track-activity');
  });
}
