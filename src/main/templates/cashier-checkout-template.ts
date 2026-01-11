/**
 * Cashier Checkout Print Template
 * 
 * Generates cashier checkout receipts using bitmap rendering for consistent display.
 * Supports both classic and modern template styles.
 * Supports i18n for English and Greek languages.
 */

import { ReceiptTemplateConfig, PaperSize } from '../printer/types';
import { BaseReceiptTemplate } from './BaseReceiptTemplate';
import { ShiftSummary, ShiftExpense, TransferredDriverInfo } from '../../renderer/types/shift';
import { TextLine } from '../printer/services/escpos/GreekBitmapRenderer';
import {
  t, formatCurrency, formatDate, formatTime,
  addSectionHeader, addMajorSectionHeader, addSignatureLines,
  generateBitmapBuffer, getDefaultConfig, CheckoutConfig
} from './checkout-bitmap-utils';

/**
 * Cashier Checkout Template Class
 */
class CashierCheckoutTemplate extends BaseReceiptTemplate {
  private summary: ShiftSummary;

  constructor(summary: ShiftSummary, config: Partial<ReceiptTemplateConfig> = {}) {
    super(config);
    this.summary = summary;
  }

  generate(): Buffer {
    this.initializeBuilder();
    const { shift, cashDrawer, breakdown, staffPayments = [], cashRefunds = 0 } = this.summary;
    
    const checkInDate = new Date(shift.check_in_time);
    const checkOutDate = shift.check_out_time ? new Date(shift.check_out_time) : new Date();

    // Header
    this.builder.receiptTitle(this.t('receipt.cashierCheckout.title'));
    
    if (this.config.terminalName) {
      this.builder.alignCenter().textLine(this.config.terminalName).alignLeft();
    }
    
    this.builder
      .alignCenter()
      .textLine(this.formatDate(checkOutDate))
      .textLine(this.formatTime(checkOutDate))
      .alignLeft()
      .emptyLine();

    // Cashier Information
    this.addCashierInfo(shift, checkInDate, checkOutDate);
    
    // Orders Breakdown
    if (breakdown) {
      this.addOrdersBreakdown(breakdown);
    }
    
    // Staff Payments
    if (staffPayments.length > 0) {
      this.addStaffPayments(staffPayments);
    }
    
    // Expenses
    if (this.summary.expenses && this.summary.expenses.length > 0) {
      this.addExpenses(this.summary.expenses);
    }
    
    // Transferred Drivers
    const transferredDrivers = this.summary.transferredDrivers || [];
    if (transferredDrivers.length > 0) {
      this.addTransferredDrivers(transferredDrivers);
    }

    // Cash Drawer Summary
    if (cashDrawer) {
      this.addCashDrawerSummary(cashDrawer, cashRefunds, transferredDrivers);
    }
    
    // Notes
    if (shift.notes) {
      this.builder
        .subsectionHeader(this.t('receipt.cashierCheckout.notes'))
        .textLine(shift.notes)
        .emptyLine();
    }
    
    // Signatures
    this.addSignatures([
      this.t('receipt.cashierCheckout.cashierSignature'),
      this.t('receipt.cashierCheckout.managerSignature')
    ]);
    
    // Footer
    this.addFooter(this.t('receipt.cashierCheckout.footer'));

    return this.builder.build();
  }

  private addCashierInfo(shift: any, checkInDate: Date, checkOutDate: Date): void {
    this.builder
      .subsectionHeader(this.t('receipt.cashierCheckout.cashierInfo'))
      .twoColumnRow(`${this.t('receipt.cashierCheckout.name')}:`, shift.staff_id)
      .twoColumnRow(`${this.t('receipt.cashierCheckout.shiftId')}:`, shift.id.substring(0, 8))
      .twoColumnRow(`${this.t('receipt.cashierCheckout.checkIn')}:`, this.formatTime(checkInDate))
      .twoColumnRow(`${this.t('receipt.cashierCheckout.checkOut')}:`, this.formatTime(checkOutDate))
      .emptyLine();
  }

