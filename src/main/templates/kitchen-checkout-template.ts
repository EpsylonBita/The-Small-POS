/**
 * Kitchen Checkout Print Template
 * 
 * Generates kitchen staff checkout receipts using bitmap rendering for consistent display.
 * Supports both classic and modern template styles.
 * Supports i18n for English and Greek languages.
 */

import { ReceiptTemplateConfig, PaperSize } from '../printer/types';
import { BaseReceiptTemplate } from './BaseReceiptTemplate';
import { ShiftSummary } from '../../renderer/types/shift';
import { TextLine } from '../printer/services/escpos/GreekBitmapRenderer';
import {
  t, formatCurrency, formatDate, formatTime,
  addSectionHeader, addMajorSectionHeader, addSignatureLines,
  generateBitmapBuffer, getDefaultConfig, CheckoutConfig
} from './checkout-bitmap-utils';

/**
 * Kitchen Checkout Template Class
 */
class KitchenCheckoutTemplate extends BaseReceiptTemplate {
  private summary: ShiftSummary;

  constructor(summary: ShiftSummary, config: Partial<ReceiptTemplateConfig> = {}) {
    super(config);
    this.summary = summary;
  }

  generate(): Buffer {
    this.initializeBuilder();
    const { shift } = this.summary;
    
    const checkInDate = new Date(shift.check_in_time);
    const checkOutDate = shift.check_out_time ? new Date(shift.check_out_time) : new Date();
    
    // Calculate hours worked
    const hoursWorked = ((checkOutDate.getTime() - checkInDate.getTime()) / (1000 * 60 * 60)).toFixed(2);

    // Header
    this.builder.receiptTitle(this.t('receipt.kitchenCheckout.title'));
    
    if (this.config.terminalName) {
      this.builder.alignCenter().textLine(this.config.terminalName).alignLeft();
    }
    
    this.builder
      .alignCenter()
      .textLine(this.formatDate(checkOutDate))
      .textLine(this.formatTime(checkOutDate))
      .alignLeft()
      .emptyLine();

    // Staff Information
    this.builder
      .subsectionHeader(this.t('receipt.kitchenCheckout.staffInfo'))
      .twoColumnRow(`${this.t('receipt.kitchenCheckout.name')}:`, shift.staff_id)
      .twoColumnRow(`${this.t('receipt.kitchenCheckout.role')}:`, this.t('receipt.kitchenCheckout.kitchenStaff'))
      .twoColumnRow(`${this.t('receipt.kitchenCheckout.shiftId')}:`, shift.id.substring(0, 8))
      .emptyLine();

    // Shift Times
    this.builder
      .subsectionHeader(this.t('receipt.kitchenCheckout.shiftTimes'))
      .twoColumnRow(`${this.t('receipt.kitchenCheckout.checkIn')}:`, this.formatTime(checkInDate))
      .twoColumnRow(`${this.t('receipt.kitchenCheckout.checkOut')}:`, this.formatTime(checkOutDate))
      .twoColumnRow(`${this.t('receipt.kitchenCheckout.hoursWorked')}:`, `${hoursWorked} hrs`)
      .emptyLine();

    // Payment
    this.builder
      .thickLine()
      .centeredBold(this.t('receipt.kitchenCheckout.payment'))
      .thickLine()
      .leftRightBold(`${this.t('receipt.kitchenCheckout.paymentAmount')}:`, 
        this.formatCurrency(shift.payment_amount || 0))
      .thickLine()
      .emptyLine();

    // Signatures
    this.addSignatures([
      this.t('receipt.kitchenCheckout.staffSignature'),
      this.t('receipt.kitchenCheckout.managerSignature')
    ]);

    // Footer
    this.addFooter(this.t('receipt.kitchenCheckout.footer'));

    return this.builder.build();
  }
}

/**
 * Generate Kitchen Checkout receipt as ESC/POS Buffer using bitmap rendering
 */
