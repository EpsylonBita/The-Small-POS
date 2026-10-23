import type { DeliveryBoundaryValidationResponse } from '../../shared/types/delivery-validation';
import {
  buildManualDeliveryZoneMarker,
  readDeliveryZoneSelection,
  withDeliveryZoneSelection,
  type ManualDeliveryZoneMarker,
  type ManualDeliveryZoneOption,
} from '../../../../shared/utils/offline-delivery-zone';

/**
 * - 'resolved': the fee is known (in zone, override, a zone the cashier chose
 *   offline, or a verdict that lets the order through with fee 0, such as out
 *   of zone or an unavailable check);
 * - 'not_checked': the address has no usable point, so its delivery zone was
 *   NOT checked. Online the order proceeds (fee 0) with a notice and a re-pick
 *   action; it is never shown as "out of zone" (founder rule, 2026-09-29);
 * - 'requires_zone_choice': offline, the address could not be located (its
 *   Google point expired or it has none): the cashier must choose the zone
 *   from the store's cached zones before checkout (offline week Ω6β). Never
 *   fee 0 without that choice;
 * - 'requires_selection': there is no delivery address to check at all;
 * - 'loading': a check is running.
 */
export type DeliveryFeeStatus =
  | 'loading'
  | 'resolved'
  | 'not_checked'
  | 'requires_zone_choice'
  | 'requires_selection'
  | 'out_of_zone'
  | 'unavailable';

/** Server `reason_code` for a check whose coordinates were missing or unusable. */
export const DELIVERY_ZONE_COORDINATES_MISSING = 'coordinates_missing';

/**
 * Opt-in body field for POST /api/pos/delivery-zones/validate: this client
 * handles "zone not checked" as its own state, so the server answers an
 * unusable point with `requires_selection` instead of the legacy
 * out_of_zone shape it keeps for released clients.
 */
export const ZONE_VALIDATION_CONTRACT_FIELD = 'zone_validation_contract';
export const ZONE_VALIDATION_CONTRACT_VERSION = 2;

type ZoneVerdictLike = {
  zone_checked?: unknown;
  reason_code?: unknown;
  validation_status?: unknown;
  reason?: unknown;
  suggestedAction?: unknown;
} | null | undefined;

/**
 * True when a zone-check answer means the zone was NOT checked: no usable
 * coordinates (`zone_checked: false` / `reason_code: 'coordinates_missing'`,
 * also on the legacy out_of_zone shape), or the exact address still has to be
 * picked (`requires_selection`, `geocode_first`, `select_exact_address`).
 */
export function isDeliveryZoneUnchecked(result: ZoneVerdictLike): boolean {
  if (!result || typeof result !== 'object') {
    return false;
  }
  if (result.zone_checked === false) {
    return true;
  }
  if (String(result.reason_code || '').toLowerCase() === DELIVERY_ZONE_COORDINATES_MISSING) {
    return true;
  }
  const validationStatus = String(result.validation_status || '').toLowerCase();
  const reason = String(result.reason || '').toUpperCase();
  const suggestedAction = String(result.suggestedAction || '').toLowerCase();
  return (
    validationStatus === 'requires_selection' ||
    reason === 'REQUIRES_SELECTION' ||
    suggestedAction === 'select_exact_address' ||
    suggestedAction === 'geocode_first'
  );
}

/**
 * The local answer for an address that has no usable point: the zone was not
 * checked. Same shape as the server's contract-2 answer, built without a
 * network call (and never cached).
 */
export function createUncheckedDeliveryZoneResult(): DeliveryBoundaryValidationResponse {
  const reason =
    'The delivery zone was not checked: the address has no valid coordinates. Pick the address again.';
  return {
    success: true,
    isValid: false,
    deliveryAvailable: false,
    validation_status: 'requires_selection',
    suggestedAction: 'geocode_first',
    reason_code: DELIVERY_ZONE_COORDINATES_MISSING,
    zone_checked: false,
    requires_override: false,
    reason,
    message: reason,
    uiState: {
      indicator: 'info',
      showOverrideOption: false,
      requiresManagerApproval: false,
      canProceed: false,
    },
  };
}

/** Where a zone answer keeps the marker of a zone the cashier chose. */
const MANUAL_ZONE_SELECTION_FIELD = 'delivery_zone_selection';

