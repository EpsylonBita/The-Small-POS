export interface SplitPaymentItem {
  name: string;
  quantity: number;
  price: number;
  totalPrice: number;
  itemIndex: number;
  isSynthetic?: boolean;
}

interface SplitPaymentItemLike {
  name?: string | null;
  quantity?: number | null;
  price?: number | null;
  totalPrice?: number | null;
  itemIndex?: number | null;
}

interface BuildSplitPaymentItemsParams {
  items: SplitPaymentItemLike[];
  orderTotal: number;
  deliveryFee?: number;
  discountAmount?: number;
  taxAmount?: number;
  deliveryFeeLabel?: string;
  discountLabel?: string;
  taxLabel?: string;
  adjustmentLabel?: string;
}

const round2 = (value: number): number => Math.round(value * 100) / 100;

export function buildSplitPaymentItems({
  items,
  orderTotal,
  deliveryFee = 0,
  discountAmount = 0,
  taxAmount = 0,
  deliveryFeeLabel = 'Delivery Fee',
  discountLabel = 'Discount',
  taxLabel = 'Tax',
  adjustmentLabel = 'Adjustment',
}: BuildSplitPaymentItemsParams): SplitPaymentItem[] {
  const normalizedItems: SplitPaymentItem[] = items.map((item, index) => {
    const quantity = Math.max(1, Number(item.quantity ?? 1));
    const totalPrice = round2(
      Number(item.totalPrice ?? ((item.price ?? 0) * quantity)),
    );
    const unitPrice = round2(
      quantity > 0 ? Number(item.price ?? (totalPrice / quantity)) : Number(item.price ?? 0),
    );

    return {
      name: item.name?.trim() || 'Item',
      quantity,
      price: unitPrice,
      totalPrice,
      itemIndex: Number.isInteger(item.itemIndex) ? Number(item.itemIndex) : index,
    };
  });

  let nextItemIndex =
    normalizedItems.reduce((max, item) => Math.max(max, item.itemIndex), -1) + 1;

  const appendSyntheticItem = (name: string, totalPrice: number) => {
    const roundedTotal = round2(totalPrice);
    if (Math.abs(roundedTotal) < 0.01) {
      return;
    }

    normalizedItems.push({
      name,
      quantity: 1,
      price: roundedTotal,
      totalPrice: roundedTotal,
      itemIndex: nextItemIndex++,
      isSynthetic: true,
    });
  };

  appendSyntheticItem(taxLabel, taxAmount);
  appendSyntheticItem(deliveryFeeLabel, deliveryFee);
  appendSyntheticItem(discountLabel, -Math.abs(discountAmount));

  const computedTotal = round2(
    normalizedItems.reduce((sum, item) => sum + item.totalPrice, 0),
  );
  const residual = round2(orderTotal - computedTotal);

  appendSyntheticItem(adjustmentLabel, residual);

  return normalizedItems;
}
