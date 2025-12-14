import React, { useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { formatCurrency } from '../../utils/format';
import AutoSizer from 'react-virtualized-auto-sizer';
import * as ReactWindow from 'react-window';
const Grid: any = (ReactWindow as any).FixedSizeGrid;
import { OptimizedImg } from '../ui/OptimizedImg';


interface MenuItem {
  id: string;
  name: string;
  description: string;
  price: number;
  category_id: string; // Changed from 'category' to match normalized data
  preparationTime: number;
  image?: string;
  is_customizable?: boolean;
  hasOverride?: boolean; // POS branch override flag
  originalPrice?: number; // Base price before override (order-type specific base passed in)
  customizations?: {
    id: string;
    name: string;
    options: {
      id: string;
      name: string;
      price: number;
    }[];
    required: boolean;
    maxSelections?: number;
  }[];
}

interface MenuCategory {
  id: string;
  name: string;
}

interface MenuGridProps {
  items: MenuItem[];
  selectedCategory: string;
  categories: MenuCategory[];
  onCategoryChange: (category: string) => void;
  onItemClick: (item: MenuItem) => void;
  showMostFrequented?: boolean;
  mostFrequentedTitle?: string;
  hideAllItemsButton?: boolean;
  hideCategoryButtons?: boolean;
  orderType?: 'pickup' | 'delivery';
}

export const MenuGrid: React.FC<MenuGridProps> = React.memo(({
  items,
  selectedCategory,
  categories,
  onCategoryChange,
  onItemClick,
  showMostFrequented = false,
  mostFrequentedTitle = "Most Popular Items",
  hideAllItemsButton = false,
  hideCategoryButtons = false,
  orderType
}) => {
  const handleCategoryChange = useCallback((category: string) => {
    onCategoryChange(category);
  }, [onCategoryChange]);

  const handleItemClick = useCallback((item: MenuItem) => {
    onItemClick(item);
  }, [onItemClick]);

  const displayTitle = useMemo(() => {
    if (showMostFrequented && !selectedCategory) {
      return mostFrequentedTitle;
    }
    if (selectedCategory) {
      const category = categories.find(cat => cat.id === selectedCategory);
      return category ? category.name : 'Menu';
    }
    return 'Menu';
  }, [showMostFrequented, selectedCategory, mostFrequentedTitle, categories]);

  return (
    <div className="bg-white rounded-lg shadow-lg p-6">
      {/* Category Filter - only show if not hidden */}
      {!hideCategoryButtons && (
        <div className="mb-6">
          <h2 className="text-xl font-bold text-gray-900 mb-4">{displayTitle}</h2>
          <div className="flex flex-wrap gap-2">
            {/* All Items button - only show if not hidden */}
            {!hideAllItemsButton && (
              <button
                onClick={() => handleCategoryChange('all')}
                className={`px-4 py-2 rounded-lg font-medium transition-colors ${
                  selectedCategory === 'all'
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                }`}
              >
                {showMostFrequented ? mostFrequentedTitle : 'All Items'}
              </button>
            )}

            {/* Category buttons */}
            {categories.map((category) => (
              <button
                key={category.id}
                onClick={() => handleCategoryChange(category.id)}
                className={`px-4 py-2 rounded-lg font-medium transition-colors ${
                  selectedCategory === category.id
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                }`}
              >
                {category.name}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Menu Items Grid (virtualized when large) */}
      <div className="relative" style={{ height: 600 }}>
        {items.length > 40 ? (
          <AutoSizer>
            {({ height, width }) => {
              const gap = 16; // px
              const columns = width < 640 ? 1 : width < 1024 ? 2 : 3;
              const colWidth = Math.floor((width - gap * (columns - 1)) / columns);
              const rowHeight = 260; // px, matches card content approx
              const rowCount = Math.ceil(items.length / columns);
              return (
                <Grid
                  columnCount={columns}
                  columnWidth={colWidth + gap}
                  height={height}
                  rowCount={rowCount}
                  rowHeight={rowHeight + gap}
                  width={width}
                  overscanRowCount={2}
                >
                  {({ columnIndex, rowIndex, style }: { columnIndex: number; rowIndex: number; style: React.CSSProperties }) => {
                    const index = rowIndex * columns + columnIndex;
                    if (index >= items.length) return null;
                    const item = items[index];
                    return (
                      <div
                        style={{ ...style, width: colWidth, height: rowHeight, paddingRight: gap, paddingBottom: gap }}
                      >
                        <MenuItemCard
                          key={item.id}
                          item={item}
                          orderType={orderType}
                          onClick={() => handleItemClick(item)}
                        />
                      </div>
                    );
                  }}
                </Grid>
              );
            }}
          </AutoSizer>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {items.map((item) => (
              <MenuItemCard
                key={item.id}
                item={item}
                orderType={orderType}
                onClick={() => handleItemClick(item)}
              />
            ))}
          </div>
        )}
      </div>

      {items.length === 0 && (
        <div className="flex flex-col items-center justify-center py-12 space-y-4">
          <div className="text-6xl opacity-50">🍽️</div>
          <div className="text-gray-500 text-lg font-medium">
            {selectedCategory ? 'No items in this category' : 'No items found'}
          </div>
          <div className="text-gray-400 text-sm">
            {selectedCategory ? 'Try selecting a different category' : 'Try syncing menu data'}
          </div>
        </div>
      )}
    </div>
  );
});

interface MenuItemCardProps {
  item: MenuItem;
  onClick: () => void;
  orderType?: 'pickup' | 'delivery';
}

const MenuItemCard: React.FC<MenuItemCardProps> = React.memo(({ item, onClick, orderType }) => {
  const { t } = useTranslation();
  return (
    <div
      onClick={onClick}
      className="border border-gray-200 rounded-lg p-4 cursor-pointer transform transition-all duration-200 hover:scale-105 hover:shadow-lg hover:border-blue-300 hover:-translate-y-1"
      style={{ contain: 'content', willChange: 'transform' }}
    >
      {/* Item Image Placeholder */}
      <div className="w-full h-32 bg-gradient-to-br from-gray-50 to-gray-100 rounded-lg mb-3 flex items-center justify-center overflow-hidden">
        {item.image ? (
          <OptimizedImg
            src={item.image}
            alt={item.name}
            className="w-full h-full object-cover rounded-lg transition-transform duration-200 hover:scale-110"
          />
        ) : (
          <div className="text-gray-400 text-4xl animate-pulse">🍽️</div>
        )}
      </div>

      {/* Item Details */}
      <div>
        <h3 className="font-semibold text-gray-900 mb-1">{item.name}</h3>
        <p className="text-gray-600 text-sm mb-2 line-clamp-2">{item.description}</p>

        <div className="flex justify-between items-center">
          <div className="flex items-center gap-2">
            {orderType === 'pickup' && item.hasOverride && typeof item.originalPrice === 'number' && item.originalPrice !== item.price ? (
              <>
                <span className="text-sm text-gray-500 line-through">
                  {formatCurrency(item.originalPrice)}
                </span>
                <span className="text-lg font-bold text-orange-600 bg-orange-50 px-2 py-1 rounded-lg">
                  {formatCurrency(item.price)}
                </span>
              </>
            ) : (
              <span className="text-lg font-bold text-green-600 bg-green-50 px-2 py-1 rounded-lg">
                {formatCurrency(item.price)}
              </span>
            )}
            {orderType && (
              <span className="text-[10px] font-medium text-gray-600 bg-gray-100 px-2 py-0.5 rounded-full uppercase">
                {orderType === 'pickup' ? t('orders.type.pickup') : t('orders.type.delivery')}
              </span>
            )}
          </div>
          <span className="text-xs text-gray-500 bg-gray-100 px-2 py-1 rounded-full">
            ⏱️ {item.preparationTime} min
          </span>
        </div>

        {/* Customization Indicator */}
        {(item.is_customizable || (item.customizations && item.customizations.length > 0)) && (
          <div className="mt-2">
            <span className="text-xs bg-blue-100 text-blue-800 px-3 py-1 rounded-full border border-blue-200 animate-pulse">
              ⚙️ Customizable
            </span>
          </div>
        )}
      </div>
    </div>
  );
});