type PosMenuPhoto = {
  image_url?: string | null;
  imageUrl?: string | null;
  show_image_in_pos?: boolean | null;
  showImageInPos?: boolean | null;
};

/** Menu visibility controls the photograph, leaving product/orderability intact. */
export function getPosMenuImageUrl(item: PosMenuPhoto): string | null {
  if (item.show_image_in_pos === false || item.showImageInPos === false) return null;
  const url = item.image_url !== undefined ? item.image_url : item.imageUrl;
  return typeof url === 'string' && url.trim() ? url.trim() : null;
}

/** Combo artwork is separate; only the nested canonical product photo is projected. */
export function projectPosMenuComboImages<T extends { items?: Array<{ subcategory?: PosMenuPhoto | null }> | null }>(combo: T): T {
  if (!Array.isArray(combo.items)) return combo;
  return {
    ...combo,
    items: combo.items.map(item => ({
      ...item,
      ...(item.subcategory ? { subcategory: { ...item.subcategory, image_url: getPosMenuImageUrl(item.subcategory) } } : {}),
    })),
  };
}
