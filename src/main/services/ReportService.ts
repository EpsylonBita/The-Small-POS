import Database from 'better-sqlite3';
import { getSupabaseClient } from '../../shared/supabase-config';
import type { SettingsService } from './SettingsService';

export class ReportService {
  private settingsService: SettingsService | null = null;

  constructor(private db: Database.Database) { }

  /**
   * Set the SettingsService reference for accessing system settings
   * Must be called after DatabaseService initialization
   */
  setSettingsService(settingsService: SettingsService): void {
    this.settingsService = settingsService;
  }

  private toISODate(date?: string): string {
    return date || new Date().toISOString().slice(0, 10);
  }

  /**
   * Get the timestamp of the last committed Z-Report.
   * Returns null if no Z-Report has ever been committed (fresh install).
   */
  getLastZReportTimestamp(): string | null {
    if (this.settingsService) {
      return this.settingsService.getSetting<string>('system', 'last_z_report_timestamp') ?? null;
    }
    // Fallback: Query local_settings table directly if SettingsService not available
    const result = this.db.prepare(
      `SELECT setting_value FROM local_settings WHERE setting_category = 'system' AND setting_key = 'last_z_report_timestamp'`
    ).get() as { setting_value: string } | undefined;
    if (!result?.setting_value) return null;
    try {
      return JSON.parse(result.setting_value);
    } catch {
      return result.setting_value;
    }
  }

  /**
   * Get the period start timestamp for Z-Report filtering.
   * Returns last Z-Report timestamp or epoch start for first-run scenario.
   */
  private getPeriodStart(): string {
    return this.getLastZReportTimestamp() || '1970-01-01T00:00:00.000Z';
  }

  getTodayStatistics(branchId: string) {
    const today = this.toISODate();
    // Total orders today
    const totalRow = this.db.prepare(
      `SELECT COUNT(*) as totalOrders FROM orders WHERE created_at > ?`
    ).get(today) as any;

    // Completed orders stats - use status-based filtering for consistency
    const row = this.db.prepare(
      `SELECT COUNT(*) as completedOrders,
              COALESCE(SUM(total_amount), 0) as totalSales,
              COALESCE(AVG(total_amount), 0) as avgOrderValue
       FROM orders
       WHERE created_at > ? AND status NOT IN ('cancelled', 'canceled')`
    ).get(today) as any;

    const totalOrders = Number(totalRow?.totalOrders || 0);
    const completedOrders = Number(row?.completedOrders || 0);
    const completionRate = totalOrders > 0 ? Math.round((completedOrders / totalOrders) * 100) : 0;

    return {
      totalOrders,
      totalSales: Number(row?.totalSales || 0),
      avgOrderValue: Number(row?.avgOrderValue || 0),
      completionRate
    };
  }

  getSalesTrend(branchId: string, days: number) {
    const results: Array<{ date: string; orders: number; revenue: number; avgOrderValue: number }> = [];
    const today = new Date();
    for (let i = 0; i < days; i++) {
      const d = new Date(today);
      d.setDate(today.getDate() - i);
      const iso = d.toISOString().slice(0, 10);
      const row = this.db.prepare(
        `SELECT COUNT(*) as orders,
                COALESCE(SUM(total_amount), 0) as revenue,
                COALESCE(AVG(total_amount), 0) as avgOrderValue
         FROM orders WHERE created_at > ? AND status NOT IN ('cancelled', 'canceled')`
      ).get(iso) as any;
      results.push({
        date: iso,
        orders: Number(row?.orders || 0),
        revenue: Number(row?.revenue || 0),
        avgOrderValue: Number(row?.avgOrderValue || 0)
      });
    }
    // Return chronological ascending
    return results.sort((a, b) => a.date.localeCompare(b.date));
  }

