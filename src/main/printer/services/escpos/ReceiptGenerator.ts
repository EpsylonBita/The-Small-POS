/**
 * Receipt Generator
 *
 * Generates formatted receipts, kitchen tickets, and test prints
 * using the EscPosBuilder class.
 *
 * @module printer/services/escpos
 */

import {
  PaperSize,
  ReceiptData,
  KitchenTicketData,
  PrintOrderItem,
  GreekRenderMode,
  ReceiptTemplate,
} from '../../types';
import { EscPosBuilder, PAPER_WIDTH_CHARS, CharacterSetType, CODE_PAGE_NUMBERS } from './EscPosBuilder';
import { GreekBitmapRenderer, TextLine, TextStyle } from './GreekBitmapRenderer';
import mainI18n from '../../../lib/main-i18n';

// ============================================================================
// Receipt Configuration
// ============================================================================

/**
 * Organization branding configuration from admin dashboard /profile settings
 * Validates: Requirements 6.1, 6.3
 */
export interface OrganizationBranding {
  name?: string;
  address?: string;
  city?: string;
  postalCode?: string;
  phone?: string;
  logoUrl?: string | null;
}

/**
 * Configuration options for receipt generation
 */
export interface ReceiptConfig {
  paperSize: PaperSize;
  storeName?: string;
  storeAddress?: string;
  storePhone?: string;
  footerMessage?: string;
  showLogo?: boolean;
  currency?: string;
  language?: 'en' | 'el';
  characterSet?: CharacterSetType;
  greekRenderMode?: GreekRenderMode;
  receiptTemplate?: ReceiptTemplate;
  /** Organization branding from admin dashboard /profile settings (Requirements 6.1, 6.3) */
  organizationBranding?: OrganizationBranding;
}

/**
 * Default receipt configuration
 */
const DEFAULT_RECEIPT_CONFIG: ReceiptConfig = {
  paperSize: PaperSize.MM_80,
  storeName: 'Restaurant',
  currency: '€',
  language: 'en',
  characterSet: 'PC437_USA',
  greekRenderMode: 'text',
  receiptTemplate: 'classic'
};

/**
 * Map ISO currency codes to their symbols
 * Falls back to the provided string if not found
 */
const CURRENCY_SYMBOL_MAP: Record<string, string> = {
  'EUR': '€',
  'USD': '$',
  'GBP': '£',
  'CHF': 'CHF',
  'CAD': 'C$',
  'AUD': 'A$',
  'JPY': '¥',
  'CNY': '¥',
  'INR': '₹',
  'KRW': '₩',
  'RUB': '₽',
  'BRL': 'R$',
  'MXN': 'MX$',
  'SEK': 'kr',
  'NOK': 'kr',
  'DKK': 'kr',
  'PLN': 'zł',
  'CZK': 'Kč',
  'HUF': 'Ft',
  'TRY': '₺',
  'ILS': '₪',
  'SGD': 'S$',
  'HKD': 'HK$',
  'NZD': 'NZ$',
  'ZAR': 'R',
  'THB': '฿',
};

/**
 * Convert ISO currency code to symbol
 * @param currency - ISO currency code (e.g., 'EUR') or symbol (e.g., '€')
 * @returns Currency symbol
 */
function getCurrencySymbol(currency: string): string {
  // If it's already a symbol (1-2 chars and not uppercase letters only), return as-is
  if (currency.length <= 2 && !/^[A-Z]+$/.test(currency)) {
    return currency;
  }
  // Look up in map, fallback to the provided string
  return CURRENCY_SYMBOL_MAP[currency.toUpperCase()] || currency;
}

// ============================================================================
// ReceiptGenerator Class
// ============================================================================

/**
 * Generates formatted receipts and tickets for thermal printers.
 */
export class ReceiptGenerator {
  private config: ReceiptConfig;
  private lineWidth: number;

  constructor(config: Partial<ReceiptConfig> = {}) {
    this.config = { ...DEFAULT_RECEIPT_CONFIG, ...config };
    this.lineWidth = PAPER_WIDTH_CHARS[this.config.paperSize];
  }

  getConfig(): ReceiptConfig {
    return { ...this.config };
  }

  private t(key: string, options?: Record<string, unknown>): string {
    const language = this.config.language || 'en';
    const result = mainI18n.t(key, { ...options, lng: language }) as string;
    // Debug: log translation lookups
    if (key.startsWith('receipt.')) {
      console.log(`[ReceiptGenerator.t] key="${key}" lng="${language}" result="${result}"`);
    }
    return result;
  }

  setConfig(config: Partial<ReceiptConfig>): void {
    this.config = { ...this.config, ...config };
    this.lineWidth = PAPER_WIDTH_CHARS[this.config.paperSize];
  }

  // ==========================================================================
  // Receipt Generation
  // ==========================================================================

  generateReceipt(data: ReceiptData): Buffer {
    const characterSet = this.config.characterSet || 'PC437_USA';
    const greekRenderMode = this.config.greekRenderMode || 'text';
    const receiptTemplate = this.config.receiptTemplate || 'classic';
    const isGreek = this.config.language === 'el';

    console.log('[ReceiptGenerator] ========== RECEIPT GENERATION ==========');
    console.log('[ReceiptGenerator] Raw config.receiptTemplate:', this.config.receiptTemplate);
    console.log('[ReceiptGenerator] Resolved receiptTemplate:', receiptTemplate);
    console.log('[ReceiptGenerator] Language:', this.config.language, 'isGreek:', isGreek);
    console.log('[ReceiptGenerator] Greek Render Mode:', greekRenderMode);
    console.log('[ReceiptGenerator] Template check: receiptTemplate === "modern" ?', receiptTemplate === 'modern');
    console.log('[ReceiptGenerator] Delivery data:', {
      orderType: data.orderType,
      deliveryAddress: data.deliveryAddress,
      deliveryNotes: data.deliveryNotes,
      ringerName: data.ringerName
    });

    // Modern template always uses bitmap with styled pillow headers
    if (receiptTemplate === 'modern') {
      console.log('[ReceiptGenerator] >>> USING MODERN TEMPLATE (bitmap with styled headers)');
      return this.generateReceiptBitmapModern(data);
    }

    // Classic template - always use bitmap rendering for consistent appearance
    // This ensures both English and Greek receipts look the same
    if (greekRenderMode === 'bitmap' || receiptTemplate === 'classic') {
      console.log('[ReceiptGenerator] >>> USING CLASSIC BITMAP (bitmap rendering)');
      return this.generateReceiptBitmapClassic(data);
    }

    // Fallback: Classic template with text mode - use ESC/POS text commands
    // This is only used when greekRenderMode is 'text' and not using classic template
    console.log('[ReceiptGenerator] >>> USING CLASSIC TEXT (ESC/POS text commands)');
    const builder = new EscPosBuilder(this.config.paperSize, characterSet);
    builder.initialize();
    
    // Set the code page based on the configured character set
    // Note: Some printers ignore ESC/POS code page commands and require
    // the code page to be set in the Windows printer driver settings
    const codePageNumber = CODE_PAGE_NUMBERS[characterSet] || 0;
    builder.raw([0x1B, 0x74, codePageNumber]);  // ESC t n - Select code page
    
    // Enable Greek encoding if using a Greek character set
    if (characterSet.includes('GREEK')) {
      builder.enableGreekEncoding();
      builder.setCharacterSetType(characterSet);
    }
    
    console.log('[ReceiptGenerator] Set code page', codePageNumber, 'for', characterSet);

    this.addReceiptHeader(builder, data);
    this.addOrderInfo(builder, data);
    this.addItemsSection(builder, data.items);
    this.addTotalsSection(builder, data);
    this.addPaymentInfo(builder, data);
    this.addReceiptFooter(builder);
    builder.cut();

    return builder.build();
  }

