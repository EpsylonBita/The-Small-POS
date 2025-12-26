/**
 * Receipt Templates Index
 * 
 * Exports all receipt template functions for checkout and report generation.
 * Each template provides both:
 * - Buffer-based function (new): Returns ESC/POS formatted Buffer for direct printing
 * - String-based function (legacy): Returns plain text string for backward compatibility
 */

// Base template class and utilities
export { 
  BaseReceiptTemplate, 
  DEFAULT_RECEIPT_CONFIG,
  createConfigFromWidth 
} from './BaseReceiptTemplate';

export type { ReceiptTemplateConfig } from './BaseReceiptTemplate';

// Z-Report templates
export { 
  generateZReportReceipt,
  generateZReportReceiptBuffer 
} from './z-report-template';

// Cashier Checkout templates
export { 
  generateCashierCheckoutReceipt,
  generateCashierCheckoutReceiptBuffer 
} from './cashier-checkout-template';

// Driver Checkout templates
export { 
  generateDriverCheckoutReceipt,
  generateDriverCheckoutReceiptBuffer 
} from './driver-checkout-template';

// Waiter Checkout templates
export { 
  generateWaiterCheckoutReceipt,
  generateWaiterCheckoutReceiptBuffer 
} from './waiter-checkout-template';

// Kitchen Checkout templates
export { 
  generateKitchenCheckoutReceipt,
  generateKitchenCheckoutReceiptBuffer 
} from './kitchen-checkout-template';

// Assign Order templates
export { 
  generateAssignOrderReceipt,
  generateAssignOrderReceiptBuffer 
} from './assign-order-template';

export type { AssignOrderData } from './assign-order-template';

// Re-export ReceiptTemplateConfig from printer types for convenience
export type { ReceiptTemplateConfig as PrinterReceiptTemplateConfig } from '../printer/types';
