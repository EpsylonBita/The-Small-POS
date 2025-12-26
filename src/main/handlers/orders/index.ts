/**
 * Order Handlers Index
 *
 * Exports all order-related IPC handler registrations.
 */

import { registerOrderCrudHandlers } from './order-crud-handlers';
import { registerOrderStatusHandlers } from './order-status-handlers';
import { registerOrderWorkflowHandlers } from './order-workflow-handlers';
import { registerOrderRetryHandlers, clearRetryQueue, getRetryQueueLength } from './order-retry-handlers';
import { registerDiagnosticHandlers } from '../diagnostic-handlers';

export {
  registerOrderCrudHandlers,
  registerOrderStatusHandlers,
  registerOrderWorkflowHandlers,
  registerOrderRetryHandlers,
  clearRetryQueue,
  getRetryQueueLength,
};

/**
 * Register all order handlers
 *
 * This function registers all order-related IPC handlers using the serviceRegistry
 * for dependency access. No explicit dependencies need to be passed.
 */
export function registerOrderHandlers(): void {
  registerOrderCrudHandlers();
  registerOrderStatusHandlers();
  registerOrderWorkflowHandlers();
  registerOrderRetryHandlers();
  registerDiagnosticHandlers();

  console.log('[OrderHandlers] ✅ All order handlers registered');
}