  /**
   * Generate receipt ASYNCHRONOUSLY - does NOT block the main thread
   * Use this for all receipt generation to prevent UI freezing
   */
  async generateReceiptAsync(data: ReceiptData): Promise<Buffer> {
    const characterSet = this.config.characterSet || 'PC437_USA';
    const greekRenderMode = this.config.greekRenderMode || 'text';
    const receiptTemplate = this.config.receiptTemplate || 'classic';

    console.log('[ReceiptGenerator] ========== ASYNC RECEIPT GENERATION ==========');
    console.log('[ReceiptGenerator] Template:', receiptTemplate, 'Greek mode:', greekRenderMode);

    // Modern template always uses bitmap with styled pillow headers
    if (receiptTemplate === 'modern') {
      console.log('[ReceiptGenerator] >>> USING MODERN TEMPLATE (async bitmap)');
      return this.generateReceiptBitmapModernAsync(data);
    }

    // Classic template - always use bitmap rendering for consistent appearance
    if (greekRenderMode === 'bitmap' || receiptTemplate === 'classic') {
      console.log('[ReceiptGenerator] >>> USING CLASSIC BITMAP (async bitmap)');
      return this.generateReceiptBitmapClassicAsync(data);
    }

    // Fallback: text mode (already fast, no async needed)
    console.log('[ReceiptGenerator] >>> USING TEXT MODE (sync - already fast)');
    return this.generateReceiptTextMode(data);
  }

  /**
   * Generate receipt using bitmap rendering for Greek text
   * This renders all text as images to ensure proper Greek character display
   * on printers that don't have Greek font support - MODERN style with pillow headers
   */
  private generateReceiptBitmapModern(data: ReceiptData): Buffer {
    const renderer = new GreekBitmapRenderer(this.config.paperSize);
    const buffers: Buffer[] = [];

    // Initialize printer
    buffers.push(Buffer.from([0x1B, 0x40]));  // ESC @ - Initialize

    const lines: TextLine[] = [];

    // Get organization branding from config (Requirements 6.1, 6.3)
    // Organization branding takes precedence over legacy storeName/storeAddress/storePhone
    const branding = this.config.organizationBranding;
    const storeName = branding?.name || this.config.storeName;
    const storeAddress = branding?.address || this.config.storeAddress;
    const storeCity = branding?.city;
    const storePostalCode = branding?.postalCode;
    const storePhone = branding?.phone || this.config.storePhone;

    // ═══════════════════════════════════════════════════════════════
    // HEADER - Organization branding (Requirements 6.1, 6.3, 6.5)
    // ═══════════════════════════════════════════════════════════════
    lines.push({ text: '', style: 'normal', align: 'left' });
    
    // Organization name in large text (Requirement 6.5 - text fallback when no logo)
    if (storeName) {
      lines.push({ text: storeName, style: 'title', align: 'center' });
    }
    
    // Organization address (Requirement 6.3)
    if (storeAddress) {
      lines.push({ text: storeAddress, style: 'small', align: 'center' });
    }
    
    // City and postal code on same line (Requirement 6.3)
    if (storeCity || storePostalCode) {
      const cityLine = [storePostalCode, storeCity].filter(Boolean).join(' ');
      if (cityLine) {
        lines.push({ text: cityLine, style: 'small', align: 'center' });
      }
    }
    
    // Phone (Requirement 6.3)
    if (storePhone) {
      lines.push({ text: this.t('receipt.header.tel') + ' ' + storePhone, style: 'small', align: 'center' });
    }
    lines.push({ text: '', style: 'small', align: 'left' });

    // ═══════════════════════════════════════════════════════════════
    // ORDER INFO - Black box header
    // ═══════════════════════════════════════════════════════════════
    const orderTypeLabel = this.formatOrderType(data.orderType);
    lines.push({ text: orderTypeLabel, style: 'boxHeader', align: 'center', inverted: true });
    
    lines.push({ text: '', style: 'small', align: 'left' });
    lines.push({ text: this.t('receipt.order.orderNumber', { number: data.orderNumber }), style: 'header', align: 'center' });
    lines.push({ text: '', style: 'small', align: 'left' });

    // Customer info section - ALL WITH BOLD LABELS for delivery
    if (data.orderType === 'delivery') {
      // Delivery order - show all customer details with BOLD labels
      if (data.customerName) {
        lines.push({ text: this.t('receipt.order.customer'), style: 'bold', align: 'left', rightText: data.customerName });
      }
      if (data.customerPhone) {
        lines.push({ text: this.t('receipt.order.phone'), style: 'bold', align: 'left', rightText: data.customerPhone });
      }

      // Address on SEPARATE LINES - Use separate fields if available
      lines.push({ text: '', style: 'small', align: 'left' });
      if (data.streetAddress) {
        // Use separate address fields (preferred)
        lines.push({ text: this.t('receipt.order.address'), style: 'bold', align: 'left', rightText: data.streetAddress });
        if (data.postalCode) {
          lines.push({ text: this.t('receipt.delivery.postCode'), style: 'bold', align: 'left', rightText: data.postalCode });
        }
        if (data.city) {
          lines.push({ text: this.t('receipt.delivery.city'), style: 'bold', align: 'left', rightText: data.city });
        }
        if (data.floorNumber) {
          lines.push({ text: this.t('receipt.delivery.floor'), style: 'bold', align: 'left', rightText: data.floorNumber });
        }
      } else if (data.deliveryAddress) {
        // Fallback: parse combined address string
        lines.push({ text: this.t('receipt.order.address'), style: 'bold', align: 'left' });

        const addressParts = this.parseDeliveryAddress(data.deliveryAddress);

        if (addressParts.street) {
          lines.push({ text: addressParts.street, style: 'bold', align: 'left' });
        }
        if (addressParts.city) {
          lines.push({ text: this.t('receipt.delivery.city'), style: 'bold', align: 'left', rightText: addressParts.city });
        }
        if (addressParts.postCode) {
          lines.push({ text: this.t('receipt.delivery.postCode'), style: 'bold', align: 'left', rightText: addressParts.postCode });
        }
        if (addressParts.floor) {
          lines.push({ text: this.t('receipt.delivery.floor'), style: 'bold', align: 'left', rightText: addressParts.floor });
        }

        // If no structured parsing worked, just show the raw address
        if (!addressParts.street && !addressParts.postCode && !addressParts.city) {
          lines.push({ text: data.deliveryAddress, style: 'bold', align: 'left' });
        }
      }

      // Ringer name - BOLD
      if (data.ringerName) {
        lines.push({ text: this.t('receipt.delivery.ringer'), style: 'bold', align: 'left', rightText: data.ringerName });
      }

      // Delivery notes
      if (data.deliveryNotes) {
        lines.push({ text: '', style: 'small', align: 'left' });
        lines.push({ text: this.t('receipt.delivery.notes'), style: 'bold', align: 'left' });
        lines.push({ text: data.deliveryNotes, style: 'normal', align: 'left' });
      }

      // Driver name - BOLD with emoji
      if (data.driverName) {
        lines.push({ text: '', style: 'small', align: 'left' });
        lines.push({ text: '🚗 ' + this.t('receipt.delivery.driver'), style: 'bold', align: 'left', rightText: data.driverName });
      }
    } else {
      // Non-delivery orders
      if (data.customerName) {
        lines.push({ text: this.t('receipt.order.customer'), style: 'normal', align: 'left', rightText: data.customerName });
      }
      if (data.customerPhone) {
        lines.push({ text: this.t('receipt.order.phone'), style: 'normal', align: 'left', rightText: data.customerPhone });
      }
      if (data.tableName && data.orderType === 'dine-in') {
        lines.push({ text: this.t('receipt.order.table'), style: 'normal', align: 'left', rightText: data.tableName });
      }
    }
    
    lines.push({ text: '', style: 'small', align: 'left' });
    lines.push({ text: this.t('receipt.order.date'), style: 'small', align: 'left', rightText: this.formatDate(data.timestamp) });
    lines.push({ text: '', style: 'small', align: 'left' });

    // ═══════════════════════════════════════════════════════════════
    // ITEMS SECTION - Black box header
    // ═══════════════════════════════════════════════════════════════
    lines.push({ text: this.t('receipt.items.item'), style: 'boxHeader', align: 'center', inverted: true });
    lines.push({ text: '', style: 'small', align: 'left' });
    
    for (const item of data.items) {
      // Category name (if available) - shown above item name
      if (item.categoryName) {
        lines.push({ text: item.categoryName.toUpperCase(), style: 'small', align: 'left' });
      }

      // Item name bold with quantity and price on right
      const qtyPrice = 'x' + item.quantity + '   ' + this.formatCurrency(item.total);
      lines.push({ text: item.name, style: 'bold', align: 'left', rightText: qtyPrice });

      // Modifiers with prices
      if (item.modifiers && item.modifiers.length > 0) {
        for (const modifier of item.modifiers) {
          if (typeof modifier === 'string') {
            lines.push({ text: '  + ' + modifier, style: 'small', align: 'left' });
          } else {
            // Handle "without" items - show with ΧΩΡΙΣ: prefix and bold style
            if (modifier.isWithout) {
              lines.push({ text: '  ΧΩΡΙΣ: ' + modifier.name, style: 'bold', align: 'left' });
            } else {
              // Handle normal and "little" items
              const modPrice = modifier.price ? this.formatCurrency(modifier.price) : '';
              const modQty = modifier.quantity && modifier.quantity > 1 ? ' x' + modifier.quantity : '';
              const littleSuffix = modifier.isLittle ? ' (λίγο)' : '';
              const style = modifier.isLittle ? 'bold' : 'small';
              lines.push({ text: '  + ' + modifier.name + littleSuffix + modQty, style, align: 'left', rightText: modPrice });
            }
          }
        }
      }

      // Special instructions
      if (item.specialInstructions) {
        lines.push({ text: '  * ' + item.specialInstructions, style: 'bold', align: 'left' });
      }
    }
    lines.push({ text: '', style: 'small', align: 'left' });

    // ═══════════════════════════════════════════════════════════════
    // TOTALS SECTION
    // ═══════════════════════════════════════════════════════════════
    lines.push({ text: '─────────────────────────────────────────────', style: 'small', align: 'center' });
    
    if (data.subtotal > 0) {
      lines.push({ text: this.t('receipt.totals.subtotal'), style: 'normal', align: 'left', rightText: this.formatCurrency(data.subtotal) });
    }
    if (data.tax > 0) {
      lines.push({ text: this.t('receipt.totals.tax'), style: 'normal', align: 'left', rightText: this.formatCurrency(data.tax) });
    }
    if (data.deliveryFee && data.deliveryFee > 0) {
      lines.push({ text: this.t('receipt.totals.deliveryFee'), style: 'normal', align: 'left', rightText: this.formatCurrency(data.deliveryFee) });
    }
    // Show discount (as negative amount) - Modern template
    if (data.discount && data.discount > 0) {
      const discountLabel = this.t('receipt.totals.discount') || 'Έκπτωση';
      const percentageText = data.discountPercentage ? ` (${data.discountPercentage}%)` : '';
      lines.push({ text: discountLabel + percentageText, style: 'normal', align: 'left', rightText: '-' + this.formatCurrency(data.discount) });
    }
    if (data.tip && data.tip > 0) {
      lines.push({ text: this.t('receipt.totals.tip'), style: 'normal', align: 'left', rightText: this.formatCurrency(data.tip) });
    }

    lines.push({ text: '', style: 'small', align: 'left' });

    // Total - big and prominent in black box
    lines.push({ text: this.t('receipt.totals.total') + ' ' + this.formatCurrency(data.total), style: 'boxHeader', align: 'center', inverted: true });
    lines.push({ text: '', style: 'small', align: 'left' });

    // ═══════════════════════════════════════════════════════════════
    // PAYMENT INFO
    // ═══════════════════════════════════════════════════════════════
    const paymentLabel = this.formatPaymentMethod(data.paymentMethod);
    lines.push({ text: this.t('receipt.payment.payment'), style: 'normal', align: 'left', rightText: paymentLabel });
    lines.push({ text: '', style: 'small', align: 'left' });

    // ═══════════════════════════════════════════════════════════════
    // FOOTER
    // ═══════════════════════════════════════════════════════════════
    lines.push({ text: '─────────────────────────────────────────────', style: 'small', align: 'center' });
    if (this.config.footerMessage) {
      lines.push({ text: this.config.footerMessage, style: 'normal', align: 'center' });
    } else {
      lines.push({ text: this.t('receipt.header.thankYou'), style: 'normal', align: 'center' });
    }
    lines.push({ text: '', style: 'normal', align: 'left' });
    lines.push({ text: '', style: 'normal', align: 'left' });

    // Render
    try {
      const bitmapBuffer = renderer.renderLinesSync(lines);
      buffers.push(bitmapBuffer);
    } catch (error) {
      console.error('[ReceiptGenerator] Bitmap rendering failed:', error);
      return this.generateReceiptTextMode(data);
    }

    buffers.push(Buffer.from([0x1D, 0x56, 0x42, 0x03]));
    return Buffer.concat(buffers);
  }

