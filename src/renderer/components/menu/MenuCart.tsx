import React from 'react';
import { useTranslation } from 'react-i18next';
import { ShoppingCart, Trash2, AlertTriangle } from 'lucide-react';
import { useTheme } from '../../contexts/theme-context';
import { useI18n } from '../../contexts/i18n-context';
import { formatCurrency } from '../../utils/format';

interface CartItem {
  id: string | number;
  name: string;
  quantity: number;
  price: number;
  totalPrice: number;
  categoryName?: string; // Main category (e.g., "Crepes", "Waffles")
  flavorType?: 'savory' | 'sweet' | null; // Flavor type for display
  customizations?: Array<{
    ingredient: {
      id: string;
      name: string;
      name_en?: string;
      name_el?: string;
      price?: number;
      pickup_price?: number;
      delivery_price?: number;
      category_name?: string;
    };
    quantity: number;
    isLittle?: boolean;
    isWithout?: boolean;
  }>;
  notes?: string;
}

interface MenuCartProps {
  cartItems: CartItem[];
  onCheckout: () => void;
  onUpdateCart: (items: CartItem[]) => void;
  onEditItem?: (item: CartItem) => void;
  onRemoveItem?: (itemId: string | number) => void;
  discountPercentage?: number;
  maxDiscountPercentage?: number;
  onDiscountChange?: (percentage: number) => void;
  editMode?: boolean; // When true, shows "Save Changes" instead of "Complete Order"
  isSaving?: boolean; // When true, shows loading state on save button
  orderType?: 'pickup' | 'delivery'; // Order type for minimum order validation
  minimumOrderAmount?: number; // Minimum order amount for delivery zones
}

