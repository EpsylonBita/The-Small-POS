/**
 * Dashboard Metrics Handlers
 *
 * Provides IPC handlers for dashboard metrics used by Service and Product dashboards.
 * These handlers return placeholder/fallback responses until the underlying services
 * (appointments, rooms, inventory) are fully implemented.
 *
 * The dashboards are designed to fall back to deriving metrics from orders when
 * these APIs return { success: false }.
 */

import { ipcMain } from 'electron';

/**
 * Response shape for dashboard metrics
 */
interface DashboardMetricsResponse {
  success: boolean;
  notImplemented?: boolean;
  message?: string;
  [key: string]: unknown;
}

/**
 * Register all dashboard metrics IPC handlers
 *
 * These handlers provide metrics data for:
 * - Service Dashboard (appointments, rooms)
 * - Product Dashboard (inventory, product catalog)
 *
 * Note: These are placeholder implementations. The dashboards fall back to
 * deriving metrics from the order store when these return { success: false }.
 */
export function registerDashboardMetricsHandlers(): void {
  console.log('[DashboardMetrics] Registering dashboard metrics handlers...');

  // =============================================
  // APPOINTMENTS METRICS (Service Dashboard)
  // =============================================

  /**
   * Get today's appointment metrics
   * Used by ServiceDashboard for appointments card
   *
   * Note: Appointments service not yet implemented.
   * Dashboard falls back to deriving from orders.
   */
  ipcMain.handle(
    'appointments:get-today-metrics',
    async (): Promise<DashboardMetricsResponse> => {
      // Return not implemented - dashboard will derive from orders
      return {
        success: false,
        notImplemented: true,
        message: 'Appointments service not yet implemented. Metrics derived from orders.',
        scheduled: 0,
        completed: 0,
        canceled: 0,
      };
    }
  );

  // =============================================
  // ROOMS METRICS (Service Dashboard - Hotel)
  // =============================================

  /**
   * Get room availability
   * Used by ServiceDashboard for rooms card (hotel business type)
   *
   * Note: Rooms service not yet implemented.
   */
  ipcMain.handle(
    'rooms:get-availability',
    async (): Promise<DashboardMetricsResponse> => {
      // Rooms service not yet implemented
      return {
        success: false,
        notImplemented: true,
        message: 'Rooms service not yet implemented',
        available: 0,
        total: 0,
      };
    }
  );

  // =============================================
  // INVENTORY METRICS (Product Dashboard)
  // =============================================

  /**
   * Get stock metrics
   * Used by ProductDashboard for inventory status
   *
   * Note: Inventory service not yet implemented.
   */
  ipcMain.handle(
    'inventory:get-stock-metrics',
    async (): Promise<DashboardMetricsResponse> => {
      // Inventory service not yet implemented
      return {
        success: false,
        notImplemented: true,
        message: 'Inventory service not yet implemented',
        inStock: 0,
        lowStock: 0,
        outOfStock: 0,
      };
    }
  );

  // =============================================
  // PRODUCT CATALOG METRICS (Product Dashboard)
  // =============================================

  /**
   * Get product catalog count
   * Used by ProductDashboard for products in stock card
   *
   * Note: Product catalog service not yet implemented.
   */
  ipcMain.handle(
    'products:get-catalog-count',
    async (): Promise<DashboardMetricsResponse> => {
      // Product catalog service not yet implemented
      return {
        success: false,
        notImplemented: true,
        message: 'Product catalog service not yet implemented',
        total: 0,
      };
    }
  );

  console.log('[DashboardMetrics] ✅ Dashboard metrics handlers registered');
}

export default registerDashboardMetricsHandlers;
