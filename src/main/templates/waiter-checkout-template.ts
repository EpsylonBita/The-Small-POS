/**
 * Waiter Checkout Print Template
 * 
 * Generates waiter checkout receipts using bitmap rendering for consistent display.
 * Supports both classic and modern template styles.
 * Supports i18n for English and Greek languages.
 */

import { ReceiptTemplateConfig, PaperSize } from '../printer/types';
import { BaseReceiptTemplate } from './BaseReceiptTemplate';
import { ShiftSummary, ShiftExpense } from '../../renderer/types/shift';
import { TextLine } from '../printer/services/escpos/GreekBitmapRenderer';
import {
  t, formatCurrency, formatDate, formatTime,
  addSectionHeader, addMajorSectionHeader, addSignatureLines,
  generateBitmapBuffer, getDefaultConfig, CheckoutConfig
} from './checkout-bitmap-utils';

/**
 * Waiter Checkout Template Class
 */
class WaiterCheckoutTemplate extends BaseReceiptTemplate {
  private summary: ShiftSummary;

  constructor(summary: ShiftSummary, config: Partial<ReceiptTemplateConfig> = {}) {
    super(config);
    this.summary = summary;
  }

  generate(): Buffer {
    this.initializeBuilder();
    const { shift, waiterTables = [] } = this.summary;
    
    const checkInDate = new Date(shift.check_in_time);
    const checkOutDate = shift.check_out_time ? new Date(shift.check_out_time) : new Date();

    // Calculate totals
    const totalTables = waiterTables.length;
    const totalOrders = waiterTables.reduce((sum, table) => sum + table.order_count, 0);
    const totalCashAmount = waiterTables.reduce((sum, table) => sum + table.cash_amount, 0);
    const totalCardAmount = waiterTables.reduce((sum, table) => sum + table.card_amount, 0);
    const totalCashCollected = totalCashAmount;

    const startingAmount = shift.opening_cash_amount || 0;
    const expenses = this.summary.expenses.reduce((sum, e) => sum + e.amount, 0);
    const paymentAmount = shift.payment_amount || 0;
    const cashToReturn = totalCashCollected - startingAmount - expenses - paymentAmount;

    // Count canceled orders and payment types
    let canceledOrders = 0;
    let cashOrdersCount = 0;
    let cardOrdersCount = 0;
    waiterTables.forEach(table => {
      const orders = Array.isArray(table.orders) ? table.orders : [];
      orders.forEach((order: any) => {
        const s = (order.status || '').toLowerCase();
        if (s === 'cancelled' || s === 'canceled') canceledOrders++;
        const pm = (order.payment_method || '').toLowerCase();
        if (pm === 'cash') cashOrdersCount++;
        else if (pm === 'card') cardOrdersCount++;
      });
    });

    // Header
    this.builder.receiptTitle(this.t('receipt.waiterCheckout.title'));
    
    if (this.config.terminalName) {
      this.builder.alignCenter().textLine(this.config.terminalName).alignLeft();
    }
    
    this.builder
      .alignCenter()
      .textLine(this.formatDate(checkOutDate))
      .textLine(this.formatTime(checkOutDate))
      .alignLeft()
      .emptyLine();

    // Waiter Information
    this.builder
      .subsectionHeader(this.t('receipt.waiterCheckout.waiterInfo'))
      .twoColumnRow(`${this.t('receipt.waiterCheckout.name')}:`, shift.staff_id)
      .twoColumnRow(`${this.t('receipt.waiterCheckout.shiftId')}:`, shift.id.substring(0, 8))
      .twoColumnRow(`${this.t('receipt.waiterCheckout.checkIn')}:`, this.formatTime(checkInDate))
      .twoColumnRow(`${this.t('receipt.waiterCheckout.checkOut')}:`, this.formatTime(checkOutDate))
      .emptyLine();

    // Table Summary
    this.builder
      .subsectionHeader(this.t('receipt.waiterCheckout.tableSummary'))
      .twoColumnRow(`${this.t('receipt.waiterCheckout.totalTables')}:`, totalTables.toString())
      .twoColumnRow(`${this.t('receipt.waiterCheckout.totalOrders')}:`, totalOrders.toString());
    
    if (canceledOrders > 0) {
      this.builder.indentedTwoColumn(`${this.t('receipt.waiterCheckout.canceled')}:`, canceledOrders.toString());
    }
    
    this.builder
      .indentedTwoColumn(`${this.t('receipt.waiterCheckout.cashOrders')}:`, 
        `${cashOrdersCount} - ${this.formatCurrency(totalCashAmount)}`)
      .indentedTwoColumn(`${this.t('receipt.waiterCheckout.cardOrders')}:`, 
        `${cardOrdersCount} - ${this.formatCurrency(totalCardAmount)}`)
      .dashedLine()
      .leftRightBold(this.t('receipt.waiterCheckout.total') + ':', 
        this.formatCurrency(totalCashAmount + totalCardAmount))
      .emptyLine();

    // Table Details
    if (waiterTables.length > 0) {
      this.addTableDetails(waiterTables);
    }

    // Cash Reconciliation
    this.builder
      .thickLine()
      .centeredBold(this.t('receipt.waiterCheckout.cashReconciliation'))
      .thickLine()
      .twoColumnRow(`${this.t('receipt.waiterCheckout.startingAmount')}:`, this.formatCurrency(startingAmount))
      .twoColumnRow(`${this.t('receipt.waiterCheckout.cashCollected')}:`, this.formatCurrency(totalCashCollected))
      .twoColumnRow(`${this.t('receipt.waiterCheckout.expenses')}:`, this.formatCurrency(expenses))
      .twoColumnRow(`${this.t('receipt.waiterCheckout.payment')}:`, this.formatCurrency(paymentAmount))
      .dashedLine();

    const returnLabel = cashToReturn >= 0 
      ? this.t('receipt.waiterCheckout.cashToReturn') + ':'
      : this.t('receipt.cashierCheckout.shortage') + ':';
    
    this.builder
      .leftRightBold(returnLabel, this.formatCurrency(Math.abs(cashToReturn)))
      .thickLine()
      .emptyLine();

    if (cashToReturn < 0) {
      this.builder.warningMessage(this.t('receipt.waiterCheckout.shortage'));
    }

    // Signatures
    this.addSignatures([
      this.t('receipt.waiterCheckout.waiterSignature'),
      this.t('receipt.waiterCheckout.managerSignature')
    ]);

    // Footer
    this.addFooter(this.t('receipt.waiterCheckout.footer'));

    return this.builder.build();
  }

