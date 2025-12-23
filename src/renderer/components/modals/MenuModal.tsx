import React, { useState, useEffect, useCallback } from 'react';
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
  // Edit mode props
  editMode?: boolean;
  editOrderId?: string;
  editSupabaseId?: string;
  editOrderNumber?: string;
  initialCartItems?: any[];
  onEditComplete?: (orderData: {
    orderId: string;
    items: any[];
    total: number;
    notes?: string;
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
  onOrderComplete,
  // Edit mode props
  editMode = false,
  editOrderId,
  editSupabaseId,
  editOrderNumber,
  initialCartItems = [],
  onEditComplete
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
  const [isSavingEdit, setIsSavingEdit] = useState(false);
  const [isLoadingItems, setIsLoadingItems] = useState(false);
  
  // State for editing a cart item
  const [editingCartItem, setEditingCartItem] = useState<any>(null);
  
  // Track if we've loaded items for this edit session to prevent infinite loops
  const hasLoadedItemsRef = React.useRef(false);
  const lastEditOrderIdRef = React.useRef<string | undefined>(undefined);

  // Fetch order items from backend
  const fetchOrderItems = useCallback(async (orderId: string, supabaseId?: string): Promise<any[]> => {
    try {
      console.log('[MenuModal] fetchOrderItems - orderId:', orderId, 'supabaseId:', supabaseId);
      
      // First try to get order from local DB using local ID
      const localOrder = await window.electronAPI?.invoke('order:get-by-id', { orderId });
      console.log('[MenuModal] Local order result:', localOrder?.id, 'items:', localOrder?.items?.length);
      if (localOrder?.items && Array.isArray(localOrder.items) && localOrder.items.length > 0) {
        console.log('[MenuModal] Loaded items from local DB:', localOrder.items.length);
        return localOrder.items;
      }

      // Fallback: fetch from Supabase using supabaseId if available, otherwise use orderId
      const supabaseOrderId = supabaseId || orderId;
      console.log('[MenuModal] Fetching from Supabase with ID:', supabaseOrderId);
      const supabaseResult = await window.electronAPI?.invoke('order:fetch-items-from-supabase', { orderId: supabaseOrderId });
      console.log('[MenuModal] Supabase result:', supabaseResult);
      
      // Handle both direct array response and {success, data} response format
      const supabaseItems = Array.isArray(supabaseResult) ? supabaseResult : supabaseResult?.data;
      console.log('[MenuModal] Supabase items:', supabaseItems?.length, supabaseItems);
      
      if (supabaseItems && Array.isArray(supabaseItems) && supabaseItems.length > 0) {
        console.log('[MenuModal] Loaded items from Supabase:', supabaseItems.length);
        return supabaseItems;
      }

      return [];
    } catch (error) {
      console.error('[MenuModal] Failed to fetch items:', error);
      return [];
    }
  }, []);

  // Reset refs and cart when modal closes
  useEffect(() => {
    if (!isOpen) {
      hasLoadedItemsRef.current = false;
      lastEditOrderIdRef.current = undefined;
      // Reset cart when modal closes to ensure clean state for next open
      setCartItems([]);
    }
  }, [isOpen]);

  // Transform customizations from Supabase format to MenuCart format
  const transformCustomizations = (customizations: any): any[] => {
    if (!customizations) return [];
    
    // If already an array in the expected format, return as-is
    if (Array.isArray(customizations)) {
      // Check if it's already in the correct format
      if (customizations.length > 0 && customizations[0]?.ingredient) {
        return customizations;
      }
      // If it's an array but not in the right format, try to transform each item
      return customizations.map(c => {
        if (c?.ingredient) return c;
        // Try to create the expected format
        return {
          ingredient: {
            id: c?.id || c?.ingredient_id || '',
            name: c?.name || c?.ingredient_name || 'Unknown',
            name_en: c?.name_en || c?.name || '',
            name_el: c?.name_el || '',
          },
          quantity: c?.quantity || 1,
          isLittle: c?.isLittle || c?.is_little || false
        };
      });
    }
    
    // If it's an object (keyed by ingredient ID or index), convert to array
    if (typeof customizations === 'object') {
      return Object.values(customizations).map((c: any) => {
        if (c?.ingredient) return c;
        return {
          ingredient: {
            id: c?.id || c?.ingredient_id || '',
            name: c?.name || c?.ingredient_name || c?.ingredient?.name || 'Unknown',
            name_en: c?.name_en || c?.ingredient?.name_en || c?.name || '',
            name_el: c?.name_el || c?.ingredient?.name_el || '',
          },
          quantity: c?.quantity || 1,
          isLittle: c?.isLittle || c?.is_little || false
        };
      });
    }
    
    return [];
  };

  // Initialize cart items when in edit mode
  useEffect(() => {
    // Skip if not open or already loaded for this order
    if (!isOpen) return;
    if (editMode && hasLoadedItemsRef.current && lastEditOrderIdRef.current === editOrderId) {
      console.log('[MenuModal] Skipping load - already loaded for order:', editOrderId);
      return;
    }
    
    const loadItems = async () => {
      console.log('[MenuModal] loadItems called - editMode:', editMode, 'editOrderId:', editOrderId, 'editSupabaseId:', editSupabaseId, 'initialCartItems:', initialCartItems?.length);
      
      if (editMode) {
        // Mark as loaded to prevent re-running
        hasLoadedItemsRef.current = true;
        lastEditOrderIdRef.current = editOrderId;
        
        // If we have initialCartItems, use them
        if (initialCartItems && initialCartItems.length > 0) {
          console.log('[MenuModal] Using initialCartItems:', initialCartItems.length);
          const transformedItems = initialCartItems.map((item, index) => ({
            id: `edit-${item.id || index}-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`,
            menuItemId: item.menu_item_id || item.menuItemId || item.id,
            name: item.name || 'Unknown Item',
            price: item.unit_price || item.price || 0,
            quantity: item.quantity || 1,
            customizations: transformCustomizations(item.customizations),
            notes: item.notes || '',
            totalPrice: item.total_price || item.totalPrice || ((item.unit_price || item.price || 0) * (item.quantity || 1)),
            basePrice: item.unit_price || item.price || 0,
            unitPrice: item.unit_price || item.price || 0,
          }));
          console.log('[MenuModal] Transformed items:', transformedItems);
          setCartItems(transformedItems);
        } 
        // Otherwise fetch from backend if we have an orderId
        else if (editOrderId) {
          console.log('[MenuModal] Fetching items from backend for order:', editOrderId, 'supabaseId:', editSupabaseId);
          setIsLoadingItems(true);
          try {
            const fetchedItems = await fetchOrderItems(editOrderId, editSupabaseId);
            console.log('[MenuModal] Fetched items:', fetchedItems?.length, fetchedItems);
            if (fetchedItems.length > 0) {
              const transformedItems = fetchedItems.map((item, index) => {
                console.log('[MenuModal] Item customizations raw:', item.customizations);
                const transformedCustomizations = transformCustomizations(item.customizations);
                console.log('[MenuModal] Item customizations transformed:', transformedCustomizations);
                return {
                  id: `edit-${item.id || index}-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`,
                  menuItemId: item.menu_item_id || item.menuItemId || item.id,
                  name: item.name || 'Unknown Item',
                  price: item.unit_price || item.price || 0,
                  quantity: item.quantity || 1,
                  customizations: transformedCustomizations,
                  notes: item.notes || '',
                  totalPrice: item.total_price || item.totalPrice || ((item.unit_price || item.price || 0) * (item.quantity || 1)),
                  basePrice: item.unit_price || item.price || 0,
                  unitPrice: item.unit_price || item.price || 0,
                };
              });
              console.log('[MenuModal] Setting cart items:', transformedItems);
              setCartItems(transformedItems);
            } else {
              console.log('[MenuModal] No items fetched from backend');
            }
          } catch (error) {
            console.error('[MenuModal] Error loading items:', error);
            toast.error(t('modals.menu.loadItemsFailed') || 'Failed to load order items');
          } finally {
            setIsLoadingItems(false);
          }
        } else {
          console.log('[MenuModal] No editOrderId provided');
        }
      } else {
        // Reset cart when opening in non-edit mode (only on first open)
        if (!hasLoadedItemsRef.current) {
          hasLoadedItemsRef.current = true;
          // Don't reset cart here - let it be managed by handleAddToCart
        }
      }
    };

    loadItems();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, editMode, editOrderId, editSupabaseId]);

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
    // Only count ingredients that are NOT marked as "without"
    const customizationPrice = customizations.reduce((sum, c) => {
      // Skip "without" items - they don't add to price
      if (c.isWithout) return sum;
      
      // Get the ingredient price based on order type
      const ingredientPrice = orderType === 'pickup'
        ? (c.ingredient?.pickup_price ?? c.ingredient?.price ?? 0)
        : (c.ingredient?.delivery_price ?? c.ingredient?.price ?? 0);

      return sum + (ingredientPrice * c.quantity);
    }, 0);
    const pricePerItem = basePrice + customizationPrice;

    // Generate truly unique ID using timestamp, random number, and counter
    const uniqueId = `${Date.now()}-${Math.random().toString(36).slice(2, 11)}-${Math.random().toString(36).slice(2, 11)}`;

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

    // If we're editing an existing cart item, remove the old one first
    if (editingCartItem) {
      setCartItems(prev => [...prev.filter(ci => ci.id !== editingCartItem.id), cartItem]);
      setEditingCartItem(null);
    } else {
      setCartItems(prev => [...prev, cartItem]);
    }
  };

  const handleCheckout = async () => {
    if (cartItems.length === 0) {
      return;
    }

    // In edit mode, save changes directly without payment
    if (editMode && editOrderId && onEditComplete) {
      setIsSavingEdit(true);
      try {
        const total = cartItems.reduce((sum, item) => sum + (item.totalPrice || 0), 0);
        await onEditComplete({
          orderId: editOrderId,
          items: cartItems.map(item => ({
            id: item.menuItemId || item.id,
            menu_item_id: item.menuItemId || item.id,
            name: item.name,
            quantity: item.quantity,
            unit_price: item.unitPrice || item.price,
            total_price: item.totalPrice,
            notes: item.notes,
            customizations: item.customizations
          })),
          total,
          notes: ''
        });
        
        // Reset state
        setCartItems([]);
        setSelectedCategory("all");
        setSelectedSubcategory("");
        onClose();
      } catch (error) {
        console.error('Error saving order edit:', error);
        toast.error(t('modals.menu.editFailed') || 'Failed to save changes');
      } finally {
        setIsSavingEdit(false);
      }
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
        // Store the cart item being edited (don't remove from cart yet)
        setEditingCartItem(item);
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

  // Generate modal title based on mode
  const getModalTitle = () => {
    if (editMode && editOrderNumber) {
      return `${t('modals.menu.editOrder') || 'Edit Order'} #${editOrderNumber} - ${orderType === 'delivery' ? t('modals.menu.delivery') : t('modals.menu.pickup')}`;
    }
    return t('modals.menu.title') + ' - ' + (orderType === 'delivery' ? t('modals.menu.delivery') : t('modals.menu.pickup')) + ' ' + t('modals.menu.order');
  };

  return (
    <>
      <LiquidGlassModal
        isOpen={isOpen}
        onClose={onClose}
        title={getModalTitle()}
        size="full"
        closeOnBackdrop={false}
        closeOnEscape={true}
      >
        {/* Edit Mode Banner */}
        {editMode && (
          <div className="bg-amber-500/20 border border-amber-500/30 rounded-lg p-3 mb-4 flex items-center gap-2">
            <span className="text-amber-600 dark:text-amber-400">✏️</span>
            <span className="text-sm text-amber-700 dark:text-amber-300">
              {t('modals.menu.editModeMessage') || 'You are editing an existing order. Add, remove, or modify items as needed.'}
            </span>
          </div>
        )}

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
              onDiscountChange={editMode ? undefined : setDiscountPercentage}
              editMode={editMode}
              isSaving={isSavingEdit}
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
          onClose={() => {
            setSelectedMenuItem(null);
            setEditingCartItem(null); // Clear editing state when modal closes
          }}
          onAddToCart={handleAddToCart}
          isCustomizable={selectedMenuItem.is_customizable || false}
          initialCustomizations={editingCartItem?.customizations || []}
          initialQuantity={editingCartItem?.quantity || 1}
          initialNotes={editingCartItem?.notes || ''}
          isEditMode={!!editingCartItem}
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