  /**
   * ASYNC version of generateReceiptBitmapModern - does NOT block main thread
   */
  private async generateReceiptBitmapModernAsync(data: ReceiptData): Promise<Buffer> {
    const renderer = new GreekBitmapRenderer(this.config.paperSize);
    const buffers: Buffer[] = [];

    buffers.push(Buffer.from([0x1B, 0x40]));

    const lines: TextLine[] = this.buildModernReceiptLines(data);

    try {
      const bitmapBuffer = await renderer.renderLinesAsync(lines);
      buffers.push(bitmapBuffer);
    } catch (error) {
      console.error('[ReceiptGenerator] Async Modern bitmap rendering failed:', error);
      return this.generateReceiptTextMode(data);
    }

    buffers.push(Buffer.from([0x1D, 0x56, 0x42, 0x03]));
    return Buffer.concat(buffers);
  }

  /**
   * Build lines array for Modern receipt (shared between sync and async)
   */
  private buildModernReceiptLines(data: ReceiptData): TextLine[] {
    const lines: TextLine[] = [];

    // Get organization branding from config (Requirements 6.1, 6.3)
    // Organization branding takes precedence over legacy storeName/storeAddress/storePhone
    const branding = this.config.organizationBranding;
    const storeName = branding?.name || this.config.storeName;
    const storeAddress = branding?.address || this.config.storeAddress;
    const storeCity = branding?.city;
    const storePostalCode = branding?.postalCode;
    const storePhone = branding?.phone || this.config.storePhone;

    // HEADER - Organization branding (Requirements 6.1, 6.3, 6.5)
    lines.push({ text: '', style: 'normal', align: 'left' });
    
    // Organization name in large text (Requirement 6.5 - text fallback when no logo)
    if (storeName) {
      lines.push({ text: storeName, style: 'title', align: 'center' });
    }
    
    // Organization address (Requirement 6.3)
    if (storeAddress) {
      lines.push({ text: storeAddress, style: 'small', align: 'center' });
    }
    
    // City and postal code on same line (Requirement 6.3)
    if (storeCity || storePostalCode) {
      const cityLine = [storePostalCode, storeCity].filter(Boolean).join(' ');
      if (cityLine) {
        lines.push({ text: cityLine, style: 'small', align: 'center' });
      }
    }
    
    // Phone (Requirement 6.3)
    if (storePhone) {
      lines.push({ text: this.t('receipt.header.tel') + ' ' + storePhone, style: 'small', align: 'center' });
    }
    lines.push({ text: '', style: 'small', align: 'left' });

    // ORDER INFO
    const orderTypeLabel = this.formatOrderType(data.orderType);
    lines.push({ text: orderTypeLabel, style: 'boxHeader', align: 'center', inverted: true });
    lines.push({ text: '', style: 'small', align: 'left' });
    lines.push({ text: this.t('receipt.order.orderNumber', { number: data.orderNumber }), style: 'header', align: 'center' });
    lines.push({ text: '', style: 'small', align: 'left' });

    // Customer info
    if (data.orderType === 'delivery') {
      if (data.customerName) {
        lines.push({ text: this.t('receipt.order.customer'), style: 'bold', align: 'left', rightText: data.customerName });
      }
      if (data.customerPhone) {
        lines.push({ text: this.t('receipt.order.phone'), style: 'bold', align: 'left', rightText: data.customerPhone });
      }
      lines.push({ text: '', style: 'small', align: 'left' });
      if (data.streetAddress) {
        lines.push({ text: this.t('receipt.order.address'), style: 'bold', align: 'left', rightText: data.streetAddress });
        if (data.postalCode) {
          lines.push({ text: this.t('receipt.delivery.postCode'), style: 'bold', align: 'left', rightText: data.postalCode });
        }
        if (data.city) {
          lines.push({ text: this.t('receipt.delivery.city'), style: 'bold', align: 'left', rightText: data.city });
        }
        if (data.floorNumber) {
          lines.push({ text: this.t('receipt.delivery.floor'), style: 'bold', align: 'left', rightText: data.floorNumber });
        }
      } else if (data.deliveryAddress) {
        lines.push({ text: this.t('receipt.order.address'), style: 'bold', align: 'left' });
        const addressParts = this.parseDeliveryAddress(data.deliveryAddress);
        if (addressParts.street) lines.push({ text: addressParts.street, style: 'bold', align: 'left' });
        if (addressParts.city) lines.push({ text: this.t('receipt.delivery.city'), style: 'bold', align: 'left', rightText: addressParts.city });
        if (addressParts.postCode) lines.push({ text: this.t('receipt.delivery.postCode'), style: 'bold', align: 'left', rightText: addressParts.postCode });
        if (addressParts.floor) lines.push({ text: this.t('receipt.delivery.floor'), style: 'bold', align: 'left', rightText: addressParts.floor });
        if (!addressParts.street && !addressParts.postCode && !addressParts.city) {
          lines.push({ text: data.deliveryAddress, style: 'bold', align: 'left' });
        }
      }
      if (data.ringerName) {
        lines.push({ text: this.t('receipt.delivery.ringer'), style: 'bold', align: 'left', rightText: data.ringerName });
      }
      if (data.deliveryNotes) {
        lines.push({ text: '', style: 'small', align: 'left' });
        lines.push({ text: this.t('receipt.delivery.notes'), style: 'bold', align: 'left' });
        lines.push({ text: data.deliveryNotes, style: 'normal', align: 'left' });
      }
      if (data.driverName) {
        lines.push({ text: '', style: 'small', align: 'left' });
        lines.push({ text: '🚗 ' + this.t('receipt.delivery.driver'), style: 'bold', align: 'left', rightText: data.driverName });
      }
    } else {
      if (data.customerName) {
        lines.push({ text: this.t('receipt.order.customer'), style: 'normal', align: 'left', rightText: data.customerName });
      }
      if (data.customerPhone) {
        lines.push({ text: this.t('receipt.order.phone'), style: 'normal', align: 'left', rightText: data.customerPhone });
      }
      if (data.tableName && data.orderType === 'dine-in') {
        lines.push({ text: this.t('receipt.order.table'), style: 'normal', align: 'left', rightText: data.tableName });
      }
    }

    lines.push({ text: '', style: 'small', align: 'left' });
    lines.push({ text: this.t('receipt.order.date'), style: 'small', align: 'left', rightText: this.formatDate(data.timestamp) });
    lines.push({ text: '', style: 'small', align: 'left' });

    // ITEMS
    lines.push({ text: this.t('receipt.items.item'), style: 'boxHeader', align: 'center', inverted: true });
    lines.push({ text: '', style: 'small', align: 'left' });

    for (const item of data.items) {
      const qtyPrice = 'x' + item.quantity + '   ' + this.formatCurrency(item.total);
      lines.push({ text: item.name, style: 'bold', align: 'left', rightText: qtyPrice });
      if (item.modifiers && item.modifiers.length > 0) {
        for (const modifier of item.modifiers) {
          if (typeof modifier === 'string') {
            lines.push({ text: '  + ' + modifier, style: 'small', align: 'left' });
          } else {
            if (modifier.isWithout) {
              lines.push({ text: '  ΧΩΡΙΣ: ' + modifier.name, style: 'bold', align: 'left' });
            } else {
              const modPrice = modifier.price ? this.formatCurrency(modifier.price) : '';
              const modQty = modifier.quantity && modifier.quantity > 1 ? ' x' + modifier.quantity : '';
              const littleSuffix = modifier.isLittle ? ' (λίγο)' : '';
              const style = modifier.isLittle ? 'bold' : 'small';
              lines.push({ text: '  + ' + modifier.name + littleSuffix + modQty, style: style as TextStyle, align: 'left', rightText: modPrice });
            }
          }
        }
      }
      if (item.specialInstructions) {
        lines.push({ text: '  * ' + item.specialInstructions, style: 'bold', align: 'left' });
      }
    }

    lines.push({ text: '', style: 'small', align: 'left' });

    // TOTALS
    if (data.subtotal > 0) {
      lines.push({ text: this.t('receipt.totals.subtotal'), style: 'normal', align: 'left', rightText: this.formatCurrency(data.subtotal) });
    }
    if (data.tax > 0) {
      lines.push({ text: this.t('receipt.totals.tax'), style: 'normal', align: 'left', rightText: this.formatCurrency(data.tax) });
    }
    if (data.deliveryFee && data.deliveryFee > 0) {
      lines.push({ text: this.t('receipt.totals.deliveryFee'), style: 'normal', align: 'left', rightText: this.formatCurrency(data.deliveryFee) });
    }
    if (data.discount && data.discount > 0) {
      const discountLabel = this.t('receipt.totals.discount') || 'Έκπτωση';
      const percentageText = data.discountPercentage ? ` (${data.discountPercentage}%)` : '';
      lines.push({ text: discountLabel + percentageText, style: 'normal', align: 'left', rightText: '-' + this.formatCurrency(data.discount) });
    }
    if (data.tip && data.tip > 0) {
      lines.push({ text: this.t('receipt.totals.tip'), style: 'normal', align: 'left', rightText: this.formatCurrency(data.tip) });
    }

    lines.push({ text: '', style: 'small', align: 'left' });
    lines.push({ text: this.t('receipt.totals.total') + ' ' + this.formatCurrency(data.total), style: 'boxHeader', align: 'center', inverted: true });
    lines.push({ text: '', style: 'small', align: 'left' });

    // PAYMENT
    const paymentLabel = this.formatPaymentMethod(data.paymentMethod);
    lines.push({ text: this.t('receipt.payment.payment'), style: 'normal', align: 'left', rightText: paymentLabel });
    lines.push({ text: '', style: 'small', align: 'left' });

    // FOOTER
    lines.push({ text: '─────────────────────────────────────────────', style: 'small', align: 'center' });
    if (this.config.footerMessage) {
      lines.push({ text: this.config.footerMessage, style: 'normal', align: 'center' });
    } else {
      lines.push({ text: this.t('receipt.header.thankYou'), style: 'normal', align: 'center' });
    }
    lines.push({ text: '', style: 'normal', align: 'left' });
    lines.push({ text: '', style: 'normal', align: 'left' });

    return lines;
  }