  private addTableDetails(tables: NonNullable<ShiftSummary['waiterTables']>): void {
    this.builder
      .subsectionHeader(this.t('receipt.waiterCheckout.tableDetails'))
      .textLine(`${this.t('receipt.waiterCheckout.table').padEnd(6)}| ${this.t('receipt.waiterCheckout.orders').padEnd(7)}| ${this.t('receipt.waiterCheckout.amount').padStart(7)} | ${this.t('receipt.waiterCheckout.status')}`)
      .dashedLine();

    tables.forEach(table => {
      const tableNum = (table.table_number || 'N/A').substring(0, 6);
      const orders = Array.isArray(table.orders) ? table.orders : [];
      const orderCountStr = table.order_count.toString();
      const amount = this.formatCurrency(table.total_amount).padStart(7);

      const hasActive = orders.some((o: any) => {
        const s = (o.status || '').toLowerCase();
        return s !== 'cancelled' && s !== 'canceled';
      });
      const statusSymbol = hasActive ? '✓' : '✗';

      let paymentSymbol = '💳';
      if (table.payment_method === 'cash') paymentSymbol = '💵';
      else if (table.payment_method === 'mixed') paymentSymbol = '💵+💳';

      this.builder.textLine(`${tableNum.padEnd(6)}| ${orderCountStr.padEnd(7)}| ${amount} | ${statusSymbol}${paymentSymbol}`);
    });

    this.builder.dashedLine().emptyLine();
  }
}

