export interface TableCheckPaidItemRecord {
  itemIndex?: number;
  item_index?: number;
  itemAmount?: number;
  item_amount?: number;
}

export interface TableCheckDiscountableItem {
  quantity?: number | string | null;
  unit_price?: number | string | null;
  unitPrice?: number | string | null;
  price?: number | string | null;
  total_price?: number | string | null;
  totalPrice?: number | string | null;
  original_unit_price?: number | string | null;
  originalUnitPrice?: number | string | null;
  is_price_overridden?: boolean | null;
  isPriceOverridden?: boolean | null;
  discount?: number | string | null;
  discountAmount?: number | string | null;
}

export interface TableCheckMergeableItem extends TableCheckDiscountableItem {
  id?: string | null;
  order_item_id?: string | null;
  menu_item_id?: string | null;
  menuItemId?: string | null;
  name?: string | null;
  menu_item_name?: string | null;
}

export interface TableCheckAllocationLike {
  order_item_id?: string | null;
  quantity?: number | string | null;
  paid_quantity?: number | string | null;
  status?: string | null;
  metadata?: unknown;
}

const moneyNumber = (value: unknown): number => {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
};

const positiveMoneyNumber = (value: unknown): number | null => {
  if (value === null || value === undefined || String(value).trim() === '') {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
};

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};

const normalizeText = (value: unknown): string => String(value ?? '').trim().toLowerCase();

const itemMenuId = (item: TableCheckMergeableItem): string =>
  normalizeText(item.menu_item_id ?? item.menuItemId);

const itemName = (item: TableCheckMergeableItem): string =>
  normalizeText(item.name ?? item.menu_item_name);

const itemIdentityMatches = (left: TableCheckMergeableItem, right: TableCheckMergeableItem): boolean => {
  const leftMenuId = itemMenuId(left);
  const rightMenuId = itemMenuId(right);
  if (leftMenuId && rightMenuId && leftMenuId === rightMenuId) {
    return true;
  }

  const leftName = itemName(left);
  const rightName = itemName(right);
  return Boolean(leftName && rightName && leftName === rightName);
};

function findLocalAdjustment(
  remoteItem: TableCheckMergeableItem,
  localItems: TableCheckMergeableItem[],
  remoteIndex: number,
  usedLocalIndexes: Set<number>,
): TableCheckMergeableItem | null {
  const indexedLocal = localItems[remoteIndex];
  if (indexedLocal && !usedLocalIndexes.has(remoteIndex) && itemIdentityMatches(remoteItem, indexedLocal)) {
    usedLocalIndexes.add(remoteIndex);
    return indexedLocal;
  }

  const matchedIndex = localItems.findIndex((item, index) =>
    !usedLocalIndexes.has(index) && itemIdentityMatches(remoteItem, item)
  );
  if (matchedIndex >= 0) {
    usedLocalIndexes.add(matchedIndex);
    return localItems[matchedIndex];
  }

  if (indexedLocal && !usedLocalIndexes.has(remoteIndex)) {
    usedLocalIndexes.add(remoteIndex);
    return indexedLocal;
  }

  return null;
}

const itemOrderItemId = (item: TableCheckMergeableItem): string => normalizeText(item.order_item_id ?? item.id);

const activeAllocationStatus = (allocation: TableCheckAllocationLike): boolean => {
  const status = normalizeText(allocation.status);
  return status !== 'transferred' && status !== 'voided' && status !== 'cancelled';
};

const itemLineUnitPrice = (item: TableCheckDiscountableItem, quantity: number): number => {
  const total = moneyNumber(item.total_price ?? item.totalPrice);
  if (total > 0 && quantity > 0) {
    return total / quantity;
  }
  return Math.max(0, moneyNumber(item.unit_price ?? item.unitPrice ?? item.price));
};

const allocationUnitPrice = (
  allocation: TableCheckAllocationLike,
  item: TableCheckMergeableItem,
  quantity: number,
): number => {
  const metadata = asRecord(allocation.metadata);
  const metadataUnit = positiveMoneyNumber(
    metadata.effective_unit_price ??
      metadata.unit_price ??
      metadata.transferred_unit_price,
  );
  if (metadataUnit !== null) {
    return metadataUnit;
  }

  const metadataTotal = positiveMoneyNumber(
    metadata.effective_total_price ??
      metadata.total_price ??
      metadata.transferred_total_price,
  );
  if (metadataTotal !== null && quantity > 0) {
    return metadataTotal / quantity;
  }

  return itemLineUnitPrice(item, quantity);
};