  /**
   * ASYNC version of generateReceiptBitmapClassic - does NOT block main thread
   */
  private async generateReceiptBitmapClassicAsync(data: ReceiptData): Promise<Buffer> {
    const renderer = new GreekBitmapRenderer(this.config.paperSize);
    const buffers: Buffer[] = [];

    buffers.push(Buffer.from([0x1B, 0x40]));

    const lines: TextLine[] = this.buildClassicReceiptLines(data);

    try {
      const bitmapBuffer = await renderer.renderLinesAsync(lines);
      buffers.push(bitmapBuffer);
    } catch (error) {
      console.error('[ReceiptGenerator] Async Classic bitmap rendering failed:', error);
      return this.generateReceiptTextMode(data);
    }

    buffers.push(Buffer.from([0x1D, 0x56, 0x42, 0x03]));
    return Buffer.concat(buffers);
  }

  /**
   * Build lines array for Classic receipt (shared between sync and async)
   */
  private buildClassicReceiptLines(data: ReceiptData): TextLine[] {
    const lines: TextLine[] = [];

    // Get organization branding from config (Requirements 6.1, 6.3)
    // Organization branding takes precedence over legacy storeName/storeAddress/storePhone
    const branding = this.config.organizationBranding;
    const storeName = branding?.name || this.config.storeName;
    const storeAddress = branding?.address || this.config.storeAddress;
    const storeCity = branding?.city;
    const storePostalCode = branding?.postalCode;
    const storePhone = branding?.phone || this.config.storePhone;

    // HEADER - Organization branding (Requirements 6.1, 6.3, 6.5)
    lines.push({ text: '', style: 'normal', align: 'left' });
    
    // Organization name in large text (Requirement 6.5 - text fallback when no logo)
    if (storeName) {
      lines.push({ text: storeName, style: 'title', align: 'center' });
    }
    
    // Organization address (Requirement 6.3)
    if (storeAddress) {
      lines.push({ text: storeAddress, style: 'small', align: 'center' });
    }
    
    // City and postal code on same line (Requirement 6.3)
    if (storeCity || storePostalCode) {
      const cityLine = [storePostalCode, storeCity].filter(Boolean).join(' ');
      if (cityLine) {
        lines.push({ text: cityLine, style: 'small', align: 'center' });
      }
    }
    
    // Phone (Requirement 6.3)
    if (storePhone) {
      lines.push({ text: this.t('receipt.header.tel') + ' ' + storePhone, style: 'small', align: 'center' });
    }
    lines.push({ text: '════════════════════════════════════════════', style: 'small', align: 'center' });
    lines.push({ text: '', style: 'small', align: 'left' });

    // ORDER INFO - Simple text (no box header)
    lines.push({ text: this.t('receipt.order.orderNumber', { number: data.orderNumber }), style: 'header', align: 'center' });

    const orderTypeLabel = this.formatOrderType(data.orderType);
    lines.push({ text: this.t('receipt.order.type') + ' ' + orderTypeLabel, style: 'normal', align: 'left' });

    // Customer info - ALL WITH BOLD LABELS
    if (data.orderType === 'delivery') {
      // Customer name - BOLD
      if (data.customerName) {
        lines.push({ text: this.t('receipt.order.customer') + ' ' + data.customerName, style: 'bold', align: 'left' });
      }
      // Phone - BOLD
      if (data.customerPhone) {
        lines.push({ text: this.t('receipt.order.phone') + ' ' + data.customerPhone, style: 'bold', align: 'left' });
      }
      // Address on SEPARATE LINES - Use separate fields if available, fallback to combined address
      if (data.streetAddress) {
        // Use separate address fields (preferred)
        lines.push({ text: this.t('receipt.order.address') + ' ' + data.streetAddress, style: 'bold', align: 'left' });
        if (data.postalCode) {
          lines.push({ text: this.t('receipt.delivery.postCode') + ' ' + data.postalCode, style: 'bold', align: 'left' });
        }
        if (data.city) {
          lines.push({ text: this.t('receipt.delivery.city') + ' ' + data.city, style: 'bold', align: 'left' });
        }
        if (data.floorNumber) {
          lines.push({ text: this.t('receipt.delivery.floor') + ' ' + data.floorNumber, style: 'bold', align: 'left' });
        }
      } else if (data.deliveryAddress) {
        // Fallback: parse combined address string (e.g., "Iliados 10, Thessaloniki 546 41, Floor: 0")
        const addressParts = data.deliveryAddress.split(',').map(p => p.trim());
        // First part is street address
        if (addressParts[0]) {
          lines.push({ text: this.t('receipt.order.address') + ' ' + addressParts[0], style: 'bold', align: 'left' });
        }
        // Second part might be city + postal code
        if (addressParts[1]) {
          // Try to extract postal code (pattern like "546 41" or "54641")
          const postalMatch = addressParts[1].match(/(\d{3}\s?\d{2})/);
          if (postalMatch) {
            const city = addressParts[1].replace(postalMatch[0], '').trim();
            if (city) {
              lines.push({ text: this.t('receipt.delivery.city') + ' ' + city, style: 'bold', align: 'left' });
            }
            lines.push({ text: this.t('receipt.delivery.postCode') + ' ' + postalMatch[1], style: 'bold', align: 'left' });
          } else {
            lines.push({ text: this.t('receipt.delivery.city') + ' ' + addressParts[1], style: 'bold', align: 'left' });
          }
        }
        // Third part might be Floor
        if (addressParts[2]) {
          const floorMatch = addressParts[2].match(/Floor:\s*(.+)/i);
          if (floorMatch) {
            lines.push({ text: this.t('receipt.delivery.floor') + ' ' + floorMatch[1], style: 'bold', align: 'left' });
          }
        }
      }
      // Ringer - BOLD
      if (data.ringerName) {
        lines.push({ text: this.t('receipt.delivery.ringer') + ' ' + data.ringerName, style: 'bold', align: 'left' });
      }
      // Notes
      if (data.deliveryNotes) {
        lines.push({ text: this.t('receipt.delivery.notes') + ' ' + data.deliveryNotes, style: 'normal', align: 'left' });
      }
      // Driver - BOLD with emoji
      if (data.driverName) {
        lines.push({ text: '🚗 ' + this.t('receipt.delivery.driver') + ' ' + data.driverName, style: 'bold', align: 'left' });
      }
    } else {
      if (data.tableName && data.orderType === 'dine-in') {
        lines.push({ text: this.t('receipt.order.table') + ' ' + data.tableName, style: 'normal', align: 'left' });
      }
      if (data.customerName) {
        lines.push({ text: this.t('receipt.order.customer') + ' ' + data.customerName, style: 'normal', align: 'left' });
      }
      if (data.customerPhone) {
        lines.push({ text: this.t('receipt.order.phone') + ' ' + data.customerPhone, style: 'normal', align: 'left' });
      }
    }

    lines.push({ text: this.t('receipt.order.date') + ' ' + this.formatDate(data.timestamp), style: 'small', align: 'left' });
    lines.push({ text: '────────────────────────────────────────────', style: 'small', align: 'center' });
    lines.push({ text: '', style: 'small', align: 'left' });

    // ITEMS SECTION - Header with qty and price aligned right
    lines.push({ text: this.t('receipt.items.item'), style: 'bold', align: 'left', rightText: this.t('receipt.items.qty') + '   ' + this.t('receipt.items.price') });
    lines.push({ text: '────────────────────────────────────────────', style: 'small', align: 'center' });

    for (const item of data.items) {
      // Category name (if available) - shown above item name
      if (item.categoryName) {
        lines.push({ text: item.categoryName.toUpperCase(), style: 'small', align: 'left' });
      }

      const qtyPrice = 'x' + item.quantity + '   ' + this.formatCurrency(item.total);
      lines.push({ text: item.name, style: 'bold', align: 'left', rightText: qtyPrice });

      if (item.modifiers && item.modifiers.length > 0) {
        for (const modifier of item.modifiers) {
          if (typeof modifier === 'string') {
            lines.push({ text: '  + ' + modifier, style: 'small', align: 'left' });
          } else {
            // Handle "without" items - show with ΧΩΡΙΣ: prefix and bold style
            if (modifier.isWithout) {
              lines.push({ text: '  ΧΩΡΙΣ: ' + modifier.name, style: 'bold', align: 'left' });
            } else {
              // Handle normal and "little" items
              const modPrice = modifier.price ? this.formatCurrency(modifier.price) : '';
              const modQty = modifier.quantity && modifier.quantity > 1 ? ' x' + modifier.quantity : '';
              const littleSuffix = modifier.isLittle ? ' (λίγο)' : '';
              const style = modifier.isLittle ? 'bold' : 'small';
              lines.push({ text: '  + ' + modifier.name + littleSuffix + modQty, style, align: 'left', rightText: modPrice });
            }
          }
        }
      }

      if (item.specialInstructions) {
        lines.push({ text: '  * ' + item.specialInstructions, style: 'small', align: 'left' });
      }
    }

    lines.push({ text: '────────────────────────────────────────────', style: 'small', align: 'center' });
    lines.push({ text: '', style: 'small', align: 'left' });

    // TOTALS SECTION
    if (data.subtotal > 0) {
      lines.push({ text: this.t('receipt.totals.subtotal'), style: 'normal', align: 'left', rightText: this.formatCurrency(data.subtotal) });
    }
    if (data.tax > 0) {
      lines.push({ text: this.t('receipt.totals.tax'), style: 'normal', align: 'left', rightText: this.formatCurrency(data.tax) });
    }
    if (data.deliveryFee && data.deliveryFee > 0) {
      lines.push({ text: this.t('receipt.totals.deliveryFee'), style: 'normal', align: 'left', rightText: this.formatCurrency(data.deliveryFee) });
    }
    // Show discount (as negative amount)
    if (data.discount && data.discount > 0) {
      const discountLabel = this.t('receipt.totals.discount') || 'Έκπτωση';
      const percentageText = data.discountPercentage ? ` (${data.discountPercentage}%)` : '';
      lines.push({ text: discountLabel + percentageText, style: 'normal', align: 'left', rightText: '-' + this.formatCurrency(data.discount) });
    }
    if (data.tip && data.tip > 0) {
      lines.push({ text: this.t('receipt.totals.tip'), style: 'normal', align: 'left', rightText: this.formatCurrency(data.tip) });
    }

    lines.push({ text: '════════════════════════════════════════════', style: 'small', align: 'center' });
    lines.push({ text: this.t('receipt.totals.total'), style: 'header', align: 'left', rightText: this.formatCurrency(data.total) });
    lines.push({ text: '════════════════════════════════════════════', style: 'small', align: 'center' });
    lines.push({ text: '', style: 'small', align: 'left' });

    // PAYMENT INFO
    const paymentLabel = this.formatPaymentMethod(data.paymentMethod);
    lines.push({ text: this.t('receipt.payment.payment') + ' ' + paymentLabel, style: 'normal', align: 'left' });
    lines.push({ text: '', style: 'small', align: 'left' });

    // FOOTER
    lines.push({ text: '────────────────────────────────────────────', style: 'small', align: 'center' });
    if (this.config.footerMessage) {
      lines.push({ text: this.config.footerMessage, style: 'normal', align: 'center' });
    } else {
      lines.push({ text: this.t('receipt.header.thankYou'), style: 'normal', align: 'center' });
    }
    lines.push({ text: '', style: 'normal', align: 'left' });
    lines.push({ text: '', style: 'normal', align: 'left' });

    return lines;
  }

