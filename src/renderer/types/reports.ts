// Report-related types for the POS renderer

import type { ZReportIntegrity } from '../../lib/ipc-contracts';

export type { ZReportIntegrity };

/**
 * One row of the Z builder's day-level order list (`ZReportData.dayOrders`).
 * Platform orders (efood/wolt…) have no staff shift, so `staffName` is null
 * and `platform` names the source instead; `paymentMethod` uses the
 * `paymentsBreakdown` bucket names for platform-settled tenders
 * (`platform_online` / `platform_cod`).
 */
export interface ZReportDayOrder {
  id: string;
  orderNumber: string;
  orderType: string;
  tableNumber?: string | null;
  deliveryAddress?: string | null;
  amount: number;
  paymentMethod?: string | null;
  paymentStatus?: string | null;
  status: string;
  createdAt: string;
  platform?: string | null;
  platformFleet?: boolean;
  staffShiftId?: string | null;
  staffName?: string | null;
}

export interface TodayStatistics {
  totalOrders: number;
  totalSales: number;
  cashSales: number;
  cardSales: number;
  avgOrderValue?: number;
  completionRate?: number;
}

export interface SalesTrendData {
  date: string; // ISO date
  orders: number;
  revenue: number;
  avgOrderValue: number;
}

export interface TopItemData {
  menuItemId?: string;
  categoryId?: string | null;
  name: string;
  quantity: number;
  revenue: number;
  percentage?: number;
}

export interface StaffPerformance {
  staffId: string;
  name: string;
  role?: string;
  hours?: number;
  orders?: number;
  sales?: number;
  variance?: number;
  expenses?: number;
  deliveries?: number;
}

export interface HourlySalesData {
  hour: number;
  orders: number;
  revenue: number;
}

export interface PaymentMethodBreakdown {
  cash: {
    count: number;
    total: number;
  };
  card: {
    count: number;
    total: number;
  };
}

export interface OrderTypeBreakdown {
  delivery: {
    count: number;
    total: number;
  };
  instore: {
    count: number;
    total: number;
  };
}

