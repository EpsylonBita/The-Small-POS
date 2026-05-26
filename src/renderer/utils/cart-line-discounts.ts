export type CartLineDiscountMode = 'percentage' | 'fixed';

export interface DiscountableCartLine {
  id: string | number;
  name?: string;
  quantity?: number;
  price?: number;
  unitPrice?: number;
  unit_price?: number;
  totalPrice?: number;
  total_price?: number;
  originalUnitPrice?: number | null;
  original_unit_price?: number | null;
  isPriceOverridden?: boolean;
  is_price_overridden?: boolean;
  discount?: number;
  discountAmount?: number;
  discount_amount?: number;
  discountBaseUnitPrice?: number;
  discountBaseTotalPrice?: number;
  lineDiscountMode?: CartLineDiscountMode;
  lineDiscountValue?: number;
}

type SelectedLineMeta = {
  index: number;
  totalCents: number;
};

const finiteNumber = (value: unknown, fallback = 0): number => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
};

export const roundMoney = (value: number): number =>
  Number((Math.round((value + Number.EPSILON) * 100) / 100).toFixed(2));

const toCents = (value: number): number => Math.max(0, Math.round(finiteNumber(value, 0) * 100));

const fromCents = (value: number): number => roundMoney(value / 100);

export const getCartLineQuantity = (item: DiscountableCartLine): number =>
  Math.max(1, Math.round(finiteNumber(item.quantity, 1)));

export const getCartLineUnitPrice = (item: DiscountableCartLine): number => {
  const quantity = getCartLineQuantity(item);
  return roundMoney(
    finiteNumber(
      item.unitPrice ??
        item.unit_price ??
        item.price ??
        (item.totalPrice ?? item.total_price ?? 0) / quantity,
      0,
    ),
  );
};

export const getCartLineTotal = (item: DiscountableCartLine): number => {
  const quantity = getCartLineQuantity(item);
  return roundMoney(
    finiteNumber(
      item.totalPrice ?? item.total_price,
      getCartLineUnitPrice(item) * quantity,
    ),
  );
};

export const getCartLineOriginalUnitPrice = (item: DiscountableCartLine): number =>
  roundMoney(finiteNumber(item.originalUnitPrice ?? item.original_unit_price, getCartLineUnitPrice(item)));

const hasAppliedLineDiscount = (item: DiscountableCartLine): boolean =>
  finiteNumber(item.discountAmount ?? item.discount_amount ?? item.discount, 0) > 0 ||
  item.discountBaseUnitPrice !== undefined ||
  item.discountBaseTotalPrice !== undefined;

const getDiscountBaseUnitPrice = (item: DiscountableCartLine): number =>
  roundMoney(finiteNumber(item.discountBaseUnitPrice, getCartLineUnitPrice(item)));

const getDiscountBaseTotalPrice = (item: DiscountableCartLine): number =>
  roundMoney(finiteNumber(item.discountBaseTotalPrice, getCartLineTotal(item)));

const allocateFixedDiscountCents = (
  selectedLines: SelectedLineMeta[],
  discountValue: number,
): Map<number, number> => {
  const allocations = new Map<number, number>();
  const selectedTotalCents = selectedLines.reduce((sum, line) => sum + line.totalCents, 0);
  const targetCents = Math.min(toCents(discountValue), selectedTotalCents);

  if (selectedTotalCents <= 0 || targetCents <= 0) {
    selectedLines.forEach((line) => allocations.set(line.index, 0));
    return allocations;
  }

  const shares = selectedLines.map((line) => {
    const exactShare = (targetCents * line.totalCents) / selectedTotalCents;
    const cents = Math.min(line.totalCents, Math.floor(exactShare));
    return {
      ...line,
      cents,
      remainder: exactShare - cents,
    };
  });

  let remainingCents = targetCents - shares.reduce((sum, share) => sum + share.cents, 0);

  while (remainingCents > 0) {
    const nextShare = shares
      .filter((share) => share.cents < share.totalCents)
      .sort((a, b) => b.remainder - a.remainder || b.totalCents - a.totalCents)[0];

    if (!nextShare) {
      break;
    }

    nextShare.cents += 1;
    nextShare.remainder = 0;
    remainingCents -= 1;
  }

  shares.forEach((share) => allocations.set(share.index, share.cents));
  return allocations;
};

