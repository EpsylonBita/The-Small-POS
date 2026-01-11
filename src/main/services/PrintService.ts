/**
 * Print Service for POS System
 * Handles printing of checkout receipts and reports
 *
 * This service now integrates with PrinterManager for advanced printer management
 * while maintaining backward compatibility with legacy direct printing.
 *
 * Requirements: 2.4, 9.2
 */

import Database from 'better-sqlite3';
import { getWaiterShiftData } from './helpers/ShiftHelpers';
import { ShiftSummary } from '../../renderer/types/shift';
import {
  generateKitchenCheckoutReceipt,
  generateKitchenCheckoutReceiptBuffer
} from '../templates/kitchen-checkout-template';
import {
  generateDriverCheckoutReceipt,
  generateDriverCheckoutReceiptBuffer
} from '../templates/driver-checkout-template';
import {
  generateCashierCheckoutReceipt,
  generateCashierCheckoutReceiptBuffer
} from '../templates/cashier-checkout-template';
import {
  generateZReportReceipt,
  generateZReportReceiptBuffer
} from '../templates/z-report-template';
import {
  generateWaiterCheckoutReceipt,
  generateWaiterCheckoutReceiptBuffer
} from '../templates/waiter-checkout-template';
import {
  generateAssignOrderReceipt,
  generateAssignOrderReceiptBuffer,
  AssignOrderData
} from '../templates/assign-order-template';
import net from 'net';
import { nativeImage, app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { SettingsService } from './SettingsService';
import { PrinterManager } from '../printer/services/PrinterManager';
import { PrintJob, PrintJobType, PrinterRole, PaperSize } from '../printer/types';
import { v4 as uuidv4 } from 'uuid';


export class PrintService {
  private printerManager: PrinterManager | null = null;

  constructor(private dbOrSettings: Database.Database | SettingsService) { }

  /**
   * Set the PrinterManager instance for advanced printer management
   * When set, print jobs will be routed through PrinterManager
   *
   * @param manager - The PrinterManager instance or null to disable
   */
  setPrinterManager(manager: PrinterManager | null): void {
    this.printerManager = manager;
    if (manager) {
      console.log('[PrintService] PrinterManager integration enabled');
    } else {
      console.log('[PrintService] PrinterManager integration disabled, using legacy printing');
    }
  }

  /**
   * Check if PrinterManager is available and has configured printers
   * @returns true if PrinterManager should be used for printing
   */
  private shouldUsePrinterManager(): boolean {
    if (!this.printerManager) return false;

    // Check if there are any enabled printers configured
    const printers = this.printerManager.getPrinters();
    return printers.some(p => p.enabled);
  }

  /**
   * Submit a print job through PrinterManager
   * @param jobType - The type of print job
   * @param data - The print job data
   * @param rawEscPos - Optional raw ESC/POS buffer for legacy compatibility
   * @returns Print result
   */
  private async submitToPrinterManager(
    jobType: PrintJobType,
    data: any,
    rawEscPos?: Buffer
  ): Promise<{ success: boolean; error?: string }> {
    if (!this.printerManager) {
      return { success: false, error: 'PrinterManager not available' };
    }

    try {
      const job: PrintJob = {
        id: uuidv4(),
        type: jobType,
        data: rawEscPos ? { buffer: rawEscPos, type: 'raw' } : data,
        priority: 5,
        createdAt: new Date(),
      };

      const result = await this.printerManager.submitPrintJob(job);
      return {
        success: result.success,
        error: result.error,
      };
    } catch (error) {
      console.error('[PrintService] Error submitting to PrinterManager:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to submit print job',
      };
    }
  }
  // Generic local setting reader with JSON parsing and default fallback
  private getSetting<T = any>(category: string, key: string, defaultValue: T): T {
    try {
      // If constructed with SettingsService, use it for reads
      if ((this.dbOrSettings as any)?.getSetting) {
        const svc = this.dbOrSettings as SettingsService;
        const val = svc.getSetting<T>(category as any, key, defaultValue);
        return (val === null || val === undefined) ? defaultValue : (val as T);
      }

      const db = this.dbOrSettings as Database.Database;
      const row = db
        .prepare(`SELECT setting_value FROM local_settings WHERE setting_category = ? AND setting_key = ?`)
        .get(category, key) as any;
      if (!row?.setting_value) return defaultValue;
      try {
        return JSON.parse(row.setting_value) as T;
      } catch {
        // in case plain values were stored without JSON.stringify
        return (row.setting_value as unknown as T) ?? defaultValue;
      }
    } catch {
      return defaultValue;
    }
  }

  private getPrinterConfig() {
    const paper_size = this.getSetting<string>('printer', 'paper_size', '80mm');
    const printer_type = this.getSetting<string>('printer', 'printer_type', 'network');
    const printer_ip = this.getSetting<string>('printer', 'printer_ip', '') || this.getSetting<string>('printer', 'receipt_printer_ip', '');
    const printer_port = this.getSetting<number>('printer', 'printer_port', 9100) || this.getSetting<number>('printer', 'receipt_printer_port', 9100);
    const copy_count = Math.max(1, Number(this.getSetting<number>('printer', 'copy_count', 1) || 1));
    const print_logo = Boolean(this.getSetting<boolean>('printer', 'print_logo', true));
    const print_order_number = Boolean(this.getSetting<boolean>('printer', 'print_order_number', true));
    const print_date_time = Boolean(this.getSetting<boolean>('printer', 'print_date_time', true));

    // Additional fields for USB/Bluetooth via OS spooler
    const printer_system_name = this.getSetting<string>('printer', 'printer_system_name', '');
    const printer_path = this.getSetting<string>('printer', 'printer_path', '');
    const printer_bluetooth_address = this.getSetting<string>('printer', 'printer_bluetooth_address', '');
    const printer_discovery_mode = this.getSetting<string>('printer', 'printer_discovery_mode', 'auto');

    return {
      paper_size,
      printer_type,
      printer_ip,
      printer_port,
      copy_count,
      print_logo,
      print_order_number,
      print_date_time,
      printer_system_name,
      printer_path,
      printer_bluetooth_address,
      printer_discovery_mode,
    };
  }

  private getReceiptConfig() {
    const show_logo = Boolean(this.getSetting<boolean>('receipt', 'show_logo', true));
    const logo_url = this.getSetting<string | undefined>('receipt', 'logo_url', undefined);
    const header_text = this.getSetting<string>('receipt', 'header_text', '')?.trim?.() || '';
    const footer_text = this.getSetting<string>('receipt', 'footer_text', '')?.trim?.() || '';
    const print_customer_copy = Boolean(this.getSetting<boolean>('receipt', 'print_customer_copy', false));
    const print_merchant_copy = Boolean(this.getSetting<boolean>('receipt', 'print_merchant_copy', false));
    // Mirrored/legacy width
    const receipt_width = this.getSetting<string>('receipt', 'receipt_width', this.getSetting<string>('printer', 'paper_size', '80mm'));
    const font_size = this.getSetting<'small' | 'medium' | 'large'>('receipt', 'font_size', 'medium');
    return { show_logo, logo_url, header_text, footer_text, receipt_width, font_size, print_customer_copy, print_merchant_copy };
  }

  private mapPaperToPixels(size: string): number {
    if (size === '58mm') return 384;  // ~48mm printable at 8 dots/mm
    if (size === '112mm') return 832; // wide printers
    return 576; // 80mm
  }

  private async fetchNativeImageFromUrl(url: string): Promise<Electron.NativeImage | null> {
    // Cached download to avoid re-fetching the logo on every print
    try {
      const cacheDir = path.join(app.getPath('userData'), 'print-cache');
      try { fs.mkdirSync(cacheDir, { recursive: true }); } catch { }
      const hash = crypto.createHash('sha1').update(url).digest('hex');
      const cachePath = path.join(cacheDir, `logo-${hash}.bin`);

      // Try cache first
      if (fs.existsSync(cachePath)) {
        const cachedImg = nativeImage.createFromPath(cachePath);
        if (!cachedImg.isEmpty()) return cachedImg;
      }

      // Fetch and cache
      const res = await fetch(url);
      if (!res || !(res as any).ok) throw new Error('HTTP fetch failed');
      const ab = await (res as any).arrayBuffer();
      const buf = Buffer.from(ab);
      try { fs.writeFileSync(cachePath, buf); } catch { }
      const img = nativeImage.createFromBuffer(buf);
      if (img.isEmpty()) return null;
      return img;
    } catch (e) {
      console.warn('[PrintService] fetchNativeImageFromUrl failed', e);
      // Fallback to cache if present
      try {
        const cacheDir = path.join(app.getPath('userData'), 'print-cache');
        const hash = crypto.createHash('sha1').update(url).digest('hex');
        const cachePath = path.join(cacheDir, `logo-${hash}.bin`);
        if (fs.existsSync(cachePath)) {
          const cachedImg = nativeImage.createFromPath(cachePath);
          if (!cachedImg.isEmpty()) return cachedImg;
        }
      } catch { }
      return null;
    }
  }

  // Floyd–Steinberg dithering to 1-bit, then pack into ESC/POS raster format (GS v 0)
  private buildRasterFromImage(img: Electron.NativeImage, targetWidth: number): Buffer {
    // Resize keeping aspect ratio
    const resized = img.resize({ width: targetWidth, quality: 'best' });
    const { width, height } = resized.getSize();
    const bmp = resized.toBitmap(); // BGRA

    // Convert to grayscale + dithering
    const gray: number[] = new Array(width * height);
    for (let i = 0; i < width * height; i++) {
      const b = bmp[i * 4 + 0];
      const g = bmp[i * 4 + 1];
      const r = bmp[i * 4 + 2];
      // luminance
      gray[i] = 0.299 * r + 0.587 * g + 0.114 * b;
    }

    const data = gray.slice();
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        const old = data[i];
        const newVal = old < 128 ? 0 : 255;
        const err = old - newVal;
        data[i] = newVal;
        // Diffuse error
        const diffuse = (dx: number, dy: number, factor: number) => {
          const nx = x + dx, ny = y + dy;
          if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
            data[ny * width + nx] = Math.max(0, Math.min(255, data[ny * width + nx] + err * factor));
          }
        };
        diffuse(1, 0, 7 / 16);
        diffuse(-1, 1, 3 / 16);
        diffuse(0, 1, 5 / 16);
        diffuse(1, 1, 1 / 16);
      }
    }

    const bytesPerRow = Math.ceil(width / 8);
    const raster = Buffer.alloc(bytesPerRow * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        const byteIndex = y * bytesPerRow + (x >> 3);
        const bit = 7 - (x & 7);
        const isBlack = data[i] === 0; // 0 -> black
        if (isBlack) raster[byteIndex] |= (1 << bit);
      }
    }

    // ESC/POS raster bit image (GS v 0)
    const xL = bytesPerRow & 0xff;
    const xH = (bytesPerRow >> 8) & 0xff;
    const yL = height & 0xff;
    const yH = (height >> 8) & 0xff;

    return Buffer.concat([
      Buffer.from([0x1D, 0x76, 0x30, 0x00, xL, xH, yL, yH]),
      raster,
    ]);
  }

  // Send ESC/POS data to an OS-installed printer via system spooler (USB/Bluetooth/System)
  private async sendEscPosToSystemPrinter(systemName: string | undefined, data: Buffer): Promise<void> {
    try {
      // Lazy require to avoid import errors when module is missing
      // Defer resolving to runtime so webpack doesn't try to bundle it
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      const nodeReq: any = (0, eval)('require');
      const printerLib: any = nodeReq('printer');
      await new Promise<void>((resolve, reject) => {
        try {
          printerLib.printDirect({
            data,
            printer: systemName || undefined,
            type: 'RAW', // send raw ESC/POS
            success: () => resolve(),
            error: (err: any) => reject(err),
          });
        } catch (e) {
          reject(e);
        }
      });
    } catch (e) {
      const msg = (e instanceof Error ? e.message : String(e));
      throw new Error(`System printer send failed${systemName ? ` (${systemName})` : ''}: ${msg}`);
    }
  }

  // Route a single job to the configured printer based on printer_type
  private async sendJobToConfiguredPrinter(job: Buffer): Promise<void> {
    const printer = this.getPrinterConfig();
    console.log('[PrintService] sendJobToConfiguredPrinter - printer config:', {
      printer_type: printer.printer_type,
      printer_ip: printer.printer_ip || '(not set)',
      printer_system_name: printer.printer_system_name || '(not set)',
      printer_port: printer.printer_port
    });

    if (printer.printer_type === 'network') {
      if (!printer.printer_ip) {
        // Fallback to system printer if available
        if (printer.printer_system_name) {
          console.log('[PrintService] Network IP not configured, falling back to system printer:', printer.printer_system_name);
          await this.sendEscPosToSystemPrinter(printer.printer_system_name, job);
          return;
        }
        throw new Error('Network printer IP not configured. Please configure printer IP in Settings → Printer, or select a USB printer.');
      }
      await this.sendEscPosToNetwork(printer.printer_ip, Number(printer.printer_port || 9100), job);
      return;
    }
    if (printer.printer_type === 'usb' || printer.printer_type === 'bluetooth') {
      if (!printer.printer_system_name) {
        throw new Error('No system printer selected. Please choose a printer in Printer Settings (Auto mode).');
      }
      await this.sendEscPosToSystemPrinter(printer.printer_system_name, job);
      return;
    }
    throw new Error('Printer type not configured. Please configure printer in Settings → Printer.');
  }

  // Print labeled copies and generic copy_count using the configured transport
  private async printWithCopies(txtReceipt: string, baseJob: Buffer | null): Promise<void> {
    const printer = this.getPrinterConfig();
    const receiptCfg = this.getReceiptConfig();
    if (!baseJob) return;

    // Labeled copies (optional)
    if (receiptCfg.print_customer_copy) {
      const labeled = await this.buildEscPosJob(txtReceipt, 'customer');
      if (labeled) await this.sendJobToConfiguredPrinter(labeled);
    }
    if (receiptCfg.print_merchant_copy) {
      const labeled = await this.buildEscPosJob(txtReceipt, 'merchant');
      if (labeled) await this.sendJobToConfiguredPrinter(labeled);
    }

    // Generic copies
    for (let i = 0; i < (printer.copy_count || 1); i++) {
      await this.sendJobToConfiguredPrinter(baseJob);
    }
  }

  /**
   * Print ESC/POS Buffer directly with configured copy count
   * 
   * Used by Buffer-based templates that already contain full ESC/POS formatting.
   * Sends the buffer directly to the printer without additional processing.
   * 
   * @param buffer - Pre-formatted ESC/POS buffer from template generators
   */
  private async printBufferWithCopies(buffer: Buffer): Promise<void> {
    const printer = this.getPrinterConfig();

    console.log('[PrintService] printBufferWithCopies called');
    console.log('[PrintService] Buffer size:', buffer.length, 'bytes');
    console.log('[PrintService] Copy count:', printer.copy_count || 1);

    // Send buffer for each configured copy
    for (let i = 0; i < (printer.copy_count || 1); i++) {
      console.log(`[PrintService] Sending copy ${i + 1}/${printer.copy_count || 1} to printer`);
      await this.sendJobToConfiguredPrinter(buffer);
    }

    console.log('[PrintService] printBufferWithCopies completed');
  }

  private buildText(text: string): Buffer {
    // Ensure LF endings
    const normalized = text.replace(/\r\n/g, '\n');
    return Buffer.from(normalized, 'utf8');
  }

  private async sendEscPosToNetwork(ip: string, port: number, data: Buffer): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const socket = new net.Socket();
      socket.setTimeout(10000);
      socket.once('error', reject);
      socket.once('timeout', () => reject(new Error('Printer connection timeout')));
      socket.connect(port, ip, () => {
        socket.write(data, (err) => {
          if (err) return reject(err);
          socket.end(() => resolve());
        });
      });
    });
  }

  private applyReceiptToggles(receipt: string, opts: { includeDateTime: boolean; includeOrderNumber: boolean }): string {
    let out = receipt;
    if (!opts.includeDateTime) {
      // Remove lines that look like MM/DD/YYYY or HH:MM AM/PM centered
      out = out
        .split('\n')
        .filter((line) => !/^\s*\d{2}\/\d{2}\/\d{4}\s*$/.test(line) && !/^\s*\d{1,2}:\d{2}\s*(AM|PM)\s*$/.test(line))
        .join('\n');
    }
    if (!opts.includeOrderNumber) {
      // Hide leading order number column like "12345| "
      out = out
        .split('\n')
        .map((line) => line.replace(/^\s*#?\d+\s*\|\s/, '     | '))
        .join('\n');
    }
    return out;
  }

  private async buildEscPosJob(receipt: string, copyType?: 'customer' | 'merchant'): Promise<Buffer | null> {
    const printer = this.getPrinterConfig();
    const receiptCfg = this.getReceiptConfig();

    // Apply content toggles (date/time, order no.)
    const processedText = this.applyReceiptToggles(receipt, {
      includeDateTime: printer.print_date_time,
      includeOrderNumber: printer.print_order_number,
    });

    const chunks: Buffer[] = [];
    // Init + center
    chunks.push(Buffer.from([0x1B, 0x40])); // ESC @
    chunks.push(Buffer.from([0x1B, 0x61, 0x01])); // ESC a 1 (center)

    const canShowLogo = printer.print_logo && receiptCfg.show_logo && !!receiptCfg.logo_url;
    if (canShowLogo && receiptCfg.logo_url) {
      const px = this.mapPaperToPixels(printer.paper_size);
      const img = await this.fetchNativeImageFromUrl(receiptCfg.logo_url);
      if (img) {
        try { chunks.push(this.buildRasterFromImage(img, px)); chunks.push(Buffer.from('\n')); } catch (e) { console.warn('[PrintService] Logo raster failed', e); }
      }
    }

    // Header text (centered)
    if (receiptCfg.header_text) {
      chunks.push(Buffer.from([0x1B, 0x61, 0x01])); // center
      chunks.push(this.buildText(receiptCfg.header_text + '\n'));
      chunks.push(Buffer.from('\n'));
    }

    // Copy label (centered)
    if (copyType) {
      chunks.push(Buffer.from([0x1B, 0x61, 0x01]));
      const label = copyType === 'customer' ? '*** CUSTOMER COPY ***' : '*** MERCHANT COPY ***';
      chunks.push(this.buildText(label + '\n'));
      chunks.push(Buffer.from('\n'));
    }

    // Switch to left for body
    chunks.push(Buffer.from([0x1B, 0x61, 0x00])); // left
    chunks.push(this.buildText(processedText));

    // Footer (centered)
    if (receiptCfg.footer_text) {
      chunks.push(Buffer.from('\n'));
      chunks.push(Buffer.from([0x1B, 0x61, 0x01]));
      chunks.push(this.buildText(receiptCfg.footer_text + '\n'));
    }

    // Feed and cut
    chunks.push(Buffer.from('\n\n\n'));
    chunks.push(Buffer.from([0x1D, 0x56, 0x41, 0x10])); // partial cut

    return Buffer.concat(chunks);
  }


  /**
   * Print kitchen staff checkout slip
   *
   * Uses ESC/POS formatted Buffer templates for professional thermal printing.
   * Routes through PrinterManager when available, falls back to direct printing.
   * Requirements: 2.4, 9.2
   */
  async printKitchenCheckout(shiftSummary: ShiftSummary, terminalName?: string): Promise<{ success: boolean; error?: string }> {
    try {
      // Generate ESC/POS formatted receipt buffer
      const config = this.getReceiptConfigForTemplates(terminalName);
      const receiptBuffer = generateKitchenCheckoutReceiptBuffer(shiftSummary, {
        paperSize: config.paperSize as PaperSize,
        language: config.language,
        currency: config.currency,
        terminalName: config.terminalName,
        receiptTemplate: config.receiptTemplate,
      });

      // Log legacy text version for debugging
      const width = this.getPaperCharWidth();
      const txtReceipt = generateKitchenCheckoutReceipt(shiftSummary, terminalName, width);
      console.log('=== KITCHEN CHECKOUT PRINT ===');
      console.log(txtReceipt);
      console.log('=== END KITCHEN CHECKOUT ===');

      // Try PrinterManager first if available
      if (this.shouldUsePrinterManager()) {
        const result = await this.submitToPrinterManager(
          PrintJobType.KITCHEN_TICKET,
          { shiftSummary, terminalName },
          receiptBuffer
        );
        if (result.success) return result;
        console.warn('[PrintService] PrinterManager failed, falling back to direct printing:', result.error);
      }

      // Direct printing path - send buffer with copies
      await this.printBufferWithCopies(receiptBuffer);
      return { success: true };
    } catch (error) {
      console.error('Error printing kitchen checkout:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to print kitchen checkout'
      };
    }
  }

  /**
   * Print driver checkout slip
   *
   * Uses ESC/POS formatted Buffer templates for professional thermal printing.
   * Routes through PrinterManager when available, falls back to direct printing.
   * Requirements: 2.4, 9.2
   */
  async printDriverCheckout(shiftSummary: ShiftSummary, terminalName?: string): Promise<{ success: boolean; error?: string }> {
    try {
      // Generate ESC/POS formatted receipt buffer
      const config = this.getReceiptConfigForTemplates(terminalName);
      const receiptBuffer = generateDriverCheckoutReceiptBuffer(shiftSummary, {
        paperSize: config.paperSize as PaperSize,
        language: config.language,
        currency: config.currency,
        terminalName: config.terminalName,
        receiptTemplate: config.receiptTemplate,
      });

      // Log legacy text version for debugging
      const width = this.getPaperCharWidth();
      const txtReceipt = generateDriverCheckoutReceipt(shiftSummary, terminalName, width);
      console.log('=== DRIVER CHECKOUT PRINT ===');
      console.log(txtReceipt);
      console.log('=== END DRIVER CHECKOUT ===');

      // Try PrinterManager first if available
      if (this.shouldUsePrinterManager()) {
        const result = await this.submitToPrinterManager(
          PrintJobType.RECEIPT,
          { shiftSummary, terminalName },
          receiptBuffer
        );
        if (result.success) return result;
        console.warn('[PrintService] PrinterManager failed, falling back to direct printing:', result.error);
      }

      // Direct printing path - send buffer with copies
      await this.printBufferWithCopies(receiptBuffer);
      return { success: true };
    } catch (error) {
      console.error('Error printing driver checkout:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to print driver checkout'
      };
    }
  }

  /**
   * Print cashier checkout report
   *
   * Uses ESC/POS formatted Buffer templates for professional thermal printing.
   * Routes through PrinterManager when available, falls back to direct printing.
   * Requirements: 2.4, 9.2
   */
  async printCashierCheckout(shiftSummary: ShiftSummary, terminalName?: string): Promise<{ success: boolean; error?: string }> {
    try {
      console.log('[PrintService] printCashierCheckout called');

      // Generate ESC/POS formatted receipt buffer
      const config = this.getReceiptConfigForTemplates(terminalName);
      console.log('[PrintService] Template config:', JSON.stringify(config));

      const receiptBuffer = generateCashierCheckoutReceiptBuffer(shiftSummary, {
        paperSize: config.paperSize as PaperSize,
        language: config.language,
        currency: config.currency,
        terminalName: config.terminalName,
        receiptTemplate: config.receiptTemplate,
      });

      console.log('[PrintService] Generated ESC/POS buffer, size:', receiptBuffer.length, 'bytes');

      // Log legacy text version for debugging
      const width = this.getPaperCharWidth();
      const txtReceipt = generateCashierCheckoutReceipt(shiftSummary, terminalName, width);
      console.log('=== CASHIER CHECKOUT PRINT (Legacy Text) ===');
      console.log(txtReceipt);
      console.log('=== END CASHIER CHECKOUT ===');

      // Try PrinterManager first if available
      if (this.shouldUsePrinterManager()) {
        console.log('[PrintService] Using PrinterManager path for cashier checkout');
        const result = await this.submitToPrinterManager(
          PrintJobType.RECEIPT,
          { shiftSummary, terminalName },
          receiptBuffer
        );
        if (result.success) {
          console.log('[PrintService] PrinterManager succeeded for cashier checkout');
          return result;
        }
        console.warn('[PrintService] PrinterManager failed, falling back to direct printing:', result.error);
      } else {
        console.log('[PrintService] Using direct printing path for cashier checkout');
      }

      // Direct printing path - send buffer with copies
      console.log('[PrintService] Calling printBufferWithCopies for cashier checkout');
      await this.printBufferWithCopies(receiptBuffer);
      console.log('[PrintService] printCashierCheckout completed successfully');
      return { success: true };
    } catch (error) {
      console.error('Error printing cashier checkout:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to print cashier checkout'
      };
    }
  }
  /**
   * Print Z Report (snapshot already computed)
   *
   * Uses ESC/POS formatted Buffer templates for professional thermal printing.
   * Routes through PrinterManager when available, falls back to direct printing.
   * Requirements: 2.4, 9.2
   */
  async printZReport(snapshot: any, terminalName?: string): Promise<{ success: boolean; error?: string }> {
    try {
      console.log('[PrintService] printZReport called');

      // Generate ESC/POS formatted receipt buffer
      const config = this.getReceiptConfigForTemplates(terminalName);
      console.log('[PrintService] Z-Report template config:', JSON.stringify(config));

      const receiptBuffer = generateZReportReceiptBuffer(snapshot, {
        paperSize: config.paperSize as PaperSize,
        language: config.language,
        currency: config.currency,
        terminalName: config.terminalName,
        receiptTemplate: config.receiptTemplate,
      });

      console.log('[PrintService] Generated Z-Report ESC/POS buffer, size:', receiptBuffer.length, 'bytes');

      // Log legacy text version for debugging
      const width = this.getPaperCharWidth();
      const txtReceipt = generateZReportReceipt(snapshot, terminalName, width);
      console.log('=== Z REPORT PRINT (Legacy Text) ===');
      console.log(txtReceipt);
      console.log('=== END Z REPORT ===');

      // Try PrinterManager first if available
      if (this.shouldUsePrinterManager()) {
        console.log('[PrintService] Using PrinterManager path for Z-Report');
        const result = await this.submitToPrinterManager(
          PrintJobType.REPORT,
          { snapshot, terminalName },
          receiptBuffer
        );
        if (result.success) {
          console.log('[PrintService] PrinterManager succeeded for Z-Report');
          return result;
        }
        console.warn('[PrintService] PrinterManager failed, falling back to direct printing:', result.error);
      } else {
        console.log('[PrintService] Using direct printing path for Z-Report');
      }

      // Direct printing path - send buffer with copies
      console.log('[PrintService] Calling printBufferWithCopies for Z-Report');
      await this.printBufferWithCopies(receiptBuffer);
      console.log('[PrintService] printZReport completed successfully');
      return { success: true };
    } catch (error) {
      console.error('Error printing Z report:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to print Z report' };
    }
  }

  /**
   * Print a simple test receipt to verify printer configuration
   *
   * Uses PrinterManager for job routing when available, falls back to legacy printing.
   * Requirements: 2.4, 10.1
   */
  async printTestReceipt(): Promise<{ success: boolean; error?: string }> {
    try {
      const width = this.getPaperCharWidth();
      const wLine = (ch = '-') => ch.repeat(width);
      const center = (text: string) => {
        const pad = Math.max(0, Math.floor((width - text.length) / 2));
        return ' '.repeat(pad) + text + '\n';
      };

      const paper = this.getSetting<string>('printer', 'paper_size', '80mm');
      const txtReceipt = [
        center('*** TEST PRINT ***'),
        wLine(),
        `Paper: ${paper}  Width: ${width} chars`,
        'Logo/Header/Footer toggles will apply if enabled.',
        wLine(),
        'Item           Qty   Price',
        'Sample Item A   1    2.50',
        'Sample Item B   2    5.00',
        wLine('='),
        'Total                 7.50',
        '\n'
      ].join('\n');

      console.log('=== TEST PRINT ===');
      console.log(txtReceipt);
      console.log('=== END TEST PRINT ===');

      // Try PrinterManager first if available
      if (this.shouldUsePrinterManager()) {
        const job = await this.buildEscPosJob(txtReceipt);
        if (job) {
          const result = await this.submitToPrinterManager(
            PrintJobType.TEST,
            { text: txtReceipt },
            job
          );
          if (result.success) return result;
          console.warn('[PrintService] PrinterManager failed, falling back to legacy printing:', result.error);
        }
      }

      // Legacy printing path
      const job = await this.buildEscPosJob(txtReceipt);
      if (job) {
        await this.printWithCopies(txtReceipt, job);
      }

      return { success: true };
    } catch (error) {
      console.error('Error printing test receipt:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to print test receipt' };
    }
  }



  /**
   * Print checkout based on role type
   */
  async printCheckout(
    shiftId: string,
    roleType: 'cashier' | 'driver' | 'kitchen' | 'manager' | 'server',
    terminalName?: string
  ): Promise<{ success: boolean; error?: string }> {
    try {
      console.log(`[PrintService] printCheckout called - shiftId: ${shiftId}, roleType: ${roleType}`);

      // Get shift summary
      const shiftSummary = this.getShiftSummary(shiftId);

      if (!shiftSummary) {
        console.error(`[PrintService] Shift not found for id: ${shiftId}`);
        return { success: false, error: 'Shift not found' };
      }

      console.log(`[PrintService] Shift summary found, staff_id: ${shiftSummary.shift?.staff_id}, role: ${shiftSummary.shift?.role_type}`);

      // Print based on role
      switch (roleType) {
        case 'cashier':
        case 'manager':
          console.log('[PrintService] Routing to printCashierCheckout');
          return await this.printCashierCheckout(shiftSummary, terminalName);

        case 'driver':
          console.log('[PrintService] Routing to printDriverCheckout');
          return await this.printDriverCheckout(shiftSummary, terminalName);

        case 'kitchen':
          console.log('[PrintService] Routing to printKitchenCheckout');
          return await this.printKitchenCheckout(shiftSummary, terminalName);

        case 'server':
          console.log('[PrintService] Routing to printWaiterCheckout');
          return await this.printWaiterCheckout(shiftSummary, terminalName);

        default:
          console.error(`[PrintService] Unknown role type: ${roleType}`);
          return { success: false, error: `Unknown role type: ${roleType}` };
      }
    } catch (error) {
      console.error('[PrintService] Error in printCheckout:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to print checkout'
      };
    }
  }

  /**
   * Print waiter checkout receipt
   * 
   * Uses ESC/POS formatted Buffer templates for professional thermal printing.
   * Routes through PrinterManager when available, falls back to direct printing.
   * Requirements: 2.4, 9.2
   */
  async printWaiterCheckout(shiftSummary: ShiftSummary, terminalName?: string): Promise<{ success: boolean; error?: string }> {
    try {
      // Generate ESC/POS formatted receipt buffer
      const config = this.getReceiptConfigForTemplates(terminalName);
      const receiptBuffer = generateWaiterCheckoutReceiptBuffer(shiftSummary, {
        paperSize: config.paperSize as PaperSize,
        language: config.language,
        currency: config.currency,
        terminalName: config.terminalName,
        receiptTemplate: config.receiptTemplate,
      });

      // Log legacy text version for debugging
      const width = this.getPaperCharWidth();
      const txtReceipt = generateWaiterCheckoutReceipt(shiftSummary, terminalName, width);
      console.log('=== WAITER CHECKOUT PRINT ===');
      console.log(txtReceipt);
      console.log('=== END WAITER CHECKOUT ===');

      // Try PrinterManager first if available
      if (this.shouldUsePrinterManager()) {
        const result = await this.submitToPrinterManager(
          PrintJobType.RECEIPT,
          { shiftSummary, terminalName },
          receiptBuffer
        );
        if (result.success) return result;
        console.warn('[PrintService] PrinterManager failed, falling back to direct printing:', result.error);
      }

      // Direct printing path - send buffer with copies
      await this.printBufferWithCopies(receiptBuffer);
      return { success: true };
    } catch (error) {
      console.error('Error printing waiter checkout:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to print waiter checkout'
      };
    }
  }

  /**
   * Print driver assignment receipt when an order is assigned to a driver
   *
   * Uses ESC/POS formatted Buffer templates for professional thermal printing.
   * Supports Greek language for i18n.
   */
  async printDriverAssignmentReceipt(
    data: AssignOrderData,
    terminalName?: string
  ): Promise<{ success: boolean; error?: string }> {
    try {
      console.log('[PrintService] printDriverAssignmentReceipt called for order:', data.orderNumber);

      // Generate ESC/POS formatted receipt buffer
      const config = this.getReceiptConfigForTemplates(terminalName);
      console.log('[PrintService] Receipt config for driver assignment:', JSON.stringify(config));
      const receiptBuffer = generateAssignOrderReceiptBuffer(data, {
        paperSize: config.paperSize as PaperSize,
        language: config.language,
        currency: config.currency,
        terminalName: config.terminalName,
        receiptTemplate: config.receiptTemplate,
      });

      console.log('[PrintService] Generated driver assignment receipt, size:', receiptBuffer.length, 'bytes');

      // Log legacy text version for debugging
      const width = this.getPaperCharWidth();
      const txtReceipt = generateAssignOrderReceipt(data, terminalName, width);
      console.log('=== DRIVER ASSIGNMENT PRINT ===');
      console.log(txtReceipt);
      console.log('=== END DRIVER ASSIGNMENT ===');

      // Try PrinterManager first if available
      if (this.shouldUsePrinterManager()) {
        console.log('[PrintService] Using PrinterManager path for driver assignment receipt');
        const result = await this.submitToPrinterManager(
          PrintJobType.RECEIPT,
          { data, terminalName },
          receiptBuffer
        );
        if (result.success) {
          console.log('[PrintService] PrinterManager succeeded for driver assignment receipt');
          return result;
        }
        console.warn('[PrintService] PrinterManager failed, falling back to direct printing:', result.error);
      }

      // Direct printing path - send buffer with copies
      await this.printBufferWithCopies(receiptBuffer);
      console.log('[PrintService] printDriverAssignmentReceipt completed successfully');
      return { success: true };
    } catch (error) {
      console.error('Error printing driver assignment receipt:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to print driver assignment receipt'
      };
    }
  }

  /**
   * Get shift summary from database
   */
  private getShiftSummary(shiftId: string): ShiftSummary | null {
    try {
      const db = this.dbOrSettings as Database.Database;
      // Get shift data
      const shift = db.prepare('SELECT * FROM staff_shifts WHERE id = ?').get(shiftId) as any;
      if (!shift) return null;

      // Get cash drawer
      const cashDrawer = db.prepare('SELECT * FROM cash_drawer_sessions WHERE staff_shift_id = ?').get(shiftId) as any;

      // Get expenses
      const expenses = db.prepare('SELECT * FROM shift_expenses WHERE staff_shift_id = ?').all(shiftId) as any[];

      // Get staff payments
      const staffPayments = db.prepare(`
        SELECT
          e.id, e.staff_id, e.amount, e.description, e.created_at,
          (SELECT staff_name FROM staff_shifts s WHERE s.staff_id = e.staff_id ORDER BY s.check_in_time DESC LIMIT 1) as staff_name,
          (SELECT role_type FROM staff_shifts s WHERE s.staff_id = e.staff_id ORDER BY s.check_in_time DESC LIMIT 1) as role_type,
          (SELECT check_in_time FROM staff_shifts s WHERE s.staff_id = e.staff_id ORDER BY s.check_in_time DESC LIMIT 1) as check_in_time,
          (SELECT check_out_time FROM staff_shifts s WHERE s.staff_id = e.staff_id ORDER BY s.check_in_time DESC LIMIT 1) as check_out_time
        FROM shift_expenses e
        WHERE e.staff_shift_id = ? AND e.expense_type = 'staff_payment'
        ORDER BY e.created_at DESC
      `).all(shiftId) as any[];

      // Get driver deliveries
      const driverDeliveries = db.prepare(`
        SELECT
          de.id, de.order_id, de.delivery_fee, de.tip_amount, de.total_earning,
          de.payment_method, de.cash_collected, de.card_amount,
          o.order_number, o.customer_name, o.delivery_address, o.total_amount
        FROM driver_earnings de
        LEFT JOIN orders o ON de.order_id = o.id
        WHERE de.staff_shift_id = ?
          ORDER BY de.created_at DESC
      `).all(shiftId) as any[];

      // Get waiter tables summary if role is server
      let waiterTables: any[] = [];
      const shiftRole = (shift as any).role_type || '';
      if (shiftRole === 'server') {
        waiterTables = getWaiterShiftData(db, shiftId);
      }

      // Get breakdown - use status-based filtering for consistency
      const breakdownRows = db.prepare(`
        SELECT order_type as type, payment_method as method,
               COUNT(*) as count, COALESCE(SUM(total_amount), 0) as total
        FROM orders
        WHERE staff_shift_id = ? AND status IN ('delivered', 'completed')
        GROUP BY order_type, payment_method
      `).all(shiftId) as any[];

      const toNumber = (v: any) => (typeof v === 'number' && isFinite(v) ? v : 0);
      const sumBy = (cond: (r: any) => boolean) => breakdownRows.filter(cond).reduce((s, r) => s + toNumber(r.total), 0);
      const countBy = (cond: (r: any) => boolean) => breakdownRows.filter(cond).reduce((s, r) => s + (r.count || 0), 0);

      const instoreTypes = ['dine-in', 'takeaway', 'pickup'];
      const isInstore = (t: string) => instoreTypes.includes(t);

      const breakdown = {
        instore: {
          cashTotal: sumBy(r => isInstore(r.type) && r.method === 'cash'),
          cardTotal: sumBy(r => isInstore(r.type) && r.method === 'card'),
          cashCount: countBy(r => isInstore(r.type) && r.method === 'cash'),
          cardCount: countBy(r => isInstore(r.type) && r.method === 'card'),
        },
        delivery: {
          cashTotal: sumBy(r => r.type === 'delivery' && r.method === 'cash'),
          cardTotal: sumBy(r => r.type === 'delivery' && r.method === 'card'),
          cashCount: countBy(r => r.type === 'delivery' && r.method === 'cash'),
          cardCount: countBy(r => r.type === 'delivery' && r.method === 'card'),
        },
        overall: {
          cashTotal: sumBy(r => r.method === 'cash'),
          cardTotal: sumBy(r => r.method === 'card'),
          totalCount: countBy(_ => true),
          totalAmount: sumBy(_ => true)
        }
      };

      // Get cash refunds
      const cashRefunds = (db.prepare(`
        SELECT COALESCE(SUM(total_amount), 0) as total
        FROM orders
        WHERE staff_shift_id = ? AND status = 'refunded' AND payment_method = 'cash'
      `).get(shiftId) as any)?.total || 0;

      // Get canceled orders
      const canceledRows = db.prepare(`
        SELECT payment_method as method,
               COUNT(*) as count, COALESCE(SUM(total_amount), 0) as total
        FROM orders
        WHERE staff_shift_id = ? AND status = 'canceled'
        GROUP BY payment_method
      `).all(shiftId) as any[];

      const canceledOrders = {
        cashTotal: (canceledRows.find(r => r.method === 'cash')?.total || 0),
        cardTotal: (canceledRows.find(r => r.method === 'card')?.total || 0),
        cashCount: (canceledRows.find(r => r.method === 'cash')?.count || 0),
        cardCount: (canceledRows.find(r => r.method === 'card')?.count || 0),
      };

      return {
        shift: {
          ...shift,
          is_day_start: Boolean(shift.is_day_start)
        },
        cashDrawer: cashDrawer ? {
          ...cashDrawer,
          reconciled: Boolean(cashDrawer.reconciled)
        } : undefined,
        expenses: expenses || [],
        staffPayments: staffPayments || [],
        totalExpenses: expenses.filter(e => e.expense_type !== 'staff_payment').reduce((sum, e) => sum + e.amount, 0),
        ordersCount: breakdown.overall.totalCount,
        salesAmount: breakdown.overall.totalAmount,
        breakdown,
        cashRefunds,
        canceledOrders,
        driverDeliveries: driverDeliveries || [],
        waiterTables: waiterTables.length > 0 ? waiterTables : undefined
      };
    } catch (error) {
      console.error('Error getting shift summary:', error);
      return null;
    }
  }

  /**
   * Send receipt to thermal printer
   * TODO: Implement actual thermal printer communication
   */
  private async sendToPrinter(receipt: string): Promise<void> {
    // This would interface with thermal printer drivers/libraries
    // Examples:
    // - USB printer: node-thermal-printer
    // - Network printer: Socket connection
    // - Serial printer: serialport package

    // For now, just log
    console.log('Sending to printer:', receipt);
  }

  private getPaperCharWidth(): number {
    const size = this.getSetting<string>('printer', 'paper_size', '80mm');
    if (size === '58mm') return 32;
    if (size === '112mm') return 64;
    return 48;
  }

  /**
   * Get receipt template configuration for ESC/POS formatted templates
   * 
   * @param terminalName - Optional terminal name override
   * @returns ReceiptTemplateConfig object for use with Buffer-based templates
   */
  getReceiptConfigForTemplates(terminalName?: string): {
    paperSize: '58mm' | '80mm' | '112mm';
    language: 'en' | 'el';
    currency: string;
    terminalName?: string;
    storeName?: string;
    storeAddress?: string;
    storePhone?: string;
    receiptTemplate?: 'classic' | 'modern';
  } {
    const paperSize = this.getSetting<string>('printer', 'paper_size', '80mm') as '58mm' | '80mm' | '112mm';
    // Language is stored in 'terminal' category, not 'general'
    const language = this.getSetting<string>('terminal', 'language', 'en') as 'en' | 'el';
    const currency = this.getSetting<string>('general', 'currency_symbol', '€');
    const storeName = this.getSetting<string | undefined>('store', 'name', undefined);
    const storeAddress = this.getSetting<string | undefined>('store', 'address', undefined);
    const storePhone = this.getSetting<string | undefined>('store', 'phone', undefined);

    // Get receipt template from printer settings if available
    let receiptTemplate: 'classic' | 'modern' = 'classic';
    if (this.printerManager) {
      const printers = this.printerManager.getPrinters();
      const defaultPrinter = printers.find(p => p.enabled && p.role === 'receipt');
      if (defaultPrinter?.receiptTemplate) {
        receiptTemplate = defaultPrinter.receiptTemplate as 'classic' | 'modern';
      }
    }

    return {
      paperSize,
      language,
      currency,
      terminalName,
      storeName,
      storeAddress,
      storePhone,
      receiptTemplate,
    };
  }
}