export function generateKitchenCheckoutReceiptBuffer(
  summary: ShiftSummary, 
  config: Partial<ReceiptTemplateConfig & { receiptTemplate?: 'classic' | 'modern' }> = {}
): Buffer {
  console.log('[KitchenCheckoutTemplate] generateKitchenCheckoutReceiptBuffer called (BITMAP MODE)');
  console.log('[KitchenCheckoutTemplate] Config:', JSON.stringify(config));
  
  const cfg = getDefaultConfig(config);
  const { language, currency, terminalName, receiptTemplate } = cfg;
  const isModern = receiptTemplate === 'modern';
  
  console.log('[KitchenCheckoutTemplate] Language:', language, 'Template:', receiptTemplate);
  
  const { shift } = summary;
  const checkInDate = new Date(shift.check_in_time);
  const checkOutDate = shift.check_out_time ? new Date(shift.check_out_time) : new Date();
  
  // Calculate hours worked
  const hoursWorked = ((checkOutDate.getTime() - checkInDate.getTime()) / (1000 * 60 * 60)).toFixed(2);

  const lines: TextLine[] = [];

  // ═══════════════════════════════════════════════════════════════
  // HEADER
  // ═══════════════════════════════════════════════════════════════
  lines.push({ text: '', style: 'normal', align: 'left' });
  
  if (isModern) {
    lines.push({ text: t('receipt.kitchenCheckout.title', language), style: 'boxHeader', align: 'center', inverted: true });
    lines.push({ text: '', style: 'small', align: 'left' });
    if (terminalName) {
      lines.push({ text: terminalName, style: 'normal', align: 'center' });
    }
    lines.push({ text: formatDate(checkOutDate, language), style: 'normal', align: 'center' });
    lines.push({ text: formatTime(checkOutDate, language), style: 'normal', align: 'center' });
  } else {
    lines.push({ text: t('receipt.kitchenCheckout.title', language), style: 'title', align: 'center' });
    lines.push({ text: '════════════════════════════════════════════', style: 'small', align: 'center' });
    if (terminalName) {
      lines.push({ text: terminalName, style: 'normal', align: 'center' });
    }
    lines.push({ text: formatDate(checkOutDate, language), style: 'normal', align: 'center' });
    lines.push({ text: formatTime(checkOutDate, language), style: 'normal', align: 'center' });
  }
  lines.push({ text: '', style: 'small', align: 'left' });

  // ═══════════════════════════════════════════════════════════════
  // STAFF INFORMATION
  // ═══════════════════════════════════════════════════════════════
  addSectionHeader(lines, t('receipt.kitchenCheckout.staffInfo', language), isModern);
  const staffName = (shift as any).staff_name || '';
  lines.push({ text: t('receipt.kitchenCheckout.name', language) + ':', style: 'normal', align: 'left', rightText: staffName });
  lines.push({ text: t('receipt.kitchenCheckout.role', language) + ':', style: 'normal', align: 'left', rightText: t('receipt.kitchenCheckout.kitchenStaff', language) });
  lines.push({ text: t('receipt.kitchenCheckout.shiftId', language) + ':', style: 'normal', align: 'left', rightText: shift.id.substring(0, 8) });
  lines.push({ text: '', style: 'small', align: 'left' });

  // ═══════════════════════════════════════════════════════════════
  // SHIFT TIMES
  // ═══════════════════════════════════════════════════════════════
  addSectionHeader(lines, t('receipt.kitchenCheckout.shiftTimes', language), isModern);
  lines.push({ text: t('receipt.kitchenCheckout.checkIn', language) + ':', style: 'normal', align: 'left', rightText: formatTime(checkInDate, language) });
  lines.push({ text: t('receipt.kitchenCheckout.checkOut', language) + ':', style: 'normal', align: 'left', rightText: formatTime(checkOutDate, language) });
  lines.push({ text: t('receipt.kitchenCheckout.hoursWorked', language) + ':', style: 'normal', align: 'left', rightText: hoursWorked + ' hrs' });
  lines.push({ text: '', style: 'small', align: 'left' });

  // ═══════════════════════════════════════════════════════════════
  // PAYMENT
  // ═══════════════════════════════════════════════════════════════
  addMajorSectionHeader(lines, t('receipt.kitchenCheckout.payment', language), isModern);
  lines.push({ text: t('receipt.kitchenCheckout.paymentAmount', language) + ':', style: 'bold', align: 'left', rightText: formatCurrency(shift.payment_amount || 0, currency) });

  if (isModern) {
    lines.push({ text: '', style: 'small', align: 'left' });
  } else {
    lines.push({ text: '════════════════════════════════════════════', style: 'small', align: 'center' });
  }
  lines.push({ text: '', style: 'small', align: 'left' });

  // Payment recording note
  lines.push({ text: t('receipt.formula.note.kitchenPayment', language), style: 'small', align: 'center' });
  lines.push({ text: '', style: 'small', align: 'left' });

  // ═══════════════════════════════════════════════════════════════
  // SIGNATURES
  // ═══════════════════════════════════════════════════════════════
  addSignatureLines(lines, [
    t('receipt.kitchenCheckout.staffSignature', language),
    t('receipt.kitchenCheckout.managerSignature', language)
  ]);

  // ═══════════════════════════════════════════════════════════════
  // FOOTER
  // ═══════════════════════════════════════════════════════════════
  lines.push({ text: '', style: 'normal', align: 'left' });
  lines.push({ text: '────────────────────────────────────────────', style: 'small', align: 'center' });
  lines.push({ text: t('receipt.kitchenCheckout.footer', language), style: 'normal', align: 'center' });
  lines.push({ text: '', style: 'normal', align: 'left' });
  lines.push({ text: '', style: 'normal', align: 'left' });

  return generateBitmapBuffer(lines, cfg.paperSize, 'KitchenCheckoutTemplate');
}

/**
 * Generate Kitchen Checkout receipt as plain text string (legacy compatibility)
 */
export function generateKitchenCheckoutReceipt(
  summary: ShiftSummary, 
  terminalName?: string, 
  paperWidth: number = 48
): string {
  const { shift } = summary;
  
  const checkInDate = new Date(shift.check_in_time);
  const checkOutDate = shift.check_out_time ? new Date(shift.check_out_time) : new Date();
  
  // Calculate hours worked
  const hoursWorked = ((checkOutDate.getTime() - checkInDate.getTime()) / (1000 * 60 * 60)).toFixed(2);
  
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
  receipt += center('KITCHEN STAFF CHECKOUT') + '\n';
  receipt += line('=') + '\n';
  receipt += '\n';
  
  if (terminalName) receipt += center(terminalName) + '\n';
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

  // Payment recording note
  receipt += center('Payment recorded by cashier during') + '\n';
  receipt += center('their checkout') + '\n';
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
  receipt += '\n\n\n';
  
  return receipt;
}
