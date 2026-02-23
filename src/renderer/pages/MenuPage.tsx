import React, { useState, useEffect, useDeferredValue, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { toast } from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import { useOrderStore } from '../hooks/useOrderStore';
import { useTheme } from '../contexts/theme-context';
import { useTerminalSettings } from '../hooks/useTerminalSettings';

// Import modular components
import { MenuGrid, MenuItemModal, CartSummary, MenuCategoryTabs } from '../components/menu';
import { CustomerInfoModal } from '../components/modals/CustomerInfoModal';
import { MenuItem, Ingredient, menuService } from '../services/MenuService';
import { MenuPageSkeleton } from '../components/skeletons';
import { ErrorDisplay } from '../components/error';
import { POSError } from '../../shared/utils/error-handler';
import { useRealTimeMenuSync } from '../hooks/useRealTimeMenuSync';
import { useFeaturedItems } from '../hooks/useFeaturedItems';
import { getMenuItemPrice, type OrderType } from '../../shared/services/PricingService';
import { Utensils } from 'lucide-react';
import { getBridge } from '../../lib';

interface SelectedIngredient {
  ingredient: Ingredient;
  quantity: number;
}

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

const MenuPage: React.FC = () => {
  const bridge = getBridge();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { t } = useTranslation();
  const { createOrder, isOperationLoading } = useOrderStore();
  const { resolvedTheme } = useTheme();
  const { getSetting } = useTerminalSettings();

  // State for menu and cart
  const [selectedCategory, setSelectedCategory] = useState<string>("all");
  const [selectedSubcategory, setSelectedSubcategory] = useState<string>("");
  const [selectedMenuItem, setSelectedMenuItem] = useState<MenuItem | null>(null);
  const [cartItems, setCartItems] = useState<OrderItem[]>([]);
  const [orderType, setOrderType] = useState<"dine-in" | "pickup" | "delivery">("pickup");
  const [branchId, setBranchId] = useState<string | null>(null);

  // State for menu data from Supabase
  const [menuItems, setMenuItems] = useState<MenuItem[]>([]);
  const [categories, setCategories] = useState<Array<{id: string, name: string, icon?: string}>>([]);
  const [isLoadingMenu, setIsLoadingMenu] = useState(true);
  const [menuError, setMenuError] = useState<POSError | null>(null);
  const [hasLoadedMenu, setHasLoadedMenu] = useState(false);
  const bootstrapSyncAttemptedRef = useRef(false);

  // Tax rate from terminal settings (percentage, e.g., 24 for 24%)
  const taxRatePercentage = getSetting<number>('tax', 'tax_rate_percentage', 24) ?? 24;

  // Delivery fee from URL params (set by delivery zone validation)
  const deliveryFeeParam = searchParams.get('deliveryFee');
  const deliveryFeeFromZone = deliveryFeeParam ? parseFloat(deliveryFeeParam) : 0;

  // Modal states
  const [showCustomerModal, setShowCustomerModal] = useState(false);
  const [customerInfo, setCustomerInfo] = useState<CustomerInfo>({
    name: '',
    phone: '',
    address: ''
  });

  // Order placement loading state
  const [isPlacingOrder, setIsPlacingOrder] = useState(false);

  useEffect(() => {
    // Set order type from URL parameter if provided
    const orderTypeParam = searchParams.get('orderType');
    if (orderTypeParam && ['dine-in', 'pickup', 'delivery'].includes(orderTypeParam)) {
      setOrderType(orderTypeParam as 'dine-in' | 'pickup' | 'delivery');
    }

    // Set customer info from URL parameters if provided
    const customerName = searchParams.get('customerName');
    const customerPhone = searchParams.get('customerPhone');
    const deliveryAddress = searchParams.get('deliveryAddress');
    const deliveryPostcode = searchParams.get('deliveryPostcode');
    const deliveryFloor = searchParams.get('deliveryFloor');
    const deliveryNotes = searchParams.get('deliveryNotes');

    if (customerName && customerPhone) {
      let fullAddress = deliveryAddress || '';
      if (deliveryPostcode) fullAddress += `, ${deliveryPostcode}`;
      if (deliveryFloor) fullAddress += `, ${t('customer.address.floor')}: ${deliveryFloor}`;
      if (deliveryNotes) fullAddress += `, ${t('customer.fields.notes')}: ${deliveryNotes}`;

      setCustomerInfo({
        name: customerName,
        phone: customerPhone,
        address: fullAddress
      });

    }
  }, [searchParams]);

  const buildCategoryObjects = (categoriesData: any[]) => {
    const getCategoryIcon = (name: string): string => {
      const iconMap: Record<string, string> = {
        'crepes': '🥞',
        'waffles': '🧇',
        'toasts': '🍞',
        'beverages': '🥤',
        'desserts': '🧁',
        'salads': '🥗',
        'my crepe': '🎨',
        'my waffle': '🎨',
        'my toast': '🎨'
      };
      return iconMap[name.toLowerCase()] || '🍽️';
    };

    const defaultCategories = [
      { id: "all", name: t('menu.categories.allItems'), icon: "🍽️" },
      { id: "featured", name: t('menu.categories.featured'), icon: "⭐" }
    ];

    return [
      ...defaultCategories,
      ...categoriesData.map((cat: any) => ({
        id: cat.id,
        name: cat.name || cat.name_en || 'Unknown',
        icon: getCategoryIcon(cat.name || cat.name_en || 'unknown')
      }))
    ];
  };

  // Load menu data from Supabase
  useEffect(() => {
    const loadMenuData = async () => {
      try {
        setIsLoadingMenu(true);
        setMenuError(null);

        // Use the singleton menuService instance

        // Load menu items
        let items = await menuService.getMenuItems();

        // Load categories as objects with {id, name, icon}
        let categoriesData = await menuService.getMenuCategories();

        if (items.length === 0 && !bootstrapSyncAttemptedRef.current) {
          bootstrapSyncAttemptedRef.current = true;
          console.warn('[MenuPage] Initial menu cache is empty, attempting bootstrap sync.');

          const bootstrapResult = await menuService.syncMenu();
          if (!bootstrapResult.success) {
            console.warn('[MenuPage] Bootstrap menu sync failed:', bootstrapResult);
            if (bootstrapResult.errorCode === 'invalid_terminal_credentials') {
              toast.error('Terminal credentials are invalid. Please reconnect this terminal.');
            }
            throw new Error(bootstrapResult.error || 'Menu bootstrap sync failed');
          }

          items = await menuService.getMenuItems();
          categoriesData = await menuService.getMenuCategories();

          if (items.length === 0) {
            console.warn('[MenuPage] Menu remains empty after bootstrap sync.', {
              version: bootstrapResult.version,
              counts: bootstrapResult.counts,
            });
          }
        }

        setMenuItems(items);
        const categoryObjects = buildCategoryObjects(categoriesData);

        setCategories(categoryObjects);

        console.log('✅ Menu data loaded successfully:', {
          itemsCount: items.length,
          categoriesCount: categoriesData.length
        });

        setHasLoadedMenu(true);

      } catch (error) {
        console.error('❌ Failed to load menu data:', error);
        // Store error as POSError
        const posError = error as POSError;
        setMenuError(posError);
        toast.error(posError.message || t('menu.messages.loadFailed'));
      } finally {
        setIsLoadingMenu(false);
      }
    };

    loadMenuData();

    // Subscribe to real-time menu updates
    try {
      const unsubscribe = menuService.subscribeToMenuUpdates(() => {
        // Avoid skeleton flash: only do a full load if initial content hasn't loaded yet
        if (!hasLoadedMenu) {
          loadMenuData();
        }
        // Otherwise, background polling will refresh caches and the grid will re-render without skeleton
      });
      return unsubscribe;
    } catch (error) {
      console.error('Error setting up real-time subscription:', error);
      // Continue without real-time updates
    }
  }, []);
  // Resolve branchId from Electron main (TerminalConfigService)
  useEffect(() => {
    bridge.terminalConfig.getBranchId()
      .then((bid: string | null) => setBranchId(bid || null))
      .catch(() => setBranchId(null));
  }, [])

  // POS real-time sync (overrides preloaded when branchId available)
  const { getEffectiveMenuItem, lastUpdate } = useRealTimeMenuSync({ branchId })

  // Dynamic featured items based on weekly sales (top 20 best sellers)
  const { topSellerIds } = useFeaturedItems(branchId);

  // Filter menu items by selected category and subcategory (UUID-based filtering)
  const filteredItems = React.useMemo(() => {
    let items = menuItems;


    // Filter by category
    if (selectedCategory === "all") {
      items = menuItems;
    } else if (selectedCategory === "featured") {
      // Dynamic: Use weekly top sellers if available (based on last 7 days of sales)
      if (topSellerIds.size > 0) {
        items = menuItems.filter((item) => topSellerIds.has(item.id));
      } else {
        // Fallback: Use static is_featured flag for new stores with no sales data
        items = menuItems.filter((item) => item.is_featured);
      }
    } else {
      items = menuItems.filter((item) => item.category_id === selectedCategory);
    }

    // Filter by subcategory (standard vs customizable)
    if (selectedSubcategory) {
      const isCustomizable = selectedSubcategory.includes('customizable');
      if (isCustomizable) {
        items = items.filter(item => item.is_customizable);
      } else {
        items = items.filter(item => !item.is_customizable);
      }
    }

    return items;
  }, [menuItems, selectedCategory, selectedSubcategory, topSellerIds]);
  // Build MenuGrid items with branch override visuals applied (price + metadata)
  // Uses shared PricingService for order-type-based pricing (Requirements 9.5, 9.6, 9.7)
  const gridItems = React.useMemo(() => {
    // Map UI order type to PricingService OrderType
    const pricingOrderType: OrderType = orderType === 'delivery' ? 'delivery' : orderType === 'dine-in' ? 'dine-in' : 'pickup';
    
    return filteredItems.map((item) => {
      const eff: any = getEffectiveMenuItem ? getEffectiveMenuItem(item as any) : (item as any)
      const hasOverride = !!eff?.hasOverride && typeof eff?.price === 'number'
      
      // Use shared PricingService for consistent price calculation with fallback logic
      const basePriceForOrder = getMenuItemPrice(item as any, pricingOrderType);
      const displayPrice: number = hasOverride ? (eff.price as number) : basePriceForOrder
      
      return {
        id: item.id,
        name: (item as any).name || t('common.unknownItem'),
        description: item.description || '',
        price: displayPrice || item.price,
        category_id: item.category_id,
        preparationTime: (item as any).preparation_time || 0,
        image: (item as any).image_url || undefined,
        is_customizable: item.is_customizable,
        hasOverride,
        originalPrice: basePriceForOrder,
      }
    })
  }, [filteredItems, orderType, getEffectiveMenuItem, t, lastUpdate])

  const handleMenuGridItemClick = React.useCallback((item: { id: string }) => {
    const originalItem = filteredItems.find(orig => orig.id === item.id);
    if (originalItem) setSelectedMenuItem(originalItem);
  }, [filteredItems]);

  // Defer heavy grid item updates for smoother typing/filtering
  const deferredGridItems = useDeferredValue(gridItems);


  // Event handlers
  // Uses shared PricingService for order-type-based pricing (Requirements 9.5, 9.6, 9.7)
  const handleAddToCart = (
    menuItem: MenuItem,
    quantity: number,
    customizations: SelectedIngredient[],
    notes: string
  ) => {
    // Map UI order type to PricingService OrderType
    const pricingOrderType: OrderType = orderType === 'delivery' ? 'delivery' : orderType === 'dine-in' ? 'dine-in' : 'pickup';
    
    // Use shared PricingService for consistent price calculation with fallback logic
    const basePrice = getMenuItemPrice(menuItem as any, pricingOrderType);
    
    // Get ingredient prices based on order type using PricingService
    const getIngPrice = (ing: any) => getMenuItemPrice(ing, pricingOrderType);

    const customizationPrice = customizations.reduce((sum, c) => sum + (getIngPrice(c.ingredient) * c.quantity), 0);
    const itemTotalPrice = basePrice + customizationPrice;

    const orderItem: OrderItem = {
      id: `${menuItem.id}-${Date.now()}`,
      name: (menuItem as any).name || (menuItem as any).name_en || t('common.unknownItem'),
      quantity: quantity,
      price: itemTotalPrice,
      notes: notes || undefined,
      menuItemId: menuItem.id,
      basePrice: basePrice,
      customizations: customizations.map((c) => ({
        customizationId: c.ingredient.id,
        optionId: c.ingredient.id,
        name: c.ingredient.name,
        price: getIngPrice(c.ingredient)
      })),
      totalPrice: itemTotalPrice,
    };

    setCartItems(prev => [...prev, orderItem]);
    toast.success(t('menu.messages.itemAddedToCart', { name: (menuItem as any).name }));
  };

  const handleUpdateQuantity = (itemId: string, newQuantity: number) => {
    if (newQuantity <= 0) {
      handleRemoveItem(itemId);
      return;
    }

    setCartItems(prev =>
      prev.map(item =>
        item.id === itemId
          ? {
              ...item,
              quantity: newQuantity,
              price: ((item.basePrice || 0) + (item.customizations || []).reduce((sum, c) => sum + c.price, 0)) * newQuantity
            }
          : item
      )
    );
  };

  const handleRemoveItem = (itemId: string) => {
    setCartItems(prev => prev.filter(item => item.id !== itemId));
    toast.success(t('menu.messages.itemRemoved'));
  };

  /**
   * Place order with order-type-specific pricing
   * Cart items already have prices calculated using shared PricingService (Requirements 9.5, 9.6, 9.7)
   * Delivery fee only applied for delivery orders
   */
  const handlePlaceOrder = async () => {
    if (cartItems.length === 0) {
      toast.error(t('menu.validation.cartEmpty'));
      return;
    }

    if (!customerInfo.name || !customerInfo.phone) {
      toast.error(t('menu.validation.customerInfoRequired'));
      setShowCustomerModal(true);
      return;
    }

    if (orderType === 'delivery' && !customerInfo.address) {
      toast.error(t('menu.validation.deliveryAddressRequired'));
      setShowCustomerModal(true);
      return;
    }

    setIsPlacingOrder(true);
    try {
      // Calculate subtotal from cart items (already priced by order type using PricingService)
      const subtotal = cartItems.reduce((sum, item) => sum + (item.totalPrice || item.price * item.quantity), 0);

      // Use configured tax rate from terminal settings (percentage, e.g., 24 for 24%)
      const taxRate = taxRatePercentage / 100; // Convert percentage to decimal
      const taxAmount = Number((subtotal * taxRate).toFixed(2));

      // Delivery fee from delivery zone (only for delivery orders)
      const deliveryFee = orderType === 'delivery' ? deliveryFeeFromZone : 0;

      // Final total = subtotal + tax + delivery fee
      const finalTotal = Number((subtotal + taxAmount + deliveryFee).toFixed(2));

      const orderData = {
        items: cartItems.map(item => ({
          id: item.id,
          menu_item_id: item.menuItemId,
          name: item.name,
          quantity: item.quantity,
          price: item.totalPrice || item.price,
          unit_price: item.basePrice || item.price,
          notes: item.notes,
          customizations: item.customizations || []
        })),
        // Pass all financial fields explicitly so backend doesn't need to derive them
        total_amount: finalTotal,
        subtotal: subtotal,
        tax_amount: taxAmount,
        tax_rate: taxRatePercentage, // Store the tax rate used (percentage)
        delivery_fee: deliveryFee,
        status: 'pending' as const,
        order_type: orderType,
        customer_name: customerInfo.name,
        customer_phone: customerInfo.phone,
        delivery_address: orderType === 'delivery' ? customerInfo.address : undefined,
        table_number: orderType === 'dine-in' ? customerInfo.address : undefined,
        special_instructions: orderType === 'pickup' ? customerInfo.address : undefined,
      };

      const result = await createOrder(orderData);

      if (result.success) {
        toast.success(t('orders.messages.orderPlacedSuccess'));
        navigate('/orders');
      } else {
        // Error already shown by createOrder
        console.error('Order creation failed:', result.error);
      }
    } catch (error) {
      console.error('Failed to create order:', error);
      toast.error(t('orders.messages.orderPlacedError'));
    } finally {
      setIsPlacingOrder(false);
    }
  };

  const handleSyncMenu = async () => {
    try {
      if (!hasLoadedMenu) setIsLoadingMenu(true);
      toast.loading(t('menu.sync.syncing'), { id: 'sync-menu' });

      const syncResult = await menuService.syncMenu();
      if (!syncResult.success) {
        if (syncResult.errorCode === 'invalid_terminal_credentials') {
          toast.error('Terminal credentials are invalid. Please reconnect this terminal.', { id: 'sync-menu' });
          return;
        }
        throw new Error(syncResult.error || 'Menu sync failed');
      }

      const items = await menuService.getMenuItems();
      const categoriesData = await menuService.getMenuCategories();
      setMenuItems(items);
      setCategories(buildCategoryObjects(categoriesData));

      if (items.length === 0) {
        console.warn('[MenuPage] Menu is still empty after manual sync.', {
          version: syncResult.version,
          counts: syncResult.counts,
        });
      }

      toast.success(t('menu.sync.syncSuccess'), { id: 'sync-menu' });
    } catch (error) {
      console.error('Failed to sync menu:', error);
      toast.error(t('menu.sync.syncError'), { id: 'sync-menu' });
    } finally {
      if (!hasLoadedMenu) setIsLoadingMenu(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 p-4">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="mb-6">
          <div className="flex items-center justify-between">
            <h1 className="text-2xl font-bold text-gray-900">{t('menu.title')}</h1>
            <button
              onClick={() => navigate('/orders')}
              className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
            >
              {t('orders.viewOrders')}
            </button>
          </div>

          {/* Order Type Display */}
          <div className="mt-4 flex items-center justify-between">
            <div className="flex items-center space-x-4">
              <span className="text-sm font-medium text-gray-700">{t('orders.fields.orderType')}</span>
              <span className="px-3 py-1 bg-blue-100 text-blue-800 rounded-full text-sm font-medium">
                {orderType === 'dine-in' ? t('orders.type.dineIn') : orderType === 'pickup' ? t('orders.type.pickup') : t('orders.type.delivery')}
              </span>
            </div>
            {cartItems.length > 0 && (
              <div className="text-sm text-gray-600">
                {cartItems.length === 1 ? t('menu.cart.oneItem') : t('menu.cart.multipleItems', { count: cartItems.length })}
              </div>
            )}
          </div>
        </div>

        {/* Main Content */}
        {(isLoadingMenu && !hasLoadedMenu) ? (
          <MenuPageSkeleton />
        ) : menuError ? (
          <div className="lg:col-span-2">
            <ErrorDisplay
              error={menuError}
              onRetry={handleSyncMenu}
              showDetails={process.env.NODE_ENV === 'development'}
            />
          </div>
        ) : (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Menu Items */}
          <div className="lg:col-span-2">
            {menuItems.length === 0 ? (
              <div className="flex items-center justify-center h-64">
                <div className="text-center">
                  <Utensils className="w-12 h-12 text-gray-400 mx-auto mb-4" />
                  <h3 className={`text-xl font-semibold mb-2 ${resolvedTheme === 'dark' ? 'text-white' : 'text-gray-900'}`}>
                    {t('menu.emptyState.title')}
                  </h3>
                  <p className={`text-lg mb-4 ${resolvedTheme === 'dark' ? 'text-gray-300' : 'text-gray-600'}`}>
                    {t('menu.emptyState.description')}
                  </p>
                  <button
                    onClick={handleSyncMenu}
                    className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
                  >
                    {t('menu.sync.syncNow')}
                  </button>
                </div>
              </div>
            ) : (
              <div className={`rounded-lg shadow-lg overflow-hidden ${
                resolvedTheme === 'dark' ? 'bg-gray-800' : 'bg-white'
              }`}>
                {/* Category Tabs */}
                <MenuCategoryTabs
                  selectedCategory={selectedCategory}
                  onCategoryChange={setSelectedCategory}
                  selectedSubcategory={selectedSubcategory}
                  onSubcategoryChange={setSelectedSubcategory}
                  categories={categories}
                />

                {/* Menu Items Grid */}
                <MenuGrid
                  items={deferredGridItems}
                  selectedCategory={selectedCategory}
                  categories={categories}
                  onCategoryChange={setSelectedCategory}
                  onItemClick={handleMenuGridItemClick}
                  hideAllItemsButton={true}
                  hideCategoryButtons={true}
                  orderType={orderType === 'delivery' ? 'delivery' : 'pickup'}
                />
              </div>
            )}
          </div>

          {/* Cart Summary */}
          <div className="lg:col-span-1">
            <CartSummary
              cartItems={cartItems}
              orderType={orderType}
              customerInfo={customerInfo}
              onEditCustomer={() => setShowCustomerModal(true)}
              onUpdateQuantity={handleUpdateQuantity}
              onRemoveItem={handleRemoveItem}
              onPlaceOrder={handlePlaceOrder}
              isPlacingOrder={isPlacingOrder}
              deliveryFee={deliveryFeeFromZone}
            />
          </div>
        </div>
        )}
      </div>

      {/* Modals */}
      <MenuItemModal
        isOpen={!!selectedMenuItem}
        onClose={() => setSelectedMenuItem(null)}
        menuItem={selectedMenuItem}
        orderType={orderType === 'delivery' ? 'delivery' : 'pickup'}
        onAddToCart={handleAddToCart}
      />

      <CustomerInfoModal
        isOpen={showCustomerModal}
        onClose={() => setShowCustomerModal(false)}
        onSave={(info: any) => setCustomerInfo(info)}
        initialData={customerInfo}
        orderType={orderType}
      />
    </div>
  );
};

export default MenuPage;
