import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../contexts/theme-context';
import { toast } from 'react-hot-toast';
import { Package, Coffee, Eye, EyeOff, Search, RefreshCw } from 'lucide-react';

// Types
interface MenuItem {
  id: string;
  name: string;
  category_id: string;
  is_available: boolean;
  price: number;
  image_url?: string;
  flavor_type?: 'savory' | 'sweet';
}

interface Ingredient {
  id: string;
  name_en: string;
  name_el: string;
  name?: string;
  category_id?: string;
  is_active: boolean;
  price?: number;
  item_color?: string;
}

interface Category {
  id: string;
  name_en: string;
  name_el: string;
  is_active: boolean;
}

export const MenuManagementPage: React.FC = () => {
  const { t, i18n } = useTranslation();
  const { resolvedTheme } = useTheme();
  const language = i18n.language;
  const [activeTab, setActiveTab] = useState<'categories' | 'subcategories' | 'ingredients'>('subcategories');
  const [loading, setLoading] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');

  // Data states
  const [categories, setCategories] = useState<Category[]>([]);
  const [menuItems, setMenuItems] = useState<MenuItem[]>([]);
  const [ingredients, setIngredients] = useState<Ingredient[]>([]);

  // Load data on mount and tab change
  useEffect(() => {
    loadData();
  }, [activeTab]);

  // Real-time sync listener
  useEffect(() => {
    if (!window.electronAPI) return;

    const handleMenuSync = (event: any, data: any) => {
      console.log('📡 Menu sync received:', data);
      // Reload current tab data
      loadData();
    };

    window.electronAPI.ipcRenderer.on('menu:sync', handleMenuSync);

    return () => {
      window.electronAPI.ipcRenderer.removeListener('menu:sync', handleMenuSync);
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
      }
    } catch (error) {
      console.error('Error loading data:', error);
      toast.error('Failed to load data');
    } finally {
      setLoading(false);
    }
  };

  const loadCategories = async () => {
    if (!window.electronAPI) return;
    try {
      const result = await window.electronAPI.ipcRenderer.invoke('menu:get-categories');
      setCategories(result || []);
    } catch (error) {
      console.error('Error loading categories:', error);
      toast.error('Failed to load categories');
    }
  };

  const loadMenuItems = async () => {
    if (!window.electronAPI) return;
    try {
      const result = await window.electronAPI.ipcRenderer.invoke('menu:get-subcategories');
      setMenuItems(result || []);
    } catch (error) {
      console.error('Error loading menu items:', error);
      toast.error('Failed to load menu items');
    }
  };

  const loadIngredients = async () => {
    if (!window.electronAPI) return;
    try {
      const result = await window.electronAPI.ipcRenderer.invoke('menu:get-ingredients');
      setIngredients(result || []);
    } catch (error) {
      console.error('Error loading ingredients:', error);
      toast.error('Failed to load ingredients');
    }
  };

  const toggleCategoryAvailability = async (id: string, currentStatus: boolean) => {
    const original = categories;
    // Optimistic update
    setCategories(prev => prev.map(c => c.id === id ? { ...c, is_active: !currentStatus } : c));

    try {
      if (!window.electronAPI) throw new Error('Electron API not available');
      
      await window.electronAPI.ipcRenderer.invoke('menu:update-category', {
        id,
        is_active: !currentStatus
      });

      toast.success('Category updated successfully');
    } catch (error) {
      console.error('Error updating category:', error);
      toast.error('Failed to update category');
      setCategories(original);
    }
  };

  const toggleMenuItemAvailability = async (id: string, currentStatus: boolean) => {
    const original = menuItems;
    // Optimistic update
    setMenuItems(prev => prev.map(item => item.id === id ? { ...item, is_available: !currentStatus } : item));

    try {
      if (!window.electronAPI) throw new Error('Electron API not available');
      
      await window.electronAPI.ipcRenderer.invoke('menu:update-subcategory', {
        id,
        is_available: !currentStatus
      });

      toast.success('Menu item updated successfully');
    } catch (error) {
      console.error('Error updating menu item:', error);
      toast.error('Failed to update menu item');
      setMenuItems(original);
    }
  };

  const toggleIngredientAvailability = async (id: string, currentStatus: boolean) => {
    const original = ingredients;
    // Optimistic update
    setIngredients(prev => prev.map(ing => ing.id === id ? { ...ing, is_active: !currentStatus } : ing));

    try {
      if (!window.electronAPI) throw new Error('Electron API not available');
      
      await window.electronAPI.ipcRenderer.invoke('menu:update-ingredient', {
        id,
        is_active: !currentStatus
      });

      toast.success('Ingredient updated successfully');
    } catch (error) {
      console.error('Error updating ingredient:', error);
      toast.error('Failed to update ingredient');
      setIngredients(original);
    }
  };

  // Filter data based on search term
  const filteredCategories = categories.filter(cat =>
    cat.name_en.toLowerCase().includes(searchTerm.toLowerCase()) ||
    cat.name_el.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const filteredMenuItems = menuItems.filter(item =>
    item.name.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const filteredIngredients = ingredients.filter(ing =>
    (ing.name_en?.toLowerCase().includes(searchTerm.toLowerCase()) ||
     ing.name_el?.toLowerCase().includes(searchTerm.toLowerCase()) ||
     ing.name?.toLowerCase().includes(searchTerm.toLowerCase()))
  );

  const renderTabs = () => (
    <div className="flex gap-2 mb-6">
      <button
        onClick={() => setActiveTab('categories')}
        className={`px-4 py-2 rounded-lg transition-all ${
          activeTab === 'categories'
            ? resolvedTheme === 'dark'
              ? 'bg-blue-500/30 text-blue-200 border border-blue-500/50'
              : 'bg-blue-500 text-white'
            : resolvedTheme === 'dark'
              ? 'bg-gray-800/50 text-gray-300 hover:bg-gray-700/50'
              : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
        }`}
      >
        Categories
      </button>
      <button
        onClick={() => setActiveTab('subcategories')}
        className={`px-4 py-2 rounded-lg transition-all ${
          activeTab === 'subcategories'
            ? resolvedTheme === 'dark'
              ? 'bg-blue-500/30 text-blue-200 border border-blue-500/50'
              : 'bg-blue-500 text-white'
            : resolvedTheme === 'dark'
              ? 'bg-gray-800/50 text-gray-300 hover:bg-gray-700/50'
              : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
        }`}
      >
        Subcategories
      </button>
      <button
        onClick={() => setActiveTab('ingredients')}
        className={`px-4 py-2 rounded-lg transition-all ${
          activeTab === 'ingredients'
            ? resolvedTheme === 'dark'
              ? 'bg-blue-500/30 text-blue-200 border border-blue-500/50'
              : 'bg-blue-500 text-white'
            : resolvedTheme === 'dark'
              ? 'bg-gray-800/50 text-gray-300 hover:bg-gray-700/50'
              : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
        }`}
      >
        Ingredients
      </button>
    </div>
  );

  const renderSearchBar = () => (
    <div className="mb-6 flex gap-4">
      <div className="flex-1 relative">
        <Search className={`absolute left-3 top-1/2 transform -translate-y-1/2 w-5 h-5 ${
          resolvedTheme === 'dark' ? 'text-gray-400' : 'text-gray-500'
        }`} />
        <input
          type="text"
          placeholder={t('menu.searchPlaceholder')}
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          className={`w-full pl-10 pr-4 py-2 rounded-lg border ${
            resolvedTheme === 'dark'
              ? 'bg-gray-800/50 border-gray-700 text-white placeholder-gray-400'
              : 'bg-white border-gray-300 text-gray-900 placeholder-gray-500'
          } focus:outline-none focus:ring-2 focus:ring-blue-500`}
        />
      </div>
      <button
        onClick={loadData}
        className={`px-4 py-2 rounded-lg flex items-center gap-2 ${
          resolvedTheme === 'dark'
            ? 'bg-gray-800/50 text-gray-300 hover:bg-gray-700/50'
            : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
        }`}
      >
        <RefreshCw className="w-4 h-4" />
        Refresh
      </button>
    </div>
  );

  const renderCategories = () => (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      {filteredCategories.map((category) => (
        <div
          key={category.id}
          className={`p-4 rounded-xl border ${
            resolvedTheme === 'dark'
              ? 'bg-gray-800/50 border-gray-700'
              : 'bg-white border-gray-200'
          } ${!category.is_active ? 'opacity-60 grayscale' : ''}`}
        >
          <div className="flex items-center justify-between">
            <div>
              <h3 className={`font-semibold ${resolvedTheme === 'dark' ? 'text-white' : 'text-gray-900'}`}>
                {language === 'el' ? category.name_el : category.name_en}
              </h3>
            </div>
            <button
              onClick={() => toggleCategoryAvailability(category.id, category.is_active)}
              className={`p-2 rounded-lg transition-all ${
                category.is_active
                  ? 'text-green-500 hover:bg-green-500/10'
                  : 'text-red-500 hover:bg-red-500/10'
              }`}
              title={category.is_active ? 'Disable' : 'Enable'}
            >
              {category.is_active ? <Eye className="w-5 h-5" /> : <EyeOff className="w-5 h-5" />}
            </button>
          </div>
        </div>
      ))}
    </div>
  );

  const renderMenuItems = () => (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      {filteredMenuItems.map((item) => (
        <div
          key={item.id}
          className={`p-4 rounded-xl border ${
            resolvedTheme === 'dark'
              ? 'bg-gray-800/50 border-gray-700'
              : 'bg-white border-gray-200'
          } ${!item.is_available ? 'opacity-60 grayscale' : ''}`}
        >
          <div className="flex items-start justify-between mb-2">
            <div className="flex-1">
              <h3 className={`font-semibold ${resolvedTheme === 'dark' ? 'text-white' : 'text-gray-900'}`}>
                {item.name}
              </h3>
              <p className={`text-sm ${resolvedTheme === 'dark' ? 'text-gray-400' : 'text-gray-600'}`}>
                €{item.price.toFixed(2)}
              </p>
            </div>
            <button
              onClick={() => toggleMenuItemAvailability(item.id, item.is_available)}
              className={`p-2 rounded-lg transition-all ${
                item.is_available
                  ? 'text-green-500 hover:bg-green-500/10'
                  : 'text-red-500 hover:bg-red-500/10'
              }`}
              title={item.is_available ? 'Disable' : 'Enable'}
            >
              {item.is_available ? <Eye className="w-5 h-5" /> : <EyeOff className="w-5 h-5" />}
            </button>
          </div>
        </div>
      ))}
    </div>
  );

  const renderIngredients = () => (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      {filteredIngredients.map((ingredient) => (
        <div
          key={ingredient.id}
          className={`p-4 rounded-xl border ${
            resolvedTheme === 'dark'
              ? 'bg-gray-800/50 border-gray-700'
              : 'bg-white border-gray-200'
          } ${!ingredient.is_active ? 'opacity-60 grayscale' : ''}`}
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
                  {language === 'el' ? ingredient.name_el : ingredient.name_en}
                </h3>
              </div>
              {ingredient.price && (
                <p className={`text-sm ${resolvedTheme === 'dark' ? 'text-gray-400' : 'text-gray-600'}`}>
                  €{ingredient.price.toFixed(2)}
                </p>
              )}
            </div>
            <button
              onClick={() => toggleIngredientAvailability(ingredient.id, ingredient.is_active)}
              className={`p-2 rounded-lg transition-all ${
                ingredient.is_active
                  ? 'text-green-500 hover:bg-green-500/10'
                  : 'text-red-500 hover:bg-red-500/10'
              }`}
              title={ingredient.is_active ? 'Disable' : 'Enable'}
            >
              {ingredient.is_active ? <Eye className="w-5 h-5" /> : <EyeOff className="w-5 h-5" />}
            </button>
          </div>
        </div>
      ))}
    </div>
  );

  return (
    <div className="p-6">
      <div className="mb-6">
        <h1 className={`text-3xl font-bold ${resolvedTheme === 'dark' ? 'text-white' : 'text-gray-900'}`}>
          {t('menu.header')}
        </h1>
        <p className={`text-lg mt-2 ${resolvedTheme === 'dark' ? 'text-gray-300' : 'text-gray-600'}`}>
          {t('menu.description')}
        </p>
      </div>

      {renderTabs()}
      {renderSearchBar()}

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <RefreshCw className="w-8 h-8 animate-spin text-blue-500" />
        </div>
      ) : (
        <>
          {activeTab === 'categories' && renderCategories()}
          {activeTab === 'subcategories' && renderMenuItems()}
          {activeTab === 'ingredients' && renderIngredients()}
        </>
      )}
    </div>
  );
};

export default MenuManagementPage;

