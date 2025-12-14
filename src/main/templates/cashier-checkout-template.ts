/**
 * Cashier Checkout Print Template
 * 80mm thermal printer format
 */

import { ShiftSummary, ShiftExpense, TransferredDriverInfo } from '../../renderer/types/shift';

export function generateCashierCheckoutReceipt(summary: ShiftSummary, terminalName?: string, paperWidth: number = 48): string {
  const { shift, cashDrawer, breakdown, staffPayments = [], cashRefunds = 0, canceledOrders } = summary;
  
  const checkInDate = new Date(shift.check_in_time);
  const checkOutDate = shift.check_out_time ? new Date(shift.check_out_time) : new Date();
  
  const formatDate = (date: Date) => {
    return date.toLocaleDateString('en-US', { 
      year: 'numeric', 
      month: '2-digit', 
      day: '2-digit' 
    });
  };
  
  const formatTime = (date: Date) => {
    return date.toLocaleTimeString('en-US', { 
      hour: '2-digit', 
      minute: '2-digit',
      hour12: true
    });
  };
  
  const formatCurrency = (amount: number) => {
    return `€${amount.toFixed(2)}`;
  };

  const line = (char: string = '-', length: number = paperWidth) => char.repeat(length);
  const center = (text: string, width: number = paperWidth) => {
    const padding = Math.max(0, Math.floor((width - text.length) / 2));
    return ' '.repeat(padding) + text;
  };
  const leftRight = (left: string, right: string, width: number = paperWidth) => {
    const spaces = Math.max(1, width - left.length - right.length);
    return left + ' '.repeat(spaces) + right;
  };

  let receipt = '';
  
  // Header
  receipt += '\n';
  receipt += line('=') + '\n';
  receipt += center('CASHIER CHECKOUT REPORT') + '\n';
  receipt += line('=') + '\n';
  receipt += '\n';
  
  if (terminalName) {
    receipt += center(terminalName) + '\n';
  }
  
  receipt += center(formatDate(checkOutDate)) + '\n';
  receipt += center(formatTime(checkOutDate)) + '\n';
  receipt += '\n';
  receipt += line() + '\n';
  receipt += '\n';
  
  // Cashier Information
  receipt += 'CASHIER INFORMATION\n';
  receipt += line() + '\n';
  receipt += leftRight('Name:', shift.staff_id) + '\n';
  receipt += leftRight('Shift ID:', shift.id.substring(0, 8)) + '\n';
  receipt += leftRight('Check-In:', formatTime(checkInDate)) + '\n';
  receipt += leftRight('Check-Out:', formatTime(checkOutDate)) + '\n';
  receipt += '\n';
  
  // Orders Breakdown
  if (breakdown) {
    receipt += 'ORDERS BREAKDOWN\n';
    receipt += line() + '\n';
    receipt += 'PICKUP/DINE-IN:\n';
    receipt += leftRight('  Cash:', `${breakdown.instore.cashCount} - ${formatCurrency(breakdown.instore.cashTotal)}`) + '\n';
    receipt += leftRight('  Card:', `${breakdown.instore.cardCount} - ${formatCurrency(breakdown.instore.cardTotal)}`) + '\n';
    receipt += '\n';
    receipt += 'DELIVERY:\n';
    receipt += leftRight('  Cash:', `${breakdown.delivery.cashCount} - ${formatCurrency(breakdown.delivery.cashTotal)}`) + '\n';
    receipt += leftRight('  Card:', `${breakdown.delivery.cardCount} - ${formatCurrency(breakdown.delivery.cardTotal)}`) + '\n';
    receipt += '\n';
    receipt += 'TOTAL:\n';
    receipt += leftRight('  Cash:', `${breakdown.overall.cashTotal > 0 ? 
      (breakdown.instore.cashCount + breakdown.delivery.cashCount) : 0} - ${formatCurrency(breakdown.overall.cashTotal)}`) + '\n';
    receipt += leftRight('  Card:', `${breakdown.overall.cardTotal > 0 ?
      (breakdown.instore.cardCount + breakdown.delivery.cardCount) : 0} - ${formatCurrency(breakdown.overall.cardTotal)}`) + '\n';
    receipt += line() + '\n';
    receipt += leftRight('GRAND TOTAL:', `${breakdown.overall.totalCount} - ${formatCurrency(breakdown.overall.totalAmount)}`) + '\n';
    receipt += '\n';
  }
  
  // Staff Shifts & Payments
  // Note: Staff payments are now retrieved from the `staff_payments` table (not shift_expenses).
  // The staffPayments array is populated by StaffService.getShiftSummary() which queries staff_payments
  // and joins with staff table for staff_name and role_type.
  if (staffPayments.length > 0) {
    receipt += 'STAFF SHIFTS & PAYMENTS\n';
    receipt += line() + '\n';
    
    staffPayments.forEach((payment: NonNullable<ShiftSummary['staffPayments']>[number]) => {
      const name = payment.staff_name || payment.staff_id;
      const role = payment.role_type || 'Staff';
      const amount = formatCurrency(payment.amount);
      
      receipt += `${name} (${role})\n`;
      if (payment.check_in_time && payment.check_out_time) {
        const checkIn = formatTime(new Date(payment.check_in_time));
        const checkOut = formatTime(new Date(payment.check_out_time));
        receipt += `  ${checkIn} - ${checkOut}\n`;
      }
      receipt += leftRight('  Payment:', amount) + '\n';
      receipt += '\n';
    });
    
    const totalPayments = staffPayments.reduce((sum: number, p: NonNullable<ShiftSummary['staffPayments']>[number]) => sum + p.amount, 0);
    receipt += line() + '\n';
    receipt += leftRight('Total Staff Payments:', formatCurrency(totalPayments)) + '\n';
    receipt += '\n';
  }
  
  // Expenses
  if (summary.expenses && summary.expenses.length > 0) {
    receipt += 'EXPENSES\n';
    receipt += line() + '\n';
    
    const nonPaymentExpenses = summary.expenses;
    nonPaymentExpenses.forEach((expense: ShiftExpense) => {
      receipt += `${expense.description}\n`;
      receipt += leftRight('  Type:', expense.expense_type) + '\n';
      receipt += leftRight('  Amount:', formatCurrency(expense.amount)) + '\n';
      receipt += '\n';
    });
    
    if (nonPaymentExpenses.length > 0) {
      const totalExpenses = nonPaymentExpenses.reduce((sum: number, e: ShiftExpense) => sum + e.amount, 0);
      receipt += line() + '\n';
      receipt += leftRight('Total Expenses:', formatCurrency(totalExpenses)) + '\n';
      receipt += '\n';
    }
  }

  // Transferred Drivers Section
  // These are active drivers inherited from the previous cashier who haven't checked out yet
  // Their amounts are NOT included in this cashier's expected drawer calculation
  const transferredDrivers = summary.transferredDrivers || [];
  if (transferredDrivers.length > 0) {
    receipt += line('=') + '\n';
    receipt += 'TRANSFERRED DRIVERS\n';
    receipt += center('(Active drivers from previous cashier)') + '\n';
    receipt += line('=') + '\n';
    receipt += '\n';

    transferredDrivers.forEach((driver: TransferredDriverInfo) => {
      const name = driver.driver_name || `Driver ${driver.driver_id.slice(-6)}`;
      const checkIn = driver.check_in_time ? formatTime(new Date(driver.check_in_time)) : 'N/A';

      receipt += `${name}\n`;
      receipt += leftRight('  Check-In:', checkIn) + '\n';
      receipt += leftRight('  Starting Amount:', formatCurrency(driver.starting_amount)) + '\n';
      receipt += leftRight('  Cash Collected:', formatCurrency(driver.cash_collected || 0)) + '\n';
      receipt += leftRight('  Card Amount:', formatCurrency(driver.card_amount || 0)) + '\n';
      receipt += leftRight('  Expenses:', formatCurrency(driver.expenses)) + '\n';
      receipt += leftRight('  Net Cash Amount:', formatCurrency(driver.net_cash_amount)) + '\n';
      receipt += '\n';
    });

    const totalTransferredCash = transferredDrivers.reduce(
      (sum: number, d: TransferredDriverInfo) => sum + d.net_cash_amount, 0
    );
    receipt += line() + '\n';
    receipt += leftRight('Total Transferred:', formatCurrency(totalTransferredCash)) + '\n';
    receipt += '\n';
    receipt += center('*** NOT INCLUDED IN EXPECTED ***') + '\n';
    receipt += center('*** AMOUNT CALCULATION ***') + '\n';
    receipt += '\n';
  }

  // Cash Drawer Summary
  // Note: Transferred driver amounts are excluded from the expected drawer calculation.
  // They will be resolved when the drivers check out under the next cashier.
  if (cashDrawer) {
    receipt += line('=') + '\n';
    receipt += 'CASH DRAWER SUMMARY\n';
    receipt += line('=') + '\n';

    // Show note if there are transferred drivers
    if (transferredDrivers.length > 0) {
      receipt += center(`Note: ${transferredDrivers.length} driver(s) transferred`) + '\n';
      receipt += center('to next cashier') + '\n';
      receipt += line() + '\n';
    }

    receipt += leftRight('Opening Amount:', formatCurrency(cashDrawer.opening_amount)) + '\n';
    receipt += leftRight('Cash Sales:', formatCurrency(cashDrawer.total_cash_sales)) + '\n';
    receipt += leftRight('Cash Refunds:', formatCurrency(cashRefunds)) + '\n';
    receipt += leftRight('Expenses:', formatCurrency(cashDrawer.total_expenses)) + '\n';
    receipt += leftRight('Cash Drops:', formatCurrency(cashDrawer.cash_drops)) + '\n';
    receipt += leftRight('Driver Cash Given:', formatCurrency(cashDrawer.driver_cash_given)) + '\n';
    receipt += leftRight('Driver Cash Returned:', formatCurrency(cashDrawer.driver_cash_returned)) + '\n';
    receipt += leftRight('Staff Payments:', formatCurrency(cashDrawer.total_staff_payments)) + '\n';
    receipt += line() + '\n';
    receipt += leftRight('EXPECTED AMOUNT:', formatCurrency(cashDrawer.expected_amount || 0)) + '\n';
    receipt += leftRight('CLOSING AMOUNT:', formatCurrency(cashDrawer.closing_amount || 0)) + '\n';
    receipt += line() + '\n';

    const variance = (cashDrawer.variance_amount || 0);
    const varianceLabel = variance >= 0 ? 'OVERAGE:' : 'SHORTAGE:';
    receipt += leftRight(varianceLabel, formatCurrency(Math.abs(variance))) + '\n';
    receipt += line('=') + '\n';
    receipt += '\n';

    if (Math.abs(variance) > 0) {
      receipt += center(variance >= 0 ? '*** OVERAGE DETECTED ***' : '*** SHORTAGE DETECTED ***') + '\n';
      receipt += '\n';
    }
  }
  
  // Notes
  if (shift.notes) {
    receipt += 'NOTES:\n';
    receipt += line() + '\n';
    receipt += shift.notes + '\n';
    receipt += '\n';
  }
  
  // Signature
  receipt += '\n';
  receipt += line() + '\n';
  receipt += '\n';
  receipt += 'CASHIER SIGNATURE:\n';
  receipt += '\n';
  receipt += 'X_______________________________\n';
  receipt += '\n';
  receipt += 'MANAGER SIGNATURE:\n';
  receipt += '\n';
  receipt += 'X_______________________________\n';
  receipt += '\n';
  receipt += line() + '\n';
  receipt += '\n';
  receipt += center('Thank you!') + '\n';
  receipt += '\n';
  receipt += '\n';
  receipt += '\n';
  
  return receipt;
}
