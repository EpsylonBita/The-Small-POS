/**
 * Z-Report Print Template
 * 
 * Generates Z-Report receipts using bitmap rendering for consistent display
 * across all thermal printers. Supports both classic and modern template styles.
 * Supports i18n for English and Greek languages.
 * 
 * Uses chunked rendering to avoid PowerShell timeout issues with large reports.
 */

import { ReceiptTemplateConfig, PaperSize } from '../printer/types';
import { GreekBitmapRenderer, TextLine } from '../printer/services/escpos/GreekBitmapRenderer';
import mainI18n from '../lib/main-i18n';

// Maximum lines per chunk to avoid PowerShell timeout
const MAX_LINES_PER_CHUNK = 30;

/**
 * Helper to translate keys
 */
function t(key: string, language: string = 'en', options?: Record<string, any>): string {
  if (mainI18n && typeof mainI18n.t === 'function') {
    return mainI18n.t(key, { ...options, lng: language }) as string;
  }
  return key.split('.').pop() || key;
}

/**
 * Format currency
 */
function formatCurrency(amount: number, currency: string = '€'): string {
  return `${currency}${(amount || 0).toFixed(2)}`;
}

/**
 * Render lines in chunks to avoid PowerShell timeout
 */
function renderLinesInChunks(renderer: GreekBitmapRenderer, lines: TextLine[]): Buffer[] {
  const buffers: Buffer[] = [];
  
  for (let i = 0; i < lines.length; i += MAX_LINES_PER_CHUNK) {
    const chunk = lines.slice(i, i + MAX_LINES_PER_CHUNK);
    try {
      const chunkBuffer = renderer.renderLinesSync(chunk);
      buffers.push(chunkBuffer);
    } catch (error) {
      console.error('[ZReportTemplate] Chunk rendering failed at index', i, ':', error);
      throw error;
    }
  }
  
  return buffers;
}

/**
 * Add section header based on template style
 */
function addSectionHeader(lines: TextLine[], title: string, isModern: boolean): void {
  if (isModern) {
    // Modern style: pillow-shaped black header with white text
    lines.push({ text: title, style: 'boxHeader', align: 'center', inverted: true });
  } else {
    // Classic style: dashed line with bold text
    lines.push({ text: '────────────────────────────────────────────', style: 'small', align: 'center' });
    lines.push({ text: title, style: 'bold', align: 'left' });
    lines.push({ text: '────────────────────────────────────────────', style: 'small', align: 'center' });
  }
}

/**
 * Add major section header based on template style
 */
function addMajorSectionHeader(lines: TextLine[], title: string, isModern: boolean): void {
  if (isModern) {
    // Modern style: pillow-shaped black header with white text
    lines.push({ text: '', style: 'small', align: 'left' });
    lines.push({ text: title, style: 'boxHeader', align: 'center', inverted: true });
    lines.push({ text: '', style: 'small', align: 'left' });
  } else {
    // Classic style: double line with bold centered text
    lines.push({ text: '════════════════════════════════════════════', style: 'small', align: 'center' });
    lines.push({ text: title, style: 'header', align: 'center' });
    lines.push({ text: '════════════════════════════════════════════', style: 'small', align: 'center' });
  }
}

/**
 * Generate Z-Report receipt as ESC/POS Buffer using bitmap rendering
 * Supports both classic and modern template styles
 * 
 * @param snapshot - Z-Report data snapshot
 * @param config - Receipt template configuration
 * @returns Buffer containing ESC/POS commands with bitmap data
 */
