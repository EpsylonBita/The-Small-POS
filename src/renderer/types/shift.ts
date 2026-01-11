// Shift management types

export interface StaffShift {
  id: string;
  staff_id: string;
  staff_name?: string; // Staff name from joined query
  branch_id: string;
  terminal_id: string;
  role_type: 'cashier' | 'manager' | 'driver' | 'kitchen' | 'server';
  check_in_time: string;
  check_out_time?: string;
  scheduled_start?: string;
  scheduled_end?: string;
  /**
   * For cashiers: The initial amount in the cash drawer.
   * For drivers: The optional starting amount taken from the cashier's drawer.
   */
  opening_cash_amount: number;
  closing_cash_amount?: number;
  expected_cash_amount?: number;
  cash_variance?: number;
  status: 'active' | 'closed' | 'abandoned';
  total_orders_count: number;
  total_sales_amount: number;
  total_cash_sales: number;
  total_card_sales: number;
  payment_amount?: number;
  is_day_start?: boolean;
  notes?: string;
  closed_by?: string;
  /**
   * For driver shifts only: The cashier shift ID this driver was attached to
   * after being transferred. NULL when:
   * - Driver is not transferred (normal checkout)
   * - Driver is pending transfer (is_transfer_pending = true, no cashier yet)
   * Set to actual cashier shift ID when the next cashier checks in and claims this driver.
   */
  transferred_to_cashier_shift_id?: string;
  /**
   * Boolean flag: true if this driver is pending transfer to next cashier.
   * This is the primary transfer state indicator. When true:
   * - The previous cashier has checked out
   * - No new cashier has checked in yet to claim this driver
   * - transferred_to_cashier_shift_id will be NULL
   *
   * When a new cashier checks in, this is set to false and
   * transferred_to_cashier_shift_id is set to the new cashier's shift ID.
   */
  is_transfer_pending?: boolean;
  /**
   * Calculation version for the shift formula.
   * Version 1 (legacy): Staff payments deducted from cashier expected, payment_amount included in driver/waiter return
   * Version 2 (current): Staff payments informational only, payment_amount NOT included in driver/waiter return
   * NULL or undefined defaults to version 1 for backward compatibility.
   */
  calculation_version?: number;
  created_at: string;
  updated_at: string;
}

export interface CashDrawerSession {
  id: string;
  staff_shift_id: string;
  cashier_id: string;
  branch_id: string;
  terminal_id: string;
  opening_amount: number;
  closing_amount?: number;
  expected_amount?: number;
  variance_amount?: number;
  total_cash_sales: number;
  total_card_sales: number;
  total_refunds: number;
  total_expenses: number;
  cash_drops: number;
  driver_cash_given: number;
  driver_cash_returned: number;
  total_staff_payments: number;
  opened_at: string;
  closed_at?: string;
  reconciled: boolean;
  reconciled_at?: string;
  reconciled_by?: string;
  reconciliation_notes?: string;
  created_at: string;
  updated_at: string;
}

/**
 * Shift expense record.
 * Note: Staff payments are now handled separately via the staff_payments table,
 * so 'staff_payment' is no longer a valid expense_type.
 */
export interface ShiftExpense {
  id: string;
  shift_id: string;
  staff_id: string;
  branch_id: string;
  expense_type: 'supplies' | 'maintenance' | 'petty_cash' | 'refund' | 'other';
  amount: number;
  description: string;
  receipt_number?: string;
  status: 'pending' | 'approved' | 'rejected';
  approved_by?: string;
  approved_at?: string;
  rejection_reason?: string;
  created_at: string;
  updated_at: string;
}

export interface DriverEarning {
  id: string;
  driver_id: string;
  staff_shift_id: string;
  order_id: string;
  branch_id: string;
  delivery_fee: number;
  tip_amount: number;
  total_earning: number;
  payment_method: 'cash' | 'card' | 'mixed';
  cash_collected: number;
  card_amount: number;
  cash_to_return: number;
  order_details?: {
    order_number: string;
    address: string;
    price: number;
    payment_type: string;
  };
  settled: boolean;
  settled_at?: string;
  settlement_batch_id?: string;
  /**
   * Indicates if this earning was transferred to the next cashier when the
   * previous cashier checked out while the driver was still active.
   * Set to true when a driver shift is transferred without checkout.
   */
  is_transferred?: boolean;
  created_at: string;
  updated_at: string;
}

/**
 * Staff payment record from the staff_payments table
 */
export interface StaffPayment {
  id: string;
  staff_shift_id: string; // Cashier's shift ID
  paid_to_staff_id: string;
  paid_by_cashier_shift_id: string;
  amount: number;
  payment_type: 'wage' | 'tip' | 'bonus' | 'advance' | 'other';
  notes?: string;
  created_at: string;
  // Additional fields from queries
  cashier_name?: string;
  check_in_time?: string;
  check_out_time?: string;
}

