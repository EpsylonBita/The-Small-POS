/**
 * PricingService (POS-local stub)
 * 
 * Provides pricing utilities for menu items based on order type.
 */

export type OrderType = 'dine-in' | 'takeaway' | 'delivery' | 'pickup';

export interface MenuItem {
  id: string;
  name: string;
  price: number;
  dine_in_price?: number | null;
  takeaway_price?: number | null;
  delivery_price?: number | null;
}

/**
 * Get the appropriate price for a menu item based on order type
 */
export function getMenuItemPrice(item: MenuItem, orderType?: OrderType): number {
  if (!item) return 0;
  
  // Default to base price
  let price = item.price || 0;
  
  if (orderType === 'dine-in' && item.dine_in_price != null) {
    price = item.dine_in_price;
  } else if ((orderType === 'takeaway' || orderType === 'pickup') && item.takeaway_price != null) {
    price = item.takeaway_price;
  } else if (orderType === 'delivery' && item.delivery_price != null) {
    price = item.delivery_price;
  }
  
  return price;
}
