import type { DeliveryBoundaryValidationResponse } from '../../shared/types/delivery-validation';
import { toValidLatLng, type LatLng } from './coordinates';
import {
  withMaterializedCustomerAddresses,
  type CustomerWithAddressesLike,
  type MaterializedCustomerAddress,
} from './customer-addresses';
import { isDeliveryZoneUnchecked } from './delivery-fee';
import { extractSavedAddressCoordinates, savedAddressIdentityKey } from './saved-address-geolocation';

/**
 * Hand-off from the customer/address modals to the order menu.
 *
 * Symptom it fixes: after editing an existing customer's address, the order
 * dashboard re-checked the customer's DEFAULT address (at (0,0) when it had no
 * coordinates) instead of the edited one, showed or cached "out of zone" for
 * it, and addressed the order to the default address.
 *
 * Contract with AddCustomerModal (onCustomerAdded):
 * - `selected_address_id`: the address the modal just created or edited;
 * - `editAddressId`: in editAddress mode, the address that was edited;
 * - `delivery_zone_validation` (optional): the zone check the modal ran for
 *   that address (address-workflow DeliveryValidationResult shape). When it
 *   is present it is reused as is; the dashboard never re-checks an address
 *   the modal did not just check.
 */
export const MODAL_ZONE_VALIDATION_FIELD = 'delivery_zone_validation' as const;
export const MODAL_DESTINATION_UNCHANGED_FIELD = 'delivery_destination_unchanged' as const;

type HandoffCustomer = CustomerWithAddressesLike & {
  editAddressId?: string | null;
  delivery_zone_validation?: unknown;
  delivery_destination_unchanged?: unknown;
};

export interface ResolvedHandoffCustomer<T> {
  customer: Omit<T, 'addresses' | 'editAddressId' | 'delivery_zone_validation' | 'delivery_destination_unchanged'> & {
    addresses: MaterializedCustomerAddress[];
    selected_address_id: string | null;
  };
  /** The address the order goes to. */
  address: MaterializedCustomerAddress | null;
  /** True when the address is the one the modal itself named. */
  addressFromModal: boolean;
}

function findAddress(
  addresses: MaterializedCustomerAddress[],
  id: unknown
): MaterializedCustomerAddress | null {
  if (typeof id !== 'string' || !id) {
    return null;
  }
  return addresses.find((address) => address.id === id) ?? null;
}

/**
 * The customer as the order will use it, with `selected_address_id` pointing
 * at the address the cashier just saved or edited (else the previous choice
 * for the same customer, else the default).
 */
export function resolveHandoffCustomer<T extends HandoffCustomer>(
  customer: T,
  previous?: { customerId?: string | null; selectedAddressId?: string | null } | null
): ResolvedHandoffCustomer<T> {
  const materialized = withMaterializedCustomerAddresses(customer);
  // Neither the edit target nor the modal's one-off check may linger on the
  // stored customer: a later modal would hand them back as if they were new.
  const { editAddressId, delivery_zone_validation: _modalValidation,
    delivery_destination_unchanged: _unchangedDestination, ...rest } = materialized;
  const addresses = materialized.addresses;

  const fromModal =
    findAddress(addresses, customer.selected_address_id)
    ?? findAddress(addresses, editAddressId);
  const fromPrevious =
    !fromModal && previous?.customerId && previous.customerId === customer.id
      ? findAddress(addresses, previous.selectedAddressId)
      : null;
  const address =
    fromModal
    ?? fromPrevious
    ?? addresses.find((candidate) => candidate.is_default)
    ?? addresses[0]
    ?? null;

  return {
    customer: {
      ...(rest as Omit<T, 'addresses' | 'editAddressId' | 'delivery_zone_validation' | 'delivery_destination_unchanged'>),
      addresses,
      selected_address_id: address?.id ?? null,
    },
    address,
    addressFromModal: Boolean(fromModal),
  };
}