  getTopItems(branchId: string, date?: string, limit: number = 5) {
    const targetDate = this.toISODate(date);
    // Fetch completed orders for the date, then aggregate items in JS (items is stored as JSON string)
    // Use status-based filtering for consistency
    const orders = this.db.prepare(
      `SELECT items FROM orders WHERE date(created_at, 'localtime') = ? AND status NOT IN ('cancelled', 'canceled')`
    ).all(targetDate) as Array<{ items: string }>;

    const itemMap = new Map<string, { quantity: number; revenue: number }>();
    for (const o of orders) {
      try {
        const items = JSON.parse(o.items || '[]');
        for (const it of items) {
          const name: string = it.name || it.title || 'Item';
          const qty: number = Number(it.quantity || 1);
          const price: number = Number(it.price || 0);
          const revenue = qty * price;
          const acc = itemMap.get(name) || { quantity: 0, revenue: 0 };
          acc.quantity += qty; acc.revenue += revenue; itemMap.set(name, acc);
        }
      } catch { }
    }

    const top = Array.from(itemMap.entries())
      .map(([name, v]) => ({ name, quantity: v.quantity, revenue: v.revenue }))
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, limit);
    return top;
  }

  /**
   * Get top-selling items from the last 7 days for the Featured/Selected category.
   * Used to dynamically populate the "Επιλεγμένα" menu category with best sellers.
   * @param branchId - Branch ID (for future multi-branch support)
   * @param limit - Number of items to return (default 20)
   * @returns Array of { menuItemId, name, totalQuantity, totalRevenue }
   */
  getWeeklyTopItems(branchId: string, limit: number = 20): Array<{
    menuItemId: string;
    name: string;
    totalQuantity: number;
    totalRevenue: number;
  }> {
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const startDate = sevenDaysAgo.toISOString().slice(0, 10);

    // Fetch completed orders from last 7 days
    const orders = this.db.prepare(
      `SELECT items FROM orders
       WHERE date(created_at, 'localtime') >= ?
       AND status NOT IN ('cancelled', 'canceled', 'pending')
       ORDER BY created_at DESC`
    ).all(startDate) as Array<{ items: string }>;

    const itemMap = new Map<string, { menuItemId: string; name: string; quantity: number; revenue: number }>();

    for (const order of orders) {
      try {
        const items = JSON.parse(order.items || '[]');
        for (const item of items) {
          // Extract menu item ID from various possible field names
          const menuItemId = item.menu_item_id || item.menuItemId || item.id || '';
          const name = item.name || item.title || 'Unknown';
          const qty = Number(item.quantity || 1);
          const price = Number(item.price || 0);

          // Use menuItemId as key if available, otherwise fall back to name
          const key = menuItemId || name;

          const existing = itemMap.get(key);
          if (existing) {
            existing.quantity += qty;
            existing.revenue += qty * price;
          } else {
            itemMap.set(key, { menuItemId, name, quantity: qty, revenue: qty * price });
          }
        }
      } catch { /* Skip malformed JSON */ }
    }

    // Sort by quantity sold (most popular) and return top N
    return Array.from(itemMap.values())
      .map(item => ({
        menuItemId: item.menuItemId,
        name: item.name,
        totalQuantity: item.quantity,
        totalRevenue: item.revenue
      }))
      .sort((a, b) => b.totalQuantity - a.totalQuantity)
      .slice(0, limit);
  }

  getDailyStaffPerformance(branchId: string, date?: string) {
    const targetDate = this.toISODate(date);
    // Basic aggregation from staff_shifts; join with orders by staff_shift_id when possible
    const shifts = this.db.prepare(
      `SELECT s.id as staff_shift_id, s.staff_id, s.staff_name, s.role_type,
              s.check_in_time, s.check_out_time
       FROM staff_shifts s
       WHERE date(s.check_in_time, 'localtime') = ? AND (s.branch_id IS NULL OR s.branch_id = s.branch_id)`
    ).all(targetDate) as any[];

    const perfMap = new Map<string, any>();

    for (const s of shifts) {
      const staffId = s.staff_id as string;
      const staffName = s.staff_name || staffId;

      // Calculate hours worked
      const checkIn = new Date(s.check_in_time);
      const checkOut = s.check_out_time ? new Date(s.check_out_time) : new Date();
      const hoursWorked = (checkOut.getTime() - checkIn.getTime()) / (1000 * 60 * 60);

      const base = perfMap.get(staffId) || { staffId, name: staffName, role: s.role_type, hours: 0, orders: 0, sales: 0, variance: 0, expenses: 0, deliveries: 0 };
      base.hours += hoursWorked;

      // Orders for shift - use status-based filtering
      const orderStats = this.db.prepare(
        `SELECT COUNT(*) as cnt, COALESCE(SUM(total_amount), 0) as sales
         FROM orders WHERE staff_shift_id = ? AND status NOT IN ('cancelled', 'canceled')`
      ).get(s.staff_shift_id) as any;
      base.orders += Number(orderStats?.cnt || 0);
      base.sales += Number(orderStats?.sales || 0);

      // Cash drawer variance if any
      const varianceRow = this.db.prepare(
        `SELECT COALESCE(variance_amount, 0) as var FROM cash_drawer_sessions WHERE staff_shift_id = ?`
      ).get(s.staff_shift_id) as any;
      base.variance += Number(varianceRow?.var || 0);

      // Expenses
      const expenseRow = this.db.prepare(
        `SELECT COALESCE(SUM(amount), 0) as total FROM shift_expenses WHERE staff_shift_id = ?`
      ).get(s.staff_shift_id) as any;
      base.expenses += Number(expenseRow?.total || 0);

      // Deliveries via driver_earnings
      const deliveriesRow = this.db.prepare(
        `SELECT COUNT(*) as cnt FROM driver_earnings WHERE staff_shift_id = ?`
      ).get(s.staff_shift_id) as any;
      base.deliveries += Number(deliveriesRow?.cnt || 0);

      perfMap.set(staffId, base);
    }

    // Return as array sorted by sales desc
    return Array.from(perfMap.values()).sort((a, b) => (b.sales || 0) - (a.sales || 0));
  }

  /**
   * Get hourly sales distribution for a specific date
   */
  getHourlySales(branchId: string, date?: string) {
    const targetDate = this.toISODate(date);
    const hourlyData: Array<{ hour: number; orders: number; revenue: number }> = [];

    for (let hour = 0; hour < 24; hour++) {
      const row = this.db.prepare(
        `SELECT COUNT(*) as orders,
                COALESCE(SUM(total_amount), 0) as revenue
         FROM orders
         WHERE created_at > ?
           AND CAST(strftime('%H', created_at) AS INTEGER) = ?
           AND status NOT IN ('cancelled', 'canceled')`
      ).get(targetDate, hour) as any;

      hourlyData.push({
        hour,
        orders: Number(row?.orders || 0),
        revenue: Number(row?.revenue || 0)
      });
    }

    return hourlyData;
  }

  /**
   * Get payment method breakdown for a specific date
   */
  getPaymentMethodBreakdown(branchId: string, date?: string) {
    const targetDate = this.toISODate(date);

    const cashRow = this.db.prepare(
      `SELECT COUNT(*) as count, COALESCE(SUM(total_amount), 0) as total
       FROM orders
       WHERE date(created_at, 'localtime') = ?
         AND payment_method = 'cash'
         AND status NOT IN ('cancelled', 'canceled')`
    ).get(targetDate) as any;

    const cardRow = this.db.prepare(
      `SELECT COUNT(*) as count, COALESCE(SUM(total_amount), 0) as total
       FROM orders
       WHERE date(created_at, 'localtime') = ?
         AND payment_method = 'card'
         AND status NOT IN ('cancelled', 'canceled')`
    ).get(targetDate) as any;

    return {
      cash: {
        count: Number(cashRow?.count || 0),
        total: Number(cashRow?.total || 0)
      },
      card: {
        count: Number(cardRow?.count || 0),
        total: Number(cardRow?.total || 0)
      }
    };
  }

  /**
   * Get order type breakdown (delivery vs in-store) for a specific date
   */
  getOrderTypeBreakdown(branchId: string, date?: string) {
    const targetDate = this.toISODate(date);

    const deliveryRow = this.db.prepare(
      `SELECT COUNT(*) as count, COALESCE(SUM(total_amount), 0) as total
       FROM orders
       WHERE date(created_at, 'localtime') = ?
         AND order_type = 'delivery'
         AND status NOT IN ('cancelled', 'canceled')`
    ).get(targetDate) as any;

    const instoreRow = this.db.prepare(
      `SELECT COUNT(*) as count, COALESCE(SUM(total_amount), 0) as total
       FROM orders
       WHERE date(created_at, 'localtime') = ?
         AND order_type IN ('dine-in','takeaway','pickup')
         AND status NOT IN ('cancelled', 'canceled')`
    ).get(targetDate) as any;

    return {
      delivery: {
        count: Number(deliveryRow?.count || 0),
        total: Number(deliveryRow?.total || 0)
      },
      instore: {
        count: Number(instoreRow?.count || 0),
        total: Number(instoreRow?.total || 0)
      }
    };
  }

  generateZReport(branchId: string, date?: string) {
    const targetDate = this.toISODate(date);
    // Period-based filtering: show all data since last Z-Report commit
    const periodStart = this.getPeriodStart();
    const hasBranch = Boolean(branchId);
    const branchFilter = hasBranch ? ' AND branch_id = ?' : '';
    const shiftIdSubquery = `SELECT id FROM staff_shifts WHERE check_in_time > ?${branchFilter}`;
    const shiftIdParams = hasBranch ? [periodStart, branchId] : [periodStart];
    const orderShiftFilter = hasBranch ? ` AND staff_shift_id IN (${shiftIdSubquery})` : '';
    const orderShiftParams = hasBranch ? [periodStart, ...shiftIdParams] : [periodStart];
    console.log('[generateZReport] Starting with periodStart:', periodStart, 'branchId:', branchId);

    // Debug: Show what's in the tables for any date
    const allShifts = this.db.prepare(`SELECT id, staff_id, role_type, date(check_in_time, 'localtime') as check_date, check_in_time FROM staff_shifts ORDER BY check_in_time DESC LIMIT 5`).all();
    console.log('[generateZReport] Recent shifts:', allShifts);

    const allDrawers = this.db.prepare(`SELECT id, staff_shift_id, date(opened_at, 'localtime') as open_date, opened_at, opening_amount, total_expenses, total_staff_payments FROM cash_drawer_sessions ORDER BY opened_at DESC LIMIT 5`).all();
    console.log('[generateZReport] Recent drawers:', allDrawers);

    const allExpenses = this.db.prepare(`SELECT id, staff_shift_id, date(created_at, 'localtime') as exp_date, amount, expense_type FROM shift_expenses ORDER BY created_at DESC LIMIT 5`).all();
    console.log('[generateZReport] Recent expenses:', allExpenses);

    // Debug: Show orders with their dates and statuses
    const allOrders = this.db.prepare(`SELECT id, order_number, status, payment_status, date(created_at, 'localtime') as order_date, created_at, staff_shift_id FROM orders ORDER BY created_at DESC LIMIT 10`).all();
    console.log('[generateZReport] Recent orders:', allOrders);

    // Debug: Count orders matching our criteria
    const orderMatchCount = this.db.prepare(
      `SELECT COUNT(*) as cnt
       FROM orders
       WHERE created_at > ?
         AND status NOT IN ('cancelled', 'canceled')${orderShiftFilter}`
    ).get(...orderShiftParams) as any;
    console.log('[generateZReport] Orders matching date', targetDate, 'with non-canceled status:', orderMatchCount?.cnt);

    // Debug: Count all orders for target date regardless of status
    const orderAllCount = this.db.prepare(
      `SELECT COUNT(*) as cnt
       FROM orders
       WHERE created_at > ?${orderShiftFilter}`
    ).get(...orderShiftParams) as any;
    console.log('[generateZReport] All orders for date', targetDate, ':', orderAllCount?.cnt);

    // Shifts overview - includes all role types (cashier, driver, kitchen)
    const shiftsTotal = (this.db.prepare(`SELECT COUNT(*) as c FROM staff_shifts WHERE check_in_time > ?${branchFilter}`).get(...shiftIdParams) as any)?.c || 0;
    console.log('[generateZReport] shiftsTotal for', targetDate, ':', shiftsTotal);
    const shiftsCashier = (this.db.prepare(`SELECT COUNT(*) as c FROM staff_shifts WHERE check_in_time > ?${branchFilter} AND role_type = 'cashier'`).get(...shiftIdParams) as any)?.c || 0;
    const shiftsDriver = (this.db.prepare(`SELECT COUNT(*) as c FROM staff_shifts WHERE check_in_time > ?${branchFilter} AND role_type = 'driver'`).get(...shiftIdParams) as any)?.c || 0;
    const shiftsKitchen = (this.db.prepare(`SELECT COUNT(*) as c FROM staff_shifts WHERE check_in_time > ?${branchFilter} AND role_type = 'kitchen'`).get(...shiftIdParams) as any)?.c || 0;

    // Sales summary (orders)
    // Use status-based filtering instead of payment_status for consistency with checkout reports
    // status NOT IN ('cancelled', 'canceled') captures all finalized paid orders
    // Try two approaches: by date AND by staff_shift_id (for shifts on that date)
    const orderSalesByDate = this.db.prepare(
      `SELECT COUNT(*) as totalOrders,
              COALESCE(SUM(total_amount), 0) as totalSales
       FROM orders
       WHERE created_at > ?
         AND status NOT IN ('cancelled', 'canceled')${orderShiftFilter}`
    ).get(...orderShiftParams) as any;

    // Also get orders by staff_shift_id for shifts on this date (handles timezone issues)
    const orderSalesByShift = this.db.prepare(
      `SELECT COUNT(*) as totalOrders,
              COALESCE(SUM(total_amount), 0) as totalSales
       FROM orders o
       WHERE o.staff_shift_id IN (${shiftIdSubquery})
         AND o.status NOT IN ('cancelled', 'canceled')`
    ).get(...shiftIdParams) as any;

    console.log('[generateZReport] Orders by date:', orderSalesByDate);
    console.log('[generateZReport] Orders by shift:', orderSalesByShift);

    // Use whichever method found more orders (handles timezone edge cases)
    const orderSales = (Number(orderSalesByShift?.totalOrders) || 0) > (Number(orderSalesByDate?.totalOrders) || 0)
      ? orderSalesByShift
      : orderSalesByDate;

    // Cash/Card breakdown from cash drawer sessions if available
    const cashRow = this.db.prepare(
      `SELECT COALESCE(SUM(total_cash_sales), 0) as cashSales,
              COALESCE(SUM(total_card_sales), 0) as cardSales
       FROM cash_drawer_sessions WHERE opened_at > ?${branchFilter}`
    ).get(...shiftIdParams) as any;


    // Payment method counts and by-type breakdown
    // Use status-based filtering for consistency
    // Query by staff_shift_id to handle timezone issues (same as orderSales)
    const useShiftQuery = (Number(orderSalesByShift?.totalOrders) || 0) > (Number(orderSalesByDate?.totalOrders) || 0);

    const pmCounts = useShiftQuery
      ? this.db.prepare(
          `SELECT payment_method as method, COUNT(*) as cnt, COALESCE(SUM(total_amount),0) as total
           FROM orders
           WHERE staff_shift_id IN (${shiftIdSubquery})
             AND status NOT IN ('cancelled', 'canceled')
           GROUP BY payment_method`
        ).all(...shiftIdParams) as any[]
      : this.db.prepare(
          `SELECT payment_method as method, COUNT(*) as cnt, COALESCE(SUM(total_amount),0) as total
           FROM orders
           WHERE created_at > ?
             AND status NOT IN ('cancelled', 'canceled')${orderShiftFilter}
           GROUP BY payment_method`
        ).all(...orderShiftParams) as any[];

    const cashOrders = Number(pmCounts.find(r => r.method === 'cash')?.cnt || 0);
    const cardOrders = Number(pmCounts.find(r => r.method === 'card')?.cnt || 0);

    const cashFromDrawer = Number(cashRow?.cashSales || 0);
    const cardFromDrawer = Number(cashRow?.cardSales || 0);
    const cashFromOrders = Number(pmCounts.find(r => r.method === 'cash')?.total || 0);
    const cardFromOrders = Number(pmCounts.find(r => r.method === 'card')?.total || 0);
    const cashSalesFinal = cashFromDrawer || cashFromOrders;
    const cardSalesFinal = cardFromDrawer || cardFromOrders;

    // Use status-based filtering for type breakdown (use same query strategy)
    const typeBreak = useShiftQuery
      ? this.db.prepare(
          `SELECT
             SUM(CASE WHEN order_type IN ('dine-in','takeaway','pickup') AND payment_method = 'cash' THEN 1 ELSE 0 END) as instoreCashCount,
             SUM(CASE WHEN order_type IN ('dine-in','takeaway','pickup') AND payment_method = 'cash' THEN total_amount ELSE 0 END) as instoreCashTotal,
             SUM(CASE WHEN order_type IN ('dine-in','takeaway','pickup') AND payment_method = 'card' THEN 1 ELSE 0 END) as instoreCardCount,
             SUM(CASE WHEN order_type IN ('dine-in','takeaway','pickup') AND payment_method = 'card' THEN total_amount ELSE 0 END) as instoreCardTotal,
             SUM(CASE WHEN order_type = 'delivery' AND payment_method = 'cash' THEN 1 ELSE 0 END) as deliveryCashCount,
             SUM(CASE WHEN order_type = 'delivery' AND payment_method = 'cash' THEN total_amount ELSE 0 END) as deliveryCashTotal,
             SUM(CASE WHEN order_type = 'delivery' AND payment_method = 'card' THEN 1 ELSE 0 END) as deliveryCardCount,
             SUM(CASE WHEN order_type = 'delivery' AND payment_method = 'card' THEN total_amount ELSE 0 END) as deliveryCardTotal
           FROM orders
           WHERE staff_shift_id IN (${shiftIdSubquery})
             AND status NOT IN ('cancelled', 'canceled')`
        ).get(...shiftIdParams) as any
      : this.db.prepare(
          `SELECT
             SUM(CASE WHEN order_type IN ('dine-in','takeaway','pickup') AND payment_method = 'cash' THEN 1 ELSE 0 END) as instoreCashCount,
             SUM(CASE WHEN order_type IN ('dine-in','takeaway','pickup') AND payment_method = 'cash' THEN total_amount ELSE 0 END) as instoreCashTotal,
             SUM(CASE WHEN order_type IN ('dine-in','takeaway','pickup') AND payment_method = 'card' THEN 1 ELSE 0 END) as instoreCardCount,
             SUM(CASE WHEN order_type IN ('dine-in','takeaway','pickup') AND payment_method = 'card' THEN total_amount ELSE 0 END) as instoreCardTotal,
             SUM(CASE WHEN order_type = 'delivery' AND payment_method = 'cash' THEN 1 ELSE 0 END) as deliveryCashCount,
             SUM(CASE WHEN order_type = 'delivery' AND payment_method = 'cash' THEN total_amount ELSE 0 END) as deliveryCashTotal,
             SUM(CASE WHEN order_type = 'delivery' AND payment_method = 'card' THEN 1 ELSE 0 END) as deliveryCardCount,
             SUM(CASE WHEN order_type = 'delivery' AND payment_method = 'card' THEN total_amount ELSE 0 END) as deliveryCardTotal
           FROM orders
           WHERE created_at > ?
             AND status NOT IN ('cancelled', 'canceled')${orderShiftFilter}`
        ).get(...orderShiftParams) as any;

    // Additional cash drawer sums
    const drawerSums = this.db.prepare(
      `SELECT
         COALESCE(SUM(opening_amount), 0) as openingTotal,
         COALESCE(SUM(driver_cash_given), 0) as driverCashGiven,
         COALESCE(SUM(driver_cash_returned), 0) as driverCashReturned,
         COALESCE(SUM(total_staff_payments), 0) as staffPaymentsTotal
       FROM cash_drawer_sessions WHERE opened_at > ?${branchFilter}`
    ).get(...shiftIdParams) as any;
    console.log('[generateZReport] drawerSums result:', drawerSums);

    // Staff payments total from staff_payments table (NOT shift_expenses)
    // Query detailed staff payment analytics with check-in/out times
    // IMPORTANT: Get role_type from the RECIPIENT's shift on the payment date, not the cashier's shift
    // The sp.staff_shift_id is the cashier who made the payment, but we need the role of paid_to_staff_id
    // Use a subquery to find the recipient's shift on the same date to get their role
    // FIX: Use staff_name from staff_shifts (which is always populated) instead of joining with staff table
    // (the staff table may not have all staff members synced locally)
    const staffPaymentsDetailed = this.db.prepare(
      `SELECT
         sp.id,
         sp.paid_to_staff_id as staff_id,
         sp.staff_shift_id,
         sp.amount,
         sp.payment_type,
         sp.notes,
         sp.created_at,
         -- Get staff_name from recipient's shift (more reliable than staff table which may not be synced)
         COALESCE(
           (SELECT staff_name FROM staff_shifts 
            WHERE staff_id = sp.paid_to_staff_id 
            AND date(check_in_time, 'localtime') = date(sp.created_at, 'localtime') 
            LIMIT 1),
           s.first_name || ' ' || s.last_name,
           sp.paid_to_staff_id
         ) as staff_name,
         -- Get role from the recipient's shift on the payment date, not the cashier's shift
         COALESCE(
           (SELECT role_type FROM staff_shifts 
            WHERE staff_id = sp.paid_to_staff_id 
            AND date(check_in_time, 'localtime') = date(sp.created_at, 'localtime') 
            LIMIT 1),
           'unknown'
         ) as role_type,
         -- Get check-in/out times from recipient's shift for display
         (SELECT check_in_time FROM staff_shifts 
          WHERE staff_id = sp.paid_to_staff_id 
          AND date(check_in_time, 'localtime') = date(sp.created_at, 'localtime') 
          LIMIT 1) as check_in_time,
         (SELECT check_out_time FROM staff_shifts 
          WHERE staff_id = sp.paid_to_staff_id 
          AND date(check_in_time, 'localtime') = date(sp.created_at, 'localtime') 
          LIMIT 1) as check_out_time,
         (SELECT status FROM staff_shifts 
          WHERE staff_id = sp.paid_to_staff_id 
          AND date(check_in_time, 'localtime') = date(sp.created_at, 'localtime') 
          LIMIT 1) as shift_status
       FROM staff_payments sp
       LEFT JOIN staff s ON sp.paid_to_staff_id = s.id
       WHERE sp.created_at > ?
         AND sp.paid_by_cashier_shift_id IN (${shiftIdSubquery})
       ORDER BY sp.created_at ASC`
    ).all(periodStart, ...shiftIdParams) as any[];

    const staffPaymentsTotal = staffPaymentsDetailed.reduce((sum: number, p: any) => sum + Number(p.amount || 0), 0);

    // Legacy: Staff payments from shift_expenses (for backward compatibility)
    const staffPayRow = this.db.prepare(
      `SELECT COALESCE(SUM(amount), 0) as total
       FROM shift_expenses WHERE created_at > ? AND expense_type = 'staff_payment'${branchFilter}`
    ).get(...shiftIdParams) as any;

    // Driver cash aggregates
    const driverAmounts = this.db.prepare(
      `SELECT COALESCE(SUM(cash_collected), 0) as cashCollectedTotal,
              COALESCE(SUM(card_amount), 0) as cardAmountTotal,
              COALESCE(SUM(cash_to_return), 0) as cashToReturnTotal
       FROM driver_earnings WHERE created_at > ?${hasBranch ? ' AND branch_id = ?' : ''}`
    ).get(...(hasBranch ? [periodStart, branchId] : [periodStart])) as any;

    // Detailed drawers list
    const drawersRaw = this.db.prepare(
      `SELECT cds.*, ss.staff_name
       FROM cash_drawer_sessions cds
       LEFT JOIN staff_shifts ss ON ss.id = cds.staff_shift_id
       WHERE cds.opened_at > ?${hasBranch ? ' AND cds.branch_id = ?' : ''}
       ORDER BY cds.opened_at ASC`
    ).all(...(hasBranch ? [periodStart, branchId] : [periodStart])) as any[];
    const drawers = drawersRaw.map(d => ({
      id: d.id,
      staffShiftId: d.staff_shift_id,
      staffName: d.staff_name,
      opening: Number(d.opening_amount || 0),
      expected: Number(d.expected_amount || 0),
      closing: Number(d.closing_amount || 0),
      variance: Number(d.variance_amount || 0),
      cashSales: Number(d.total_cash_sales || 0),
      cardSales: Number(d.total_card_sales || 0),
      driverCashGiven: Number(d.driver_cash_given || 0),
      driverCashReturned: Number(d.driver_cash_returned || 0),
      drops: Number(d.cash_drops || 0),
      staffPayments: Number(d.total_staff_payments || 0),
      openedAt: d.opened_at,
      closedAt: d.closed_at,
      reconciled: d.reconciled,
    }));

    // Cash drawer summary
    const drawerRow = this.db.prepare(
      `SELECT COALESCE(SUM(variance_amount), 0) as totalVariance,
              COALESCE(SUM(cash_drops), 0) as totalCashDrops,
              SUM(CASE WHEN (reconciled = 0 OR reconciled IS NULL) THEN 1 ELSE 0 END) as unreconciledCount
       FROM cash_drawer_sessions WHERE opened_at > ?${branchFilter}`
    ).get(...shiftIdParams) as any;

    // Pre-compute non-staff-payment expenses per shift for version-aware return formulas.
    const shiftExpensesByShiftRaw = this.db.prepare(
      `SELECT staff_shift_id, COALESCE(SUM(amount), 0) as total_expenses
       FROM shift_expenses
       WHERE created_at > ?
         AND (expense_type IS NULL OR expense_type != 'staff_payment')${hasBranch ? ' AND branch_id = ?' : ''}
       GROUP BY staff_shift_id`
    ).all(...(hasBranch ? [periodStart, branchId] : [periodStart])) as any[];
    const shiftExpensesByShift = new Map<string, number>(
      shiftExpensesByShiftRaw.map((row: any) => [String(row.staff_shift_id || ''), Number(row.total_expenses || 0)])
    );

    // Driver cash breakdown - per-driver cash transactions with identity.
    // cashToReturn is computed via the same version-aware shift formula used for staff reports.
    const driverCashBreakdownRaw = this.db.prepare(
      `SELECT 
         de.staff_shift_id as driver_shift_id,
         ss.staff_id as driver_id,
         COALESCE(ss.staff_name, s.first_name || ' ' || s.last_name, ss.staff_id) as driver_name,
         SUM(de.cash_collected) as cash_collected,
         ss.opening_cash_amount as opening_cash_amount,
         ss.payment_amount as payment_amount,
         ss.calculation_version as calculation_version
       FROM driver_earnings de
       INNER JOIN staff_shifts ss ON ss.id = de.staff_shift_id
       LEFT JOIN staff s ON ss.staff_id = s.id
       WHERE de.created_at > ?${hasBranch ? ' AND de.branch_id = ?' : ''}
       GROUP BY de.staff_shift_id, ss.staff_id, ss.opening_cash_amount, ss.payment_amount, ss.calculation_version
       ORDER BY driver_name ASC`
    ).all(...(hasBranch ? [periodStart, branchId] : [periodStart])) as any[];

    const driverCashBreakdown = driverCashBreakdownRaw.map(d => {
      const driverShiftId = d.driver_shift_id || '';
      const cashCollected = Number(d.cash_collected || 0);
      const openingAmount = Number(d.opening_cash_amount || 0);
      const paymentAmount = Number(d.payment_amount || 0);
      const calculationVersion = Number(d.calculation_version || 1);
      const expenses = Number(shiftExpensesByShift.get(driverShiftId) || 0);
      const cashToReturn = calculationVersion >= 2
        ? openingAmount + cashCollected - expenses
        : openingAmount + cashCollected - expenses - paymentAmount;

      return {
        driverId: d.driver_id || '',
        driverName: d.driver_name || d.driver_id || 'Unknown Driver',
        driverShiftId,
        cashCollected,
        cashToReturn: Number(cashToReturn || 0),
      };
    });
    const driverCashBreakdownTotal = driverCashBreakdown.reduce((sum, d) => sum + Number(d.cashToReturn || 0), 0);

    // Expenses - EXCLUDE staff_payment type to avoid double-counting with staffPaymentsTotal
    // The staff_payments table is the primary source for staff payments now
    const expensesTotalRow = this.db.prepare(
      `SELECT COALESCE(SUM(amount), 0) as total,
              SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pendingCount
       FROM shift_expenses
       WHERE created_at > ?
         AND (expense_type IS NULL OR expense_type != 'staff_payment')${branchFilter}`
    ).get(...shiftIdParams) as any;

    // Expense items - also exclude staff_payment type (they're shown in staffAnalytics section)
    const expensesItems = this.db.prepare(
      `SELECT e.id, e.description, e.amount, e.expense_type, e.created_at,
              (SELECT staff_name FROM staff_shifts ss WHERE ss.id = e.staff_shift_id LIMIT 1) as staff_name
       FROM shift_expenses e
       WHERE e.created_at > ?
         AND (e.expense_type IS NULL OR e.expense_type != 'staff_payment')${branchFilter}
       ORDER BY e.created_at DESC`
    ).all(...shiftIdParams) as Array<{ id: string; description: string; amount: number; expense_type?: string; staff_name?: string; created_at: string }>;

    // Driver earnings (including canceled orders via LEFT JOIN with orders table)
    const driverRow = this.db.prepare(
      `SELECT
         COUNT(*) as totalDeliveries,
         COALESCE(SUM(de.total_earning), 0) as totalEarnings,
         SUM(CASE WHEN de.settled = 0 OR de.settled IS NULL THEN 1 ELSE 0 END) as unsettledCount,
         SUM(CASE WHEN o.status IN ('cancelled', 'canceled', 'refunded') THEN 1 ELSE 0 END) as cancelledCount,
         SUM(CASE WHEN o.status IN ('completed', 'delivered') THEN 1 ELSE 0 END) as completedCount
       FROM driver_earnings de
       LEFT JOIN orders o ON de.order_id = o.id
       WHERE de.created_at > ?${hasBranch ? ' AND de.branch_id = ?' : ''}`
    ).get(...(hasBranch ? [periodStart, branchId] : [periodStart])) as any;

    // Staff personal reports (per shift) - includes ALL role types (cashier, driver, kitchen)
    // Sort by role_type first to group staff by role, then by check_in_time
    const staffShifts = this.db.prepare(
      `SELECT * FROM staff_shifts WHERE check_in_time > ?${branchFilter} ORDER BY role_type ASC, check_in_time ASC`
    ).all(...shiftIdParams) as any[];

    const staffReports = staffShifts.map(s => {
      const roleType = s.role_type;
      
      // FIX: Order attribution by role
      // - Drivers get delivery orders from driver_earnings table
      // - Cashiers get in-store orders they created (excluding deliveries assigned to drivers)
      let ordersAgg: any;
      let ordersDetail: any[];
      
      if (roleType === 'driver') {
        // For drivers: Get orders from driver_earnings table
        // These are delivery orders assigned to this driver
        ordersAgg = this.db.prepare(
          `SELECT COUNT(*) as cnt,
                  COALESCE(SUM(CASE WHEN o.status NOT IN ('cancelled', 'canceled') THEN o.total_amount ELSE 0 END), 0) as total,
                  COALESCE(SUM(CASE WHEN o.status NOT IN ('cancelled', 'canceled') AND o.payment_method='cash' THEN o.total_amount ELSE 0 END), 0) as cashTotal,
                  COALESCE(SUM(CASE WHEN o.status NOT IN ('cancelled', 'canceled') AND o.payment_method='card' THEN o.total_amount ELSE 0 END), 0) as cardTotal
           FROM orders o
           INNER JOIN driver_earnings de ON de.order_id = o.id
           WHERE de.staff_shift_id = ?`
        ).get(s.id) as any;

        // FETCH INDIVIDUAL ORDERS for drivers from driver_earnings
        ordersDetail = this.db.prepare(
          `SELECT o.id, o.order_number, o.order_type, o.table_number, o.delivery_address,
                  o.total_amount, o.payment_method, o.payment_status, o.status, o.created_at
           FROM orders o
           INNER JOIN driver_earnings de ON de.order_id = o.id
           WHERE de.staff_shift_id = ?
           ORDER BY o.created_at ASC
           LIMIT 1001`
        ).all(s.id) as any[];
      } else {
        // For cashiers (and kitchen staff): Get in-store orders they created
        // Exclude delivery orders that have been assigned to drivers
        ordersAgg = this.db.prepare(
          `SELECT COUNT(*) as cnt,
                  COALESCE(SUM(CASE WHEN status NOT IN ('cancelled', 'canceled') THEN total_amount ELSE 0 END), 0) as total,
                  COALESCE(SUM(CASE WHEN status NOT IN ('cancelled', 'canceled') AND payment_method='cash' THEN total_amount ELSE 0 END), 0) as cashTotal,
                  COALESCE(SUM(CASE WHEN status NOT IN ('cancelled', 'canceled') AND payment_method='card' THEN total_amount ELSE 0 END), 0) as cardTotal
           FROM orders 
           WHERE staff_shift_id = ?
             AND (order_type IN ('dine-in', 'takeaway', 'pickup') 
                  OR NOT EXISTS (SELECT 1 FROM driver_earnings de WHERE de.order_id = orders.id))`
        ).get(s.id) as any;

        // FETCH INDIVIDUAL ORDERS for cashiers - exclude delivery orders assigned to drivers
        ordersDetail = this.db.prepare(
          `SELECT id, order_number, order_type, table_number, delivery_address,
                  total_amount, payment_method, payment_status, status, created_at
           FROM orders
           WHERE staff_shift_id = ?
             AND (order_type IN ('dine-in', 'takeaway', 'pickup')
                  OR NOT EXISTS (SELECT 1 FROM driver_earnings de WHERE de.order_id = orders.id))
           ORDER BY created_at ASC
           LIMIT 1001`
        ).all(s.id) as any[];
      }

      let mappedOrders = ordersDetail.map(o => ({
        id: o.id,
        orderNumber: o.order_number,
        orderType: o.order_type,
        tableNumber: o.table_number,
        deliveryAddress: o.delivery_address,
        amount: Number(o.total_amount || 0),
        paymentMethod: o.payment_method,
        paymentStatus: o.payment_status,
        status: o.status,
        createdAt: o.created_at
      }));

      const ordersTruncated = mappedOrders.length > 1000;
      if (ordersTruncated) {
        mappedOrders = mappedOrders.slice(0, 1000);
      }

      // Staff payment received by this staff member (from staff_payments table)
      const staffPaymentReceived = this.db.prepare(
        `SELECT COALESCE(SUM(amount), 0) as total
         FROM staff_payments WHERE paid_to_staff_id = ? AND created_at > ?`
      ).get(s.staff_id, periodStart) as any;

      // Legacy: Expenses from shift_expenses (non-staff-payment types only)
      const expAgg = this.db.prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN expense_type='staff_payment' THEN amount ELSE 0 END), 0) as staffPaymentsLegacy,
           COALESCE(SUM(CASE WHEN expense_type!='staff_payment' OR expense_type IS NULL THEN amount ELSE 0 END), 0) as expensesTotal
         FROM shift_expenses WHERE staff_shift_id = ?`
      ).get(s.id) as any;

      // Driver deliveries including canceled orders
      const drv = this.db.prepare(
        `SELECT
           COUNT(*) as deliveries,
           SUM(CASE WHEN o.status IN ('cancelled', 'canceled', 'refunded') THEN 1 ELSE 0 END) as cancelledDeliveries,
           SUM(CASE WHEN o.status IN ('completed', 'delivered') THEN 1 ELSE 0 END) as completedDeliveries,
           COALESCE(SUM(de.total_earning),0) as earnings,
           COALESCE(SUM(de.cash_collected),0) as cashCollected,
           COALESCE(SUM(de.card_amount),0) as cardAmount,
           COALESCE(SUM(de.cash_to_return),0) as cashToReturn
         FROM driver_earnings de
         LEFT JOIN orders o ON de.order_id = o.id
         WHERE de.staff_shift_id = ?`
      ).get(s.id) as any;

      const drawer = this.db.prepare(
        `SELECT * FROM cash_drawer_sessions WHERE staff_shift_id = ?`
      ).get(s.id) as any;

      // Calculate returnedToDrawerAmount using version-aware formula:
      // v1 (legacy): startingAmount + cashCollected - expenses - payment
      // v2+: startingAmount + cashCollected - expenses (payment is cashier-handled, not deducted)
      const calculationVersion = Number(s.calculation_version || 1);
      let returnedToDrawerAmount: number;
      if (s.role_type === 'driver') {
        const startingAmount = Number(s.opening_cash_amount || 0);
        const cashCollected = Number(drv?.cashCollected || 0);
        const expenses = Number(expAgg?.expensesTotal || 0);
        const payment = Number(s.payment_amount || 0);
        // v2+: payment is NOT deducted (cashier handles payment separately)
        if (calculationVersion >= 2) {
          returnedToDrawerAmount = startingAmount + cashCollected - expenses;
        } else {
          // v1 (legacy): payment is deducted from return
          returnedToDrawerAmount = startingAmount + cashCollected - expenses - payment;
        }
      } else if (s.role_type === 'server') {
        // Waiter/server: same version-aware formula as driver
        const startingAmount = Number(s.opening_cash_amount || 0);
        const cashCollected = Number(ordersAgg?.cashTotal || 0);
        const expenses = Number(expAgg?.expensesTotal || 0);
        const payment = Number(s.payment_amount || 0);
        // v2+: payment is NOT deducted (cashier handles payment separately)
        if (calculationVersion >= 2) {
          returnedToDrawerAmount = startingAmount + cashCollected - expenses;
        } else {
          // v1 (legacy): payment is deducted from return
          returnedToDrawerAmount = startingAmount + cashCollected - expenses - payment;
        }
      } else {
        // Cashier: use drawer's driver_cash_returned (sum of what drivers returned)
        returnedToDrawerAmount = Number(drawer?.driver_cash_returned || 0);
      }

      // Use staff_payments table total, fall back to legacy shift_expenses
      const staffPaymentsAmount = Number(staffPaymentReceived?.total || 0) || Number(expAgg?.staffPaymentsLegacy || 0);

      return {
        staffShiftId: s.id,
        staffId: s.staff_id,
        staffName: s.staff_name || s.staff_id,
        role: s.role_type,
        checkIn: s.check_in_time,
        checkOut: s.check_out_time,
        shiftStatus: s.status,
        calculationVersion: s.calculation_version || 1, // Version 1 for legacy, 2 for corrected formula
        orders: {
          count: Number(ordersAgg?.cnt || 0),
          cashAmount: Number(ordersAgg?.cashTotal || 0),
          cardAmount: Number(ordersAgg?.cardTotal || 0),
          totalAmount: Number(ordersAgg?.total || 0)
        },
        ordersDetails: mappedOrders,
        ordersTruncated,
        payments: { staffPayments: staffPaymentsAmount },
        expenses: { total: Number(expAgg?.expensesTotal || 0) },
        driver: {
          deliveries: Number(drv?.deliveries || 0),
          completedDeliveries: Number(drv?.completedDeliveries || 0),
          cancelledDeliveries: Number(drv?.cancelledDeliveries || 0),
          earnings: Number(drv?.earnings || 0),
          cashCollected: Number(drv?.cashCollected || 0),
          cardAmount: Number(drv?.cardAmount || 0),
          // Use correct formula: startingAmount + cashCollected - expenses - payment
          // instead of summing per-order cash_to_return values
          cashToReturn: s.role_type === 'driver' ? returnedToDrawerAmount : Number(drv?.cashToReturn || 0),
          startingAmount: Number(s.opening_cash_amount || 0),
          expenses: Number(expAgg?.expensesTotal || 0),
          payment: Number(s.payment_amount || 0)
        },
        drawer: drawer ? {
          opening: Number(drawer.opening_amount || 0),
          expected: Number(drawer.expected_amount || 0),
          closing: Number(drawer.closing_amount || 0),
          variance: Number(drawer.variance_amount || 0),
          cashSales: Number(drawer.total_cash_sales || 0),
          cardSales: Number(drawer.total_card_sales || 0),
          drops: Number(drawer.cash_drops || 0),
          driverCashReturned: Number(drawer.driver_cash_returned || 0),
          driverCashGiven: Number(drawer.driver_cash_given || 0)
        } : undefined,
        returnedToDrawerAmount
      };
    });

    // In fixture/test environments there may be no drawer sessions; use breakdown total as fallback.
    const resolvedDriverCashReturned = drawersRaw.length > 0
      ? Number(drawerSums?.driverCashReturned || 0)
      : driverCashBreakdownTotal;

    const daySummary = {
      cashTotal: Number(cashSalesFinal || 0),
      cardTotal: Number(cardSalesFinal || 0),
      total: Number((cashSalesFinal || 0) + (cardSalesFinal || 0)),
      totalOrders: Number(orderSales?.totalOrders || 0)
    };

    return {
      date: targetDate,
      periodStart: periodStart, // Timestamp of last Z-Report commit (start of current period)
      shifts: { total: Number(shiftsTotal || 0), cashier: Number(shiftsCashier || 0), driver: Number(shiftsDriver || 0), kitchen: Number(shiftsKitchen || 0) },
      sales: {
        totalOrders: Number(orderSales?.totalOrders || 0),
        totalSales: Number(orderSales?.totalSales || 0),
        cashSales: cashSalesFinal,
        cardSales: cardSalesFinal,
        counts: { cashOrders, cardOrders },
        byType: {
          instore: {
            cash: { count: Number(typeBreak?.instoreCashCount || 0), total: Number(typeBreak?.instoreCashTotal || 0) },
            card: { count: Number(typeBreak?.instoreCardCount || 0), total: Number(typeBreak?.instoreCardTotal || 0) },
          },
          delivery: {
            cash: { count: Number(typeBreak?.deliveryCashCount || 0), total: Number(typeBreak?.deliveryCashTotal || 0) },
            card: { count: Number(typeBreak?.deliveryCardCount || 0), total: Number(typeBreak?.deliveryCardTotal || 0) },
          },
        },
      },
      cashDrawer: {
        totalVariance: Number(drawerRow?.totalVariance || 0),
        totalCashDrops: Number(drawerRow?.totalCashDrops || 0),
        unreconciledCount: Number(drawerRow?.unreconciledCount || 0),
        openingTotal: Number(drawerSums?.openingTotal || 0),
        driverCashGiven: Number(drawerSums?.driverCashGiven || 0),
        driverCashReturned: resolvedDriverCashReturned,
        // Per-driver cash breakdown with driver identity
        driverCashBreakdown,
      },
      expenses: {
        total: Number(expensesTotalRow?.total || 0),
        pendingCount: Number(expensesTotalRow?.pendingCount || 0),
        // Use staff_payments table total, fall back to legacy shift_expenses or drawer totals
        staffPaymentsTotal: staffPaymentsTotal || Number(staffPayRow?.total || 0) || Number(drawerSums?.staffPaymentsTotal || 0),
        items: expensesItems?.map(e => ({ id: e.id, description: e.description, amount: Number(e.amount || 0), expenseType: (e as any).expense_type, staffName: (e as any).staff_name, createdAt: e.created_at })) || []
      },
      driverEarnings: {
        totalDeliveries: Number(driverRow?.totalDeliveries || 0),
        completedDeliveries: Number(driverRow?.completedCount || 0),
        cancelledDeliveries: Number(driverRow?.cancelledCount || 0),
        totalEarnings: Number(driverRow?.totalEarnings || 0),
        unsettledCount: Number(driverRow?.unsettledCount || 0),
        cashCollectedTotal: Number(driverAmounts?.cashCollectedTotal || 0),
        cardAmountTotal: Number(driverAmounts?.cardAmountTotal || 0),
        // Use the sum of individual driver returnedToDrawerAmount (which uses correct formula)
        // instead of summing per-order cash_to_return from driver_earnings table
        cashToReturnTotal: staffReports
          .filter((s: any) => s.role === 'driver')
          .reduce((sum: number, s: any) => sum + (s.returnedToDrawerAmount || 0), 0),
      },
      // Detailed staff analytics from staff_payments table
      staffAnalytics: staffPaymentsDetailed.map((p: any) => ({
        id: p.id,
        staffId: p.staff_id,
        staffName: p.staff_name,
        roleType: p.role_type,
        amount: Number(p.amount || 0),
        paymentType: p.payment_type,
        notes: p.notes,
        checkInTime: p.check_in_time,
        checkOutTime: p.check_out_time,
        shiftStatus: p.shift_status,
        createdAt: p.created_at
      })),
      drawers,
      staffReports,
      daySummary,
      // Calculation version tracking for audit and transition period
      calculationVersions: {
        v1Count: staffReports.filter((s: any) => (s.calculationVersion || 1) === 1).length,
        v2Count: staffReports.filter((s: any) => s.calculationVersion === 2).length,
        hasMixedVersions: staffReports.some((s: any) => (s.calculationVersion || 1) === 1) &&
                          staffReports.some((s: any) => s.calculationVersion === 2),
      },
    };
  }

  /**
   * Aggregate Z-reports from main and child terminals
   * Returns an aggregated snapshot with per-terminal breakdown
   */
  aggregateZReports(
    main: { terminalId: string; terminalName?: string; type?: string; report: any },
    children: Array<{ terminalId: string; terminalName?: string; type?: string; report: any }>
  ): any {
    const all = [main, ...children];
    const agg = JSON.parse(JSON.stringify(main.report || {}));

    // Helper to coalesce numbers
    const add = (a: any, b: any) => Number(a || 0) + Number(b || 0);

    // Sales
    for (const c of children) {
      const r = c.report || {};
      agg.sales = agg.sales || {};
      agg.sales.totalOrders = add(agg.sales.totalOrders, r?.sales?.totalOrders);
      agg.sales.totalSales = add(agg.sales.totalSales, r?.sales?.totalSales);
      agg.sales.cashSales = add(agg.sales.cashSales, r?.sales?.cashSales);
      agg.sales.cardSales = add(agg.sales.cardSales, r?.sales?.cardSales);

      // counts
      const counts = agg.sales.counts || { cashOrders: 0, cardOrders: 0 };
      counts.cashOrders = add(counts.cashOrders, r?.sales?.counts?.cashOrders);
      counts.cardOrders = add(counts.cardOrders, r?.sales?.counts?.cardOrders);
      agg.sales.counts = counts;

      // byType
      agg.sales.byType = agg.sales.byType || { instore: { cash: {}, card: {} }, delivery: { cash: {}, card: {} } };
      const bt = agg.sales.byType;
      bt.instore.cash.count = add(bt.instore.cash.count, r?.sales?.byType?.instore?.cash?.count);
      bt.instore.cash.total = add(bt.instore.cash.total, r?.sales?.byType?.instore?.cash?.total);
      bt.instore.card.count = add(bt.instore.card.count, r?.sales?.byType?.instore?.card?.count);
      bt.instore.card.total = add(bt.instore.card.total, r?.sales?.byType?.instore?.card?.total);
      bt.delivery.cash.count = add(bt.delivery.cash.count, r?.sales?.byType?.delivery?.cash?.count);
      bt.delivery.cash.total = add(bt.delivery.cash.total, r?.sales?.byType?.delivery?.cash?.total);
      bt.delivery.card.count = add(bt.delivery.card.count, r?.sales?.byType?.delivery?.card?.count);
      bt.delivery.card.total = add(bt.delivery.card.total, r?.sales?.byType?.delivery?.card?.total);
    }

    // Cash drawer totals
    for (const c of children) {
      const r = c.report || {};
      agg.cashDrawer = agg.cashDrawer || {};
      agg.cashDrawer.openingTotal = add(agg.cashDrawer.openingTotal, r?.cashDrawer?.openingTotal);
      agg.cashDrawer.driverCashGiven = add(agg.cashDrawer.driverCashGiven, r?.cashDrawer?.driverCashGiven);
      agg.cashDrawer.driverCashReturned = add(agg.cashDrawer.driverCashReturned, r?.cashDrawer?.driverCashReturned);
      agg.cashDrawer.totalVariance = add(agg.cashDrawer.totalVariance, r?.cashDrawer?.totalVariance);
      agg.cashDrawer.totalCashDrops = add(agg.cashDrawer.totalCashDrops, r?.cashDrawer?.totalCashDrops);
      agg.cashDrawer.unreconciledCount = add(agg.cashDrawer.unreconciledCount, r?.cashDrawer?.unreconciledCount);
      // Merge driverCashBreakdown arrays from all terminals
      const mainBreakdown = Array.isArray(agg.cashDrawer.driverCashBreakdown) ? agg.cashDrawer.driverCashBreakdown : [];
      const childBreakdown = Array.isArray(r?.cashDrawer?.driverCashBreakdown) ? r.cashDrawer.driverCashBreakdown : [];
      agg.cashDrawer.driverCashBreakdown = [...mainBreakdown, ...childBreakdown];
    }

    // Expenses
    for (const c of children) {
      const r = c.report || {};
      agg.expenses = agg.expenses || {};
      agg.expenses.total = add(agg.expenses.total, r?.expenses?.total);
      agg.expenses.pendingCount = add(agg.expenses.pendingCount, r?.expenses?.pendingCount);
      agg.expenses.staffPaymentsTotal = add(agg.expenses.staffPaymentsTotal, r?.expenses?.staffPaymentsTotal);
      // items: merge arrays
      const items = Array.isArray(agg.expenses.items) ? agg.expenses.items : [];
      const more = Array.isArray(r?.expenses?.items) ? r.expenses.items : [];
      agg.expenses.items = items.concat(more);
    }

    // Driver earnings
    for (const c of children) {
      const r = c.report || {};
      agg.driverEarnings = agg.driverEarnings || {};
      agg.driverEarnings.totalDeliveries = add(agg.driverEarnings.totalDeliveries, r?.driverEarnings?.totalDeliveries);
      agg.driverEarnings.completedDeliveries = add(agg.driverEarnings.completedDeliveries, r?.driverEarnings?.completedDeliveries);
      agg.driverEarnings.cancelledDeliveries = add(agg.driverEarnings.cancelledDeliveries, r?.driverEarnings?.cancelledDeliveries);
      agg.driverEarnings.totalEarnings = add(agg.driverEarnings.totalEarnings, r?.driverEarnings?.totalEarnings);
      agg.driverEarnings.cashCollectedTotal = add(agg.driverEarnings.cashCollectedTotal, r?.driverEarnings?.cashCollectedTotal);
      agg.driverEarnings.cardAmountTotal = add(agg.driverEarnings.cardAmountTotal, r?.driverEarnings?.cardAmountTotal);
      agg.driverEarnings.cashToReturnTotal = add(agg.driverEarnings.cashToReturnTotal, r?.driverEarnings?.cashToReturnTotal);
    }

    // Staff reports
    const mainName = main.terminalName || main.terminalId;
    const mergedStaffReports: any[] = [];
    const pushReports = (list: any[], name: string) => {
      for (const s of list || []) {
        mergedStaffReports.push({ ...s, terminal: name });
      }
    };
    pushReports(main.report?.staffReports || [], mainName);
    for (const c of children) pushReports(c.report?.staffReports || [], c.terminalName || c.terminalId);
    agg.staffReports = mergedStaffReports;

    // Day summary totals
    for (const c of children) {
      const r = c.report || {};
      agg.daySummary = agg.daySummary || {};
      agg.daySummary.cashTotal = add(agg.daySummary.cashTotal, r?.daySummary?.cashTotal);
      agg.daySummary.cardTotal = add(agg.daySummary.cardTotal, r?.daySummary?.cardTotal);
      agg.daySummary.total = add(agg.daySummary.total, r?.daySummary?.total);
      agg.daySummary.totalOrders = add(agg.daySummary.totalOrders, r?.daySummary?.totalOrders);
    }

    // Terminal breakdown
    const breakdown: Array<{ id: string; name: string; orders: number; cash: number; card: number; total: number; type?: string }> = [];
    for (const t of all) {
      const r = t.report || {};
      breakdown.push({
        id: t.terminalId,
        name: t.terminalName || t.terminalId,
        orders: Number(r?.sales?.totalOrders || 0),
        cash: Number(r?.sales?.cashSales || 0),
        card: Number(r?.sales?.cardSales || 0),
        total: Number(r?.sales?.totalSales || 0),
        type: t.type,
      });
    }
    agg.terminalBreakdown = breakdown;

    // Mark aggregation metadata
    agg.is_aggregated = true;

    return agg;
  }

  /**
   * Check if Z report can be executed: requires no active shifts and all cashier checkouts closed
   * Note: Excludes local-only shifts (simple PIN login or timestamp-based IDs)
   *
   * Validation order is designed to show the most specific error message:
   * 1. First check for transferred driver shifts (most specific)
   * 2. Then check for other active shifts (more generic)
   * 3. Then check for unclosed cashier drawers
   * 4. Finally check for open orders
   */
  canExecuteZReport(date?: string, branchId?: string): { ok: boolean; reason?: string } {
    const targetDate = this.toISODate(date);
    const hasBranch = Boolean(branchId);
    const branchFilter = hasBranch ? ' AND branch_id = ?' : '';
    const branchParams = hasBranch ? [branchId] : [];

    // FIRST: Check for transferred driver shifts that haven't been resolved
    // These are drivers who were transferred when a cashier checked out but haven't completed their shifts yet
    // Check this first to provide a more specific error message
    // Note: is_transfer_pending = 1 means driver is waiting for next cashier (no active cashier yet)
    //       transferred_to_cashier_shift_id IS NOT NULL means driver was attached to a new cashier but hasn't checked out
    const transferredDrivers = this.db.prepare(
      `SELECT COUNT(*) as c FROM staff_shifts
       WHERE role_type = 'driver'
         AND status = 'active'
         AND (is_transfer_pending = 1 OR transferred_to_cashier_shift_id IS NOT NULL)
         AND staff_id != 'local-simple-pin'${branchFilter}`
    ).get(...branchParams) as any;
    const transferredDriverCount = Number(transferredDrivers?.c || 0);
    if (transferredDriverCount > 0) {
      return { ok: false, reason: `${transferredDriverCount} transferred driver shift${transferredDriverCount > 1 ? 's' : ''} not checked out. Please ensure all drivers complete their shifts before running the Z report.` };
    }

    // SECOND: Check for any other active shifts (non-transferred), excluding local-only shifts
    // Exclude transferred drivers (already caught above) to show appropriate message
    const activeShifts = this.db.prepare(
      `SELECT COUNT(*) as c FROM staff_shifts
       WHERE status = 'active'
         AND staff_id != 'local-simple-pin'
         AND is_transfer_pending = 0
         AND transferred_to_cashier_shift_id IS NULL${branchFilter}`
    ).get(...branchParams) as any;
    const activeShiftCount = Number(activeShifts?.c || 0);
    if (activeShiftCount > 0) {
      return { ok: false, reason: `${activeShiftCount} active shift${activeShiftCount > 1 ? 's' : ''} remaining. Please close all shifts (checkout) before running the Z report.` };
    }

    // THIRD: Check for unclosed cashier drawers (in current Z-Report period)
    const periodStart = this.getPeriodStart();
    const unclosedCashierDrawers = this.db.prepare(
      `SELECT COUNT(*) as c
       FROM cash_drawer_sessions cds
       INNER JOIN staff_shifts ss ON ss.id = cds.staff_shift_id
       WHERE ss.check_in_time > ?
         AND ss.role_type = 'cashier'
         AND ss.staff_id != 'local-simple-pin'
         AND cds.closed_at IS NULL${hasBranch ? ' AND ss.branch_id = ?' : ''}`
    ).get(...(hasBranch ? [periodStart, branchId] : [periodStart])) as any;
    const unclosedDrawerCount = Number(unclosedCashierDrawers?.c || 0);
    if (unclosedDrawerCount > 0) {
      return { ok: false, reason: `${unclosedDrawerCount} cashier drawer${unclosedDrawerCount > 1 ? 's' : ''} still open. All cashier checkouts must be executed before running the Z report.` };
    }

    // FOURTH: Block Z report if any open orders exist for the day (non-final statuses)
    const openOrders = this.db.prepare(
      `SELECT COUNT(*) as c FROM orders
       WHERE created_at > ?
         AND status NOT IN ('delivered','completed','cancelled','canceled','refunded')${hasBranch ? ` AND staff_shift_id IN (SELECT id FROM staff_shifts WHERE check_in_time > ?${branchFilter})` : ''}`
    ).get(...(hasBranch ? [periodStart, periodStart, branchId] : [periodStart])) as any;
    const openOrderCount = Number(openOrders?.c || 0);
    if (openOrderCount > 0) {
      return { ok: false, reason: `${openOrderCount} open order${openOrderCount > 1 ? 's' : ''} for the day. Please complete or cancel them before running the Z report.` };
    }

    return { ok: true };
  }

  /**
   * Get list of transferred driver shifts that haven't been checked out yet.
   * Useful for debugging and reporting purposes.
   * Includes both:
   * - Drivers pending transfer (is_transfer_pending = 1, waiting for next cashier)
   * - Drivers attached to new cashier (transferred_to_cashier_shift_id IS NOT NULL)
   */
  getTransferredDriverShifts(): Array<{
    shift_id: string;
    driver_id: string;
    driver_name: string;
    transferred_to_cashier_shift_id: string | null;
    is_transfer_pending: boolean;
    check_in_time: string;
  }> {
    const stmt = this.db.prepare(`
      SELECT
        ss.id as shift_id,
        ss.staff_id as driver_id,
        (s.first_name || ' ' || s.last_name) as driver_name,
        ss.transferred_to_cashier_shift_id,
        ss.is_transfer_pending,
        ss.check_in_time
      FROM staff_shifts ss
      LEFT JOIN staff s ON ss.staff_id = s.id
      WHERE ss.role_type = 'driver'
        AND ss.status = 'active'
        AND (ss.is_transfer_pending = 1 OR ss.transferred_to_cashier_shift_id IS NOT NULL)
      ORDER BY ss.check_in_time ASC
    `);
    return stmt.all().map((row: any) => ({
      ...row,
      is_transfer_pending: Boolean(row.is_transfer_pending)
    })) as any[];
  }

  /**
   * Count finalized orders (delivered/completed/cancelled) in current period that have not been synced (missing supabase_id)
   */
  countUnsyncedFinalOrders(date?: string): number {
    const periodStart = this.getPeriodStart();
    const row = this.db.prepare(
      `SELECT COUNT(*) as c
       FROM orders
       WHERE created_at > ?
         AND status IN ('delivered','completed','cancelled','canceled','refunded')
         AND (supabase_id IS NULL OR supabase_id = '')`
    ).get(periodStart) as any;
    return Number(row?.c || 0);
  }

  countUnsyncedDriverEarnings(date?: string): number {
    const periodStart = this.getPeriodStart();
    const result = this.db.prepare(
      `SELECT COUNT(*) as count FROM driver_earnings WHERE created_at > ? AND (supabase_id IS NULL OR supabase_id = '')`
    ).get(periodStart) as any;
    return Number(result?.count || 0);
  }

  countUnsyncedStaffPayments(date?: string): number {
    const periodStart = this.getPeriodStart();
    const result = this.db.prepare(
      `SELECT COUNT(*) as count FROM staff_payments WHERE created_at > ? AND (supabase_id IS NULL OR supabase_id = '')`
    ).get(periodStart) as any;
    return Number(result?.count || 0);
  }

  countUnsyncedShiftExpenses(date?: string): number {
    const periodStart = this.getPeriodStart();
    const result = this.db.prepare(
      `SELECT COUNT(*) as count FROM shift_expenses WHERE created_at > ? AND (supabase_id IS NULL OR supabase_id = '')`
    ).get(periodStart) as any;
    return Number(result?.count || 0);
  }

  getUnsyncedFinancialSummary(date?: string): { driverEarnings: number, staffPayments: number, shiftExpenses: number, total: number } {
    const driverEarnings = this.countUnsyncedDriverEarnings(date);
    const staffPayments = this.countUnsyncedStaffPayments(date);
    const shiftExpenses = this.countUnsyncedShiftExpenses(date);
    return {
      driverEarnings,
      staffPayments,
      shiftExpenses,
      total: driverEarnings + staffPayments + shiftExpenses
    };
  }

  async validateFinancialDataIntegrity(date?: string): Promise<{
    valid: boolean,
    discrepancies: Array<{
      table: string,
      localCount: number, remoteCount: number, countDiff: number,
      localTotal: number, remoteTotal: number, totalDiff: number
    }>,
    errors: string[]
  }> {
    const periodStart = this.getPeriodStart();
    const errors: string[] = [];
    const discrepancies: Array<{
      table: string,
      localCount: number, remoteCount: number, countDiff: number,
      localTotal: number, remoteTotal: number, totalDiff: number
    }> = [];

    const supabase = getSupabaseClient();
    if (!supabase) {
      return { valid: false, discrepancies: [], errors: ['Supabase client not available'] };
    }

    const tables = [
      { name: 'driver_earnings', amountField: 'total_earning' },
      { name: 'staff_payments', amountField: 'amount' },
      { name: 'shift_expenses', amountField: 'amount' }
    ];

    // Use periodStart for remote queries as well

    for (const table of tables) {
      try {
        // Local
        const localResult = this.db.prepare(
          `SELECT COUNT(*) as count, COALESCE(SUM(${table.amountField}), 0) as total FROM ${table.name} WHERE created_at > ?`
        ).get(periodStart) as any;
        const localCount = Number(localResult?.count || 0);
        const localTotal = Number(localResult?.total || 0);

        // Remote - use periodStart for consistency with local query
        const { data: remoteData, error: remoteError } = await supabase
          .from(table.name)
          .select(table.amountField)
          .gt('created_at', periodStart);

        if (remoteError) {
          errors.push(`Error fetching ${table.name}: ${remoteError.message}`);
          continue;
        }

        const remoteCount = remoteData?.length || 0;
        const remoteTotal = remoteData?.reduce((sum, row: any) => sum + (Number(row[table.amountField]) || 0), 0) || 0;

        // Compare
        const countDiff = localCount - remoteCount;
        const totalDiff = localTotal - remoteTotal;

        if (countDiff !== 0 || Math.abs(totalDiff) > 0.01) {
          discrepancies.push({
            table: table.name,
            localCount,
            remoteCount,
            countDiff,
            localTotal,
            remoteTotal,
            totalDiff
          });
        }

      } catch (e: any) {
        errors.push(`Exception checking ${table.name}: ${e.message}`);
      }
    }

    return {
      valid: discrepancies.length === 0 && errors.length === 0,
      discrepancies,
      errors
    };
  }


  /**
   * Finalize end-of-day: clear ALL operational data up to and including the report date
   * This ensures the POS starts fresh the next day with no leftover orders from previous days
   */
  finalizeEndOfDay(date?: string): Record<string, number> {
    const targetDate = this.toISODate(date);
    const cleared: Record<string, number> = {};

    this.db.exec('BEGIN');
    try {
      // NOTE: Respect foreign key dependencies: delete children first, parents last
      // Use <= targetDate to clear ALL old data, not just that specific day

      // Payment artifacts (children of payment_transactions -> orders)
      const delReceipts = this.db.prepare(`DELETE FROM payment_receipts WHERE date(created_at, 'localtime') <= ?`).run(targetDate);
      cleared['payment_receipts'] = Number(delReceipts?.changes || 0);

      const delRefunds = this.db.prepare(`DELETE FROM payment_refunds WHERE date(created_at, 'localtime') <= ?`).run(targetDate);
      cleared['payment_refunds'] = Number(delRefunds?.changes || 0);

      const delTx = this.db.prepare(`DELETE FROM payment_transactions WHERE date(created_at, 'localtime') <= ?`).run(targetDate);
      cleared['payment_transactions'] = Number(delTx?.changes || 0);

      // Order retry queue and sync/conflict artifacts (may reference orders)
      const delRetry = this.db.prepare(`DELETE FROM order_retry_queue WHERE date(created_at, 'localtime') <= ?`).run(targetDate);
      cleared['order_retry_queue'] = Number(delRetry?.changes || 0);

      // Clear ALL sync queue items (processed items should be gone anyway)
      const delSync = this.db.prepare(`DELETE FROM sync_queue WHERE date(created_at, 'localtime') <= ?`).run(targetDate);
      cleared['sync_queue'] = Number(delSync?.changes || 0);

      const delConflicts = this.db.prepare(`DELETE FROM order_sync_conflicts WHERE date(created_at, 'localtime') <= ?`).run(targetDate);
      cleared['order_sync_conflicts'] = Number(delConflicts?.changes || 0);

      // Driver earnings (FK to orders and staff_shifts)
      const delDriver = this.db.prepare(`DELETE FROM driver_earnings WHERE date(created_at, 'localtime') <= ?`).run(targetDate);
      cleared['driver_earnings'] = Number(delDriver?.changes || 0);

      // Expenses (FK to staff_shifts)
      const delExpenses = this.db.prepare(`DELETE FROM shift_expenses WHERE date(created_at, 'localtime') <= ?`).run(targetDate);
      cleared['shift_expenses'] = Number(delExpenses?.changes || 0);

      // Staff payments (FK to staff_shifts via paid_by_cashier_shift_id)
      const delStaffPayments = this.db.prepare(`DELETE FROM staff_payments WHERE date(created_at, 'localtime') <= ?`).run(targetDate);
      cleared['staff_payments'] = Number(delStaffPayments?.changes || 0);

      // Cash drawers (FK to staff_shifts)
      const delDrawers = this.db.prepare(`DELETE FROM cash_drawer_sessions WHERE date(opened_at, 'localtime') <= ?`).run(targetDate);
      cleared['cash_drawer_sessions'] = Number(delDrawers?.changes || 0);

      // Staff shifts (parent of drawers/expenses)
      const delShifts = this.db.prepare(`DELETE FROM staff_shifts WHERE date(check_in_time, 'localtime') <= ?`).run(targetDate);
      cleared['staff_shifts'] = Number(delShifts?.changes || 0);

      // Table sessions (if table exists) - clear all sessions up to this date
      try {
        const delTableSessions = this.db.prepare(`DELETE FROM table_sessions WHERE date(created_at, 'localtime') <= ?`).run(targetDate);
        cleared['table_sessions'] = Number(delTableSessions?.changes || 0);
      } catch (e) {
        // Table might not exist in this installation
      }

      // Reset restaurant tables to available (if table exists)
      try {
        const resetTables = this.db.prepare(`UPDATE restaurant_tables SET status = 'available', current_order_id = NULL WHERE status != 'available'`).run();
        cleared['tables_reset'] = Number(resetTables?.changes || 0);
      } catch (e) {
        // Table might not exist in this installation
      }

      // Orders last (parent of transactions/receipts/driver_earnings)
      // Clear ALL orders up to and including the report date - Z Report closes the day
      // This includes pending, preparing, ready, delivered, completed, cancelled - everything
      const delOrders = this.db.prepare(
        `DELETE FROM orders WHERE date(created_at, 'localtime') <= ?`
      ).run(targetDate);
      cleared['orders'] = Number(delOrders?.changes || 0);

      this.db.exec('COMMIT');
      console.log(`[ReportService] End-of-day cleanup complete. Cleared all data up to ${targetDate}:`, cleared);
      return cleared;
    } catch (e) {
      try { this.db.exec('ROLLBACK'); } catch { }
      throw e;
    }
  }

}
