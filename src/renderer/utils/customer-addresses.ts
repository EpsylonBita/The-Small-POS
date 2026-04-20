import { extractSavedAddressCoordinates } from './saved-address-geolocation';

export const LEGACY_FALLBACK_ADDRESS_PREFIX = 'legacy:';

export type MaterializedCustomerAddress = {
  id: string;
  customer_id?: string;
  street_address: string;
  street?: string;
  city: string;
  postal_code: string;
  floor_number?: string;
  notes?: string;
  delivery_notes?: string;
  name_on_ringer?: string;
  coordinates?:
    | { lat: number; lng: number }
    | { type: 'Point'; coordinates: [number, number] }
    | undefined;
  latitude?: number | null;
  longitude?: number | null;
  address_type: string;
  is_default: boolean;
  created_at: string;
  updated_at?: string;
  version?: number;
  is_legacy_fallback?: boolean;
};

type CustomerAddressLike = {
  id: string;
  customer_id?: string | null;
  street_address?: string | null;
  street?: string | null;
  city?: string | null;
  postal_code?: string | null;
  floor_number?: string | null;
  notes?: string | null;
  delivery_notes?: string | null;
  name_on_ringer?: string | null;
  coordinates?:
    | { lat: number; lng: number }
    | { type: 'Point'; coordinates: [number, number] }
    | null;
  latitude?: number | null;
  longitude?: number | null;
  address_type?: string | null;
  is_default?: boolean | null;
  created_at?: string | null;
  updated_at?: string | null;
  version?: number | null;
  is_legacy_fallback?: boolean | null;
};

export type CanonicalCustomerAddress = Omit<
  MaterializedCustomerAddress,
  'postal_code' | 'floor_number' | 'notes' | 'delivery_notes' | 'name_on_ringer'
> & {
  street_address: string;
  street: string;
  city: string;
  postal_code: string;
  postalCode: string;
  floor_number: string;
  floor: string;
  notes: string;
  delivery_notes: string;
  name_on_ringer: string;
  nameOnRinger: string;
};

export type CustomerWithAddressesLike = {
  id: string;
  address?: string | null;
  city?: string | null;
  postal_code?: string | null;
  floor_number?: string | null;
  notes?: string | null;
  name_on_ringer?: string | null;
  coordinates?:
    | { lat: number; lng: number }
    | { type: 'Point'; coordinates: [number, number] }
    | null;
  latitude?: number | null;
  longitude?: number | null;
  version?: number | null;
  selected_address_id?: string | null;
  addresses?: CustomerAddressLike[] | null;
};

