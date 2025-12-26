/**
 * Base Receipt Template
 * 
 * Abstract base class providing shared functionality for all receipt templates.
 * Handles i18n, currency formatting, date/time formatting, and EscPosBuilder setup.
 */

import { EscPosBuilder } from '../printer/services/escpos/EscPosBuilder';
import { PaperSize } from '../printer/types';
import mainI18n from '../lib/main-i18n';

/**
 * Configuration for receipt templates
 */
export interface ReceiptTemplateConfig {
  paperSize: PaperSize;
  language: 'en' | 'el';
  currency: string;
  terminalName?: string;
  storeName?: string;
  storeAddress?: string;
  storePhone?: string;
}

/**
 * Default configuration values
 */
export const DEFAULT_RECEIPT_CONFIG: ReceiptTemplateConfig = {
  paperSize: PaperSize.MM_80,
  language: 'en',
  currency: '€',
  terminalName: undefined,
  storeName: undefined,
  storeAddress: undefined,
  storePhone: undefined,
};

/**
 * Abstract base class for receipt templates
 */
export abstract class BaseReceiptTemplate {
  protected builder: EscPosBuilder;
  protected config: ReceiptTemplateConfig;

  constructor(config: Partial<ReceiptTemplateConfig> = {}) {
    this.config = { ...DEFAULT_RECEIPT_CONFIG, ...config };
    this.builder = new EscPosBuilder(this.config.paperSize);
    
    // Set language for i18n
    if (mainI18n && typeof mainI18n.changeLanguage === 'function') {
      mainI18n.changeLanguage(this.config.language);
    }
  }

  /**
   * Translate a key using i18n
   * @param key - translation key (e.g., 'receipt.zreport.title')
   * @param options - optional interpolation options
   */
  protected t(key: string, options?: Record<string, any>): string {
    if (mainI18n && typeof mainI18n.t === 'function') {
      return mainI18n.t(key, options) as string;
    }
    // Fallback: return the key's last segment
    return key.split('.').pop() || key;
  }

  /**
   * Format a number as currency
   * @param amount - amount to format
   */
  protected formatCurrency(amount: number): string {
    return `${this.config.currency}${amount.toFixed(2)}`;
  }

  /**
   * Format a date
   * @param date - date to format
   */
  protected formatDate(date: Date): string {
    return date.toLocaleDateString(this.config.language === 'el' ? 'el-GR' : 'en-US', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
  }

  /**
   * Format a time
   * @param date - date to extract time from
   */
  protected formatTime(date: Date): string {
    return date.toLocaleTimeString(this.config.language === 'el' ? 'el-GR' : 'en-US', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: this.config.language !== 'el',
    });
  }

  /**
   * Format date and time together
   * @param date - date to format
   */
  protected formatDateTime(date: Date): string {
    return `${this.formatDate(date)} ${this.formatTime(date)}`;
  }

  /**
   * Get paper width in characters
   */
  protected getPaperWidth(): number {
    return this.builder.getLineWidth();
  }

  /**
   * Initialize the builder with standard settings
   */
  protected initializeBuilder(): this {
    this.builder.initialize();
    
    if (this.config.language === 'el') {
      // Enable Greek encoding with Windows-1253 (CP1253)
      // CP1253 includes Euro symbol at 0x80
      this.builder
        .setCodePage(17)      // CP1253 (Windows Greek)
        .setCharacterSet(13)  // Greek character set
        .enableGreekEncoding();
    } else {
      // Default code page for English
      this.builder.setCodePage(0); // CP437 for English
    }
    
    return this;
  }

  /**
   * Add standard receipt header with terminal info
   */
  protected addHeader(title: string): this {
    this.builder.receiptTitle(title);
    
    if (this.config.terminalName) {
      this.builder
        .alignCenter()
        .textLine(this.config.terminalName)
        .alignLeft();
    }
    
    this.builder
      .alignCenter()
      .textLine(this.formatDate(new Date()))
      .textLine(this.formatTime(new Date()))
      .alignLeft()
      .emptyLine();
    
    return this;
  }

  /**
   * Add standard signature section
   * @param labels - array of signature labels
   */
  protected addSignatures(labels: string[]): this {
    this.builder.emptyLine().dashedLine();
    
    labels.forEach(label => {
      this.builder.signatureLine(label);
    });
    
    return this;
  }

  /**
   * Add standard footer and cut
   * @param message - footer message
   */
  protected addFooter(message: string): this {
    this.builder
      .receiptFooter(message)
      .cut();
    return this;
  }

  /**
   * Abstract method that subclasses must implement
   * @returns Buffer containing ESC/POS commands
   */
  abstract generate(): Buffer;
}

/**
 * Helper function to create receipt config from paper width
 * @param paperWidth - paper width in characters (32, 48, or 64)
 * @param language - language code
 * @param currency - currency symbol
 */
export function createConfigFromWidth(
  paperWidth: number = 48,
  language: 'en' | 'el' = 'en',
  currency: string = '€'
): ReceiptTemplateConfig {
  let paperSize: PaperSize;
  
  if (paperWidth <= 32) {
    paperSize = PaperSize.MM_58;
  } else if (paperWidth >= 64) {
    paperSize = PaperSize.MM_112;
  } else {
    paperSize = PaperSize.MM_80;
  }
  
  return {
    paperSize,
    language,
    currency,
  };
}
