import type { EditCustomerInfoFormData } from '../components/modals/EditCustomerInfoModal';
import { toValidLatLng } from './coordinates';
import { resolvePersistedCustomerId } from './persisted-customer-id';
import { parseSpecialAddressInput } from './specialAddress';

const text = (...values: unknown[]): string => values.find(value => typeof value === 'string' && value.trim()) as string || '';
const trimmed = (value: unknown): string => typeof value === 'string' ? value.trim() : '';

/** Destination identity excludes contact/access instructions such as floor and bell. */
export function isSameCustomerEditDestination(a: EditCustomerInfoFormData, b: EditCustomerInfoFormData): boolean {
  return ['address', 'city', 'postal_code'].every(key => trimmed(a[key as keyof typeof a]) === trimmed(b[key as keyof typeof b]));
}

/** Read only the order's own location or its exact linked customer-address row. */
export function orderCustomerEditSnapshot(order: any): EditCustomerInfoFormData {
  const nested = [order?.deliveryAddress, order?.delivery_address, order?.address].find(value => value && typeof value === 'object');
  const address = text(order?.deliveryAddress, order?.delivery_address, order?.address, nested?.street_address, nested?.street, nested?.address);
  const city = text(order?.deliveryCity, order?.delivery_city, nested?.city);
  const postal = text(order?.deliveryPostalCode, order?.delivery_postal_code, order?.postalCode, order?.postal_code, nested?.postal_code);
  const customerId = resolvePersistedCustomerId(order?.customer_id, order?.customerId);
  const addressId = order?.delivery_address_id ?? order?.deliveryAddressId ?? null;
  const customer = order?.customer;
  const linked = customerId && customer?.id === customerId && addressId
    ? customer.addresses?.find((row: any) => row.id === addressId && (!row.customer_id || row.customer_id === customerId))
    : null;
  const matches = (row: any) => row && trimmed(text(row.street_address, row.street, row.address)) === trimmed(address) &&
    (!city || trimmed(row.city) === trimmed(city)) && (!postal || trimmed(row.postal_code) === trimmed(postal));
  const point = toValidLatLng(order?.coordinates, order?.deliveryLatitude ?? order?.delivery_latitude ?? order?.latitude,
    order?.deliveryLongitude ?? order?.delivery_longitude ?? order?.longitude) ??
    (matches(nested) ? toValidLatLng(nested.coordinates, nested.latitude, nested.longitude) : null) ??
    (matches(linked) ? toValidLatLng(linked.coordinates, linked.latitude, linked.longitude) : null);
  return {
    customerId, addressId, orderType: order?.order_type ?? order?.orderType,
    expectedVersion: order?.remote_version ?? order?.remoteVersion ?? order?.version,
    expectedLocalVersion: order?.version,
    name: text(order?.customerName, order?.customer_name), phone: text(order?.customerPhone, order?.customer_phone),
    address, city, postal_code: postal,
    delivery_floor: text(order?.deliveryFloor, order?.delivery_floor, nested?.floor_number, nested?.floor),
    name_on_ringer: text(order?.nameOnRinger, order?.name_on_ringer, nested?.name_on_ringer, nested?.nameOnRinger),
    notes: text(order?.deliveryNotes, order?.delivery_notes, order?.specialInstructions, order?.special_instructions, order?.notes),
    coordinates: point, latitude: point?.lat ?? null, longitude: point?.lng ?? null,
    addressFingerprint: order?.deliveryAddressFingerprint ?? order?.delivery_address_fingerprint ??
      (matches(nested) ? nested.address_fingerprint : null) ?? (matches(linked) ? linked.address_fingerprint : null) ?? null,
  };
}

export function customerInfoEditUpdate(info: EditCustomerInfoFormData, original: EditCustomerInfoFormData) {
  const metadataOnly = info.destinationChanged === false;
  const sameDestination = metadataOnly || (info.destinationChanged !== true && isSameCustomerEditDestination(info, original));
  const point = toValidLatLng(info.coordinates, info.latitude, info.longitude);
  // The editor corrects the linked customer's contact; it never re-links the
  // order. Without the id the server was asked to create a customer for a
  // phone that already belonged to this one and refused the edit (06/10/2026).
  const customerId = resolvePersistedCustomerId(original.customerId);
  return {
    expectedVersion: original.expectedVersion ?? info.expectedVersion,
    ...(original.expectedLocalVersion === undefined ? {} : { expectedLocalVersion: original.expectedLocalVersion }),
    ...(customerId ? { customerId } : {}),
    customerName: info.name.trim(), customerPhone: info.phone.trim(), deliveryAddress: metadataOnly ? original.address.trim() : info.address.trim(),
    deliveryFloor: info.delivery_floor?.trim() || null, nameOnRinger: info.name_on_ringer?.trim() || null,
    deliveryNotes: info.notes?.trim() || null,
    // Missing renderer coordinates are not permission to erase the native
    // destination. Metadata-only saves carry no location or financial write.
    ...(!sameDestination ? {
      deliveryAddressId: info.addressId ?? null, deliveryCity: info.city?.trim() || null,
      deliveryPostalCode: info.postal_code?.trim() || null,
      deliveryLatitude: point?.lat ?? null, deliveryLongitude: point?.lng ?? null,
      deliveryAddressFingerprint: info.addressFingerprint ?? null,
    } : {}),
  };
}

/** Preserve a selected/frozen destination's proof only for the street being saved. */
export function orderCreateDeliveryLocation(destination: { address: string | null; city: string | null; postal: string | null }, selected: any, zone?: any) {
  const street = text(selected?.street_address, selected?.street, selected?.address);
  const matches = selected && typeof selected === 'object' && trimmed(street) === trimmed(destination.address) &&
    (!destination.city || trimmed(selected.city) === trimmed(destination.city)) &&
    (!destination.postal || trimmed(selected.postal_code ?? selected.postalCode) === trimmed(destination.postal));
  if (!matches || parseSpecialAddressInput(street).shouldSkipZoneValidation) return {};
  const point = toValidLatLng(selected.coordinates, selected.latitude, selected.longitude);
  return {
    delivery_address_id: resolvePersistedCustomerId(selected.id),
    delivery_latitude: point?.lat ?? null, delivery_longitude: point?.lng ?? null,
    delivery_address_fingerprint: selected.address_fingerprint ?? selected.addressFingerprint ?? null,
    delivery_zone_id: zone?.zone?.id ?? null,
    zone_name: zone?.zone?.name ?? null,
    estimated_delivery_time: zone?.zone?.estimatedTime ?? null,
  };
}
