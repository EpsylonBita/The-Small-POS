/**
 * Assign Order Print Template
 * 
 * Generates ESC/POS formatted receipts for driver order assignments.
 * Redesigned to focus on delivery details: Address, Phone, and Payment.
 */

import { ReceiptTemplateConfig } from '../printer/types';
import { BaseReceiptTemplate } from './BaseReceiptTemplate';
import { TextLine } from '../printer/services/escpos/GreekBitmapRenderer';
import {
  t, formatCurrency, formatDate, formatTime,
  addSectionHeader, generateBitmapBuffer, getDefaultConfig
} from './checkout-bitmap-utils';

/**
 * Data structure for assign-order receipt
 */
export interface AssignOrderData {
  orderId: string;
  orderNumber: string;
  driverId: string;
  driverName: string;
  customerName?: string;
  customerPhone?: string;
  deliveryAddress?: string;
  deliveryCity?: string;
  deliveryPostalCode?: string;
  deliveryNotes?: string;
  deliveryFloor?: string;
  deliveryBell?: string;
  orderTotal: number;
  paymentMethod: 'cash' | 'card' | 'online' | 'mixed';
  items?: Array<{
    name: string;
    quantity: number;
    specialInstructions?: string;
  }>;
  assignedAt: Date;
  estimatedDeliveryTime?: string;
  notes?: string;
}

/**
 * Assign Order Template Class
 * Kept for interface compatibility but methods are degenerate as we use the functional approach.
 */
class AssignOrderTemplate extends BaseReceiptTemplate {
  constructor(data: AssignOrderData, config: Partial<ReceiptTemplateConfig> = {}) {
    super(config);
  }
  generate(): Buffer { return Buffer.alloc(0); }
}

/**
 * Generate Assign Order receipt as ESC/POS Buffer (using Bitmap Rendering)
 * Redesigned for Driver convenience: Big Address, Big Phone, Big Payment.
 */
