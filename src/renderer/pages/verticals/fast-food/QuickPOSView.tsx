import React, { memo, useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../../../contexts/theme-context';
import { ShoppingCart, Phone, CreditCard, Banknote, Plus, Minus, Trash2 } from 'lucide-react';
import { useAcquiredModules } from '../../../hooks/useAcquiredModules';

/**
 * INTEGRATION ROADMAP
 * ===================
 * This view currently uses mock data for demonstration purposes.
 * 
 * Intended integration path:
 * - Menu items should be loaded from the menu store or via IPC channel 'menu:get-items'
 * - Orders should be created and managed via `useOrderStore` hook
 * - Customer lookup should integrate with the customer service via IPC 'customers:lookup'
 * - Payment processing should use the existing payment handlers in the main process
 * - "View Order" actions should navigate to the core order views using the main layout's view change handler
 * - Order type selection (dine-in/takeaway/delivery) should persist to order metadata
 * 
 * Required integrations:
 * 1. Replace MOCK_MENU_ITEMS with real menu data from Supabase/local cache
 * 2. Connect order creation to useOrderStore.createOrder()
 * 3. Integrate payment buttons with payment processing IPC handlers
 * 4. Add customer lookup functionality for loyalty/rewards
 */

// Mock data interfaces
interface QuickMenuItem {
  id: string;
  name: string;
  price: number;
  category: string;
  image_url?: string;
}

interface OrderItem extends QuickMenuItem {
  quantity: number;
}

// Mock menu items
const MOCK_MENU_ITEMS: QuickMenuItem[] = [
  { id: '1', name: 'Classic Burger', price: 8.99, category: 'Burgers' },
  { id: '2', name: 'Cheese Burger', price: 9.99, category: 'Burgers' },
  { id: '3', name: 'Double Burger', price: 12.99, category: 'Burgers' },
  { id: '4', name: 'Chicken Sandwich', price: 7.99, category: 'Sandwiches' },
  { id: '5', name: 'Fish Sandwich', price: 8.49, category: 'Sandwiches' },
  { id: '6', name: 'Small Fries', price: 2.99, category: 'Sides' },
  { id: '7', name: 'Large Fries', price: 4.49, category: 'Sides' },
  { id: '8', name: 'Onion Rings', price: 3.99, category: 'Sides' },
  { id: '9', name: 'Cola', price: 1.99, category: 'Drinks' },
  { id: '10', name: 'Lemonade', price: 2.49, category: 'Drinks' },
  { id: '11', name: 'Milkshake', price: 4.99, category: 'Drinks' },
  { id: '12', name: 'Ice Cream', price: 3.49, category: 'Desserts' },
  { id: '13', name: 'Apple Pie', price: 2.99, category: 'Desserts' },
  { id: '14', name: 'Combo Meal #1', price: 11.99, category: 'Combos' },
  { id: '15', name: 'Combo Meal #2', price: 13.99, category: 'Combos' },
];

type OrderType = 'dine_in' | 'takeaway' | 'delivery';

export const QuickPOSView: React.FC = memo(() => {
  const { t } = useTranslation();
  const { resolvedTheme } = useTheme();
  const [orderItems, setOrderItems] = useState<OrderItem[]>([]);
  const [orderType, setOrderType] = useState<OrderType>('dine_in');
  const [customerPhone, setCustomerPhone] = useState('');
  const [activeCategory, setActiveCategory] = useState<string>('all');
  
  // Check if delivery module is acquired (Requirement 10.2, 10.3)
  const { hasDeliveryModule } = useAcquiredModules();

  const categories = ['all', ...new Set(MOCK_MENU_ITEMS.map(item => item.category))];
  const filteredItems = activeCategory === 'all' 
    ? MOCK_MENU_ITEMS 
    : MOCK_MENU_ITEMS.filter(item => item.category === activeCategory);

  // Filter available order types based on acquired modules
  const availableOrderTypes = useMemo((): OrderType[] => {
    const types: OrderType[] = ['dine_in', 'takeaway'];
    if (hasDeliveryModule) {
      types.push('delivery');
    }
    return types;
  }, [hasDeliveryModule]);

  const addToOrder = (item: QuickMenuItem) => {
    setOrderItems(prev => {
      const existing = prev.find(i => i.id === item.id);
      if (existing) {
        return prev.map(i => i.id === item.id ? { ...i, quantity: i.quantity + 1 } : i);
      }
      return [...prev, { ...item, quantity: 1 }];
    });
  };

  const updateQuantity = (id: string, delta: number) => {
    setOrderItems(prev => prev
      .map(item => item.id === id ? { ...item, quantity: Math.max(0, item.quantity + delta) } : item)
      .filter(item => item.quantity > 0)
    );
  };

  const removeItem = (id: string) => {
    setOrderItems(prev => prev.filter(item => item.id !== id));
  };

  const subtotal = orderItems.reduce((sum, item) => sum + item.price * item.quantity, 0);
  const tax = subtotal * 0.1;
  const total = subtotal + tax;

  const clearOrder = () => {
    setOrderItems([]);
    setCustomerPhone('');
  };

  const isDark = resolvedTheme === 'dark';

  return (
    <div className="h-full flex gap-4 p-4">
      {/* Left Panel - Menu Items */}
      <div className="flex-1 flex flex-col">
        {/* Order Type Selector - Delivery only shown when module is acquired (Requirement 10.2, 10.3) */}
        <div className="flex gap-2 mb-4">
          {availableOrderTypes.map(type => (
            <button
              key={type}
              onClick={() => setOrderType(type)}
              className={`flex-1 py-3 px-4 rounded-xl font-medium transition-all ${
                orderType === type
                  ? 'bg-blue-600 text-white shadow-lg'
                  : isDark
                    ? 'bg-gray-800 text-gray-300 hover:bg-gray-700'
                    : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              }`}
            >
              {t(`quickPos.orderType.${type}`, { defaultValue: type.replace('_', ' ').toUpperCase() })}
            </button>
          ))}
        </div>

        {/* Category Tabs */}
        <div className="flex gap-2 mb-4 overflow-x-auto pb-2">
          {categories.map(cat => (
            <button
              key={cat}
              onClick={() => setActiveCategory(cat)}
              className={`px-4 py-2 rounded-lg whitespace-nowrap transition-all ${
                activeCategory === cat
                  ? 'bg-blue-600 text-white'
                  : isDark
                    ? 'bg-gray-800 text-gray-300 hover:bg-gray-700'
                    : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              }`}
            >
              {cat === 'all' ? t('common.all', { defaultValue: 'All' }) : cat}
            </button>
          ))}
        </div>

        {/* Menu Grid */}
        <div className="flex-1 overflow-y-auto">
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
            {filteredItems.map(item => (
              <button
                key={item.id}
                onClick={() => addToOrder(item)}
                className={`p-4 rounded-xl text-left transition-all hover:scale-105 active:scale-95 ${
                  isDark
                    ? 'bg-gray-800 hover:bg-gray-700 border border-gray-700'
                    : 'bg-white hover:bg-gray-50 border border-gray-200 shadow-sm'
                }`}
              >
                <div className={`text-sm font-medium mb-1 ${isDark ? 'text-white' : 'text-gray-900'}`}>
                  {item.name}
                </div>
                <div className="text-blue-500 font-bold">${item.price.toFixed(2)}</div>
                <div className={`text-xs mt-1 ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
                  {item.category}
                </div>
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Right Panel - Order Summary */}
      <div className={`w-80 flex flex-col rounded-2xl ${
        isDark ? 'bg-gray-800 border border-gray-700' : 'bg-white border border-gray-200 shadow-lg'
      }`}>
        {/* Header */}
        <div className={`p-4 border-b ${isDark ? 'border-gray-700' : 'border-gray-200'}`}>
          <div className="flex items-center gap-2 mb-3">
            <ShoppingCart className="w-5 h-5 text-blue-500" />
            <span className={`font-semibold ${isDark ? 'text-white' : 'text-gray-900'}`}>
              {t('quickPos.currentOrder', { defaultValue: 'Current Order' })}
            </span>
          </div>
          {/* Customer Phone */}
          <div className="relative">
            <Phone className={`absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 ${isDark ? 'text-gray-500' : 'text-gray-400'}`} />
            <input
              type="tel"
              value={customerPhone}
              onChange={(e) => setCustomerPhone(e.target.value)}
              placeholder={t('quickPos.customerPhone', { defaultValue: 'Customer Phone' })}
              className={`w-full pl-10 pr-4 py-2 rounded-lg ${
                isDark
                  ? 'bg-gray-700 text-white placeholder-gray-500 border-gray-600'
                  : 'bg-gray-50 text-gray-900 placeholder-gray-400 border-gray-200'
              } border focus:outline-none focus:ring-2 focus:ring-blue-500`}
            />
          </div>
        </div>

        {/* Order Items */}
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {orderItems.length === 0 ? (
            <div className={`text-center py-8 ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
              {t('quickPos.emptyOrder', { defaultValue: 'No items in order' })}
            </div>
          ) : (
            orderItems.map(item => (
              <div key={item.id} className={`flex items-center gap-3 p-3 rounded-lg ${
                isDark ? 'bg-gray-700/50' : 'bg-gray-50'
              }`}>
                <div className="flex-1">
                  <div className={`font-medium text-sm ${isDark ? 'text-white' : 'text-gray-900'}`}>
                    {item.name}
                  </div>
                  <div className="text-blue-500 text-sm">${(item.price * item.quantity).toFixed(2)}</div>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => updateQuantity(item.id, -1)}
                    className={`p-1 rounded ${isDark ? 'hover:bg-gray-600' : 'hover:bg-gray-200'}`}
                  >
                    <Minus className="w-4 h-4" />
                  </button>
                  <span className={`w-6 text-center ${isDark ? 'text-white' : 'text-gray-900'}`}>
                    {item.quantity}
                  </span>
                  <button
                    onClick={() => updateQuantity(item.id, 1)}
                    className={`p-1 rounded ${isDark ? 'hover:bg-gray-600' : 'hover:bg-gray-200'}`}
                  >
                    <Plus className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => removeItem(item.id)}
                    className="p-1 rounded text-red-500 hover:bg-red-500/10"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            ))
          )}
        </div>

        {/* Totals & Payment */}
        <div className={`p-4 border-t ${isDark ? 'border-gray-700' : 'border-gray-200'}`}>
          <div className="space-y-2 mb-4">
            <div className="flex justify-between text-sm">
              <span className={isDark ? 'text-gray-400' : 'text-gray-500'}>
                {t('quickPos.subtotal', { defaultValue: 'Subtotal' })}
              </span>
              <span className={isDark ? 'text-white' : 'text-gray-900'}>${subtotal.toFixed(2)}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className={isDark ? 'text-gray-400' : 'text-gray-500'}>
                {t('quickPos.tax', { defaultValue: 'Tax (10%)' })}
              </span>
              <span className={isDark ? 'text-white' : 'text-gray-900'}>${tax.toFixed(2)}</span>
            </div>
            <div className={`flex justify-between font-bold text-lg pt-2 border-t ${isDark ? 'border-gray-700' : 'border-gray-200'}`}>
              <span className={isDark ? 'text-white' : 'text-gray-900'}>
                {t('quickPos.total', { defaultValue: 'Total' })}
              </span>
              <span className="text-blue-500">${total.toFixed(2)}</span>
            </div>
          </div>

          {/* Payment Buttons */}
          <div className="grid grid-cols-2 gap-2">
            <button
              disabled={orderItems.length === 0}
              className="flex items-center justify-center gap-2 py-3 rounded-xl bg-green-600 text-white font-medium hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
            >
              <Banknote className="w-5 h-5" />
              {t('quickPos.cash', { defaultValue: 'Cash' })}
            </button>
            <button
              disabled={orderItems.length === 0}
              className="flex items-center justify-center gap-2 py-3 rounded-xl bg-blue-600 text-white font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
            >
              <CreditCard className="w-5 h-5" />
              {t('quickPos.card', { defaultValue: 'Card' })}
            </button>
          </div>

          {orderItems.length > 0 && (
            <button
              onClick={clearOrder}
              className={`w-full mt-2 py-2 rounded-lg text-sm ${
                isDark ? 'text-gray-400 hover:text-white hover:bg-gray-700' : 'text-gray-500 hover:text-gray-700 hover:bg-gray-100'
              } transition-all`}
            >
              {t('quickPos.clearOrder', { defaultValue: 'Clear Order' })}
            </button>
          )}
        </div>
      </div>
    </div>
  );
});

QuickPOSView.displayName = 'QuickPOSView';

export default QuickPOSView;