export interface ZReportData {
  date: string; // ISO date (yyyy-mm-dd)
  shiftId?: string;
  terminalId?: string;
  terminalName?: string;
  shiftCount?: number;
  shifts: {
    total: number;
    cashier: number;
    driver: number;
  };
  sales: {
    totalOrders: number;
    totalSales: number;
    cashSales: number;
    cardSales: number;
    /** THE-437: platform-held money — prepaid online platform orders. */
    platformOnlineSales?: number;
    /** THE-437: COD collected by the platform's own rider (banks it to us). */
    platformCodSales?: number;
    cashPercent?: number;
    cardPercent?: number;
    counts?: { cashOrders: number; cardOrders: number };
    byType?: {
      instore?: { cash?: { count: number; total: number }; card?: { count: number; total: number } };
      delivery?: { cash?: { count: number; total: number }; card?: { count: number; total: number } };
    };
  };
  cashDrawer: {
    totalVariance: number;
    totalCashDrops: number;
    unreconciledCount: number;
    openingTotal?: number;
    driverCashGiven?: number;
    driverCashReturned?: number;
    driverCashBreakdown?: Array<{
      driverName: string;
      driverShiftId: string;
      roleType?: string;
      startingAmount: number;
      cashCollected: number;
      cardAmount?: number;
      cashToReturn: number;
      expenses: number;
    }>;
    waiterCashBreakdown?: Array<{
      driverName: string;
      driverShiftId: string;
      roleType?: string;
      startingAmount: number;
      cashCollected: number;
      cardAmount?: number;
      cashToReturn: number;
      expenses: number;
    }>;
  };
  /**
   * Expenses summary - excludes staff_payment type items to avoid double-counting.
   * Staff payments are tracked separately in staffAnalytics and expenses.staffPaymentsTotal.
   */
  expenses: {
    /** Total expenses excluding staff_payment type */
    total: number;
    pendingCount: number;
    /**
     * Total staff payments from staff_payments table (or legacy shift_expenses).
     * For detailed breakdown, use staffAnalytics array instead.
     */
    staffPaymentsTotal?: number;
    /** Expense items excluding staff_payment type (those are in staffAnalytics) */
    items?: Array<{ id: string; amount: number; description: string; expenseType?: string; staffName?: string; createdAt?: string }>;
  };
  driverEarnings: {
    totalDeliveries: number;
    completedDeliveries?: number;
    cancelledDeliveries?: number;
    totalEarnings: number;
    unsettledCount: number;
    cashCollectedTotal?: number;
    cardAmountTotal?: number;
    cashToReturnTotal?: number;
    breakdown?: Array<{ driverId: string; name: string; deliveries: number; earnings: number; unsettled?: boolean; cashCollected?: number; cardAmount?: number; cashToReturn?: number }>;
  };
  drawers?: Array<{
    id: string;
    staffShiftId: string;
    staffName?: string;
    opening: number;
    expected?: number;
    closing?: number;
    variance?: number;
    cashSales?: number;
    cardSales?: number;
    driverCashGiven?: number;
    driverCashReturned?: number;
    drops?: number;
    staffPayments?: number;
    openedAt: string;
    closedAt?: string;
    reconciled?: number;
  }>;
  // Added: per-staff personal Z and day summary
  staffReports?: Array<{
    staffShiftId: string;
    staffId: string;
    staffName: string;
    role: string;
    checkIn?: string;
    checkOut?: string;
    shiftStatus?: string;
    orders: { count: number; cashAmount: number; cardAmount: number; totalAmount: number };
    ordersDetails?: Array<{
      id: string;
      orderNumber: string;
      orderType: 'dine-in' | 'pickup' | 'delivery';
      tableNumber?: string;
      deliveryAddress?: string;
      amount: number;
      paymentMethod?: string;
      paymentStatus?: string;
      status: string;
      createdAt: string;
    }>;
    ordersTruncated?: boolean;
    payments?: {
      staffPayments: number;
      list?: Array<{
        id: string;
        amount: number;
        type?: string;
        notes?: string;
        createdAt?: string;
      }>;
    };
    expenses?: {
      total: number;
      items?: Array<{
        id: string;
        amount: number;
        description: string;
        expenseType?: string;
        createdAt?: string;
      }>;
    };
    driver?: {
      deliveries: number;
      completedDeliveries?: number;
      cancelledDeliveries?: number;
      earnings: number;
      cashCollected: number;
      cardAmount: number;
      cashToReturn: number;
    };
    drawer?: {
      opening: number;
      expected?: number;
      closing?: number;
      variance?: number;
      cashSales?: number;
      cardSales?: number;
      drops?: number;
      driverCashReturned?: number;
      driverCashGiven?: number;
    };
    returnedToDrawerAmount?: number;
  }>;
  /**
   * RECOMMENDED: Detailed staff payment analytics from staff_payments table.
   * This is the primary source for staff payment breakdowns in Z reports.
   * Use this array for rendering detailed staff payment sections in admin UI.
   * Each entry represents a single payment with full context about the receiving staff member's shift.
   * Note: expenses.staffPaymentsTotal provides the aggregate total; this array provides the detail.
   */
  staffAnalytics?: Array<{
    id: string;
    staffId: string;
    staffName: string;
    roleType?: string;
    amount: number;
    paymentType?: string;
    notes?: string;
    /** Check-in time from the staff member's shift (linked via staff_shift_id FK) */
    checkInTime?: string;
    /** Check-out time from the staff member's shift (linked via staff_shift_id FK) */
    checkOutTime?: string;
    /** Shift status: 'active', 'closed', 'abandoned' */
    shiftStatus?: string;
    createdAt: string;
  }>;
  /**
   * Payment-level day totals from the Z builder: `total` = cash + card +
   * other tender + platform online + platform COD (money actually
   * collected), unlike `sales.totalSales` which is the order-level gross
   * minus discounts. The Z modal headline reads this one.
   */
  daySummary?: {
    cashTotal: number;
    cardTotal: number;
    platformOnlineTotal?: number;
    platformCodTotal?: number;
    total: number;
    totalOrders: number;
  };
  /**
   * Every order the Z day counts — store AND platform — in chronological
   * order, selected with the same predicate as `sales.totalOrders`
   * (founder, 06/09/2026: the Orders tab only listed staff-shift orders, so
   * platform orders were missing). Absent on reports persisted before
   * 1.4.97; the modal then falls back to the per-staff lists.
   */
  dayOrders?: ZReportDayOrder[];
  dayOrdersTruncated?: boolean;
  /**
   * Does the order side of the day agree with the payment side?
   *
   * `integrity.orderTurnover` is `sales.totalSales` (Σ order totals) and
   * `integrity.paymentCoverage` is `daySummary.total` (Σ completed payments).
   * They are reported side by side and NEVER summed: efood's «x43 / €504,80»
   * is platform turnover already inside both, not an extra amount on top.
   *
   * `findings` names every order that breaks the founder's rule — a paid
   * order must have canonical completed payment coverage — and a non-zero
   * `blockingFindings` is why the Z refuses to close. Absent on reports
   * persisted before 1.4.114.
   */
  integrity?: ZReportIntegrity;
  /** Completed-payment buckets (count + total) behind `daySummary`. */
  paymentsBreakdown?: Partial<
    Record<'cash' | 'card' | 'other' | 'platform_online' | 'platform_cod', { count: number; total: number }>
  >;
  period?: {
    start?: string;
    end?: string;
  };
  periodStart?: string;
  periodEnd?: string;
}
