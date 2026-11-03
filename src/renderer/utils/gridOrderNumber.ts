import { formatCompactOrderNumberForDisplay, getVisibleOrderNumber } from './orderNumberUtils';
import { resolveFoodDeliveryShortCode } from './foodDeliveryMetadata';

const KIOSK_ORDER_NUMBER_PATTERN = /^#?[A-Za-z]+-[A-Za-z0-9]{1,16}-\d{8}-\d{6}-\d+$/;
const KIOSK_SHORT_ORDER_NUMBER_PATTERN = /^#?K[A-Za-z]*-\d+$/i;

export type GridOrderNumberSource = {
  id?: string | null;
  order_id?: string | null;
  created_at?: string | null;
  createdAt?: string | null;
  display_order_number?: string;
  displayOrderNumber?: string;
  order_number?: string;
  orderNumber?: string;
};

/**
 * The order number exactly as the order grid card shows it: «#00003» for the register's
 * ORD-DDMMYYYY-00003 (no date in front), efood's «#4545», a waiter phone's «#M1-0042», a kiosk «KIOSK #12».
 * Founder 01/11: every other place that names an order (the shift checkout's order history among them)
 * shows this same number.
 */
export function formatGridOrderNumber(order: GridOrderNumberSource | null | undefined): string {
  if (!order) return '';
  // Platform orders headline the rider-facing 4-digit short code (efood's
  // «#4545»), never the long external order id embedded in order_number.
  const platformShortCode = resolveFoodDeliveryShortCode(order);
  if (platformShortCode) {
    return `#${platformShortCode}`;
  }
  const orderNum = getVisibleOrderNumber(order);
  if (orderNum) {
    const trimmedOrderNum = orderNum.trim();
    const isHashedFallbackNumber = /^#?[A-Za-z]+-\d{8}-[a-f0-9]{32}$/i.test(trimmedOrderNum);
    if (isHashedFallbackNumber) {
      const compactFallbackNumber = formatCompactOrderNumberForDisplay(
        trimmedOrderNum,
        order.created_at || order.createdAt,
      );
      // The fallback already reads «ORD #0ZF4…»: never prefix a second # («#ORD #…», founder 31/10).
      return compactFallbackNumber.includes('#')
        ? compactFallbackNumber
        : `#${compactFallbackNumber}`;
    }

    if (
      KIOSK_ORDER_NUMBER_PATTERN.test(trimmedOrderNum) ||
      KIOSK_SHORT_ORDER_NUMBER_PATTERN.test(trimmedOrderNum)
    ) {
      return formatCompactOrderNumberForDisplay(
        trimmedOrderNum,
        order.created_at || order.createdAt,
      );
    }

    // Satellite display code (e.g. M1-0042, minted by a waiter phone):
    // the terminal marker IS the point — never strip it down to #0042.
    if (/^[A-Za-z0-9]{1,4}-\d{1,6}$/.test(trimmedOrderNum)) {
      return `#${trimmedOrderNum.toUpperCase()}`;
    }

    // If it's already formatted like "POS-20251212-0001", extract the last part
    if (orderNum.includes('-')) {
      const parts = orderNum.split('-');
      const lastPart = parts[parts.length - 1];
      // If the last part is numeric, format it as #XX
      if (/^\d+$/.test(lastPart)) {
        return `#${lastPart.padStart(2, '0')}`;
      }
    }
    // If it's just a number, format it
    if (/^\d+$/.test(orderNum)) {
      return `#${orderNum.padStart(2, '0')}`;
    }
    // Otherwise return as-is with # prefix
    return orderNum.startsWith('#') ? orderNum : `#${orderNum}`;
  }
  // Fallback to ID-based number if no order_number exists
  const shortId = (order.id || order.order_id || '').slice(-4) || '00';
  return `#${shortId}`;
}
