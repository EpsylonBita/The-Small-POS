export interface FeaturedMenuItemLike {
  id: string;
  name?: string;
  category_id?: string | null;
  categoryId?: string | null;
  is_featured?: boolean | null;
  flavor_type?: 'savory' | 'sweet' | 'savoury' | null;
  flavorType?: 'savory' | 'sweet' | 'savoury' | null;
}

export interface FeaturedSellerRanking {
  menuItemId: string;
  name: string;
  categoryId?: string | null;
}

export interface FeaturedMenuCategoryLike {
  id: string;
  name: string;
  icon?: string;
}

export interface FeaturedMenuNavigationShortcut {
  id: string;
  kind: 'category' | 'subcategory';
  categoryId: string;
  categoryName: string;
  icon?: string;
  itemCount: number;
  subcategoryId?: string;
  flavorType?: 'savory' | 'sweet';
}

function normalizeRankingText(value: string | null | undefined): string {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLocaleLowerCase('el-GR')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function itemCategoryId(item: FeaturedMenuItemLike): string {
  return String(item.category_id ?? item.categoryId ?? '').trim();
}

function itemFlavorType(item: FeaturedMenuItemLike): 'savory' | 'sweet' | null {
  const flavorType = String(item.flavor_type ?? item.flavorType ?? '').trim().toLocaleLowerCase();
  if (flavorType === 'savoury') return 'savory';
  return flavorType === 'savory' || flavorType === 'sweet' ? flavorType : null;
}

/**
 * Builds navigation shortcuts from the already-ranked Featured snapshot.
 *
 * Category order follows the first ranked product in each category, so the
 * most-used areas stay closest to the cashier. Flavor shortcuts mirror the
 * exact local filters used by MenuCategoryTabs (`<category>-savory|sweet`).
 * Virtual tabs and categories without a ranked item are deliberately omitted.
 */
export function buildFeaturedMenuNavigationShortcuts(
  rankedMenuItems: FeaturedMenuItemLike[],
  categories: FeaturedMenuCategoryLike[],
  categoryLimit = 8,
): FeaturedMenuNavigationShortcut[] {
  const boundedCategoryLimit = Math.max(1, categoryLimit);
  const categoryById = new Map(
    categories
      .filter((category) => category.id !== 'featured' && category.id !== 'combos' && category.id !== 'all')
      .map((category) => [category.id, category]),
  );
  const rankedCategoryIds: string[] = [];
  const categoryItemCounts = new Map<string, number>();
  const categoryFlavorOrder = new Map<string, Array<'savory' | 'sweet'>>();

  for (const item of rankedMenuItems) {
    const categoryId = itemCategoryId(item);
    if (!categoryById.has(categoryId)) continue;

    if (!categoryItemCounts.has(categoryId)) {
      if (rankedCategoryIds.length >= boundedCategoryLimit) continue;
      rankedCategoryIds.push(categoryId);
      categoryItemCounts.set(categoryId, 0);
      categoryFlavorOrder.set(categoryId, []);
    }

    categoryItemCounts.set(categoryId, (categoryItemCounts.get(categoryId) ?? 0) + 1);

    const flavorType = itemFlavorType(item);
    const flavorOrder = categoryFlavorOrder.get(categoryId);
    if (flavorType && flavorOrder && !flavorOrder.includes(flavorType)) {
      flavorOrder.push(flavorType);
    }
  }

  const shortcuts: FeaturedMenuNavigationShortcut[] = [];
  for (const categoryId of rankedCategoryIds) {
    const category = categoryById.get(categoryId);
    if (!category) continue;

    const itemCount = categoryItemCounts.get(categoryId) ?? 0;
    shortcuts.push({
      id: `category:${categoryId}`,
      kind: 'category',
      categoryId,
      categoryName: category.name,
      icon: category.icon,
      itemCount,
    });

    for (const flavorType of categoryFlavorOrder.get(categoryId) ?? []) {
      shortcuts.push({
        id: `subcategory:${categoryId}:${flavorType}`,
        kind: 'subcategory',
        categoryId,
        categoryName: category.name,
        itemCount,
        subcategoryId: `${categoryId}-${flavorType}`,
        flavorType,
      });
    }
  }

  return shortcuts;
}

/**
 * Resolves persisted sales rankings against the current menu. Exact IDs are
 * preferred, then normalized name/category matches recover rankings created
 * before a menu re-import changed IDs. Curated featured items are appended,
 * while a new terminal falls back to the first available menu items.
 */
export function rankFeaturedMenuItems<T extends FeaturedMenuItemLike>(
  menuItems: T[],
  topSellers: FeaturedSellerRanking[],
  limit = 20,
): T[] {
  const boundedLimit = Math.max(1, limit);
  const byId = new Map(menuItems.map((item) => [item.id, item]));
  const byNameAndCategory = new Map<string, T[]>();
  const byName = new Map<string, T[]>();

  for (const item of menuItems) {
    const normalizedName = normalizeRankingText(item.name);
    if (!normalizedName) continue;

    const categoryKey = `${itemCategoryId(item)}:${normalizedName}`;
    byNameAndCategory.set(categoryKey, [...(byNameAndCategory.get(categoryKey) ?? []), item]);
    byName.set(normalizedName, [...(byName.get(normalizedName) ?? []), item]);
  }

  const ranked: T[] = [];
  const seen = new Set<string>();
  const append = (item: T | undefined) => {
    if (!item || seen.has(item.id) || ranked.length >= boundedLimit) return;
    seen.add(item.id);
    ranked.push(item);
  };

  for (const seller of topSellers) {
    const exact = byId.get(String(seller.menuItemId ?? '').trim());
    if (exact) {
      append(exact);
      continue;
    }

    const normalizedName = normalizeRankingText(seller.name);
    if (!normalizedName || normalizedName === 'item') continue;

    const categoryId = String(seller.categoryId ?? '').trim();
    const categoryMatches = byNameAndCategory.get(`${categoryId}:${normalizedName}`) ?? [];
    const categoryMatch = categoryMatches.find((item) => !seen.has(item.id));
    if (categoryMatch) {
      append(categoryMatch);
      continue;
    }

    append((byName.get(normalizedName) ?? []).find((item) => !seen.has(item.id)));
  }

  for (const item of menuItems) {
    if (item.is_featured) append(item);
  }

  if (ranked.length === 0) {
    for (const item of menuItems) append(item);
  }

  return ranked;
}
