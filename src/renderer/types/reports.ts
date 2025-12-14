// Report-related types for the POS renderer

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
    payments: { staffPayments: number };
    expenses: { total: number };
    driver: {
      deliveries: number;
      completedDeliveries?: number;
      cancelledDeliveries?: number;
      earnings: number;
      cashCollected: number;
      cardAmount: number;
      cashToReturn: number;
    };
    drawer?: { opening: number; expected?: number; closing?: number; variance?: number; cashSales?: number; cardSales?: number; drops?: number; driverCashReturned?: number; driverCashGiven?: number };
    returnedToDrawerAmount: number;
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
  daySummary?: { cashTotal: number; cardTotal: number; total: number; totalOrders: number };
}

