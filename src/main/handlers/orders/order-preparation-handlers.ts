import { ipcMain } from 'electron';
import { serviceRegistry } from '../../service-registry';

export function registerOrderPreparationHandlers(): void {
  const dbManager = serviceRegistry.dbManager;
  const authService = serviceRegistry.authService;
  const staffAuthService = serviceRegistry.staffAuthService;
  const mainWindow = serviceRegistry.mainWindow;

  if (!dbManager || !authService || !staffAuthService) {
    console.error('[OrderPreparationHandlers] Required services not initialized');
    return;
  }

  ipcMain.handle(
    'order:update-preparation',
    async (_event, orderId: string, stage: string, progress: number, message?: string) => {
      try {
        const hasPermission =
          (await staffAuthService.hasPermission('update_order_status')) ||
          (await authService.hasPermission('update_order_status'));
        if (!hasPermission) {
          return { success: false, error: 'Insufficient permissions' };
        }

        const order = await dbManager.getOrderById(orderId);
        if (!order) {
          return { success: false, error: 'Order not found' };
        }

        let estimatedCompletion: string | null = null;
        if (order.estimated_time && progress < 100) {
          const remainingMinutes = Math.ceil((order.estimated_time * (100 - progress)) / 100);
          estimatedCompletion = new Date(Date.now() + remainingMinutes * 60000).toISOString();
        }

        const success = await dbManager.executeQuery(
          `INSERT OR REPLACE INTO order_preparation_progress (
            order_id,
            stage,
            progress,
            estimated_completion,
            message,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?)`,
          [orderId, stage, progress, estimatedCompletion, message || null, new Date().toISOString()],
        );

        if (!success) {
          return { success: false, error: 'Failed to update preparation progress' };
        }

        const currentMainWindow = serviceRegistry.mainWindow;
        if (currentMainWindow && !currentMainWindow.isDestroyed()) {
          currentMainWindow.webContents.send('preparation-progress-updated', {
            orderId,
            stage,
            progress,
            estimatedCompletion,
            message,
          });
        }

        return { success: true, data: { orderId, stage, progress, estimatedCompletion } };
      } catch (error) {
        console.error('Failed to update preparation progress:', error);
        return { success: false, error: 'Failed to update preparation progress' };
      }
    },
  );
}
