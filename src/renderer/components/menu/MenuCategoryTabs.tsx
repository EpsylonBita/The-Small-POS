import React, { useCallback, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../../contexts/theme-context';

type MenuFlavorType = 'savory' | 'sweet';

interface MenuCategoryFlavorItem {
  category_id?: string | null;
  categoryId?: string | null;
  category?: { id?: string | null } | string | null;
  flavor_type?: MenuFlavorType | 'all' | 'savoury' | null;
  flavorType?: MenuFlavorType | 'all' | 'savoury' | null;
}

interface MenuCategoryTabsProps {
  selectedCategory: string;
  onCategoryChange: (categoryId: string) => void;
  selectedSubcategory?: string;
  onSubcategoryChange?: (subcategoryId: string) => void;
  categories: Array<{ id: string; name: string; icon?: string }>;
  menuItems?: MenuCategoryFlavorItem[];
}

export const MenuCategoryTabs: React.FC<MenuCategoryTabsProps> = React.memo(({
  selectedCategory,
  onCategoryChange,
  selectedSubcategory = '',
  onSubcategoryChange,
  categories,
  menuItems = []
}) => {
  const { t } = useTranslation();
  const { resolvedTheme } = useTheme();
  // Founder 01/11: the rows are kit scroll rows (glassmorphism.css .pos-scroll-row, utils/scroll-rows.ts) — they
  // follow a mouse drag and fade at an edge that has more to show, like every sideways row of the till.

  const resolveItemCategoryId = (item: MenuCategoryFlavorItem): string | null => {
    if (typeof item.category_id === 'string' && item.category_id.trim()) return item.category_id;
    if (typeof item.categoryId === 'string' && item.categoryId.trim()) return item.categoryId;
    if (typeof item.category === 'string' && item.category.trim()) return item.category;
    if (item.category && typeof item.category === 'object' && typeof item.category.id === 'string' && item.category.id.trim()) {
      return item.category.id;
    }
    return null;
  };

  const normalizeFlavorType = (value: unknown): MenuFlavorType | null => {
    if (typeof value !== 'string') return null;
    const normalized = value.trim().toLowerCase();
    if (normalized === 'savoury') return 'savory';
    return normalized === 'savory' || normalized === 'sweet' ? normalized : null;
  };

  // Get subcategories that have actual items in the selected category.
  const getSubcategories = useCallback((categoryId: string) => {
    if (categoryId === 'all' || categoryId === 'featured') {
      return [];
    }

    const category = categories.find(cat => cat.id === categoryId);
    if (!category) return [];

    const categoryItems = menuItems.filter((item) => resolveItemCategoryId(item) === categoryId);
    const hasSavoryItems = categoryItems.some((item) => normalizeFlavorType(item.flavor_type ?? item.flavorType) === 'savory');
    const hasSweetItems = categoryItems.some((item) => normalizeFlavorType(item.flavor_type ?? item.flavorType) === 'sweet');

    return [
      ...(hasSavoryItems ? [{ id: `${categoryId}-savory`, name: t('menu.categories.savory', 'Savoury'), icon: '🧂' }] : []),
      ...(hasSweetItems ? [{ id: `${categoryId}-sweet`, name: t('menu.categories.sweet'), icon: '🍯' }] : [])
    ];
  }, [categories, menuItems, t]);

  const subcategories = useMemo(
    () => getSubcategories(selectedCategory),
    [getSubcategories, selectedCategory],
  );

  useEffect(() => {
    if (!onSubcategoryChange || !selectedSubcategory) return;

    const selectedSubcategoryStillExists = subcategories.some(
      (subcategory) => subcategory.id === selectedSubcategory,
    );
    if (!selectedSubcategoryStillExists) {
      onSubcategoryChange(subcategories[0]?.id ?? '');
    }
  }, [onSubcategoryChange, selectedSubcategory, subcategories]);

  const handleCategoryChange = useCallback((categoryId: string) => {
    onCategoryChange(categoryId);
    // Auto-select the first available flavor filter when this category has one.
    if (onSubcategoryChange) {
      const subs = getSubcategories(categoryId);
      onSubcategoryChange(subs.length > 0 ? subs[0].id : '');
    }
  }, [onCategoryChange, onSubcategoryChange, getSubcategories]);

  const handleSubcategoryChange = useCallback((subcategoryId: string) => {
    if (onSubcategoryChange) {
      onSubcategoryChange(subcategoryId);
    }
  }, [onSubcategoryChange]);

  return (
    <div className="border-b border-gray-200/20 pb-1">
      {/* Main Categories */}
      <div className="relative px-2 py-3 sm:px-3 sm:py-4">
        <div className="pos-scroll-row max-w-full select-none gap-1 sm:gap-1.5" data-testid="menu-categories">
          {categories.map((category) => (
            <button
              key={category.id}
              onClick={() => handleCategoryChange(category.id)}
              className={`min-h-[38px] shrink-0 whitespace-nowrap rounded-xl border px-3 py-2 text-[13px] font-semibold antialiased shadow-xs backdrop-blur-md transition-all duration-200 touch-feedback active:translate-y-0 active:scale-95 sm:px-3.5 ${
                selectedCategory === category.id
                  ? resolvedTheme === 'dark'
                    ? 'border-(--pos-s-sel-bg) bg-(--pos-s-sel-bg) text-(--pos-s-sel-fg) shadow-none'
                    : 'border-(--pos-s-sel-bg) bg-(--pos-s-sel-bg) text-(--pos-s-sel-fg) shadow-none'
                  : resolvedTheme === 'dark'
                    ? 'border-white/12 bg-white/8 text-zinc-100 shadow-black/20 active:border-white/25 active:bg-white/[0.14]'
                    : 'border-white/70 bg-white/75 text-gray-800 shadow-gray-900/5 active:border-gray-300 active:bg-white'
              }`}
            >
              {category.name}
            </button>
          ))}
        </div>
      </div>

      {/* Subcategories - only show if there are subcategories */}
      {subcategories.length > 0 && (
        <div className="px-2 pb-4 pt-1 sm:px-4 sm:pb-5">
          <div className="pos-scroll-row gap-2" data-testid="menu-subcategories">
            {subcategories.map((subcategory) => (
              <button
                key={subcategory.id}
                onClick={() => handleSubcategoryChange(subcategory.id)}
                className={`min-h-[40px] whitespace-nowrap rounded-full border px-3.5 py-2 text-sm font-semibold antialiased shadow-xs backdrop-blur-md transition-all duration-200 touch-feedback active:translate-y-0 active:scale-95 sm:px-4 ${
                  selectedSubcategory === subcategory.id
                    ? resolvedTheme === 'dark'
                      ? 'border-(--pos-s-sel-bg) bg-(--pos-s-sel-bg) text-(--pos-s-sel-fg) shadow-none'
                      : 'border-(--pos-s-sel-bg) bg-(--pos-s-sel-bg) text-(--pos-s-sel-fg) shadow-none'
                    : resolvedTheme === 'dark'
                      ? 'border-white/12 bg-white/8 text-zinc-100 shadow-black/20 active:border-white/25 active:bg-white/[0.14]'
                      : 'border-white/70 bg-white/75 text-gray-700 shadow-gray-900/5 active:border-gray-300 active:bg-white'
                }`}
              >
                {subcategory.name}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
});