export const MenuCart: React.FC<MenuCartProps> = ({
  cartItems,
  onCheckout,
  onUpdateCart,
  onEditItem,
  onRemoveItem,
  discountPercentage = 0,
  maxDiscountPercentage = 30,
  onDiscountChange,
  editMode = false,
  isSaving = false,
  orderType,
  minimumOrderAmount = 0
}) => {
  const { t } = useTranslation();

  // Deduplicate cart items by ID to prevent React key warnings
  // This is a safety measure in case duplicates somehow make it into the cart
  const uniqueCartItems = React.useMemo(() => {
    const seen = new Set<string | number>();
    return cartItems.filter(item => {
      if (seen.has(item.id)) {
        console.warn('Duplicate cart item detected:', item.id);
        return false;
      }
      seen.add(item.id);
      return true;
    });
  }, [cartItems]);
  const { resolvedTheme } = useTheme();
  const { language } = useI18n();

  const discountDebounceRef = React.useRef<number | null>(null);

  // Helper function to get localized ingredient name
  const getIngredientName = (ingredient: {
    id: string;
    name: string;
    name_en?: string;
    name_el?: string;
    price?: number;
    pickup_price?: number;
    delivery_price?: number;
  }): string => {
    if (language === 'el' && ingredient.name_el) {
      return ingredient.name_el;
    }
    if (language === 'en' && ingredient.name_en) {
      return ingredient.name_en;
    }
    // Fallback to name_en, then name_el, then name
    return ingredient.name_en || ingredient.name_el || ingredient.name || 'Unknown';
  };

  const getSubtotal = () => {
    return uniqueCartItems.reduce((sum, item) => sum + (item.totalPrice || 0), 0);
  };

  const subtotal = getSubtotal();
  const discountAmount = subtotal * (discountPercentage / 100);
  const totalAfterDiscount = subtotal - discountAmount;

  // Minimum order validation for delivery orders
  const isDeliveryOrder = orderType === 'delivery';
  const isBelowMinimum = isDeliveryOrder && minimumOrderAmount > 0 && totalAfterDiscount < minimumOrderAmount;
  const shortfall = isBelowMinimum ? minimumOrderAmount - totalAfterDiscount : 0;

  return (
    <div className={`w-full sm:w-72 md:w-80 border-l flex flex-col ${
      resolvedTheme === 'dark' ? 'bg-gray-900 border-gray-700' : 'bg-gray-50 border-gray-200'
    }`} style={{ height: '73vh' }}>
      <div className={`p-4 border-b ${resolvedTheme === 'dark' ? 'border-gray-700' : 'border-gray-200'}`}>
        <h3 className={`text-lg font-semibold ${
          resolvedTheme === 'dark' ? 'text-white' : 'text-gray-900'
        }`}>
          {t('menu.cart.header', { count: uniqueCartItems.length })}
        </h3>
      </div>

      <div className="flex-1 p-2 sm:p-4 overflow-y-auto touch-scroll scrollbar-hide">
        {uniqueCartItems.length === 0 ? (
          <div className="text-center py-6 sm:py-8">
            <ShoppingCart className={`w-12 h-12 sm:w-16 sm:h-16 mx-auto mb-3 sm:mb-4 ${
              resolvedTheme === 'dark' ? 'text-gray-600' : 'text-gray-400'
            }`} />
            <p className={`text-sm sm:text-base antialiased ${
              resolvedTheme === 'dark' ? 'text-gray-400' : 'text-gray-500'
            }`}>
              {t('menu.cart.empty')}
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {uniqueCartItems.map((item) => (
              <div
                key={item.id}
                className={`p-3 rounded-lg border transition-all duration-200 ${
                  resolvedTheme === 'dark'
                    ? 'bg-gray-800 border-gray-700 hover:border-blue-500 hover:bg-gray-750'
                    : 'bg-white border-gray-200 hover:border-blue-400 hover:bg-gray-50'
                } ${onEditItem ? 'cursor-pointer' : ''}`}
                onClick={() => onEditItem?.(item)}
              >
                <div className="flex justify-between items-start mb-2">
                  <div className="flex-1">
                    {/* Category label */}
                    {item.categoryName && (
                      <div className={`text-[10px] uppercase tracking-wider font-medium mb-0.5 antialiased ${
                        resolvedTheme === 'dark' ? 'text-gray-400' : 'text-gray-500'
                      }`}>
                        {item.categoryName}
                      </div>
                    )}
                    {/* Item name (subcategory) */}
                    <h4 className={`font-semibold antialiased ${
                      resolvedTheme === 'dark' ? 'text-white' : 'text-gray-900'
                    }`}>
                      {item.name}
                    </h4>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={`font-semibold antialiased ${
                      resolvedTheme === 'dark' ? 'text-emerald-400' : 'text-emerald-600'
                    }`}>
                      {formatCurrency(item.totalPrice || 0)}
                    </span>
                    {/* Delete button - positioned away from main click area */}
                    {onRemoveItem && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation(); // Prevent card click
                          onRemoveItem(item.id);
                        }}
                        className={`p-1.5 rounded-full hover:bg-red-500/20 transition-colors ml-2 ${
                          resolvedTheme === 'dark' ? 'text-red-400' : 'text-red-600'
                        }`}
                        title={t('common.actions.delete')}
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                </div>
                {/* Quantity controls */}
                <div
                  className={`flex items-center justify-between mt-2 antialiased ${
                    resolvedTheme === 'dark' ? 'text-gray-300' : 'text-gray-600'
                  }`}
                  onClick={(e) => e.stopPropagation()} // Prevent card click when using quantity controls
                >
                  <div className="flex items-center gap-2">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        if (item.quantity <= 1) {
                          onRemoveItem?.(item.id);
                        } else {
                          const updatedItems = cartItems.map(ci =>
                            ci.id === item.id ? { ...ci, quantity: ci.quantity - 1, totalPrice: (ci.totalPrice / ci.quantity) * (ci.quantity - 1) } : ci
                          );
                          onUpdateCart(updatedItems);
                        }
                      }}
                      className={`w-7 h-7 rounded-full flex items-center justify-center font-bold transition-colors ${
                        resolvedTheme === 'dark'
                          ? 'bg-gray-700 hover:bg-gray-600 text-white'
                          : 'bg-gray-200 hover:bg-gray-300 text-gray-800'
                      }`}
                    >
                      −
                    </button>
                    <span className="min-w-[24px] text-center font-semibold antialiased">{item.quantity}</span>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        const updatedItems = cartItems.map(ci =>
                          ci.id === item.id ? { ...ci, quantity: ci.quantity + 1, totalPrice: (ci.totalPrice / ci.quantity) * (ci.quantity + 1) } : ci
                        );
                        onUpdateCart(updatedItems);
                      }}
                      className={`w-7 h-7 rounded-full flex items-center justify-center font-bold transition-colors ${
                        resolvedTheme === 'dark'
                          ? 'bg-gray-700 hover:bg-gray-600 text-white'
                          : 'bg-gray-200 hover:bg-gray-300 text-gray-800'
                      }`}
                    >
                      +
                    </button>
                  </div>
                  <span className="text-sm font-medium antialiased">
                    × {formatCurrency(item.price || 0)}
                  </span>
                </div>
                {item.customizations && item.customizations.length > 0 && (
                  <div className={`mt-2 pt-2 border-t ${
                    resolvedTheme === 'dark' ? 'border-gray-700' : 'border-gray-200'
                  }`}>
                    {/* Separate "with" and "without" ingredients */}
                    {(() => {
                      const withIngredients = item.customizations.filter(c => !c.isWithout);
                      const withoutIngredients = item.customizations.filter(c => c.isWithout);

                      return (
                        <>
                          {/* Added ingredients */}
                          {withIngredients.length > 0 && (
                            <>
                              <div className={`text-xs font-semibold mb-1 antialiased ${
                                resolvedTheme === 'dark' ? 'text-gray-400' : 'text-gray-500'
                              }`}>
                                {t('menu.cart.ingredients')}:
                              </div>
                              <div className="flex flex-wrap gap-1">
                                {withIngredients.map((c, idx) => {
                                  const ingredientName = getIngredientName(c.ingredient);
                                  const quantityText = c.quantity > 1 ? ` ×${c.quantity}` : '';
                                  const littleText = c.isLittle ? ` (${t('menu.itemModal.little')})` : '';

                                  return (
                                    <span
                                      key={`${item.id}-customization-${c.ingredient.id}-${idx}`}
                                      className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium antialiased ${
                                        resolvedTheme === 'dark'
                                          ? 'bg-blue-600 text-blue-100'
                                          : 'bg-blue-100 text-blue-700'
                                      }`}
                                    >
                                      + {ingredientName}
                                      {quantityText && (
                                        <span className={`ml-1 font-bold ${
                                          resolvedTheme === 'dark' ? 'text-blue-50' : 'text-blue-800'
                                        }`}>
                                          {quantityText}
                                        </span>
                                      )}
                                      {littleText && (
                                        <span className="ml-1 opacity-80">{littleText}</span>
                                      )}
                                    </span>
                                  );
                                })}
                              </div>
                            </>
                          )}

                          {/* Without ingredients */}
                          {withoutIngredients.length > 0 && (
                            <>
                              <div className={`text-xs font-semibold mb-1 antialiased ${withIngredients.length > 0 ? 'mt-2' : ''} ${
                                resolvedTheme === 'dark' ? 'text-red-400' : 'text-red-500'
                              }`}>
                                🚫 {t('menu.cart.without') || 'Χωρίς'}:
                              </div>
                              <div className="flex flex-wrap gap-1">
                                {withoutIngredients.map((c, idx) => {
                                  const ingredientName = getIngredientName(c.ingredient);

                                  return (
                                    <span
                                      key={`${item.id}-without-${c.ingredient.id}-${idx}`}
                                      className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium antialiased ${
                                        resolvedTheme === 'dark'
                                          ? 'bg-red-600/80 text-red-100 line-through'
                                          : 'bg-red-100 text-red-700 line-through'
                                      }`}
                                    >
                                      {ingredientName}
                                    </span>
                                  );
                                })}
                              </div>
                            </>
                          )}
                        </>
                      );
                    })()}
                  </div>
                )}
                {/* Special Notes */}
                {item.notes && item.notes.trim() && (
                  <div className={`mt-2 pt-2 border-t ${
                    resolvedTheme === 'dark' ? 'border-gray-700' : 'border-gray-200'
                  }`}>
                    <div className={`text-xs font-semibold mb-1 antialiased ${
                      resolvedTheme === 'dark' ? 'text-amber-400' : 'text-amber-600'
                    }`}>
                      📝 {t('menu.cart.specialNotes') || t('menu.itemModal.specialInstructions')}:
                    </div>
                    <p className={`text-xs italic antialiased ${
                      resolvedTheme === 'dark' ? 'text-gray-300' : 'text-gray-600'
                    }`}>
                      {item.notes}
                    </p>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Cart Footer */}
      <div className={`p-4 border-t space-y-3 ${
        resolvedTheme === 'dark' ? 'border-gray-700' : 'border-gray-200'
      }`}>
        {/* Discount Input */}
        {onDiscountChange && (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className={`text-sm font-semibold antialiased ${
                resolvedTheme === 'dark' ? 'text-gray-300' : 'text-gray-700'
              }`}>
                {t('menu.cart.discountLabel')}
              </label>
              <input
                type="number"
                min="0"
                max={maxDiscountPercentage}
                step="0.1"
                value={discountPercentage || ''}
                onChange={(e) => {
                  if (!onDiscountChange) return;
                  const v = parseFloat(e.target.value) || 0;
                  if (discountDebounceRef.current) {
                    clearTimeout(discountDebounceRef.current);
                  }
                  discountDebounceRef.current = window.setTimeout(() => {
                    onDiscountChange(v);
                  }, 150);
                }}
                className={`w-20 px-2 py-1 text-sm font-medium border rounded antialiased ${
                  resolvedTheme === 'dark'
                    ? 'bg-gray-700 border-gray-600 text-white'
                    : 'bg-white border-gray-300 text-gray-900'
                } focus:outline-none focus:ring-2 focus:ring-blue-500`}
                placeholder=""
              />
            </div>
            {discountPercentage > maxDiscountPercentage && (
              <p className="text-xs text-red-500 text-right font-medium antialiased">
                {t('menu.cart.discountExceeded', { max: maxDiscountPercentage })}
              </p>
            )}
          </div>
        )}

        {/* Subtotal */}
        <div className="flex justify-between items-center text-sm font-medium antialiased">
          <span className={resolvedTheme === 'dark' ? 'text-gray-400' : 'text-gray-600'}>
            {t('menu.cart.subtotal')}
          </span>
          <span className={resolvedTheme === 'dark' ? 'text-gray-300' : 'text-gray-700'}>
            {formatCurrency(subtotal)}
          </span>
        </div>

        {/* Discount Display */}
        {discountAmount > 0 && (
          <div className="flex justify-between items-center text-sm font-medium antialiased">
            <span className={`${
              resolvedTheme === 'dark' ? 'text-green-400' : 'text-green-600'
            }`}>
              {t('menu.cart.discount', { percent: discountPercentage })}:
            </span>
            <span className={`${
              resolvedTheme === 'dark' ? 'text-green-400' : 'text-green-600'
            }`}>
              -{formatCurrency(discountAmount)}
            </span>
          </div>
        )}

        {/* Total */}
        <div className={`flex justify-between items-center pt-2 border-t antialiased ${
          resolvedTheme === 'dark' ? 'border-gray-700' : 'border-gray-200'
        }`}>
          <span className={`text-lg font-semibold ${
            resolvedTheme === 'dark' ? 'text-white' : 'text-gray-900'
          }`}>
            {t('menu.cart.total')}
          </span>
          <span className={`text-xl font-bold ${
            resolvedTheme === 'dark' ? 'text-emerald-400' : 'text-emerald-600'
          }`}>
            {formatCurrency(totalAfterDiscount)}
          </span>
        </div>

        {/* Minimum Order Warning for Delivery */}
        {isBelowMinimum && !editMode && (
          <div className={`flex items-center gap-2 p-3 rounded-lg mb-3 ${
            resolvedTheme === 'dark'
              ? 'bg-orange-500/20 border border-orange-500/30'
              : 'bg-orange-50 border border-orange-200'
          }`}>
            <AlertTriangle className={`w-5 h-5 flex-shrink-0 ${
              resolvedTheme === 'dark' ? 'text-orange-400' : 'text-orange-500'
            }`} />
            <div className="flex-1">
              <p className={`text-sm font-medium antialiased ${
                resolvedTheme === 'dark' ? 'text-orange-400' : 'text-orange-600'
              }`}>
                {t('menu.cart.minimumNotMet', 'Minimum order not met')}
              </p>
              <p className={`text-xs antialiased ${
                resolvedTheme === 'dark' ? 'text-orange-300/80' : 'text-orange-500/80'
              }`}>
                {t('menu.cart.addMoreToOrder', 'Add {{amount}} more to complete order', { amount: formatCurrency(shortfall) })}
              </p>
            </div>
          </div>
        )}

        <button
          onClick={onCheckout}
          disabled={uniqueCartItems.length === 0 || discountPercentage > maxDiscountPercentage || isSaving || (isBelowMinimum && !editMode)}
          className={`w-full py-3 rounded-xl font-semibold antialiased transition-all duration-300 ${
            uniqueCartItems.length === 0 || discountPercentage > maxDiscountPercentage || isSaving || (isBelowMinimum && !editMode)
              ? 'bg-gray-400 text-gray-500 cursor-not-allowed'
              : editMode
                ? 'bg-amber-600 text-white hover:bg-amber-700 hover:scale-[1.02]'
                : 'bg-blue-600 text-white hover:bg-blue-700 hover:scale-[1.02]'
          }`}
        >
          {isSaving ? (
            <span className="flex items-center justify-center gap-2">
              <svg className="animate-spin h-5 w-5" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
              </svg>
              {t('common.saving')}
            </span>
          ) : editMode ? (
            t('modals.menu.saveChanges') || t('common.saveChanges')
          ) : (
            t('menu.cart.completeOrder')
          )}
        </button>
      </div>
    </div>
  );
};