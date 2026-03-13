const PLACEHOLDER_ORDER_CUSTOMER_NAMES = new Set([
  'customer.defaultCustomer',
  'customer.noCustomer',
]);

export const normalizeOrderTypeForDisplay = (orderType: string | null | undefined): string => {
  if (typeof orderType !== 'string') {
    return '';
  }

  return orderType.trim().toLowerCase();
};

export const normalizeOrderCustomerName = (
  customerName: string | null | undefined,
): string | null => {
  if (typeof customerName !== 'string') {
    return null;
  }

  const trimmed = customerName.trim();
  if (!trimmed) {
    return null;
  }

  return PLACEHOLDER_ORDER_CUSTOMER_NAMES.has(trimmed) ? null : trimmed;
};

export const pickMeaningfulOrderCustomerName = (
  ...candidates: Array<string | null | undefined>
): string | null => {
  for (const candidate of candidates) {
    const normalized = normalizeOrderCustomerName(candidate);
    if (normalized) {
      return normalized;
    }
  }

  return null;
};

interface ResolveOrderDisplayTitleOptions {
  orderType: string | null | undefined;
  customerName: string | null | undefined;
  pickupLabel: string;
  fallbackLabel: string;
}

export const resolveOrderDisplayTitle = ({
  orderType,
  customerName,
  pickupLabel,
  fallbackLabel,
}: ResolveOrderDisplayTitleOptions): string => {
  const normalizedCustomerName = normalizeOrderCustomerName(customerName);
  if (normalizedCustomerName) {
    return normalizedCustomerName;
  }

  return normalizeOrderTypeForDisplay(orderType) === 'pickup'
    ? pickupLabel
    : fallbackLabel;
};
