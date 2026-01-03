import React, { useState, useEffect, useMemo } from 'react';
import { toast } from 'react-hot-toast';
import { useTheme } from '../../contexts/theme-context';
import { useI18n } from '../../contexts/i18n-context';
import { menuService, MenuItem, Ingredient } from '../../services/MenuService';

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
  const [loading, setLoading] = useState(false);
  const [ingredientsByColor, setIngredientsByColor] = useState<{ [color: string]: Ingredient[] }>({});
  const [activeFlavorType, setActiveFlavorType] = useState<'all' | 'savory' | 'sweet'>('all');
  const [isLittleMode, setIsLittleMode] = useState(false);
  const [isWithoutMode, setIsWithoutMode] = useState(false); // New: "without" mode for removing ingredients

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

  // Filter ingredients by flavor type
  const filteredIngredients = useMemo(() => {
    if (activeFlavorType === 'all') {
      return availableIngredients;
    }

    return availableIngredients.filter(ing => ing.flavor_type === activeFlavorType);
  }, [availableIngredients, activeFlavorType]);

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
      <div className="liquid-glass-modal-shell fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-3xl max-h-[95vh] z-[1101] flex flex-col">
        {/* Header */}
        <div className="flex-shrink-0 px-6 py-4 border-b liquid-glass-modal-border">
          <div className="flex justify-between items-start gap-4">
            <div className="flex-1">
              <h2 className="text-2xl font-bold liquid-glass-modal-text">
                {menuItem.name}
              </h2>
              {menuItem.description && (
                <p className="text-sm mt-1 liquid-glass-modal-text-muted">
                  {menuItem.description}
                </p>
              )}
              <div className="flex items-center gap-3 mt-3 flex-wrap">
                <span className="text-lg font-bold text-green-500">
                  €{basePrice.toFixed(2)}
                </span>
                <span className="text-xs px-2 py-1 rounded-full liquid-glass-modal-badge">
                  {orderType === 'pickup' ? t('menu.item.pickup') : t('menu.item.delivery')} {t('menu.item.price')}
                </span>
              </div>
            </div>
            <button
              onClick={onClose}
              className="liquid-glass-modal-button p-2 min-h-0 min-w-0 shrink-0"
              aria-label={t('common.actions.close')}
            >
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        {/* Scrollable Content */}
        <div className="flex-1 overflow-y-auto overflow-x-hidden px-6 py-4 min-h-0 relative z-0">
          {/* Ingredients Section - Show for ALL items (customizable or not) */}
          <div className="mb-6">
            {/* Header with Little and Without Switches */}
            <div className="flex items-center justify-between mb-4">
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

              {/* Mode Toggles */}
              <div className="flex items-center gap-4">
                {/* Without Mode Toggle */}
                <label className="flex items-center gap-2 cursor-pointer">
                  <span className="text-sm liquid-glass-modal-text">{t('menu.itemModal.without') || 'Without'}</span>
                  <button
                    onClick={() => {
                      setIsWithoutMode(!isWithoutMode);
                      if (!isWithoutMode) setIsLittleMode(false); // Turn off little mode when enabling without
                    }}
                    className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${isWithoutMode ? 'bg-red-500' : 'bg-gray-300 dark:bg-gray-600'
                      }`}
                    title={t('menu.itemModal.withoutHint') || 'Mark ingredients to remove (no price change)'}
                  >
                    <span
                      className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${isWithoutMode ? 'translate-x-6' : 'translate-x-1'
                        }`}
                    />
                  </button>
                </label>

                {/* Little Mode Toggle */}
                <label className="flex items-center gap-2 cursor-pointer">
                  <span className="text-sm liquid-glass-modal-text">{t('menu.itemModal.little')}</span>
                  <button
                    onClick={() => {
                      setIsLittleMode(!isLittleMode);
                      if (!isLittleMode) setIsWithoutMode(false); // Turn off without mode when enabling little
                    }}
                    className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${isLittleMode ? 'bg-blue-500' : 'bg-gray-300 dark:bg-gray-600'
                      }`}
                    title={t('menu.itemModal.littleHint')}
                  >
                    <span
                      className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${isLittleMode ? 'translate-x-6' : 'translate-x-1'
                        }`}
                    />
                  </button>
                </label>
              </div>
            </div>

            {loading ? (
              <div className="space-y-3">
                {[1, 2, 3].map(i => (
                  <div key={i} className="h-20 rounded-xl animate-pulse liquid-glass-modal-card" />
                ))}
              </div>
            ) : (
              <div className="space-y-4">
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

                {/* Ingredients Grouped by Color */}
                <div className="space-y-6">
                  {Object.keys(filteredByColor).length === 0 ? (
                    <div className="text-center py-8 liquid-glass-modal-text-muted">
                      <p>No ingredients available for this filter.</p>
                      <p className="text-sm mt-2">Try selecting "All" to see all ingredients.</p>
                    </div>
                  ) : (
                    Object.entries(filteredByColor).map(([color, ingredients]) => (
                      <div key={color}>
                        {/* Color Header */}
                        <div className="flex items-center gap-2 mb-3">
                          <span
                            className="h-4 w-4 rounded-full border-2 border-white/30 shadow-lg"
                            style={{ backgroundColor: color }}
                          />
                          <span className="text-sm font-medium liquid-glass-modal-text-muted">
                            {ingredients.length} {ingredients.length === 1 ? 'ingredient' : 'ingredients'}
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

                            // Helper function to convert hex to rgba
                            const hexToRgba = (hex: string, alpha: number) => {
                              const r = parseInt(hex.slice(1, 3), 16);
                              const g = parseInt(hex.slice(3, 5), 16);
                              const b = parseInt(hex.slice(5, 7), 16);
                              return `rgba(${r}, ${g}, ${b}, ${alpha})`;
                            };

                            return (
                              <div
                                key={ingredient.id}
                                className={`relative p-3 rounded-xl border-2 transition-all duration-200 text-left backdrop-blur-sm ${isSelected
                                    ? isWithout
                                      ? 'border-red-400/60 shadow-lg scale-[1.02]'
                                      : 'border-white/40 shadow-lg scale-[1.02]'
                                    : 'border-white/10 hover:border-white/30'
                                  }`}
                                style={{
                                  backgroundColor: isSelected
                                    ? isWithout
                                      ? 'rgba(239, 68, 68, 0.2)' // Red tint for "without"
                                      : hexToRgba(color, 0.3)
                                    : hexToRgba(color, 0.15),
                                  borderColor: isSelected && !isWithout ? hexToRgba(color, 0.6) : undefined
                                }}
                              >
                                {/* Main clickable area for toggle */}
                                <button
                                  onClick={() => handleIngredientToggle(ingredient, !isSelected)}
                                  className="w-full text-left"
                                >
                                  <div className="flex flex-col gap-1 pr-8">
                                    <span className={`font-medium text-sm line-clamp-2 ${isWithout ? 'line-through text-red-400' : 'liquid-glass-modal-text'
                                      }`}>
                                      {isWithout && <span className="no-underline mr-1">🚫</span>}
                                      {getIngredientName(ingredient)}
                                      {isLittle && isSelected && !isWithout && (
                                        <span className="ml-1 text-xs text-blue-400">({t('menu.itemModal.little')})</span>
                                      )}
                                    </span>
                                    {getIngredientUnitPrice(ingredient) > 0 && !isWithout && (
                                      <span className="text-xs text-green-500 font-semibold">
                                        +€{getIngredientUnitPrice(ingredient).toFixed(2)}
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
                                      className="w-7 h-7 rounded-full bg-white/20 hover:bg-white/30 active:bg-white/40 flex items-center justify-center transition-all touch-feedback"
                                      title={t('common.actions.decrease')}
                                    >
                                      <span className="text-white font-bold text-sm">−</span>
                                    </button>

                                    {/* Quantity display */}
                                    <span className="min-w-[24px] text-center text-sm font-bold text-white">
                                      {currentQuantity}
                                    </span>

                                    {/* Increase button */}
                                    <button
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        handleIngredientQuantityChange(ingredient.id, currentQuantity + 1);
                                      }}
                                      className="w-7 h-7 rounded-full bg-white/20 hover:bg-white/30 active:bg-white/40 flex items-center justify-center transition-all touch-feedback"
                                      title={t('common.actions.increase')}
                                    >
                                      <span className="text-white font-bold text-sm">+</span>
                                    </button>
                                  </div>
                                ) : isSelected && isWithout ? (
                                  /* X button to remove "without" selection */
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      handleIngredientToggle(ingredient, false);
                                    }}
                                    className="absolute top-1/2 right-2 -translate-y-1/2 w-7 h-7 rounded-full bg-red-500/30 hover:bg-red-500/50 flex items-center justify-center transition-all"
                                    title={t('common.actions.remove')}
                                  >
                                    <span className="text-white font-bold text-sm">×</span>
                                  </button>
                                ) : (
                                  /* Plus button when not selected - tap to add */
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      handleIngredientToggle(ingredient, true);
                                    }}
                                    className="absolute top-1/2 right-2 -translate-y-1/2 w-7 h-7 rounded-full bg-white/10 hover:bg-white/20 active:bg-white/30 flex items-center justify-center transition-all touch-feedback opacity-60 hover:opacity-100"
                                    title={t('common.actions.add')}
                                  >
                                    <span className="text-white font-bold text-sm">+</span>
                                  </button>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Footer - Fixed */}
        <div className="flex-shrink-0 border-t liquid-glass-modal-border px-6 py-4 space-y-4 bg-black/40 backdrop-blur-sm relative z-10">
          {/* Special Instructions */}
          <div>
            <label htmlFor="special-instructions-textarea" className="block text-sm font-medium mb-2 liquid-glass-modal-text">
              {t('menu.itemModal.specialInstructions')}
            </label>
            <textarea
              id="special-instructions-textarea"
              name="specialInstructions"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              onFocus={(e) => e.stopPropagation()}
              onKeyDown={(e) => e.stopPropagation()}
              onKeyUp={(e) => e.stopPropagation()}
              onKeyPress={(e) => e.stopPropagation()}
              className="w-full p-3 rounded-xl liquid-glass-modal-card border liquid-glass-modal-border focus:ring-2 focus:ring-blue-500 transition-all resize-none text-sm liquid-glass-modal-text placeholder:liquid-glass-modal-text-muted pointer-events-auto cursor-text"
              rows={2}
              placeholder={t('menu.itemModal.specialInstructionsPlaceholder')}
            />
          </div>

          {/* Quantity */}
          <div>
            <label className="block text-sm font-medium mb-2 liquid-glass-modal-text">
              {t('menu.itemModal.quantity')}
            </label>
            <div className="flex items-center gap-4">
              <button
                onClick={() => setQuantity(Math.max(1, quantity - 1))}
                className="liquid-glass-modal-button w-12 h-12 rounded-full flex items-center justify-center text-xl font-bold"
              >
                −
              </button>
              <span className="text-2xl font-bold liquid-glass-modal-text min-w-[3rem] text-center">
                {quantity}
              </span>
              <button
                onClick={() => setQuantity(quantity + 1)}
                className="liquid-glass-modal-button w-12 h-12 rounded-full flex items-center justify-center text-xl font-bold"
              >
                +
              </button>
            </div>
          </div>
          <div className="flex justify-between items-center mb-4">
            <span className="text-lg font-semibold liquid-glass-modal-text">
              {t('menu.itemModal.total')}:
            </span>
            <span className="text-3xl font-bold text-green-500">
              €{totalPrice.toFixed(2)}
            </span>
          </div>

          {selectedIngredients.length > 0 && (
            <div className="text-sm mb-4 liquid-glass-modal-text-muted">
              {/* Show extras and "without" items separately */}
              {(() => {
                const extras = selectedIngredients.filter(si => !si.isWithout);
                const withoutItems = selectedIngredients.filter(si => si.isWithout);
                const totalExtrasCount = extras.reduce((sum, si) => sum + si.quantity, 0);

                return (
                  <div className="space-y-1">
                    {totalExtrasCount > 0 && (
                      <div>
                        {t('menu.itemModal.ingredientsSelected', { count: totalExtrasCount })}
                        {ingredientPrice > 0 && (
                          <span className="ml-1 text-green-500 font-semibold">
                            {t('menu.itemModal.extraPrice', {
                              price: new Intl.NumberFormat('el-GR', { style: 'currency', currency: 'EUR' }).format(ingredientPrice)
                            })}
                          </span>
                        )}
                      </div>
                    )}
                    {withoutItems.length > 0 && (
                      <div className="text-red-400">
                        🚫 {t('menu.itemModal.withoutCount', { count: withoutItems.length }) || `Without: ${withoutItems.length} item(s)`}
                      </div>
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
            {isEditMode
              ? `✓ ${t('menu.itemModal.updateItem') || 'Update Item'}`
              : `🛒 ${t('menu.itemModal.addToCart')}`
            }
          </button>
        </div>
      </div>
    </>
  );
};