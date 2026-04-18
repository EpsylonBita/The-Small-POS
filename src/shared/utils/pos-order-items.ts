const POS_ORDER_ITEM_UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const MANUAL_SENTINEL = 'manual';

const MANUAL_ITEM_DEFAULTS = {
  vatCategoryCode: 'gr_standard_24',
  priceIncludesVat: true,
  fiscalDocumentProfile: 'manual_item',
} as const;

const normalizeOptionalString = (value: unknown): string | null => {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const normalizeFiniteNumber = (value: unknown, fallback = 0): number => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
};

const normalizeOptionalBoolean = (value: unknown): boolean | null => {
  if (typeof value === 'boolean') {
    return value;
  }

  return null;
};

const deriveCategoryPath = (
  categoryName: string | null,
  subcategoryName: string | null,
  explicitPath: string | null,
): string | null => {
  if (explicitPath) {
    return explicitPath;
  }

  if (categoryName && subcategoryName) {
    return categoryName.toLowerCase() === subcategoryName.toLowerCase()
      ? categoryName
      : `${categoryName} > ${subcategoryName}`;
  }

  return categoryName || subcategoryName || null;
};

export const getRawPosOrderMenuItemId = (item: Record<string, any>): string | null =>
  normalizeOptionalString(item?.menu_item_id) ||
  normalizeOptionalString(item?.menuItemId) ||
  normalizeOptionalString(item?.id);

export const isLegacyManualMenuItemId = (value: unknown): boolean =>
  normalizeOptionalString(value)?.toLowerCase() === MANUAL_SENTINEL;

export const isManualPosOrderItem = (item: Record<string, any>): boolean =>
  item?.is_manual === true ||
  item?.isManual === true ||
  isLegacyManualMenuItemId(
    normalizeOptionalString(item?.menu_item_id) ||
      normalizeOptionalString(item?.menuItemId),
  );

export const hasValidSyncedPosMenuItemId = (item: {
  menu_item_id?: unknown;
  menuItemId?: unknown;
  is_manual?: unknown;
  isManual?: unknown;
}): boolean => {
  if (isManualPosOrderItem(item as Record<string, any>)) {
    return true;
  }

  const candidate =
    normalizeOptionalString(item.menu_item_id) ||
    normalizeOptionalString(item.menuItemId);

  return typeof candidate === 'string' && POS_ORDER_ITEM_UUID_REGEX.test(candidate);
};