function applyAllocationPricing(
  item: TableCheckMergeableItem,
  allocation: TableCheckAllocationLike,
  quantity: number,
): TableCheckMergeableItem {
  const metadata = asRecord(allocation.metadata);
  const boundedQuantity = quantity > 0 ? quantity : Math.max(1, moneyNumber(item.quantity) || 1);
  const unitPrice = Number(allocationUnitPrice(allocation, item, boundedQuantity).toFixed(2));
  const totalPrice = Number((unitPrice * boundedQuantity).toFixed(2));
  const originalUnitPrice = positiveMoneyNumber(
    metadata.original_unit_price ??
      metadata.originalUnitPrice ??
      item.original_unit_price ??
      item.originalUnitPrice,
  );
  const discountAmount = positiveMoneyNumber(metadata.discount_amount ?? metadata.discountAmount) ?? 0;
  const isPriceOverridden =
    metadata.is_price_overridden === true ||
    metadata.isPriceOverridden === true ||
    discountAmount > 0.009 ||
    (originalUnitPrice !== null && Math.abs(originalUnitPrice - unitPrice) > 0.005);

  return {
    ...item,
    quantity: boundedQuantity,
    unit_price: unitPrice,
    unitPrice: unitPrice,
    price: unitPrice,
    total_price: totalPrice,
    totalPrice: totalPrice,
    ...(originalUnitPrice !== null ? { original_unit_price: originalUnitPrice, originalUnitPrice } : {}),
    ...(discountAmount > 0 ? { discount: discountAmount, discountAmount } : {}),
    is_price_overridden: isPriceOverridden,
    isPriceOverridden: isPriceOverridden,
  } as TableCheckMergeableItem;
}

export function scopeTableCheckItemsToActiveAllocations(
  items: TableCheckMergeableItem[] | null | undefined,
  allocations: TableCheckAllocationLike[] | null | undefined,
): TableCheckMergeableItem[] {
  const itemList = Array.isArray(items) ? items : [];
  const allocationList = Array.isArray(allocations) ? allocations : [];
  if (itemList.length === 0) {
    return [];
  }
  if (allocationList.length === 0) {
    return itemList.map(item => ({ ...item }));
  }

  const allocationsByItemId = new Map<string, { quantity: number; allocation: TableCheckAllocationLike }>();
  for (const allocation of allocationList) {
    if (!activeAllocationStatus(allocation) || !allocation.order_item_id) {
      continue;
    }
    const orderItemId = normalizeText(allocation.order_item_id);
    if (!orderItemId) {
      continue;
    }

    const quantity = Math.max(0, moneyNumber(allocation.quantity));
    const existing = allocationsByItemId.get(orderItemId);
    allocationsByItemId.set(orderItemId, {
      quantity: Number(((existing?.quantity || 0) + quantity).toFixed(3)),
      allocation: existing?.allocation || allocation,
    });
  }

  if (allocationsByItemId.size === 0) {
    return [];
  }

  return itemList
    .filter(item => {
      const id = itemOrderItemId(item);
      return Boolean(id && allocationsByItemId.has(id));
    })
    .map(item => {
      const allocationGroup = allocationsByItemId.get(itemOrderItemId(item));
      return allocationGroup
        ? applyAllocationPricing(item, allocationGroup.allocation, allocationGroup.quantity)
        : { ...item };
    });
}

