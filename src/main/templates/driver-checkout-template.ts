/**
 * Driver Checkout Print Template
 * 
 * Generates driver checkout receipts using bitmap rendering for consistent display.
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
  generateBitmapBuffer, getDefaultConfig, CheckoutConfig,
  parseAddressSimple
} from './checkout-bitmap-utils';

/**
 * Driver Checkout Template Class
 */
class DriverCheckoutTemplate extends BaseReceiptTemplate {
  private summary: ShiftSummary;

  constructor(summary: ShiftSummary, config: Partial<ReceiptTemplateConfig> = {}) {
    super(config);
    this.summary = summary;
  }

  generate(): Buffer {
    this.initializeBuilder();
    const { shift, driverDeliveries = [] } = this.summary;
    
    const checkInDate = new Date(shift.check_in_time);
    const checkOutDate = shift.check_out_time ? new Date(shift.check_out_time) : new Date();

    // Calculate totals
    const totalOrders = driverDeliveries.length;
    const totalCashOrders = driverDeliveries.filter(d => d.payment_method === 'cash').length;
    const totalCardOrders = driverDeliveries.filter(d => d.payment_method === 'card').length;
    const totalCashAmount = driverDeliveries
      .filter(d => d.payment_method === 'cash')
      .reduce((sum, d) => sum + d.total_amount, 0);
    const totalCardAmount = driverDeliveries
      .filter(d => d.payment_method === 'card')
      .reduce((sum, d) => sum + d.total_amount, 0);
    const totalCashCollected = driverDeliveries.reduce((sum, d) => sum + d.cash_collected, 0);

    const startingAmount = shift.opening_cash_amount || 0;
    const expenses = this.summary.expenses.reduce((sum, e) => sum + e.amount, 0);
    const paymentAmount = shift.payment_amount || 0;
    // v2+: payment_amount is NOT deducted (cashier handles payment separately)
    // v1 (legacy): payment_amount is deducted from cash to return
    const calculationVersion = (shift as any).calculation_version || 1;
    const cashToReturn = calculationVersion >= 2
      ? startingAmount + totalCashCollected - expenses
      : startingAmount + totalCashCollected - paymentAmount - expenses;

    // Header
    this.builder.receiptTitle(this.t('receipt.driverCheckout.title'));
    
    if (this.config.terminalName) {
      this.builder.alignCenter().textLine(this.config.terminalName).alignLeft();
    }
    
    this.builder
      .alignCenter()
      .textLine(this.formatDate(checkOutDate))
      .textLine(this.formatTime(checkOutDate))
      .alignLeft()
      .emptyLine();

    // Driver Information
    this.builder
      .subsectionHeader(this.t('receipt.driverCheckout.driverInfo'))
      .twoColumnRow(`${this.t('receipt.driverCheckout.name')}:`, shift.staff_id)
      .twoColumnRow(`${this.t('receipt.driverCheckout.shiftId')}:`, shift.id.substring(0, 8))
      .twoColumnRow(`${this.t('receipt.driverCheckout.checkIn')}:`, this.formatTime(checkInDate))
      .twoColumnRow(`${this.t('receipt.driverCheckout.checkOut')}:`, this.formatTime(checkOutDate))
      .emptyLine();

    // Delivery Summary
    const canceledOrders = driverDeliveries.filter((d: any) => 
      d.status === 'cancelled' || d.status === 'canceled' || d.status === 'refunded'
    ).length;

    this.builder
      .subsectionHeader(this.t('receipt.driverCheckout.deliverySummary'))
      .twoColumnRow(`${this.t('receipt.driverCheckout.totalOrders')}:`, totalOrders.toString());
    
    if (canceledOrders > 0) {
      this.builder.indentedTwoColumn(`${this.t('receipt.driverCheckout.canceled')}:`, canceledOrders.toString());
    }
    
    this.builder
      .indentedTwoColumn(`${this.t('receipt.driverCheckout.cashOrders')}:`, 
        `${totalCashOrders} - ${this.formatCurrency(totalCashAmount)}`)
      .indentedTwoColumn(`${this.t('receipt.driverCheckout.cardOrders')}:`, 
        `${totalCardOrders} - ${this.formatCurrency(totalCardAmount)}`)
      .dashedLine()
      .leftRightBold(this.t('receipt.driverCheckout.total') + ':', 
        this.formatCurrency(totalCashAmount + totalCardAmount))
      .emptyLine();

    // Order Details
    if (driverDeliveries.length > 0) {
      this.addOrderDetails(driverDeliveries);
    }

    // Cash Reconciliation
    this.builder
      .thickLine()
      .centeredBold(this.t('receipt.driverCheckout.cashReconciliation'))
      .thickLine()
      .twoColumnRow(`${this.t('receipt.driverCheckout.startingAmount')}:`, this.formatCurrency(startingAmount))
      .twoColumnRow(`${this.t('receipt.driverCheckout.cashCollected')}:`, this.formatCurrency(totalCashCollected))
      .twoColumnRow(`${this.t('receipt.driverCheckout.expenses')}:`, this.formatCurrency(expenses))
      .twoColumnRow(`${this.t('receipt.driverCheckout.payment')}:`, this.formatCurrency(paymentAmount))
      .dashedLine();

    const returnLabel = cashToReturn >= 0 
      ? this.t('receipt.driverCheckout.cashToReturn') + ':'
      : this.t('receipt.cashierCheckout.shortage') + ':';
    
    this.builder
      .leftRightBold(returnLabel, this.formatCurrency(Math.abs(cashToReturn)))
      .thickLine()
      .emptyLine();

    if (cashToReturn < 0) {
      this.builder.warningMessage(this.t('receipt.driverCheckout.shortage'));
    }

    // Signatures
    this.addSignatures([
      this.t('receipt.driverCheckout.driverSignature'),
      this.t('receipt.driverCheckout.cashierSignature')
    ]);

    // Footer
    this.addFooter(this.t('receipt.driverCheckout.footer'));

    return this.builder.build();
  }

