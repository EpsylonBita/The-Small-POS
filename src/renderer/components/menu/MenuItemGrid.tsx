import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../../contexts/theme-context';
import { MenuItemCard } from './MenuItemCard';
import { ComboCard } from './ComboCard';
import { menuService, MenuItem } from '../../services/MenuService';
import { AlertTriangle, Utensils } from 'lucide-react';
import type { MenuCombo } from '@shared/types/combo';

interface MenuItemGridProps {
  selectedCategory: string;
  selectedSubcategory?: string;
  onItemSelect: (item: MenuItem) => void;
  orderType?: 'pickup' | 'delivery' | 'dine-in';
  onSyncMenu?: () => void;
  onQuickAdd?: (item: MenuItem, quantity: number) => void;
  searchQuery?: string;
  // Combo mode
  comboMode?: boolean;
  combos?: MenuCombo[];
  onComboSelect?: (combo: MenuCombo) => void;
}

export const MenuItemGrid: React.FC<MenuItemGridProps> = ({
  selectedCategory,
  selectedSubcategory = '',
  onItemSelect,
  orderType = 'pickup',
  onSyncMenu,
  onQuickAdd,
  searchQuery = '',
  comboMode = false,
  combos = [],
  onComboSelect,
}) => {
  const { t } = useTranslation();
  const { resolvedTheme } = useTheme();
  const [menuItems, setMenuItems] = useState<MenuItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const loadMenuItems = async () => {
      setLoading(true);
      setError(null);

      try {
        let items: MenuItem[] = [];

        // Fetch items based on selected category
        if (selectedCategory === 'all') {
          items = await menuService.getMenuItems();
        } else if (selectedCategory === 'featured') {
          const allItems = await menuService.getMenuItems();
          items = allItems.filter(item => item.is_featured || false);
        } else {
          // Category filtering by UUID
          items = await menuService.getMenuItemsByCategory(selectedCategory);
        }

        // Filter by subcategory if selected
        if (selectedSubcategory) {
          // Check if filtering by flavor type (sweet/savory)
          const isSavory = selectedSubcategory.includes('savory');
          const isSweet = selectedSubcategory.includes('sweet');

          if (isSavory || isSweet) {
            // Filter items based on their flavor_type column
            const targetFlavorType = isSweet ? 'sweet' : 'savory';
            items = items.filter(item => item.flavor_type === targetFlavorType);

            console.log(`Filtering by ${targetFlavorType}:`, {
              totalItems: items.length,
              allItems: menuItems.length,
              itemsWithFlavorType: menuItems.filter(i => i.flavor_type).length,
              sampleItem: menuItems[0]
            });
          } else {
            // Legacy filtering for customizable/standard
            const isCustomizable = selectedSubcategory.includes('customizable');

            if (isCustomizable) {
              // Filter to show only customizable items
              items = items.filter(item => item.is_customizable);
            } else {
              // Show standard pre-configured items
              items = items.filter(item => !item.is_customizable);
            }
          }
        }

        // Validate items have required fields
        const validItems = items.filter(item => {
          const isValid = item.id && item.name && item.price !== undefined;
          if (!isValid) {
            console.warn('Invalid menu item detected:', item);
          }
          return isValid;
        });

        // Deduplicate items by ID to prevent React key warnings
        const uniqueItems = validItems.reduce((acc, item) => {
          if (!acc.find(i => i.id === item.id)) {
            acc.push(item);
          }
          return acc;
        }, [] as MenuItem[]);

        // Filter by search query
        const searchFiltered = searchQuery.trim()
          ? uniqueItems.filter(item =>
              item.name?.toLowerCase().includes(searchQuery.trim().toLowerCase())
            )
          : uniqueItems;

        setMenuItems(searchFiltered);
      } catch (err) {
        console.error('Error loading menu items:', err);
        setError(t('menu.grid.error'));
      } finally {
        setLoading(false);
      }
    };

    loadMenuItems();

    // Subscribe to real-time updates
    try {
      const unsubscribe = menuService.subscribeToMenuUpdates(() => {
        loadMenuItems();
      });
      return unsubscribe;
    } catch (error) {
      console.error('Error setting up real-time subscription:', error);
      // Continue without real-time updates
    }
  }, [selectedCategory, selectedSubcategory, searchQuery]);

  // Combo mode - render combo cards instead of menu items
  if (comboMode && onComboSelect) {
    if (combos.length === 0) {
      return (
        <div className="flex-1 p-4 overflow-y-auto flex items-center justify-center">
          <div className="text-center">
            <Utensils className={`w-12 h-12 mb-4 mx-auto ${
              resolvedTheme === 'dark' ? 'text-gray-600' : 'text-gray-400'
            }`} />
            <p className={`text-lg font-medium mb-2 ${
              resolvedTheme === 'dark' ? 'text-gray-300' : 'text-gray-600'
            }`}>
              {t('menu.combos.noCombos', 'No combos available')}
            </p>
          </div>
        </div>
      );
    }

    return (
      <div className="flex-1 p-2 sm:p-4 overflow-y-auto touch-scroll scrollbar-hide">
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-5 gap-3 sm:gap-4">
          {combos.map((combo) => (
            <ComboCard
              key={combo.id}
              combo={combo}
              orderType={orderType}
              onSelect={onComboSelect}
            />
          ))}
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex-1 p-2 sm:p-4 overflow-y-auto">
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-5 gap-3 sm:gap-4">
          {[1, 2, 3, 4, 5, 6, 7, 8].map(i => (
            <div
              key={i}
              className={`aspect-square rounded-xl animate-pulse ${
                resolvedTheme === 'dark' ? 'bg-gray-700/30' : 'bg-gray-200/50'
              }`}
            />
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex-1 p-4 overflow-y-auto flex items-center justify-center">
        <div className="text-center">
          <AlertTriangle className={`w-12 h-12 mb-4 mx-auto ${
            resolvedTheme === 'dark' ? 'text-gray-600' : 'text-gray-400'
          }`} />
          <p className={`text-lg font-medium mb-2 ${
            resolvedTheme === 'dark' ? 'text-gray-300' : 'text-gray-600'
          }`}>
            {error}
          </p>
          <p className={`text-sm mb-4 ${
            resolvedTheme === 'dark' ? 'text-gray-400' : 'text-gray-500'
          }`}>
            {t('menu.grid.errorDescription')}
          </p>
          {onSyncMenu && (
            <button
              onClick={onSyncMenu}
              className={`px-4 py-2 rounded-lg font-medium transition-colors ${
                resolvedTheme === 'dark'
                  ? 'bg-blue-600 text-white hover:bg-blue-700'
                  : 'bg-blue-500 text-white hover:bg-blue-600'
              }`}
            >
              {t('menu.grid.syncMenuData')}
            </button>
          )}
        </div>
      </div>
    );
  }

  if (menuItems.length === 0) {
    return (
      <div className="flex-1 p-4 overflow-y-auto flex items-center justify-center">
        <div className="text-center">
          <Utensils className={`w-12 h-12 mb-4 mx-auto ${
            resolvedTheme === 'dark' ? 'text-gray-600' : 'text-gray-400'
          }`} />
          <p className={`text-lg font-medium mb-2 ${
            resolvedTheme === 'dark' ? 'text-gray-300' : 'text-gray-600'
          }`}>
            {t('menu.grid.noItems')}
          </p>
          <p className={`text-sm mb-4 ${
            resolvedTheme === 'dark' ? 'text-gray-400' : 'text-gray-500'
          }`}>
            {t('menu.grid.noItemsDescription')}
          </p>
          {onSyncMenu && (
            <button
              onClick={onSyncMenu}
              className={`px-4 py-2 rounded-lg font-medium transition-colors ${
                resolvedTheme === 'dark'
                  ? 'bg-blue-600 text-white hover:bg-blue-700'
                  : 'bg-blue-500 text-white hover:bg-blue-600'
              }`}
            >
              {t('menu.grid.syncMenuData')}
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 p-2 sm:p-4 overflow-y-auto touch-scroll scrollbar-hide">
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-5 gap-3 sm:gap-4">
        {menuItems.map((item) => {
          // Get the correct price based on order type (three-tier pricing)
          const getDisplayPrice = () => {
            if (orderType === 'pickup') return item.pickup_price || item.price;
            if (orderType === 'delivery') return item.delivery_price || item.price;
            if (orderType === 'dine-in') return item.dine_in_price || item.pickup_price || item.price;
            return item.price;
          };
          const displayPrice = getDisplayPrice();

          return (
            <MenuItemCard
              key={item.id}
              item={{
                id: item.id,
                name: item.name || '',
                description: item.description || '',
                price: displayPrice,
                category: item.category_id,
                preparationTime: item.preparation_time || item.preparationTime || 0,
                image: item.image_url || '',
                is_customizable: item.is_customizable
              }}
              orderType={orderType}
              onSelect={() => onItemSelect(item)}
              onQuickAdd={onQuickAdd ? (_cardItem, quantity) => onQuickAdd(item, quantity) : undefined}
            />
          );
        })}
      </div>
    </div>
  );
};