export function mergeRemoteTableCheckItemsWithLocalAdjustments(
  remoteItems: TableCheckMergeableItem[] | null | undefined,
  localItems: TableCheckMergeableItem[] | null | undefined,
): TableCheckMergeableItem[] {
  const remoteList = Array.isArray(remoteItems) ? remoteItems : [];
  const localList = Array.isArray(localItems) ? localItems : [];

  if (remoteList.length === 0) {
    return localList.map(item => ({ ...item }));
  }

  if (localList.length === 0) {
    return remoteList.map(item => ({ ...item }));
  }

  const usedLocalIndexes = new Set<number>();

  return remoteList.map((remoteItem, index) => {
    const localItem = findLocalAdjustment(remoteItem, localList, index, usedLocalIndexes);
    if (!localItem) {
      return { ...remoteItem };
    }

    return {
      ...remoteItem,
      name: localItem.name ?? localItem.menu_item_name ?? remoteItem.name,
      menu_item_name: localItem.menu_item_name ?? localItem.name ?? remoteItem.menu_item_name,
      menu_item_id: remoteItem.menu_item_id ?? localItem.menu_item_id ?? localItem.menuItemId,
      menuItemId: remoteItem.menuItemId ?? remoteItem.menu_item_id ?? localItem.menuItemId ?? localItem.menu_item_id,
      quantity: localItem.quantity ?? remoteItem.quantity,
      price: localItem.price ?? remoteItem.price,
      unit_price: localItem.unit_price ?? localItem.unitPrice ?? remoteItem.unit_price,
      unitPrice: localItem.unitPrice ?? localItem.unit_price ?? remoteItem.unitPrice,
      total_price: localItem.total_price ?? localItem.totalPrice ?? remoteItem.total_price,
      totalPrice: localItem.totalPrice ?? localItem.total_price ?? remoteItem.totalPrice,
      original_unit_price: localItem.original_unit_price ?? localItem.originalUnitPrice ?? remoteItem.original_unit_price,
      originalUnitPrice: localItem.originalUnitPrice ?? localItem.original_unit_price ?? remoteItem.originalUnitPrice,
      discount: localItem.discount ?? remoteItem.discount,
      discountAmount: localItem.discountAmount ?? remoteItem.discountAmount,
      order_item_id: remoteItem.order_item_id,
      id: remoteItem.id,
    };
  });
}

export function resolveTableCheckItemDiscount(item: TableCheckDiscountableItem): number {
  const explicitDiscount = Math.max(
    moneyNumber(item.discount),
    moneyNumber(item.discountAmount),
  );
  if (explicitDiscount > 0) {
    return Number(explicitDiscount.toFixed(2));
  }

  const quantity = Math.max(1, moneyNumber(item.quantity) || 1);
  const currentUnit = moneyNumber(item.unit_price ?? item.unitPrice ?? item.price);
  const currentLine = moneyNumber(item.total_price ?? item.totalPrice) || currentUnit * quantity;
  const originalUnit = moneyNumber(item.original_unit_price ?? item.originalUnitPrice);
  const originalLine = originalUnit > 0 ? originalUnit * quantity : 0;

  return Number(Math.max(0, originalLine - currentLine).toFixed(2));
}

export function sumTableCheckItemDiscounts(items: TableCheckDiscountableItem[]): number {
  return Number(
    items.reduce((sum, item) => sum + resolveTableCheckItemDiscount(item), 0).toFixed(2),
  );
}

export function sumTableCheckLineTotals(items: TableCheckDiscountableItem[]): number {
  return Number(
    items.reduce((sum, item) => {
      const quantity = Math.max(1, moneyNumber(item.quantity) || 1);
      const lineTotal = moneyNumber(item.total_price ?? item.totalPrice);
      if (lineTotal > 0) {
        return sum + lineTotal;
      }
      return sum + itemLineUnitPrice(item, quantity) * quantity;
    }, 0).toFixed(2),
  );
}

/**
 * Distribute an order-level discount across a table check's line items.
 *
 * An order-level discount (e.g. a cart percentage discount applied while building
 * a table order) lives on the order total, NOT on the per-line prices. When the
 * table account is rebuilt from line items, summing the raw lines resurrects the
 * pre-discount subtotal. This scales each line down to the discounted target total
 * so the balance, per-item unpaid amounts, summary and payment default all agree,
 * and surfaces the difference as an explicit per-line discount.
 *
 * Returns the items unchanged when there is no order-level discount to apply
 * (target at/above the line sum, or no basis), so it is safe to call idempotently.
 */
