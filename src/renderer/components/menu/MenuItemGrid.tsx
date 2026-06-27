import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../../contexts/theme-context';
import { MenuItemCard } from './MenuItemCard';
import { ComboCard } from './ComboCard';
import { menuService, MenuItem } from '../../services/MenuService';
import { AlertTriangle, Utensils, X } from 'lucide-react';
import { formatCurrency } from '../../utils/format';
import type { MenuCombo } from '@shared/types/combo';
import { resolveMenuItemPrice } from '../../utils/order-type-pricing';

interface MenuItemGridProps {
  selectedCategory: string;
  selectedSubcategory?: string;
  onItemSelect: (item: MenuItem) => void;
  orderType?: 'pickup' | 'delivery' | 'dine-in';
  onSyncMenu?: () => void;
  onQuickAdd?: (item: MenuItem, quantity: number) => void;
  searchQuery?: string;
  // Top seller IDs for featured category filtering
  topSellerIds?: Set<string>;
  featuredRankedIds?: string[];
  // Combo mode
  comboMode?: boolean;
  combos?: MenuCombo[];
  onComboSelect?: (combo: MenuCombo) => void;
}

interface MenuItemPreview {
  id: string;
  name: string;
  description: string;
  price: number;
  category: string;
  preparationTime: number;
  image?: string;
  is_customizable?: boolean;
  ingredients?: string[] | null;
  customizations?: MenuItem['customizations'];
}

interface MenuItemPreviewState {
  item: MenuItemPreview;
  anchorRect: DOMRect;
}