  /**
   * Generate receipt using bitmap rendering - CLASSIC style (simple layout, no pillow headers)
   * Uses bitmap for Greek text but with a simpler layout similar to text mode
   */
  private generateReceiptBitmapClassic(data: ReceiptData): Buffer {
    const renderer = new GreekBitmapRenderer(this.config.paperSize);
    const buffers: Buffer[] = [];

    buffers.push(Buffer.from([0x1B, 0x40]));  // ESC @ - Initialize

    const lines: TextLine[] = this.buildClassicReceiptLines(data);

    // Render synchronously (blocks main thread)
    try {
      const bitmapBuffer = renderer.renderLinesSync(lines);
      buffers.push(bitmapBuffer);
    } catch (error) {
      console.error('[ReceiptGenerator] Classic bitmap rendering failed:', error);
      return this.generateReceiptTextMode(data);
    }

    buffers.push(Buffer.from([0x1D, 0x56, 0x42, 0x03]));
    return Buffer.concat(buffers);
  }

  /**
   * Generate receipt using standard text mode (fallback)
   */
  private generateReceiptTextMode(data: ReceiptData): Buffer {
    const characterSet = this.config.characterSet || 'PC437_USA';
    const builder = new EscPosBuilder(this.config.paperSize, characterSet);
    
    builder.initialize();
    const codePageNumber = CODE_PAGE_NUMBERS[characterSet] || 0;
    builder.raw([0x1B, 0x74, codePageNumber]);
    
    if (characterSet.includes('GREEK')) {
      builder.enableGreekEncoding();
      builder.setCharacterSetType(characterSet);
    }

    this.addReceiptHeader(builder, data);
    this.addOrderInfo(builder, data);
    this.addItemsSection(builder, data.items);
    this.addTotalsSection(builder, data);
    this.addPaymentInfo(builder, data);
    this.addReceiptFooter(builder);
    builder.cut();

    return builder.build();
  }

