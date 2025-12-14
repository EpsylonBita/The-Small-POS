/**
 * Kitchen Checkout Print Template
 * 80mm thermal printer format
 */

import { ShiftSummary } from '../../renderer/types/shift';

export function generateKitchenCheckoutReceipt(summary: ShiftSummary, terminalName?: string, paperWidth: number = 48): string {
  const { shift } = summary;
  
  const checkInDate = new Date(shift.check_in_time);
  const checkOutDate = shift.check_out_time ? new Date(shift.check_out_time) : new Date();
  
  // Calculate hours worked
  const hoursWorked = ((checkOutDate.getTime() - checkInDate.getTime()) / (1000 * 60 * 60)).toFixed(2);
  
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
  receipt += center('KITCHEN STAFF CHECKOUT') + '\n';
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
  receipt += 'STAFF INFORMATION\n';
  receipt += line() + '\n';
  receipt += leftRight('Name:', shift.staff_id) + '\n';
  receipt += leftRight('Role:', 'Kitchen Staff') + '\n';
  receipt += leftRight('Shift ID:', shift.id.substring(0, 8)) + '\n';
  receipt += '\n';
  
  // Shift Times
  receipt += 'SHIFT TIMES\n';
  receipt += line() + '\n';
  receipt += leftRight('Check-In:', formatTime(checkInDate)) + '\n';
  receipt += leftRight('Check-Out:', formatTime(checkOutDate)) + '\n';
  receipt += leftRight('Hours Worked:', hoursWorked + ' hrs') + '\n';
  receipt += '\n';
  
  // Payment
  receipt += line('=') + '\n';
  receipt += 'PAYMENT\n';
  receipt += line('=') + '\n';
  receipt += leftRight('Payment Amount:', formatCurrency(shift.payment_amount || 0)) + '\n';
  receipt += line('=') + '\n';
  receipt += '\n';
  
  // Signature
  receipt += '\n';
  receipt += line() + '\n';
  receipt += '\n';
  receipt += 'STAFF SIGNATURE:\n';
  receipt += '\n';
  receipt += 'X_______________________________\n';
  receipt += '\n';
  receipt += 'MANAGER SIGNATURE:\n';
  receipt += '\n';
  receipt += 'X_______________________________\n';
  receipt += '\n';
  receipt += line() + '\n';
  receipt += '\n';
  receipt += center('Thank you for your hard work!') + '\n';
  receipt += '\n';
  receipt += '\n';
  receipt += '\n';
  
  return receipt;
}