/**
 * Generate Waiter Checkout receipt as ESC/POS Buffer using bitmap rendering
 */
export function generateWaiterCheckoutReceiptBuffer(
  summary: ShiftSummary, 
  config: Partial<ReceiptTemplateConfig & { receiptTemplate?: 'classic' | 'modern' }> = {}
): Buffer {
  console.log('[WaiterCheckoutTemplate] generateWaiterCheckoutReceiptBuffer called (BITMAP MODE)');
  console.log('[WaiterCheckoutTemplate] Config:', JSON.stringify(config));
  
  const cfg = getDefaultConfig(config);
  const { language, currency, terminalName, receiptTemplate } = cfg;
  const isModern = receiptTemplate === 'modern';
  
  console.log('[WaiterCheckoutTemplate] Language:', language, 'Template:', receiptTemplate);
  
  const { shift, waiterTables = [], expenses = [] } = summary;
  const checkInDate = new Date(shift.check_in_time);
  const checkOutDate = shift.check_out_time ? new Date(shift.check_out_time) : new Date();

  // Calculate totals
  const totalTables = waiterTables.length;
  const totalOrders = waiterTables.reduce((sum, table) => sum + table.order_count, 0);
  const totalCashAmount = waiterTables.reduce((sum, table) => sum + table.cash_amount, 0);
  const totalCardAmount = waiterTables.reduce((sum, table) => sum + table.card_amount, 0);
  const totalCashCollected = totalCashAmount;

  const startingAmount = shift.opening_cash_amount || 0;
  const totalExpenses = expenses.reduce((sum, e) => sum + e.amount, 0);
  const paymentAmount = shift.payment_amount || 0;
  const cashToReturn = totalCashCollected - startingAmount - totalExpenses - paymentAmount;

  // Count canceled orders and payment types
  let canceledOrders = 0;
  let cashOrdersCount = 0;
  let cardOrdersCount = 0;
  waiterTables.forEach(table => {
    const orders = Array.isArray(table.orders) ? table.orders : [];
    orders.forEach((order: any) => {
      const s = (order.status || '').toLowerCase();
      if (s === 'cancelled' || s === 'canceled') canceledOrders++;
      const pm = (order.payment_method || '').toLowerCase();
      if (pm === 'cash') cashOrdersCount++;
      else if (pm === 'card') cardOrdersCount++;
    });
  });

  const lines: TextLine[] = [];

  // ═══════════════════════════════════════════════════════════════
  // HEADER
  // ═══════════════════════════════════════════════════════════════
  lines.push({ text: '', style: 'normal', align: 'left' });
  
  if (isModern) {
    lines.push({ text: t('receipt.waiterCheckout.title', language), style: 'boxHeader', align: 'center', inverted: true });
    lines.push({ text: '', style: 'small', align: 'left' });
    if (terminalName) {
      lines.push({ text: terminalName, style: 'normal', align: 'center' });
    }
    lines.push({ text: formatDate(checkOutDate, language), style: 'normal', align: 'center' });
    lines.push({ text: formatTime(checkOutDate, language), style: 'normal', align: 'center' });
  } else {
    lines.push({ text: t('receipt.waiterCheckout.title', language), style: 'title', align: 'center' });
    lines.push({ text: '════════════════════════════════════════════', style: 'small', align: 'center' });
    if (terminalName) {
      lines.push({ text: terminalName, style: 'normal', align: 'center' });
    }
    lines.push({ text: formatDate(checkOutDate, language), style: 'normal', align: 'center' });
    lines.push({ text: formatTime(checkOutDate, language), style: 'normal', align: 'center' });
  }
  lines.push({ text: '', style: 'small', align: 'left' });

  // ═══════════════════════════════════════════════════════════════
  // WAITER INFORMATION
  // ═══════════════════════════════════════════════════════════════
  addSectionHeader(lines, t('receipt.waiterCheckout.waiterInfo', language), isModern);
  const staffName = (shift as any).staff_name || '';
  lines.push({ text: t('receipt.waiterCheckout.name', language) + ':', style: 'normal', align: 'left', rightText: staffName });
  lines.push({ text: t('receipt.waiterCheckout.shiftId', language) + ':', style: 'normal', align: 'left', rightText: shift.id.substring(0, 8) });
  lines.push({ text: t('receipt.waiterCheckout.checkIn', language) + ':', style: 'normal', align: 'left', rightText: formatTime(checkInDate, language) });
  lines.push({ text: t('receipt.waiterCheckout.checkOut', language) + ':', style: 'normal', align: 'left', rightText: formatTime(checkOutDate, language) });
  lines.push({ text: '', style: 'small', align: 'left' });

  // ═══════════════════════════════════════════════════════════════
  // TABLE SUMMARY
  // ═══════════════════════════════════════════════════════════════
  addSectionHeader(lines, t('receipt.waiterCheckout.tableSummary', language), isModern);
  lines.push({ text: t('receipt.waiterCheckout.totalTables', language) + ':', style: 'normal', align: 'left', rightText: totalTables.toString() });
  lines.push({ text: t('receipt.waiterCheckout.totalOrders', language) + ':', style: 'normal', align: 'left', rightText: totalOrders.toString() });
  
  if (canceledOrders > 0) {
    lines.push({ text: '  ' + t('receipt.waiterCheckout.canceled', language) + ':', style: 'small', align: 'left', rightText: canceledOrders.toString() });
  }
  
  lines.push({ text: '  ' + t('receipt.waiterCheckout.cashOrders', language) + ':', style: 'normal', align: 'left', rightText: cashOrdersCount + ' - ' + formatCurrency(totalCashAmount, currency) });
  lines.push({ text: '  ' + t('receipt.waiterCheckout.cardOrders', language) + ':', style: 'normal', align: 'left', rightText: cardOrdersCount + ' - ' + formatCurrency(totalCardAmount, currency) });
  lines.push({ text: '────────────────────────────────────────────', style: 'small', align: 'center' });
  lines.push({ text: t('receipt.waiterCheckout.total', language) + ':', style: 'bold', align: 'left', rightText: formatCurrency(totalCashAmount + totalCardAmount, currency) });
  lines.push({ text: '', style: 'small', align: 'left' });

  // ═══════════════════════════════════════════════════════════════
  // TABLE DETAILS
  // ═══════════════════════════════════════════════════════════════
  if (waiterTables.length > 0) {
    addSectionHeader(lines, t('receipt.waiterCheckout.tableDetails', language), isModern);
    
    waiterTables.forEach(table => {
      const tableNum = table.table_number || 'N/A';
      const orders = Array.isArray(table.orders) ? table.orders : [];
      const orderCount = table.order_count;
      const amount = formatCurrency(table.total_amount, currency);

      const hasActive = orders.some((o: any) => {
        const s = (o.status || '').toLowerCase();
        return s !== 'cancelled' && s !== 'canceled';
      });
      const statusSymbol = hasActive ? '[OK]' : '[X]';

      let paymentSymbol = 'Card';
      if (table.payment_method === 'cash') paymentSymbol = 'Cash';
      else if (table.payment_method === 'mixed') paymentSymbol = 'Mixed';

      lines.push({ text: t('receipt.waiterCheckout.table', language) + ' ' + tableNum + ' ' + statusSymbol + ' ' + paymentSymbol, style: 'bold', align: 'left', rightText: amount });
      lines.push({ text: '  ' + t('receipt.waiterCheckout.orders', language) + ': ' + orderCount, style: 'small', align: 'left' });
    });
    
    lines.push({ text: '────────────────────────────────────────────', style: 'small', align: 'center' });
    lines.push({ text: '', style: 'small', align: 'left' });
  }

  // ═══════════════════════════════════════════════════════════════
  // CASH RECONCILIATION
  // ═══════════════════════════════════════════════════════════════
  addMajorSectionHeader(lines, t('receipt.waiterCheckout.cashReconciliation', language), isModern);
  lines.push({ text: t('receipt.waiterCheckout.startingAmount', language) + ':', style: 'normal', align: 'left', rightText: formatCurrency(startingAmount, currency) });
  lines.push({ text: t('receipt.waiterCheckout.cashCollected', language) + ':', style: 'normal', align: 'left', rightText: formatCurrency(totalCashCollected, currency) });
  lines.push({ text: t('receipt.waiterCheckout.expenses', language) + ':', style: 'normal', align: 'left', rightText: formatCurrency(totalExpenses, currency) });
  lines.push({ text: t('receipt.waiterCheckout.payment', language) + ':', style: 'normal', align: 'left', rightText: formatCurrency(paymentAmount, currency) });
  lines.push({ text: '────────────────────────────────────────────', style: 'small', align: 'center' });

  const returnLabel = cashToReturn >= 0 
    ? t('receipt.waiterCheckout.cashToReturn', language) + ':'
    : t('receipt.cashierCheckout.shortage', language) + ':';
  
  lines.push({ text: returnLabel, style: 'bold', align: 'left', rightText: formatCurrency(Math.abs(cashToReturn), currency) });
  
  if (isModern) {
    lines.push({ text: '', style: 'small', align: 'left' });
  } else {
    lines.push({ text: '════════════════════════════════════════════', style: 'small', align: 'center' });
  }
  lines.push({ text: '', style: 'small', align: 'left' });

  if (cashToReturn < 0) {
    lines.push({ text: '*** ' + t('receipt.waiterCheckout.shortage', language) + ' ***', style: 'bold', align: 'center' });
    lines.push({ text: '', style: 'small', align: 'left' });
  }

  // ═══════════════════════════════════════════════════════════════
  // SIGNATURES
  // ═══════════════════════════════════════════════════════════════
  addSignatureLines(lines, [
    t('receipt.waiterCheckout.waiterSignature', language),
    t('receipt.waiterCheckout.managerSignature', language)
  ]);

  // ═══════════════════════════════════════════════════════════════
  // FOOTER
  // ═══════════════════════════════════════════════════════════════
  lines.push({ text: '', style: 'normal', align: 'left' });
  lines.push({ text: '────────────────────────────────────────────', style: 'small', align: 'center' });
  lines.push({ text: t('receipt.waiterCheckout.footer', language), style: 'normal', align: 'center' });
  lines.push({ text: '', style: 'normal', align: 'left' });
  lines.push({ text: '', style: 'normal', align: 'left' });

  return generateBitmapBuffer(lines, cfg.paperSize, 'WaiterCheckoutTemplate');
}

