import React, { useState, useEffect } from 'react';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { MenuCategoryTabs } from '../menu/MenuCategoryTabs';
import { MenuItemGrid } from '../menu/MenuItemGrid';
import { MenuCart } from '../menu/MenuCart';
import { MenuItemModal } from '../menu/MenuItemModal';
import { PaymentModal } from './PaymentModal';
import { useDiscountSettings } from '../../hooks/useDiscountSettings';
import { LiquidGlassModal } from '../ui/pos-glass-components';
import toast from 'react-hot-toast';
import { menuService } from '../../services/MenuService';
import type { DeliveryBoundaryValidationResponse } from '../../../shared/types/delivery-validation';

interface MenuModalProps {
  isOpen: boolean;
  onClose: () => void;
  selectedCustomer?: any;
  selectedAddress?: any;
  orderType?: 'pickup' | 'delivery';
  isProcessingOrder?: boolean;
  deliveryZoneInfo?: DeliveryBoundaryValidationResponse | null;
  onOrderComplete?: (orderData: {
    items: any[];
    total: number;
    customer?: any;
    address?: any;
    orderType?: string;
    notes?: string;
    paymentData?: any;
    discountPercentage?: number;
    discountAmount?: number;
  }) => void;
}

export const MenuModal: React.FC<MenuModalProps> = ({
  isOpen,
  onClose,
  selectedCustomer,
  selectedAddress,
  orderType = 'delivery',
  isProcessingOrder = false,
  deliveryZoneInfo,
  onOrderComplete
}) => {


  const { t } = useTranslation();
  const { maxDiscountPercentage } = useDiscountSettings();
  const [selectedCategory, setSelectedCategory] = useState<string>("all");
  const [selectedSubcategory, setSelectedSubcategory] = useState<string>("");
  const [selectedMenuItem, setSelectedMenuItem] = useState<any>(null);
  const [cartItems, setCartItems] = useState<any[]>([]);
  const [showPaymentModal, setShowPaymentModal] = useState(false);
  const [discountPercentage, setDiscountPercentage] = useState<number>(0);
  const [categories, setCategories] = useState<Array<{id: string, name: string, icon?: string}>>([]);

  // Load categories on mount
  useEffect(() => {
    const loadCategories = async () => {
      try {
        const categoriesData = await menuService.getMenuCategories();

        // Helper to get category icon
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

        // Default categories
        const defaultCategories = [
          { id: "all", name: t('modals.menu.allItems'), icon: "🍽️" },
          { id: "featured", name: t('modals.menu.featured'), icon: "⭐" }
        ];

        // Combine default categories with database categories
        const categoryObjects = [
          ...defaultCategories,
          ...categoriesData.map((cat: any) => ({
            id: cat.id,
            name: cat.name || cat.name_en || 'Unknown',
            icon: getCategoryIcon(cat.name || cat.name_en || 'unknown')
          }))
        ];

        // Deduplicate categories by ID to prevent React key warnings
        const uniqueCategories = categoryObjects.reduce((acc, cat) => {
          if (!acc.find(c => c.id === cat.id)) {
            acc.push(cat);
          }
          return acc;
        }, [] as Array<{ id: string; name: string; icon: string }>);

        setCategories(uniqueCategories);
      } catch (error) {
        console.error('Error loading categories in MenuModal:', error);
        // Fallback to default categories
        setCategories([
          { id: "all", name: t('modals.menu.allItems'), icon: "🍽️" },
          { id: "featured", name: t('modals.menu.featured'), icon: "⭐" }
        ]);
      }
    };

    if (isOpen) {
      loadCategories();
    }
  }, [isOpen]);

  const handleAddToCart = (item: any, quantity: number, customizations: any[], notes: string) => {
    // Ensure item has required properties
    // Use order-type-specific price: delivery_price for delivery, pickup_price for pickup
    const basePrice = orderType === 'pickup'
      ? (item.pickup_price ?? item.price ?? 0)
      : (item.delivery_price ?? item.price ?? 0);
    const itemQuantity = quantity || 1;

    // Calculate customization price per item
    // customizations is an array of SelectedIngredient objects: { ingredient: Ingredient, quantity: number }
    const customizationPrice = customizations.reduce((sum, c) => {
      // Get the ingredient price based on order type
      const ingredientPrice = orderType === 'pickup'
        ? (c.ingredient?.pickup_price ?? c.ingredient?.price ?? 0)
        : (c.ingredient?.delivery_price ?? c.ingredient?.price ?? 0);

      return sum + (ingredientPrice * c.quantity);
    }, 0);
    const pricePerItem = basePrice + customizationPrice;

    // Generate truly unique ID using timestamp, random number, and counter
    const uniqueId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}-${Math.random().toString(36).substr(2, 9)}`;

    // totalPrice should be the TOTAL price for this cart item (including quantity)
    const totalPriceWithQuantity = pricePerItem * itemQuantity;

    const cartItem = {
      // Spread item properties first (but we'll override id)
      ...item,
      // Then override with cart-specific properties
      id: uniqueId, // Truly unique ID for cart item (overrides item.id)
      menuItemId: item.id, // Store original menu item ID for editing
      name: item.name || 'Unknown Item',
      price: pricePerItem, // Price per unit (base + customizations) - used for display
      quantity: itemQuantity,
      customizations,
      notes,
      totalPrice: totalPriceWithQuantity, // TOTAL price = (base + customizations) * quantity
      basePrice: basePrice, // Store base price separately (without customizations)
      unitPrice: pricePerItem, // Store unit price (base + customizations, without quantity)
    };
    setCartItems(prev => [...prev, cartItem]);
  };

  const handleCheckout = async () => {
    if (cartItems.length === 0) {
      return;
    }

    // Show payment modal instead of immediately completing order
    setShowPaymentModal(true);
  };

  const handleEditCartItem = async (item: any) => {
    try {
      // Fetch the menu item from the database
      const menuItem = await menuService.getMenuItemById(item.menuItemId || item.id);
      if (menuItem) {
        // Remove the item from cart
        setCartItems(prev => prev.filter(ci => ci.id !== item.id));
        // Open the menu item modal for re-customization
        setSelectedMenuItem(menuItem);
      } else {
        toast.error(t('modals.menu.itemNotFound'));
      }
    } catch (error) {
      console.error('Error loading menu item for edit:', error);
      toast.error(t('modals.menu.errorLoadingItem'));
    }
  };

  const handleRemoveCartItem = (itemId: string | number) => {
    setCartItems(prev => prev.filter(item => item.id !== itemId));
    toast.success(t('modals.menu.itemRemoved'));
  };

  const handlePaymentComplete = async (paymentData: any) => {
    const subtotal = cartItems.reduce((sum, item) => sum + (item.totalPrice || 0), 0);
    const discountAmount = subtotal * (discountPercentage / 100);
    const totalAfterDiscount = subtotal - discountAmount;

    // Log address state for debugging
    console.log('[MenuModal.handlePaymentComplete] selectedAddress:', selectedAddress);
    console.log('[MenuModal.handlePaymentComplete] orderType:', orderType);
    console.log('[MenuModal.handlePaymentComplete] selectedCustomer:', selectedCustomer);

    // Note: Address validation is NOT enforced here because:
    // 1. OrderDashboard has comprehensive multi-source address resolution with database fallback
    // 2. The customer may have an address in the database (customers.address or customer_addresses table)
    //    that isn't passed to MenuModal but will be resolved by OrderDashboard
    // 3. Blocking here would prevent legitimate orders where address is in the database
    // OrderDashboard.handleOrderComplete will validate and show error if address truly cannot be resolved

    try {
      if (onOrderComplete) {
        await onOrderComplete({
          items: cartItems,
          total: totalAfterDiscount,
          customer: selectedCustomer,
          address: selectedAddress || null, // Explicitly pass null if undefined
          orderType,
          notes: '', // Could be enhanced to collect order notes
          paymentData,
          discountPercentage,
          discountAmount
        });
      }

      // Show success feedback
      setTimeout(() => {
        toast.success(t('modals.menu.orderSuccess'));
      }, 100);

      // Reset state
      setCartItems([]);
      setSelectedCategory("all");
      setSelectedSubcategory("");
      setDiscountPercentage(0);
      setShowPaymentModal(false);
      onClose();
    } catch (error) {
      console.error('Error completing order:', error);
      toast.error(t('modals.menu.orderFailed'));
      setShowPaymentModal(false);
    }
  };

  return (
    <>
      <LiquidGlassModal
        isOpen={isOpen}
        onClose={onClose}
        title={t('modals.menu.title') + ' - ' + (orderType === 'delivery' ? t('modals.menu.delivery') : t('modals.menu.pickup')) + ' ' + t('modals.menu.order')}
        size="full"
        closeOnBackdrop={false}
        closeOnEscape={true}
      >
        {/* Customer/Address Info Section */}
        {(selectedCustomer || selectedAddress) && (
          <div className="liquid-glass-modal-card p-4 mb-4">
            {selectedCustomer && (
              <p className="liquid-glass-modal-text text-sm">
                {t('modals.menu.customerLabel', { name: selectedCustomer.name, phone: selectedCustomer.phone_number })}
              </p>
            )}
            {selectedAddress && orderType === 'delivery' && (
              <>
                <p className="liquid-glass-modal-text-muted text-xs mt-1">
                  {t('modals.menu.deliveryTo', { address: `${selectedAddress.street_address || selectedAddress.street}, ${selectedAddress.postal_code || selectedAddress.city}` })}
                </p>
                {deliveryZoneInfo?.zone && (
                  <div className="flex items-center gap-3 mt-2 text-xs liquid-glass-modal-text">
                    <span className="inline-flex items-center px-2 py-1 rounded-md bg-blue-500/20 text-blue-400 font-medium">
                      {t('modals.menu.zone')}: {deliveryZoneInfo.zone.name}
                    </span>
                    <span className="inline-flex items-center">
                      {t('modals.menu.fee')}: €{deliveryZoneInfo.zone.deliveryFee.toFixed(2)}
                    </span>
                    {deliveryZoneInfo.zone.estimatedTime && (
                      <span className="inline-flex items-center">
                        {t('modals.menu.eta')}: {deliveryZoneInfo.zone.estimatedTime.min}-{deliveryZoneInfo.zone.estimatedTime.max} min
                      </span>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        )}

        <div className="flex flex-col sm:flex-row h-full overflow-hidden">
          {/* Left Panel - Menu */}
          <div className="flex-1 flex flex-col min-w-0 min-h-0">
            <MenuCategoryTabs
              selectedCategory={selectedCategory}
              onCategoryChange={setSelectedCategory}
              selectedSubcategory={selectedSubcategory}
              onSubcategoryChange={setSelectedSubcategory}
              hideAllItemsButton={true}
              categories={categories}
            />
            <MenuItemGrid
              selectedCategory={selectedCategory}
              selectedSubcategory={selectedSubcategory}
              orderType={orderType}
              onItemSelect={setSelectedMenuItem}
            />
          </div>

          {/* Right Panel - Cart - Fixed at bottom on mobile, sidebar on desktop */}
          <div className="flex-shrink-0 h-auto sm:h-full max-h-[40vh] sm:max-h-full overflow-hidden">
            <MenuCart
              cartItems={cartItems}
              onCheckout={handleCheckout}
              onUpdateCart={setCartItems}
              onEditItem={handleEditCartItem}
              onRemoveItem={handleRemoveCartItem}
              discountPercentage={discountPercentage}
              maxDiscountPercentage={maxDiscountPercentage}
              onDiscountChange={setDiscountPercentage}
            />
          </div>
        </div>
      </LiquidGlassModal>

      {/* Menu Item Customization Modal */}
      {isOpen && selectedMenuItem && (
        <MenuItemModal
          isOpen={!!selectedMenuItem}
          menuItem={selectedMenuItem}
          orderType={orderType}
          onClose={() => setSelectedMenuItem(null)}
          onAddToCart={handleAddToCart}
          isCustomizable={selectedMenuItem.is_customizable || false}
        />
      )}

      {/* Payment Modal */}
      {isOpen && (
        <PaymentModal
          isOpen={showPaymentModal}
          onClose={() => setShowPaymentModal(false)}
          orderTotal={cartItems.reduce((sum, item) => sum + (item.totalPrice || 0), 0) * (1 - discountPercentage / 100)}
          discountAmount={cartItems.reduce((sum, item) => sum + (item.totalPrice || 0), 0) * (discountPercentage / 100)}
          orderType={orderType}
          minimumOrderAmount={deliveryZoneInfo?.zone?.minimumOrderAmount || 0}
          onPaymentComplete={handlePaymentComplete}
          isProcessing={isProcessingOrder}
        />
      )}

      {/* Processing Overlay */}
      {isOpen && isProcessingOrder && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-[1100]">
          <div className="rounded-2xl p-8 bg-white/90 dark:bg-gray-800/90 border liquid-glass-modal-border backdrop-blur-xl">
            <div className="flex flex-col items-center space-y-4">
              <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
              <p className="text-lg font-medium liquid-glass-modal-text">
                {t('modals.menu.processingOrder')}
              </p>
              <p className="text-sm liquid-glass-modal-text-muted">
                {t('modals.menu.pleaseWait')}
              </p>
            </div>
          </div>
        </div>
      )}
    </>
  );
};