/**
 * Parameters for recording a staff payment via IPC
 */
export interface RecordStaffPaymentParams {
  cashierShiftId: string;
  paidToStaffId: string;
  amount: number;
  paymentType: 'wage' | 'tip' | 'bonus' | 'advance' | 'other';
  notes?: string;
}

/**
 * Response from recording a staff payment
 */
export interface RecordStaffPaymentResponse {
  success: boolean;
  paymentId?: string;
  error?: string;
}

/**
 * Information about a driver shift that was transferred from a previous cashier.
 * These are active driver shifts inherited when the current cashier checked in.
 */
export interface TransferredDriverInfo {
  /** Driver's staff ID */
  driver_id: string;
  /** Driver's display name */
  driver_name?: string;
  /** The driver's shift ID */
  shift_id: string;
  /** Amount the driver took from the original cashier's drawer */
  starting_amount: number;
  /** Total earnings (cash + card) collected during the shift */
  current_earnings: number;
  /** Cash collected from deliveries */
  cash_collected: number;
  /** Card amount from deliveries */
  card_amount: number;
  /** Total expenses recorded by the driver */
  expenses: number;
  /** Net cash amount (starting + cash collected - expenses) */
  net_cash_amount: number;
  /** The cashier shift ID this driver was transferred from (if tracked) */
  transferred_from_cashier_shift_id?: string;
  /** Driver's check-in time */
  check_in_time: string;
}

export interface ShiftSummary {
  shift: StaffShift;
  cashDrawer?: CashDrawerSession;
  expenses: ShiftExpense[];
  totalExpenses: number;
  staffPayments?: Array<{
    id: string;
    staff_id: string;
    staff_name?: string;
    role_type?: string;
    amount: number;
    check_in_time?: string;
    check_out_time?: string;
    description: string;
    created_at: string;
  }>;
  ordersCount: number;
  salesAmount: number;
  breakdown?: {
    instore: {
      cashTotal: number;
      cardTotal: number;
      cashCount: number;
      cardCount: number;
    };
    delivery: {
      cashTotal: number;
      cardTotal: number;
      cashCount: number;
      cardCount: number;
    };
    overall: {
      cashTotal: number;
      cardTotal: number;
      totalCount: number;
      totalAmount: number;
    };
  };
  cashRefunds?: number;
  canceledOrders?: {
    cashTotal: number;
    cardTotal: number;
    cashCount: number;
    cardCount: number;
  };
  /**
   * Driver deliveries array including all orders (completed, delivered, cancelled)
   * The status field contains order status: 'completed', 'delivered', 'cancelled', etc.
   */
  driverDeliveries?: Array<{
    id: string;
    order_id: string;
    order_number: string;
    customer_name?: string;
    delivery_address?: string;
    total_amount: number;
    payment_method: string;
    delivery_fee: number;
    tip_amount: number;
    total_earning: number;
    cash_collected: number;
    card_amount: number;
    /** Order status: 'completed', 'delivered', 'cancelled', etc. */
    status?: string;
    /** Alias for status field for backward compatibility */
    order_status?: string;
  }>;
  driverEarnings?: {
    totalDeliveries: number;
    totalEarnings: number;
  };
  /**
   * Active driver shifts that were inherited from the previous cashier.
   * These drivers checked in under a previous cashier who has since checked out,
   * and are now the responsibility of the current cashier.
   * Their amounts are NOT included in the current cashier's expected drawer calculation.
   */
  transferredDrivers?: TransferredDriverInfo[];
  waiterTables?: Array<{
    table_number: string;
    order_count: number;
    total_amount: number;
    cash_amount: number;
    card_amount: number;
    payment_method: 'cash' | 'card' | 'mixed';
    orders: Array<{
      id: string;
      order_id: string;
      order_number: string;
      total_amount: number;
      payment_method: string;
      status: string;
    }>;
  }>;
}

// API response types
export interface OpenShiftResponse {
  success: boolean;
  shiftId?: string;
  message?: string;
  error?: string;
}

export interface CloseShiftResponse {
  success: boolean;
  variance?: number;
  message?: string;
  error?: string;
}

export interface RecordExpenseResponse {
  success: boolean;
  expenseId?: string;
  error?: string;
}

/**
 * Scheduled shift from admin dashboard (salon_staff_shifts table)
 * These are pre-planned shifts created in the admin dashboard
 */
export interface ScheduledShift {
  id: string;
  staffId: string;
  branchId: string;
  startTime: string;
  endTime: string;
  breakStart?: string;
  breakEnd?: string;
  status: 'scheduled' | 'active' | 'completed' | 'cancelled' | 'no_show';
  notes?: string;
  staffName: string;
  staffCode: string;
}

/**
 * Parameters for fetching scheduled shifts
 */
export interface GetScheduledShiftsParams {
  branchId: string;
  startDate: string;
  endDate: string;
  staffId?: string;
}