export function generateAssignOrderReceiptBuffer(
  data: AssignOrderData,
  config: Partial<ReceiptTemplateConfig> = {}
): Buffer {
  console.log('[AssignOrderTemplate] 🖨️ generateAssignOrderReceiptBuffer called');
  console.log('[AssignOrderTemplate] Config received:', JSON.stringify(config));
  console.log('[AssignOrderTemplate] full data payload:', JSON.stringify(data, null, 2));
  console.log('[AssignOrderTemplate] Address details -> city:', data.deliveryCity, 'postal:', data.deliveryPostalCode, 'floor:', data.deliveryFloor, 'bell:', data.deliveryBell, 'deliveryNotes:', data.deliveryNotes);

  const cfg = getDefaultConfig(config);
  console.log('[AssignOrderTemplate] Normalized config:', JSON.stringify(cfg));
  const { language, currency, terminalName, receiptTemplate } = cfg;
  const isModern = receiptTemplate === 'modern';

  console.log('[AssignOrderTemplate] Using template style:', isModern ? 'MODERN' : 'CLASSIC');

  const lines: TextLine[] = [];

  // 1. HEADER - Order Number, Date, Driver
  lines.push({ text: `#${data.orderNumber}`, style: 'header', align: 'center' });
  lines.push({ text: formatDate(data.assignedAt, language) + '  ' + formatTime(data.assignedAt, language), style: 'small', align: 'center' });
  lines.push({ text: '', style: 'small', align: 'left' });

  // Driver section with box header
  lines.push({ text: t('receipt.assignOrder.driver', language), style: 'boxHeader', align: 'center', inverted: true });
  lines.push({ text: data.driverName, style: 'bold', align: 'center' });
  lines.push({ text: '', style: 'small', align: 'left' });

  // 2. ADDRESS SECTION with box header
  const addressLabel = language === 'el' ? 'ΔΙΕΥΘΥΝΣΗ' : 'ADDRESS';
  lines.push({ text: addressLabel, style: 'boxHeader', align: 'center', inverted: true });
  lines.push({ text: '', style: 'small', align: 'left' });

  // Build address content lines first to calculate max width
  const addressContentLines: Array<{ content: string; style: 'bold' | 'header' | 'normal' | 'small' }> = [];

  // Customer Name
  if (data.customerName) {
    addressContentLines.push({ content: data.customerName, style: 'bold' });
  }

  // Customer Phone
  if (data.customerPhone) {
    addressContentLines.push({ content: data.customerPhone, style: 'header' });
  }

  // Empty line
  addressContentLines.push({ content: '', style: 'normal' });

  // Street Address - extract only the part before comma
  if (data.deliveryAddress) {
    const streetAddress = data.deliveryAddress.split(',')[0].trim();
    addressContentLines.push({ content: streetAddress, style: 'bold' });
  }

  // Postal Code + City
  const postalCity: string[] = [];
  if (data.deliveryPostalCode) {
    postalCity.push(data.deliveryPostalCode);
  }
  if (data.deliveryCity) {
    postalCity.push(data.deliveryCity);
  }
  if (postalCity.length > 0) {
    addressContentLines.push({ content: postalCity.join(' '), style: 'bold' });
  }

  // Floor
  if (data.deliveryFloor) {
    addressContentLines.push({ content: 'Floor: ' + data.deliveryFloor, style: 'normal' });
  }

  // Bell / Name on Ringer
  if (data.deliveryBell) {
    addressContentLines.push({ content: 'Bell: ' + data.deliveryBell, style: 'normal' });
  }

  // Notes (Address Notes & Order Notes combined)
  const allNotes: string[] = [];
  if (data.deliveryNotes) {
    allNotes.push(data.deliveryNotes);
  }
  if (data.notes) {
    allNotes.push(data.notes);
  }

  if (allNotes.length > 0) {
    addressContentLines.push({ content: '', style: 'normal' });
    addressContentLines.push({ content: 'Notes: ' + allNotes.join(', '), style: 'normal' });
  }

  // Calculate max content width (accounting for Greek characters which may be wider)
  const maxContentWidth = Math.max(
    ...addressContentLines.map(line => line.content.length),
    30 // Minimum width
  );

  // Helper function to pad text to width
  const padToWidth = (text: string, width: number): string => {
    const padding = width - text.length;
    return text + ' '.repeat(Math.max(0, padding));
  };

  // Generate stitched border based on content width
  // Use continuous dashes with the exact width of the content (plus 2 for the '| ' prefix)
  const borderDashes = '─'.repeat(maxContentWidth + 2);
  const topBorder = '┌' + borderDashes + '┐';
  const bottomBorder = '└' + borderDashes + '┘';

  // Address box with dynamic stitched border (top)
  lines.push({ text: topBorder, style: 'small', align: 'left' });

  // Add all address lines with proper padding
  addressContentLines.forEach(line => {
    const paddedContent = padToWidth(line.content, maxContentWidth);
    lines.push({ text: '| ' + paddedContent + ' |', style: line.style, align: 'left' });
  });

  // Address box with dynamic stitched border (bottom)
  lines.push({ text: bottomBorder, style: 'small', align: 'left' });
  lines.push({ text: '', style: 'small', align: 'left' });

  // 3. ORDER ITEMS with box header
  if (data.items && data.items.length > 0) {
    const itemsLabel = language === 'el' ? 'ΠΑΡΑΓΓΕΛΙΑ' : 'ORDER ITEMS';
    lines.push({ text: itemsLabel, style: 'boxHeader', align: 'center', inverted: true });

    data.items.forEach(item => {
      lines.push({ text: `${item.quantity}x ${item.name}`, style: 'normal', align: 'left' });
      if (item.specialInstructions) {
        lines.push({ text: `   * ${item.specialInstructions}`, style: 'small', align: 'left' });
      }
    });
    lines.push({ text: '', style: 'small', align: 'left' });
  }

  // 4. PAYMENT SECTION with box header
  const paymentMethodMap: Record<string, string> = {
    'cash': language === 'el' ? 'Μετρητά' : 'Cash',
    'card': language === 'el' ? 'Κάρτα' : 'Card',
    'online': language === 'el' ? 'Ηλεκτρονικά' : 'Online',
    'mixed': language === 'el' ? 'Μικτή' : 'Mixed'
  };
  const paymentLabel = paymentMethodMap[data.paymentMethod] || data.paymentMethod.toUpperCase();

  const totalLabel = (language === 'el' ? 'ΣΥΝΟΛΟ: ' : 'TOTAL: ') + formatCurrency(data.orderTotal, currency);
  lines.push({ text: totalLabel, style: 'boxHeader', align: 'center', inverted: true });
  lines.push({ text: '', style: 'small', align: 'left' });
  lines.push({ text: paymentLabel, style: 'header', align: 'center' });

  lines.push({ text: '', style: 'normal', align: 'left' });
  lines.push({ text: '', style: 'normal', align: 'left' });

  return generateBitmapBuffer(lines, cfg.paperSize, 'AssignOrderTemplate');
}

/**
 * Generate Assign Order receipt as plain text string (legacy compatibility)
 * Simplified to match new design.
 */
export function generateAssignOrderReceipt(
  data: AssignOrderData,
  terminalName?: string,
  paperWidth: number = 48
): string {
  return `
Order: #${data.orderNumber}
Driver: ${data.driverName}

${data.customerName || ''}
PHONE: ${data.customerPhone || ''}

${data.deliveryAddress || ''}
${data.deliveryFloor ? 'Floor: ' + data.deliveryFloor : ''} ${data.deliveryBell ? 'Bell: ' + data.deliveryBell : ''}

Total: ${data.orderTotal}
Method: ${data.paymentMethod.toUpperCase()}
`;
}