  private addReceiptHeader(builder: EscPosBuilder, _data: ReceiptData): void {
    builder.alignCenter();

    // Get organization branding from config (Requirements 6.1, 6.3)
    // Organization branding takes precedence over legacy storeName/storeAddress/storePhone
    const branding = this.config.organizationBranding;
    const storeName = branding?.name || this.config.storeName;
    const storeAddress = branding?.address || this.config.storeAddress;
    const storeCity = branding?.city;
    const storePostalCode = branding?.postalCode;
    const storePhone = branding?.phone || this.config.storePhone;
    const logoUrl = branding?.logoUrl;

    // Logo printing with text fallback (Requirement 6.5)
    // IF organization logo is not configured or fails, display organization name in large text
    let logoPrinted = false;

    if (logoUrl && this.config.showLogo !== false) {
      // Attempt to print logo
      // Note: Full logo printing requires bitmap conversion which is handled in bitmap mode
      // For text mode, we fall back to text header
      try {
        console.log('[ReceiptGenerator] Logo URL configured but text mode does not support logo printing, using text fallback');
      } catch (e) {
        console.warn('[ReceiptGenerator] Logo printing failed, using text fallback:', e);
      }
    }

    // Text fallback: Organization name in large text (Requirement 6.5)
    if (!logoPrinted && storeName) {
      builder
        .doubleSize()
        .bold(true)
        .textLine(storeName)
        .bold(false)
        .normalSize();
    }

    // Organization info (Requirements 6.3)
    // Display organization address, city, postal code, and phone from profile settings
    if (storeAddress) {
      builder.textLine(storeAddress);
    }

    // City and postal code on same line (Requirement 6.3)
    if (storeCity || storePostalCode) {
      const cityLine = [storePostalCode, storeCity].filter(Boolean).join(' ');
      if (cityLine) {
        builder.textLine(cityLine);
      }
    }

    if (storePhone) {
      builder.textLine(this.t('receipt.header.tel') + ' ' + storePhone);
    }

    builder.alignLeft().thickLine().emptyLine();
  }

  private addOrderInfo(builder: EscPosBuilder, data: ReceiptData): void {
    builder.alignLeft();

    // Order number with bold formatting
    builder
      .doubleHeight()
      .bold(true)
      .textLine(this.t('receipt.order.orderNumber', { number: data.orderNumber }))
      .normalSize()
      .bold(false);

    const orderTypeLabel = this.formatOrderType(data.orderType);
    builder.twoColumnRow(this.t('receipt.order.type'), orderTypeLabel);

    if (data.orderType === 'delivery') {
      // Delivery order - show all customer details with BOLD labels
      if (data.customerName) {
        builder.bold(true).twoColumnRow(this.t('receipt.order.customer'), data.customerName).bold(false);
      }
      if (data.customerPhone) {
        builder.bold(true).twoColumnRow(this.t('receipt.order.phone'), data.customerPhone).bold(false);
      }

      // Address on SEPARATE LINES - Use separate fields if available
      builder.emptyLine();
      if (data.streetAddress) {
        // Use separate address fields (preferred)
        builder.bold(true).twoColumnRow(this.t('receipt.order.address'), data.streetAddress).bold(false);
        if (data.postalCode) {
          builder.bold(true).twoColumnRow(this.t('receipt.delivery.postCode'), data.postalCode).bold(false);
        }
        if (data.city) {
          builder.bold(true).twoColumnRow(this.t('receipt.delivery.city'), data.city).bold(false);
        }
        if (data.floorNumber) {
          builder.bold(true).twoColumnRow(this.t('receipt.delivery.floor'), data.floorNumber).bold(false);
        }
      } else if (data.deliveryAddress) {
        // Fallback: parse combined address string
        builder.bold(true).textLine(this.t('receipt.order.address')).bold(false);

        const addressParts = this.parseDeliveryAddress(data.deliveryAddress);

        if (addressParts.street) {
          builder.bold(true).textLine('  ' + addressParts.street).bold(false);
        }
        if (addressParts.city) {
          builder.bold(true).twoColumnRow(this.t('receipt.delivery.city'), addressParts.city).bold(false);
        }
        if (addressParts.postCode) {
          builder.bold(true).twoColumnRow(this.t('receipt.delivery.postCode'), addressParts.postCode).bold(false);
        }
        if (addressParts.floor) {
          builder.bold(true).twoColumnRow(this.t('receipt.delivery.floor'), addressParts.floor).bold(false);
        }

        // If no structured parsing worked, just show the raw address
        if (!addressParts.street && !addressParts.postCode && !addressParts.city) {
          builder.bold(true).textLine('  ' + data.deliveryAddress).bold(false);
        }
      }

      // Ringer name - BOLD
      if (data.ringerName) {
        builder.bold(true).twoColumnRow(this.t('receipt.delivery.ringer'), data.ringerName).bold(false);
      }

      // Delivery notes
      if (data.deliveryNotes) {
        builder.emptyLine();
        builder.bold(true).textLine(this.t('receipt.delivery.notes')).bold(false);
        builder.textLine('  ' + data.deliveryNotes);
      }

      // Driver name - BOLD
      if (data.driverName) {
        builder.emptyLine();
        builder.bold(true).textLine('🚗 ' + this.t('receipt.delivery.driver') + ' ' + data.driverName).bold(false);
      }
    } else {
      // Non-delivery orders
      if (data.tableName && data.orderType === 'dine-in') {
        builder.twoColumnRow(this.t('receipt.order.table'), data.tableName);
      }
      if (data.customerName) {
        builder.twoColumnRow(this.t('receipt.order.customer'), data.customerName);
      }
      if (data.customerPhone) {
        builder.twoColumnRow(this.t('receipt.order.phone'), data.customerPhone);
      }
    }

    builder.emptyLine();
    builder.twoColumnRow(this.t('receipt.order.date'), this.formatDate(data.timestamp));
    builder.dashedLine().emptyLine();
  }