export const normalizePosOrderItem = (item: Record<string, any>) => {
  const rawMenuItemId = getRawPosOrderMenuItemId(item);
  const isManual = isManualPosOrderItem(item);
  const normalizedMenuItemId = isManual ? null : rawMenuItemId;
  const quantity = Math.max(1, Math.round(normalizeFiniteNumber(item.quantity, 1)));
  const unitPrice = normalizeFiniteNumber(
    item.unit_price ?? item.unitPrice ?? item.basePrice ?? item.price,
    0,
  );
  const originalUnitPrice = normalizeFiniteNumber(
    item.original_unit_price ??
      item.originalUnitPrice ??
      item.basePrice ??
      item.unit_price ??
      item.unitPrice ??
      item.price,
    unitPrice,
  );
  const totalPrice = normalizeFiniteNumber(
    item.total_price ?? item.totalPrice,
    unitPrice * quantity,
  );
  const isPriceOverridden =
    item.is_price_overridden === true ||
    item.isPriceOverridden === true ||
    Math.abs(unitPrice - originalUnitPrice) > 0.0001;
  const categoryId =
    normalizeOptionalString(item.category_id) ||
    normalizeOptionalString(item.categoryId) ||
    normalizeOptionalString(item.category?.id);
  const categoryName =
    normalizeOptionalString(item.category_name) ||
    normalizeOptionalString(item.categoryName) ||
    normalizeOptionalString(item.category?.name) ||
    normalizeOptionalString(item.menu_item?.category_name) ||
    normalizeOptionalString(item.menu_item?.categoryName);
  const subcategoryName =
    normalizeOptionalString(item.subcategory_name) ||
    normalizeOptionalString(item.subcategoryName) ||
    normalizeOptionalString(item.sub_category_name) ||
    normalizeOptionalString(item.subCategoryName) ||
    normalizeOptionalString(item.menu_item_name) ||
    normalizeOptionalString(item.menuItemName) ||
    normalizeOptionalString(item.name) ||
    normalizeOptionalString(item.title);
  const categoryPath = deriveCategoryPath(
    categoryName,
    subcategoryName,
    normalizeOptionalString(item.category_path) || normalizeOptionalString(item.categoryPath),
  );
  const name =
    normalizeOptionalString(item.name) ||
    normalizeOptionalString(item.title) ||
    normalizeOptionalString(item.menu_item_name) ||
    normalizeOptionalString(item.menuItemName) ||
    subcategoryName ||
    'Item';
  const notes =
    normalizeOptionalString(item.notes) ||
    normalizeOptionalString(item.special_instructions) ||
    normalizeOptionalString(item.specialInstructions) ||
    normalizeOptionalString(item.instructions) ||
    undefined;
  const instructions = normalizeOptionalString(item.instructions) || undefined;
  const specialInstructions =
    normalizeOptionalString(item.special_instructions) ||
    normalizeOptionalString(item.specialInstructions) ||
    undefined;
  const vatCategoryCode =
    normalizeOptionalString(item.vat_category_code) ||
    normalizeOptionalString(item.vatCategoryCode) ||
    (isManual ? MANUAL_ITEM_DEFAULTS.vatCategoryCode : null);
  const priceIncludesVat =
    normalizeOptionalBoolean(item.price_includes_vat) ??
    normalizeOptionalBoolean(item.priceIncludesVat) ??
    MANUAL_ITEM_DEFAULTS.priceIncludesVat;
  const taxExemptionReason =
    normalizeOptionalString(item.tax_exemption_reason) ||
    normalizeOptionalString(item.taxExemptionReason);
  const fiscalDocumentProfile =
    normalizeOptionalString(item.fiscal_document_profile) ||
    normalizeOptionalString(item.fiscalDocumentProfile) ||
    (isManual ? MANUAL_ITEM_DEFAULTS.fiscalDocumentProfile : null);
  const localLineId =
    normalizeOptionalString(item.id) ||
    rawMenuItemId ||
    normalizeOptionalString(item.name) ||
    'item';

  return {
    ...item,
    id: localLineId,
    menu_item_id: normalizedMenuItemId,
    menuItemId: normalizedMenuItemId,
    name,
    menu_item_name: name,
    menuItemName: name,
    quantity,
    price: unitPrice,
    unit_price: unitPrice,
    unitPrice: unitPrice,
    total_price: totalPrice,
    totalPrice: totalPrice,
    original_unit_price: originalUnitPrice,
    originalUnitPrice: originalUnitPrice,
    is_price_overridden: isPriceOverridden,
    isPriceOverridden: isPriceOverridden,
    customizations: item.customizations ?? item.selectedIngredients ?? null,
    notes,
    instructions,
    special_instructions: specialInstructions,
    specialInstructions,
    category_id: categoryId,
    categoryId,
    category_name: categoryName,
    categoryName,
    subcategory_name: subcategoryName,
    subcategoryName,
    category_path: categoryPath,
    categoryPath,
    is_manual: isManual,
    isManual,
    vat_category_code: vatCategoryCode,
    vatCategoryCode,
    price_includes_vat: priceIncludesVat,
    priceIncludesVat,
    tax_exemption_reason: taxExemptionReason,
    taxExemptionReason,
    fiscal_document_profile: fiscalDocumentProfile,
    fiscalDocumentProfile,
  };
};

export const normalizePosOrderItems = (items: Record<string, any>[]) =>
  items.map((item) => normalizePosOrderItem(item));

export { MANUAL_ITEM_DEFAULTS, POS_ORDER_ITEM_UUID_REGEX };