  private addOrderDetails(deliveries: NonNullable<ShiftSummary['driverDeliveries']>): void {
    this.builder.subsectionHeader(this.t('receipt.driverCheckout.orderDetails'));

    deliveries.forEach((delivery, index) => {
      const orderNum = delivery.order_number || `#${index + 1}`;
      const amount = this.formatCurrency(delivery.total_amount);

      const rawStatus = (delivery as any).status || (delivery as any).order_status || '';
      const normalizedStatus = rawStatus.toLowerCase();
      const isCanceled = normalizedStatus === 'cancelled' || normalizedStatus === 'canceled' || normalizedStatus === 'refunded';
      const statusSymbol = isCanceled ? '✗' : '✓';

      const paymentMethod = (delivery.payment_method || '').toLowerCase();
      let paymentSymbol = '💳';
      if (paymentMethod === 'cash') paymentSymbol = '💵';
      else if (paymentMethod === 'mixed') paymentSymbol = '💵+💳';

      // Format delivery time using locale-aware formatting
      const deliveryTime = (delivery as any).delivery_time;
      const timeStr = deliveryTime
        ? this.formatTime(new Date(deliveryTime))
        : '';

      // Order header line: Order# | Status | Payment | Time | Amount
      this.builder.textLine(`${orderNum} ${statusSymbol}${paymentSymbol} ${timeStr}`.padEnd(30) + amount.padStart(10));

      // Simplified address (street, city) for receipt readability
      const address = parseAddressSimple(delivery.delivery_address || '');
      this.builder.textLine(`  ${address}`);

      this.builder.emptyLine();
    });

    this.builder.dashedLine().emptyLine();
  }

  private wrapText(text: string, maxWidth: number): string[] {
    const lines: string[] = [];
    let remaining = text;
    while (remaining.length > maxWidth) {
      let breakPoint = remaining.lastIndexOf(' ', maxWidth);
      if (breakPoint === -1) breakPoint = maxWidth;
      lines.push(remaining.substring(0, breakPoint).trim());
      remaining = remaining.substring(breakPoint).trim();
    }
    if (remaining) lines.push(remaining);
    return lines;
  }
}

