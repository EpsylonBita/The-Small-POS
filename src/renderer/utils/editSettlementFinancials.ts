export type EditSettlementEditableOrderType = 'pickup' | 'delivery' | 'dine-in';

export type EditSettlementFinancialsOrderLike = object;

export type EditSettlementFinancialsItemLike = object;

export interface DerivedEditSettlementFinancials {
  totalAmount: number;
  subtotal: number;
  taxAmount: number;
  deliveryFee: number;
  discountAmount: number;
  discountPercentage: number;
  tipAmount: number;
}

const readNumber = (
  source: Record<string, unknown> | undefined,
  keys: string[],
  fallback = 0,
): number => {
  if (!source) return fallback;
  for (const key of keys) {
    if (source[key] === null || source[key] === undefined || source[key] === '') continue;
    const value = Number(source[key]);
    if (Number.isFinite(value)) {
      return value;
    }
  }
  return fallback;
};

const roundMoney = (value: number): number => Number(value.toFixed(2));

export const getEditSettlementItemsSubtotal = (
  nextItems: EditSettlementFinancialsItemLike[],
): number =>
  roundMoney(
    nextItems.reduce((sum, item) => {
      const itemRecord = item as Record<string, unknown>;
      const quantity = readNumber(itemRecord, ['quantity'], 0);
      const explicitTotal = readNumber(itemRecord, ['total_price', 'totalPrice'], NaN);
      if (Number.isFinite(explicitTotal)) {
        return sum + explicitTotal;
      }
      return sum + readNumber(itemRecord, ['unit_price', 'unitPrice', 'price']) * quantity;
    }, 0),
  );

export const deriveEditSettlementFinancials = (
  order: EditSettlementFinancialsOrderLike,
  nextItems: EditSettlementFinancialsItemLike[],
  targetOrderType: EditSettlementEditableOrderType,
  configuredTaxRate = 0,
): DerivedEditSettlementFinancials => {
  const orderRecord = order as Record<string, unknown>;
  const itemsSubtotal = getEditSettlementItemsSubtotal(nextItems);
  const discountAmount = roundMoney(
    Math.min(
      Math.max(readNumber(orderRecord, ['discount_amount', 'discountAmount']), 0),
      itemsSubtotal,
    ),
  );
  const discountPercentage = readNumber(orderRecord, [
    'discount_percentage',
    'discountPercentage',
  ]);
  const tipAmount = Math.max(readNumber(orderRecord, ['tip_amount', 'tipAmount']), 0);
  const deliveryFee =
    targetOrderType === 'delivery'
      ? Math.max(readNumber(orderRecord, ['delivery_fee', 'deliveryFee']), 0)
      : 0;
  const taxableSubtotal = Math.max(0, itemsSubtotal - discountAmount);
  const taxRate = readNumber(orderRecord, ['tax_rate', 'taxRate'], configuredTaxRate);
  const taxAmount =
    Number.isFinite(taxRate) && taxRate > 0
      ? roundMoney(taxableSubtotal - taxableSubtotal / (1 + taxRate / 100))
      : 0;
  const totalAmount = roundMoney(Math.max(0, taxableSubtotal + deliveryFee + tipAmount));

  return {
    totalAmount,
    subtotal: itemsSubtotal,
    taxAmount,
    deliveryFee,
    discountAmount,
    discountPercentage,
    tipAmount,
  };
};