  private addOrdersBreakdown(breakdown: NonNullable<ShiftSummary['breakdown']>): void {
    this.builder.subsectionHeader(this.t('receipt.cashierCheckout.ordersBreakdown'));
    
    // Pickup/Dine-In
    this.builder
      .bold(true)
      .textLine(this.t('receipt.cashierCheckout.pickupDineIn'))
      .bold(false)
      .indentedTwoColumn(`${this.t('receipt.cashierCheckout.cash')}:`, 
        `${breakdown.instore.cashCount} - ${this.formatCurrency(breakdown.instore.cashTotal)}`)
      .indentedTwoColumn(`${this.t('receipt.cashierCheckout.card')}:`, 
        `${breakdown.instore.cardCount} - ${this.formatCurrency(breakdown.instore.cardTotal)}`)
      .emptyLine();
    
    // Delivery
    this.builder
      .bold(true)
      .textLine(this.t('receipt.cashierCheckout.delivery'))
      .bold(false)
      .indentedTwoColumn(`${this.t('receipt.cashierCheckout.cash')}:`, 
        `${breakdown.delivery.cashCount} - ${this.formatCurrency(breakdown.delivery.cashTotal)}`)
      .indentedTwoColumn(`${this.t('receipt.cashierCheckout.card')}:`, 
        `${breakdown.delivery.cardCount} - ${this.formatCurrency(breakdown.delivery.cardTotal)}`)
      .emptyLine();
    
    // Total
    const totalCashCount = breakdown.overall.cashTotal > 0 
      ? (breakdown.instore.cashCount + breakdown.delivery.cashCount) : 0;
    const totalCardCount = breakdown.overall.cardTotal > 0 
      ? (breakdown.instore.cardCount + breakdown.delivery.cardCount) : 0;
    
    this.builder
      .bold(true)
      .textLine('TOTAL:')
      .bold(false)
      .indentedTwoColumn(`${this.t('receipt.cashierCheckout.cash')}:`, 
        `${totalCashCount} - ${this.formatCurrency(breakdown.overall.cashTotal)}`)
      .indentedTwoColumn(`${this.t('receipt.cashierCheckout.card')}:`, 
        `${totalCardCount} - ${this.formatCurrency(breakdown.overall.cardTotal)}`)
      .dashedLine()
      .leftRightBold(this.t('receipt.cashierCheckout.grandTotal') + ':', 
        `${breakdown.overall.totalCount} - ${this.formatCurrency(breakdown.overall.totalAmount)}`)
      .emptyLine();
  }

  private addStaffPayments(staffPayments: NonNullable<ShiftSummary['staffPayments']>): void {
    this.builder.subsectionHeader(this.t('receipt.cashierCheckout.staffPayments'));
    
    staffPayments.forEach((payment) => {
      const name = payment.staff_name || payment.staff_id;
      const role = payment.role_type || 'Staff';
      
      this.builder
        .bold(true)
        .textLine(`${name} (${role})`)
        .bold(false);
      
      if (payment.check_in_time && payment.check_out_time) {
        const checkIn = this.formatTime(new Date(payment.check_in_time));
        const checkOut = this.formatTime(new Date(payment.check_out_time));
        this.builder.indentedText(`${checkIn} - ${checkOut}`);
      }
      
      this.builder
        .indentedTwoColumn(`${this.t('receipt.cashierCheckout.payment')}:`, this.formatCurrency(payment.amount))
        .emptyLine();
    });
    
    const totalPayments = staffPayments.reduce((sum, p) => sum + p.amount, 0);
    this.builder
      .dashedLine()
      .leftRightBold(`${this.t('receipt.cashierCheckout.totalStaffPayments')}:`, this.formatCurrency(totalPayments))
      .emptyLine();
  }

  private addExpenses(expenses: ShiftExpense[]): void {
    this.builder.subsectionHeader(this.t('receipt.cashierCheckout.expenses'));
    
    expenses.forEach((expense) => {
      this.builder
        .bold(true)
        .textLine(expense.description)
        .bold(false)
        .indentedTwoColumn('Type:', expense.expense_type)
        .indentedTwoColumn('Amount:', this.formatCurrency(expense.amount))
        .emptyLine();
    });
    
    const totalExpenses = expenses.reduce((sum, e) => sum + e.amount, 0);
    this.builder
      .dashedLine()
      .leftRightBold(`${this.t('receipt.cashierCheckout.totalExpenses')}:`, this.formatCurrency(totalExpenses))
      .emptyLine();
  }

  private addTransferredDrivers(drivers: TransferredDriverInfo[]): void {
    this.builder
      .thickLine()
      .centeredBold(this.t('receipt.cashierCheckout.inheritedDrivers'))
      .alignCenter()
      .textLine(`(${this.t('receipt.cashierCheckout.inheritedNote')})`)
      .alignLeft()
      .thickLine()
      .emptyLine();

    drivers.forEach((driver) => {
      const name = driver.driver_name || `Driver ${driver.driver_id.slice(-6)}`;
      const checkIn = driver.check_in_time ? this.formatTime(new Date(driver.check_in_time)) : 'N/A';

      this.builder
        .bold(true)
        .textLine(name)
        .bold(false)
        .indentedTwoColumn(`${this.t('receipt.cashierCheckout.checkIn')}:`, checkIn)
        .indentedTwoColumn(this.t('receipt.cashierCheckout.startingAmount') + ':', this.formatCurrency(driver.starting_amount))
        .indentedTwoColumn(this.t('receipt.cashierCheckout.cashCollected') + ':', this.formatCurrency(driver.cash_collected || 0))
        .indentedTwoColumn(this.t('receipt.cashierCheckout.cardAmount') + ':', this.formatCurrency(driver.card_amount || 0))
        .indentedTwoColumn(this.t('receipt.cashierCheckout.expenses') + ':', this.formatCurrency(driver.expenses))
        .indentedTwoColumn(this.t('receipt.cashierCheckout.expectedReturn') + ':', this.formatCurrency(driver.net_cash_amount))
        .emptyLine();
    });

    const totalTransferred = drivers.reduce((sum, d) => sum + d.net_cash_amount, 0);
    this.builder
      .dashedLine()
      .leftRightBold(`${this.t('receipt.cashierCheckout.totalInherited')}:`, this.formatCurrency(totalTransferred))
      .emptyLine();
  }