  private addItemsSection(builder: EscPosBuilder, items: PrintOrderItem[]): void {
    builder.alignLeft();

    // Items header with bold formatting
    builder
      .bold(true)
      .threeColumnRow(
        this.t('receipt.items.item'),
        this.t('receipt.items.qty'),
        this.t('receipt.items.price')
      )
      .bold(false)
      .dashedLine();

    for (const item of items) {
      this.addItemLine(builder, item);
    }

    builder.dashedLine().emptyLine();
  }

  private addItemLine(builder: EscPosBuilder, item: PrintOrderItem): void {
    const priceStr = this.formatCurrency(item.total);
    const qtyStr = 'x' + item.quantity.toString();

    // Category name (if available) - shown above item name
    if (item.categoryName) {
      builder.textLine(item.categoryName.toUpperCase());
    }

    // Item name bold with quantity and price on same line
    builder.bold(true);
    builder.threeColumnRow(
      this.truncateText(item.name, this.lineWidth - qtyStr.length - priceStr.length - 4),
      qtyStr,
      priceStr
    );
    builder.bold(false);

    if (item.modifiers && item.modifiers.length > 0) {
      for (const modifier of item.modifiers) {
        if (typeof modifier === 'string') {
          builder.textLine('  + ' + modifier);
        } else {
          // Handle "without" items - show with ΧΩΡΙΣ: prefix and bold style
          if (modifier.isWithout) {
            builder.bold(true).textLine('  ΧΩΡΙΣ: ' + modifier.name).bold(false);
          } else {
            // Handle normal and "little" items
            const modName = modifier.name;
            const modQty = modifier.quantity && modifier.quantity > 1 ? ' x' + modifier.quantity : '';
            const littleSuffix = modifier.isLittle ? ' (λίγο)' : '';
            const modPrice = modifier.price ? this.formatCurrency(modifier.price) : '';
            // Two column: modifier name on left, price on right
            if (modifier.isLittle) {
              builder.bold(true);
            }
            if (modPrice) {
              builder.twoColumnRow('  + ' + modName + littleSuffix + modQty, modPrice);
            } else {
              builder.textLine('  + ' + modName + littleSuffix + modQty);
            }
            if (modifier.isLittle) {
              builder.bold(false);
            }
          }
        }
      }
    }

    if (item.specialInstructions) {
      builder
        .bold(true)
        .textLine('  * ' + item.specialInstructions)
        .bold(false);
    }
  }

  private addTotalsSection(builder: EscPosBuilder, data: ReceiptData): void {
    builder.alignLeft();

    builder.twoColumnRow(this.t('receipt.totals.subtotal'), this.formatCurrency(data.subtotal));
    builder.twoColumnRow(this.t('receipt.totals.tax'), this.formatCurrency(data.tax));

    if (data.deliveryFee && data.deliveryFee > 0) {
      builder.twoColumnRow(this.t('receipt.totals.deliveryFee'), this.formatCurrency(data.deliveryFee));
    }

    // Show discount (as negative amount) - Text mode
    if (data.discount && data.discount > 0) {
      const discountLabel = this.t('receipt.totals.discount') || 'Έκπτωση';
      const percentageText = data.discountPercentage ? ` (${data.discountPercentage}%)` : '';
      builder.twoColumnRow(discountLabel + percentageText, '-' + this.formatCurrency(data.discount));
    }

    if (data.tip && data.tip > 0) {
      builder.twoColumnRow(this.t('receipt.totals.tip'), this.formatCurrency(data.tip));
    }

    builder.thickLine();

    // Total with prominent formatting
    builder
      .bold(true)
      .doubleHeight()
      .twoColumnRow(this.t('receipt.totals.total'), this.formatCurrency(data.total))
      .normalSize()
      .bold(false);

    builder.thickLine().emptyLine();
  }

  private addPaymentInfo(builder: EscPosBuilder, data: ReceiptData): void {
    builder.alignLeft();
    const paymentLabel = this.formatPaymentMethod(data.paymentMethod);
    builder.leftRightBold(this.t('receipt.payment.payment'), paymentLabel);
    builder.emptyLine();
  }

  private formatPaymentMethod(paymentMethod: string): string {
    const methodMap: Record<string, string> = {
      'cash': 'cash',
      'card': 'card',
      'online': 'online',
    };
    const methodKey = methodMap[paymentMethod.toLowerCase()] || paymentMethod.toLowerCase();
    const translationKey = 'receipt.payment.' + methodKey;
    const translated = this.t(translationKey);
    return translated === translationKey ? paymentMethod : translated;
  }

  private addReceiptFooter(builder: EscPosBuilder): void {
    builder.thickLine().alignCenter();

    if (this.config.footerMessage) {
      builder.textLine(this.config.footerMessage);
    } else {
      builder.textLine(this.t('receipt.header.thankYou'));
    }

    builder.emptyLines(2);
  }


  // ==========================================================================
  // Kitchen Ticket Generation
  // ==========================================================================

  generateKitchenTicket(data: KitchenTicketData): Buffer {
    const characterSet = this.config.characterSet || 'PC437_USA';
    const builder = new EscPosBuilder(this.config.paperSize, characterSet);

    builder.initialize();
    
    // Set the code page based on the configured character set
    const codePageNumber = CODE_PAGE_NUMBERS[characterSet] || 0;
    builder.raw([0x1B, 0x74, codePageNumber]);  // ESC t n - Select code page
    
    // Enable Greek encoding if using a Greek character set
    if (characterSet.includes('GREEK')) {
      builder.enableGreekEncoding();
      builder.setCharacterSetType(characterSet);
    }

    this.addKitchenHeader(builder, data);
    this.addKitchenItems(builder, data.items);

    if (data.specialInstructions) {
      this.addSpecialInstructions(builder, data.specialInstructions);
    }

    this.addKitchenFooter(builder, data);
    builder.cut();

    return builder.build();
  }

  private addKitchenHeader(builder: EscPosBuilder, data: KitchenTicketData): void {
    // Station name as prominent title
    builder
      .thickLine()
      .alignCenter()
      .doubleSize()
      .bold(true)
      .textLine(data.station.toUpperCase())
      .bold(false)
      .normalSize()
      .alignLeft()
      .thickLine();

    // Order number with prominent formatting
    builder
      .emptyLine()
      .doubleHeight()
      .bold(true)
      .textLine(this.t('receipt.order.orderNumber', { number: data.orderNumber }))
      .normalSize()
      .bold(false);

    const orderTypeLabel = this.formatOrderType(data.orderType);
    builder.twoColumnRow(this.t('receipt.order.type'), orderTypeLabel);

    if (data.tableName) {
      builder
        .bold(true)
        .twoColumnRow(this.t('receipt.order.table'), data.tableName)
        .bold(false);
    } else if (data.customerName) {
      builder.twoColumnRow(this.t('receipt.order.customer'), data.customerName);
    }

    builder.dashedLine().emptyLine();
  }

  private addKitchenItems(builder: EscPosBuilder, items: PrintOrderItem[]): void {
    builder.alignLeft();

    for (const item of items) {
      // Item with quantity - prominent formatting
      builder
        .doubleHeight()
        .bold(true)
        .textLine(item.quantity + 'x ' + item.name)
        .normalSize()
        .bold(false);

      if (item.modifiers && item.modifiers.length > 0) {
        for (const modifier of item.modifiers) {
          const modName = typeof modifier === 'string' ? modifier : modifier.name;
          builder.indentedText(this.t('receipt.items.modifier', { name: modName }), 3);
        }
      }

      if (item.specialInstructions) {
        const instructions = this.t('receipt.items.specialInstructions', { instructions: item.specialInstructions }).replace(/^\* /, '');
        builder
          .bold(true)
          .indentedText('** ' + instructions + ' **', 3)
          .bold(false);
      }

      builder.emptyLine();
    }

    builder.dashedLine();
  }

