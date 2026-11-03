import React, { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { toast } from 'react-hot-toast';
import { Eye, EyeOff, Search, RefreshCw, BadgePercent } from 'lucide-react';
import { getBridge, offEvent, onEvent } from '../../lib';
import { getOfflineActionState } from '../services/offline-page-capabilities';
import { pageMotionContainer, pageMotionItem } from '../components/ui/page-motion';
import { formatCurrency } from '../utils/format';
import { resolveMenuItemPrice } from '../utils/order-type-pricing';

// Types
interface MenuItem {
  id: string;
  name: string;
  category_id: string;
  is_available: boolean;
  is_customizable?: boolean;
  price?: number;
  base_price: number;
  pickup_price?: number;
  delivery_price?: number;
  dine_in_price?: number;
  image_url?: string;
  flavor_type?: 'savory' | 'sweet';
}

interface Ingredient {
  id: string;
  name: string;
  category_id?: string;
  is_available: boolean;
  price?: number;
  item_color?: string;
}

interface CatalogOffer {
  id: string;
  name: string;
  description?: string | null;
  catalog_type: 'menu' | 'product';
  branch_id?: string | null;
  is_active: boolean;
  priority: number;
  repeatable: boolean;
}

interface Category {
  id: string;
  name: string;      // Primary name field
  name_en: string;
  name_el: string;
  is_active: boolean;
}

export const MenuManagementPage: React.FC = () => {
  const bridge = getBridge();
  const { t, i18n } = useTranslation();
  const language = i18n.language;
  const [activeTab, setActiveTab] = useState<'categories' | 'subcategories' | 'ingredients' | 'offers'>('categories');
  const [loading, setLoading] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [isOnline, setIsOnline] = useState(navigator.onLine);

  // Data states
  const [categories, setCategories] = useState<Category[]>([]);
  const [menuItems, setMenuItems] = useState<MenuItem[]>([]);
  const [ingredients, setIngredients] = useState<Ingredient[]>([]);
  const [offers, setOffers] = useState<CatalogOffer[]>([]);
  const toggleAction = getOfflineActionState('menu', 'toggle', isOnline);

  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  // Load data on mount and tab change
  useEffect(() => {
    loadData();
  }, [activeTab]);

  // Real-time sync listener
  useEffect(() => {
    const handleMenuSync = (data: any) => {
      console.log('📡 Menu sync received:', data);
      // Reload current tab data
      loadData();
    };

    onEvent('menu:sync', handleMenuSync);

    return () => {
      offEvent('menu:sync', handleMenuSync);
    };
  }, [activeTab]);

  const loadData = async () => {
    setLoading(true);
    try {
      if (activeTab === 'categories') {
        await loadCategories();
      } else if (activeTab === 'subcategories') {
        await loadMenuItems();
      } else if (activeTab === 'ingredients') {
        await loadIngredients();
      } else if (activeTab === 'offers') {
        await loadOffers();
      }
    } catch (error) {
      console.error('Error loading data:', error);
      toast.error(t('menu.failedToLoadData', 'Failed to load data'));
    } finally {
      setLoading(false);
    }
  };

  const loadCategories = async () => {
    try {
      const result = await bridge.menu.getCategories();
      const mapped: Category[] = (result || []).map((cat: any) => ({
        id: cat.id,
        name: cat.name || cat.name_en || cat.name_el || '',
        name_en: cat.name_en || cat.name || '',
        name_el: cat.name_el || cat.name || '',
        is_active: cat.is_active !== false,
      }));
      setCategories(mapped);
    } catch (error) {
      console.error('Error loading categories:', error);
      toast.error(t('menu.failedToLoadCategories', 'Failed to load categories'));
    }
  };

  const loadMenuItems = async () => {
    try {
      const result = await bridge.menu.getSubcategories();
      setMenuItems((result || []).map((item: any) => ({
        ...item,
        // The order-taking menu resolves pickup/delivery/dine-in tiers from
        // these exact fields. Keep the management view on the same normalized
        // contract instead of presenting base_price as the sale price.
        price: Number(item.price ?? item.base_price ?? 0),
        base_price: Number(item.base_price ?? item.price ?? 0),
        pickup_price: item.pickup_price == null ? undefined : Number(item.pickup_price),
        delivery_price: item.delivery_price == null ? undefined : Number(item.delivery_price),
        dine_in_price: item.dine_in_price == null ? undefined : Number(item.dine_in_price),
      })));
    } catch (error) {
      console.error('Error loading menu items:', error);
      toast.error(t('menu.failedToLoadMenuItems', 'Failed to load menu items'));
    }
  };

  const loadIngredients = async () => {
    try {
      const result = await bridge.menu.getIngredients();
      setIngredients(result || []);
    } catch (error) {
      console.error('Error loading ingredients:', error);
      toast.error(t('menu.failedToLoadIngredients', 'Failed to load ingredients'));
    }
  };

  const loadOffers = async () => {
    try {
      const result = await bridge.branchData.getCatalogOffers({
        catalog_type: 'menu',
        include_inactive: true,
      });
      if (!result.success) {
        throw new Error(result.error || 'Failed to load offers');
      }

      const payload = (result.data ?? {}) as {
        success?: boolean;
        offers?: CatalogOffer[];
      };
      if (payload.success === false) {
        throw new Error('Failed to load offers');
      }
      setOffers(Array.isArray(payload.offers) ? payload.offers : []);
    } catch (error) {
      console.error('Error loading offers:', error);
      toast.error(t('menu.failedToLoadOffers', 'Failed to load offers'));
    }
  };

  const toggleCategoryAvailability = async (id: string, currentStatus: boolean) => {
    if (toggleAction.disabled) {
      toast.error(toggleAction.message || t('menu.onlineRequired', 'This action requires an online connection.'));
      return;
    }

    const original = categories;
    // Optimistic update
    setCategories(prev => prev.map(c => c.id === id ? { ...c, is_active: !currentStatus } : c));

    try {
      await bridge.menu.updateCategory(id, {
        is_active: !currentStatus,
      });

      toast.success(t('menu.categoryUpdated', 'Category updated successfully'));
    } catch (error) {
      console.error('Error updating category:', error);
      toast.error(t('menu.failedToUpdateCategory', 'Failed to update category'));
      setCategories(original);
    }
  };

  const toggleMenuItemAvailability = async (id: string, currentStatus: boolean) => {
    if (toggleAction.disabled) {
      toast.error(toggleAction.message || t('menu.onlineRequired', 'This action requires an online connection.'));
      return;
    }

    const original = menuItems;
    // Optimistic update
    setMenuItems(prev => prev.map(item => item.id === id ? { ...item, is_available: !currentStatus } : item));

    try {
      await bridge.menu.updateSubcategory(id, {
        is_available: !currentStatus,
      });

      toast.success(t('menu.menuItemUpdated', 'Menu item updated successfully'));
    } catch (error) {
      console.error('Error updating menu item:', error);
      toast.error(t('menu.failedToUpdateMenuItem', 'Failed to update menu item'));
      setMenuItems(original);
    }
  };

  const toggleIngredientAvailability = async (id: string, currentStatus: boolean) => {
    if (toggleAction.disabled) {
      toast.error(toggleAction.message || t('menu.onlineRequired', 'This action requires an online connection.'));
      return;
    }

    const original = ingredients;
    // Optimistic update
    setIngredients(prev => prev.map(ing => ing.id === id ? { ...ing, is_available: !currentStatus } : ing));

    try {
      await bridge.menu.updateIngredient(id, {
        is_available: !currentStatus,
      });

      toast.success(t('menu.ingredientUpdated', 'Ingredient updated successfully'));
    } catch (error) {
      console.error('Error updating ingredient:', error);
      toast.error(t('menu.failedToUpdateIngredient', 'Failed to update ingredient'));
      setIngredients(original);
    }
  };

  const toggleOfferAvailability = async (id: string, currentStatus: boolean) => {
    if (toggleAction.disabled) {
      toast.error(toggleAction.message || t('menu.onlineRequired', 'This action requires an online connection.'));
      return;
    }

    const original = offers;
    // Optimistic update
    setOffers(prev => prev.map(offer =>
      offer.id === id ? { ...offer, is_active: !currentStatus } : offer
    ));

    try {
      const result = await bridge.adminApi.fetchFromAdmin(
        `/api/pos/offers/${encodeURIComponent(id)}`,
        {
          method: 'PATCH',
          body: { is_active: !currentStatus },
        },
      );
      const payload = result.data as { success?: boolean; error?: string } | undefined;
      if (!result.success || payload?.success === false) {
        throw new Error(result.error || payload?.error || 'Failed to update offer');
      }

      // Re-read the complete branch-scoped set after the write. This refreshes
      // the native cache and confirms the server accepted the toggle.
      await loadOffers();
      toast.success(t('menu.offerUpdated', 'Offer updated successfully'));
    } catch (error) {
      console.error('Error updating offer:', error);
      toast.error(t('menu.failedToUpdateOffer', 'Failed to update offer'));
      setOffers(original);
    }
  };

  const getMenuItemDisplayPrice = (item: MenuItem) =>
    resolveMenuItemPrice(item, 'pickup');

  const renderMenuItemPrice = (item: MenuItem) => (
    <>
      {item.is_customizable ? t('menu.item.from') : ''}
      {formatCurrency(getMenuItemDisplayPrice(item), undefined, language)}
    </>
  );

  // Filter data based on search term
  const searchLower = searchTerm.toLowerCase();

  const filteredCategories = categories.filter(cat =>
    (cat.name_en || '').toLowerCase().includes(searchLower) ||
    (cat.name_el || '').toLowerCase().includes(searchLower) ||
    (cat.name || '').toLowerCase().includes(searchLower)
  );

  const filteredMenuItems = menuItems.filter(item =>
    (item.name || '').toLowerCase().includes(searchLower)
  );

  const filteredIngredients = ingredients.filter(ing =>
    (ing.name || '').toLowerCase().includes(searchLower)
  );

  const filteredOffers = offers.filter(offer =>
    (offer.name || '').toLowerCase().includes(searchLower) ||
    (offer.description || '').toLowerCase().includes(searchLower)
  );

  // Founder 01/11 (module pages one by one, Menu Management first): the page in the kit. Tabs are kit options
  // (the open one in the selection yellow), cards are kit cards, words are the kit fg / muted.
  const getTabClass = (tab: typeof activeTab) => `pos-choice${activeTab === tab ? ' is-selected' : ''}`;

  const gridCardClass = 'pos-card p-4';
  // Keep the full touch target while letting the availability icon stand alone: shown = the kit ok green.
  const getAvailabilityToggleClass = (active: boolean) =>
    `inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl transition disabled:opacity-50 disabled:cursor-not-allowed active:scale-95 active:bg-(--pos-s-surface-2) focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-(--pos-s-fg) ${
      active ? 'text-(--pos-s-ok)' : 'text-(--pos-s-muted)'
    }`;
  const refreshLabel = loading
    ? t('menu.refreshingMenu', 'Refreshing menu')
    : t('menu.refreshMenu', 'Refresh menu');

  const renderTabs = () => (
    <motion.div variants={pageMotionItem} className="flex flex-wrap gap-2 mb-6">
      <button
        onClick={() => setActiveTab('categories')}
        aria-pressed={activeTab === 'categories'}
        className={getTabClass('categories')}
      >
        {t('menu.managementTabs.categories', 'Categories')}
      </button>
      <button
        onClick={() => setActiveTab('subcategories')}
        aria-pressed={activeTab === 'subcategories'}
        className={getTabClass('subcategories')}
      >
        {/* Historical data model: the 'subcategories' tab/table actually stores menu items.
            Keep the internal key + bridge naming; only the staff-facing label is corrected. */}
        {t('menu.managementTabs.menuItems', 'Menu Items')}
      </button>
      <button
        onClick={() => setActiveTab('ingredients')}
        aria-pressed={activeTab === 'ingredients'}
        className={getTabClass('ingredients')}
      >
        {t('menu.managementTabs.ingredients', 'Ingredients')}
      </button>
      <button
        onClick={() => setActiveTab('offers')}
        aria-pressed={activeTab === 'offers'}
        className={getTabClass('offers')}
      >
        {t('menu.managementTabs.offers', 'Offers')}
      </button>
    </motion.div>
  );

  const renderSearchBar = () => (
    <motion.div variants={pageMotionItem} className="mb-6">
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-(--pos-s-muted)" />
        <input
          type="text"
          placeholder={t('menu.searchPlaceholder')}
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          className="min-h-[48px] w-full rounded-xl border border-(--pos-s-control) bg-(--pos-s-surface) pl-10 pr-4 text-(--pos-s-fg) outline-hidden transition-colors placeholder:text-zinc-400 focus:border-(--pos-s-yellow) dark:placeholder:text-zinc-500"
        />
      </div>
    </motion.div>
  );

  const renderCategories = () => (
    <motion.div key="categories" variants={pageMotionContainer} className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      {filteredCategories.map((category) => (
        <motion.div
          key={category.id}
          variants={pageMotionItem}
          className={gridCardClass}
        >
          {/* The fade sits inside: the card's entrance animation owns its opacity. */}
          <div className={`flex items-center justify-between ${!category.is_active ? 'opacity-60 grayscale' : ''}`}>
            <div>
              <h3 className="font-semibold text-(--pos-s-fg)">
                {(language === 'el'
                  ? (category.name_el || category.name_en || category.name)
                  : (category.name_en || category.name_el || category.name)
                ) || t('menu.unnamed', 'Unnamed')}
              </h3>
            </div>
            <button
              onClick={() => toggleCategoryAvailability(category.id, category.is_active)}
              disabled={toggleAction.disabled}
              aria-label={toggleAction.message || (category.is_active ? t('menu.disable', 'Disable') : t('menu.enable', 'Enable'))}
              className={getAvailabilityToggleClass(category.is_active)}
            >
              {category.is_active ? <Eye className="w-5 h-5" /> : <EyeOff className="w-5 h-5" />}
            </button>
          </div>
        </motion.div>
      ))}
    </motion.div>
  );

  const renderMenuItems = () => (
    <motion.div key="subcategories" variants={pageMotionContainer} className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      {filteredMenuItems.map((item) => (
        <motion.div
          key={item.id}
          variants={pageMotionItem}
          className={gridCardClass}
        >
          {/* The fade sits inside: the card's entrance animation owns its opacity. */}
          <div className={`flex items-start justify-between mb-2 ${!item.is_available ? 'opacity-60 grayscale' : ''}`}>
            <div className="flex-1">
              <h3 className="font-semibold text-(--pos-s-fg)">
                {item.name}
              </h3>
              <p className="text-sm text-(--pos-s-muted)">
                {renderMenuItemPrice(item)}
              </p>
            </div>
            <button
              onClick={() => toggleMenuItemAvailability(item.id, item.is_available)}
              disabled={toggleAction.disabled}
              aria-label={toggleAction.message || (item.is_available ? t('menu.disable', 'Disable') : t('menu.enable', 'Enable'))}
              className={getAvailabilityToggleClass(item.is_available)}
            >
              {item.is_available ? <Eye className="w-5 h-5" /> : <EyeOff className="w-5 h-5" />}
            </button>
          </div>
        </motion.div>
      ))}
    </motion.div>
  );

  const renderIngredients = () => (
    <motion.div key="ingredients" variants={pageMotionContainer} className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      {filteredIngredients.map((ingredient) => (
        <motion.div
          key={ingredient.id}
          variants={pageMotionItem}
          className={gridCardClass}
        >
          {/* The fade sits inside: the card's entrance animation owns its opacity. */}
          <div className={`flex items-start justify-between mb-2 ${!ingredient.is_available ? 'opacity-60 grayscale' : ''}`}>
            <div className="flex-1">
              <div className="flex items-center gap-2">
                {ingredient.item_color && (
                  <div
                    className="w-3 h-3 rounded-full"
                    style={{ backgroundColor: ingredient.item_color }}
                  />
                )}
                <h3 className="font-semibold text-(--pos-s-fg)">
                  {ingredient.name || t('menu.unnamed', 'Unnamed')}
                </h3>
              </div>
              {ingredient.price != null && ingredient.price > 0 && (
                <p className="text-sm text-(--pos-s-muted)">
                  {formatCurrency(ingredient.price, undefined, language)}
                </p>
              )}
            </div>
            <button
              onClick={() => toggleIngredientAvailability(ingredient.id, ingredient.is_available)}
              disabled={toggleAction.disabled}
              aria-label={toggleAction.message || (ingredient.is_available ? t('menu.disable', 'Disable') : t('menu.enable', 'Enable'))}
              className={getAvailabilityToggleClass(ingredient.is_available)}
            >
              {ingredient.is_available ? <Eye className="w-5 h-5" /> : <EyeOff className="w-5 h-5" />}
            </button>
          </div>
        </motion.div>
      ))}
    </motion.div>
  );

  const renderOffers = () => {
    // Offers can be legitimately empty (none synced) or filtered to nothing by the
    // search. Both used to leave a bare black grid; render a small centered glass empty state instead,
    // distinguishing no-data from no-search-results. UI only -- no data is created/refreshed here.
    if (filteredOffers.length === 0) {
      const isSearching = searchTerm.trim().length > 0;
      return (
        <motion.div
          key="offers-empty"
          variants={pageMotionItem}
          data-menu-offers-empty
          className="flex justify-center py-12"
        >
          <div className="flex max-w-md flex-col items-center gap-3 rounded-2xl border border-dashed border-zinc-400 px-8 py-10 text-center dark:border-zinc-600">
            <BadgePercent className="h-10 w-10 text-(--pos-s-muted)" aria-hidden="true" />
            <h3 className="text-lg font-semibold text-(--pos-s-fg)">
              {isSearching
                ? t('menu.offersEmpty.searchTitle', 'No offers match the search')
                : t('menu.offersEmpty.title', 'No offers configured')}
            </h3>
            <p className="text-sm text-(--pos-s-muted)">
              {isSearching
                ? t('menu.offersEmpty.searchSubtitle', 'Clear the search or try another term')
                : t('menu.offersEmpty.subtitle', 'Create offers in the admin dashboard or refresh after syncing.')}
            </p>
            {isSearching && (
              <button
                type="button"
                onClick={() => setSearchTerm('')}
                className="pos-solid-btn pos-solid-btn--sm mt-1"
              >
                {t('menu.offersEmpty.clearSearch', 'Clear search')}
              </button>
            )}
          </div>
        </motion.div>
      );
    }
    return (
      <motion.div key="offers" variants={pageMotionContainer} className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      {filteredOffers.map((offer) => (
        <motion.div
          key={offer.id}
          variants={pageMotionItem}
          className={gridCardClass}
        >
          {/* The fade sits inside: the card's entrance animation owns its opacity. */}
          <div className={`flex items-start justify-between mb-2 ${!offer.is_active ? 'opacity-60 grayscale' : ''}`}>
            <div className="flex-1">
              <h3 className="font-semibold text-(--pos-s-fg)">
                {offer.name || t('menu.unnamed', 'Unnamed')}
              </h3>
              {offer.description && (
                <p className="mt-1 text-sm text-(--pos-s-muted)">
                  {offer.description}
                </p>
              )}
            </div>
            <button
              onClick={() => toggleOfferAvailability(offer.id, offer.is_active)}
              disabled={toggleAction.disabled}
              aria-label={toggleAction.message || (offer.is_active ? t('menu.disable', 'Disable') : t('menu.enable', 'Enable'))}
              className={getAvailabilityToggleClass(offer.is_active)}
            >
              {offer.is_active ? <Eye className="w-5 h-5" /> : <EyeOff className="w-5 h-5" />}
            </button>
          </div>
        </motion.div>
      ))}
    </motion.div>
    );
  };

  return (
    <motion.div initial="hidden" animate="show" variants={pageMotionContainer} className="p-6">
      <motion.div variants={pageMotionItem} className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold text-(--pos-s-fg)">
            {t('menu.header')}
          </h1>
          <p className="mt-2 text-lg text-(--pos-s-muted)">
            {t('menu.description')}
          </p>
        </div>
        <button
          onClick={loadData}
          disabled={loading}
          aria-label={refreshLabel}
          className="pos-icon-btn h-12! w-12!"
        >
          <RefreshCw className={`w-5 h-5 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </motion.div>

      {renderTabs()}
      {renderSearchBar()}

      {loading ? (
        <motion.div variants={pageMotionItem} className="flex items-center justify-center py-12">
          <RefreshCw className="h-8 w-8 animate-spin text-(--pos-s-muted)" />
        </motion.div>
      ) : (
        <>
          {activeTab === 'categories' && renderCategories()}
          {activeTab === 'subcategories' && renderMenuItems()}
          {activeTab === 'ingredients' && renderIngredients()}
          {activeTab === 'offers' && renderOffers()}
        </>
      )}
    </motion.div>
  );
};

export default MenuManagementPage;