  private addCashDrawerSummary(
    cashDrawer: NonNullable<ShiftSummary['cashDrawer']>,
    cashRefunds: number,
    transferredDrivers: TransferredDriverInfo[]
  ): void {
    const totalInheritedReturns = transferredDrivers.reduce((sum, d) => sum + d.net_cash_amount, 0);

    this.builder
      .thickLine()
      .centeredBold(this.t('receipt.cashierCheckout.cashDrawer'))
      .thickLine();

    // Cash drawer calculation breakdown
    this.builder
      .twoColumnRow(`${this.t('receipt.cashierCheckout.openingAmount')}:`, `+${this.formatCurrency(cashDrawer.opening_amount)}`)
      .twoColumnRow(`+ ${this.t('receipt.cashierCheckout.cashSales')}:`, this.formatCurrency(cashDrawer.total_cash_sales))
      .twoColumnRow(`- ${this.t('receipt.cashierCheckout.cashRefunds')}:`, this.formatCurrency(cashRefunds))
      .twoColumnRow(`- ${this.t('receipt.cashierCheckout.expenses')}:`, this.formatCurrency(cashDrawer.total_expenses))
      .twoColumnRow(`- ${this.t('receipt.cashierCheckout.cashDrops')}:`, this.formatCurrency(cashDrawer.cash_drops))
      .twoColumnRow(`- ${this.t('receipt.cashierCheckout.driverCashGiven')}:`, this.formatCurrency(cashDrawer.driver_cash_given))
      .twoColumnRow(`+ ${this.t('receipt.cashierCheckout.driverCashReturned')}:`, this.formatCurrency(cashDrawer.driver_cash_returned));

    // Add inherited drivers line if there are any
    if (transferredDrivers.length > 0) {
      this.builder.twoColumnRow(`+ ${this.t('receipt.cashierCheckout.inheritedDrivers')}:`, this.formatCurrency(totalInheritedReturns));
    }

    this.builder
      .dashedLine()
      .leftRightBold(this.t('receipt.cashierCheckout.expectedInDrawer') + ':', this.formatCurrency(cashDrawer.expected_amount || 0))
      .emptyLine();

    // Information Only section for Staff Payments
    this.builder
      .subsectionHeader(this.t('receipt.cashierCheckout.informationOnly'))
      .twoColumnRow(`${this.t('receipt.cashierCheckout.staffPayments')}:`, this.formatCurrency(cashDrawer.total_staff_payments))
      .alignCenter()
      .textLine(`(${this.t('receipt.formula.note.staffPaymentsReturned')})`)
      .alignLeft()
      .dashedLine();

    // Closing amount and variance
    this.builder
      .leftRightBold(this.t('receipt.cashierCheckout.closingAmount') + ':', this.formatCurrency(cashDrawer.closing_amount || 0))
      .dashedLine();

    const variance = cashDrawer.variance_amount || 0;
    const varianceLabel = variance >= 0
      ? this.t('receipt.cashierCheckout.overage') + ':'
      : this.t('receipt.cashierCheckout.shortage') + ':';

    this.builder
      .leftRightBold(varianceLabel, this.formatCurrency(Math.abs(variance)))
      .thickLine()
      .emptyLine();

    if (Math.abs(variance) > 0) {
      const message = variance >= 0
        ? this.t('receipt.cashierCheckout.overageDetected')
        : this.t('receipt.cashierCheckout.shortageDetected');
      this.builder.warningMessage(message);
    }

    // Formula explanation
    this.builder
      .dashedLine()
      .centeredBold(this.t('receipt.formula.label'))
      .alignCenter()
      .textLine(this.t('receipt.formula.cashier'))
      .alignLeft()
      .emptyLine();
  }
}

/**
 * Generate Cashier Checkout receipt as ESC/POS Buffer using bitmap rendering
 */