/**
 * Generate Driver Checkout receipt as ESC/POS Buffer using bitmap rendering
 */
export function generateDriverCheckoutReceiptBuffer(
  summary: ShiftSummary, 
  config: Partial<ReceiptTemplateConfig & { receiptTemplate?: 'classic' | 'modern' }> = {}
): Buffer {
  console.log('[DriverCheckoutTemplate] generateDriverCheckoutReceiptBuffer called (BITMAP MODE)');
  console.log('[DriverCheckoutTemplate] Config:', JSON.stringify(config));
  
  const cfg = getDefaultConfig(config);
  const { language, currency, terminalName, receiptTemplate } = cfg;
  const isModern = receiptTemplate === 'modern';
  
  console.log('[DriverCheckoutTemplate] Language:', language, 'Template:', receiptTemplate);
  
  const { shift, driverDeliveries = [], expenses = [] } = summary;
  const checkInDate = new Date(shift.check_in_time);
  const checkOutDate = shift.check_out_time ? new Date(shift.check_out_time) : new Date();

  // Calculate totals
  const totalOrders = driverDeliveries.length;
  const totalCashOrders = driverDeliveries.filter(d => d.payment_method === 'cash').length;
  const totalCardOrders = driverDeliveries.filter(d => d.payment_method === 'card').length;
  const totalCashAmount = driverDeliveries
    .filter(d => d.payment_method === 'cash')
    .reduce((sum, d) => sum + d.total_amount, 0);
  const totalCardAmount = driverDeliveries
    .filter(d => d.payment_method === 'card')
    .reduce((sum, d) => sum + d.total_amount, 0);
  const totalCashCollected = driverDeliveries.reduce((sum, d) => sum + d.cash_collected, 0);

  const startingAmount = shift.opening_cash_amount || 0;
  const totalExpenses = expenses.reduce((sum, e) => sum + e.amount, 0);
  const paymentAmount = shift.payment_amount || 0;
  // v2+: payment_amount is NOT deducted (cashier handles payment separately)
  // v1 (legacy): payment_amount is deducted from cash to return
  const calculationVersion = (shift as any).calculation_version || 1;
  const cashToReturn = calculationVersion >= 2
    ? startingAmount + totalCashCollected - totalExpenses
    : startingAmount + totalCashCollected - paymentAmount - totalExpenses;

  const canceledOrders = driverDeliveries.filter((d: any) => 
    d.status === 'cancelled' || d.status === 'canceled' || d.status === 'refunded'
  ).length;

  const lines: TextLine[] = [];

  // ═══════════════════════════════════════════════════════════════
  // HEADER
  // ═══════════════════════════════════════════════════════════════
  lines.push({ text: '', style: 'normal', align: 'left' });
  
  if (isModern) {
    lines.push({ text: t('receipt.driverCheckout.title', language), style: 'boxHeader', align: 'center', inverted: true });
    lines.push({ text: '', style: 'small', align: 'left' });
    if (terminalName) {
      lines.push({ text: terminalName, style: 'normal', align: 'center' });
    }
    lines.push({ text: formatDate(checkOutDate, language), style: 'normal', align: 'center' });
    lines.push({ text: formatTime(checkOutDate, language), style: 'normal', align: 'center' });
  } else {
    lines.push({ text: t('receipt.driverCheckout.title', language), style: 'title', align: 'center' });
    lines.push({ text: '════════════════════════════════════════════', style: 'small', align: 'center' });
    if (terminalName) {
      lines.push({ text: terminalName, style: 'normal', align: 'center' });
    }
    lines.push({ text: formatDate(checkOutDate, language), style: 'normal', align: 'center' });
    lines.push({ text: formatTime(checkOutDate, language), style: 'normal', align: 'center' });
  }
  lines.push({ text: '', style: 'small', align: 'left' });

  // ═══════════════════════════════════════════════════════════════
  // DRIVER INFORMATION
  // ═══════════════════════════════════════════════════════════════
  addSectionHeader(lines, t('receipt.driverCheckout.driverInfo', language), isModern);
  const staffName = (shift as any).staff_name || '';
  lines.push({ text: t('receipt.driverCheckout.name', language) + ':', style: 'normal', align: 'left', rightText: staffName });
  lines.push({ text: t('receipt.driverCheckout.shiftId', language) + ':', style: 'normal', align: 'left', rightText: shift.id.substring(0, 8) });
  lines.push({ text: t('receipt.driverCheckout.checkIn', language) + ':', style: 'normal', align: 'left', rightText: formatTime(checkInDate, language) });
  lines.push({ text: t('receipt.driverCheckout.checkOut', language) + ':', style: 'normal', align: 'left', rightText: formatTime(checkOutDate, language) });
  lines.push({ text: '', style: 'small', align: 'left' });

  // ═══════════════════════════════════════════════════════════════
  // DELIVERY SUMMARY
  // ═══════════════════════════════════════════════════════════════
  addSectionHeader(lines, t('receipt.driverCheckout.deliverySummary', language), isModern);
  lines.push({ text: t('receipt.driverCheckout.totalOrders', language) + ':', style: 'normal', align: 'left', rightText: totalOrders.toString() });
  
  if (canceledOrders > 0) {
    lines.push({ text: '  ' + t('receipt.driverCheckout.canceled', language) + ':', style: 'small', align: 'left', rightText: canceledOrders.toString() });
  }
  
  lines.push({ text: '  ' + t('receipt.driverCheckout.cashOrders', language) + ':', style: 'normal', align: 'left', rightText: totalCashOrders + ' - ' + formatCurrency(totalCashAmount, currency) });
  lines.push({ text: '  ' + t('receipt.driverCheckout.cardOrders', language) + ':', style: 'normal', align: 'left', rightText: totalCardOrders + ' - ' + formatCurrency(totalCardAmount, currency) });
  lines.push({ text: '────────────────────────────────────────────', style: 'small', align: 'center' });
  lines.push({ text: t('receipt.driverCheckout.total', language) + ':', style: 'bold', align: 'left', rightText: formatCurrency(totalCashAmount + totalCardAmount, currency) });
  lines.push({ text: '', style: 'small', align: 'left' });

  // ═══════════════════════════════════════════════════════════════
  // ORDER DETAILS
  // ═══════════════════════════════════════════════════════════════
  if (driverDeliveries.length > 0) {
    addSectionHeader(lines, t('receipt.driverCheckout.orderDetails', language), isModern);

    driverDeliveries.forEach((delivery, index) => {
      const orderNum = delivery.order_number || '#' + (index + 1);
      const amount = formatCurrency(delivery.total_amount, currency);

      const rawStatus = (delivery as any).status || (delivery as any).order_status || '';
      const normalizedStatus = rawStatus.toLowerCase();
      const isCanceled = normalizedStatus === 'cancelled' || normalizedStatus === 'canceled' || normalizedStatus === 'refunded';
      const statusSymbol = isCanceled ? '[X]' : '[OK]';

      const paymentMethod = (delivery.payment_method || '').toLowerCase();
      const paymentSymbol = paymentMethod === 'cash' ? 'Cash' : 'Card';

      // Format delivery time
      const deliveryTime = (delivery as any).delivery_time;
      const timeStr = deliveryTime
        ? new Date(deliveryTime).toLocaleTimeString(language === 'el' ? 'el-GR' : 'en-US', {
            hour: '2-digit',
            minute: '2-digit',
            hour12: language !== 'el'
          })
        : '';

      // Order header: Order# | Status | Payment | Time | Amount
      lines.push({ text: `${orderNum} ${statusSymbol} ${paymentSymbol} ${timeStr}`, style: 'bold', align: 'left', rightText: amount });

      // Simplified address (street, city) for receipt readability
      const address = parseAddressSimple(delivery.delivery_address || '');
      lines.push({ text: '  ' + address, style: 'small', align: 'left' });
      lines.push({ text: '', style: 'small', align: 'left' });
    });

    lines.push({ text: '────────────────────────────────────────────', style: 'small', align: 'center' });
    lines.push({ text: '', style: 'small', align: 'left' });
  }

  // ═══════════════════════════════════════════════════════════════
  // CASH RECONCILIATION
  // ═══════════════════════════════════════════════════════════════
  addMajorSectionHeader(lines, t('receipt.driverCheckout.cashReconciliation', language), isModern);
  lines.push({ text: t('receipt.driverCheckout.startingAmount', language) + ':', style: 'normal', align: 'left', rightText: formatCurrency(startingAmount, currency) });
  lines.push({ text: t('receipt.driverCheckout.cashCollected', language) + ':', style: 'normal', align: 'left', rightText: formatCurrency(totalCashCollected, currency) });
  lines.push({ text: t('receipt.driverCheckout.expenses', language) + ':', style: 'normal', align: 'left', rightText: formatCurrency(totalExpenses, currency) });
  lines.push({ text: t('receipt.driverCheckout.payment', language) + ':', style: 'normal', align: 'left', rightText: formatCurrency(paymentAmount, currency) });
  lines.push({ text: '────────────────────────────────────────────', style: 'small', align: 'center' });

  const returnLabel = cashToReturn >= 0 
    ? t('receipt.driverCheckout.cashToReturn', language) + ':'
    : t('receipt.cashierCheckout.shortage', language) + ':';
  
  lines.push({ text: returnLabel, style: 'bold', align: 'left', rightText: formatCurrency(Math.abs(cashToReturn), currency) });

  if (isModern) {
    lines.push({ text: '', style: 'small', align: 'left' });
  } else {
    lines.push({ text: '════════════════════════════════════════════', style: 'small', align: 'center' });
  }
  lines.push({ text: '', style: 'small', align: 'left' });

  // Formula explanation
  lines.push({ text: t('receipt.formula.label', language), style: 'small', align: 'center' });
  lines.push({ text: t('receipt.formula.driver', language), style: 'small', align: 'center' });
  lines.push({ text: '', style: 'small', align: 'left' });

  // Notes about order details
  lines.push({ text: t('receipt.formula.note.orderTimes', language), style: 'small', align: 'center' });
  lines.push({ text: t('receipt.formula.note.simplifiedAddresses', language), style: 'small', align: 'center' });
  lines.push({ text: '', style: 'small', align: 'left' });

  if (cashToReturn < 0) {
    lines.push({ text: '*** ' + t('receipt.driverCheckout.shortage', language) + ' ***', style: 'bold', align: 'center' });
    lines.push({ text: '', style: 'small', align: 'left' });
  }

  // ═══════════════════════════════════════════════════════════════
  // SIGNATURES
  // ═══════════════════════════════════════════════════════════════
  addSignatureLines(lines, [
    t('receipt.driverCheckout.driverSignature', language),
    t('receipt.driverCheckout.cashierSignature', language)
  ]);

  // ═══════════════════════════════════════════════════════════════
  // FOOTER
  // ═══════════════════════════════════════════════════════════════
  lines.push({ text: '', style: 'normal', align: 'left' });
  lines.push({ text: '────────────────────────────────────────────', style: 'small', align: 'center' });
  lines.push({ text: t('receipt.driverCheckout.footer', language), style: 'normal', align: 'center' });
  lines.push({ text: '', style: 'normal', align: 'left' });
  lines.push({ text: '', style: 'normal', align: 'left' });

  return generateBitmapBuffer(lines, cfg.paperSize, 'DriverCheckoutTemplate');
}