function normalizeStreetAddress(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeOptionalText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function materializeAddress(address: CustomerAddressLike): MaterializedCustomerAddress {
  const streetAddress = normalizeStreetAddress(address.street_address) || normalizeStreetAddress(address.street);
  const normalizedCoordinates =
    extractSavedAddressCoordinates({
      street_address: streetAddress || undefined,
      city: normalizeOptionalText(address.city) || undefined,
      postal_code: normalizeOptionalText(address.postal_code) || undefined,
      coordinates: address.coordinates ?? undefined,
      latitude: address.latitude ?? undefined,
      longitude: address.longitude ?? undefined,
    }) ?? undefined;

  return {
    ...address,
    customer_id: typeof address.customer_id === 'string' ? address.customer_id : undefined,
    street: streetAddress,
    street_address: streetAddress,
    city: normalizeOptionalText(address.city),
    postal_code: normalizeOptionalText(address.postal_code),
    floor_number: normalizeOptionalText(address.floor_number),
    notes: normalizeOptionalText(address.notes),
    delivery_notes:
      normalizeOptionalText(address.delivery_notes) || normalizeOptionalText(address.notes),
    name_on_ringer: normalizeOptionalText(address.name_on_ringer),
    coordinates: address.coordinates ?? normalizedCoordinates,
    latitude:
      normalizedCoordinates?.lat ??
      (Number.isFinite(Number(address.latitude)) ? Number(address.latitude) : null),
    longitude:
      normalizedCoordinates?.lng ??
      (Number.isFinite(Number(address.longitude)) ? Number(address.longitude) : null),
    address_type: normalizeOptionalText(address.address_type) || 'home',
    is_default: Boolean(address.is_default),
    created_at: normalizeOptionalText(address.created_at),
    updated_at: typeof address.updated_at === 'string' ? address.updated_at : undefined,
    version: typeof address.version === 'number' ? address.version : undefined,
    is_legacy_fallback: Boolean((address as MaterializedCustomerAddress).is_legacy_fallback),
  };
}

export function isLegacyFallbackAddressId(id: unknown): boolean {
  return typeof id === 'string' && id.startsWith(LEGACY_FALLBACK_ADDRESS_PREFIX);
}

export function isLegacyFallbackAddress(address: unknown): boolean {
  if (!address || typeof address !== 'object') {
    return false;
  }

  const candidate = address as { id?: unknown; is_legacy_fallback?: unknown };
  return Boolean(candidate.is_legacy_fallback) || isLegacyFallbackAddressId(candidate.id);
}

export function buildLegacyFallbackCustomerAddress(
  customer: CustomerWithAddressesLike
): MaterializedCustomerAddress | null {
  const normalizedStreet = normalizeStreetAddress(customer.address);
  if (!normalizedStreet) {
    return null;
  }

  const coordinates = extractSavedAddressCoordinates({
    street_address: normalizedStreet,
    city: typeof customer.city === 'string' ? customer.city : undefined,
    postal_code: typeof customer.postal_code === 'string' ? customer.postal_code : undefined,
    coordinates: customer.coordinates ?? undefined,
    latitude: customer.latitude ?? undefined,
    longitude: customer.longitude ?? undefined,
  }) ?? undefined;

  return {
    id: `${LEGACY_FALLBACK_ADDRESS_PREFIX}${customer.id}`,
    customer_id: customer.id,
    street: normalizedStreet,
    street_address: normalizedStreet,
    city: typeof customer.city === 'string' ? customer.city : '',
    postal_code: typeof customer.postal_code === 'string' ? customer.postal_code : '',
    floor_number: typeof customer.floor_number === 'string' ? customer.floor_number : undefined,
    notes: customer.notes ?? undefined,
    delivery_notes: customer.notes ?? undefined,
    name_on_ringer: typeof customer.name_on_ringer === 'string' ? customer.name_on_ringer : undefined,
    coordinates: coordinates ?? undefined,
    latitude: coordinates?.lat ?? customer.latitude ?? null,
    longitude: coordinates?.lng ?? customer.longitude ?? null,
    address_type: 'home',
    is_default: true,
    created_at: '',
    updated_at: undefined,
    version: customer.version ?? 1,
    is_legacy_fallback: true,
  };
}

export function materializeCustomerAddresses<T extends CustomerWithAddressesLike>(
  customer: T
): MaterializedCustomerAddress[] {
  if (Array.isArray(customer.addresses) && customer.addresses.length > 0) {
    return customer.addresses.map((address) => materializeAddress(address));
  }

  const legacyAddress = buildLegacyFallbackCustomerAddress(customer);
  return legacyAddress ? [legacyAddress] : [];
}

export function withMaterializedCustomerAddresses<T extends CustomerWithAddressesLike>(
  customer: T
): Omit<T, 'addresses'> & { addresses: MaterializedCustomerAddress[] } {
  return {
    ...customer,
    addresses: materializeCustomerAddresses(customer),
  } as Omit<T, 'addresses'> & { addresses: MaterializedCustomerAddress[] };
}

export function resolveSelectedCustomerAddress<T extends CustomerWithAddressesLike>(
  customer: T
): MaterializedCustomerAddress | null {
  const addresses = materializeCustomerAddresses(customer);
  if (addresses.length === 0) {
    return null;
  }

  const selectedAddressId = typeof customer.selected_address_id === 'string'
    ? customer.selected_address_id
    : null;
  if (selectedAddressId) {
    const selectedAddress = addresses.find((address) => address.id === selectedAddressId);
    if (selectedAddress) {
      return selectedAddress;
    }
  }

  return addresses.find((address) => address.is_default) || addresses[0];
}

export function toCanonicalCustomerAddress(
  address: MaterializedCustomerAddress | null | undefined
): CanonicalCustomerAddress | null {
  if (!address) {
    return null;
  }

  const streetAddress = normalizeStreetAddress(address.street_address) || normalizeStreetAddress(address.street);
  if (!streetAddress) {
    return null;
  }

  const normalizedCoordinates =
    extractSavedAddressCoordinates(address) ?? undefined;

  const resolvedLatitude =
    normalizedCoordinates?.lat ??
    (Number.isFinite(Number(address.latitude)) ? Number(address.latitude) : null);
  const resolvedLongitude =
    normalizedCoordinates?.lng ??
    (Number.isFinite(Number(address.longitude)) ? Number(address.longitude) : null);
  const resolvedNotes =
    normalizeOptionalText(address.delivery_notes) || normalizeOptionalText(address.notes);
  const resolvedFloor = normalizeOptionalText(address.floor_number);
  const resolvedPostalCode = normalizeOptionalText(address.postal_code);
  const resolvedNameOnRinger = normalizeOptionalText(address.name_on_ringer);

  return {
    ...address,
    street: streetAddress,
    street_address: streetAddress,
    city: normalizeOptionalText(address.city),
    postal_code: resolvedPostalCode,
    postalCode: resolvedPostalCode,
    floor_number: resolvedFloor,
    floor: resolvedFloor,
    notes: resolvedNotes,
    delivery_notes: resolvedNotes,
    name_on_ringer: resolvedNameOnRinger,
    nameOnRinger: resolvedNameOnRinger,
    coordinates: address.coordinates ?? normalizedCoordinates,
    latitude: resolvedLatitude,
    longitude: resolvedLongitude,
  };
}

export function resolveCanonicalCustomerAddress<T extends CustomerWithAddressesLike>(
  customer: T | null | undefined
): CanonicalCustomerAddress | null {
  if (!customer) {
    return null;
  }

  return toCanonicalCustomerAddress(resolveSelectedCustomerAddress(customer));
}