export function generateCashierCheckoutReceiptBuffer(
  summary: ShiftSummary, 
  config: Partial<ReceiptTemplateConfig & { receiptTemplate?: 'classic' | 'modern' }> = {}
): Buffer {
  console.log('[CashierCheckoutTemplate] generateCashierCheckoutReceiptBuffer called (BITMAP MODE)');
  console.log('[CashierCheckoutTemplate] Config:', JSON.stringify(config));
  
  const cfg = getDefaultConfig(config);
  const { language, currency, terminalName, receiptTemplate } = cfg;
  const isModern = receiptTemplate === 'modern';
  
  console.log('[CashierCheckoutTemplate] Language:', language, 'Template:', receiptTemplate);
  
  const { shift, cashDrawer, breakdown, staffPayments = [], cashRefunds = 0, expenses = [] } = summary;
  const checkInDate = new Date(shift.check_in_time);
  const checkOutDate = shift.check_out_time ? new Date(shift.check_out_time) : new Date();
  const transferredDrivers = summary.transferredDrivers || [];

  const lines: TextLine[] = [];

  // ═══════════════════════════════════════════════════════════════
  // HEADER
  // ═══════════════════════════════════════════════════════════════
  lines.push({ text: '', style: 'normal', align: 'left' });
  
  if (isModern) {
    lines.push({ text: t('receipt.cashierCheckout.title', language), style: 'boxHeader', align: 'center', inverted: true });
    lines.push({ text: '', style: 'small', align: 'left' });
    if (terminalName) {
      lines.push({ text: terminalName, style: 'normal', align: 'center' });
    }
    lines.push({ text: formatDate(checkOutDate, language), style: 'normal', align: 'center' });
    lines.push({ text: formatTime(checkOutDate, language), style: 'normal', align: 'center' });
  } else {
    lines.push({ text: t('receipt.cashierCheckout.title', language), style: 'title', align: 'center' });
    lines.push({ text: '════════════════════════════════════════════', style: 'small', align: 'center' });
    if (terminalName) {
      lines.push({ text: terminalName, style: 'normal', align: 'center' });
    }
    lines.push({ text: formatDate(checkOutDate, language), style: 'normal', align: 'center' });
    lines.push({ text: formatTime(checkOutDate, language), style: 'normal', align: 'center' });
  }
  lines.push({ text: '', style: 'small', align: 'left' });

  // ═══════════════════════════════════════════════════════════════
  // CASHIER INFORMATION
  // ═══════════════════════════════════════════════════════════════
  addSectionHeader(lines, t('receipt.cashierCheckout.cashierInfo', language), isModern);
  const staffName = (shift as any).staff_name || '';
  lines.push({ text: t('receipt.cashierCheckout.name', language) + ':', style: 'normal', align: 'left', rightText: staffName });
  lines.push({ text: t('receipt.cashierCheckout.shiftId', language) + ':', style: 'normal', align: 'left', rightText: shift.id.substring(0, 8) });
  lines.push({ text: t('receipt.cashierCheckout.checkIn', language) + ':', style: 'normal', align: 'left', rightText: formatTime(checkInDate, language) });
  lines.push({ text: t('receipt.cashierCheckout.checkOut', language) + ':', style: 'normal', align: 'left', rightText: formatTime(checkOutDate, language) });
  lines.push({ text: '', style: 'small', align: 'left' });

  // ═══════════════════════════════════════════════════════════════
  // ORDERS BREAKDOWN
  // ═══════════════════════════════════════════════════════════════
  if (breakdown) {
    addSectionHeader(lines, t('receipt.cashierCheckout.ordersBreakdown', language), isModern);
    
    // Pickup/Dine-In
    lines.push({ text: t('receipt.cashierCheckout.pickupDineIn', language), style: 'bold', align: 'left' });
    lines.push({ text: '  ' + t('receipt.cashierCheckout.cash', language) + ':', style: 'normal', align: 'left', rightText: breakdown.instore.cashCount + ' - ' + formatCurrency(breakdown.instore.cashTotal, currency) });
    lines.push({ text: '  ' + t('receipt.cashierCheckout.card', language) + ':', style: 'normal', align: 'left', rightText: breakdown.instore.cardCount + ' - ' + formatCurrency(breakdown.instore.cardTotal, currency) });
    lines.push({ text: '', style: 'small', align: 'left' });
    
    // Delivery
    lines.push({ text: t('receipt.cashierCheckout.delivery', language), style: 'bold', align: 'left' });
    lines.push({ text: '  ' + t('receipt.cashierCheckout.cash', language) + ':', style: 'normal', align: 'left', rightText: breakdown.delivery.cashCount + ' - ' + formatCurrency(breakdown.delivery.cashTotal, currency) });
    lines.push({ text: '  ' + t('receipt.cashierCheckout.card', language) + ':', style: 'normal', align: 'left', rightText: breakdown.delivery.cardCount + ' - ' + formatCurrency(breakdown.delivery.cardTotal, currency) });
    lines.push({ text: '', style: 'small', align: 'left' });
    
    // Total
    const totalCashCount = breakdown.overall.cashTotal > 0 ? (breakdown.instore.cashCount + breakdown.delivery.cashCount) : 0;
    const totalCardCount = breakdown.overall.cardTotal > 0 ? (breakdown.instore.cardCount + breakdown.delivery.cardCount) : 0;
    
    lines.push({ text: 'TOTAL:', style: 'bold', align: 'left' });
    lines.push({ text: '  ' + t('receipt.cashierCheckout.cash', language) + ':', style: 'normal', align: 'left', rightText: totalCashCount + ' - ' + formatCurrency(breakdown.overall.cashTotal, currency) });
    lines.push({ text: '  ' + t('receipt.cashierCheckout.card', language) + ':', style: 'normal', align: 'left', rightText: totalCardCount + ' - ' + formatCurrency(breakdown.overall.cardTotal, currency) });
    lines.push({ text: '────────────────────────────────────────────', style: 'small', align: 'center' });
    lines.push({ text: t('receipt.cashierCheckout.grandTotal', language) + ':', style: 'bold', align: 'left', rightText: breakdown.overall.totalCount + ' - ' + formatCurrency(breakdown.overall.totalAmount, currency) });
    lines.push({ text: '', style: 'small', align: 'left' });
  }

  // ═══════════════════════════════════════════════════════════════
  // STAFF PAYMENTS
  // ═══════════════════════════════════════════════════════════════
  if (staffPayments.length > 0) {
    addSectionHeader(lines, t('receipt.cashierCheckout.staffPayments', language), isModern);
    
    staffPayments.forEach((payment) => {
      const name = payment.staff_name || payment.staff_id;
      const role = payment.role_type || 'Staff';
      
      lines.push({ text: name + ' (' + role + ')', style: 'bold', align: 'left' });
      
      if (payment.check_in_time && payment.check_out_time) {
        const checkIn = formatTime(new Date(payment.check_in_time), language);
        const checkOut = formatTime(new Date(payment.check_out_time), language);
        lines.push({ text: '  ' + checkIn + ' - ' + checkOut, style: 'small', align: 'left' });
      }
      
      lines.push({ text: '  ' + t('receipt.cashierCheckout.payment', language) + ':', style: 'normal', align: 'left', rightText: formatCurrency(payment.amount, currency) });
      lines.push({ text: '', style: 'small', align: 'left' });
    });
    
    const totalPayments = staffPayments.reduce((sum, p) => sum + p.amount, 0);
    lines.push({ text: '────────────────────────────────────────────', style: 'small', align: 'center' });
    lines.push({ text: t('receipt.cashierCheckout.totalStaffPayments', language) + ':', style: 'bold', align: 'left', rightText: formatCurrency(totalPayments, currency) });
    lines.push({ text: '', style: 'small', align: 'left' });
  }

  // ═══════════════════════════════════════════════════════════════
  // EXPENSES
  // ═══════════════════════════════════════════════════════════════
  if (expenses.length > 0) {
    addSectionHeader(lines, t('receipt.cashierCheckout.expenses', language), isModern);
    
    expenses.forEach((expense) => {
      lines.push({ text: expense.description, style: 'bold', align: 'left' });
      lines.push({ text: '  Type:', style: 'normal', align: 'left', rightText: expense.expense_type });
      lines.push({ text: '  Amount:', style: 'normal', align: 'left', rightText: formatCurrency(expense.amount, currency) });
      lines.push({ text: '', style: 'small', align: 'left' });
    });
    
    const totalExpenses = expenses.reduce((sum, e) => sum + e.amount, 0);
    lines.push({ text: '────────────────────────────────────────────', style: 'small', align: 'center' });
    lines.push({ text: t('receipt.cashierCheckout.totalExpenses', language) + ':', style: 'bold', align: 'left', rightText: formatCurrency(totalExpenses, currency) });
    lines.push({ text: '', style: 'small', align: 'left' });
  }

  // ═══════════════════════════════════════════════════════════════
  // INHERITED DRIVERS
  // ═══════════════════════════════════════════════════════════════
  const totalInheritedReturns = transferredDrivers.reduce((sum, d) => sum + d.net_cash_amount, 0);

  if (transferredDrivers.length > 0) {
    addMajorSectionHeader(lines, t('receipt.cashierCheckout.inheritedDrivers', language), isModern);
    lines.push({ text: '(' + t('receipt.cashierCheckout.inheritedNote', language) + ')', style: 'small', align: 'center' });
    lines.push({ text: '', style: 'small', align: 'left' });

    transferredDrivers.forEach((driver) => {
      const name = driver.driver_name || 'Driver ' + driver.driver_id.slice(-6);
      const checkIn = driver.check_in_time ? formatTime(new Date(driver.check_in_time), language) : 'N/A';

      lines.push({ text: name, style: 'bold', align: 'left' });
      lines.push({ text: '  ' + t('receipt.cashierCheckout.checkIn', language) + ':', style: 'normal', align: 'left', rightText: checkIn });
      lines.push({ text: '  ' + t('receipt.cashierCheckout.startingAmount', language) + ':', style: 'normal', align: 'left', rightText: formatCurrency(driver.starting_amount, currency) });
      lines.push({ text: '  ' + t('receipt.cashierCheckout.cashCollected', language) + ':', style: 'normal', align: 'left', rightText: formatCurrency(driver.cash_collected || 0, currency) });
      lines.push({ text: '  ' + t('receipt.cashierCheckout.cardAmount', language) + ':', style: 'normal', align: 'left', rightText: formatCurrency(driver.card_amount || 0, currency) });
      lines.push({ text: '  ' + t('receipt.cashierCheckout.expenses', language) + ':', style: 'normal', align: 'left', rightText: formatCurrency(driver.expenses, currency) });
      lines.push({ text: '  ' + t('receipt.cashierCheckout.expectedReturn', language) + ':', style: 'normal', align: 'left', rightText: formatCurrency(driver.net_cash_amount, currency) });
      lines.push({ text: '', style: 'small', align: 'left' });
    });

    lines.push({ text: '────────────────────────────────────────────', style: 'small', align: 'center' });
    lines.push({ text: t('receipt.cashierCheckout.totalInherited', language) + ':', style: 'bold', align: 'left', rightText: formatCurrency(totalInheritedReturns, currency) });
    lines.push({ text: '', style: 'small', align: 'left' });
  }

  // ═══════════════════════════════════════════════════════════════
  // CASH DRAWER SUMMARY
  // ═══════════════════════════════════════════════════════════════
  if (cashDrawer) {
    addMajorSectionHeader(lines, t('receipt.cashierCheckout.cashDrawer', language), isModern);

    // Cash drawer calculation breakdown with +/- signs
    lines.push({ text: t('receipt.cashierCheckout.openingAmount', language) + ':', style: 'normal', align: 'left', rightText: '+' + formatCurrency(cashDrawer.opening_amount, currency) });
    lines.push({ text: '+ ' + t('receipt.cashierCheckout.cashSales', language) + ':', style: 'normal', align: 'left', rightText: formatCurrency(cashDrawer.total_cash_sales, currency) });
    lines.push({ text: '- ' + t('receipt.cashierCheckout.cashRefunds', language) + ':', style: 'normal', align: 'left', rightText: formatCurrency(cashRefunds, currency) });
    lines.push({ text: '- ' + t('receipt.cashierCheckout.expenses', language) + ':', style: 'normal', align: 'left', rightText: formatCurrency(cashDrawer.total_expenses, currency) });
    lines.push({ text: '- ' + t('receipt.cashierCheckout.cashDrops', language) + ':', style: 'normal', align: 'left', rightText: formatCurrency(cashDrawer.cash_drops, currency) });
    lines.push({ text: '- ' + t('receipt.cashierCheckout.driverCashGiven', language) + ':', style: 'normal', align: 'left', rightText: formatCurrency(cashDrawer.driver_cash_given, currency) });
    lines.push({ text: '+ ' + t('receipt.cashierCheckout.driverCashReturned', language) + ':', style: 'normal', align: 'left', rightText: formatCurrency(cashDrawer.driver_cash_returned, currency) });

    // Add inherited drivers line if there are any
    if (transferredDrivers.length > 0) {
      lines.push({ text: '+ ' + t('receipt.cashierCheckout.inheritedDrivers', language) + ':', style: 'normal', align: 'left', rightText: formatCurrency(totalInheritedReturns, currency) });
    }

    lines.push({ text: '────────────────────────────────────────────', style: 'small', align: 'center' });
    lines.push({ text: t('receipt.cashierCheckout.expectedInDrawer', language) + ':', style: 'bold', align: 'left', rightText: formatCurrency(cashDrawer.expected_amount || 0, currency) });
    lines.push({ text: '', style: 'small', align: 'left' });

    // Information Only section for Staff Payments
    addSectionHeader(lines, t('receipt.cashierCheckout.informationOnly', language), isModern);
    lines.push({ text: t('receipt.cashierCheckout.staffPayments', language) + ':', style: 'normal', align: 'left', rightText: formatCurrency(cashDrawer.total_staff_payments, currency) });
    lines.push({ text: '(' + t('receipt.formula.note.staffPaymentsReturned', language) + ')', style: 'small', align: 'center' });
    lines.push({ text: '────────────────────────────────────────────', style: 'small', align: 'center' });

    // Closing amount and variance
    lines.push({ text: t('receipt.cashierCheckout.closingAmount', language) + ':', style: 'bold', align: 'left', rightText: formatCurrency(cashDrawer.closing_amount || 0, currency) });
    lines.push({ text: '────────────────────────────────────────────', style: 'small', align: 'center' });

    const variance = cashDrawer.variance_amount || 0;
    const varianceLabel = variance >= 0
      ? t('receipt.cashierCheckout.overage', language) + ':'
      : t('receipt.cashierCheckout.shortage', language) + ':';

    lines.push({ text: varianceLabel, style: 'bold', align: 'left', rightText: formatCurrency(Math.abs(variance), currency) });

    if (isModern) {
      lines.push({ text: '', style: 'small', align: 'left' });
    } else {
      lines.push({ text: '════════════════════════════════════════════', style: 'small', align: 'center' });
    }
    lines.push({ text: '', style: 'small', align: 'left' });

    if (Math.abs(variance) > 0) {
      const message = variance >= 0
        ? '*** ' + t('receipt.cashierCheckout.overageDetected', language) + ' ***'
        : '*** ' + t('receipt.cashierCheckout.shortageDetected', language) + ' ***';
      lines.push({ text: message, style: 'bold', align: 'center' });
      lines.push({ text: '', style: 'small', align: 'left' });
    }

    // Formula explanation
    lines.push({ text: '────────────────────────────────────────────', style: 'small', align: 'center' });
    lines.push({ text: t('receipt.formula.label', language), style: 'bold', align: 'center' });
    lines.push({ text: t('receipt.formula.cashier', language), style: 'small', align: 'center' });
    lines.push({ text: '', style: 'small', align: 'left' });
  }

  // ═══════════════════════════════════════════════════════════════
  // NOTES
  // ═══════════════════════════════════════════════════════════════
  if (shift.notes) {
    addSectionHeader(lines, t('receipt.cashierCheckout.notes', language), isModern);
    lines.push({ text: shift.notes, style: 'normal', align: 'left' });
    lines.push({ text: '', style: 'small', align: 'left' });
  }

  // ═══════════════════════════════════════════════════════════════
  // SIGNATURES
  // ═══════════════════════════════════════════════════════════════
  addSignatureLines(lines, [
    t('receipt.cashierCheckout.cashierSignature', language),
    t('receipt.cashierCheckout.managerSignature', language)
  ]);

  // ═══════════════════════════════════════════════════════════════
  // FOOTER
  // ═══════════════════════════════════════════════════════════════
  lines.push({ text: '', style: 'normal', align: 'left' });
  lines.push({ text: '────────────────────────────────────────────', style: 'small', align: 'center' });
  lines.push({ text: t('receipt.cashierCheckout.footer', language), style: 'normal', align: 'center' });
  lines.push({ text: '', style: 'normal', align: 'left' });
  lines.push({ text: '', style: 'normal', align: 'left' });

  return generateBitmapBuffer(lines, cfg.paperSize, 'CashierCheckoutTemplate');
}

