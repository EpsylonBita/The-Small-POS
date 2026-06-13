import React, { useCallback, useState, useRef, useEffect, useMemo } from 'react';
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
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [startX, setStartX] = useState(0);
  const [scrollLeft, setScrollLeft] = useState(0);
  const [showLeftFade, setShowLeftFade] = useState(false);
  const [showRightFade, setShowRightFade] = useState(false);

  // Check scroll position to show/hide fade effects
  const checkScroll = useCallback(() => {
    if (scrollContainerRef.current) {
      const { scrollLeft, scrollWidth, clientWidth } = scrollContainerRef.current;
      setShowLeftFade(scrollLeft > 10);
      setShowRightFade(scrollLeft < scrollWidth - clientWidth - 10);
    }
  }, []);

  // Update fade effects on mount and scroll
  useEffect(() => {
    checkScroll();
    const container = scrollContainerRef.current;
    if (container) {
      container.addEventListener('scroll', checkScroll);
      return () => container.removeEventListener('scroll', checkScroll);
    }
  }, [checkScroll, categories]);

  // Mouse drag handlers
  const handleMouseDown = (e: React.MouseEvent) => {
    if (!scrollContainerRef.current) return;
    setIsDragging(true);
    setStartX(e.pageX - scrollContainerRef.current.offsetLeft);
    setScrollLeft(scrollContainerRef.current.scrollLeft);
    scrollContainerRef.current.style.cursor = 'grabbing';
  };

  const handleMouseLeave = () => {
    setIsDragging(false);
    if (scrollContainerRef.current) {
      scrollContainerRef.current.style.cursor = 'grab';
    }
  };

  const handleMouseUp = () => {
    setIsDragging(false);
    if (scrollContainerRef.current) {
      scrollContainerRef.current.style.cursor = 'grab';
    }
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isDragging || !scrollContainerRef.current) return;
    e.preventDefault();
    const x = e.pageX - scrollContainerRef.current.offsetLeft;
    const walk = (x - startX) * 2; // Scroll speed multiplier
    scrollContainerRef.current.scrollLeft = scrollLeft - walk;
  };

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

  const categoryFadeMask = [
    showLeftFade ? 'transparent 0' : 'black 0',
    showLeftFade ? 'black 2.25rem' : 'black 0',
    showRightFade ? 'black calc(100% - 2.25rem)' : 'black 100%',
    showRightFade ? 'transparent 100%' : 'black 100%'
  ].join(', ');
  const categoryScrollStyle: React.CSSProperties = {
    scrollbarWidth: 'none',
    msOverflowStyle: 'none',
    WebkitOverflowScrolling: 'touch',
    ...(showLeftFade || showRightFade
      ? {
          maskImage: `linear-gradient(to right, ${categoryFadeMask})`,
          WebkitMaskImage: `linear-gradient(to right, ${categoryFadeMask})`,
          maskRepeat: 'no-repeat',
          WebkitMaskRepeat: 'no-repeat'
        }
      : {})
  };

  return (
    <div className="border-b border-gray-200/20 pb-1">
      {/* Main Categories */}
      <div className="relative px-2 py-3 sm:px-3 sm:py-4">
        <div
          ref={scrollContainerRef}
          className="flex gap-1.5 overflow-x-auto scrollbar-hide cursor-grab select-none touch-pan-x py-1.5 sm:gap-2"
          data-testid="menu-categories"
          onMouseDown={handleMouseDown}
          onMouseLeave={handleMouseLeave}
          onMouseUp={handleMouseUp}
          onMouseMove={handleMouseMove}
          style={categoryScrollStyle}
        >
          {categories.map((category) => (
            <button
              key={category.id}
              onClick={() => handleCategoryChange(category.id)}
              className={`min-h-[38px] flex-shrink-0 whitespace-nowrap rounded-xl border px-3.5 py-2 text-sm font-semibold antialiased shadow-sm backdrop-blur-md transition-all duration-200 touch-feedback hover:-translate-y-0.5 active:translate-y-0 active:scale-95 sm:px-4 ${
                selectedCategory === category.id
                  ? resolvedTheme === 'dark'
                    ? 'border-yellow-300/55 bg-yellow-400 text-black shadow-none ring-1 ring-yellow-200/25'
                    : 'border-yellow-500/60 bg-yellow-400 text-black shadow-none ring-1 ring-yellow-200/35'
                  : resolvedTheme === 'dark'
                    ? 'border-white/12 bg-white/[0.08] text-zinc-100 shadow-black/20 hover:border-white/25 hover:bg-white/[0.14]'
                    : 'border-white/70 bg-white/75 text-gray-800 shadow-gray-900/5 hover:border-blue-200 hover:bg-white'
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
          <div className="flex space-x-2 overflow-x-auto scrollbar-hide touch-pan-x py-1.5" style={{ scrollbarWidth: 'none', msOverflowStyle: 'none', WebkitOverflowScrolling: 'touch' }}>
            {subcategories.map((subcategory) => (
              <button
                key={subcategory.id}
                onClick={() => handleSubcategoryChange(subcategory.id)}
                className={`min-h-[40px] whitespace-nowrap rounded-full border px-3.5 py-2 text-sm font-semibold antialiased shadow-sm backdrop-blur-md transition-all duration-200 touch-feedback hover:-translate-y-0.5 active:translate-y-0 active:scale-95 sm:px-4 ${
                  selectedSubcategory === subcategory.id
                    ? resolvedTheme === 'dark'
                      ? 'border-emerald-300/45 bg-emerald-500/75 text-white shadow-none ring-1 ring-emerald-200/20'
                      : 'border-emerald-300/60 bg-emerald-500 text-white shadow-none ring-1 ring-emerald-200/30'
                    : resolvedTheme === 'dark'
                      ? 'border-white/12 bg-white/[0.08] text-zinc-100 shadow-black/20 hover:border-white/25 hover:bg-white/[0.14]'
                      : 'border-white/70 bg-white/75 text-gray-700 shadow-gray-900/5 hover:border-emerald-200 hover:bg-white'
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