/** A live metadata-only save may retain only the current cart's own destination verdict. */
export function canKeepDeliveryZoneForCustomerEdit(options: {
  customerId: unknown;
  previousCustomerId: unknown;
  address: Parameters<typeof savedAddressIdentityKey>[0];
  previousAddress: Parameters<typeof savedAddressIdentityKey>[0];
  unchangedDestination: unknown;
  zoneInfo: DeliveryBoundaryValidationResponse | null;
}): boolean {
  const { customerId, previousCustomerId, address, previousAddress, zoneInfo } = options;
  if (options.unchangedDestination !== true || typeof customerId !== 'string' || !customerId
    || customerId !== previousCustomerId || !address?.id || address.id !== previousAddress?.id
    || savedAddressIdentityKey(address) !== savedAddressIdentityKey(previousAddress)) return false;

  const point = extractSavedAddressCoordinates(address);
  const zonePoint = toValidLatLng(zoneInfo?.coordinates);
  // Unknown coordinates cannot acquire a genuine verdict from another address.
  if (zoneInfo && !isDeliveryZoneUnchecked(zoneInfo) && !point) return false;
  return !zonePoint || Boolean(point && zonePoint.lat === point.lat && zonePoint.lng === point.lng);
}

function readNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (value === null || value === undefined || value === '') {
      continue;
    }
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

/**
 * The menu's zone info from the zone check a customer/address modal already
 * ran (address-workflow shape). Null when there is nothing to reuse, or when
 * that check did not actually check the zone.
 */
export function toDeliveryZoneInfoFromModalValidation(
  raw: unknown
): DeliveryBoundaryValidationResponse | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const result = raw as Record<string, any>;
  if (isDeliveryZoneUnchecked(result)) {
    return null;
  }

  const status = String(result.validation_status || '').toLowerCase();
  const coordinates = toValidLatLng(result.coordinates) ?? undefined;
  const selectedZone = result.selectedZone && typeof result.selectedZone === 'object'
    ? result.selectedZone
    : null;

  if ((status === 'in_zone' || result.isValid === true) && selectedZone) {
    const minimumOrderAmount = readNumber(selectedZone.minimum_order_amount, selectedZone.minimumOrderAmount) ?? 0;
    return {
      ...result,
      success: true,
      isValid: true,
      deliveryAvailable: true,
      validation_status: 'in_zone',
      selectedZone,
      coordinates,
      zone: {
        id: selectedZone.id,
        name: selectedZone.name,
        deliveryFee: readNumber(selectedZone.delivery_fee, selectedZone.deliveryFee) ?? 0,
        minimumOrderAmount,
        estimatedTime: {
          min: readNumber(selectedZone.estimated_delivery_time_min, selectedZone.estimatedTime?.min) ?? 20,
          max: readNumber(selectedZone.estimated_delivery_time_max, selectedZone.estimatedTime?.max) ?? 35,
        },
        color: selectedZone.color ?? selectedZone.color_code,
        priority: selectedZone.priority,
      },
      uiState: {
        indicator: 'success',
        showOverrideOption: false,
        requiresManagerApproval: false,
        canProceed: true,
      },
    };
  }

  if (status === 'module_disabled' || status === 'out_of_zone' || status === 'unverified_offline') {
    // The menu resolves these with fee 0 (out of zone keeps today's desktop
    // behaviour, including an override the modal already recorded).
    return {
      ...result,
      success: result.success !== false,
      isValid: status === 'module_disabled',
      deliveryAvailable: status === 'module_disabled',
      validation_status: status,
      coordinates,
    } as DeliveryBoundaryValidationResponse;
  }

  return null;
}

export type DeliveryZoneHandoffPlan =
  /** Reuse the modal's own check for this address. */
  | { kind: 'reuse'; zoneInfo: DeliveryBoundaryValidationResponse }
  /** Check the address's real point. */
  | { kind: 'check_point'; point: LatLng }
  /**
   * No usable point (or a "#label" address): the menu geolocates the address
   * (accepted only when its area matches) or shows "zone not checked".
   */
  | { kind: 'menu' };

