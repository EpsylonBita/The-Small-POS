import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { LoadingSpinner } from '../common/LoadingSpinner';
import { useDiscountSettings } from '../../hooks/useDiscountSettings';

/**
 * CartSummary Component
 * 
 * Displays order summary with pricing breakdown.
 * Note: Item prices are already calculated using the shared PricingService
 * in MenuPage based on order type (Requirements 9.5, 9.6, 9.7).
 * 
 * This component handles:
 * - Subtotal calculation from pre-priced items
 * - Discount application
 * - Tax calculation
 * - Delivery fee (only for delivery orders per Requirements 9.5)
 */

interface SelectedCustomization {
  customizationId: string;
  optionId: string;
  name: string;
  price: number;
}

interface OrderItem {
  id: string;
  name: string;
  quantity: number;
  price: number;
  notes?: string;
  menuItemId?: string;
  basePrice?: number;
  customizations?: SelectedCustomization[];
  totalPrice?: number;
}

interface CustomerInfo {
  name: string;
  phone: string;
  address: string;
}

interface CartSummaryProps {
  cartItems: OrderItem[];
  orderType: 'dine-in' | 'pickup' | 'delivery';
  customerInfo: CustomerInfo;
  onEditCustomer: () => void;
  onUpdateQuantity: (itemId: string, newQuantity: number) => void;
  onRemoveItem: (itemId: string) => void;
  onPlaceOrder: () => void;
  isPlacingOrder?: boolean;
  /** Delivery fee from delivery zone (only used for delivery orders) */
  deliveryFee?: number;
}