  private addSpecialInstructions(builder: EscPosBuilder, instructions: string): void {
    builder
      .emptyLine()
      .centeredBold(this.t('receipt.kitchen.specialInstructions'))
      .alignLeft()
      .textLine(instructions)
      .emptyLine()
      .dashedLine();
  }

  private addKitchenFooter(builder: EscPosBuilder, data: KitchenTicketData): void {
    builder
      .alignCenter()
      .textLine(this.formatDate(data.timestamp))
      .emptyLines(2);
  }


  // ==========================================================================
  // Test Print Generation
  // ==========================================================================

  generateTestPrint(printerName: string = 'Test Printer'): Buffer {
    const characterSet = this.config.characterSet || 'PC437_USA';
    const builder = new EscPosBuilder(this.config.paperSize, characterSet);

    builder.initialize();
    
    // Set the code page based on the configured character set
    const codePageNumber = CODE_PAGE_NUMBERS[characterSet] || 0;
    builder.raw([0x1B, 0x74, codePageNumber]);  // ESC t n - Select code page
    
    // Enable Greek encoding if using a Greek character set
    if (characterSet.includes('GREEK')) {
      builder.enableGreekEncoding();
      builder.setCharacterSetType(characterSet);
    }

    builder
      .alignCenter()
      .doubleLine()
      .doubleSize()
      .bold(true)
      .textLine(this.t('receipt.test.title'))
      .normalSize()
      .bold(false)
      .doubleLine()
      .emptyLines(1);

    builder
      .alignLeft()
      .textLine(this.t('receipt.test.printer') + ' ' + printerName)
      .textLine(this.t('receipt.test.paperSize') + ' ' + this.config.paperSize)
      .textLine(this.t('receipt.test.lineWidth') + ' ' + this.lineWidth + ' ' + this.t('receipt.test.chars'))
      .textLine(this.t('receipt.test.characterSet') + ' ' + characterSet)
      .textLine(this.t('receipt.order.date') + ' ' + this.formatDate(new Date()))
      .emptyLines(1)
      .horizontalLine()
      .emptyLines(1);

    builder
      .alignCenter()
      .textLine(this.t('receipt.test.textFormatting'))
      .horizontalLine()
      .alignLeft();

    builder.textLine(this.t('receipt.test.normalText'));
    builder.bold(true).textLine(this.t('receipt.test.boldText')).bold(false);
    builder.underline(1).textLine(this.t('receipt.test.underlinedText')).underline(0);
    builder.doubleWidth().textLine(this.t('receipt.test.doubleWidth')).normalSize();
    builder.doubleHeight().textLine(this.t('receipt.test.doubleHeight')).normalSize();
    builder.doubleSize().textLine(this.t('receipt.test.doubleSize')).normalSize();

    builder.emptyLines(1).horizontalLine().emptyLines(1);

    builder.alignCenter().textLine(this.t('receipt.test.alignment')).horizontalLine();
    builder.alignLeft().textLine(this.t('receipt.test.leftAligned'));
    builder.alignCenter().textLine(this.t('receipt.test.centerAligned'));
    builder.alignRight().textLine(this.t('receipt.test.rightAligned'));

    builder.emptyLines(1).horizontalLine().emptyLines(1);

    builder.alignCenter().textLine(this.t('receipt.test.lineDrawing')).horizontalLine();
    builder.alignLeft();
    builder.textLine(this.t('receipt.test.dashedLine'));
    builder.horizontalLine();
    builder.textLine(this.t('receipt.test.doubleLine'));
    builder.doubleLine();
    builder.textLine(this.t('receipt.test.dottedLine'));
    builder.dottedLine();

    builder.emptyLines(1);

    builder.textLine(this.t('receipt.test.twoColumn'));
    builder.twoColumnRow(this.t('receipt.test.leftText'), this.t('receipt.test.rightText'));
    builder.twoColumnRow(this.t('receipt.test.itemName'), this.formatCurrency(9.99));
    builder.twoColumnRow(this.t('receipt.test.longerItemName'), this.formatCurrency(12.50));

    builder.emptyLines(1).doubleLine();

    builder
      .alignCenter()
      .bold(true)
      .textLine(this.t('receipt.test.success'))
      .bold(false)
      .emptyLines(2);

    builder.cut();

    return builder.build();
  }

  // ==========================================================================
  // Utility Methods
  // ==========================================================================

  private formatCurrency(amount: number): string {
    const currency = this.config.currency || '€';
    const symbol = getCurrencySymbol(currency);
    return symbol + amount.toFixed(2);
  }

  private formatDate(date: Date): string {
    const d = new Date(date);
    const language = this.config.language || 'en';
    const locale = language === 'el' ? 'el-GR' : 'en-US';
    const hour12 = language !== 'el';
    return d.toLocaleString(locale, {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: hour12,
    });
  }

  private formatOrderType(orderType: string): string {
    const typeMap: Record<string, string> = {
      'dine-in': 'dineIn',
      'pickup': 'pickup',
      'delivery': 'delivery',
    };
    const typeKey = typeMap[orderType] || orderType;
    return this.t('receipt.orderTypes.' + typeKey);
  }

  private truncateText(text: string, maxLength: number): string {
    if (text.length <= maxLength) {
      return text;
    }
    return text.substring(0, maxLength - 3) + '...';
  }

  /**
   * Parse delivery address string into structured components
   * Tries to extract: street, postCode, city, floor, ringer, notes
   */
  private parseDeliveryAddress(address: string): {
    street?: string;
    postCode?: string;
    city?: string;
    floor?: string;
    ringer?: string;
    notes?: string;
  } {
    const result: {
      street?: string;
      postCode?: string;
      city?: string;
      floor?: string;
      ringer?: string;
      notes?: string;
    } = {};

    // Try to parse structured address
    // Common formats:
    // "Street 123, 54641 Thessaloniki, Floor: 2"
    // "Street 123, PostCode City, Floor: X, Ringer: Name"
    
    let remaining = address;

    // Extract floor (Floor: X or Όροφος: X)
    const floorMatch = remaining.match(/(?:Floor|Όροφος|floor|όροφος)[:\s]+([^,]+)/i);
    if (floorMatch) {
      result.floor = floorMatch[1].trim();
      remaining = remaining.replace(floorMatch[0], '');
    }

    // Extract ringer/doorbell (Ringer: X or Κουδούνι: X)
    const ringerMatch = remaining.match(/(?:Ringer|Κουδούνι|ringer|κουδούνι|Bell|bell)[:\s]+([^,]+)/i);
    if (ringerMatch) {
      result.ringer = ringerMatch[1].trim();
      remaining = remaining.replace(ringerMatch[0], '');
    }

    // Extract notes (Notes: X or Σημειώσεις: X)
    const notesMatch = remaining.match(/(?:Notes|Σημειώσεις|notes|σημειώσεις)[:\s]+(.+)$/i);
    if (notesMatch) {
      result.notes = notesMatch[1].trim();
      remaining = remaining.replace(notesMatch[0], '');
    }

    // Clean up remaining address
    remaining = remaining.replace(/,\s*,/g, ',').replace(/,\s*$/, '').replace(/^\s*,/, '').trim();

    // Split remaining by comma
    const parts = remaining.split(',').map(p => p.trim()).filter(p => p.length > 0);

    if (parts.length >= 1) {
      result.street = parts[0];
    }
    
    if (parts.length >= 2) {
      // Second part might be "PostCode City" or just city
      const secondPart = parts[1];
      const postCodeMatch = secondPart.match(/^(\d{3}\s?\d{2})\s*(.*)$/);
      if (postCodeMatch) {
        result.postCode = postCodeMatch[1];
        result.city = postCodeMatch[2] || undefined;
      } else {
        result.city = secondPart;
      }
    }

    if (parts.length >= 3 && !result.city) {
      result.city = parts[2];
    }

    return result;
  }
}
