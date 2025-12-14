/**
 * Driver Handlers Module
 *
 * Handles driver earnings IPC.
 */

import { ipcMain } from 'electron';
import { serviceRegistry } from '../service-registry';

/**
 * Register driver-related IPC handlers
 */
export function registerDriverHandlers(): void {
  // Driver earnings handlers
  ipcMain.handle(
    'driver:record-earning',
    async (
      event,
      params: {
        driverId: string;
        shiftId: string;
        orderId: string;
        deliveryFee: number;
        tipAmount: number;
        paymentMethod: 'cash' | 'card' | 'mixed';
        cashCollected: number;
        cardAmount: number;
      }
    ) => {
      try {
        const dbManager = serviceRegistry.dbManager;
        if (!dbManager) {
          return { success: false, error: 'Database not initialized' };
        }
        const result = dbManager.staff.recordDriverEarning(params);
        return result;
      } catch (error) {
        console.error('Record driver earning error:', error);
        return { success: false, error: (error as Error).message };
      }
    }
  );

  ipcMain.handle('driver:get-earnings', async (event, shiftId: string) => {
    try {
      const dbManager = serviceRegistry.dbManager;
      if (!dbManager) {
        return [];
      }
      const earnings = dbManager.staff.getDriverEarnings(shiftId);
      return earnings;
    } catch (error) {
      console.error('Get driver earnings error:', error);
      return [];
    }
  });

  ipcMain.handle('driver:get-shift-summary', async (event, shiftId: string) => {
    try {
      const dbManager = serviceRegistry.dbManager;
      if (!dbManager) {
        return null;
      }
      const summary = dbManager.staff.getDriverShiftSummary(shiftId);
      return summary;
    } catch (error) {
      console.error('Get driver shift summary error:', error);
      return null;
    }
  });

  ipcMain.handle('driver:get-active', async (event, branchId: string) => {
    try {
      const dbManager = serviceRegistry.dbManager;
      if (!dbManager) {
        return { success: false, error: 'Database not initialized', data: [] };
      }
      const drivers = await dbManager.staff.getActiveDrivers(branchId);
      return { success: true, data: drivers };
    } catch (error) {
      console.error('Get active drivers error:', error);
      return { success: false, error: 'Failed to get active drivers', data: [] };
    }
  });

  // Alias handler: drivers:get-active (used by renderer hook)
  // This uses raw SQL query for compatibility with existing renderer code
  ipcMain.handle('drivers:get-active', async (_event, branchId?: string) => {
    try {
      const dbManager = serviceRegistry.dbManager;
      if (!dbManager) {
        return { success: false, error: 'Database not initialized' };
      }
      const params: any[] = [];
      let sql = `
        SELECT
          id AS shiftId,
          staff_id AS id,
          COALESCE(check_in_time, start_time) AS checkInTime
        FROM staff_shifts
        WHERE status = 'active' AND role_type = 'driver'
      `;
      if (branchId) {
        sql += ' AND branch_id = ?';
        params.push(branchId);
      }
      const rows = await dbManager.executeQuery(sql, params);
      const drivers = Array.isArray(rows)
        ? rows.map((r: any) => ({
            id: r.id || r.staff_id || r.shiftId,
            shiftId: r.shiftId || r.id,
            status: 'available',
            checkInTime: r.checkInTime || new Date().toISOString(),
          }))
        : [];
      return { success: true, data: drivers };
    } catch (error) {
      console.error('Get active drivers error:', error);
      return { success: false, error: 'Failed to fetch active drivers' };
    }
  });
}