export const CartSummary: React.FC<CartSummaryProps> = ({
  cartItems,
  orderType,
  customerInfo,
  onEditCustomer,
  onUpdateQuantity,
  onRemoveItem,
  onPlaceOrder,
  isPlacingOrder = false,
  deliveryFee: deliveryFeeProp = 0
}) => {
  const { t } = useTranslation();

  // Discount state and settings
  const [discountPercentage, setDiscountPercentage] = useState<string>('0');
  const { maxDiscountPercentage, taxRatePercentage, isLoading: isLoadingSettings } = useDiscountSettings();

  const subtotal = cartItems.reduce((sum, item) => {
    // Always use totalPrice if available (includes customizations)
    // Otherwise calculate from base price and customizations
    if (item.totalPrice) {
      return sum + (item.totalPrice * item.quantity);
    }

    // Fallback calculation including customizations
    const customizationPrice = (item.customizations || []).reduce((custSum, c) => custSum + (c.price || 0), 0);
    const itemTotal = (item.price + customizationPrice) * item.quantity;
    return sum + itemTotal;
  }, 0);

  // Calculate discount
  const discountValue = parseFloat(discountPercentage) || 0;
  const isDiscountValid = discountValue >= 0 && discountValue <= maxDiscountPercentage;
  const discountAmount = isDiscountValid ? subtotal * (discountValue / 100) : 0;
  const subtotalAfterDiscount = subtotal - discountAmount;

  // Use tax rate from settings (converted from percentage to decimal)
  const tax = subtotalAfterDiscount * (taxRatePercentage / 100);
  // Use delivery fee from prop (from delivery zone) only for delivery orders
  const deliveryFee = orderType === 'delivery' ? deliveryFeeProp : 0;
  const total = subtotalAfterDiscount + tax + deliveryFee;

  if (cartItems.length === 0) {
    return (
      <div className="bg-white rounded-lg shadow-lg p-6">
        <h2 className="text-xl font-bold text-gray-900 mb-4">{t('menu.summary.header')}</h2>
        <div className="text-center text-gray-500 py-8">
          <p>{t('menu.summary.emptyCart')}</p>
          <p className="text-sm mt-2">{t('menu.summary.emptyCartDescription')}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-lg shadow-lg p-6">
      <h2 className="text-xl font-bold text-gray-900 mb-4">{t('menu.summary.header')}</h2>

      {/* Order Type */}
      <div className="mb-4 p-3 bg-blue-50 rounded-lg">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium text-blue-700">{t('menu.summary.orderType')}</span>
          <span className="text-sm font-semibold text-blue-800">
            {t('orders.type.' + (orderType === 'dine-in' ? 'dineIn' : orderType))}
          </span>
        </div>
      </div>

      {/* Customer Info */}
      <div className="mb-6 p-3 bg-gray-50 rounded-lg">
        <div className="flex items-center justify-between mb-2">
          <h3 className="font-medium text-gray-900">{t('menu.summary.customer')}</h3>
          <button
            onClick={onEditCustomer}
            className="text-blue-600 hover:text-blue-700 text-sm font-medium"
          >
            {t('menu.summary.edit')}
          </button>
        </div>
        <div className="text-sm text-gray-700 space-y-1">
          <p><span className="font-medium">{t('menu.summary.name')}</span> {customerInfo.name || t('menu.summary.notProvided')}</p>
          <p><span className="font-medium">{t('menu.summary.phone')}</span> {customerInfo.phone || t('menu.summary.notProvided')}</p>
          {customerInfo.address && (
            <p>
              <span className="font-medium">
                {orderType === 'delivery' ? t('menu.summary.address') :
                 orderType === 'dine-in' ? t('menu.summary.table') : t('menu.summary.notes')}
              </span> {customerInfo.address}
            </p>
          )}
        </div>
      </div>

      {/* Cart Items */}
      <div className="space-y-4 mb-6">
        {cartItems.map((item) => (
          <div key={item.id} className="border-b pb-4">
            <div className="flex justify-between items-start mb-2">
              <div className="flex-1">
                <h4 className="font-medium text-gray-900">{item.name}</h4>
                {item.customizations && item.customizations.length > 0 && (
                  <div className="text-sm text-gray-600 mt-1">
                    {item.customizations.map((customization, index) => (
                      <span key={index}>
                        {customization.name}
                        {customization.price > 0 && ` (+€${customization.price.toFixed(2)})`}
                        {index < item.customizations!.length - 1 && ', '}
                      </span>
                    ))}
                  </div>
                )}
                {item.notes && (
                  <p className="text-sm text-gray-600 italic mt-1">
                    {t('menu.summary.note')} {item.notes}
                  </p>
                )}
              </div>
              <button
                onClick={() => onRemoveItem(item.id)}
                className="text-red-500 hover:text-red-700 ml-2"
              >
                ×
              </button>
            </div>
            
            <div className="flex justify-between items-center">
              <div className="flex items-center space-x-2">
                <button
                  onClick={() => onUpdateQuantity(item.id, Math.max(1, item.quantity - 1))}
                  className="w-8 h-8 rounded-full border border-gray-300 flex items-center justify-center hover:bg-gray-50"
                >
                  -
                </button>
                <span className="w-8 text-center font-medium">{item.quantity}</span>
                <button
                  onClick={() => onUpdateQuantity(item.id, item.quantity + 1)}
                  className="w-8 h-8 rounded-full border border-gray-300 flex items-center justify-center hover:bg-gray-50"
                >
                  +
                </button>
              </div>
              <span className="font-semibold text-gray-900">
                €{(item.totalPrice || item.price * item.quantity).toFixed(2)}
              </span>
            </div>
          </div>
        ))}
      </div>

      {/* Order Totals */}
      <div className="space-y-2 mb-6">
        <div className="flex justify-between text-sm">
          <span className="text-gray-600">{t('menu.cart.subtotal')}</span>
          <span className="text-gray-900">€{subtotal.toFixed(2)}</span>
        </div>

        {/* Discount Input */}
        <div className="border-t border-b py-2 my-2">
          <div className="flex items-center justify-between mb-2">
            <label htmlFor="discount-input" className="text-sm font-medium text-gray-700">
              {t('menu.cart.discountLabel')}
            </label>
            <div className="flex items-center gap-2">
              <input
                id="discount-input"
                type="number"
                min="0"
                max={maxDiscountPercentage}
                step="0.1"
                value={discountPercentage}
                onChange={(e) => setDiscountPercentage(e.target.value)}
                disabled={isLoadingSettings}
                className={`w-20 px-2 py-1 text-sm border rounded ${
                  !isDiscountValid && discountValue > 0
                    ? 'border-red-500 bg-red-50'
                    : 'border-gray-300'
                } focus:outline-none focus:ring-2 focus:ring-blue-500`}
                placeholder={t('forms.placeholders.zero')}
              />
              <span className="text-xs text-gray-500">
                {t('menu.summary.discountMax', { max: maxDiscountPercentage })}
              </span>
            </div>
          </div>
          {!isDiscountValid && discountValue > 0 && (
            <p className="text-xs text-red-600 text-right">
              {t('menu.cart.discountExceeded', { max: maxDiscountPercentage })}
            </p>
          )}
          {discountAmount > 0 && isDiscountValid && (
            <div className="flex justify-between text-sm text-green-600">
              <span>{t('menu.cart.discount', { percent: discountValue })}</span>
              <span>-€{discountAmount.toFixed(2)}</span>
            </div>
          )}
        </div>

        <div className="flex justify-between text-sm">
          <span className="text-gray-600">{t('menu.cart.tax', { percent: taxRatePercentage })}</span>
          <span className="text-gray-900">€{tax.toFixed(2)}</span>
        </div>
        {deliveryFee > 0 && (
          <div className="flex justify-between text-sm">
            <span className="text-gray-600">{t('menu.cart.deliveryFee')}</span>
            <span className="text-gray-900">€{deliveryFee.toFixed(2)}</span>
          </div>
        )}
        <div className="border-t pt-2">
          <div className="flex justify-between text-lg font-bold">
            <span className="text-gray-900">{t('menu.cart.total')}</span>
            <span className="text-gray-900">€{total.toFixed(2)}</span>
          </div>
        </div>
      </div>

      {/* Place Order Button */}
      <button
        onClick={onPlaceOrder}
        disabled={
          isPlacingOrder ||
          !customerInfo.name ||
          !customerInfo.phone ||
          (orderType === 'delivery' && !customerInfo.address) ||
          !isDiscountValid
        }
        className="w-full bg-green-600 text-white py-3 px-4 rounded-lg font-semibold hover:bg-green-700 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2"
      >
        {isPlacingOrder && <LoadingSpinner size="small" />}
        {t(isPlacingOrder ? 'menu.summary.placingOrder' : 'menu.summary.placeOrder')}
      </button>

      {(!customerInfo.name || !customerInfo.phone || (orderType === 'delivery' && !customerInfo.address)) && (
        <p className="text-sm text-red-600 mt-2 text-center">
          {t('menu.summary.customerInfoRequired')}
        </p>
      )}
      {!isDiscountValid && discountValue > 0 && (
        <p className="text-sm text-red-600 mt-2 text-center">
          {t('menu.summary.discountInvalid', { max: maxDiscountPercentage })}
        </p>
      )}
    </div>
  );
};