/**
 * The zone answer for a zone the cashier chose offline (Ω6β): the zone's own
 * fee and minimum, and the marker the order carries
 * (`deliveryZoneSelectionMetadata`). No point was checked; the marker, not
 * `zone_checked`, says so, so this answer never reads as "zone not checked"
 * (fee 0) anywhere.
 */
export function createManualDeliveryZoneResult(
  zone: ManualDeliveryZoneOption
): DeliveryBoundaryValidationResponse {
  return {
    success: true,
    isValid: true,
    deliveryAvailable: true,
    validation_status: 'manual_zone',
    requires_override: false,
    zone: {
      id: zone.id,
      name: zone.name,
      deliveryFee: zone.deliveryFee,
      minimumOrderAmount: zone.minimumOrderAmount,
    },
    [MANUAL_ZONE_SELECTION_FIELD]: buildManualDeliveryZoneMarker(zone),
  };
}

/** The marker of a zone answer the cashier chose by hand, or null. */
export function readManualDeliveryZoneSelection(
  validationResult?: DeliveryBoundaryValidationResponse | null
): ManualDeliveryZoneMarker | null {
  const marker = validationResult?.[MANUAL_ZONE_SELECTION_FIELD];
  return marker ? readDeliveryZoneSelection({ [MANUAL_ZONE_SELECTION_FIELD]: marker }) : null;
}

/**
 * The order's `ghost_metadata` with the "zone chosen manually" marker of a
 * delivery whose zone the cashier chose offline. Every other order keeps its
 * metadata exactly as before (null stays null). The order paths
 * (OrderDashboard, OrderFlow, NewOrderPage) call this with the zone answer
 * the menu handed over.
 */
export function deliveryZoneSelectionMetadata<T>(
  ghostMetadata: T,
  orderType: string | null | undefined,
  validationResult?: DeliveryBoundaryValidationResponse | null
): T | Record<string, unknown> {
  if (orderType !== 'delivery') {
    return ghostMetadata;
  }
  return withDeliveryZoneSelection(ghostMetadata, readManualDeliveryZoneSelection(validationResult));
}

export function resolveDeliveryFee(
  validationResult?: DeliveryBoundaryValidationResponse | null
): number {
  const overrideFee =
    validationResult?.override?.applied === true
      ? validationResult.override.customDeliveryFee
      : undefined;

  if (overrideFee != null) {
    return Number(overrideFee) || 0;
  }

  return Number(validationResult?.zone?.deliveryFee ?? 0) || 0;
}

export function getDeliveryFeeStatus(
  orderType?: 'pickup' | 'delivery' | 'dine-in' | null,
  validationResult?: DeliveryBoundaryValidationResponse | null,
  isValidating = false
): DeliveryFeeStatus {
  if (orderType !== 'delivery') {
    return 'resolved';
  }

  if (isValidating) {
    return 'loading';
  }

  if (
    (validationResult?.override?.applied === true &&
      validationResult.override.customDeliveryFee != null) ||
    validationResult?.zone?.deliveryFee != null
  ) {
    return 'resolved';
  }

  // Checked before out_of_zone: the legacy out_of_zone shape for an unusable
  // point carries zone_checked: false and must never read as out of zone.
  if (isDeliveryZoneUnchecked(validationResult)) {
    return 'not_checked';
  }

  // Out of zone or validation unavailable → resolve with fee = 0 so orders aren't blocked.
  // A dedicated out-of-zone fee will be configurable from the admin dashboard (future feature).
  const validationStatus = String(validationResult?.validation_status || '').toLowerCase();
  const reason = String(validationResult?.reason || '').toUpperCase();
  if (
    validationStatus === 'out_of_zone' ||
    reason === 'OUT_OF_ZONE' ||
    validationResult
  ) {
    return 'resolved';
  }

  return 'loading';
}

export function hasResolvedDeliveryFee(
  orderType?: 'pickup' | 'delivery' | 'dine-in' | null,
  validationResult?: DeliveryBoundaryValidationResponse | null,
  isValidating = false
): boolean {
  return getDeliveryFeeStatus(orderType, validationResult, isValidating) === 'resolved';
}

/**
 * Checkout gate for a delivery order with delivery zones: a known fee, or a
 * zone that was not checked (the cashier sees the notice; fee 0).
 */
export function canCheckoutWithDeliveryFeeStatus(status: DeliveryFeeStatus): boolean {
  return status === 'resolved' || status === 'not_checked';
}