/**
 * Generate Driver Checkout receipt as plain text string (legacy compatibility)
 */
export function generateDriverCheckoutReceipt(
  summary: ShiftSummary,
  terminalName?: string,
  paperWidth: number = 48,
  language: 'en' | 'el' = 'en'
): string {
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
  // v2+: payment_amount is NOT deducted (cashier handles payment separately)
  // v1 (legacy): payment_amount is deducted from cash to return
  const calculationVersion = (shift as any).calculation_version || 1;
  const cashToReturn = calculationVersion >= 2
    ? startingAmount + totalCashCollected - expenses
    : startingAmount + totalCashCollected - paymentAmount - expenses;

  const locale = language === 'el' ? 'el-GR' : 'en-US';
  const use24Hour = language === 'el';
  const formatDateLocal = (date: Date) => date.toLocaleDateString(locale, { year: 'numeric', month: '2-digit', day: '2-digit' });
  const formatTimeLocal = (date: Date) => date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', hour12: !use24Hour });
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
  receipt += center('DRIVER CHECKOUT') + '\n';
  receipt += line('=') + '\n';
  receipt += '\n';
  
  if (terminalName) receipt += center(terminalName) + '\n';
  receipt += center(formatDateLocal(checkOutDate)) + '\n';
  receipt += center(formatTimeLocal(checkOutDate)) + '\n';
  receipt += '\n';
  receipt += line() + '\n';
  receipt += '\n';
  
  // Driver Information
  receipt += 'DRIVER INFORMATION\n';
  receipt += line() + '\n';
  receipt += leftRight('Name:', shift.staff_id) + '\n';
  receipt += leftRight('Shift ID:', shift.id.substring(0, 8)) + '\n';
  receipt += leftRight('Check-In:', formatTimeLocal(checkInDate)) + '\n';
  receipt += leftRight('Check-Out:', formatTimeLocal(checkOutDate)) + '\n';
  receipt += '\n';
  
  // Delivery Summary
  const canceledOrders = driverDeliveries.filter((d: any) => d.status === 'cancelled' || d.status === 'canceled' || d.status === 'refunded').length;
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

  // Order Details
  if (driverDeliveries.length > 0) {
    receipt += 'ORDER DETAILS\n';
    receipt += line() + '\n';
    driverDeliveries.forEach((delivery: NonNullable<ShiftSummary['driverDeliveries']>[number], index: number) => {
      const orderNum = delivery.order_number || `#${index + 1}`;
      const amount = formatCurrency(delivery.total_amount);
      const rawStatus = (delivery as any).status || (delivery as any).order_status || '';
      const normalizedStatus = rawStatus.toLowerCase();
      const isCanceled = normalizedStatus === 'cancelled' || normalizedStatus === 'canceled' || normalizedStatus === 'refunded';
      const statusSymbol = isCanceled ? '✗' : '✓';
      const paymentMethod = (delivery.payment_method || '').toLowerCase();
      let paymentSymbol: string;
      if (paymentMethod === 'cash') paymentSymbol = '💵';
      else if (paymentMethod === 'card') paymentSymbol = '💳';
      else if (paymentMethod === 'mixed') paymentSymbol = '💵+💳';
      else paymentSymbol = '💳';

      // Format delivery time using locale-aware formatting
      const deliveryTime = (delivery as any).delivery_time;
      const timeStr = deliveryTime
        ? formatTimeLocal(new Date(deliveryTime))
        : '';

      // Order header line with time
      receipt += leftRight(`${orderNum} ${statusSymbol}${paymentSymbol} ${timeStr}`, amount) + '\n';

      // Simplified address (street, city) for receipt readability
      const address = parseAddressSimple(delivery.delivery_address || '');
      receipt += `  ${address}\n`;
      receipt += '\n';
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

  // Formula explanation
  receipt += center('Formula:') + '\n';
  if (calculationVersion >= 2) {
    receipt += center('Starting + Collected - Expenses = Return') + '\n';
  } else {
    receipt += center('Starting + Collected - Expenses - Payment') + '\n';
    receipt += center('= Cash to Return') + '\n';
  }
  receipt += '\n';
  receipt += center('Order times shown for delivery verification') + '\n';
  receipt += center('Addresses simplified for readability') + '\n';
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
  receipt += '\n\n\n';
  
  return receipt;
}
