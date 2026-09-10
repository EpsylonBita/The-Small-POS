import type { CustomerInfo } from '../types/customer';

// The CustomerInfoModal only lets the user edit street text, floor,
// ringer name, and (indirectly, via re-validation) coordinates. It has
// no city/postal/email/notes inputs at all, so any field it doesn't
// carry in its save payload must be copied forward from the previously
// stored customer info rather than defaulted to blank.
export interface CustomerInfoModalSavePayload {
  name: string;
  phone: string;
  email?: string;
  notes?: string;
  address?: string;
  city?: string;
  postalCode?: string;
  floor_number?: string;
  name_on_ringer?: string;
  coordinates?: { lat: number; lng: number };
}

export const mergeCustomerInfoModalSave = (
  previous: CustomerInfo | null | undefined,
  info: CustomerInfoModalSavePayload,
): CustomerInfo => {
  const previousAddress = previous?.address;
  const previousStreet = previousAddress?.street || previousAddress?.street_address || '';
  const nextStreet = info.address ?? previousStreet;
  const city = info.city ?? previousAddress?.city ?? '';
  const postalCode = info.postalCode ?? previousAddress?.postalCode ?? previousAddress?.postal_code ?? '';
  const streetChanged = nextStreet !== previousStreet || city !== (previousAddress?.city ?? '')
    || postalCode !== (previousAddress?.postalCode ?? previousAddress?.postal_code ?? '');

  // A genuine street edit invalidates stale coordinates/validation unless
  // the caller already supplies freshly validated coordinates for the new
  // address. Floor/ringer-only edits leave coordinates untouched.
  const coordinates = info.coordinates
    ? info.coordinates
    : streetChanged
      ? undefined
      : previousAddress?.coordinates;
  return {
    ...previous,
    name: info.name,
    phone: info.phone,
    email: info.email ?? previous?.email,
    address: {
      ...previousAddress,
      street: nextStreet,
      street_address: nextStreet,
      city,
      postalCode,
      postal_code: info.postalCode ?? previousAddress?.postal_code,
      floor_number: info.floor_number ?? previousAddress?.floor_number ?? '',
      name_on_ringer: info.name_on_ringer ?? previousAddress?.name_on_ringer ?? '',
      coordinates,
      latitude: info.coordinates?.lat ?? (streetChanged ? undefined : previousAddress?.latitude),
      longitude: info.coordinates?.lng ?? (streetChanged ? undefined : previousAddress?.longitude),
      notes: previousAddress?.notes,
    },
    notes: info.notes ?? previous?.notes ?? '',
  };
};
