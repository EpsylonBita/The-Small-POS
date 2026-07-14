import type { Customer, CustomerAddress } from '../../shared/types/customer';
import type { Order } from '../../shared/types/orders';
import { resolveCartLineUnitPrice, reconcileHydratedUnitPrice } from './edit-order-pricing';
import { resolvePersistedCustomerId } from './persisted-customer-id';

export interface ResolvedPickupToDeliveryAddress {
  addressId: string | null;
  customerId: string | null;
  streetAddress: string;
  city: string;
  postalCode: string;
  floor: string;
  notes: string;
  nameOnRinger: string;
  coordinates:
    | { lat: number; lng: number }
    | { type: 'Point'; coordinates: [number, number] }
    | null;
  latitude: number | null;
  longitude: number | null;
  addressFingerprint: string | null;
  deliveryZoneId: string | null;
}

type PickupToDeliveryCustomer = Customer & {
  selected_address_id?: string | null;
  city?: string | null;
  postal_code?: string | null;
  floor_number?: string | null;
  notes?: string | null;
};

const normalizeText = (value: string | null | undefined): string => {
  return typeof value === 'string' ? value.trim() : '';
};

const resolveStreet = (address?: Partial<CustomerAddress> | null): string => {
  return normalizeText(address?.street_address) || normalizeText(address?.street);
};

const resolveSelectedAddress = (
  customer: PickupToDeliveryCustomer,
): Partial<CustomerAddress> | null => {
  const addresses = Array.isArray(customer.addresses) ? customer.addresses : [];
  if (addresses.length === 0) {
    return null;
  }

  const selectedAddressId = normalizeText(customer.selected_address_id || undefined);
  if (selectedAddressId) {
    const selectedAddress = addresses.find((address) => address.id === selectedAddressId);
    if (selectedAddress) {
      return selectedAddress;
    }
  }

  return addresses.find((address) => address.is_default) || addresses[0] || null;
};

export const resolvePickupToDeliveryAddress = (
  customer: PickupToDeliveryCustomer | null | undefined,
): ResolvedPickupToDeliveryAddress | null => {
  if (!customer) {
    return null;
  }

  const selectedAddress = resolveSelectedAddress(customer);
  const streetAddress = resolveStreet(selectedAddress) || normalizeText(customer.address || undefined);
  if (!streetAddress) {
    return null;
  }

  return {
    addressId: normalizeText(selectedAddress?.id) || null,
    customerId: resolvePersistedCustomerId(
      selectedAddress?.customer_id,
      customer.id,
    ),
    streetAddress,
    city: normalizeText(selectedAddress?.city) || normalizeText(customer.city || undefined),
    postalCode:
      normalizeText(selectedAddress?.postal_code) || normalizeText(customer.postal_code || undefined),
    floor:
      normalizeText(selectedAddress?.floor_number) || normalizeText(customer.floor_number || undefined),
    notes:
      normalizeText(selectedAddress?.delivery_notes) ||
      normalizeText(selectedAddress?.notes) ||
      normalizeText(customer.notes || undefined),
    nameOnRinger:
      normalizeText(selectedAddress?.name_on_ringer) ||
      normalizeText(customer.name_on_ringer || undefined),
    coordinates: selectedAddress?.coordinates ?? customer.coordinates ?? null,
    latitude:
      selectedAddress?.latitude ??
      (Number.isFinite(Number(customer.latitude)) ? Number(customer.latitude) : null),
    longitude:
      selectedAddress?.longitude ??
      (Number.isFinite(Number(customer.longitude)) ? Number(customer.longitude) : null),
    addressFingerprint:
      normalizeText(selectedAddress?.address_fingerprint) ||
      normalizeText(customer.address_fingerprint || undefined) ||
      null,
    deliveryZoneId:
      normalizeText((selectedAddress as any)?.delivery_zone_id) ||
      normalizeText((customer as any)?.delivery_zone_id) ||
      null,
  };
};

const toNumber = (value: unknown): number => {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : 0;
};

const resolveOrderItems = (order: Partial<Order>): any[] => {
  const rawItems = (order as Partial<Order> & { items?: unknown }).items;
  return Array.isArray(rawItems) ? rawItems : [];
};

const itemQuantity = (item: any): number => {
  const quantity = Number(item?.quantity ?? 1);
  return Number.isFinite(quantity) && quantity > 0 ? quantity : 1;
};