export function applyTableCheckOrderLevelDiscount<T extends TableCheckMergeableItem>(
  items: T[] | null | undefined,
  targetOrderTotal: number,
): T[] {
  const list = Array.isArray(items) ? items : [];
  if (list.length === 0) {
    return list as T[];
  }

  const lineSum = sumTableCheckLineTotals(list);
  const target = Math.max(0, moneyNumber(targetOrderTotal));

  // No basis, or no order-level discount (target at/above the line sum — an
  // already-discounted check, no discount, or a surcharge): leave items untouched.
  if (lineSum <= 0 || target >= lineSum - 0.005) {
    return list as T[];
  }

  const ratio = target / lineSum;
  const lastIndex = list.length - 1;
  let distributedSoFar = 0;

  return list.map((item, index) => {
    const quantity = Math.max(1, moneyNumber(item.quantity) || 1);
    const originalLine = Number(
      (moneyNumber(item.total_price ?? item.totalPrice) || itemLineUnitPrice(item, quantity) * quantity).toFixed(2),
    );
    const originalUnit = Number(
      (
        moneyNumber(item.original_unit_price ?? item.originalUnitPrice) ||
        (quantity > 0 ? originalLine / quantity : originalLine)
      ).toFixed(2),
    );

    // Scale every line by the discount ratio; the final line absorbs any rounding
    // drift so the distributed lines sum exactly to the discounted target total.
    const discountedLine =
      index === lastIndex
        ? Number(Math.max(0, target - distributedSoFar).toFixed(2))
        : Number((originalLine * ratio).toFixed(2));
    if (index !== lastIndex) {
      distributedSoFar = Number((distributedSoFar + discountedLine).toFixed(2));
    }

    const discountedUnit = quantity > 0 ? Number((discountedLine / quantity).toFixed(2)) : discountedLine;
    const existingDiscount = resolveTableCheckItemDiscount(item);
    const orderLevelDiscount = Number(Math.max(0, originalLine - discountedLine).toFixed(2));
    const lineDiscount = Number((existingDiscount + orderLevelDiscount).toFixed(2));

    return {
      ...item,
      unit_price: discountedUnit,
      unitPrice: discountedUnit,
      price: discountedUnit,
      total_price: discountedLine,
      totalPrice: discountedLine,
      original_unit_price: originalUnit,
      originalUnitPrice: originalUnit,
      is_price_overridden: true,
      isPriceOverridden: true,
      discount: lineDiscount,
      discountAmount: lineDiscount,
    } as T;
  });
}

export function resolveTableCheckOrderTotal(input: {
  remoteTotal: number;
  localTotal: number;
  hasLocalOrderItems: boolean;
}): number {
  const remoteTotal = Number(input.remoteTotal || 0);
  const localTotal = Number(input.localTotal || 0);

  if (input.hasLocalOrderItems && localTotal > 0) {
    return Number(localTotal.toFixed(2));
  }

  return Number(Math.max(remoteTotal, localTotal).toFixed(2));
}

export function buildUnpaidAmountByItemId<T extends { id: string }>(
  items: T[],
  paidItemRecords: TableCheckPaidItemRecord[],
  paidTotal: number,
  itemLineTotal: (item: T) => number,
): Map<string, number> {
  const itemSpecificPaidById = new Map<string, number>();

  for (const paidItem of paidItemRecords) {
    const itemIndex = Number(paidItem.itemIndex ?? paidItem.item_index ?? -1);
    const item = Number.isInteger(itemIndex) && itemIndex >= 0 ? items[itemIndex] : null;
    if (!item) {
      continue;
    }

    const amount = Math.max(0, Number(paidItem.itemAmount ?? paidItem.item_amount ?? 0) || 0);
    itemSpecificPaidById.set(
      item.id,
      Number(((itemSpecificPaidById.get(item.id) || 0) + amount).toFixed(2)),
    );
  }

  const unpaidAfterItemPayments = new Map<string, number>();
  let tableLevelPaidRemainder = Math.max(0, Number(paidTotal || 0));

  for (const item of items) {
    const lineTotal = Math.max(0, Number(itemLineTotal(item) || 0));
    const itemSpecificPaid = itemSpecificPaidById.get(item.id) || 0;
    const appliedItemSpecificPaid = Math.min(lineTotal, itemSpecificPaid, tableLevelPaidRemainder);
    tableLevelPaidRemainder = Number((tableLevelPaidRemainder - appliedItemSpecificPaid).toFixed(2));
    unpaidAfterItemPayments.set(
      item.id,
      Number(Math.max(0, lineTotal - appliedItemSpecificPaid).toFixed(2)),
    );
  }

  const map = new Map<string, number>();

  for (const item of items) {
    const unpaidAfterItemPayment = unpaidAfterItemPayments.get(item.id) || 0;
    const tableLevelAllocation = Math.min(tableLevelPaidRemainder, unpaidAfterItemPayment);
    tableLevelPaidRemainder = Number((tableLevelPaidRemainder - tableLevelAllocation).toFixed(2));
    map.set(item.id, Number(Math.max(0, unpaidAfterItemPayment - tableLevelAllocation).toFixed(2)));
  }

  return map;
}