export function generateZReportReceiptBuffer(
  snapshot: any, 
  config: Partial<ReceiptTemplateConfig & { receiptTemplate?: 'classic' | 'modern' }> = {}
): Buffer {
  console.log('[ZReportTemplate] generateZReportReceiptBuffer called (BITMAP MODE)');
  console.log('[ZReportTemplate] Config:', JSON.stringify(config));
  
  const paperSize = config.paperSize || PaperSize.MM_80;
  const language = config.language || 'en';
  const currency = config.currency || '€';
  const terminalName = config.terminalName;
  const receiptTemplate = config.receiptTemplate || 'classic';
  const isModern = receiptTemplate === 'modern';
  
  console.log('[ZReportTemplate] Language:', language, 'Template:', receiptTemplate);
  
  const renderer = new GreekBitmapRenderer(paperSize);
  const buffers: Buffer[] = [];

  // Initialize printer
  buffers.push(Buffer.from([0x1B, 0x40]));  // ESC @ - Initialize

  const lines: TextLine[] = [];
  const date = snapshot?.date || new Date().toISOString().slice(0, 10);

  // ═══════════════════════════════════════════════════════════════
  // HEADER
  // ═══════════════════════════════════════════════════════════════
  lines.push({ text: '', style: 'normal', align: 'left' });
  
  if (isModern) {
    // Modern: Title in pillow box
    lines.push({ text: t('receipt.zreport.title', language), style: 'boxHeader', align: 'center', inverted: true });
    lines.push({ text: '', style: 'small', align: 'left' });
    if (terminalName) {
      lines.push({ text: t('receipt.zreport.terminal', language), style: 'normal', align: 'left', rightText: terminalName });
    }
    lines.push({ text: t('receipt.zreport.date', language), style: 'normal', align: 'left', rightText: date });
  } else {
    // Classic: Title centered with double lines
    lines.push({ text: t('receipt.zreport.title', language), style: 'title', align: 'center' });
    lines.push({ text: '════════════════════════════════════════════', style: 'small', align: 'center' });
    if (terminalName) {
      lines.push({ text: t('receipt.zreport.terminal', language) + ': ' + terminalName, style: 'normal', align: 'center' });
    }
    lines.push({ text: t('receipt.zreport.date', language) + ': ' + date, style: 'normal', align: 'center' });
  }
  lines.push({ text: '', style: 'small', align: 'left' });

  // ═══════════════════════════════════════════════════════════════
  // TERMINAL BREAKDOWN
  // ═══════════════════════════════════════════════════════════════
  const terminalBreakdown = Array.isArray(snapshot?.terminalBreakdown) ? snapshot.terminalBreakdown : [];
  if (terminalBreakdown.length > 0) {
    addSectionHeader(lines, t('receipt.zreport.terminalBreakdown', language), isModern);
    
    terminalBreakdown.forEach((term: any) => {
      let prefix = '';
      if (term.type === 'main') prefix = '[M] ';
      else if (term.type === 'mobile_waiter' || term.type === 'waiter') prefix = '[W] ';
      
      lines.push({ text: prefix + (term.name || term.id), style: 'bold', align: 'left' });
      lines.push({ text: '  ' + t('receipt.zreport.orders', language), style: 'normal', align: 'left', rightText: String(term.orders || 0) });
      lines.push({ text: '  ' + t('receipt.zreport.total', language), style: 'normal', align: 'left', rightText: formatCurrency(term.total || 0, currency) });
      lines.push({ text: '  ' + t('receipt.zreport.cash', language), style: 'normal', align: 'left', rightText: formatCurrency(term.cash || 0, currency) });
      lines.push({ text: '  ' + t('receipt.zreport.card', language), style: 'normal', align: 'left', rightText: formatCurrency(term.card || 0, currency) });
    });
    lines.push({ text: '', style: 'small', align: 'left' });
  }

  // ═══════════════════════════════════════════════════════════════
  // SHIFTS
  // ═══════════════════════════════════════════════════════════════
  const shifts = snapshot?.shifts || {};
  addSectionHeader(lines, t('receipt.zreport.shifts', language), isModern);
  lines.push({ text: '  ' + t('receipt.zreport.total', language), style: 'normal', align: 'left', rightText: String(shifts.total || 0) });
  lines.push({ text: '  Cashier', style: 'normal', align: 'left', rightText: String(shifts.cashier || 0) });
  lines.push({ text: '  Driver', style: 'normal', align: 'left', rightText: String(shifts.driver || 0) });
  lines.push({ text: '', style: 'small', align: 'left' });

  // ═══════════════════════════════════════════════════════════════
  // SALES SUMMARY
  // ═══════════════════════════════════════════════════════════════
  const sales = snapshot?.sales || {};
  addSectionHeader(lines, t('receipt.zreport.salesSummary', language), isModern);
  lines.push({ text: '  ' + t('receipt.zreport.orders', language), style: 'normal', align: 'left', rightText: String(sales.totalOrders || 0) });
  lines.push({ text: '  ' + t('receipt.zreport.total', language), style: 'normal', align: 'left', rightText: formatCurrency(sales.totalSales || 0, currency) });
  lines.push({ text: '  ' + t('receipt.zreport.cash', language), style: 'normal', align: 'left', rightText: formatCurrency(sales.cashSales || 0, currency) });
  lines.push({ text: '  ' + t('receipt.zreport.card', language), style: 'normal', align: 'left', rightText: formatCurrency(sales.cardSales || 0, currency) });
  lines.push({ text: '', style: 'small', align: 'left' });

  // ═══════════════════════════════════════════════════════════════
  // BY ORDER TYPE
  // ═══════════════════════════════════════════════════════════════
  const byType = sales.byType || {};
  const instore = byType.instore || { cash: {}, card: {} };
  const delivery = byType.delivery || { cash: {}, card: {} };
  
  addSectionHeader(lines, t('receipt.zreport.byOrderType', language), isModern);
  lines.push({ text: '  ' + t('receipt.zreport.inStore', language), style: 'bold', align: 'left' });
  lines.push({ text: '    ' + t('receipt.zreport.cash', language) + ' (' + (instore.cash.count || 0) + ')', style: 'normal', align: 'left', rightText: formatCurrency(instore.cash.total || 0, currency) });
  lines.push({ text: '    ' + t('receipt.zreport.card', language) + ' (' + (instore.card.count || 0) + ')', style: 'normal', align: 'left', rightText: formatCurrency(instore.card.total || 0, currency) });
  lines.push({ text: '  ' + t('receipt.zreport.delivery', language), style: 'bold', align: 'left' });
  lines.push({ text: '    ' + t('receipt.zreport.cash', language) + ' (' + (delivery.cash.count || 0) + ')', style: 'normal', align: 'left', rightText: formatCurrency(delivery.cash.total || 0, currency) });
  lines.push({ text: '    ' + t('receipt.zreport.card', language) + ' (' + (delivery.card.count || 0) + ')', style: 'normal', align: 'left', rightText: formatCurrency(delivery.card.total || 0, currency) });
  lines.push({ text: '', style: 'small', align: 'left' });

  // ═══════════════════════════════════════════════════════════════
  // CASH DRAWER TOTALS
  // ═══════════════════════════════════════════════════════════════
  const cd = snapshot?.cashDrawer || {};
  addSectionHeader(lines, t('receipt.zreport.cashDrawer', language), isModern);
  lines.push({ text: '  ' + t('receipt.zreport.openingTotal', language), style: 'normal', align: 'left', rightText: formatCurrency(cd.openingTotal || 0, currency) });
  lines.push({ text: '  ' + t('receipt.zreport.driverGiven', language), style: 'normal', align: 'left', rightText: formatCurrency(cd.driverCashGiven || 0, currency) });
  lines.push({ text: '  ' + t('receipt.zreport.driverReturned', language), style: 'normal', align: 'left', rightText: formatCurrency(cd.driverCashReturned || 0, currency) });
  lines.push({ text: '  ' + t('receipt.zreport.variance', language), style: 'normal', align: 'left', rightText: formatCurrency(cd.totalVariance || 0, currency) });
  lines.push({ text: '  ' + t('receipt.zreport.cashDrops', language), style: 'normal', align: 'left', rightText: formatCurrency(cd.totalCashDrops || 0, currency) });
  lines.push({ text: '  ' + t('receipt.zreport.unreconciled', language), style: 'normal', align: 'left', rightText: String(cd.unreconciledCount || 0) });
  lines.push({ text: '', style: 'small', align: 'left' });

  // ═══════════════════════════════════════════════════════════════
  // EXPENSES
  // ═══════════════════════════════════════════════════════════════
  const expenses = snapshot?.expenses || {};
  addSectionHeader(lines, t('receipt.zreport.expenses', language), isModern);
  lines.push({ text: '  ' + t('receipt.zreport.total', language), style: 'normal', align: 'left', rightText: formatCurrency(expenses.total || 0, currency) });
  lines.push({ text: '  ' + t('receipt.zreport.staffPayments', language), style: 'normal', align: 'left', rightText: formatCurrency(expenses.staffPaymentsTotal || 0, currency) });
  lines.push({ text: '  ' + t('receipt.zreport.pending', language), style: 'normal', align: 'left', rightText: String(expenses.pendingCount || 0) });
  lines.push({ text: '', style: 'small', align: 'left' });

  // ═══════════════════════════════════════════════════════════════
  // DRIVER EARNINGS
  // ═══════════════════════════════════════════════════════════════
  const de = snapshot?.driverEarnings || {};
  addSectionHeader(lines, t('receipt.zreport.driverEarnings', language), isModern);
  lines.push({ text: '  ' + t('receipt.zreport.totalDeliveries', language), style: 'normal', align: 'left', rightText: String(de.totalDeliveries || 0) });
  lines.push({ text: '    [OK] ' + t('receipt.zreport.completed', language), style: 'small', align: 'left', rightText: String(de.completedDeliveries || 0) });
  lines.push({ text: '    [X ] ' + t('receipt.zreport.cancelled', language), style: 'small', align: 'left', rightText: String(de.cancelledDeliveries || 0) });
  lines.push({ text: '  ' + t('receipt.zreport.totalEarned', language), style: 'normal', align: 'left', rightText: formatCurrency(de.totalEarnings || 0, currency) });
  lines.push({ text: '  ' + t('receipt.zreport.cashCollected', language), style: 'normal', align: 'left', rightText: formatCurrency(de.cashCollectedTotal || 0, currency) });
  lines.push({ text: '  ' + t('receipt.zreport.cardAmount', language), style: 'normal', align: 'left', rightText: formatCurrency(de.cardAmountTotal || 0, currency) });
  lines.push({ text: '  ' + t('receipt.zreport.cashToReturn', language), style: 'normal', align: 'left', rightText: formatCurrency(de.cashToReturnTotal || 0, currency) });
  lines.push({ text: '', style: 'small', align: 'left' });

  // ═══════════════════════════════════════════════════════════════
  // STAFF REPORTS
  // ═══════════════════════════════════════════════════════════════
  const staffReports = Array.isArray(snapshot?.staffReports) ? snapshot.staffReports : [];
  if (staffReports.length > 0) {
    addMajorSectionHeader(lines, t('receipt.zreport.staffReports', language), isModern);
    
    staffReports.forEach((s: any) => {
      const statusSymbol = (s.shiftStatus === 'closed' || s.checkOut) ? '[OK]' : '[  ]';
      const checkInTime = s.checkIn 
        ? new Date(s.checkIn).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) 
        : '-';
      const checkOutTime = s.checkOut 
        ? new Date(s.checkOut).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) 
        : '-';

      lines.push({ text: statusSymbol + ' ' + (s.staffName || s.staffId) + ' (' + s.role + ')', style: 'bold', align: 'left' });
      lines.push({ text: '  ' + t('receipt.zreport.checkIn', language) + ': ' + checkInTime + '  ' + t('receipt.zreport.checkOut', language) + ': ' + checkOutTime, style: 'small', align: 'left' });
      lines.push({ text: '  ' + t('receipt.zreport.orders', language), style: 'normal', align: 'left', rightText: String(s.orders?.count || 0) });
      lines.push({ text: '    ' + t('receipt.zreport.cash', language), style: 'small', align: 'left', rightText: formatCurrency(s.orders?.cashAmount || 0, currency) });
      lines.push({ text: '    ' + t('receipt.zreport.card', language), style: 'small', align: 'left', rightText: formatCurrency(s.orders?.cardAmount || 0, currency) });
      lines.push({ text: '  ' + t('receipt.zreport.paymentReceived', language), style: 'normal', align: 'left', rightText: formatCurrency(s.payments?.staffPayments || 0, currency) });
      lines.push({ text: '  ' + t('receipt.zreport.expenses', language), style: 'normal', align: 'left', rightText: formatCurrency(s.expenses?.total || 0, currency) });
      lines.push({ text: '  ' + t('receipt.zreport.returnedToDrawer', language), style: 'normal', align: 'left', rightText: formatCurrency(s.returnedToDrawerAmount || 0, currency) });

      if (String(s.role).toLowerCase() === 'driver') {
        lines.push({ text: '  ' + t('receipt.zreport.deliveries', language), style: 'normal', align: 'left', rightText: String(s.driver?.deliveries || 0) });
        lines.push({ text: '    [OK] ' + t('receipt.zreport.completed', language), style: 'small', align: 'left', rightText: String(s.driver?.completedDeliveries || 0) });
        lines.push({ text: '    [X ] ' + t('receipt.zreport.cancelled', language), style: 'small', align: 'left', rightText: String(s.driver?.cancelledDeliveries || 0) });
        lines.push({ text: '  ' + t('receipt.zreport.earnings', language), style: 'normal', align: 'left', rightText: formatCurrency(s.driver?.earnings || 0, currency) });
        lines.push({ text: '  ' + t('receipt.zreport.driverCash', language), style: 'normal', align: 'left', rightText: formatCurrency(s.driver?.cashCollected || 0, currency) });
        lines.push({ text: '  ' + t('receipt.zreport.driverCard', language), style: 'normal', align: 'left', rightText: formatCurrency(s.driver?.cardAmount || 0, currency) });
      }
      lines.push({ text: '────────────────────────────────────────────', style: 'small', align: 'center' });
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // STAFF PAYMENTS DETAIL
  // ═══════════════════════════════════════════════════════════════
  const staffAnalytics = Array.isArray(snapshot?.staffAnalytics) ? snapshot.staffAnalytics : [];
  if (staffAnalytics.length > 0) {
    addMajorSectionHeader(lines, t('receipt.zreport.staffPaymentsDetail', language), isModern);

    staffAnalytics.forEach((p: any) => {
      const statusSymbol = (p.shiftStatus === 'closed') ? '[OK]' : '[  ]';
      const payType = p.paymentType ? ' (' + p.paymentType + ')' : '';

      lines.push({ text: statusSymbol + ' ' + (p.staffName || p.staffId) + payType, style: 'bold', align: 'left' });

      if (p.checkInTime || p.checkOutTime) {
        const checkIn = p.checkInTime 
          ? new Date(p.checkInTime).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) 
          : '-';
        const checkOut = p.checkOutTime 
          ? new Date(p.checkOutTime).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) 
          : '-';
        lines.push({ text: '  Shift: ' + checkIn + ' - ' + checkOut, style: 'small', align: 'left' });
      }

      lines.push({ text: '  Amount Paid', style: 'normal', align: 'left', rightText: formatCurrency(p.amount || 0, currency) });

      if (p.notes) {
        lines.push({ text: '  Note: ' + p.notes, style: 'small', align: 'left' });
      }
      lines.push({ text: '────────────────────────────────────────────', style: 'small', align: 'center' });
    });

    const totalPayments = staffAnalytics.reduce((sum: number, p: any) => sum + Number(p.amount || 0), 0);
    lines.push({ text: t('receipt.zreport.total', language) + ' ' + t('receipt.zreport.staffPayments', language), style: 'bold', align: 'left', rightText: formatCurrency(totalPayments, currency) });
    lines.push({ text: '', style: 'small', align: 'left' });
  }

  // ═══════════════════════════════════════════════════════════════
  // DRAWERS
  // ═══════════════════════════════════════════════════════════════
  const drawers = Array.isArray(snapshot?.drawers) ? snapshot.drawers : [];
  if (drawers.length > 0) {
    addSectionHeader(lines, t('receipt.zreport.drawers', language), isModern);

    drawers.forEach((d: any, idx: number) => {
      const name = d.staffName || 'Drawer ' + (idx + 1);
      
      lines.push({ text: '  ' + name, style: 'bold', align: 'left' });
      lines.push({ text: '    ' + t('receipt.zreport.opening', language), style: 'normal', align: 'left', rightText: formatCurrency(d.opening || 0, currency) });
      lines.push({ text: '    ' + t('receipt.zreport.cash', language), style: 'normal', align: 'left', rightText: formatCurrency(d.cashSales || 0, currency) });
      lines.push({ text: '    ' + t('receipt.zreport.card', language), style: 'normal', align: 'left', rightText: formatCurrency(d.cardSales || 0, currency) });
      lines.push({ text: '    ' + t('receipt.zreport.expected', language), style: 'normal', align: 'left', rightText: formatCurrency(d.expected || 0, currency) });
      lines.push({ text: '    ' + t('receipt.zreport.closing', language), style: 'normal', align: 'left', rightText: formatCurrency(d.closing || 0, currency) });
      lines.push({ text: '    ' + t('receipt.zreport.variance', language), style: 'normal', align: 'left', rightText: formatCurrency(d.variance || 0, currency) });
    });
    lines.push({ text: '', style: 'small', align: 'left' });
  }

  // ═══════════════════════════════════════════════════════════════
  // DAY SUMMARY
  // ═══════════════════════════════════════════════════════════════
  const ds = snapshot?.daySummary || {};
  addSectionHeader(lines, t('receipt.zreport.daySummary', language), isModern);
  lines.push({ text: '  ' + t('receipt.zreport.cashTotal', language), style: 'normal', align: 'left', rightText: formatCurrency(ds.cashTotal || 0, currency) });
  lines.push({ text: '  ' + t('receipt.zreport.cardTotal', language), style: 'normal', align: 'left', rightText: formatCurrency(ds.cardTotal || 0, currency) });
  
  if (isModern) {
    lines.push({ text: '', style: 'small', align: 'left' });
    lines.push({ text: t('receipt.zreport.total', language) + ' ' + formatCurrency(ds.total || 0, currency), style: 'boxHeader', align: 'center', inverted: true });
  } else {
    lines.push({ text: '════════════════════════════════════════════', style: 'small', align: 'center' });
    lines.push({ text: t('receipt.zreport.total', language), style: 'header', align: 'left', rightText: formatCurrency(ds.total || 0, currency) });
    lines.push({ text: '════════════════════════════════════════════', style: 'small', align: 'center' });
  }
  lines.push({ text: '', style: 'small', align: 'left' });

  // ═══════════════════════════════════════════════════════════════
  // FOOTER
  // ═══════════════════════════════════════════════════════════════
  lines.push({ text: '────────────────────────────────────────────', style: 'small', align: 'center' });
  lines.push({ text: t('receipt.zreport.submitted', language), style: 'normal', align: 'center' });
  lines.push({ text: new Date().toISOString(), style: 'small', align: 'center' });
  lines.push({ text: '', style: 'small', align: 'left' });
  lines.push({ text: '--- ' + t('receipt.zreport.end', language) + ' ---', style: 'bold', align: 'center' });
  lines.push({ text: '', style: 'normal', align: 'left' });
  lines.push({ text: '', style: 'normal', align: 'left' });

  // Render bitmap in chunks to avoid timeout
  try {
    console.log('[ZReportTemplate] Total lines to render:', lines.length);
    const bitmapBuffers = renderLinesInChunks(renderer, lines);
    console.log('[ZReportTemplate] Rendered', bitmapBuffers.length, 'chunks successfully');
    
    for (const bitmapBuffer of bitmapBuffers) {
      buffers.push(bitmapBuffer);
    }
  } catch (error) {
    console.error('[ZReportTemplate] Bitmap rendering failed:', error);
    // Return empty buffer on error - caller should handle
    return Buffer.from([0x1B, 0x40, 0x1D, 0x56, 0x42, 0x03]);
  }

  // Cut command
  buffers.push(Buffer.from([0x1D, 0x56, 0x42, 0x03]));
  
  const finalBuffer = Buffer.concat(buffers);
  console.log('[ZReportTemplate] Final buffer size:', finalBuffer.length, 'bytes');
  
  return finalBuffer;
}


