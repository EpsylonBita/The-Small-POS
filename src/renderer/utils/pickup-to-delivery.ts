import type { Customer, CustomerAddress } from '../../shared/types/customer';
import type { Order } from '../../shared/types/orders';
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
  };
};

const toNumber = (value: unknown): number => {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : 0;
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
  return Math.max(0, existingTotal - existingDeliveryFee + deliveryFee);
};
