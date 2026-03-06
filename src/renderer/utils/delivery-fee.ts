import type { DeliveryBoundaryValidationResponse } from '../../shared/types/delivery-validation';

export type DeliveryFeeStatus =
  | 'loading'
  | 'resolved'
  | 'requires_selection'
  | 'out_of_zone'
  | 'unavailable';

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
  orderType?: 'pickup' | 'delivery' | null,
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

  const validationStatus = String(validationResult?.validation_status || '').toLowerCase();
  const reason = String(validationResult?.reason || '').toUpperCase();
  const suggestedAction = String(validationResult?.suggestedAction || '').toLowerCase();

  if (
    validationStatus === 'requires_selection' ||
    reason === 'REQUIRES_SELECTION' ||
    suggestedAction === 'select_exact_address' ||
    suggestedAction === 'geocode_first'
  ) {
    return 'requires_selection';
  }

  if (validationStatus === 'out_of_zone' || reason === 'OUT_OF_ZONE') {
    return 'out_of_zone';
  }

  if (validationResult) {
    return 'unavailable';
  }

  return 'loading';
}

export function hasResolvedDeliveryFee(
  orderType?: 'pickup' | 'delivery' | null,
  validationResult?: DeliveryBoundaryValidationResponse | null,
  isValidating = false
): boolean {
  return getDeliveryFeeStatus(orderType, validationResult, isValidating) === 'resolved';
}
