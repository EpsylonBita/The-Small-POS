/**
 * Order Retry Queue Handlers
 *
 * Handles order retry queue operations for offline resilience.
 * Uses serviceRegistry for dependency access.
 */

import { ipcMain } from 'electron';
import { serviceRegistry } from '../../service-registry';
import { withTimeout } from '../../../shared/utils/error-handler';
import { TIMING } from '../../../shared/constants';

// In-memory retry queue
let retryQueue: any[] = [];

export function registerOrderRetryHandlers(): void {
  // Remove existing handlers to prevent double registration
  const handlers = [
    'order:save-for-retry',
    'order:get-retry-queue',
    'order:process-retry-queue',
  ];
  handlers.forEach(handler => ipcMain.removeHandler(handler));

  // Save order for retry
  ipcMain.handle('order:save-for-retry', async (_event, orderData) => {
    try {
      // Add timestamp and retry count
      const retryItem = {
        ...orderData,
        savedAt: new Date().toISOString(),
        retryCount: 0,
        id: `retry-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      };

      retryQueue.push(retryItem);

      return { success: true, queueLength: retryQueue.length };
    } catch (error) {
      console.error('Failed to save order for retry:', error);
      return { success: false, error: 'Failed to save order for retry' };
    }
  });

  // Get retry queue
  ipcMain.handle('order:get-retry-queue', async () => {
    try {
      return { success: true, queue: retryQueue };
    } catch (error) {
      console.error('Failed to get retry queue:', error);
      return { success: false, error: 'Failed to get retry queue', queue: [] };
    }
  });

  // Process retry queue
  ipcMain.handle('order:process-retry-queue', async () => {
    try {
      const dbManager = serviceRegistry.requireService('dbManager');
      const results: any[] = [];
      const failedItems: any[] = [];

      for (const item of retryQueue) {
        try {
          // Transform frontend data to database schema
          // Extract delivery address fields from item or nested address object
          const dbOrderData = {
            customer_name: item.customerName,
            items: item.items,
            total_amount: item.totalAmount || 0,
            status: item.status || 'pending',
            order_type: item.orderType,
            customer_phone: item.customerPhone,
            customer_email: item.customerEmail,
            table_number: item.tableNumber,
            // Full delivery address fields - extract from item or nested address object
            delivery_address: item.deliveryAddress || item.address?.street_address,
            delivery_city: item.deliveryCity || item.address?.city,
            delivery_postal_code: item.deliveryPostalCode || item.address?.postal_code,
            delivery_floor: item.deliveryFloor || item.address?.floor,
            delivery_notes: item.deliveryNotes || item.address?.delivery_notes,
            name_on_ringer: item.nameOnRinger || item.address?.name_on_ringer,
            special_instructions: item.notes,
            estimated_time: item.estimatedTime,
            payment_status: item.paymentStatus,
            payment_method: item.paymentMethod,
            payment_transaction_id: item.paymentTransactionId,
          };

          const createdOrder = await withTimeout(
            dbManager.insertOrder(dbOrderData),
            TIMING.ORDER_CREATE_TIMEOUT,
            'Retry order creation',
          );

          results.push({ id: item.id, success: true, orderId: createdOrder?.id });
        } catch (error) {
          item.retryCount = (item.retryCount || 0) + 1;

          // Keep in queue if retry count < 3
          if (item.retryCount < 3) {
            failedItems.push(item);
          }

          results.push({ id: item.id, success: false, error: (error as Error).message });
        }
      }

      // Update retry queue with failed items
      retryQueue = failedItems;

      return { success: true, results, remainingInQueue: retryQueue.length };
    } catch (error) {
      console.error('Failed to process retry queue:', error);
      return { success: false, error: 'Failed to process retry queue' };
    }
  });
}

/**
 * Clear the retry queue (useful for testing or cleanup)
 */
export function clearRetryQueue(): void {
  retryQueue = [];
}

/**
 * Get current retry queue length
 */
export function getRetryQueueLength(): number {
  return retryQueue.length;
}