/**
 * Generate Cashier Checkout receipt as plain text string (legacy compatibility)
 */
export function generateCashierCheckoutReceipt(
  summary: ShiftSummary, 
  terminalName?: string, 
  paperWidth: number = 48
): string {
  const { shift, cashDrawer, breakdown, staffPayments = [], cashRefunds = 0 } = summary;
  
  const checkInDate = new Date(shift.check_in_time);
  const checkOutDate = shift.check_out_time ? new Date(shift.check_out_time) : new Date();
  
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
  receipt += center('CASHIER CHECKOUT REPORT') + '\n';
  receipt += line('=') + '\n';
  receipt += '\n';
  
  if (terminalName) receipt += center(terminalName) + '\n';
  receipt += center(formatDate(checkOutDate)) + '\n';
  receipt += center(formatTime(checkOutDate)) + '\n';
  receipt += '\n';
  receipt += line() + '\n';
  receipt += '\n';
  
  // Cashier Information
  receipt += 'CASHIER INFORMATION\n';
  receipt += line() + '\n';
  receipt += leftRight('Name:', (shift as any).staff_name || shift.staff_id) + '\n';
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
    receipt += leftRight('  Cash:', `${breakdown.overall.cashTotal > 0 ? (breakdown.instore.cashCount + breakdown.delivery.cashCount) : 0} - ${formatCurrency(breakdown.overall.cashTotal)}`) + '\n';
    receipt += leftRight('  Card:', `${breakdown.overall.cardTotal > 0 ? (breakdown.instore.cardCount + breakdown.delivery.cardCount) : 0} - ${formatCurrency(breakdown.overall.cardTotal)}`) + '\n';
    receipt += line() + '\n';
    receipt += leftRight('GRAND TOTAL:', `${breakdown.overall.totalCount} - ${formatCurrency(breakdown.overall.totalAmount)}`) + '\n';
    receipt += '\n';
  }
  
  // Staff Payments
  if (staffPayments.length > 0) {
    receipt += 'STAFF SHIFTS & PAYMENTS\n';
    receipt += line() + '\n';
    staffPayments.forEach((payment: NonNullable<ShiftSummary['staffPayments']>[number]) => {
      const name = payment.staff_name || payment.staff_id;
      const role = payment.role_type || 'Staff';
      receipt += `${name} (${role})\n`;
      if (payment.check_in_time && payment.check_out_time) {
        receipt += `  ${formatTime(new Date(payment.check_in_time))} - ${formatTime(new Date(payment.check_out_time))}\n`;
      }
      receipt += leftRight('  Payment:', formatCurrency(payment.amount)) + '\n';
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
    summary.expenses.forEach((expense: ShiftExpense) => {
      receipt += `${expense.description}\n`;
      receipt += leftRight('  Type:', expense.expense_type) + '\n';
      receipt += leftRight('  Amount:', formatCurrency(expense.amount)) + '\n';
      receipt += '\n';
    });
    const totalExpenses = summary.expenses.reduce((sum: number, e: ShiftExpense) => sum + e.amount, 0);
    receipt += line() + '\n';
    receipt += leftRight('Total Expenses:', formatCurrency(totalExpenses)) + '\n';
    receipt += '\n';
  }

  // Inherited Drivers
  const transferredDrivers = summary.transferredDrivers || [];
  const totalInheritedReturns = transferredDrivers.reduce((sum: number, d: TransferredDriverInfo) => sum + d.net_cash_amount, 0);

  if (transferredDrivers.length > 0) {
    receipt += line('=') + '\n';
    receipt += 'INHERITED DRIVERS\n';
    receipt += center('(Drivers from previous cashier shift)') + '\n';
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
      receipt += leftRight('  Expected Return:', formatCurrency(driver.net_cash_amount)) + '\n';
      receipt += '\n';
    });
    receipt += line() + '\n';
    receipt += leftRight('Total Inherited:', formatCurrency(totalInheritedReturns)) + '\n';
    receipt += '\n';
  }

  // Cash Drawer Summary
  if (cashDrawer) {
    receipt += line('=') + '\n';
    receipt += 'CASH DRAWER SUMMARY\n';
    receipt += line('=') + '\n';
    // Cash drawer calculation breakdown with +/- signs
    receipt += leftRight('Opening Amount:', '+' + formatCurrency(cashDrawer.opening_amount)) + '\n';
    receipt += leftRight('+ Pickup/Dine-In Cash:', formatCurrency(cashDrawer.total_cash_sales)) + '\n';
    receipt += leftRight('- Cash Refunds:', formatCurrency(cashRefunds)) + '\n';
    receipt += leftRight('- Expenses:', formatCurrency(cashDrawer.total_expenses)) + '\n';
    receipt += leftRight('- Cash Drops:', formatCurrency(cashDrawer.cash_drops)) + '\n';
    receipt += leftRight('- Driver Cash Given:', formatCurrency(cashDrawer.driver_cash_given)) + '\n';
    receipt += leftRight('+ Driver Cash Returned:', formatCurrency(cashDrawer.driver_cash_returned)) + '\n';
    if (transferredDrivers.length > 0) {
      receipt += leftRight('+ Inherited Drivers:', formatCurrency(totalInheritedReturns)) + '\n';
    }
    receipt += line() + '\n';
    receipt += leftRight('EXPECTED IN DRAWER:', formatCurrency(cashDrawer.expected_amount || 0)) + '\n';
    receipt += '\n';

    // Information Only section
    receipt += line() + '\n';
    receipt += 'INFORMATION ONLY\n';
    receipt += line() + '\n';
    receipt += leftRight('Staff Payments:', formatCurrency(cashDrawer.total_staff_payments)) + '\n';
    receipt += center('(Staff receives this amount back)') + '\n';
    receipt += line() + '\n';

    // Closing amount and variance
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

    // Formula explanation
    receipt += line() + '\n';
    receipt += center('Formula:') + '\n';
    receipt += center('Opening + Sales - Refunds - Expenses') + '\n';
    receipt += center('- Drops - Given + Returned + Inherited') + '\n';
    receipt += center('= Expected') + '\n';
    receipt += '\n';
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
  receipt += '\n\n\n';
  
  return receipt;
}