/**
 * Generate Waiter Checkout receipt as plain text string (legacy compatibility)
 */
export function generateWaiterCheckoutReceipt(
  summary: ShiftSummary, 
  terminalName?: string, 
  paperWidth: number = 48
): string {
  const { shift, waiterTables = [] } = summary;

  const checkInDate = new Date(shift.check_in_time);
  const checkOutDate = shift.check_out_time ? new Date(shift.check_out_time) : new Date();

  // Calculate totals
  const totalTables = waiterTables.length;
  const totalOrders = waiterTables.reduce((sum, table) => sum + table.order_count, 0);
  const totalCashAmount = waiterTables.reduce((sum, table) => sum + table.cash_amount, 0);
  const totalCardAmount = waiterTables.reduce((sum, table) => sum + table.card_amount, 0);
  const totalCashCollected = totalCashAmount;

  const startingAmount = shift.opening_cash_amount || 0;
  const expenses = summary.expenses.reduce((sum: number, e: ShiftExpense) => sum + e.amount, 0);
  const paymentAmount = shift.payment_amount || 0;
  const cashToReturn = totalCashCollected - startingAmount - expenses - paymentAmount;

  const formatDate = (date: Date) => date.toLocaleDateString('en-US', { year: 'numeric', month: '2-digit', day: '2-digit' });
  const formatTime = (date: Date) => date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
  const formatCurrency = (amount: number) => `€${amount.toFixed(2)}`;
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
  receipt += center('WAITER CHECKOUT') + '\n';
  receipt += line('=') + '\n';
  receipt += '\n';

  if (terminalName) receipt += center(terminalName) + '\n';
  receipt += center(formatDate(checkOutDate)) + '\n';
  receipt += center(formatTime(checkOutDate)) + '\n';
  receipt += '\n';
  receipt += line() + '\n';
  receipt += '\n';

  // Waiter Information
  receipt += 'WAITER INFORMATION\n';
  receipt += line() + '\n';
  receipt += leftRight('Name:', shift.staff_id) + '\n';
  receipt += leftRight('Shift ID:', shift.id.substring(0, 8)) + '\n';
  receipt += leftRight('Check-In:', formatTime(checkInDate)) + '\n';
  receipt += leftRight('Check-Out:', formatTime(checkOutDate)) + '\n';
  receipt += '\n';

  // Table Summary
  let canceledOrders = 0;
  let cashOrdersCount = 0;
  let cardOrdersCount = 0;
  waiterTables.forEach(table => {
    const orders = Array.isArray(table.orders) ? table.orders : [];
    orders.forEach((order: any) => {
      const s = (order.status || '').toLowerCase();
      if (s === 'cancelled' || s === 'canceled') canceledOrders++;
      const pm = (order.payment_method || '').toLowerCase();
      if (pm === 'cash') cashOrdersCount++;
      else if (pm === 'card') cardOrdersCount++;
    });
  });

  receipt += 'TABLE SUMMARY\n';
  receipt += line() + '\n';
  receipt += leftRight('Total Tables:', totalTables.toString()) + '\n';
  receipt += leftRight('Total Orders:', totalOrders.toString()) + '\n';
  if (canceledOrders > 0) {
    receipt += leftRight('  Canceled:', canceledOrders.toString()) + '\n';
  }
  receipt += leftRight('  Cash Orders:', cashOrdersCount + ' - ' + formatCurrency(totalCashAmount)) + '\n';
  receipt += leftRight('  Card Orders:', cardOrdersCount + ' - ' + formatCurrency(totalCardAmount)) + '\n';
  receipt += line() + '\n';
  receipt += leftRight('TOTAL:', formatCurrency(totalCashAmount + totalCardAmount)) + '\n';
  receipt += '\n';

  // Table Details
  if (waiterTables.length > 0) {
    receipt += 'TABLE DETAILS\n';
    receipt += line() + '\n';
    receipt += 'Table | Orders | Amount  | Status\n';
    receipt += line() + '\n';

    waiterTables.forEach(table => {
      const tableNum = (table.table_number || 'N/A').substring(0, 6);
      const orders = Array.isArray(table.orders) ? table.orders : [];
      const orderCountStr = table.order_count.toString();
      const amount = formatCurrency(table.total_amount).padStart(7);

      const hasActive = orders.some((o: any) => {
        const s = (o.status || '').toLowerCase();
        return s !== 'cancelled' && s !== 'canceled';
      });
      const statusSymbol = hasActive ? '✓' : '✗';

      let paymentSymbol = '💳';
      if (table.payment_method === 'cash') paymentSymbol = '💵';
      else if (table.payment_method === 'mixed') paymentSymbol = '💵+💳';

      receipt += `${tableNum.padEnd(6)}| ${orderCountStr.padEnd(7)}| ${amount} | ${statusSymbol}${paymentSymbol}\n`;
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
  receipt += 'WAITER SIGNATURE:\n';
  receipt += '\n';
  receipt += 'X_______________________________\n';
  receipt += '\n';
  receipt += 'MANAGER SIGNATURE:\n';
  receipt += '\n';
  receipt += 'X_______________________________\n';
  receipt += '\n';
  receipt += line() + '\n';
  receipt += '\n';
  receipt += center('Thank you for your service!') + '\n';
  receipt += '\n\n\n';

  return receipt;
}
