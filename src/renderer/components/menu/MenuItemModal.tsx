import React, { useState, useEffect, useMemo, useRef } from 'react';
import { toast } from 'react-hot-toast';
import { useTheme } from '../../contexts/theme-context';
import { useI18n } from '../../contexts/i18n-context';
import { menuService, MenuItem, Ingredient } from '../../services/MenuService';
import { Ban, Check, MessageSquare, Minus, Plus, Search, ShoppingCart, X } from 'lucide-react';
import { motion } from 'framer-motion';
import { formatCurrency } from '../../utils/format';
import { LiquidGlassModal } from '../ui/pos-glass-components';
import { renderModalPortal } from '../../utils/render-modal-portal';
import './menu-item-cart-action.css';

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
  const [activeFlavorType, setActiveFlavorType] = useState<'savory' | 'sweet'>('savory');
  const [isLittleMode, setIsLittleMode] = useState(false);
  const [isWithoutMode, setIsWithoutMode] = useState(false); // New: "without" mode for removing ingredients
  const [ingredientSearch, setIngredientSearch] = useState('');
  const ingredientSearchRef = useRef<HTMLInputElement>(null);

  // Auto-focus search input after modal renders
  useEffect(() => {
    if (!isOpen) return;
    const timer = setTimeout(() => ingredientSearchRef.current?.focus(), 150);
    return () => clearTimeout(timer);
  }, [isOpen, menuItem?.id]);

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
      setActiveFlavorType((menuItem.flavor_type as 'savory' | 'sweet') || 'savory');
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
      // Founder 01/11/2026 («τα υλικα πρεπει να ειναι απεριοριστα και απλα η λιστα να μεγαλωνει»): an item's
      // `max_ingredients` no longer caps the choice; only Gemini X test data ever set one.

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

  const handleSelectedIngredientRemove = (ingredientId: string) => {
    setSelectedIngredients(prev =>
      prev.filter(si => si.ingredient.id !== ingredientId)
    );
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
    result = result.filter(ing => ing.flavor_type === activeFlavorType);
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

  // Founder 01/11/2026 (proposal A, «ήρεμο πλέγμα»): a row of the categories on screen jumps to each section.
  const categorySectionRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const ingredientsScrollRef = useRef<HTMLDivElement | null>(null);
  // Scrolls the ingredient list itself to the section (a smooth scrollIntoView moved nothing in the till's WebView);
  // if the smooth scroll does not start, it lands there at once.
  const jumpToCategory = (color: string) => {
    const scroller = ingredientsScrollRef.current;
    const section = categorySectionRefs.current[color];
    if (!scroller || !section) return;
    const start = scroller.scrollTop;
    const top = Math.max(0, start + section.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 4);
    scroller.scrollTo({ top, behavior: 'smooth' });
    window.setTimeout(() => {
      if (Math.abs(scroller.scrollTop - start) < 1 && Math.abs(top - start) >= 1) scroller.scrollTop = top;
    }, 250);
  };
  const ingredientMode: 'normal' | 'little' | 'without' = isWithoutMode ? 'without' : isLittleMode ? 'little' : 'normal';
  const setIngredientMode = (mode: 'normal' | 'little' | 'without') => {
    setIsWithoutMode(mode === 'without');
    setIsLittleMode(mode === 'little');
  };

  const selectedExtras = useMemo(
    () => selectedIngredients.filter(si => !si.isWithout),
    [selectedIngredients]
  );

  const selectedWithoutItems = useMemo(
    () => selectedIngredients.filter(si => si.isWithout),
    [selectedIngredients]
  );

  const totalSelectedExtrasCount = useMemo(
    () => selectedExtras.reduce((sum, si) => sum + si.quantity, 0),
    [selectedExtras]
  );

  // The kit's segmented control: the chosen segment in the selection yellow, the others quiet on a sunken well.
  const segmentClass = (selected: boolean) =>
    `relative inline-flex h-10 items-center justify-center rounded-full px-4 text-sm font-semibold antialiased transition-colors touch-feedback ${
      selected ? 'text-(--pos-s-sel-fg)' : 'text-(--pos-s-muted) active:bg-(--pos-s-surface)'
    }`;
  // Founder 01/11/2026 («καπιο micro animation οταν αλλαζω τα κουμπια αυτα»): the yellow slides to the new choice
  // (180 ms ease-out, as the order tabs). Visual only: the choice changes on the same press; "reduce motion" jumps.
  const segmentIndicator = (group: 'flavor' | 'mode') => (
    <motion.span
      layoutId={`ingredients-${group}-indicator`}
      aria-hidden="true"
      transition={{ duration: 0.18, ease: [0.2, 0.8, 0.2, 1] }}
      className="absolute inset-0 rounded-full bg-(--pos-s-sel-bg) shadow-(--pos-s-depth-yellow)"
    />
  );
  const segmentWellClass = 'inline-flex shrink-0 items-center gap-1 rounded-full bg-(--pos-s-surface-2) p-1 shadow-(--pos-s-well)';
  const categoriesOnScreen = Object.entries(filteredByColor);

  const modalHeader = (
    <div className="shrink-0 px-5 pt-3 pb-2 space-y-2.5" data-ingredients-layout="calm-grid">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
          <h3 className="text-[1.05rem] font-semibold liquid-glass-modal-text">
            {menuItem.is_customizable
              ? t('menu.itemModal.customizeTitle', { item: menuItem.name })
              : t('menu.itemModal.extrasTitle') || 'Extras & Modifications'}
          </h3>
          {menuItem.is_customizable && selectedIngredients.length > 0 && (
            <span data-ingredients-count className="shrink-0 rounded-full bg-(--pos-s-ok-bg) px-2.5 py-0.5 text-xs font-semibold text-(--pos-s-ok)">
              {t('menu.itemModal.selectedCount', { count: selectedIngredients.length, defaultValue: '{{count}} ingredients' })}
            </span>
          )}
          {!menuItem.is_customizable && (
            <p className="text-xs liquid-glass-modal-text-muted">
              {t('menu.itemModal.extrasHint') || 'Add extras or mark ingredients as "without"'}
            </p>
          )}
        </div>
        <button
          onClick={onClose}
          className="liquid-glass-modal-close"
          aria-label={t('common.actions.close')}
        >
          <X className="h-5 w-5" aria-hidden="true" />
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-56 flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            ref={ingredientSearchRef}
            type="text"
            autoFocus
            value={ingredientSearch}
            onChange={(e) => setIngredientSearch(e.target.value)}
            placeholder={t('menu.itemModal.searchIngredients', 'Search ingredients...')}
            className="liquid-glass-modal-input w-full h-11 pl-9 pr-8 rounded-xl text-sm focus:ring-1 focus:ring-amber-400"
          />
          {ingredientSearch && (
            <button
              onClick={() => setIngredientSearch('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 liquid-glass-modal-text-muted active:opacity-70"
              aria-label={t('common.actions.clear', { defaultValue: 'Clear' })}
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
        <div className={segmentWellClass} role="group" aria-label={t('menu.itemModal.savory') + ' / ' + t('menu.itemModal.sweet')}>
          <button type="button" aria-pressed={activeFlavorType === 'savory'} onClick={() => setActiveFlavorType('savory')} className={segmentClass(activeFlavorType === 'savory')}>
            {activeFlavorType === 'savory' && segmentIndicator('flavor')}
            <span className="relative">{t('menu.itemModal.savory')}</span>
          </button>
          <button type="button" aria-pressed={activeFlavorType === 'sweet'} onClick={() => setActiveFlavorType('sweet')} className={segmentClass(activeFlavorType === 'sweet')}>
            {activeFlavorType === 'sweet' && segmentIndicator('flavor')}
            <span className="relative">{t('menu.itemModal.sweet')}</span>
          </button>
        </div>
        <div className={segmentWellClass} role="group" data-ingredient-mode={ingredientMode} aria-label={t('menu.itemModal.normal', { defaultValue: 'Normal' }) + ' / ' + t('menu.itemModal.little') + ' / ' + (t('menu.itemModal.without') || 'Without')}>
          <button type="button" aria-pressed={ingredientMode === 'normal'} onClick={() => setIngredientMode('normal')} className={segmentClass(ingredientMode === 'normal')}>
            {ingredientMode === 'normal' && segmentIndicator('mode')}
            <span className="relative">{t('menu.itemModal.normal', { defaultValue: 'Normal' })}</span>
          </button>
          <button type="button" aria-pressed={ingredientMode === 'little'} onClick={() => setIngredientMode('little')} className={segmentClass(ingredientMode === 'little')}>
            {ingredientMode === 'little' && segmentIndicator('mode')}
            <span className="relative">{t('menu.itemModal.little')}</span>
          </button>
          <button type="button" aria-pressed={ingredientMode === 'without'} onClick={() => setIngredientMode('without')} className={segmentClass(ingredientMode === 'without')}>
            {ingredientMode === 'without' && segmentIndicator('mode')}
            <span className="relative">{t('menu.itemModal.without') || 'Without'}</span>
          </button>
        </div>
      </div>

      {categoriesOnScreen.length > 1 && (
        <div className="pos-scroll-row flex items-center gap-2 pb-1 border-b liquid-glass-modal-border" data-ingredients-jump>
          <span className="shrink-0 text-xs font-medium liquid-glass-modal-text-muted">
            {t('menu.itemModal.jumpTo', { defaultValue: 'Go to' })}
          </span>
          {categoriesOnScreen.map(([color, ingredients]) => (
            <button
              key={color}
              type="button"
              onClick={() => jumpToCategory(color)}
              className="pos-raised inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full px-3 text-xs font-semibold liquid-glass-modal-text"
            >
              <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: color }} aria-hidden="true" />
              {ingredients[0]?.category_name || t('menu.itemModal.ingredients')}
            </button>
          ))}
        </div>
      )}
    </div>
  );

  const modalFooter = (
    <div className="liquid-glass-modal-footer shrink-0 border-t px-5 py-2 space-y-2 relative z-10">
      {selectedIngredients.length > 0 && (
        // Founder 01/11/2026 («πολυ μεγαλα ... δεν φαινονται ολα ... δεν ειναι βολικο να τα σερνεις», «δε χρειαζεται
        // απαραιτητα να ειναι pill shaped»): the choice as plain small rows in a grid that wraps, every one in view,
        // each with its category's colour dot; nothing to drag.
        <div data-ingredients-selection className="liquid-glass-modal-inset rounded-xl px-3 py-2">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs">
            <span className="font-semibold liquid-glass-modal-text">
              {t('menu.itemModal.currentSelection', { defaultValue: 'Current selection' })}
            </span>
            {totalSelectedExtrasCount > 0 && (
              <span className="liquid-glass-modal-text-muted">
                {t('menu.itemModal.ingredientsSelected', { count: totalSelectedExtrasCount })}
                {ingredientPrice > 0 && (
                  <span className="ml-1 font-semibold text-green-700 dark:text-green-400">
                    {t('menu.itemModal.extraPrice', {
                      price: formatCurrency(ingredientPrice)
                    })}
                  </span>
                )}
              </span>
            )}
            {selectedWithoutItems.length > 0 && (
              <span className="inline-flex items-center gap-1 text-red-700 dark:text-red-400">
                <Ban className="w-3 h-3 shrink-0" aria-hidden="true" />
                {t('menu.itemModal.withoutCount', { count: selectedWithoutItems.length })}
              </span>
            )}
          </div>
          <ul className="mt-1 grid grid-cols-2 gap-x-4 sm:grid-cols-3 lg:grid-cols-4">
            {selectedExtras.map((selectedItem) => {
              const ingredientName = getIngredientName(selectedItem.ingredient);
              const priceImpact = getIngredientUnitPrice(selectedItem.ingredient) * selectedItem.quantity;

              return (
                <li
                  key={`selected-${selectedItem.ingredient.id}`}
                  className="flex h-8 min-w-0 items-center gap-1.5 border-b border-(--pos-s-border)/60 text-xs antialiased liquid-glass-modal-text"
                >
                  <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: selectedItem.ingredient.item_color || '#6B7280' }} aria-hidden="true" />
                  <span className="min-w-0 truncate font-medium">{ingredientName}</span>
                  {selectedItem.quantity > 1 && (
                    <span className="shrink-0 font-bold">×{selectedItem.quantity}</span>
                  )}
                  {selectedItem.isLittle && (
                    <span className="shrink-0 liquid-glass-modal-text-muted">({t('menu.itemModal.little')})</span>
                  )}
                  {priceImpact > 0 && (
                    <span className="shrink-0 font-semibold text-green-700 dark:text-green-400">
                      +{formatCurrency(priceImpact)}
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={() => handleSelectedIngredientRemove(selectedItem.ingredient.id)}
                    className="ml-auto inline-flex shrink-0 items-center justify-center rounded-md text-(--pos-s-bad) active:bg-(--pos-s-bad-bg)"
                    style={{ width: 28, height: 28, minWidth: 28, minHeight: 28 }}
                    aria-label={`${t('common.actions.remove')} ${ingredientName}`}
                  >
                    <X className="w-3.5 h-3.5" aria-hidden="true" />
                  </button>
                </li>
              );
            })}

            {selectedWithoutItems.map((selectedItem) => (
              <li
                key={`without-${selectedItem.ingredient.id}`}
                className="flex h-8 min-w-0 items-center gap-1.5 border-b border-(--pos-s-border)/60 text-xs antialiased text-red-700 dark:text-red-400"
              >
                <Ban className="w-3 h-3 shrink-0" aria-hidden="true" />
                <span className="min-w-0 truncate font-medium line-through">
                  {getIngredientName(selectedItem.ingredient)}
                </span>
                <button
                  type="button"
                  onClick={() => handleSelectedIngredientRemove(selectedItem.ingredient.id)}
                  className="ml-auto inline-flex shrink-0 items-center justify-center rounded-md text-(--pos-s-bad) active:bg-(--pos-s-bad-bg)"
                  style={{ width: 28, height: 28, minWidth: 28, minHeight: 28 }}
                  aria-label={`${t('common.actions.remove')} ${getIngredientName(selectedItem.ingredient)}`}
                >
                  <X className="w-3.5 h-3.5" aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <button
            onClick={() => setQuantity(Math.max(1, quantity - 1))}
            className="pos-raised flex h-11 w-11 items-center justify-center rounded-full text-(--pos-s-fg)"
            aria-label={t('common.actions.decrease', { defaultValue: 'Decrease quantity' })}
          >
            <Minus className="h-5 w-5" strokeWidth={3.5} aria-hidden="true" />
          </button>
          <span className="text-lg font-bold liquid-glass-modal-text min-w-7 text-center">
            {quantity}
          </span>
          <button
            onClick={() => setQuantity(quantity + 1)}
            className="pos-raised flex h-11 w-11 items-center justify-center rounded-full text-(--pos-s-fg)"
            aria-label={t('common.actions.increase', { defaultValue: 'Increase quantity' })}
          >
            <Plus className="h-5 w-5" strokeWidth={3.5} aria-hidden="true" />
          </button>
        </div>

        <button
          onClick={() => setShowNotesOverlay(true)}
          className="liquid-glass-modal-button px-3 py-1.5 rounded-lg text-xs sm:text-sm flex items-center gap-2"
        >
          <MessageSquare className="w-4 h-4" />
          {notes
            ? (t('menu.itemModal.editNotes', { defaultValue: 'Edit Notes' }))
            : (t('menu.itemModal.addNotes', { defaultValue: 'Add Notes' }))}
          {notes && <span className="w-2 h-2 rounded-full bg-green-500 shrink-0" />}
        </button>

        <span className="text-xl font-bold text-green-500">
          {formatCurrency(totalPrice)}
        </span>
      </div>

      <button
        onClick={handleAddToCart}
        className="menu-item-cart-action"
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
  );

  return (
    <LiquidGlassModal
      isOpen={isOpen}
      onClose={onClose}
      header={modalHeader}
      footer={modalFooter}
      size="lg"
      className="menu-item-customizer-modal max-w-5xl max-h-[98vh]"
      // The list scrolls inside the window (founder 01/11/2026: «Μετάβαση» did nothing and the last ingredients were
      // out of reach): every level of the column is allowed to shrink, so the ingredient list is the one that scrolls.
      contentClassName="p-0 relative flex flex-1 min-h-0 flex-col overflow-hidden"
      initialFocusRef={ingredientSearchRef}
      ariaLabel={menuItem.name}
    >
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div ref={ingredientsScrollRef} data-ingredients-scroll className="flex-1 overflow-y-auto overflow-x-hidden px-5 pb-2 min-h-0 pos-scrollbar-glass">
          <div className="space-y-4">
                  {Object.keys(filteredByColor).length === 0 ? (
                    <div className="text-center py-8 liquid-glass-modal-text-muted">
                      <p>{t('menu.itemModal.noIngredientsForFilter', { defaultValue: 'No ingredients available for this filter.' })}</p>
                      <p className="text-sm mt-2">{t('menu.itemModal.noIngredientsForFilterHint', { all: t('menu.itemModal.all', { defaultValue: 'All' }), defaultValue: 'Try selecting "{{all}}" to see all ingredients.' })}</p>
                    </div>
                  ) : (
                    Object.entries(filteredByColor).map(([color, ingredients]) => {
                      // Get the category name from the first ingredient in this color group
                      const categoryName = ingredients[0]?.category_name || t('menu.itemModal.ingredients');
                      return (
                      <div key={color} ref={(el) => { categorySectionRefs.current[color] = el; }} className="scroll-mt-2">
                        {/* The category: its colour dot and its name. */}
                        <div className="flex items-center gap-2 mb-2">
                          <span className="h-3 w-3 rounded-full" style={{ backgroundColor: color }} aria-hidden="true" />
                          <span className="text-sm font-semibold liquid-glass-modal-text">
                            {categoryName}
                          </span>
                        </div>

                        {/* Ingredients Grid */}
                        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-2">
                          {ingredients.map((ingredient) => {
                            const isSelected = isIngredientSelected(ingredient);
                            const selectedItem = selectedIngredients.find(si => si.ingredient.id === ingredient.id);
                            const currentQuantity = selectedItem?.quantity || 0;
                            const isLittle = selectedItem?.isLittle || false;
                            const isWithout = selectedItem?.isWithout || false;

                            // Keep configured category colors on borders; use a neutral readable card.
                            const hexToVividRgba = (hex: string, alpha: number) => {
                              const r = parseInt(hex.slice(1, 3), 16);
                              const g = parseInt(hex.slice(3, 5), 16);
                              const b = parseInt(hex.slice(5, 7), 16);
                              return `rgba(${r}, ${g}, ${b}, ${alpha})`;
                            };
                            const surfaceColor = isWithout ? '#EF4444' : color;
                            const neutral = resolvedTheme === 'dark' ? [15, 23, 42] : [255, 255, 255];
                            // Every ingredient keeps its category colours (founder 01/11/2026); a chosen one deepens them.
                            const tint = isWithout ? 0.12 : isSelected ? 0.22 : 0.07;
                            const surfaceChannels = [1, 3, 5].map((offset, index) => {
                              const channel = parseInt(surfaceColor.slice(offset, offset + 2), 16);
                              return Math.round((Number.isFinite(channel) ? channel : neutral[index]) * tint + neutral[index] * (1 - tint));
                            });

                            return (
                              <div
                                key={ingredient.id}
                                data-ingredient-selected={isSelected ? (isWithout ? 'without' : 'yes') : undefined}
                                className={`relative p-3 rounded-xl border-2 transition-colors duration-200 text-left ${isSelected
                                    ? isWithout
                                      ? 'border-red-400'
                                      : ''
                                    : 'active:translate-y-px'
                                  }`}
                                style={{
                                  backgroundColor: `rgb(${surfaceChannels.join(', ')})`,
                                  borderColor: isSelected && !isWithout
                                    ? hexToVividRgba(color, 1)
                                    : hexToVividRgba(color, 0.6),
                                  boxShadow: isSelected && !isWithout
                                    ? `0 0 0 2px ${hexToVividRgba(color, 0.35)}, var(--pos-s-depth)`
                                    : undefined,
                                }}
                              >
                                {/* Main clickable area for toggle */}
                                <button
                                  onClick={() => handleIngredientToggle(ingredient, !isSelected)}
                                  aria-pressed={isSelected}
                                  className="w-full min-h-11 text-left"
                                >
                                  <div className="flex flex-col gap-1 pr-8">
                                    <span
                                      className={`ingredient-text-crisp font-semibold text-sm line-clamp-2 ${isWithout ? 'line-through text-red-400' : ''}`}
                                      style={{
                                        color: isWithout ? (resolvedTheme === 'dark' ? '#FCA5A5' : '#991B1B') : (resolvedTheme === 'dark' ? '#f1f5f9' : '#1e293b'),
                                        textRendering: 'geometricPrecision',
                                        WebkitFontSmoothing: 'subpixel-antialiased'
                                      }}
                                    >
                                      {isWithout && <Ban className="w-3 h-3 inline-block mr-1 text-red-400" aria-hidden="true" />}
                                      {getIngredientName(ingredient)}
                                      {isLittle && isSelected && !isWithout && (
                                        <span className="ml-1 text-xs font-medium" style={{ color: resolvedTheme === 'dark' ? '#FCD34D' : '#92400E' }}>({t('menu.itemModal.little')})</span>
                                      )}
                                    </span>
                                    {getIngredientUnitPrice(ingredient) > 0 && !isWithout && (
                                      <span
                                        className="text-xs font-bold"
                                        style={{
                                          color: resolvedTheme === 'dark' ? '#f1f5f9' : '#1e293b',
                                        }}
                                      >
                                        +{formatCurrency(getIngredientUnitPrice(ingredient))}
                                      </span>
                                    )}
                                    {isWithout && (
                                      <span className="text-xs font-medium" style={{ color: resolvedTheme === 'dark' ? '#FCA5A5' : '#991B1B' }}>
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
                                      className="pos-raised w-8 h-8 rounded-full flex items-center justify-center text-(--pos-s-fg)"
                                      aria-label={t('common.actions.decrease')}
                                    >
                                      <Minus className="w-4 h-4" strokeWidth={3} aria-hidden="true" />
                                    </button>

                                    {/* Quantity display */}
                                    <span
                                      className="min-w-[28px] text-center text-sm"
                                      style={{
                                        color: resolvedTheme === 'dark' ? '#ffffff' : '#1e293b',
                                        fontWeight: 800,
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
                                      className="pos-raised w-8 h-8 rounded-full flex items-center justify-center text-(--pos-s-fg)"
                                      aria-label={t('common.actions.increase')}
                                    >
                                      <Plus className="w-4 h-4" strokeWidth={3} aria-hidden="true" />
                                    </button>
                                  </div>
                                ) : isSelected && isWithout ? (
                                  /* X button to remove "without" selection */
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      handleIngredientToggle(ingredient, false);
                                    }}
                                    className="absolute top-1/2 right-2 -translate-y-1/2 w-8 h-8 rounded-full bg-(--pos-s-surface-2) active:bg-red-700 flex items-center justify-center transition-all"
                                    aria-label={t('common.actions.remove')}
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
                                    className="absolute top-1/2 right-2 -translate-y-1/2 w-8 h-8 rounded-full flex items-center justify-center touch-feedback active:opacity-70"
                                    style={{ color: hexToVividRgba(color, 1) }}
                                    aria-label={t('common.actions.add')}
                                  >
                                    <Plus className="w-5 h-5" strokeWidth={3} aria-hidden="true" />
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

        {/* Notes overlay */}
        {showNotesOverlay && renderModalPortal(
          <div className="fixed inset-0 z-20050 flex items-center justify-center bg-slate-950/45 backdrop-blur-sm p-4">
            <div className="liquid-glass-modal-inset rounded-3xl p-5 mx-6 max-w-md w-full shadow-2xl backdrop-blur-2xl">
              <h3 className="text-sm font-semibold liquid-glass-modal-text mb-3">
                {t('menu.itemModal.specialInstructions')}
              </h3>
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                onClick={(e) => e.stopPropagation()}
                onFocus={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                  // Escape closes ONLY the notes overlay. The textarea otherwise swallows
                  // key events (stopPropagation, below) so Escape never reaches the parent;
                  // handle it here and stop it so the item-customization / order-entry
                  // modals behind the overlay stay open.
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    e.stopPropagation();
                    setShowNotesOverlay(false);
                    return;
                  }
                  e.stopPropagation();
                }}
                onKeyUp={(e) => e.stopPropagation()}
                onKeyPress={(e) => e.stopPropagation()}
                className="liquid-glass-modal-input w-full p-3 rounded-xl focus:ring-2 focus:ring-amber-400 transition-all resize-none text-sm pointer-events-auto cursor-text"
                rows={3}
                placeholder={t('menu.itemModal.specialInstructionsPlaceholder')}
                autoFocus
              />
              <div className="flex gap-2 justify-end mt-3">
                <button
                  onClick={() => setShowNotesOverlay(false)}
                  className="pos-raised pos-raised--yellow px-4 py-2 text-sm font-semibold rounded-lg bg-(--pos-s-yellow) active:bg-yellow-500 text-black transition-colors"
                >
                  {t('common.actions.done', { defaultValue: 'Done' })}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </LiquidGlassModal>
  );
};
