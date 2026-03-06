import type { DeliveryBoundaryValidationResponse } from '../../shared/types/delivery-validation';

export function resolveDeliveryFee(
  validationResult?: DeliveryBoundaryValidationResponse | null
): number {
  const overrideFee =
    validationResult?.override?.applied === true
      ? validationResult.override.customDeliveryFee
      : undefined;

  if (overrideFee != null) {
    return overrideFee;
  }

  return validationResult?.zone?.deliveryFee ?? 0;
}

export function hasResolvedDeliveryFee(
  orderType?: 'pickup' | 'delivery' | null,
  validationResult?: DeliveryBoundaryValidationResponse | null
): boolean {
  if (orderType !== 'delivery') {
    return true;
  }

  return (
    (validationResult?.override?.applied === true &&
      validationResult.override.customDeliveryFee != null) ||
    validationResult?.zone?.deliveryFee != null
  );
}
