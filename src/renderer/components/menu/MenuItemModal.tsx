import React, { useState, useEffect, useMemo, useRef } from 'react';
import { toast } from 'react-hot-toast';
import { useTheme } from '../../contexts/theme-context';
import { useI18n } from '../../contexts/i18n-context';
import { menuService, MenuItem, Ingredient } from '../../services/MenuService';
import { Ban, Check, MessageSquare, Minus, Search, ShoppingCart, X } from 'lucide-react';
import { formatCurrency } from '../../utils/format';

interface SelectedIngredient {
  ingredient: Ingredient;
  quantity: number;
  isLittle?: boolean; // Flag for "little" portion
  isWithout?: boolean; // Flag for "without" - ingredient removed, no price change
}

interface MenuItemModalProps {
  isOpen: boolean;
  onClose: () => void;
  menuItem: MenuItem | null;
  orderType?: 'pickup' | 'delivery' | 'dine-in';
  onAddToCart: (item: MenuItem, quantity: number, customizations: SelectedIngredient[], notes: string) => void;
  isCustomizable?: boolean;
  // Edit mode props - pre-populate with existing customizations
  initialCustomizations?: SelectedIngredient[];
  initialQuantity?: number;
  initialNotes?: string;
  isEditMode?: boolean;
}

export const MenuItemModal: React.FC<MenuItemModalProps> = ({
  isOpen,
  onClose,
  menuItem,
  orderType = 'delivery',
  onAddToCart,
  isCustomizable = false,
  initialCustomizations = [],
  initialQuantity = 1,
  initialNotes = '',
  isEditMode = false
}) => {
  const { t, language } = useI18n();
  const { resolvedTheme } = useTheme();
  const [selectedIngredients, setSelectedIngredients] = useState<SelectedIngredient[]>([]);
  const [availableIngredients, setAvailableIngredients] = useState<Ingredient[]>([]);
  const [quantity, setQuantity] = useState(1);
  const [notes, setNotes] = useState("");
  const [showNotesOverlay, setShowNotesOverlay] = useState(false);
  const [loading, setLoading] = useState(false);
  const [ingredientsByColor, setIngredientsByColor] = useState<{ [color: string]: Ingredient[] }>({});
  const [activeFlavorType, setActiveFlavorType] = useState<'all' | 'savory' | 'sweet'>('all');
  const [isLittleMode, setIsLittleMode] = useState(false);
  const [isWithoutMode, setIsWithoutMode] = useState(false); // New: "without" mode for removing ingredients
  const [ingredientSearch, setIngredientSearch] = useState('');
  const ingredientSearchRef = useRef<HTMLInputElement>(null);

  // Auto-focus search input after modal renders
  useEffect(() => {
    const timer = setTimeout(() => ingredientSearchRef.current?.focus(), 150);
    return () => clearTimeout(timer);
  }, []);

  // Track which menuItem we've initialized for to prevent re-initialization on parent re-renders
  const initializedForMenuItemRef = React.useRef<string | null>(null);

  useEffect(() => {
    if (isOpen && menuItem) {
      // Only initialize if this is a NEW menuItem (different from what we've already initialized)
      // This prevents resetting selectedIngredients when parent re-renders due to silentRefresh
      const menuItemId = menuItem.id;
      if (initializedForMenuItemRef.current === menuItemId) {
        // Already initialized for this menuItem, skip re-initialization
        return;
      }

      // Mark this menuItem as initialized
      initializedForMenuItemRef.current = menuItemId;

      // In edit mode, use initial values; otherwise reset
      if (isEditMode && initialCustomizations.length > 0) {
        setSelectedIngredients(initialCustomizations);
        setQuantity(initialQuantity);
        setNotes(initialNotes);
      } else {
        setSelectedIngredients([]);
        setQuantity(initialQuantity || 1);
        setNotes(initialNotes || '');
      }
      setActiveFlavorType('all');
      setIsLittleMode(false);
      setIsWithoutMode(false);
      loadAvailableIngredients();
    } else if (!isOpen) {
      // Reset the ref when modal closes so next open will initialize fresh
      initializedForMenuItemRef.current = null;
    }
  }, [isOpen, menuItem, isEditMode, initialCustomizations, initialQuantity, initialNotes]);


  // Guard: don't render if closed or no item provided
  if (!isOpen || !menuItem) {
    return null;
  }

  const loadAvailableIngredients = async () => {
    if (!menuItem) return;

    setLoading(true);
    try {
      // Always load ingredients - even non-customizable items can have extras or "without"
      const ingredients = await menuService.getIngredients();
      setAvailableIngredients(ingredients);

      // Group ingredients by item_color
      const byColor = ingredients.reduce((acc, ingredient) => {
        const color = ingredient.item_color || '#6B7280'; // Default gray if no color
        if (!acc[color]) {
          acc[color] = [];
        }
        acc[color].push(ingredient);
        return acc;
      }, {} as { [key: string]: Ingredient[] });

      setIngredientsByColor(byColor);

      // Only load default ingredients for customizable items when NOT in edit mode
      // In edit mode, we use the initialCustomizations passed in
      if (menuItem.is_customizable === true && !isEditMode) {
        const defaultIngredients = await menuService.getMenuItemIngredients(menuItem.id);
        const defaultSelected = defaultIngredients
          .filter(mi => mi.is_default)
          .map(mi => {
            const ingredient = ingredients.find((ing: Ingredient) => ing.id === mi.ingredient_id);
            return ingredient ? {
              ingredient,
              quantity: mi.quantity,
              isLittle: false,
              isWithout: false
            } : null;
          })
          .filter(Boolean) as SelectedIngredient[];

        setSelectedIngredients(defaultSelected);
      } else if (!isEditMode) {
        // For non-customizable items not in edit mode, start with empty selection
        // User can add extras or mark items as "without"
        setSelectedIngredients([]);
      }
      // In edit mode, selectedIngredients is already set from initialCustomizations
    } catch (error) {
      console.error('Error loading ingredients:', error);
      toast.error(t('menu.messages.loadFailed'));
    } finally {
      setLoading(false);
    }
  };

  if (!isOpen || !menuItem) return null;

  // Helper function to get localized ingredient name
  const getIngredientName = (ingredient: Ingredient): string => {
    if (language === 'el' && ingredient.name_el) {
      return ingredient.name_el;
    }
    if (language === 'en' && ingredient.name_en) {
      return ingredient.name_en;
    }
    // Fallback to name_en, then name_el, then name
    return ingredient.name_en || ingredient.name_el || ingredient.name || 'Unknown';
  };

  const handleIngredientToggle = (ingredient: Ingredient, isSelected: boolean) => {
    if (isSelected) {
      // Check if we've reached the max ingredients limit (only for customizable items)
      if (menuItem?.is_customizable && menuItem.max_ingredients && selectedIngredients.length >= menuItem.max_ingredients) {
        toast.error(t('menu.validation.maxIngredients', { count: menuItem.max_ingredients }));
        return;
      }

      setSelectedIngredients(prev => [
        ...prev,
        {
          ingredient,
          quantity: 1,
          isLittle: isLittleMode,
          isWithout: isWithoutMode // Mark as "without" if in without mode
        }
      ]);
    } else {
      setSelectedIngredients(prev =>
        prev.filter(si => si.ingredient.id !== ingredient.id)
      );
    }
    // Clear search and re-focus input for next search
    setIngredientSearch('');
    setTimeout(() => ingredientSearchRef.current?.focus(), 50);
  };

  const handleIngredientQuantityChange = (ingredientId: string, newQuantity: number) => {
    if (newQuantity < 1) {
      setSelectedIngredients(prev =>
        prev.filter(si => si.ingredient.id !== ingredientId)
      );
    } else {
      setSelectedIngredients(prev =>
        prev.map(si =>
          si.ingredient.id === ingredientId
            ? { ...si, quantity: newQuantity }
            : si
        )
      );
    }
  };

  const handleAddToCart = () => {
    onAddToCart(menuItem, quantity, selectedIngredients, notes);
    onClose();
    toast.success(t('menu.messages.itemAddedToCart', { name: menuItem.name }));
  };

  // Calculate total price with order type consideration (three-tier pricing)
  const getBasePrice = () => {
    if (!menuItem) return 0;
    if (orderType === 'pickup' && menuItem.pickup_price) {
      return menuItem.pickup_price;
    } else if (orderType === 'delivery' && menuItem.delivery_price) {
      return menuItem.delivery_price;
    } else if (orderType === 'dine-in' && menuItem.dine_in_price) {
      return menuItem.dine_in_price;
    }
    return menuItem.base_price || menuItem.price || 0;
  };

  const basePrice = getBasePrice();
  const getIngredientUnitPrice = (ing: Ingredient) => {
    if (orderType === 'pickup' && ing.pickup_price !== undefined) return ing.pickup_price;
    if (orderType === 'delivery' && ing.delivery_price !== undefined) return ing.delivery_price;
    if (orderType === 'dine-in' && ing.dine_in_price !== undefined) return ing.dine_in_price;
    return ing.price || 0;
  };
  // Only charge for ingredients that are NOT marked as "without"
  const ingredientPrice = selectedIngredients
    .filter(si => !si.isWithout)
    .reduce((sum, si) => sum + (getIngredientUnitPrice(si.ingredient) * si.quantity), 0);
  const totalPrice = (basePrice + ingredientPrice) * quantity;

  const isIngredientSelected = (ingredient: Ingredient) => {
    return selectedIngredients.some(si => si.ingredient.id === ingredient.id);
  };

  const getIngredientQuantity = (ingredient: Ingredient) => {
    const selected = selectedIngredients.find(si => si.ingredient.id === ingredient.id);
    return selected ? selected.quantity : 0;
  };

  // Filter ingredients by flavor type and search query
  const filteredIngredients = useMemo(() => {
    let result = availableIngredients;
    if (activeFlavorType !== 'all') {
      result = result.filter(ing => ing.flavor_type === activeFlavorType);
    }
    if (ingredientSearch.trim()) {
      const q = ingredientSearch.trim().toLowerCase();
      result = result.filter(ing => ing.name?.toLowerCase().includes(q));
    }
    return result;
  }, [availableIngredients, activeFlavorType, ingredientSearch]);

  // Group filtered ingredients by color
  const filteredByColor = useMemo(() => {
    return filteredIngredients.reduce((acc, ingredient) => {
      const color = ingredient.item_color || '#6B7280';
      if (!acc[color]) {
        acc[color] = [];
      }
      acc[color].push(ingredient);
      return acc;
    }, {} as { [key: string]: Ingredient[] });
  }, [filteredIngredients]);

  return (
    <>
      {/* Backdrop */}
      <div
        className="liquid-glass-modal-backdrop fixed inset-0 z-[1100]"
        onClick={onClose}
      />

      {/* Modal Container */}
      <div role="dialog" aria-modal="true" className="liquid-glass-modal-shell fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-5xl max-h-[95vh] z-[1101] flex flex-col">
        {/* Non-scrolling Header */}
        <div className="flex-shrink-0 px-6 pt-4 pb-2 space-y-3">
          {/* Title row with mode toggles and close */}
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-lg font-semibold liquid-glass-modal-text">
                {menuItem.is_customizable
                  ? t('menu.itemModal.customizeTitle', { item: menuItem.name })
                  : t('menu.itemModal.extrasTitle') || 'Extras & Modifications'}
              </h3>
              {menuItem.is_customizable && menuItem.max_ingredients && (
                <p className="text-sm liquid-glass-modal-text-muted mt-1">
                  {t('menu.itemModal.maxIngredientsHint', { count: menuItem.max_ingredients })}
                </p>
              )}
              {!menuItem.is_customizable && (
                <p className="text-sm liquid-glass-modal-text-muted mt-1">
                  {t('menu.itemModal.extrasHint') || 'Add extras or mark ingredients as "without"'}
                </p>
              )}
            </div>

            {/* Mode Toggles + Close button */}
            <div className="flex items-center gap-3">
              {/* Without Mode Toggle - Red glow */}
              <button
                onClick={() => {
                  setIsWithoutMode(!isWithoutMode);
                  if (!isWithoutMode) setIsLittleMode(false);
                }}
                className={`px-4 py-2 rounded-full font-semibold text-sm transition-all duration-300 ${
                  isWithoutMode
                    ? 'bg-red-500 text-white shadow-[0_0_20px_rgba(239,68,68,0.6),0_0_40px_rgba(239,68,68,0.3)] scale-105 border-2 border-red-300'
                    : 'bg-gray-200/50 dark:bg-gray-700/50 text-gray-600 dark:text-gray-300 border-2 border-transparent hover:bg-red-100 dark:hover:bg-red-900/30 hover:border-red-300 dark:hover:border-red-700'
                }`}
                title={t('menu.itemModal.withoutHint') || 'Mark ingredients to remove (no price change)'}
                style={{
                  textRendering: 'geometricPrecision',
                  WebkitFontSmoothing: 'subpixel-antialiased'
                }}
              >
                {t('menu.itemModal.without') || 'Without'}
              </button>

              {/* Little Mode Toggle - Orange glow */}
              <button
                onClick={() => {
                  setIsLittleMode(!isLittleMode);
                  if (!isLittleMode) setIsWithoutMode(false);
                }}
                className={`px-4 py-2 rounded-full font-semibold text-sm transition-all duration-300 ${
                  isLittleMode
                    ? 'bg-orange-500 text-white shadow-[0_0_20px_rgba(249,115,22,0.6),0_0_40px_rgba(249,115,22,0.3)] scale-105 border-2 border-orange-300'
                    : 'bg-gray-200/50 dark:bg-gray-700/50 text-gray-600 dark:text-gray-300 border-2 border-transparent hover:bg-orange-100 dark:hover:bg-orange-900/30 hover:border-orange-300 dark:hover:border-orange-700'
                }`}
                title={t('menu.itemModal.littleHint')}
                style={{
                  textRendering: 'geometricPrecision',
                  WebkitFontSmoothing: 'subpixel-antialiased'
                }}
              >
                {t('menu.itemModal.little')}
              </button>

              {/* Close button */}
              <button
                onClick={onClose}
                className="liquid-glass-modal-button p-2 min-h-0 min-w-0"
                aria-label={t('common.actions.close')}
              >
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          </div>

          {/* Search bar */}
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <input
              ref={ingredientSearchRef}
              type="text"
              autoFocus
              value={ingredientSearch}
              onChange={(e) => setIngredientSearch(e.target.value)}
              placeholder={t('menu.itemModal.searchIngredients', 'Search ingredients...')}
              className="w-full pl-9 pr-8 py-2 rounded-lg bg-white/10 border border-white/20 text-sm text-white placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
            {ingredientSearch && (
              <button
                onClick={() => setIngredientSearch('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-white"
              >
                <X className="w-4 h-4" />
              </button>
            )}
          </div>

          {/* Flavor Type Tabs */}
          <div className="flex gap-2 pb-3 border-b liquid-glass-modal-border">
                  <button
                    onClick={() => setActiveFlavorType('all')}
                    className={`px-4 py-2 rounded-full font-medium transition-all duration-200 ${activeFlavorType === 'all'
                        ? 'bg-blue-500 text-white shadow-lg'
                        : 'liquid-glass-modal-button'
                      }`}
                  >
                    {t('menu.itemModal.all')}
                  </button>
                  <button
                    onClick={() => setActiveFlavorType('savory')}
                    className={`px-4 py-2 rounded-full font-medium transition-all duration-200 ${activeFlavorType === 'savory'
                        ? 'bg-orange-500 text-white shadow-lg'
                        : 'liquid-glass-modal-button'
                      }`}
                  >
                    {t('menu.itemModal.savory')}
                  </button>
                  <button
                    onClick={() => setActiveFlavorType('sweet')}
                    className={`px-4 py-2 rounded-full font-medium transition-all duration-200 ${activeFlavorType === 'sweet'
                        ? 'bg-pink-500 text-white shadow-lg'
                        : 'liquid-glass-modal-button'
                      }`}
                  >
                    {t('menu.itemModal.sweet')}
                  </button>
          </div>
        </div>

        {/* Scrollable Ingredients Body */}
        <div className="flex-1 overflow-y-auto overflow-x-hidden px-6 pb-4 min-h-0 pos-scrollbar-glass">
          <div className="space-y-6">
                  {Object.keys(filteredByColor).length === 0 ? (
                    <div className="text-center py-8 liquid-glass-modal-text-muted">
                      <p>No ingredients available for this filter.</p>
                      <p className="text-sm mt-2">Try selecting "All" to see all ingredients.</p>
                    </div>
                  ) : (
                    Object.entries(filteredByColor).map(([color, ingredients]) => {
                      // Get the category name from the first ingredient in this color group
                      const categoryName = ingredients[0]?.category_name || t('menu.itemModal.ingredients');
                      return (
                      <div key={color}>
                        {/* Color Header with Category Name */}
                        <div className="flex items-center gap-2 mb-3">
                          <span
                            className="h-4 w-4 rounded-full border-2 shadow-lg"
                            style={{
                              backgroundColor: color,
                              borderColor: resolvedTheme === 'dark' ? 'rgba(255,255,255,0.4)' : 'rgba(0,0,0,0.2)'
                            }}
                          />
                          <span className="text-sm font-medium liquid-glass-modal-text-muted">
                            {ingredients.length} {categoryName}
                          </span>
                        </div>

                        {/* Ingredients Grid */}
                        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                          {ingredients.map((ingredient) => {
                            const isSelected = isIngredientSelected(ingredient);
                            const selectedItem = selectedIngredients.find(si => si.ingredient.id === ingredient.id);
                            const currentQuantity = selectedItem?.quantity || 0;
                            const isLittle = selectedItem?.isLittle || false;
                            const isWithout = selectedItem?.isWithout || false;

                            // Helper function to convert hex to vivid rgba with strong saturation boost
                            const hexToVividRgba = (hex: string, alpha: number) => {
                              const r = parseInt(hex.slice(1, 3), 16);
                              const g = parseInt(hex.slice(3, 5), 16);
                              const b = parseInt(hex.slice(5, 7), 16);
                              return `rgba(${r}, ${g}, ${b}, ${alpha})`;
                            };

                            return (
                              <div
                                key={ingredient.id}
                                className={`relative p-3 rounded-xl border-2 transition-all duration-200 text-left ${isSelected
                                    ? isWithout
                                      ? 'border-red-400 shadow-lg scale-[1.02]'
                                      : 'shadow-lg scale-[1.02]'
                                    : 'hover:scale-[1.01]'
                                  }`}
                                style={{
                                  backgroundColor: isSelected
                                    ? isWithout
                                      ? 'rgba(239, 68, 68, 0.5)' // Vivid red for "without"
                                      : hexToVividRgba(color, 0.7) // Strong color when selected
                                    : hexToVividRgba(color, 0.45), // Vivid base color
                                  borderColor: isSelected && !isWithout
                                    ? hexToVividRgba(color, 1)
                                    : hexToVividRgba(color, 0.6),
                                  boxShadow: isSelected
                                    ? `0 4px 15px ${hexToVividRgba(color, 0.5)}, inset 0 1px 0 rgba(255,255,255,0.2)`
                                    : `0 2px 8px ${hexToVividRgba(color, 0.25)}`
                                }}
                              >
                                {/* Main clickable area for toggle */}
                                <button
                                  onClick={() => handleIngredientToggle(ingredient, !isSelected)}
                                  className="w-full text-left"
                                >
                                  <div className="flex flex-col gap-1 pr-8">
                                    <span
                                      className={`font-semibold text-sm line-clamp-2 ${isWithout ? 'line-through text-red-400' : ''}`}
                                      style={{
                                        color: isWithout ? undefined : (resolvedTheme === 'dark' ? '#f1f5f9' : '#1e293b'),
                                        textRendering: 'geometricPrecision',
                                        WebkitFontSmoothing: 'subpixel-antialiased'
                                      }}
                                    >
                                      {isWithout && <Ban className="w-3 h-3 inline-block mr-1 text-red-400" aria-hidden="true" />}
                                      {getIngredientName(ingredient)}
                                      {isLittle && isSelected && !isWithout && (
                                        <span className="ml-1 text-xs text-blue-400 font-medium">({t('menu.itemModal.little')})</span>
                                      )}
                                    </span>
                                    {getIngredientUnitPrice(ingredient) > 0 && !isWithout && (
                                      <span
                                        className="text-xs font-bold"
                                        style={{
                                          color: resolvedTheme === 'dark' ? '#4ade80' : '#16a34a',
                                          textShadow: resolvedTheme === 'dark' ? '0 0 2px rgba(74, 222, 128, 0.3)' : 'none'
                                        }}
                                      >
                                        +{formatCurrency(getIngredientUnitPrice(ingredient))}
                                      </span>
                                    )}
                                    {isWithout && (
                                      <span className="text-xs text-red-400 font-medium">
                                        {t('menu.itemModal.withoutLabel') || 'Without'}
                                      </span>
                                    )}
                                  </div>
                                </button>

                                {/* Quantity controls - show when selected and NOT "without" */}
                                {isSelected && !isWithout ? (
                                  <div className="absolute top-1/2 right-2 -translate-y-1/2 flex items-center gap-1">
                                    {/* Decrease button */}
                                    <button
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        handleIngredientQuantityChange(ingredient.id, currentQuantity - 1);
                                      }}
                                      className="w-8 h-8 rounded-full flex items-center justify-center transition-all touch-feedback"
                                      style={{
                                        backgroundColor: resolvedTheme === 'dark' ? 'rgba(255,255,255,0.25)' : 'rgba(0,0,0,0.15)',
                                      }}
                                      title={t('common.actions.decrease')}
                                    >
                                      <Minus className={`w-4 h-4 ${resolvedTheme === 'dark' ? 'text-white' : 'text-slate-900'}`} />
                                    </button>

                                    {/* Quantity display */}
                                    <span
                                      className="min-w-[28px] text-center text-sm"
                                      style={{
                                        color: resolvedTheme === 'dark' ? '#ffffff' : '#1e293b',
                                        fontWeight: 800,
                                        textShadow: resolvedTheme === 'dark' ? '0 1px 3px rgba(0,0,0,0.5)' : '0 1px 2px rgba(255,255,255,0.8)'
                                      }}
                                    >
                                      {currentQuantity}
                                    </span>

                                    {/* Increase button */}
                                    <button
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        handleIngredientQuantityChange(ingredient.id, currentQuantity + 1);
                                      }}
                                      className="w-8 h-8 rounded-full flex items-center justify-center transition-all touch-feedback"
                                      style={{
                                        backgroundColor: resolvedTheme === 'dark' ? 'rgba(255,255,255,0.25)' : 'rgba(0,0,0,0.15)',
                                      }}
                                      title={t('common.actions.increase')}
                                    >
                                      <span style={{ color: resolvedTheme === 'dark' ? '#ffffff' : '#1e293b', fontWeight: 700, fontSize: '16px', textShadow: '0 1px 2px rgba(0,0,0,0.2)' }}>+</span>
                                    </button>
                                  </div>
                                ) : isSelected && isWithout ? (
                                  /* X button to remove "without" selection */
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      handleIngredientToggle(ingredient, false);
                                    }}
                                    className="absolute top-1/2 right-2 -translate-y-1/2 w-8 h-8 rounded-full bg-red-500/40 hover:bg-red-500/60 flex items-center justify-center transition-all"
                                    title={t('common.actions.remove')}
                                  >
                                    <X className="w-4 h-4 text-white" />
                                  </button>
                                ) : (
                                  /* Plus button when not selected - tap to add */
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      handleIngredientToggle(ingredient, true);
                                    }}
                                    className="absolute top-1/2 right-2 -translate-y-1/2 w-8 h-8 rounded-full flex items-center justify-center transition-all touch-feedback opacity-70 hover:opacity-100"
                                    style={{
                                      backgroundColor: resolvedTheme === 'dark' ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.1)',
                                    }}
                                    title={t('common.actions.add')}
                                  >
                                    <span style={{ color: resolvedTheme === 'dark' ? '#ffffff' : '#1e293b', fontWeight: 700, fontSize: '16px' }}>+</span>
                                  </button>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    );
                    })
                  )}
          </div>
        </div>

        {/* Footer - Compact */}
        <div className="flex-shrink-0 border-t liquid-glass-modal-border px-6 py-3 space-y-3 bg-black/40 backdrop-blur-sm relative z-10">
          {/* Row: Quantity + Notes + Total */}
          <div className="flex items-center justify-between gap-3">
            {/* Quantity - inline */}
            <div className="flex items-center gap-2">
              <button
                onClick={() => setQuantity(Math.max(1, quantity - 1))}
                className="liquid-glass-modal-button w-10 h-10 rounded-full flex items-center justify-center text-lg font-bold"
              >
                <Minus className="w-4 h-4" />
              </button>
              <span className="text-xl font-bold liquid-glass-modal-text min-w-[2rem] text-center">
                {quantity}
              </span>
              <button
                onClick={() => setQuantity(quantity + 1)}
                className="liquid-glass-modal-button w-10 h-10 rounded-full flex items-center justify-center text-lg font-bold"
              >
                +
              </button>
            </div>

            {/* Notes button */}
            <button
              onClick={() => setShowNotesOverlay(true)}
              className="liquid-glass-modal-button px-3 py-2 rounded-lg text-sm flex items-center gap-2"
            >
              <MessageSquare className="w-4 h-4" />
              {notes
                ? (t('menu.itemModal.editNotes', { defaultValue: 'Edit Notes' }))
                : (t('menu.itemModal.addNotes', { defaultValue: 'Add Notes' }))}
              {notes && <span className="w-2 h-2 rounded-full bg-green-500 flex-shrink-0" />}
            </button>

            {/* Total */}
            <span className="text-2xl font-bold text-green-500">
              {formatCurrency(totalPrice)}
            </span>
          </div>

          {selectedIngredients.length > 0 && (
            <div className="text-sm liquid-glass-modal-text-muted">
              {(() => {
                const extras = selectedIngredients.filter(si => !si.isWithout);
                const withoutItems = selectedIngredients.filter(si => si.isWithout);
                const totalExtrasCount = extras.reduce((sum, si) => sum + si.quantity, 0);

                return (
                  <div className="flex items-center gap-3 flex-wrap">
                    {totalExtrasCount > 0 && (
                      <span>
                        {t('menu.itemModal.ingredientsSelected', { count: totalExtrasCount })}
                        {ingredientPrice > 0 && (
                          <span className="ml-1 text-green-500 font-semibold">
                            {t('menu.itemModal.extraPrice', {
                              price: formatCurrency(ingredientPrice)
                            })}
                          </span>
                        )}
                      </span>
                    )}
                    {withoutItems.length > 0 && (
                      <span className="text-red-400 inline-flex items-center gap-1">
                        <Ban className="w-3 h-3" />
                        {t('menu.itemModal.withoutCount', { count: withoutItems.length }) || `Without: ${withoutItems.length} item(s)`}
                      </span>
                    )}
                  </div>
                );
              })()}
            </div>
          )}

          <button
            onClick={handleAddToCart}
            className={`liquid-glass-modal-button w-full py-4 rounded-xl font-bold text-lg text-white shadow-lg hover:shadow-xl transition-all duration-200 transform hover:scale-[1.02] active:scale-98 ${isEditMode
                ? 'bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-600 hover:to-amber-700'
                : 'bg-gradient-to-r from-blue-500 to-blue-600 hover:from-blue-600 hover:to-blue-700'
              }`}
          >
            {isEditMode ? (
              <span className="inline-flex items-center gap-2">
                <Check className="w-5 h-5" aria-hidden="true" />
                {t('menu.itemModal.updateItem', { defaultValue: 'Update Item' })}
              </span>
            ) : (
              <span className="inline-flex items-center gap-2">
                <ShoppingCart className="w-5 h-5" aria-hidden="true" />
                {t('menu.itemModal.addToCart', { defaultValue: 'Add to Cart' })}
              </span>
            )}
          </button>
        </div>

        {/* Notes overlay */}
        {showNotesOverlay && (
          <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm rounded-2xl">
            <div className="bg-gray-900/95 border border-white/15 rounded-xl p-5 mx-6 max-w-md w-full shadow-2xl">
              <h3 className="text-sm font-semibold text-white mb-3">
                {t('menu.itemModal.specialInstructions')}
              </h3>
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                onClick={(e) => e.stopPropagation()}
                onFocus={(e) => e.stopPropagation()}
                onKeyDown={(e) => e.stopPropagation()}
                onKeyUp={(e) => e.stopPropagation()}
                onKeyPress={(e) => e.stopPropagation()}
                className="w-full p-3 rounded-xl bg-black/30 border border-white/10 focus:ring-2 focus:ring-blue-500 transition-all resize-none text-sm text-white placeholder:text-gray-500 pointer-events-auto cursor-text"
                rows={3}
                placeholder={t('menu.itemModal.specialInstructionsPlaceholder')}
                autoFocus
              />
              <div className="flex gap-2 justify-end mt-3">
                <button
                  onClick={() => setShowNotesOverlay(false)}
                  className="px-4 py-2 text-sm font-medium rounded-lg bg-blue-600 hover:bg-blue-700 text-white transition-colors"
                >
                  {t('common.actions.done', { defaultValue: 'Done' })}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </>
  );
};
