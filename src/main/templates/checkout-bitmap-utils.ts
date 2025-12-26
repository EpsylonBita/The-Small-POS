/**
 * Shared utilities for bitmap-based checkout templates
 * 
 * Provides common functions for rendering checkout receipts using bitmap rendering.
 */

import { PaperSize } from '../printer/types';
import { GreekBitmapRenderer, TextLine } from '../printer/services/escpos/GreekBitmapRenderer';
import mainI18n from '../lib/main-i18n';

// Maximum lines per chunk to avoid PowerShell timeout
export const MAX_LINES_PER_CHUNK = 30;

/**
 * Helper to translate keys
 */
export function t(key: string, language: string = 'en', options?: Record<string, any>): string {
  if (mainI18n && typeof mainI18n.t === 'function') {
    return mainI18n.t(key, { ...options, lng: language }) as string;
  }
  return key.split('.').pop() || key;
}

/**
 * Format currency
 */
export function formatCurrency(amount: number, currency: string = '€'): string {
  return `${currency}${(amount || 0).toFixed(2)}`;
}

/**
 * Format date
 */
export function formatDate(date: Date, language: string = 'en'): string {
  return date.toLocaleDateString(language === 'el' ? 'el-GR' : 'en-US', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
}

/**
 * Format time
 */
export function formatTime(date: Date, language: string = 'en'): string {
  return date.toLocaleTimeString(language === 'el' ? 'el-GR' : 'en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: language !== 'el',
  });
}

/**
 * Render lines in chunks to avoid PowerShell timeout
 */
export function renderLinesInChunks(renderer: GreekBitmapRenderer, lines: TextLine[]): Buffer[] {
  const buffers: Buffer[] = [];
  
  for (let i = 0; i < lines.length; i += MAX_LINES_PER_CHUNK) {
    const chunk = lines.slice(i, i + MAX_LINES_PER_CHUNK);
    try {
      const chunkBuffer = renderer.renderLinesSync(chunk);
      buffers.push(chunkBuffer);
    } catch (error) {
      console.error('[CheckoutTemplate] Chunk rendering failed at index', i, ':', error);
      throw error;
    }
  }
  
  return buffers;
}

/**
 * Add section header based on template style
 */
export function addSectionHeader(lines: TextLine[], title: string, isModern: boolean): void {
  if (isModern) {
    lines.push({ text: title, style: 'boxHeader', align: 'center', inverted: true });
    lines.push({ text: '', style: 'small', align: 'left' });
  } else {
    lines.push({ text: '────────────────────────────────────────────', style: 'small', align: 'center' });
    lines.push({ text: title, style: 'bold', align: 'left' });
    lines.push({ text: '────────────────────────────────────────────', style: 'small', align: 'center' });
  }
}

/**
 * Add major section header based on template style
 */
export function addMajorSectionHeader(lines: TextLine[], title: string, isModern: boolean): void {
  if (isModern) {
    lines.push({ text: '', style: 'small', align: 'left' });
    lines.push({ text: title, style: 'boxHeader', align: 'center', inverted: true });
    lines.push({ text: '', style: 'small', align: 'left' });
  } else {
    lines.push({ text: '════════════════════════════════════════════', style: 'small', align: 'center' });
    lines.push({ text: title, style: 'header', align: 'center' });
    lines.push({ text: '════════════════════════════════════════════', style: 'small', align: 'center' });
  }
}

/**
 * Add signature lines
 */
export function addSignatureLines(lines: TextLine[], labels: string[]): void {
  lines.push({ text: '', style: 'normal', align: 'left' });
  lines.push({ text: '────────────────────────────────────────────', style: 'small', align: 'center' });
  
  labels.forEach(label => {
    lines.push({ text: '', style: 'normal', align: 'left' });
    lines.push({ text: label + ':', style: 'normal', align: 'left' });
    lines.push({ text: '', style: 'normal', align: 'left' });
    lines.push({ text: 'X_______________________________', style: 'normal', align: 'left' });
  });
}

/**
 * Generate bitmap buffer from lines
 */
export function generateBitmapBuffer(
  lines: TextLine[],
  paperSize: PaperSize,
  templateName: string
): Buffer {
  const renderer = new GreekBitmapRenderer(paperSize);
  const buffers: Buffer[] = [];

  // Initialize printer
  buffers.push(Buffer.from([0x1B, 0x40]));  // ESC @ - Initialize

  // Render bitmap in chunks
  try {
    console.log(`[${templateName}] Total lines to render:`, lines.length);
    const bitmapBuffers = renderLinesInChunks(renderer, lines);
    console.log(`[${templateName}] Rendered`, bitmapBuffers.length, 'chunks successfully');
    
    for (const bitmapBuffer of bitmapBuffers) {
      buffers.push(bitmapBuffer);
    }
  } catch (error) {
    console.error(`[${templateName}] Bitmap rendering failed:`, error);
    return Buffer.from([0x1B, 0x40, 0x1D, 0x56, 0x42, 0x03]);
  }

  // Cut command
  buffers.push(Buffer.from([0x1D, 0x56, 0x42, 0x03]));
  
  const finalBuffer = Buffer.concat(buffers);
  console.log(`[${templateName}] Final buffer size:`, finalBuffer.length, 'bytes');
  
  return finalBuffer;
}

export interface CheckoutConfig {
  paperSize: PaperSize;
  language: 'en' | 'el';
  currency: string;
  terminalName?: string;
  receiptTemplate: 'classic' | 'modern';
}

export function getDefaultConfig(config: Partial<CheckoutConfig & { receiptTemplate?: string }> = {}): CheckoutConfig {
  return {
    paperSize: config.paperSize || PaperSize.MM_80,
    language: config.language || 'en',
    currency: config.currency || '€',
    terminalName: config.terminalName,
    receiptTemplate: (config.receiptTemplate as 'classic' | 'modern') || 'classic',
  };
}
