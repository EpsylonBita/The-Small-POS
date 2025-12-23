/**
 * Order Number Utility Functions
 * 
 * Provides functions for generating, validating, and parsing order numbers.
 * Order numbers follow the format: ORD-YYYYMMDD-NNNN
 * 
 * Requirements: 7.1, 8.5
 */

/**
 * Regular expression pattern for valid order numbers.
 * Format: ORD-YYYYMMDD-NNNN (or ORD-YYYYMMDD-NNNNNN for legacy 6-digit)
 * - ORD- prefix
 * - YYYYMMDD date (8 digits)
 * - NNNN sequence number (4-6 digits for compatibility)
 */
export const ORDER_NUMBER_PATTERN = /^ORD-(\d{8})-(\d{4,6})$/;

/**
 * Strict pattern for new order numbers (4-digit sequence)
 * Format: ORD-YYYYMMDD-NNNN
 */
export const ORDER_NUMBER_STRICT_PATTERN = /^ORD-(\d{8})-(\d{4})$/;

/**
 * Parsed order number components
 */
export interface ParsedOrderNumber {
  year: number;
  month: number;
  day: number;
  sequence: number;
  dateString: string;
}

/**
 * Generates an order number in the format ORD-YYYYMMDD-NNNN
 * 
 * Requirements: 7.1, 8.5
 * 
 * @param date - The date for the order (defaults to current date)
 * @param sequence - The sequence number (1-9999, will be clamped)
 * @returns Order number string in format ORD-YYYYMMDD-NNNN
 */
export function generateOrderNumber(date: Date = new Date(), sequence: number = 1): string {
  // Clamp sequence to valid range (1-9999)
  const clampedSequence = Math.max(1, Math.min(9999, Math.floor(sequence)));
  
  // Format date as YYYYMMDD
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const dateString = `${year}${month}${day}`;
  
  // Format sequence as 4-digit zero-padded number
  const sequenceString = String(clampedSequence).padStart(4, '0');
  
  return `ORD-${dateString}-${sequenceString}`;
}

/**
 * Validates an order number format.
 * Accepts both strict (4-digit) and legacy (6-digit) sequence formats.
 * 
 * Requirements: 7.1, 8.5
 * 
 * @param orderNumber - The order number to validate
 * @returns true if the order number matches the expected format
 */
export function validateOrderNumberFormat(orderNumber: string): boolean {
  if (!orderNumber || typeof orderNumber !== 'string') {
    return false;
  }
  
  const match = orderNumber.match(ORDER_NUMBER_PATTERN);
  if (!match) {
    return false;
  }
  
  // Validate date components
  const dateString = match[1];
  const year = parseInt(dateString.substring(0, 4), 10);
  const month = parseInt(dateString.substring(4, 6), 10);
  const day = parseInt(dateString.substring(6, 8), 10);
  
  // Basic date validation
  if (year < 2020 || year > 2100) return false;
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > 31) return false;
  
  // More precise day validation based on month
  const daysInMonth = new Date(year, month, 0).getDate();
  if (day > daysInMonth) return false;
  
  return true;
}

/**
 * Validates an order number format strictly (4-digit sequence only).
 * 
 * Requirements: 7.1, 8.5
 * 
 * @param orderNumber - The order number to validate
 * @returns true if the order number matches the strict format
 */
export function validateOrderNumberFormatStrict(orderNumber: string): boolean {
  if (!orderNumber || typeof orderNumber !== 'string') {
    return false;
  }
  
  const match = orderNumber.match(ORDER_NUMBER_STRICT_PATTERN);
  if (!match) {
    return false;
  }
  
  // Validate date components
  const dateString = match[1];
  const year = parseInt(dateString.substring(0, 4), 10);
  const month = parseInt(dateString.substring(4, 6), 10);
  const day = parseInt(dateString.substring(6, 8), 10);
  
  // Basic date validation
  if (year < 2020 || year > 2100) return false;
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > 31) return false;
  
  // More precise day validation based on month
  const daysInMonth = new Date(year, month, 0).getDate();
  if (day > daysInMonth) return false;
  
  return true;
}

/**
 * Parses an order number into its components.
 * 
 * Requirements: 7.1, 8.5
 * 
 * @param orderNumber - The order number to parse
 * @returns Parsed components or null if invalid
 */
export function parseOrderNumber(orderNumber: string): ParsedOrderNumber | null {
  if (!validateOrderNumberFormat(orderNumber)) {
    return null;
  }
  
  const match = orderNumber.match(ORDER_NUMBER_PATTERN);
  if (!match) {
    return null;
  }
  
  const dateString = match[1];
  const sequenceString = match[2];
  
  return {
    year: parseInt(dateString.substring(0, 4), 10),
    month: parseInt(dateString.substring(4, 6), 10),
    day: parseInt(dateString.substring(6, 8), 10),
    sequence: parseInt(sequenceString, 10),
    dateString: dateString,
  };
}

/**
 * Normalizes an order number to ensure consistent display.
 * Handles both snake_case (order_number) and camelCase (orderNumber) field names.
 * 
 * Requirements: 7.6, 7.7
 * 
 * @param order - Order object with order_number or orderNumber field
 * @returns The order number string or empty string if not found
 */
export function getOrderNumber(order: { order_number?: string; orderNumber?: string } | null | undefined): string {
  if (!order) return '';
  return order.order_number || order.orderNumber || '';
}

/**
 * Formats an order number for display (adds # prefix if not present).
 * 
 * @param orderNumber - The order number to format
 * @returns Formatted order number for display
 */
export function formatOrderNumberForDisplay(orderNumber: string): string {
  if (!orderNumber) return '';
  return orderNumber.startsWith('#') ? orderNumber : `#${orderNumber}`;
}
