/**
 * Driver Checkout Print Template
 * 80mm thermal printer format
 */

import { ShiftSummary, ShiftExpense } from '../../renderer/types/shift';

export function generateDriverCheckoutReceipt(summary: ShiftSummary, terminalName?: string, paperWidth: number = 48): string {
  const { shift, driverDeliveries = [] } = summary;
  
  const checkInDate = new Date(shift.check_in_time);
  const checkOutDate = shift.check_out_time ? new Date(shift.check_out_time) : new Date();
  
  // Calculate totals
  const totalOrders = driverDeliveries.length;
  const totalCashOrders = driverDeliveries.filter((d: NonNullable<ShiftSummary['driverDeliveries']>[number]) => d.payment_method === 'cash').length;
  const totalCardOrders = driverDeliveries.filter((d: NonNullable<ShiftSummary['driverDeliveries']>[number]) => d.payment_method === 'card').length;
  const totalCashAmount = driverDeliveries
    .filter((d: NonNullable<ShiftSummary['driverDeliveries']>[number]) => d.payment_method === 'cash')
    .reduce((sum: number, d: NonNullable<ShiftSummary['driverDeliveries']>[number]) => sum + d.total_amount, 0);
  const totalCardAmount = driverDeliveries
    .filter((d: NonNullable<ShiftSummary['driverDeliveries']>[number]) => d.payment_method === 'card')
    .reduce((sum: number, d: NonNullable<ShiftSummary['driverDeliveries']>[number]) => sum + d.total_amount, 0);
  const totalCashCollected = driverDeliveries.reduce((sum: number, d: NonNullable<ShiftSummary['driverDeliveries']>[number]) => sum + d.cash_collected, 0);

  const startingAmount = shift.opening_cash_amount || 0;
  const expenses = summary.expenses.reduce((sum: number, e: ShiftExpense) => sum + e.amount, 0);
  const paymentAmount = shift.payment_amount || 0;
  const cashToReturn = totalCashCollected - startingAmount - expenses - paymentAmount;
  
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
  receipt += center('DRIVER CHECKOUT') + '\n';
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
  
  // Staff Information
  receipt += 'DRIVER INFORMATION\n';
  receipt += line() + '\n';
  receipt += leftRight('Name:', shift.staff_id) + '\n';
  receipt += leftRight('Shift ID:', shift.id.substring(0, 8)) + '\n';
  receipt += leftRight('Check-In:', formatTime(checkInDate)) + '\n';
  receipt += leftRight('Check-Out:', formatTime(checkOutDate)) + '\n';
  receipt += '\n';
  
  // Delivery Summary
  // Count canceled orders (included in totals for reconciliation purposes)
  const canceledOrders = driverDeliveries.filter((d: any) => d.status === 'cancelled' || d.status === 'canceled').length;

  receipt += 'DELIVERY SUMMARY\n';
  receipt += line() + '\n';
  receipt += leftRight('Total Orders:', totalOrders.toString()) + '\n';
  if (canceledOrders > 0) {
    receipt += leftRight('  Canceled:', canceledOrders.toString()) + '\n';
  }
  receipt += leftRight('  Cash Orders:', totalCashOrders + ' - ' + formatCurrency(totalCashAmount)) + '\n';
  receipt += leftRight('  Card Orders:', totalCardOrders + ' - ' + formatCurrency(totalCardAmount)) + '\n';
  receipt += line() + '\n';
  receipt += leftRight('TOTAL:', formatCurrency(totalCashAmount + totalCardAmount)) + '\n';
  receipt += '\n';
  
  // Detailed Orders with status symbols
  // ✓ = completed/delivered, ✗ = canceled, 💵 = cash, 💳 = card, 💵+💳 = mixed
  if (driverDeliveries.length > 0) {
    receipt += 'ORDER DETAILS\n';
    receipt += line() + '\n';
    receipt += 'No.  | Address            | Amount  | Status\n';
    receipt += line() + '\n';

    driverDeliveries.forEach((delivery: NonNullable<ShiftSummary['driverDeliveries']>[number], index: number) => {
      const orderNum = delivery.order_number || `#${index + 1}`;
      const address = (delivery.delivery_address || 'N/A').substring(0, 18);
      const amount = formatCurrency(delivery.total_amount).padStart(7);

      // Derive normalized status: prefer delivery.status, fallback to order_status, lowercase for comparison
      const rawStatus = (delivery as any).status || (delivery as any).order_status || '';
      const normalizedStatus = rawStatus.toLowerCase();

      // Status symbol: ✓ for completed/delivered, ✗ for canceled states
      const isCanceled = normalizedStatus === 'cancelled' || normalizedStatus === 'canceled';
      const statusSymbol = isCanceled ? '✗' : '✓';

      // Payment symbol: handle 'cash', 'card', 'mixed', and other values
      const paymentMethod = (delivery.payment_method || '').toLowerCase();
      let paymentSymbol: string;
      if (paymentMethod === 'cash') {
        paymentSymbol = '💵';
      } else if (paymentMethod === 'card') {
        paymentSymbol = '💳';
      } else if (paymentMethod === 'mixed') {
        paymentSymbol = '💵+💳';
      } else {
        // Fallback for unknown payment methods
        paymentSymbol = '💳';
      }

      receipt += `${orderNum.padEnd(5)}| ${address.padEnd(19)}| ${amount} | ${statusSymbol}${paymentSymbol}\n`;
    });

    receipt += line() + '\n';
    receipt += '\n';
  }
  
  // Cash Reconciliation
  receipt += line('=') + '\n';
  receipt += 'CASH RECONCILIATION\n';
  receipt += line('=') + '\n';
  receipt += leftRight('Starting Amount:', formatCurrency(startingAmount)) + '\n';
  receipt += leftRight('Cash Collected:', formatCurrency(totalCashCollected)) + '\n';
  receipt += leftRight('Expenses:', formatCurrency(expenses)) + '\n';
  receipt += leftRight('Payment:', formatCurrency(paymentAmount)) + '\n';
  receipt += line() + '\n';
  
  const returnLabel = cashToReturn >= 0 ? 'Cash to Return:' : 'Shortage:';
  const returnAmount = Math.abs(cashToReturn);
  receipt += leftRight(returnLabel, formatCurrency(returnAmount)) + '\n';
  receipt += line('=') + '\n';
  receipt += '\n';
  
  if (cashToReturn < 0) {
    receipt += center('*** SHORTAGE - WILL BE DEDUCTED ***') + '\n';
    receipt += '\n';
  }
  
  // Signature
  receipt += '\n';
  receipt += line() + '\n';
  receipt += '\n';
  receipt += 'DRIVER SIGNATURE:\n';
  receipt += '\n';
  receipt += 'X_______________________________\n';
  receipt += '\n';
  receipt += 'CASHIER SIGNATURE:\n';
  receipt += '\n';
  receipt += 'X_______________________________\n';
  receipt += '\n';
  receipt += line() + '\n';
  receipt += '\n';
  receipt += center('Drive Safe!') + '\n';
  receipt += '\n';
  receipt += '\n';
  receipt += '\n';
  
  return receipt;
}