const currentItemLineTotal = (item: any): number => {
  const explicitTotal = Number(item?.total_price ?? item?.totalPrice);
  if (Number.isFinite(explicitTotal)) {
    return explicitTotal;
  }

  return toNumber(item?.unit_price ?? item?.unitPrice ?? item?.price) * itemQuantity(item);
};

const asFinite = (value: unknown): number | undefined => {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
};

const deliveryItemUnitPrice = (item: any): number => {
  // Free offer-reward lines stay free and operator price overrides stay
  // as set — re-inflating either from catalog tiers on conversion would
  // charge the customer for a promised free item or undo the operator's
  // explicit pricing.
  if (
    item?.is_offer_reward === true ||
    item?.auto_added_by_offer === true ||
    item?.is_price_overridden === true ||
    item?.isPriceOverridden === true
  ) {
    return toNumber(item?.unit_price ?? item?.unitPrice ?? item?.price);
  }

  // Tier base + the line's ingredient tier prices — retiering to delivery
  // must not flatten customized lines to the bare subcategory price. Only
  // items that carry a genuine bare base/tier field can take this path;
  // slim synced shapes store the COMBINED price under `price`, and adding
  // the customization component on top would double-count it.
  const bareBase =
    asFinite(item?.base_price) ?? asFinite(item?.basePrice);
  const hasBareTier =
    bareBase !== undefined ||
    [item?.delivery_price, item?.deliveryPrice, item?.pickup_price, item?.pickupPrice].some(
      (value) => asFinite(value) !== undefined,
    );
  if (hasBareTier) {
    return resolveCartLineUnitPrice(
      {
        ...item,
        price: bareBase ?? item?.price ?? item?.unit_price ?? item?.unitPrice,
      },
      item?.customizations,
      'delivery',
    ).unitPrice;
  }

  // Legacy fallback: no bare tier data on record — keep the stored
  // (possibly combined) price rather than fabricating a retier. Kiosk
  // rows store unit_price base-only with an ingredient-inclusive
  // total_price, so reconcile upward against the line total; combined
  // and discounted lines are untouched by the upward-only reconcile.
  const fallback = resolveCartLineUnitPrice(
    {
      ...item,
      price: item?.price ?? item?.unit_price ?? item?.unitPrice,
    },
    null,
    'delivery',
  );
  return reconcileHydratedUnitPrice(
    fallback.unitPrice,
    item?.total_price ?? item?.totalPrice,
    itemQuantity(item),
  );
};

export const getPickupToDeliveryValidationAmount = (order: Partial<Order>): number => {
  const legacyOrder = order as Partial<Order> & {
    discountAmount?: number;
    delivery_fee?: number;
  };
  const subtotal = toNumber(order.subtotal);
  const discountAmount = toNumber(order.discount_amount ?? legacyOrder.discountAmount);
  if (subtotal > 0) {
    return Math.max(0, subtotal - discountAmount);
  }

  const totalAmount = toNumber(order.totalAmount ?? order.total_amount);
  const existingDeliveryFee = toNumber(order.deliveryFee ?? legacyOrder.delivery_fee);
  return Math.max(0, totalAmount - existingDeliveryFee);
};

export const calculatePickupToDeliveryTotal = (
  order: Partial<Order>,
  deliveryFee: number,
): number => {
  const legacyOrder = order as Partial<Order> & {
    delivery_fee?: number;
  };
  const existingTotal = toNumber(order.totalAmount ?? order.total_amount);
  const existingDeliveryFee = toNumber(order.deliveryFee ?? legacyOrder.delivery_fee);
  const items = resolveOrderItems(order);

  if (items.length === 0) {
    return Math.max(0, existingTotal - existingDeliveryFee + deliveryFee);
  }

  const currentItemsTotal = items.reduce(
    (sum, item) => sum + currentItemLineTotal(item),
    0,
  );
  const deliveryItemsTotal = items.reduce(
    (sum, item) => sum + deliveryItemUnitPrice(item) * itemQuantity(item),
    0,
  );
  const nonItemOffset = existingTotal - existingDeliveryFee - currentItemsTotal;

  return Number(
    Math.max(0, deliveryItemsTotal + nonItemOffset + deliveryFee).toFixed(2),
  );
};