/**
 * Generate Z-Report receipt as plain text string (legacy compatibility)
 * 
 * @param snapshot - Z-Report data snapshot
 * @param terminalName - Optional terminal name
 * @param paperWidth - Paper width in characters (default 48)
 * @returns Plain text receipt string
 */
export function generateZReportReceipt(
  snapshot: any, 
  terminalName?: string, 
  paperWidth: number = 48
): string {
  const lines: string[] = [];
  const pad = (s: string = '', len = 32) => {
    const RIGHT = 12;
    const LEFT = Math.max(0, paperWidth - RIGHT);
    const target = len > 20 ? LEFT : RIGHT;
    return s.length > target ? s.slice(0, target) : s + ' '.repeat(Math.max(0, target - s.length));
  };
  const num = (n: any) => (Number(n || 0)).toFixed(2);
  const divider = () => lines.push('-'.repeat(paperWidth));
  const doubleDivider = () => lines.push('='.repeat(paperWidth));

  const statusSymbol = (status: string) => status === 'closed' ? '[OK]' : '[  ]';
  const date = snapshot?.date || new Date().toISOString().slice(0, 10);

  lines.push('*** Z REPORT ***');
  if (terminalName) lines.push(`Terminal: ${terminalName}`);
  lines.push(`Date: ${date}`);
  divider();

  // Terminal Breakdown
  const terminalBreakdown = Array.isArray(snapshot?.terminalBreakdown) ? snapshot.terminalBreakdown : [];
  if (terminalBreakdown.length > 0) {
    lines.push('Terminal Breakdown');
    terminalBreakdown.forEach((t: any) => {
      let prefix = '';
      if (t.type === 'main') prefix = '[M] ';
      else if (t.type === 'mobile_waiter' || t.type === 'waiter') prefix = '[W] ';
      lines.push(`${prefix}${t.name || t.id}`);
      lines.push(pad('  Orders', 20) + pad(String(t.orders || 0), 12));
      lines.push(pad('  Total', 20) + pad(num(t.total), 12));
      lines.push(pad('  Cash', 20) + pad(num(t.cash), 12));
      lines.push(pad('  Card', 20) + pad(num(t.card), 12));
    });
    divider();
  }

  // Shifts
  const shifts = snapshot?.shifts || {};
  lines.push('Shifts');
  lines.push(pad('  Total', 20) + pad(String(shifts.total || 0), 12));
  lines.push(pad('  Cashier', 20) + pad(String(shifts.cashier || 0), 12));
  lines.push(pad('  Driver', 20) + pad(String(shifts.driver || 0), 12));
  divider();

  // Sales summary
  const sales = snapshot?.sales || {};
  lines.push('Sales Summary');
  lines.push(pad('  Orders', 20) + pad(String(sales.totalOrders || 0), 12));
  lines.push(pad('  Total', 20) + pad(num(sales.totalSales), 12));
  lines.push(pad('  Cash', 20) + pad(num(sales.cashSales), 12));
  lines.push(pad('  Card', 20) + pad(num(sales.cardSales), 12));
  divider();

  // By type
  const byType = sales.byType || {};
  const instore = byType.instore || { cash: {}, card: {} };
  const delivery = byType.delivery || { cash: {}, card: {} };
  lines.push('By Order Type');
  lines.push('  In-Store');
  lines.push(pad(`    Cash (${instore.cash.count || 0})`, 20) + pad(num(instore.cash.total), 12));
  lines.push(pad(`    Card (${instore.card.count || 0})`, 20) + pad(num(instore.card.total), 12));
  lines.push('  Delivery');
  lines.push(pad(`    Cash (${delivery.cash.count || 0})`, 20) + pad(num(delivery.cash.total), 12));
  lines.push(pad(`    Card (${delivery.card.count || 0})`, 20) + pad(num(delivery.card.total), 12));
  divider();

  // Cash drawer totals
  const cd = snapshot?.cashDrawer || {};
  lines.push('Cash Drawer Totals');
  lines.push(pad('  Opening Total', 20) + pad(num(cd.openingTotal), 12));
  lines.push(pad('  Driver Given', 20) + pad(num(cd.driverCashGiven), 12));
  lines.push(pad('  Driver Returned', 20) + pad(num(cd.driverCashReturned), 12));
  lines.push(pad('  Variance', 20) + pad(num(cd.totalVariance), 12));
  lines.push(pad('  Cash Drops', 20) + pad(num(cd.totalCashDrops), 12));
  lines.push(pad('  Unreconciled', 20) + pad(String(cd.unreconciledCount || 0), 12));
  divider();

  // Expenses
  const expenses = snapshot?.expenses || {};
  lines.push('Expenses');
  lines.push(pad('  Total', 20) + pad(num(expenses.total), 12));
  lines.push(pad('  Staff Payments', 20) + pad(num(expenses.staffPaymentsTotal), 12));
  lines.push(pad('  Pending', 20) + pad(String(expenses.pendingCount || 0), 12));
  divider();

  // Driver earnings
  const de = snapshot?.driverEarnings || {};
  lines.push('Driver Earnings');
  lines.push(pad('  Total Deliveries', 20) + pad(String(de.totalDeliveries || 0), 12));
  lines.push(pad('    [OK] Completed', 20) + pad(String(de.completedDeliveries || 0), 12));
  lines.push(pad('    [X ] Cancelled', 20) + pad(String(de.cancelledDeliveries || 0), 12));
  lines.push(pad('  Total Earned', 20) + pad(num(de.totalEarnings), 12));
  lines.push(pad('  Cash Collected', 20) + pad(num(de.cashCollectedTotal), 12));
  lines.push(pad('  Card Amount', 20) + pad(num(de.cardAmountTotal), 12));
  lines.push(pad('  Cash to Return', 20) + pad(num(de.cashToReturnTotal), 12));
  divider();

  // Staff reports
  const staffReports = Array.isArray(snapshot?.staffReports) ? snapshot.staffReports : [];
  if (staffReports.length > 0) {
    doubleDivider();
    lines.push('Staff Reports');
    doubleDivider();
    staffReports.forEach((s: any) => {
      const status = statusSymbol(s.shiftStatus || (s.checkOut ? 'closed' : 'active'));
      lines.push(`${status} ${s.staffName || s.staffId} (${s.role})`);
      const checkInTime = s.checkIn ? new Date(s.checkIn).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) : '-';
      const checkOutTime = s.checkOut ? new Date(s.checkOut).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) : '-';
      lines.push(`  In: ${checkInTime}  Out: ${checkOutTime}`);
      lines.push(pad('  Orders', 20) + pad(String(s.orders?.count || 0), 12));
      lines.push(pad('    Cash', 20) + pad(num(s.orders?.cashAmount), 12));
      lines.push(pad('    Card', 20) + pad(num(s.orders?.cardAmount), 12));
      lines.push(pad('  Payment Received', 20) + pad(num(s.payments?.staffPayments), 12));
      lines.push(pad('  Expenses', 20) + pad(num(s.expenses?.total), 12));
      lines.push(pad('  Returned to Drawer', 20) + pad(num(s.returnedToDrawerAmount), 12));
      if (String(s.role).toLowerCase() === 'driver') {
        lines.push(pad('  Deliveries', 20) + pad(String(s.driver?.deliveries || 0), 12));
        lines.push(pad('    [OK] Completed', 20) + pad(String(s.driver?.completedDeliveries || 0), 12));
        lines.push(pad('    [X ] Cancelled', 20) + pad(String(s.driver?.cancelledDeliveries || 0), 12));
        lines.push(pad('  Earnings', 20) + pad(num(s.driver?.earnings), 12));
        lines.push(pad('  Driver Cash', 20) + pad(num(s.driver?.cashCollected), 12));
        lines.push(pad('  Driver Card', 20) + pad(num(s.driver?.cardAmount), 12));
      }
      divider();
    });
  }

  // Staff Analytics
  const staffAnalytics = Array.isArray(snapshot?.staffAnalytics) ? snapshot.staffAnalytics : [];
  if (staffAnalytics.length > 0) {
    doubleDivider();
    lines.push('Staff Payments Detail');
    doubleDivider();
    staffAnalytics.forEach((p: any) => {
      const status = statusSymbol(p.shiftStatus || 'active');
      const payType = p.paymentType ? `(${p.paymentType})` : '';
      lines.push(`${status} ${p.staffName || p.staffId} ${payType}`);
      if (p.checkInTime || p.checkOutTime) {
        const checkIn = p.checkInTime ? new Date(p.checkInTime).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) : '-';
        const checkOut = p.checkOutTime ? new Date(p.checkOutTime).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) : '-';
        lines.push(`  Shift: ${checkIn} - ${checkOut}`);
      }
      lines.push(pad('  Amount Paid', 20) + pad(num(p.amount), 12));
      if (p.notes) lines.push(`  Note: ${p.notes}`);
      divider();
    });
    const totalPayments = staffAnalytics.reduce((sum: number, p: any) => sum + Number(p.amount || 0), 0);
    lines.push(pad('Total Staff Payments', 20) + pad(num(totalPayments), 12));
    divider();
  }

  // Drawers
  const drawers = Array.isArray(snapshot?.drawers) ? snapshot.drawers : [];
  lines.push('Drawers');
  drawers.forEach((d: any, idx: number) => {
    const name = d.staffName || `Drawer ${idx + 1}`;
    lines.push(`  ${name}`);
    lines.push(pad('    Opening', 20) + pad(num(d.opening), 12));
    lines.push(pad('    Cash', 20) + pad(num(d.cashSales), 12));
    lines.push(pad('    Card', 20) + pad(num(d.cardSales), 12));
    lines.push(pad('    Expected', 20) + pad(num(d.expected), 12));
    lines.push(pad('    Closing', 20) + pad(num(d.closing), 12));
    lines.push(pad('    Variance', 20) + pad(num(d.variance), 12));
  });
  divider();

  // Day Summary
  const ds = snapshot?.daySummary || {};
  lines.push('Day Summary');
  lines.push(pad('  Cash Total', 20) + pad(num(ds.cashTotal), 12));
  lines.push(pad('  Card Total', 20) + pad(num(ds.cardTotal), 12));
  lines.push(pad('  Total', 20) + pad(num(ds.total), 12));
  divider();

  lines.push('Submitted to Admin');
  lines.push(new Date().toISOString());
  lines.push('--- END Z REPORT ---');

  return lines.join('\n');
}