export const applyDiscountToCartLines = <T extends DiscountableCartLine>(
  items: T[],
  selectedIds: Iterable<T['id']>,
  mode: CartLineDiscountMode,
  value: number,
): T[] => {
  const selectedIdSet = new Set(selectedIds);
  const safeValue = Math.max(0, finiteNumber(value, 0));
  const selectedLines = items
    .map((item, index) => ({
      index,
      totalCents: toCents(getDiscountBaseTotalPrice(item)),
      selected: selectedIdSet.has(item.id),
    }))
    .filter((line) => line.selected)
    .map(({ index, totalCents }) => ({ index, totalCents }));
  const fixedAllocations =
    mode === 'fixed' ? allocateFixedDiscountCents(selectedLines, safeValue) : new Map<number, number>();

  return items.map((item, index) => {
    if (!selectedIdSet.has(item.id)) {
      return item;
    }

    const quantity = getCartLineQuantity(item);
    const currentUnitPrice = getCartLineUnitPrice(item);
    const baseUnitPrice = getDiscountBaseUnitPrice(item);
    const baseTotal = getDiscountBaseTotalPrice(item);
    const discountAmount =
      mode === 'percentage'
        ? roundMoney(baseTotal * (Math.min(safeValue, 100) / 100))
        : fromCents(fixedAllocations.get(index) ?? 0);
    const nextTotal = roundMoney(Math.max(0, baseTotal - discountAmount));
    const nextUnitPrice = roundMoney(nextTotal / quantity);
    const originalUnitPrice = getCartLineOriginalUnitPrice(item);
    const isPriceOverridden =
      discountAmount > 0 ||
      item.isPriceOverridden === true ||
      item.is_price_overridden === true ||
      Math.abs(nextUnitPrice - originalUnitPrice) > 0.0001;

    return {
      ...item,
      price: nextUnitPrice,
      unitPrice: nextUnitPrice,
      unit_price: nextUnitPrice,
      totalPrice: nextTotal,
      total_price: nextTotal,
      originalUnitPrice: item.originalUnitPrice ?? item.original_unit_price ?? currentUnitPrice,
      original_unit_price: item.original_unit_price ?? item.originalUnitPrice ?? currentUnitPrice,
      isPriceOverridden,
      is_price_overridden: isPriceOverridden,
      discount: discountAmount,
      discountAmount,
      discount_amount: discountAmount,
      discountBaseUnitPrice: baseUnitPrice,
      discountBaseTotalPrice: baseTotal,
      lineDiscountMode: mode,
      lineDiscountValue: safeValue,
    };
  });
};

export const clearDiscountFromCartLines = <T extends DiscountableCartLine>(
  items: T[],
  selectedIds: Iterable<T['id']>,
): T[] => {
  const selectedIdSet = new Set(selectedIds);

  return items.map((item) => {
    if (!selectedIdSet.has(item.id) || !hasAppliedLineDiscount(item)) {
      return item;
    }

    const quantity = getCartLineQuantity(item);
    const restoredUnitPrice = roundMoney(
      finiteNumber(item.discountBaseUnitPrice, getCartLineOriginalUnitPrice(item)),
    );
    const restoredTotal = roundMoney(
      finiteNumber(item.discountBaseTotalPrice, restoredUnitPrice * quantity),
    );
    const originalUnitPrice = getCartLineOriginalUnitPrice(item);
    const isPriceOverridden = Math.abs(restoredUnitPrice - originalUnitPrice) > 0.0001;

    return {
      ...item,
      price: restoredUnitPrice,
      unitPrice: restoredUnitPrice,
      unit_price: restoredUnitPrice,
      totalPrice: restoredTotal,
      total_price: restoredTotal,
      isPriceOverridden,
      is_price_overridden: isPriceOverridden,
      discount: 0,
      discountAmount: 0,
      discount_amount: 0,
      discountBaseUnitPrice: undefined,
      discountBaseTotalPrice: undefined,
      lineDiscountMode: undefined,
      lineDiscountValue: undefined,
    };
  });
};
