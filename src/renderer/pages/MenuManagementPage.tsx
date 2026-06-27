import React, { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../contexts/theme-context';
import { toast } from 'react-hot-toast';
import { Eye, EyeOff, Search, RefreshCw, BadgePercent } from 'lucide-react';
import { getBridge, offEvent, onEvent } from '../../lib';
import { getOfflineActionState } from '../services/offline-page-capabilities';
import { pageMotionContainer, pageMotionItem } from '../components/ui/page-motion';
import { formatCurrency } from '../utils/format';

// Types
interface MenuItem {
  id: string;
  name: string;
  category_id: string;
  is_available: boolean;
  base_price: number;
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

interface Combo {
  id: string;
  name_en: string;
  name_el?: string;
  base_price: number;
  pickup_price?: number;
  delivery_price?: number;
  is_active: boolean;
  is_featured?: boolean;
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
  const { resolvedTheme } = useTheme();
  const language = i18n.language;
  const [activeTab, setActiveTab] = useState<'categories' | 'subcategories' | 'ingredients' | 'combos'>('categories');
  const [loading, setLoading] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [isOnline, setIsOnline] = useState(navigator.onLine);

  // Data states
  const [categories, setCategories] = useState<Category[]>([]);
  const [menuItems, setMenuItems] = useState<MenuItem[]>([]);
  const [ingredients, setIngredients] = useState<Ingredient[]>([]);
  const [combos, setCombos] = useState<Combo[]>([]);
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
      } else if (activeTab === 'combos') {
        await loadCombos();
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
      setMenuItems(result || []);
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

  const loadCombos = async () => {
    try {
      const result = await bridge.menu.getCombos();
      setCombos(result || []);
    } catch (error) {
      console.error('Error loading combos:', error);
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

  const toggleComboAvailability = async (id: string, currentStatus: boolean) => {
    if (toggleAction.disabled) {
      toast.error(toggleAction.message || t('menu.onlineRequired', 'This action requires an online connection.'));
      return;
    }

    const original = combos;
    // Optimistic update
    setCombos(prev => prev.map(c => c.id === id ? { ...c, is_active: !currentStatus } : c));

    try {
      await bridge.menu.updateCombo(id, {
        is_active: !currentStatus,
      });

      toast.success(t('menu.offerUpdated', 'Offer updated successfully'));
    } catch (error) {
      console.error('Error updating combo:', error);
      toast.error(t('menu.failedToUpdateOffer', 'Failed to update offer'));
      setCombos(original);
    }
  };

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

  const filteredCombos = combos.filter(combo =>
    (combo.name_en || '').toLowerCase().includes(searchLower) ||
    (combo.name_el || '').toLowerCase().includes(searchLower)
  );

  const getTabClass = (tab: typeof activeTab) => `px-4 py-2 rounded-2xl transition-transform active:scale-[0.98] ${
    activeTab === tab
      ? 'bg-yellow-500 text-black font-semibold border border-yellow-400'
      : resolvedTheme === 'dark'
        ? 'bg-zinc-900 text-zinc-200 active:bg-zinc-800'
        : 'bg-gray-100 text-gray-700 active:bg-gray-200'
  }`;

  const gridCardClass = `p-4 rounded-xl border ${
    resolvedTheme === 'dark'
      ? 'bg-yellow-500/10 border-yellow-500/45'
      : 'bg-yellow-50 border-yellow-200'
  }`;
  // Round 234: availability toggles are real 44x44 glass touch targets (was a borderless p-2 eye
  // glyph that read like decoration on a touchscreen). Semantic green = enabled, red = disabled,
  // with a translucent tinted glass surface + active press feedback; no hover, no native title.
  const getAvailabilityToggleClass = (active: boolean) =>
    `inline-flex h-11 w-11 items-center justify-center rounded-2xl border backdrop-blur-md transition disabled:opacity-50 disabled:cursor-not-allowed active:scale-95 ${
      active
        ? 'border-green-500/40 bg-green-500/15 text-green-500 active:bg-green-500/25'
        : 'border-red-500/40 bg-red-500/15 text-red-500 active:bg-red-500/25'
    }`;
  const refreshLabel = loading
    ? t('menu.refreshingMenu', 'Refreshing menu')
    : t('menu.refreshMenu', 'Refresh menu');

  const renderTabs = () => (
    <motion.div variants={pageMotionItem} className="flex gap-2 mb-6">
      <button
        onClick={() => setActiveTab('categories')}
        className={getTabClass('categories')}
      >
        {t('menu.managementTabs.categories', 'Categories')}
      </button>
      <button
        onClick={() => setActiveTab('subcategories')}
        className={getTabClass('subcategories')}
      >
        {/* Historical data model: the 'subcategories' tab/table actually stores menu items.
            Keep the internal key + bridge naming; only the staff-facing label is corrected. */}
        {t('menu.managementTabs.menuItems', 'Menu Items')}
      </button>
      <button
        onClick={() => setActiveTab('ingredients')}
        className={getTabClass('ingredients')}
      >
        {t('menu.managementTabs.ingredients', 'Ingredients')}
      </button>
      <button
        onClick={() => setActiveTab('combos')}
        className={getTabClass('combos')}
      >
        {t('menu.managementTabs.offers', 'Offers')}
      </button>
    </motion.div>
  );

  const renderSearchBar = () => (
    <motion.div variants={pageMotionItem} className="mb-6">
      <div className="relative">
        <Search className={`absolute left-3 top-1/2 transform -translate-y-1/2 w-5 h-5 ${
          resolvedTheme === 'dark' ? 'text-gray-400' : 'text-gray-500'
        }`} />
        <input
          type="text"
          placeholder={t('menu.searchPlaceholder')}
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          className={`w-full pl-10 pr-4 py-2 rounded-2xl border ${
            resolvedTheme === 'dark'
              ? 'bg-zinc-900 border-white text-white placeholder-zinc-400'
              : 'bg-gray-100 border-white text-gray-900 placeholder-gray-500'
          } focus:outline-none focus:ring-2 focus:ring-white/70`}
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
          className={`${gridCardClass} ${!category.is_active ? 'opacity-60 grayscale' : ''}`}
        >
          <div className="flex items-center justify-between">
            <div>
              <h3 className={`font-semibold ${resolvedTheme === 'dark' ? 'text-white' : 'text-gray-900'}`}>
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
          className={`${gridCardClass} ${!item.is_available ? 'opacity-60 grayscale' : ''}`}
        >
          <div className="flex items-start justify-between mb-2">
            <div className="flex-1">
              <h3 className={`font-semibold ${resolvedTheme === 'dark' ? 'text-white' : 'text-gray-900'}`}>
                {item.name}
              </h3>
              <p className={`text-sm ${resolvedTheme === 'dark' ? 'text-gray-400' : 'text-gray-600'}`}>
                {formatCurrency(item.base_price || 0, 'EUR', language)}
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
          className={`${gridCardClass} ${!ingredient.is_available ? 'opacity-60 grayscale' : ''}`}
        >
          <div className="flex items-start justify-between mb-2">
            <div className="flex-1">
              <div className="flex items-center gap-2">
                {ingredient.item_color && (
                  <div
                    className="w-3 h-3 rounded-full"
                    style={{ backgroundColor: ingredient.item_color }}
                  />
                )}
                <h3 className={`font-semibold ${resolvedTheme === 'dark' ? 'text-white' : 'text-gray-900'}`}>
                  {ingredient.name || t('menu.unnamed', 'Unnamed')}
                </h3>
              </div>
              {ingredient.price != null && ingredient.price > 0 && (
                <p className={`text-sm ${resolvedTheme === 'dark' ? 'text-gray-400' : 'text-gray-600'}`}>
                  {formatCurrency(ingredient.price, 'EUR', language)}
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

  const renderCombos = () => {
    // Round 235: offers/combos can be legitimately empty (none synced) or filtered to nothing by the
    // search. Both used to leave a bare black grid; render a small centered glass empty state instead,
    // distinguishing no-data from no-search-results. UI only -- no data is created/refreshed here.
    if (filteredCombos.length === 0) {
      const isSearching = searchTerm.trim().length > 0;
      return (
        <motion.div
          key="combos-empty"
          variants={pageMotionItem}
          data-menu-offers-empty
          className="flex justify-center py-12"
        >
          <div
            className={`flex max-w-md flex-col items-center gap-3 rounded-2xl border px-8 py-10 text-center backdrop-blur-md ${
              resolvedTheme === 'dark'
                ? 'border-white/10 bg-white/5'
                : 'border-black/10 bg-black/5'
            }`}
          >
            <span
              className={`inline-flex h-14 w-14 items-center justify-center rounded-2xl border ${
                resolvedTheme === 'dark'
                  ? 'border-amber-400/30 bg-amber-400/10 text-amber-300'
                  : 'border-amber-400/40 bg-amber-400/15 text-amber-600'
              }`}
            >
              <BadgePercent className="w-7 h-7" />
            </span>
            <h3 className={`text-lg font-semibold ${resolvedTheme === 'dark' ? 'text-white' : 'text-gray-900'}`}>
              {isSearching
                ? t('menu.offersEmpty.searchTitle', 'No offers match the search')
                : t('menu.offersEmpty.title', 'No offers configured')}
            </h3>
            <p className={`text-sm ${resolvedTheme === 'dark' ? 'text-gray-400' : 'text-gray-600'}`}>
              {isSearching
                ? t('menu.offersEmpty.searchSubtitle', 'Clear the search or try another term')
                : t('menu.offersEmpty.subtitle', 'Create offers in the admin dashboard or refresh after syncing.')}
            </p>
            {isSearching && (
              <button
                type="button"
                onClick={() => setSearchTerm('')}
                className={`mt-1 inline-flex min-h-[44px] items-center justify-center gap-2 rounded-2xl border px-5 transition active:scale-95 ${
                  resolvedTheme === 'dark'
                    ? 'border-amber-400/30 bg-amber-400/10 text-amber-200 active:bg-amber-400/20'
                    : 'border-amber-400/40 bg-amber-400/15 text-amber-700 active:bg-amber-400/25'
                }`}
              >
                {t('menu.offersEmpty.clearSearch', 'Clear search')}
              </button>
            )}
          </div>
        </motion.div>
      );
    }
    return (
      <motion.div key="combos" variants={pageMotionContainer} className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      {filteredCombos.map((combo) => (
        <motion.div
          key={combo.id}
          variants={pageMotionItem}
          className={`${gridCardClass} ${!combo.is_active ? 'opacity-60 grayscale' : ''}`}
        >
          <div className="flex items-start justify-between mb-2">
            <div className="flex-1">
              <h3 className={`font-semibold ${resolvedTheme === 'dark' ? 'text-white' : 'text-gray-900'}`}>
                {(language === 'el' ? (combo.name_el || combo.name_en) : combo.name_en) || t('menu.unnamed', 'Unnamed')}
              </h3>
              <p className={`text-sm ${resolvedTheme === 'dark' ? 'text-gray-400' : 'text-gray-600'}`}>
                {formatCurrency(combo.base_price || 0, 'EUR', language)}
              </p>
              {combo.is_featured && (
                <span className="text-xs bg-yellow-100 text-yellow-800 px-2 py-0.5 rounded-full">
                  {t('menu.featured', 'Featured')}
                </span>
              )}
            </div>
            <button
              onClick={() => toggleComboAvailability(combo.id, combo.is_active)}
              disabled={toggleAction.disabled}
              aria-label={toggleAction.message || (combo.is_active ? t('menu.disable', 'Disable') : t('menu.enable', 'Enable'))}
              className={getAvailabilityToggleClass(combo.is_active)}
            >
              {combo.is_active ? <Eye className="w-5 h-5" /> : <EyeOff className="w-5 h-5" />}
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
          <h1 className={`text-3xl font-bold ${resolvedTheme === 'dark' ? 'text-white' : 'text-gray-900'}`}>
            {t('menu.header')}
          </h1>
          <p className={`text-lg mt-2 ${resolvedTheme === 'dark' ? 'text-gray-300' : 'text-gray-600'}`}>
            {t('menu.description')}
          </p>
        </div>
        <button
          onClick={loadData}
          disabled={loading}
          aria-label={refreshLabel}
          className={`inline-flex h-12 w-12 items-center justify-center rounded-2xl border backdrop-blur-xl transition shadow-sm shadow-amber-500/10 ${resolvedTheme === 'dark' ? 'border-amber-400/30 bg-white/10 text-amber-300 active:bg-white/20' : 'border-amber-400/40 bg-black/5 text-amber-600 active:bg-black/10'} ${loading ? 'opacity-60 cursor-not-allowed' : 'active:scale-95'}`}
        >
          <RefreshCw className={`w-5 h-5 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </motion.div>

      {renderTabs()}
      {renderSearchBar()}

      {loading ? (
        <motion.div variants={pageMotionItem} className="flex items-center justify-center py-12">
          <RefreshCw className="w-8 h-8 animate-spin text-yellow-400" />
        </motion.div>
      ) : (
        <>
          {activeTab === 'categories' && renderCategories()}
          {activeTab === 'subcategories' && renderMenuItems()}
          {activeTab === 'ingredients' && renderIngredients()}
          {activeTab === 'combos' && renderCombos()}
        </>
      )}
    </motion.div>
  );
};

export default MenuManagementPage;
