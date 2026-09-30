import type { DeliveryBoundaryValidationResponse } from '../../shared/types/delivery-validation';

/**
 * - 'resolved': the fee is known (in zone, override, or a verdict that lets
 *   the order through with fee 0, such as out of zone or an unavailable check);
 * - 'not_checked': the address has no usable point, so its delivery zone was
 *   NOT checked. The order proceeds (fee 0) with a notice and a re-pick action;
 *   it is never shown as "out of zone" (founder rule, 2026-09-29);
 * - 'requires_selection': there is no delivery address to check at all;
 * - 'loading': a check is running.
 */
export type DeliveryFeeStatus =
  | 'loading'
  | 'resolved'
  | 'not_checked'
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
