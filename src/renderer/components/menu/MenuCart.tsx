import React from 'react';
import { useTranslation } from 'react-i18next';
import { ShoppingCart, Trash2, AlertTriangle, Ban, Ticket, X, Loader2, Plus } from 'lucide-react';
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

export interface AppliedCoupon {
  id: string;
  code: string;
  discount_type: 'percentage' | 'fixed_amount';
  discount_value: number;
  minimum_order_amount?: number;
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
  // Coupon props
  appliedCoupon?: AppliedCoupon | null;
  onApplyCoupon?: (code: string) => void;
  onRemoveCoupon?: () => void;
  couponDiscount?: number;
  isValidatingCoupon?: boolean;
  couponError?: string | null;
  // Manual item props
  onAddManualItem?: (price: number, name?: string) => void;
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
  minimumOrderAmount = 0,
  appliedCoupon,
  onApplyCoupon,
  onRemoveCoupon,
  couponDiscount = 0,
  isValidatingCoupon = false,
  couponError,
  onAddManualItem,
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

  const [couponInput, setCouponInput] = React.useState('');
  const [showManualInput, setShowManualInput] = React.useState(false);
  const [manualPrice, setManualPrice] = React.useState('');
  const [manualName, setManualName] = React.useState('');
  const [isDiscountModalOpen, setIsDiscountModalOpen] = React.useState(false);
  const [discountDraft, setDiscountDraft] = React.useState<number>(discountPercentage || 0);
  const [discountManualInput, setDiscountManualInput] = React.useState<string>('');

  const discountPresetValues = React.useMemo(() => (
    Array.from({ length: 10 }, (_, index) => (index + 1) * 10)
  ), []);

  React.useEffect(() => {
    setDiscountDraft(discountPercentage || 0);
    setDiscountManualInput(discountPercentage ? String(discountPercentage) : '');
  }, [discountPercentage]);

  React.useEffect(() => {
    if (!isDiscountModalOpen) {
      return;
    }

    const onEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsDiscountModalOpen(false);
      }
    };