export const MenuItemGrid: React.FC<MenuItemGridProps> = ({
  selectedCategory,
  selectedSubcategory = '',
  onItemSelect,
  orderType = 'pickup',
  onSyncMenu,
  onQuickAdd,
  searchQuery = '',
  topSellerIds,
  featuredRankedIds = [],
  comboMode = false,
  combos = [],
  onComboSelect,
}) => {
  const { t } = useTranslation();
  const { resolvedTheme } = useTheme();
  const [menuItems, setMenuItems] = useState<MenuItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<MenuItemPreviewState | null>(null);

  const previewPosition = useMemo(() => {
    if (!preview) return null;

    const width = Math.min(360, Math.max(280, window.innerWidth - 32));
    const heightEstimate = 280;
    const gap = 12;
    const centeredLeft = preview.anchorRect.left + (preview.anchorRect.width / 2) - (width / 2);
    const left = Math.min(Math.max(16, centeredLeft), Math.max(16, window.innerWidth - width - 16));
    const preferredTop = preview.anchorRect.top - heightEstimate - gap;
    const fallbackTop = preview.anchorRect.bottom + gap;
    const top = preferredTop >= 16
      ? preferredTop
      : Math.min(Math.max(16, fallbackTop), Math.max(16, window.innerHeight - heightEstimate - 16));

    return { left, top, width };
  }, [preview]);

  useEffect(() => {
    if (!preview) return;

    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setPreview(null);
      }
    };
    const closeOnViewportChange = () => setPreview(null);

    window.addEventListener('keydown', closeOnEscape);
    window.addEventListener('resize', closeOnViewportChange);
    window.addEventListener('scroll', closeOnViewportChange, true);

    return () => {
      window.removeEventListener('keydown', closeOnEscape);
      window.removeEventListener('resize', closeOnViewportChange);
      window.removeEventListener('scroll', closeOnViewportChange, true);
    };
  }, [preview]);

  useEffect(() => {
    // Wave 5 H: guard against setState-after-unmount. The previous
    // implementation fired `loadMenuItems` and (later) subscribed to
    // real-time updates — either callback could resolve after the
    // component unmounted (fast category switches, menu modal
    // closing), landing a React warning and, in the wrong order,
    // overwriting the new component's state. `disposed` matches the
    // pattern already used in App.tsx's validateAndRestoreSession.
    let disposed = false;

    const loadMenuItems = async () => {
      if (disposed) return;
      setLoading(true);
      setError(null);

      try {
        let items: MenuItem[] = [];

        // Fetch items based on selected category
        if (selectedCategory === 'all') {
          items = await menuService.getMenuItems();
        } else if (selectedCategory === 'featured') {
          const allItems = await menuService.getMenuItems();
          if (featuredRankedIds.length > 0) {
            const itemsById = new Map(allItems.map(item => [item.id, item]));
            const rankedItems = featuredRankedIds
              .map((itemId) => itemsById.get(itemId))
              .filter((item): item is MenuItem => Boolean(item));

            items = rankedItems.length > 0
              ? rankedItems
              : allItems.filter(item => item.is_featured || false);
          } else if (topSellerIds && topSellerIds.size > 0) {
            const filteredItems = allItems.filter(item => topSellerIds.has(item.id));
            items = filteredItems.length > 0
              ? filteredItems
              : allItems.filter(item => item.is_featured || false);
          } else {
            items = allItems.filter(item => item.is_featured || false);
          }
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

        if (!disposed) {
          setMenuItems(searchFiltered);
        }
      } catch (err) {
        console.error('Error loading menu items:', err);
        if (!disposed) {
          setError(t('menu.grid.error'));
        }
      } finally {
        if (!disposed) {
          setLoading(false);
        }
      }
    };

    loadMenuItems();

    // Subscribe to real-time updates. The callback also routes through
    // `loadMenuItems`, which already checks `disposed` at each setState.
    let unsubscribe: (() => void) | undefined;
    try {
      unsubscribe = menuService.subscribeToMenuUpdates(() => {
        loadMenuItems();
      });
    } catch (error) {
      console.error('Error setting up real-time subscription:', error);
      // Continue without real-time updates.
    }

    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, [featuredRankedIds, searchQuery, selectedCategory, selectedSubcategory, topSellerIds]);

  // Combo mode - render combo cards instead of menu items
  if (comboMode && onComboSelect) {
    if (combos.length === 0) {
      return (
        <div className="flex-1 p-4 overflow-y-auto scrollbar-hide flex items-center justify-center">
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
      <div className="flex-1 p-2 sm:p-3 overflow-y-auto touch-scroll scrollbar-hide">
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6 gap-2.5 sm:gap-3">
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
      <div className="flex-1 p-2 sm:p-3 overflow-y-auto scrollbar-hide">
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6 gap-2.5 sm:gap-3">
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
      <div className="flex-1 p-4 overflow-y-auto scrollbar-hide flex items-center justify-center">
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
                  ? 'bg-yellow-400 text-black active:bg-yellow-500'
                  : 'bg-yellow-400 text-black active:bg-yellow-500'
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
      <div className="flex-1 p-4 overflow-y-auto scrollbar-hide flex items-center justify-center">
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
                  ? 'bg-yellow-400 text-black active:bg-yellow-500'
                  : 'bg-yellow-400 text-black active:bg-yellow-500'
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
    <div className="flex-1 p-2 sm:p-3 overflow-y-auto touch-scroll scrollbar-hide">
      {preview && previewPosition && createPortal(
        <div className="fixed inset-0 z-[2147483001]" onPointerDown={() => setPreview(null)}>
          <div
            className={`absolute max-h-[min(70vh,22rem)] overflow-hidden rounded-2xl border p-4 shadow-2xl backdrop-blur-2xl ${
              resolvedTheme === 'dark'
                ? 'border-white/15 bg-zinc-950/85 text-white shadow-black/50'
                : 'border-white/70 bg-white/90 text-gray-950 shadow-gray-900/20'
            }`}
            style={{
              left: previewPosition.left,
              top: previewPosition.top,
              width: previewPosition.width,
            }}
            onPointerDown={(event) => event.stopPropagation()}
            role="dialog"
            aria-modal="false"
            aria-label={preview.item.name}
          >
            <div className="mb-3 flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h4 className="line-clamp-2 text-xl font-bold leading-tight">
                  {preview.item.name}
                </h4>
                <span className={`mt-1 block text-lg font-bold ${
                  resolvedTheme === 'dark' ? 'text-emerald-400' : 'text-emerald-600'
                }`}>
                  {preview.item.is_customizable ? t('menu.item.from') : ''}{formatCurrency(preview.item.price)}
                </span>
              </div>
              <button
                type="button"
                onClick={() => setPreview(null)}
                className={`flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl border transition-colors ${
                  resolvedTheme === 'dark'
                    ? 'border-white/10 bg-white/5 text-zinc-300 active:bg-white/10 active:text-white'
                    : 'border-black/10 bg-black/5 text-gray-600 active:bg-black/10 active:text-gray-950'
                }`}
                aria-label={t('common.actions.close')}
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="max-h-[14rem] overflow-y-auto pr-1 scrollbar-hide">
              {preview.item.description ? (
                <p className={`text-base font-semibold leading-relaxed ${
                  resolvedTheme === 'dark' ? 'text-yellow-300' : 'text-yellow-800'
                }`}>
                  {preview.item.description}
                </p>
              ) : (
                <p className={resolvedTheme === 'dark' ? 'text-zinc-400' : 'text-gray-500'}>
                  {t('menu.item.noDescription', 'No description available')}
                </p>
              )}

              {(preview.item.ingredients?.filter(Boolean).length ?? 0) > 0 && (
                <div className="mt-4">
                  <div className={`mb-2 text-xs font-semibold uppercase tracking-wide ${
                    resolvedTheme === 'dark' ? 'text-zinc-400' : 'text-gray-500'
                  }`}>
                    {t('menu.cart.ingredients')}
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {preview.item.ingredients!.filter(Boolean).map((ingredient, index) => (
                      <span
                        key={`${preview.item.id}-glance-ingredient-${index}`}
                        className={`rounded-full px-2.5 py-1 text-xs font-semibold ${
                          resolvedTheme === 'dark'
                            ? 'bg-yellow-300/12 text-yellow-200'
                            : 'bg-yellow-100 text-yellow-800'
                        }`}
                      >
                        {ingredient}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>,
        document.body,
      )}
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6 gap-2.5 sm:gap-3">
        {menuItems.map((item) => {
          // Tier-price resolution lives in a shared util so cart-repricing
          // in MenuModal (when order type changes mid-edit) uses exactly
          // the same fallback chain as the grid displays here.
          const displayPrice = resolveMenuItemPrice(item, orderType);

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
                is_customizable: item.is_customizable,
                ingredients: item.ingredients || null,
                customizations: item.customizations,
              }}
              orderType={orderType}
              onSelect={() => onItemSelect(item)}
              onQuickAdd={onQuickAdd ? (_cardItem, quantity) => onQuickAdd(item, quantity) : undefined}
              onPreview={(previewItem, anchorRect) => setPreview({ item: previewItem, anchorRect })}
            />
          );
        })}
      </div>
    </div>
  );
};
