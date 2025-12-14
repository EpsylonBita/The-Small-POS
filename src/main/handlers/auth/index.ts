/**
 * Authentication Handlers Index
 *
 * Exports all authentication-related IPC handler registrations.
 */

import { registerAuthHandlers } from './auth-handlers';
import { registerStaffAuthHandlers } from './staff-auth-handlers';

export {
  registerAuthHandlers,
  registerStaffAuthHandlers,
};

/**
 * Register all authentication handlers
 *
 * This function registers all auth-related IPC handlers using the serviceRegistry
 * for dependency access. No explicit dependencies need to be passed.
 */
export function registerAllAuthHandlers(): void {
  registerAuthHandlers();
  registerStaffAuthHandlers();

  console.log('[AuthHandlers] ✅ All auth handlers registered');
}
