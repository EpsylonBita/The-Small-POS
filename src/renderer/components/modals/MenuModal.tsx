import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { MenuCategoryTabs } from '../menu/MenuCategoryTabs';
import { MenuItemGrid } from '../menu/MenuItemGrid';
import { MenuCart } from '../menu/MenuCart';
import type { AppliedCoupon } from '../menu/MenuCart';
import { MenuItemModal } from '../menu/MenuItemModal';
import { ComboChoiceModal } from '../menu/ComboChoiceModal';
import type { ChosenComboItem } from '../menu/ComboChoiceModal';
import { PaymentModal } from './PaymentModal';
import { useDiscountSettings } from '../../hooks/useDiscountSettings';
import { useDeliveryValidation } from '../../hooks/useDeliveryValidation';
import { useKdsLiveDraftSync } from '../../hooks/useKdsLiveDraftSync';
import { useShift } from '../../contexts/shift-context';
import { LiquidGlassModal } from '../ui/pos-glass-components';
import toast from 'react-hot-toast';
import { menuService } from '../../services/MenuService';
import type { DeliveryBoundaryValidationResponse } from '../../../shared/types/delivery-validation';
import type { MenuCombo } from '@shared/types/combo';
import { getComboPrice } from '@shared/types/combo';
import { Pencil, Search, X, User, UserPlus } from 'lucide-react';
import { formatCurrency } from '../../utils/format';
import { posApiPost } from '../../utils/api-helpers';
import { getBridge } from '../../../lib';
import { getCachedTerminalCredentials, refreshTerminalCredentialCache } from '../../services/terminal-credentials';

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
    manualDiscountMode?: 'percentage' | 'fixed';
    manualDiscountValue?: number;
    coupon_id?: string | null;
    coupon_code?: string | null;
    coupon_discount_amount?: number;
    total_discount_amount?: number;
    is_ghost?: boolean;
    ghost_source?: string | null;
    ghost_metadata?: Record<string, unknown> | null;
    deliveryZoneInfo?: DeliveryBoundaryValidationResponse | null;
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
  const { validateAddress: validateDeliveryAddress } = useDeliveryValidation({ debounceMs: 0 });
  const { staff } = useShift();
  const bridge = getBridge();
  const [selectedCategory, setSelectedCategory] = useState<string>("all");
  const [selectedSubcategory, setSelectedSubcategory] = useState<string>("");
  const [selectedMenuItem, setSelectedMenuItem] = useState<any>(null);
  const [cartItems, setCartItems] = useState<any[]>([]);
  const [showPaymentModal, setShowPaymentModal] = useState(false);
  const [manualDiscountMode, setManualDiscountMode] = useState<'percentage' | 'fixed'>('percentage');
  const [manualDiscountValue, setManualDiscountValue] = useState<number>(0);
  const [ghostModeFeatureEnabled, setGhostModeFeatureEnabled] = useState(false);
  const [ghostModeEnabled, setGhostModeEnabled] = useState(false);
  const [categories, setCategories] = useState<Array<{id: string, name: string, icon?: string}>>([]);
  const [isSavingEdit, setIsSavingEdit] = useState(false);
  const [isLoadingItems, setIsLoadingItems] = useState(false);
  const [menuSearchQuery, setMenuSearchQuery] = useState('');
  const menuSearchRef = useRef<HTMLInputElement>(null);

  // Capture keyboard input and redirect to search bar when typing printable characters
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      if (e.key.length !== 1) return; // only printable characters
      const active = document.activeElement;
      if (active?.tagName === 'INPUT' || active?.tagName === 'TEXTAREA') return;
      // Don't capture if ingredient modal is open (it has its own search)
      if (active?.closest('[role="dialog"]') && !active?.closest('.liquid-glass-modal-content')) return;
      menuSearchRef.current?.focus();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen]);

  // Customer popover state (for pickup orders)
  const [showCustomerPopover, setShowCustomerPopover] = useState(false);
  const [pickupCustomerName, setPickupCustomerName] = useState(selectedCustomer?.name || '');
  const [pickupCustomerPhone, setPickupCustomerPhone] = useState(selectedCustomer?.phone || selectedCustomer?.phone_number || '');
  const [pickupCustomerNotes, setPickupCustomerNotes] = useState(selectedCustomer?.notes || '');

  const hasCustomerInfo = !!(
    (selectedCustomer?.name && selectedCustomer.name.trim()) ||
    (selectedCustomer?.phone && selectedCustomer.phone.trim()) ||
    (selectedCustomer?.phone_number && selectedCustomer.phone_number.trim())
  );

  useKdsLiveDraftSync({
    enabled: !editMode,
    isOpen,
    cartItems,
    orderType,
    customerName: orderType === 'pickup'
      ? (pickupCustomerName || selectedCustomer?.name || null)
      : (selectedCustomer?.name || null),
  });

  // Combos state
  const [combos, setCombos] = useState<MenuCombo[]>([]);
  const [selectedCombo, setSelectedCombo] = useState<MenuCombo | null>(null);

  // Coupon state
  const [appliedCoupon, setAppliedCoupon] = useState<AppliedCoupon | null>(null);
  const [isValidatingCoupon, setIsValidatingCoupon] = useState(false);
  const [couponError, setCouponError] = useState<string | null>(null);

  // State for editing a cart item
  const [editingCartItem, setEditingCartItem] = useState<any>(null);

  // State for locally fetched delivery zone info (when not provided via props)
  const [localDeliveryZoneInfo, setLocalDeliveryZoneInfo] = useState<DeliveryBoundaryValidationResponse | null>(null);

  // State for default minimum order amount (from delivery zones)
  const [defaultMinimumOrderAmount, setDefaultMinimumOrderAmount] = useState<number>(0);

  // Track if we've loaded items for this edit session to prevent infinite loops
  const hasLoadedItemsRef = React.useRef(false);
  const lastEditOrderIdRef = React.useRef<string | undefined>(undefined);
  const shouldApplyGhostMode = ghostModeFeatureEnabled && ghostModeEnabled;
  const hasOnlyManualItems = cartItems.length > 0 && cartItems.every((item) => item?.is_manual === true);
  const shouldBypassPaymentWithGhostMode = shouldApplyGhostMode && hasOnlyManualItems;

  const parseBooleanSetting = (value: unknown): boolean => {
    if (value === true || value === 1) return true;
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (!trimmed) return false;
      if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
        const unwrapped = trimmed.slice(1, -1).trim().toLowerCase();
        return unwrapped === 'true' || unwrapped === '1' || unwrapped === 'yes' || unwrapped === 'on';
      }
      const normalized = trimmed.toLowerCase();
      return normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on';
    }
    return false;
  };

  // Effective delivery zone info - use prop if available, otherwise use locally fetched
  const effectiveDeliveryZoneInfo = deliveryZoneInfo || localDeliveryZoneInfo;

  // Effective minimum order amount - prefer zone-specific, fallback to default
  const effectiveMinimumOrderAmount = effectiveDeliveryZoneInfo?.zone?.minimumOrderAmount ?? defaultMinimumOrderAmount;

  // Fetch order items from backend
  const fetchOrderItems = useCallback(async (orderId: string, supabaseId?: string): Promise<any[]> => {
    try {
      console.log('[MenuModal] fetchOrderItems - orderId:', orderId, 'supabaseId:', supabaseId);
      
      // First try to get order from local DB using local ID
      const localOrderResponse: any = await bridge.orders.getById(orderId);
      const localOrder = localOrderResponse?.data ?? localOrderResponse;
      console.log('[MenuModal] Local order result:', localOrder?.id, 'items:', localOrder?.items?.length);
      if (localOrder?.items && Array.isArray(localOrder.items) && localOrder.items.length > 0) {
        console.log('[MenuModal] Loaded items from local DB:', localOrder.items.length);
        return localOrder.items;
      }

      // Fallback: fetch from Supabase using supabaseId if available, otherwise use orderId
      const supabaseOrderId = supabaseId || orderId;
      console.log('[MenuModal] Fetching from Supabase with ID:', supabaseOrderId);
      const supabaseResult: any = await bridge.orders.fetchItemsFromSupabase(supabaseOrderId);
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
  }, [bridge.orders]);

  // Reset refs and cart when modal closes
  useEffect(() => {
    if (!isOpen) {
      hasLoadedItemsRef.current = false;
      lastEditOrderIdRef.current = undefined;
      // Reset cart when modal closes to ensure clean state for next open
      setCartItems([]);
      // Clear locally fetched delivery zone info and default minimum
      setLocalDeliveryZoneInfo(null);
      setDefaultMinimumOrderAmount(0);
      // Clear combos/coupon state
      setAppliedCoupon(null);
      setCouponError(null);
      setSelectedCombo(null);
      setManualDiscountMode('percentage');
      setManualDiscountValue(0);
      setGhostModeEnabled(false);
      setGhostModeFeatureEnabled(false);
    }
  }, [isOpen, cartItems.length]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    const loadGhostSettings = async () => {
      try {
        const [featureFlag, enabled] = await Promise.all([
          bridge.settings.get('terminal', 'ghost_mode_feature_enabled'),
          bridge.settings.get('system', 'ghost_mode_enabled'),
        ]);
        setGhostModeFeatureEnabled(parseBooleanSetting(featureFlag));
        setGhostModeEnabled(parseBooleanSetting(enabled));
      } catch (error) {
        console.warn('[MenuModal] Failed to load ghost mode settings:', error);
        setGhostModeFeatureEnabled(false);
        setGhostModeEnabled(false);
      }
    };
    void loadGhostSettings();
  }, [bridge.settings, isOpen]);

  // Fetch delivery zone info when modal opens for delivery orders (if not provided via props)
  useEffect(() => {
    const fetchDeliveryZoneInfo = async () => {
      // Only fetch if: modal is open, order type is delivery, no zone info provided, has address, not in edit mode
      if (!isOpen || orderType !== 'delivery' || deliveryZoneInfo || editMode || !selectedAddress) {
        return;
      }

      // Build address string from selectedAddress
      const addressParts = [
        selectedAddress.street_address || selectedAddress.street || '',
        selectedAddress.city || '',
        selectedAddress.postal_code || selectedAddress.postalCode || ''
      ].filter(Boolean);

      if (addressParts.length === 0) {
        return;
      }

      const addressString = addressParts.join(', ');

      try {
        const result = await validateDeliveryAddress(addressString, 0);
        if (result) {
          setLocalDeliveryZoneInfo(result);
        }
      } catch (error) {
        console.error('[MenuModal] Error validating delivery zone:', error);
      }
    };

    fetchDeliveryZoneInfo();
  }, [isOpen, orderType, deliveryZoneInfo, editMode, selectedAddress, validateDeliveryAddress]);

  // Fetch delivery zones to get default minimum order amount (fallback when validation doesn't work)
  useEffect(() => {
    const fetchDeliveryZones = async () => {
      // Only fetch if: modal is open, order type is delivery, no zone info yet, not in edit mode
      if (!isOpen || orderType !== 'delivery' || editMode) {
        return;
      }

      // If we already have effective zone info with minimum amount, skip
      if (effectiveDeliveryZoneInfo?.zone?.minimumOrderAmount !== undefined) {
        return;
      }

      const refreshed = await refreshTerminalCredentialCache();
      const branchId = staff?.branchId || refreshed.branchId || getCachedTerminalCredentials().branchId;
      if (!branchId) {
        return;
      }

      try {
        const { posApiGet } = await import('../../utils/api-helpers');
        const result = await posApiGet<any[]>(`pos/delivery-zones?branch_id=${branchId}`);

        if (result.success && result.data) {
          const zones = Array.isArray(result.data) ? result.data : (result.data as any).zones || [];
          // Find the first active zone with a minimum order amount, or use the lowest minimum from all active zones
          const activeZones = zones.filter((z: any) => z.is_active);
          if (activeZones.length > 0) {
            const minAmount = activeZones[0].min_order_amount || activeZones[0].minimum_order_amount || 0;
            setDefaultMinimumOrderAmount(minAmount);
          }
        }
      } catch (error) {
        console.error('[MenuModal] Error fetching delivery zones:', error);
      }
    };

    fetchDeliveryZones();
  }, [isOpen, orderType, editMode, staff?.branchId, effectiveDeliveryZoneInfo?.zone?.minimumOrderAmount]);

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
    // Skip if not open
    if (!isOpen) return;

    // Skip if already loaded for this exact order
    if (editMode && hasLoadedItemsRef.current && lastEditOrderIdRef.current === editOrderId) {
      console.log('[MenuModal] Skipping load - already loaded for order:', editOrderId);
      return;
    }

    const loadItems = async () => {
      if (editMode) {
        // Mark as loaded IMMEDIATELY to prevent race conditions where this effect runs multiple times
        // before the async operations complete
        hasLoadedItemsRef.current = true;
        lastEditOrderIdRef.current = editOrderId;

        // IMPORTANT: Clear cart items first to prevent duplicates when switching between orders
        // This handles the case where the modal is already open and we're loading a different order
        setCartItems([]);

        // If we have initialCartItems, use them
        if (initialCartItems && initialCartItems.length > 0) {
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
            originalUnitPrice: item.original_unit_price || item.originalUnitPrice || item.unit_price || item.price || 0,
            isPriceOverridden:
              item.is_price_overridden === true ||
              item.isPriceOverridden === true ||
              ((item.original_unit_price || item.originalUnitPrice || item.unit_price || item.price || 0) !==
                (item.unit_price || item.price || 0)),
          }));
          setCartItems(transformedItems);
        }
        // Otherwise fetch from backend if we have an orderId
        else if (editOrderId) {
          setIsLoadingItems(true);
          try {
            const fetchedItems = await fetchOrderItems(editOrderId, editSupabaseId);
            if (fetchedItems.length > 0) {
              const transformedItems = fetchedItems.map((item, index) => {
                const transformedCustomizations = transformCustomizations(item.customizations);
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
                  originalUnitPrice: item.original_unit_price || item.originalUnitPrice || item.unit_price || item.price || 0,
                  isPriceOverridden:
                    item.is_price_overridden === true ||
                    item.isPriceOverridden === true ||
                    ((item.original_unit_price || item.originalUnitPrice || item.unit_price || item.price || 0) !==
                      (item.unit_price || item.price || 0)),
                };
              });
              setCartItems(transformedItems);
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
          { id: "featured", name: t('modals.menu.featured'), icon: "⭐" },
          { id: "combos", name: t('modals.menu.combos', 'Combos & Offers'), icon: "🎁" },
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

  // Load combos when modal opens
  useEffect(() => {
    const loadCombos = async () => {
      try {
        const combosData = await menuService.getMenuCombos();
        setCombos(combosData);
      } catch (error) {
        console.error('Error loading combos:', error);
        setCombos([]);
      }
    };

    if (isOpen) {
      loadCombos();
    }
  }, [isOpen]);

  // Handle combo selection
  const handleComboSelect = (combo: MenuCombo) => {
    if (combo.combo_type === 'choice') {
      // Open choice modal for selection
      setSelectedCombo(combo);
    } else if (combo.combo_type === 'bogo') {
      // BOGO - show info toast
      toast.success(
        t('menu.combos.bogo.infoToast', 'BOGO offer will be applied when qualifying items are in cart'),
        { duration: 3000 }
      );
    } else {
      // Fixed combo - add directly to cart
      handleAddFixedComboToCart(combo);
    }
  };

  // Add a fixed combo to cart
  const handleAddFixedComboToCart = (combo: MenuCombo) => {
    const comboPrice = getComboPrice(combo, orderType);
    const comboName = combo.name_en; // Will be localized in cart display

    const cartItem = {
      id: `combo-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`,
      menuItemId: combo.id,
      name: comboName,
      price: comboPrice,
      quantity: 1,
      customizations: [],
      notes: '',
      totalPrice: comboPrice,
      basePrice: comboPrice,
      unitPrice: comboPrice,
      originalUnitPrice: comboPrice,
      isPriceOverridden: false,
      is_combo: true,
      combo_id: combo.id,
      combo_type: combo.combo_type,
      combo_items: combo.items?.map((item) => ({
        subcategory_id: item.subcategory_id || '',
        name: item.subcategory?.name || item.subcategory?.name_en || '',
        name_en: item.subcategory?.name_en,
        name_el: item.subcategory?.name_el,
        quantity: item.quantity,
        unit_price: item.subcategory?.base_price || 0,
      })) || [],
    };

    setCartItems((prev) => [...prev, cartItem]);
    toast.success(t('menu.combos.addedToCart', 'Combo added to cart'));
  };

  // Handle choice combo confirmation
  const handleComboChoiceConfirm = (combo: MenuCombo, chosenItems: ChosenComboItem[]) => {
    const comboPrice = getComboPrice(combo, orderType);
    const comboName = combo.name_en;

    const cartItem = {
      id: `combo-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`,
      menuItemId: combo.id,
      name: comboName,
      price: comboPrice,
      quantity: 1,
      customizations: [],
      notes: '',
      totalPrice: comboPrice,
      basePrice: comboPrice,
      unitPrice: comboPrice,
      originalUnitPrice: comboPrice,
      isPriceOverridden: false,
      is_combo: true,
      combo_id: combo.id,
      combo_type: combo.combo_type,
      combo_items: chosenItems.map((item) => ({
        subcategory_id: item.subcategory_id,
        name: item.name,
        name_en: item.name_en,
        name_el: item.name_el,
        quantity: item.quantity,
        unit_price: item.unit_price,
      })),
    };

    setCartItems((prev) => [...prev, cartItem]);
    setSelectedCombo(null);
    toast.success(t('menu.combos.addedToCart', 'Combo added to cart'));
  };

  // Coupon handlers
  const handleApplyCoupon = async (code: string) => {
    setIsValidatingCoupon(true);
    setCouponError(null);
    try {
      const result = await posApiPost<{
        valid: boolean;
        coupon?: AppliedCoupon;
        error?: string;
      }>('pos/coupons/validate', { code, order_total: cartItems.reduce((sum, item) => sum + (item.totalPrice || 0), 0) });

      if (!result.success) {
        setCouponError(result.error || t('menu.cart.couponError', 'Failed to validate coupon'));
        return;
      }

      if (result.data?.valid && result.data?.coupon) {
        setAppliedCoupon(result.data.coupon);
        setCouponError(null);
        toast.success(t('menu.cart.couponApplied', 'Coupon applied!'));
      } else {
        setCouponError(result.data?.error || t('menu.cart.couponInvalid', 'Invalid coupon code'));
      }
    } catch (error) {
      console.error('Error validating coupon:', error);
      setCouponError(t('menu.cart.couponError', 'Failed to validate coupon'));
    } finally {
      setIsValidatingCoupon(false);
    }
  };

  const handleRemoveCoupon = () => {
    setAppliedCoupon(null);
    setCouponError(null);
  };

  // Add manual item to cart (or toggle ghost mode via secret code)
  const handleAddManualItem = (price: number, name?: string) => {
    // Secret code: name "x" + price 1 toggles ghost mode
    if (ghostModeFeatureEnabled && name?.trim().toLowerCase() === 'x' && price === 1) {
      const newState = !ghostModeEnabled;
      setGhostModeEnabled(newState);
      // Persist the toggle
      bridge.settings.updateLocal({
        settingType: 'system',
        settings: { ghost_mode_enabled: newState },
      })
        .catch((err: unknown) => console.warn('[MenuModal] Failed to save ghost mode setting:', err));
      toast.success(
        newState
          ? (t('menu.cart.ghostModeActivated', 'Ghost mode activated'))
          : (t('menu.cart.ghostModeDeactivated', 'Ghost mode deactivated')),
      );
      return; // Do NOT add item to cart
    }

    const cartItem = {
      id: `manual-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`,
      menuItemId: 'manual',
      name: name || t('menu.cart.manualItem', 'Manual Item'),
      price,
      quantity: 1,
      customizations: [],
      notes: '',
      totalPrice: price,
      basePrice: price,
      unitPrice: price,
      originalUnitPrice: price,
      isPriceOverridden: false,
      is_manual: true,
    };
    setCartItems((prev) => [...prev, cartItem]);
    toast.success(t('menu.cart.manualItemAdded', 'Manual item added'));
  };

  const calculateManualDiscount = useCallback((subtotal: number) => {
    if (manualDiscountMode === 'percentage') {
      const percentage = Math.max(0, Math.min(manualDiscountValue, 100));
      return {
        discountAmount: subtotal * (percentage / 100),
        discountPercentage: percentage,
      };
    }
    return {
      discountAmount: Math.min(Math.max(manualDiscountValue, 0), subtotal),
      discountPercentage: 0,
    };
  }, [manualDiscountMode, manualDiscountValue]);

  // Calculate coupon discount
  const calculateCouponDiscount = (): number => {
    if (!appliedCoupon) return 0;
    const subtotal = cartItems.reduce((sum, item) => sum + (item.totalPrice || 0), 0);
    const { discountAmount } = calculateManualDiscount(subtotal);
    const afterManualDiscount = subtotal - discountAmount;
    if (appliedCoupon.discount_type === 'percentage') {
      return afterManualDiscount * (appliedCoupon.discount_value / 100);
    }
    return Math.min(appliedCoupon.discount_value, afterManualDiscount);
  };

  const handleAddToCart = async (item: any, quantity: number, customizations: any[], notes: string) => {
    // Get category ID from the item, or fallback to selected category
    const itemCategoryId = item.category_id || item.categoryId || item.category;

    console.log('[handleAddToCart] Starting category lookup:', {
      itemName: item.name,
      itemCategoryId,
      selectedCategory,
      categoriesCount: categories.length
    });

    // Look up category name - try multiple strategies:
    // 1. First try the item's category_id from local categories state
    // 2. Then try the currently selected category (which is the category tab the user is on)
    // 3. Finally, fetch categories from service if not found (race condition fallback)
    let categoryName: string | null = null;

    // Strategy 1: Look up by item's category_id in local state
    if (itemCategoryId && categories.length > 0) {
      categoryName = categories.find(cat => cat.id === itemCategoryId)?.name || null;
      console.log('[handleAddToCart] Strategy 1 result:', categoryName);
    }

    // Strategy 2: Use selected category if it's a real category (not "all" or "featured")
    if (!categoryName && selectedCategory && selectedCategory !== 'all' && selectedCategory !== 'featured') {
      categoryName = categories.find(cat => cat.id === selectedCategory)?.name || null;
      console.log('[handleAddToCart] Strategy 2 result:', categoryName);
    }

    // Strategy 3: If categories state is empty or lookup failed, fetch from service
    if (!categoryName && itemCategoryId) {
      try {
        const freshCategories = await menuService.getMenuCategories();
        const foundCategory = freshCategories.find((cat: any) => cat.id === itemCategoryId);
        if (foundCategory) {
          categoryName = foundCategory.name || foundCategory.name_en || null;
          console.log('[handleAddToCart] Strategy 3 result:', categoryName);
        }
      } catch (error) {
        console.error('Failed to fetch categories for category name lookup:', error);
      }
    }

    console.log('[handleAddToCart] Final categoryName:', categoryName);

    // Ensure item has required properties
    // Use order-type-specific price: three-tier pricing (pickup, delivery, dine-in)
    const getItemPrice = () => {
      if (orderType === 'pickup') return item.pickup_price ?? item.price ?? 0;
      if (orderType === 'delivery') return item.delivery_price ?? item.price ?? 0;
      if (orderType === 'dine-in') return item.dine_in_price ?? item.pickup_price ?? item.price ?? 0;
      return item.price ?? 0;
    };
    const basePrice = getItemPrice();
    const itemQuantity = quantity || 1;

    // Calculate customization price per item
    // customizations is an array of SelectedIngredient objects: { ingredient: Ingredient, quantity: number }
    // Only count ingredients that are NOT marked as "without"
    const customizationPrice = customizations.reduce((sum, c) => {
      // Skip "without" items - they don't add to price
      if (c.isWithout) return sum;

      // Get the ingredient price based on order type (three-tier pricing)
      const getIngredientPrice = () => {
        if (orderType === 'pickup') return c.ingredient?.pickup_price ?? c.ingredient?.price ?? 0;
        if (orderType === 'delivery') return c.ingredient?.delivery_price ?? c.ingredient?.price ?? 0;
        if (orderType === 'dine-in') return c.ingredient?.dine_in_price ?? c.ingredient?.pickup_price ?? c.ingredient?.price ?? 0;
        return c.ingredient?.price ?? 0;
      };
      const ingredientPrice = getIngredientPrice();

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
      originalUnitPrice: pricePerItem,
      isPriceOverridden: false,
      flavorType: item.flavor_type || null, // Store flavor type (savory/sweet) for display
      categoryName: categoryName, // Store main category name (e.g., "Crepes", "Waffles")
    };

    // If we're editing an existing cart item, remove the old one first
    if (editingCartItem) {
      setCartItems(prev => [...prev.filter(ci => ci.id !== editingCartItem.id), cartItem]);
      setEditingCartItem(null);
    } else {
      setCartItems(prev => [...prev, cartItem]);
    }
  };

  // Quick add handler for non-customizable items (skips modal, adds directly to cart)
  const handleQuickAdd = async (item: any, quantity: number) => {
    await handleAddToCart(item, quantity, [], '');
    setMenuSearchQuery('');
    setTimeout(() => menuSearchRef.current?.focus(), 50);
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
            original_unit_price: item.originalUnitPrice ?? item.unitPrice ?? item.price,
            is_price_overridden:
              item.isPriceOverridden === true ||
              Math.abs(
                (item.unitPrice || item.price || 0) -
                  (item.originalUnitPrice ?? item.unitPrice ?? item.price ?? 0)
              ) > 0.0001,
            notes: item.notes,
            customizations: item.customizations,
            categoryName: item.categoryName // Include category name for display in orders
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

    if (shouldBypassPaymentWithGhostMode) {
      const subtotal = cartItems.reduce((sum, item) => sum + (item.totalPrice || 0), 0);
      await handlePaymentComplete({
        method: 'other',
        status: 'paid',
        amount: subtotal,
        isGhostBypass: true,
      });
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

  const handleLinePriceChange = (itemId: string | number, newUnitPrice: number) => {
    const normalizedPrice = Math.max(0, Number.isFinite(newUnitPrice) ? newUnitPrice : 0);
    setCartItems(prev =>
      prev.map(item => {
        if (item.id !== itemId) return item;
        const originalUnitPrice = item.originalUnitPrice ?? item.unitPrice ?? item.price ?? 0;
        const isPriceOverridden = Math.abs(normalizedPrice - originalUnitPrice) > 0.0001;
        return {
          ...item,
          unitPrice: normalizedPrice,
          price: normalizedPrice,
          totalPrice: normalizedPrice * item.quantity,
          originalUnitPrice,
          isPriceOverridden,
        };
      })
    );
  };

  const handlePaymentComplete = async (paymentData: any) => {
    const subtotal = cartItems.reduce((sum, item) => sum + (item.totalPrice || 0), 0);
    const {
      discountAmount: manualDiscountAmount,
      discountPercentage: normalizedDiscountPercentage,
    } = calculateManualDiscount(subtotal);
    const couponDiscountAmount = calculateCouponDiscount();
    const totalDiscountAmount = manualDiscountAmount + couponDiscountAmount;
    const totalAfterDiscount = subtotal - totalDiscountAmount;
    const isGhostOrder = shouldBypassPaymentWithGhostMode;
    const ghostMetadata = isGhostOrder
      ? {
        trigger: 'ghost_mode_toggle',
        item_count: cartItems.length,
        bypass_reason: 'ghost_mode_enabled',
      }
      : null;

    // Debug: Log cart items with notes, categoryName, and customizations before passing to onOrderComplete
    console.log('[MenuModal.handlePaymentComplete] cartItems details:', cartItems.map(item => ({
      name: item.name,
      categoryName: item.categoryName,
      customizationsCount: item.customizations?.length || 0,
      customizations: item.customizations,
      notes: item.notes
    })));

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
          discountPercentage: normalizedDiscountPercentage,
          discountAmount: manualDiscountAmount,
          manualDiscountMode,
          manualDiscountValue,
          total_discount_amount: totalDiscountAmount,
          is_ghost: isGhostOrder,
          ghost_source: isGhostOrder ? 'ghost_mode_toggle' : null,
          ghost_metadata: ghostMetadata,
          deliveryZoneInfo: effectiveDeliveryZoneInfo, // Pass delivery zone info to OrderDashboard for correct fee calculation
          ...(appliedCoupon ? {
            coupon_id: appliedCoupon.id,
            coupon_code: appliedCoupon.code,
            coupon_discount_amount: couponDiscountAmount,
          } : {}),
        });
      }

      // Reset state
      setCartItems([]);
      setSelectedCategory("all");
      setSelectedSubcategory("");
      setManualDiscountMode('percentage');
      setManualDiscountValue(0);
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
    const typeLabel = orderType === 'delivery' ? t('modals.menu.delivery') : t('modals.menu.pickup');
    if (editMode && editOrderNumber) {
      return `${t('modals.menu.editOrder') || 'Edit Order'} #${editOrderNumber} - ${typeLabel}`;
    }
    return `${typeLabel} ${t('modals.menu.order')}`;
  };

  return (
    <>
      <LiquidGlassModal
        isOpen={isOpen}
        onClose={onClose}
        header={
          <div className="flex flex-col gap-1 px-6 py-3 border-b border-white/10 flex-shrink-0">
            {/* Main row: Title + Customer + Close */}
            <div className="flex items-center justify-between w-full">
              <h2 className="liquid-glass-modal-title text-xl">
                {getModalTitle()}
                {editMode && (
                  <span className="ml-3 text-xs font-medium text-amber-400 bg-amber-500/20 px-2 py-0.5 rounded-full align-middle">
                    <Pencil className="w-3 h-3 inline mr-1" />
                    {t('modals.menu.editModeMessage') || 'Editing'}
                  </span>
                )}
              </h2>

              <div className="flex items-center gap-3">
                {/* Customer info chip or Add Customer button */}
                <div>
                  {orderType === 'delivery' && selectedCustomer ? (
                    <span className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-sm bg-blue-500/20 text-blue-300 border border-blue-500/30">
                      <User className="w-3.5 h-3.5" />
                      {selectedCustomer.name}{selectedCustomer.phone_number || selectedCustomer.phone ? ` \u00B7 ${selectedCustomer.phone_number || selectedCustomer.phone}` : ''}
                    </span>
                  ) : hasCustomerInfo ? (
                    <button
                      onClick={() => setShowCustomerPopover(true)}
                      className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-sm bg-green-500/20 text-green-300 border border-green-500/30 hover:bg-green-500/30 transition-colors"
                    >
                      <User className="w-3.5 h-3.5" />
                      {pickupCustomerName || pickupCustomerPhone}
                      {pickupCustomerName && pickupCustomerPhone ? ` \u00B7 ${pickupCustomerPhone}` : ''}
                    </button>
                  ) : (
                    <button
                      onClick={() => setShowCustomerPopover(true)}
                      className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-sm liquid-glass-modal-button hover:bg-white/10 transition-colors"
                    >
                      <UserPlus className="w-3.5 h-3.5" />
                      {t('modals.menu.addCustomer', { defaultValue: 'Add Customer' })}
                    </button>
                  )}
                </div>

                {/* Close button */}
                <button
                  onClick={onClose}
                  className="liquid-glass-modal-button p-2 min-h-0 min-w-0"
                  aria-label={t('common.actions.close')}
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            </div>

            {/* Delivery address subtitle */}
            {orderType === 'delivery' && selectedAddress && (
              <div className="flex items-center gap-3 text-xs liquid-glass-modal-text-muted">
                <span>{selectedAddress.street_address || selectedAddress.street}, {selectedAddress.postal_code || selectedAddress.city}</span>
                {effectiveDeliveryZoneInfo?.zone && (
                  <>
                    <span className="px-2 py-0.5 rounded bg-blue-500/20 text-blue-400 font-medium">
                      {effectiveDeliveryZoneInfo.zone.name}
                    </span>
                    <span>{t('modals.menu.fee')}: {formatCurrency(effectiveDeliveryZoneInfo.zone.deliveryFee)}</span>
                    {effectiveDeliveryZoneInfo.zone.estimatedTime && (
                      <span>{effectiveDeliveryZoneInfo.zone.estimatedTime.min}-{effectiveDeliveryZoneInfo.zone.estimatedTime.max} min</span>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
        }
        size="full"
        closeOnBackdrop={false}
        closeOnEscape={true}
      >

        <div className="flex flex-col sm:flex-row flex-1 overflow-hidden min-h-0">
          {/* Left Panel - Menu */}
          <div className="flex-1 flex flex-col min-w-0 min-h-0 overflow-hidden">
            {/* Search bar */}
            <div className="px-3 pt-3 pb-1">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                <input
                  ref={menuSearchRef}
                  type="text"
                  autoFocus
                  value={menuSearchQuery}
                  onChange={(e) => setMenuSearchQuery(e.target.value)}
                  placeholder={t('menu.search.placeholder', 'Search menu items...')}
                  className="w-full pl-9 pr-8 py-2 rounded-lg bg-white/10 border border-white/20 text-sm text-white placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
                {menuSearchQuery && (
                  <button
                    onClick={() => setMenuSearchQuery('')}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-white"
                  >
                    <X className="w-4 h-4" />
                  </button>
                )}
              </div>
            </div>
            <MenuCategoryTabs
              selectedCategory={selectedCategory}
              onCategoryChange={(cat) => { setSelectedCategory(cat); setMenuSearchQuery(''); }}
              selectedSubcategory={selectedSubcategory}
              onSubcategoryChange={setSelectedSubcategory}
              hideAllItemsButton={true}
              categories={categories}
            />
            <MenuItemGrid
              selectedCategory={selectedCategory}
              selectedSubcategory={selectedSubcategory}
              orderType={orderType}
              onItemSelect={(item) => { setSelectedMenuItem(item); setMenuSearchQuery(''); setTimeout(() => menuSearchRef.current?.focus(), 50); }}
              onQuickAdd={handleQuickAdd}
              comboMode={selectedCategory === 'combos'}
              combos={combos}
              onComboSelect={handleComboSelect}
              searchQuery={menuSearchQuery}
            />
          </div>

          {/* Right Panel - Cart - Flex layout for proper height inheritance */}
          <div className="w-72 md:w-80 flex-shrink-0 flex flex-col min-h-0 overflow-hidden">
            <MenuCart
              cartItems={cartItems}
              onCheckout={handleCheckout}
              onUpdateCart={setCartItems}
              onEditItem={handleEditCartItem}
              onRemoveItem={handleRemoveCartItem}
              discountPercentage={manualDiscountMode === 'percentage' ? manualDiscountValue : 0}
              manualDiscountMode={manualDiscountMode}
              manualDiscountValue={manualDiscountValue}
              maxDiscountPercentage={maxDiscountPercentage}
              onManualDiscountChange={
                editMode
                  ? undefined
                  : (mode, value) => {
                      setManualDiscountMode(mode);
                      setManualDiscountValue(value);
                    }
              }
              editMode={editMode}
              isSaving={isSavingEdit}
              orderType={orderType}
              minimumOrderAmount={effectiveMinimumOrderAmount}
              appliedCoupon={appliedCoupon}
              onApplyCoupon={editMode ? undefined : handleApplyCoupon}
              onRemoveCoupon={handleRemoveCoupon}
              couponDiscount={calculateCouponDiscount()}
              isValidatingCoupon={isValidatingCoupon}
              couponError={couponError}
              onAddManualItem={editMode ? undefined : handleAddManualItem}
              onLinePriceChange={handleLinePriceChange}
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

      {/* Combo Choice Modal */}
      {isOpen && selectedCombo && (
        <ComboChoiceModal
          isOpen={!!selectedCombo}
          combo={selectedCombo}
          orderType={orderType}
          onClose={() => setSelectedCombo(null)}
          onConfirm={handleComboChoiceConfirm}
        />
      )}

      {/* Payment Modal */}
      {isOpen && (
        (() => {
          const subtotal = cartItems.reduce((sum, item) => sum + (item.totalPrice || 0), 0);
          const { discountAmount: manualDiscountAmount } = calculateManualDiscount(subtotal);
          const couponDiscountAmount = calculateCouponDiscount();
          const discountAmount = manualDiscountAmount + couponDiscountAmount;
          const orderTotal = subtotal - discountAmount;
          return (
        <PaymentModal
          isOpen={showPaymentModal}
          onClose={() => setShowPaymentModal(false)}
          orderTotal={orderTotal}
          discountAmount={discountAmount}
          orderType={orderType}
          minimumOrderAmount={effectiveDeliveryZoneInfo?.zone?.minimumOrderAmount || 0}
          onPaymentComplete={handlePaymentComplete}
          isProcessing={isProcessingOrder}
        />
          );
        })()
      )}

      {/* Customer Info Modal — compact centered overlay */}
      {showCustomerPopover && (
        <div className="fixed inset-0 z-[1200] flex items-center justify-center" onClick={() => setShowCustomerPopover(false)}>
          {/* Heavy blur backdrop */}
          <div className="absolute inset-0 bg-black/50 backdrop-blur-md" />

          {/* Compact glass card */}
          <div
            role="dialog"
            aria-modal="true"
            className="relative w-[340px] rounded-2xl overflow-hidden liquid-glass-modal-shell !fixed !top-1/2 !left-1/2 !-translate-x-1/2 !-translate-y-1/2 !max-w-[340px] !max-h-fit !animate-none"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="liquid-glass-modal-header !py-4 !px-5">
              <h3 className="liquid-glass-modal-title !text-lg">
                {t('modals.menu.customerInfo', { defaultValue: 'Customer Info (Optional)' })}
              </h3>
              <button onClick={() => setShowCustomerPopover(false)} className="liquid-glass-modal-close !w-8 !h-8 !text-base">
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Body */}
            <div className="p-5 space-y-3">
              <input
                type="text"
                value={pickupCustomerName}
                onChange={(e) => setPickupCustomerName(e.target.value)}
                placeholder={t('modals.menu.customerName', { defaultValue: 'Name' })}
                className="liquid-glass-modal-input w-full"
                autoFocus
              />
              <input
                type="tel"
                value={pickupCustomerPhone}
                onChange={(e) => setPickupCustomerPhone(e.target.value)}
                placeholder={t('modals.menu.customerPhone', { defaultValue: 'Phone' })}
                className="liquid-glass-modal-input w-full"
              />
              <input
                type="text"
                value={pickupCustomerNotes}
                onChange={(e) => setPickupCustomerNotes(e.target.value)}
                placeholder={t('modals.menu.customerNotes', { defaultValue: 'Notes' })}
                className="liquid-glass-modal-input w-full"
              />
              <button
                onClick={() => {
                  if (selectedCustomer) {
                    selectedCustomer.name = pickupCustomerName;
                    selectedCustomer.phone = pickupCustomerPhone;
                    selectedCustomer.phone_number = pickupCustomerPhone;
                    selectedCustomer.notes = pickupCustomerNotes;
                  }
                  setShowCustomerPopover(false);
                }}
                className="liquid-glass-modal-button liquid-glass-modal-primary w-full"
              >
                {t('common.actions.save', { defaultValue: 'Save' })}
              </button>
            </div>
          </div>
        </div>
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