export function planDeliveryZoneHandoff(options: {
  address: Parameters<typeof extractSavedAddressCoordinates>[0];
  modalValidation?: unknown;
  addressFromModal?: boolean;
}): DeliveryZoneHandoffPlan {
  if (options.addressFromModal) {
    const reused = toDeliveryZoneInfoFromModalValidation(options.modalValidation);
    if (reused) {
      return { kind: 'reuse', zoneInfo: reused };
    }
  }

  const point = extractSavedAddressCoordinates(options.address);
  if (point) {
    return { kind: 'check_point', point };
  }

  return { kind: 'menu' };
}

// ---------------------------------------------------------------------------
// "Pick the address again" (the menu's zone-not-checked notice)
// ---------------------------------------------------------------------------

type RepickCustomer = { id?: unknown; editAddressId?: string | null; selected_address_id?: string | null };

export type DeliveryAddressRepickPlan<T> =
  /** Open the address editor (AddCustomerModal, editAddress mode) on this customer. */
  | { kind: 'edit_address'; customer: T & { selected_address_id: string; editAddressId: string } }
  /** No saved address row (walk-in delivery): the order's own address form. */
  | { kind: 'order_address_form' };

/**
 * What the re-pick action opens: the address editor on the order's saved
 * address, or, without a saved address row, the order's address form.
 */
export function planDeliveryAddressRepick<T extends RepickCustomer>(
  customer: T | null | undefined,
  address: { id?: unknown } | null | undefined
): DeliveryAddressRepickPlan<T> {
  const customerId = customer?.id;
  const addressId = address?.id;
  if (customer && typeof customerId === 'string' && customerId && typeof addressId === 'string' && addressId) {
    return {
      kind: 'edit_address',
      customer: { ...customer, selected_address_id: addressId, editAddressId: addressId },
    };
  }
  return { kind: 'order_address_form' };
}

/**
 * Closing the re-pick editor without saving keeps the order's customer (and
 * the cart): only the edit target is dropped, so a later modal does not
 * hand it back as if it were new.
 */
export function withoutRepickTarget<T extends RepickCustomer>(customer: T | null): T | null {
  if (!customer) {
    return customer;
  }
  const { editAddressId: _repickTarget, ...rest } = customer;
  return rest as T;
}

// ---------------------------------------------------------------------------
// Pickup -> delivery conversion
// ---------------------------------------------------------------------------

export interface PickupToDeliveryZoneDecision {
  /** The zone was not checked: proceed with the notice, never an override. */
  zoneNotChecked: boolean;
  canProceed: boolean;
  /** Only a genuine verdict (e.g. out of zone) may ask for manager approval. */
  canAttemptOverride: boolean;
}

/**
 * Founder rule (2026-09-29): a zone that was not checked (no usable point)
 * never blocks the conversion and never asks for an out-of-zone override. A
 * genuine out_of_zone keeps today's desktop override flow.
 */
export function decidePickupToDeliveryZone(
  validationResult: DeliveryBoundaryValidationResponse | null | undefined
): PickupToDeliveryZoneDecision {
  const zoneNotChecked = isDeliveryZoneUnchecked(validationResult);
  if (zoneNotChecked) {
    return { zoneNotChecked: true, canProceed: true, canAttemptOverride: false };
  }
  const canProceed = Boolean(
    validationResult?.uiState?.canProceed ??
      validationResult?.deliveryAvailable ??
      validationResult?.isValid ??
      false
  );
  return {
    zoneNotChecked: false,
    canProceed,
    canAttemptOverride:
      !canProceed &&
      Boolean(validationResult?.uiState?.showOverrideOption || validationResult?.uiState?.requiresManagerApproval),
  };
}
