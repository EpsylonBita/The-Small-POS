/**
 * Which orders the Orders screen of this register works on.
 *
 * The business type picks the dashboard layout (food / service / product) and
 * the food layout narrows the order list to food orders. That same narrowing
 * decides which pending platform orders the register is asked to accept, so
 * it lives here, in one place, for both the dashboard and the app-shell
 * incoming-order alert (IncomingOrderAlertManager): the alert must never ring for
 * an order the Orders screen would not offer to approve.
 */
import type { BusinessType } from '../../../shared/types/organization';
import type { Order } from '../../types/orders';

export type BusinessCategory = 'food' | 'service' | 'product';

/**
 * Maps business types to their business categories.
 * This mapping determines which dashboard layout is used.
 */
export const BUSINESS_TYPE_TO_CATEGORY: Record<BusinessType, BusinessCategory> = {
  // Food businesses - order-focused, kitchen operations
  restaurant: 'food',
  fast_food: 'food',
  bar_cafe: 'food',
  food_truck: 'food',
  chain: 'food',
  franchise: 'food',
  cafe: 'food',
  bar: 'food',
  bakery: 'food',
  catering: 'food',
  ghost_kitchen: 'food',

  // Service businesses - appointment/booking-focused
  salon: 'service',
  spa: 'service',
  barbershop: 'service',
  beauty_salon: 'service',
  wellness: 'service',
  fitness: 'service',
  clinic: 'service',
  dental: 'service',
  medical_clinic: 'service',
  veterinary: 'service',
  physiotherapy: 'service',
  hotel: 'service',
  hotel_restaurant: 'service',

  // Product businesses - inventory/retail-focused
  retail: 'product',
  shop: 'product',
  boutique: 'product',
  convenience: 'product',
  grocery: 'product',
};

/**
 * Get the business category for a given business type
 */
export function getBusinessCategory(businessType: BusinessType | null | undefined): BusinessCategory {
  if (!businessType) {
    return 'food'; // Default to food dashboard
  }
  return BUSINESS_TYPE_TO_CATEGORY[businessType] || 'food';
}

/**
 * The food dashboard's order scope: every order without retail product lines.
 * An order with no lines yet stays in scope.
 */
export function foodOrderFilter(order: Order): boolean {
  const items = Array.isArray(order.items) ? order.items : [];

  if (items.length === 0) {
    return true;
  }

  return !items.some((item) => {
    const candidate = item as any;
    return Boolean(
      candidate.product_id ||
      candidate.productId ||
      candidate.retail_product_id ||
      candidate.product_name ||
      candidate.productName
    );
  });
}

/**
 * The order filter the category's dashboard passes to OrderDashboard
 * (`undefined` = every order).
 */
export function getDashboardOrderFilter(
  category: BusinessCategory,
): ((order: Order) => boolean) | undefined {
  return category === 'food' ? foodOrderFilter : undefined;
}