    window.addEventListener('keydown', onEscape);
    return () => {
      window.removeEventListener('keydown', onEscape);
    };
  }, [isDiscountModalOpen]);

  const parseDiscountInput = (value: string): number => {
    const normalized = value.replace(',', '.').trim();
    const parsed = Number.parseFloat(normalized);
    if (!Number.isFinite(parsed)) {
      return 0;
    }
    return Math.max(0, Math.min(parsed, 100));
  };

  const openDiscountModal = () => {
    const current = discountPercentage || 0;
    setDiscountDraft(current);
    setDiscountManualInput(current > 0 ? String(current) : '');
    setIsDiscountModalOpen(true);
  };

  const applyDraftDiscount = () => {
    if (!onDiscountChange) {
      return;
    }
    const nextValue = Math.max(0, Math.min(discountDraft, maxDiscountPercentage));
    onDiscountChange(nextValue);
    setIsDiscountModalOpen(false);
  };

  const clearDiscount = () => {
    setDiscountDraft(0);
    setDiscountManualInput('');
    onDiscountChange?.(0);
    setIsDiscountModalOpen(false);
  };

  const isDraftOverMax = discountDraft > maxDiscountPercentage;

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
  const totalAfterDiscount = subtotal - discountAmount - couponDiscount;

  // Minimum order validation for delivery orders
  const isDeliveryOrder = orderType === 'delivery';
  const isBelowMinimum = isDeliveryOrder && minimumOrderAmount > 0 && totalAfterDiscount < minimumOrderAmount;
  const shortfall = isBelowMinimum ? minimumOrderAmount - totalAfterDiscount : 0;

  return (
    <div
      className={`flex flex-col h-full w-full border-l ${
        resolvedTheme === 'dark' ? 'bg-gray-900 border-gray-700' : 'bg-gray-50 border-gray-200'
      }`}
    >
      {/* Header - flex-shrink-0 keeps it fixed size */}
      <div className={`flex-shrink-0 border-b ${resolvedTheme === 'dark' ? 'border-gray-700' : 'border-gray-200'}`}>
        <div className="flex items-center justify-between p-4">
          <h3 className={`text-lg font-semibold ${
            resolvedTheme === 'dark' ? 'text-white' : 'text-gray-900'
          }`}>
            {t('menu.cart.header', { count: uniqueCartItems.length })}
          </h3>
          {onAddManualItem && !editMode && (
            <button
              onClick={() => setShowManualInput((prev) => !prev)}
              className={`p-1.5 rounded-lg transition-colors ${
                showManualInput
                  ? resolvedTheme === 'dark'
                    ? 'bg-blue-600 text-white'
                    : 'bg-blue-500 text-white'
                  : resolvedTheme === 'dark'
                    ? 'hover:bg-gray-700 text-gray-400'
                    : 'hover:bg-gray-200 text-gray-500'
              }`}
              title={t('menu.cart.addManualItem', 'Manual Item')}
            >
              <Plus className="w-4 h-4" />
            </button>
          )}
        </div>
        {/* Manual item inline form */}
        {showManualInput && onAddManualItem && (
          <div className={`px-4 pb-3 space-y-2`}>
            <div className="flex gap-2">
              <input
                type="text"
                value={manualName}
                onChange={(e) => setManualName(e.target.value)}
                placeholder={t('menu.cart.manualNamePlaceholder', 'Item name (optional)')}
                className={`flex-1 px-2.5 py-1.5 text-sm border rounded-lg antialiased ${
                  resolvedTheme === 'dark'
                    ? 'bg-gray-700 border-gray-600 text-white placeholder-gray-500'
                    : 'bg-white border-gray-300 text-gray-900 placeholder-gray-400'
                } focus:outline-none focus:ring-2 focus:ring-blue-500`}
              />
            </div>
            <div className="flex gap-2">
              <input
                type="number"
                value={manualPrice}
                onChange={(e) => setManualPrice(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    const price = parseFloat(manualPrice);
                    if (price > 0) {
                      onAddManualItem(price, manualName.trim() || undefined);
                      setManualPrice('');
                      setManualName('');
                      setShowManualInput(false);
                    }
                  }
                }}
                min="0.01"
                step="0.01"
                placeholder={t('menu.cart.manualPricePlaceholder', 'Price')}
                className={`flex-1 px-2.5 py-1.5 text-sm border rounded-lg antialiased ${
                  resolvedTheme === 'dark'
                    ? 'bg-gray-700 border-gray-600 text-white placeholder-gray-500'
                    : 'bg-white border-gray-300 text-gray-900 placeholder-gray-400'
                } focus:outline-none focus:ring-2 focus:ring-blue-500`}
                autoFocus
              />
              <button
                onClick={() => {
                  const price = parseFloat(manualPrice);
                  if (price > 0) {
                    onAddManualItem(price, manualName.trim() || undefined);
                    setManualPrice('');
                    setManualName('');
                    setShowManualInput(false);
                  }
                }}
                disabled={!manualPrice || parseFloat(manualPrice) <= 0}
                className={`px-3 py-1.5 text-sm font-medium rounded-lg transition-colors ${
                  !manualPrice || parseFloat(manualPrice) <= 0
                    ? 'bg-gray-400 text-gray-500 cursor-not-allowed'
                    : resolvedTheme === 'dark'
                      ? 'bg-blue-600 text-white hover:bg-blue-700'
                      : 'bg-blue-500 text-white hover:bg-blue-600'
                }`}
              >
                {t('common.add', 'Add')}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Scrollable Cart Items - flex-1 + min-h-0 allows proper scrolling */}
      <div className="flex-1 min-h-0 overflow-y-auto p-2 sm:p-4 touch-scroll scrollbar-hide">
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
                                <span className="inline-flex items-center gap-1">
                                  <Ban className="w-3 h-3" aria-hidden="true" />
                                  {t('menu.cart.without', { defaultValue: 'Without' })}:
                                </span>
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

      {/* Cart Footer - flex-shrink-0 keeps it fixed at bottom */}
      <div
        className={`flex-shrink-0 p-4 border-t space-y-3 ${
          resolvedTheme === 'dark' ? 'border-gray-700 bg-gray-900' : 'border-gray-200 bg-gray-50'
        }`}
      >
        {/* Coupon Input */}
        {onApplyCoupon && !editMode && (
          <div className="space-y-2">
            {appliedCoupon ? (
              /* Applied coupon badge */
              <div className={`flex items-center justify-between rounded-lg px-3 py-2 ${
                resolvedTheme === 'dark'
                  ? 'bg-emerald-500/20 border border-emerald-500/30'
                  : 'bg-emerald-50 border border-emerald-200'
              }`}>
                <div className="flex items-center gap-2">
                  <Ticket className={`w-4 h-4 ${resolvedTheme === 'dark' ? 'text-emerald-400' : 'text-emerald-600'}`} />
                  <div>
                    <span className={`text-sm font-semibold antialiased ${
                      resolvedTheme === 'dark' ? 'text-emerald-400' : 'text-emerald-700'
                    }`}>
                      {appliedCoupon.code}
                    </span>
                    <span className={`text-xs ml-2 antialiased ${
                      resolvedTheme === 'dark' ? 'text-emerald-300/70' : 'text-emerald-600/70'
                    }`}>
                      {appliedCoupon.discount_type === 'percentage'
                        ? `${appliedCoupon.discount_value}%`
                        : formatCurrency(appliedCoupon.discount_value)
                      } {t('menu.cart.couponOff', 'off')}
                    </span>
                  </div>
                </div>
                {onRemoveCoupon && (
                  <button
                    onClick={onRemoveCoupon}
                    className={`p-1 rounded-full transition-colors ${
                      resolvedTheme === 'dark' ? 'hover:bg-emerald-500/30 text-emerald-400' : 'hover:bg-emerald-100 text-emerald-600'
                    }`}
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            ) : (
              /* Coupon input field */
              <div className="space-y-1">
                <div className="flex gap-2">
                  <div className="relative flex-1">
                    <Ticket className={`absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 ${
                      resolvedTheme === 'dark' ? 'text-gray-500' : 'text-gray-400'
                    }`} />
                    <input
                      type="text"
                      value={couponInput}
                      onChange={(e) => setCouponInput(e.target.value.toUpperCase())}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && couponInput.trim()) {
                          onApplyCoupon(couponInput.trim());
                        }
                      }}
                      placeholder={t('menu.cart.couponPlaceholder', 'Coupon code')}
                      className={`w-full pl-9 pr-3 py-1.5 text-sm border rounded-lg antialiased ${
                        resolvedTheme === 'dark'
                          ? 'bg-gray-700 border-gray-600 text-white placeholder-gray-500'
                          : 'bg-white border-gray-300 text-gray-900 placeholder-gray-400'
                      } focus:outline-none focus:ring-2 focus:ring-blue-500`}
                    />
                  </div>
                  <button
                    onClick={() => {
                      if (couponInput.trim()) {
                        onApplyCoupon(couponInput.trim());
                      }
                    }}
                    disabled={!couponInput.trim() || isValidatingCoupon}
                    className={`px-3 py-1.5 text-sm font-medium rounded-lg transition-colors ${
                      !couponInput.trim() || isValidatingCoupon
                        ? 'bg-gray-400 text-gray-500 cursor-not-allowed'
                        : resolvedTheme === 'dark'
                          ? 'bg-blue-600 text-white hover:bg-blue-700'
                          : 'bg-blue-500 text-white hover:bg-blue-600'
                    }`}
                  >
                    {isValidatingCoupon ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      t('menu.cart.applyCoupon', 'Apply')
                    )}
                  </button>
                </div>
                {couponError && (
                  <p className="text-xs text-red-500 font-medium antialiased">{couponError}</p>
                )}
              </div>
            )}
          </div>
        )}

        {/* Discount Input */}
        {onDiscountChange && (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className={`text-sm font-semibold antialiased ${
                resolvedTheme === 'dark' ? 'text-gray-300' : 'text-gray-700'
              }`}>
                {t('menu.cart.discountLabel')}
              </label>
              <button
                type="button"
                onClick={openDiscountModal}
                className={`min-w-[88px] px-3 py-1.5 text-sm font-semibold border rounded-lg antialiased transition-colors ${
                  resolvedTheme === 'dark'
                    ? 'bg-gray-800 border-gray-600 text-white hover:bg-gray-700'
                    : 'bg-white border-gray-300 text-gray-900 hover:bg-gray-50'
                } focus:outline-none focus:ring-2 focus:ring-blue-500`}
              >
                {discountPercentage > 0 ? `${discountPercentage}%` : '0%'}
              </button>
            </div>
            <p className={`text-xs text-right font-medium antialiased ${
              resolvedTheme === 'dark' ? 'text-gray-400' : 'text-gray-500'
            }`}>
              {t('menu.cart.discountMax', { max: maxDiscountPercentage })}
            </p>
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

        {/* Coupon Discount Display */}
        {couponDiscount > 0 && appliedCoupon && (
          <div className="flex justify-between items-center text-sm font-medium antialiased">
            <span className={`flex items-center gap-1 ${
              resolvedTheme === 'dark' ? 'text-emerald-400' : 'text-emerald-600'
            }`}>
              <Ticket className="w-3.5 h-3.5" />
              {t('menu.cart.couponDiscount', 'Coupon')} ({appliedCoupon.code}):
            </span>
            <span className={`${
              resolvedTheme === 'dark' ? 'text-emerald-400' : 'text-emerald-600'
            }`}>
              -{formatCurrency(couponDiscount)}
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

      {onDiscountChange && isDiscountModalOpen && (
        <div className="fixed inset-0 z-[1200] flex items-center justify-center p-4">
          <button
            type="button"
            aria-label={t('common.close', 'Close')}
            onClick={() => setIsDiscountModalOpen(false)}
            className="absolute inset-0 bg-black/70"
          />
          <div className={`relative w-full max-w-xl rounded-2xl border shadow-2xl ${
            resolvedTheme === 'dark'
              ? 'bg-gray-900 border-gray-700'
              : 'bg-white border-gray-200'
          }`}>
            <div className={`flex items-center justify-between px-6 py-4 border-b ${
              resolvedTheme === 'dark' ? 'border-gray-700' : 'border-gray-200'
            }`}>
              <div>
                <h4 className={`text-xl font-bold antialiased ${
                  resolvedTheme === 'dark' ? 'text-white' : 'text-gray-900'
                }`}>
                  {t('menu.cart.discountPickerTitle', 'Apply Discount')}
                </h4>
                <p className={`text-sm antialiased ${
                  resolvedTheme === 'dark' ? 'text-gray-400' : 'text-gray-500'
                }`}>
                  {t('menu.cart.discountMax', { max: maxDiscountPercentage })}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setIsDiscountModalOpen(false)}
                className={`w-10 h-10 rounded-lg border flex items-center justify-center ${
                  resolvedTheme === 'dark'
                    ? 'border-gray-600 text-gray-300 hover:bg-gray-800'
                    : 'border-gray-300 text-gray-600 hover:bg-gray-100'
                }`}
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="px-6 py-5 space-y-5">
              <div>
                <p className={`text-sm font-semibold mb-3 antialiased ${
                  resolvedTheme === 'dark' ? 'text-gray-300' : 'text-gray-700'
                }`}>
                  {t('menu.cart.quickDiscounts', 'Quick discounts')}
                </p>
                <div className="grid grid-cols-5 gap-2">
                  {discountPresetValues.map((value) => {
                    const disabled = value > maxDiscountPercentage;
                    const selected = Math.abs(discountDraft - value) < 0.001;

                    return (
                      <button
                        key={value}
                        type="button"
                        disabled={disabled}
                        onClick={() => {
                          if (disabled) {
                            return;
                          }
                          setDiscountDraft(value);
                          setDiscountManualInput(String(value));
                        }}
                        className={`py-2 rounded-lg text-sm font-semibold border transition-colors ${
                          disabled
                            ? 'opacity-45 cursor-not-allowed'
                            : selected
                              ? resolvedTheme === 'dark'
                                ? 'bg-blue-600 border-blue-500 text-white'
                                : 'bg-blue-500 border-blue-400 text-white'
                              : resolvedTheme === 'dark'
                                ? 'bg-gray-800 border-gray-700 text-gray-200 hover:bg-gray-700'
                                : 'bg-gray-50 border-gray-200 text-gray-700 hover:bg-gray-100'
                        }`}
                      >
                        {value}%
                      </button>
                    );
                  })}
                </div>
              </div>

              <div>
                <label className={`text-sm font-semibold mb-2 block antialiased ${
                  resolvedTheme === 'dark' ? 'text-gray-300' : 'text-gray-700'
                }`}>
                  {t('menu.cart.manualDiscount', 'Manual discount')}
                </label>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    inputMode="decimal"
                    value={discountManualInput}
                    onChange={(e) => {
                      const rawValue = e.target.value;
                      setDiscountManualInput(rawValue);
                      setDiscountDraft(parseDiscountInput(rawValue));
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !isDraftOverMax) {
                        applyDraftDiscount();
                      }
                    }}
                    placeholder={t('menu.cart.discountLabel')}
                    className={`w-full px-4 py-3 rounded-lg text-base border ${
                      resolvedTheme === 'dark'
                        ? 'bg-gray-800 border-gray-700 text-white placeholder-gray-500'
                        : 'bg-white border-gray-300 text-gray-900 placeholder-gray-400'
                    } focus:outline-none focus:ring-2 focus:ring-blue-500`}
                  />
                  <span className={`text-base font-semibold ${
                    resolvedTheme === 'dark' ? 'text-gray-300' : 'text-gray-700'
                  }`}>%</span>
                </div>
                {isDraftOverMax && (
                  <p className="text-xs text-red-500 mt-2 font-medium antialiased">
                    {t('menu.cart.discountExceeded', { max: maxDiscountPercentage })}
                  </p>
                )}
              </div>
            </div>

            <div className={`flex items-center justify-between gap-3 px-6 py-4 border-t ${
              resolvedTheme === 'dark' ? 'border-gray-700' : 'border-gray-200'
            }`}>
              <button
                type="button"
                onClick={clearDiscount}
                className={`px-4 py-2 rounded-lg text-sm font-semibold ${
                  resolvedTheme === 'dark'
                    ? 'bg-gray-800 text-gray-200 hover:bg-gray-700'
                    : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                }`}
              >
                {t('menu.cart.removeDiscount', 'Remove discount')}
              </button>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setIsDiscountModalOpen(false)}
                  className={`px-4 py-2 rounded-lg text-sm font-semibold ${
                    resolvedTheme === 'dark'
                      ? 'bg-gray-800 text-gray-200 hover:bg-gray-700'
                      : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                  }`}
                >
                  {t('common.cancel', 'Cancel')}
                </button>
                <button
                  type="button"
                  onClick={applyDraftDiscount}
                  disabled={isDraftOverMax}
                  className={`px-5 py-2 rounded-lg text-sm font-semibold ${
                    isDraftOverMax
                      ? 'bg-gray-400 text-gray-500 cursor-not-allowed'
                      : 'bg-blue-600 text-white hover:bg-blue-700'
                  }`}
                >
                  {t('menu.cart.applyDiscount', 'Apply discount')}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
