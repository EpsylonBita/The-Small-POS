import React, { useCallback, useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../../contexts/theme-context';

interface MenuCategoryTabsProps {
  selectedCategory: string;
  onCategoryChange: (categoryId: string) => void;
  selectedSubcategory?: string;
  onSubcategoryChange?: (subcategoryId: string) => void;
  hideAllItemsButton?: boolean;
  categories: Array<{ id: string; name: string; icon?: string }>;
}

export const MenuCategoryTabs: React.FC<MenuCategoryTabsProps> = React.memo(({
  selectedCategory,
  onCategoryChange,
  selectedSubcategory = '',
  onSubcategoryChange,
  hideAllItemsButton = false,
  categories
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

  // Get subcategories for selected category
  const getSubcategories = useCallback((categoryId: string) => {
    if (categoryId === 'all' || categoryId === 'featured') {
      return [];
    }

    const category = categories.find(cat => cat.id === categoryId);
    if (!category) return [];

    return [
      { id: `${categoryId}-savory`, name: t('menu.categories.savory'), icon: '🧂' },
      { id: `${categoryId}-sweet`, name: t('menu.categories.sweet'), icon: '🍯' }
    ];
  }, [categories, t]);

  const handleCategoryChange = useCallback((categoryId: string) => {
    onCategoryChange(categoryId);
    // Reset subcategory when category changes
    if (onSubcategoryChange) {
      onSubcategoryChange('');
    }
  }, [onCategoryChange, onSubcategoryChange]);

  const handleSubcategoryChange = useCallback((subcategoryId: string) => {
    if (onSubcategoryChange) {
      onSubcategoryChange(subcategoryId);
    }
  }, [onSubcategoryChange]);

  const subcategories = getSubcategories(selectedCategory);

  return (
    <div className="border-b border-gray-200/20">
      {/* Main Categories */}
      <div className="p-2 sm:p-3 relative">
        {/* Left Fade - Opacity mask */}
        {showLeftFade && (
          <div
            className="absolute left-0 top-0 bottom-0 w-24 z-10 pointer-events-none"
            style={{
              background: resolvedTheme === 'dark'
                ? 'linear-gradient(to right, rgb(17, 24, 39) 0%, rgba(17, 24, 39, 0.8) 30%, rgba(17, 24, 39, 0) 100%)'
                : 'linear-gradient(to right, rgb(255, 255, 255) 0%, rgba(255, 255, 255, 0.8) 30%, rgba(255, 255, 255, 0) 100%)'
            }}
          />
        )}

        {/* Right Fade - Opacity mask */}
        {showRightFade && (
          <div
            className="absolute right-0 top-0 bottom-0 w-24 z-10 pointer-events-none"
            style={{
              background: resolvedTheme === 'dark'
                ? 'linear-gradient(to left, rgb(17, 24, 39) 0%, rgba(17, 24, 39, 0.8) 30%, rgba(17, 24, 39, 0) 100%)'
                : 'linear-gradient(to left, rgb(255, 255, 255) 0%, rgba(255, 255, 255, 0.8) 30%, rgba(255, 255, 255, 0) 100%)'
            }}
          />
        )}

        <div
          ref={scrollContainerRef}
          className="flex gap-1.5 sm:gap-2 overflow-x-auto scrollbar-hide cursor-grab select-none touch-pan-x"
          data-testid="menu-categories"
          onMouseDown={handleMouseDown}
          onMouseLeave={handleMouseLeave}
          onMouseUp={handleMouseUp}
          onMouseMove={handleMouseMove}
          style={{ scrollbarWidth: 'none', msOverflowStyle: 'none', WebkitOverflowScrolling: 'touch' }}
        >
          {categories.map((category) => (
            <button
              key={category.id}
              onClick={() => handleCategoryChange(category.id)}
              className={`px-3 py-2 rounded-lg text-sm font-medium transition-all duration-200 whitespace-nowrap min-h-[36px] touch-feedback active:scale-95 flex-shrink-0 ${
                selectedCategory === category.id
                  ? resolvedTheme === 'dark'
                    ? 'bg-blue-600/50 text-blue-200 border border-blue-400/40'
                    : 'bg-blue-500 text-white'
                  : resolvedTheme === 'dark'
                    ? 'bg-gray-800/60 text-gray-300 border border-gray-700/50'
                    : 'bg-gray-100 text-gray-700 border border-gray-200'
              }`}
            >
              {category.name}
            </button>
          ))}
        </div>
      </div>

      {/* Subcategories - only show if there are subcategories */}
      {subcategories.length > 0 && (
        <div className="px-2 sm:px-4 pb-3 sm:pb-4">
          <div className="flex space-x-2 overflow-x-auto scrollbar-hide touch-pan-x" style={{ scrollbarWidth: 'none', msOverflowStyle: 'none', WebkitOverflowScrolling: 'touch' }}>
            {subcategories.map((subcategory) => (
              <button
                key={subcategory.id}
                onClick={() => handleSubcategoryChange(subcategory.id)}
                className={`px-3 sm:px-4 py-2 rounded-full text-sm font-medium transition-all duration-200 whitespace-nowrap min-h-[40px] touch-feedback active:scale-95 ${
                  selectedSubcategory === subcategory.id
                    ? resolvedTheme === 'dark'
                      ? 'bg-gradient-to-r from-green-600/40 to-green-500/40 text-green-300 shadow-[0_3px_15px_rgba(34,197,94,0.4)] border border-green-400/30'
                      : 'bg-gradient-to-r from-green-500 to-green-600 text-white shadow-[0_3px_15px_rgba(34,197,94,0.5)]'
                    : resolvedTheme === 'dark'
                      ? 'bg-gray-800/40 text-gray-400 hover:bg-gray-700/50 active:bg-gray-600/50 border border-gray-700/40 shadow-[0_2px_8px_rgba(0,0,0,0.3)]'
                      : 'bg-gray-100/70 text-gray-600 hover:bg-gray-200/70 active:bg-gray-300/70 border border-gray-200 shadow-[0_2px_8px_rgba(0,0,0,0.1)]'
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