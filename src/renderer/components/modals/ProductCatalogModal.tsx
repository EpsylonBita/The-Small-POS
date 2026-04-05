/**
 * ProductCatalogModal - POS Product Selection Modal for Retail Vertical
 * 
 * A modal version of the ProductCatalog for order flow.
 * Supports barcode scanning and cart functionality.
 */

import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { X, Package, Search, Barcode, Plus, Minus, ShoppingCart, DollarSign, Gift } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../../contexts/theme-context';
import { useModules } from '../../contexts/module-context';
import { useProductCatalog } from '../../hooks/useProductCatalog';
import { useDiscountSettings } from '../../hooks/useDiscountSettings';
import { useDeliveryValidation } from '../../hooks/useDeliveryValidation';
import { useAcquiredModules, MODULE_IDS } from '../../hooks/useAcquiredModules';
import { useOnBarcodeScan, useBarcodeScannerContext } from '../../contexts/barcode-scanner-context';
import { LiquidGlassModal } from '../ui/pos-glass-components';
import { PaymentModal } from './PaymentModal';
import type { Product, ProductFilters } from '../../services/ProductCatalogService';
import type { DeliveryBoundaryValidationResponse } from '../../../shared/types/delivery-validation';
import { getBridge, offEvent, onEvent } from '../../../lib';
import {
  getCachedTerminalCredentials,
  refreshTerminalCredentialCache,
} from '../../services/terminal-credentials';
import { getDeliveryFeeStatus, resolveDeliveryFee } from '../../utils/delivery-fee';
import { formatMoneyInputWithCents, parseMoneyInputValue } from '../../utils/moneyInput';
import {
  buildSavedAddressQuery,
  extractSavedAddressCoordinates,
  resolveSavedAddressCoordinates,
} from '../../utils/saved-address-geolocation';
import { resolvePersistedCustomerId } from '../../utils/persisted-customer-id';
import {
  isOfferRewardLine,
  mapRewardActionsWithSignatures,
  validateCatalogOffers,
  type OfferRewardLineMetadata,
} from '../../utils/catalog-offers';
import type {
  CatalogOfferEvaluationResult,
  MatchedCatalogOffer,
  OfferEvaluationCartItem,
} from '../../../../../shared/types/catalog-offer';

// Debounce hook for search input
function useDebounce<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = useState<T>(value);

  useEffect(() => {
    const handler = setTimeout(() => {
      setDebouncedValue(value);
    }, delay);

    return () => {
      clearTimeout(handler);
    };
  }, [value, delay]);

  return debouncedValue;
}

interface CartItem extends Product {
  cartQuantity: number;
  is_offer_reward?: boolean;
  auto_added_by_offer?: boolean;
  offer_id?: string;
  offer_name?: string;
  reward_item_id?: string;
  reward_item_category_id?: string | null;
  reward_source_item_id?: string | null;
  reward_source_category_id?: string | null;
  reward_signature?: string;
  originalUnitPrice?: number;
}

interface ProductCatalogModalProps {
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
    deliveryFee?: number;
    deliveryZoneInfo?: DeliveryBoundaryValidationResponse | null;
  }) => void;
}

export const ProductCatalogModal: React.FC<ProductCatalogModalProps> = ({
  isOpen,
  onClose,
  selectedCustomer,
  selectedAddress,
  orderType = 'pickup',
  isProcessingOrder = false,
  deliveryZoneInfo,
  onOrderComplete
}) => {
  const { t } = useTranslation();
  const { resolvedTheme } = useTheme();
  const { organizationId: moduleOrgId } = useModules();
  const { maxDiscountPercentage } = useDiscountSettings();
  const { hasModule } = useAcquiredModules();
  const hasDeliveryModule = hasModule(MODULE_IDS.DELIVERY);
  const hasDeliveryZonesModule = hasModule(MODULE_IDS.DELIVERY_ZONES);
  const hasDeliveryPro = hasDeliveryModule && hasDeliveryZonesModule;
  const { state: scannerState } = useBarcodeScannerContext();
  const isDark = resolvedTheme === 'dark';

  const [branchId, setBranchId] = useState<string | null>(null);
  const [localOrgId, setLocalOrgId] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const [barcodeInput, setBarcodeInput] = useState('');
  const [cartItems, setCartItems] = useState<CartItem[]>([]);
  const [offerEvaluation, setOfferEvaluation] = useState<CatalogOfferEvaluationResult | null>(null);
  const [showPaymentModal, setShowPaymentModal] = useState(false);
  const [discountPercentage, setDiscountPercentage] = useState<number>(0);
  const [manualDeliveryFee, setManualDeliveryFee] = useState<number>(0);
  const [manualDeliveryFeeInput, setManualDeliveryFeeInput] = useState('');
  const [localDeliveryZoneInfo, setLocalDeliveryZoneInfo] =
    useState<DeliveryBoundaryValidationResponse | null>(null);
  const [resolvedSelectedAddressCoordinates, setResolvedSelectedAddressCoordinates] =
    useState<{ lat: number; lng: number } | null>(null);
  const [isResolvingSelectedAddressCoordinates, setIsResolvingSelectedAddressCoordinates] =
    useState(false);
  const barcodeInputRef = useRef<HTMLInputElement>(null);
  const {
    validateAddress: validateDeliveryAddress,
    isValidating: isValidatingDeliveryFee,
  } = useDeliveryValidation({ debounceMs: 0 });

  // Debounce search term to avoid excessive API calls (300ms delay)
  const debouncedSearchTerm = useDebounce(searchTerm, 300);
  const bridge = getBridge();
  const offerValidationRequestIdRef = useRef(0);

  useEffect(() => {
    let disposed = false;

    const hydrateTerminalIdentity = async () => {
      const cached = getCachedTerminalCredentials();
      if (!disposed) {
        setBranchId(cached.branchId || null);
        setLocalOrgId(cached.organizationId || null);
      }

      const refreshed = await refreshTerminalCredentialCache();
      if (!disposed) {
        setBranchId(refreshed.branchId || null);
        setLocalOrgId(refreshed.organizationId || null);
      }
    };

    const handleConfigUpdate = (data: { branch_id?: string; organization_id?: string }) => {
      if (disposed) return;
      if (typeof data?.branch_id === 'string' && data.branch_id.trim()) {
        setBranchId(data.branch_id.trim());
      }
      if (typeof data?.organization_id === 'string' && data.organization_id.trim()) {
        setLocalOrgId(data.organization_id.trim());
      }
    };

    hydrateTerminalIdentity();
    onEvent('terminal-config-updated', handleConfigUpdate);

    return () => {
      disposed = true;
      offEvent('terminal-config-updated', handleConfigUpdate);
    };
  }, []);

  // Use module context organizationId if available, otherwise fall back to cache
  const organizationId = moduleOrgId || localOrgId;

  // Memoize filters to avoid unnecessary re-renders
  const filters: ProductFilters = useMemo(() => ({
    categoryFilter,
    searchTerm: debouncedSearchTerm,
    lowStockOnly: false,
  }), [categoryFilter, debouncedSearchTerm]);

  const {
    products,
    categories,
    isLoading,
    searchByBarcode,
  } = useProductCatalog({
    branchId: branchId || '',
    organizationId: organizationId || '',
    filters,
    enableRealtime: true,
  });

  useEffect(() => {
    let cancelled = false;

    const resolveCoordinates = async () => {
      if (!isOpen || orderType !== 'delivery' || !selectedAddress) {
        setResolvedSelectedAddressCoordinates(null);
        setIsResolvingSelectedAddressCoordinates(false);
        return;
      }

      const existingCoordinates = extractSavedAddressCoordinates(selectedAddress);
      if (existingCoordinates) {
        setResolvedSelectedAddressCoordinates(existingCoordinates);
        setIsResolvingSelectedAddressCoordinates(false);
        return;
      }

      setResolvedSelectedAddressCoordinates(null);
      setIsResolvingSelectedAddressCoordinates(true);

      try {
        const refreshed = await refreshTerminalCredentialCache();
        const resolved = await resolveSavedAddressCoordinates(
          selectedAddress,
          branchId || refreshed.branchId || getCachedTerminalCredentials().branchId || undefined
        );

        if (cancelled) {
          return;
        }

        if (!resolved?.coordinates) {
          setResolvedSelectedAddressCoordinates(null);
          return;
        }

        setResolvedSelectedAddressCoordinates(resolved.coordinates);

        const addressVersion = Number((selectedAddress as any)?.version);
        const customerId = resolvePersistedCustomerId(
          selectedCustomer?.id,
          (selectedAddress as any)?.customer_id,
        );
        if (typeof (selectedAddress as any)?.id === 'string' && customerId) {
          try {
            await bridge.customers.updateAddress(
              (selectedAddress as any).id,
              {
                customer_id: customerId,
                coordinates: resolved.coordinates,
                latitude: resolved.coordinates.lat,
                longitude: resolved.coordinates.lng,
              },
              Number.isFinite(addressVersion) ? addressVersion : -1
            );
          } catch (error) {
            console.warn('[ProductCatalogModal] Failed to persist resolved address coordinates:', error);
          }
        }
      } catch (error) {
        if (!cancelled) {
          console.warn('[ProductCatalogModal] Failed to resolve saved address coordinates:', error);
          setResolvedSelectedAddressCoordinates(null);
        }
      } finally {
        if (!cancelled) {
          setIsResolvingSelectedAddressCoordinates(false);
        }
      }
    };

    void resolveCoordinates();

    return () => {
      cancelled = true;
    };
  }, [branchId, bridge.customers, isOpen, orderType, selectedAddress, selectedCustomer?.id]);

  useEffect(() => {
    if (!hasDeliveryPro) {
      setLocalDeliveryZoneInfo(null);
      return;
    }
    if (!isOpen || orderType !== 'delivery') {
      setLocalDeliveryZoneInfo(null);
      return;
    }

    if (deliveryZoneInfo) {
      setLocalDeliveryZoneInfo(null);
      return;
    }

      const exactCoordinates =
        resolvedSelectedAddressCoordinates || extractSavedAddressCoordinates(selectedAddress);

      if (!exactCoordinates) {
        setLocalDeliveryZoneInfo(null);
        return;
      }

    let cancelled = false;

      const validate = async () => {
        try {
          const result = await validateDeliveryAddress(exactCoordinates, 0);
          if (!cancelled) {
            setLocalDeliveryZoneInfo(result);
          }
      } catch (error) {
        if (!cancelled) {
          console.error('[ProductCatalogModal] Delivery validation failed:', error);
          setLocalDeliveryZoneInfo(null);
        }
      }
    };

    void validate();

    return () => {
      cancelled = true;
    };
  }, [deliveryZoneInfo, hasDeliveryPro, isOpen, orderType, resolvedSelectedAddressCoordinates, selectedAddress, validateDeliveryAddress]);

  useEffect(() => {
    if (!hasDeliveryPro) {
      const normalized = Math.max(0, manualDeliveryFee || 0);
      setManualDeliveryFeeInput(normalized > 0 ? normalized.toFixed(2).replace('.', ',') : '');
      return;
    }

    setManualDeliveryFeeInput('');
  }, [hasDeliveryPro, manualDeliveryFee]);

  // Focus barcode input when modal opens
  useEffect(() => {
    if (isOpen) {
      setTimeout(() => barcodeInputRef.current?.focus(), 100);
    }
  }, [isOpen]);

  useEffect(() => {
    if (isOpen) {
      return
    }

    setManualDeliveryFee(0)
    setManualDeliveryFeeInput('')
    setLocalDeliveryZoneInfo(null)
  }, [isOpen])

  // Add to cart function (defined before barcode handlers)
  const addToCart = useCallback((product: Product) => {
    setCartItems(prev => {
      const existing = prev.find(item => item.id === product.id && item.is_offer_reward !== true);
      if (existing) {
        return prev.map(item =>
          item.id === product.id && item.is_offer_reward !== true
            ? { ...item, cartQuantity: item.cartQuantity + 1 }
            : item
        );
      }
      return [...prev, { ...product, cartQuantity: 1 }];
    });
  }, []);

  // Handle barcode scan from input field
  const handleBarcodeScan = async (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && barcodeInput.trim()) {
      const product = await searchByBarcode(barcodeInput.trim());
      if (product) {
        addToCart(product);
      }
      setBarcodeInput('');
    }
  };

  // Handle global barcode scanner (USB barcode scanner support)
  const handleGlobalBarcodeScan = useCallback(async (barcode: string) => {
    if (!isOpen) return; // Only process when modal is open

    console.log('[ProductCatalogModal] Received barcode scan:', barcode);
    const product = await searchByBarcode(barcode);
    if (product) {
      addToCart(product);
      // Also update the input field to show what was scanned
      setBarcodeInput(barcode);
      setTimeout(() => setBarcodeInput(''), 1000); // Clear after 1 second
    }
  }, [isOpen, searchByBarcode, addToCart]);

  // Subscribe to global barcode scanner events
  useOnBarcodeScan(handleGlobalBarcodeScan, [isOpen, searchByBarcode, addToCart]);

  const updateCartQuantity = (productId: string, delta: number) => {
    setCartItems(prev => prev
      .map(item => item.id === productId && item.is_offer_reward !== true
        ? { ...item, cartQuantity: Math.max(0, item.cartQuantity + delta) }
        : item
      )
      .filter(item => item.cartQuantity > 0)
    );
  };

  const removeFromCart = (productId: string) => {
    setCartItems(prev => prev.filter(item => item.id !== productId && item.is_offer_reward !== true));
  };

  const paidCartItems = useMemo(
    () => cartItems.filter((item) => !isOfferRewardLine(item)),
    [cartItems],
  );
  const offerValidationItems = useMemo<OfferEvaluationCartItem[]>(
    () =>
      paidCartItems.flatMap((item) => {
        if (typeof item.id !== 'string' || !item.id.trim()) {
          return [];
        }

        return [{
          item_id: item.id,
          quantity: Math.max(1, item.cartQuantity || 1),
          unit_price: Math.max(0, item.price || 0),
          category_id: item.categoryId ?? null,
        }];
      }),
    [paidCartItems],
  );
  const offerValidationSignature = useMemo(
    () => JSON.stringify(offerValidationItems),
    [offerValidationItems],
  );

  const createRewardCartLine = useCallback((
    action: CatalogOfferEvaluationResult['reward_actions'][number],
    signature: string,
  ): CartItem & OfferRewardLineMetadata => ({
    id: `offer-reward-${signature}`,
    organizationId: organizationId || '',
    branchId: branchId || '',
    sku: '',
    barcode: null,
    name: action.item_name,
    description: null,
    categoryId: action.category_id ?? null,
    categoryName: null,
    price: 0,
    cost: null,
    quantity: 0,
    lowStockThreshold: 0,
    isActive: true,
    imageUrl: null,
    wholesalePrice: null,
    memberPrice: null,
    minWholesaleQuantity: null,
    preferredSupplierId: null,
    preferredSupplierName: null,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    cartQuantity: Math.max(1, action.quantity || 1),
    originalUnitPrice: action.unit_price,
    is_offer_reward: true,
    auto_added_by_offer: true,
    offer_id: action.offer_id,
    offer_name: action.offer_name,
    reward_item_id: action.item_id,
    reward_item_category_id: action.category_id ?? null,
    reward_source_item_id: action.source_item_id ?? null,
    reward_source_category_id: action.source_category_id ?? null,
    reward_signature: signature,
  }), [branchId, organizationId]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const requestId = offerValidationRequestIdRef.current + 1;
    offerValidationRequestIdRef.current = requestId;

    if (offerValidationItems.length === 0) {
      setOfferEvaluation(null);
      if (cartItems.some((item) => isOfferRewardLine(item))) {
        setCartItems(paidCartItems);
      }
      return;
    }

    let cancelled = false;

    const syncOffers = async () => {
      try {
        const evaluation = await validateCatalogOffers({
          catalogType: 'product',
          cartItems: offerValidationItems,
        });

        if (cancelled || offerValidationRequestIdRef.current !== requestId) {
          return;
        }

        const rewardLines = mapRewardActionsWithSignatures(evaluation?.reward_actions ?? []).map(
          ({ action, signature }) => createRewardCartLine(action, signature),
        );

        setOfferEvaluation(evaluation);
        setCartItems((prev) => {
          const currentPaidItems = prev.filter((item) => !isOfferRewardLine(item));
          return [...currentPaidItems, ...rewardLines];
        });
      } catch (error) {
        if (cancelled || offerValidationRequestIdRef.current !== requestId) {
          return;
        }
        console.error('[ProductCatalogModal] Failed to validate catalog offers:', error);
        setOfferEvaluation(null);
        setCartItems((prev) => prev.filter((item) => !isOfferRewardLine(item)));
      }
    };

    void syncOffers();

    return () => {
      cancelled = true;
    };
  }, [createRewardCartLine, isOpen, offerValidationSignature]);

  const subtotal = cartItems.reduce((sum, item) => sum + (item.price * item.cartQuantity), 0);
  const offerDiscountAmount = offerEvaluation?.discount_total ?? 0;
  const discountableSubtotal = Math.max(subtotal - offerDiscountAmount, 0);
  const discountAmount = discountableSubtotal * (discountPercentage / 100);
  const effectiveDeliveryZoneInfo = deliveryZoneInfo || localDeliveryZoneInfo;
  const exactDeliveryCoordinates =
    resolvedSelectedAddressCoordinates || extractSavedAddressCoordinates(selectedAddress);
  const deliveryValidationTarget =
    exactDeliveryCoordinates || buildSavedAddressQuery(selectedAddress) || null;
  const hasExactDeliveryCoordinates = !!exactDeliveryCoordinates;
  const deliveryFeeStatus =
      orderType !== 'delivery'
        ? 'resolved'
        : !hasDeliveryPro
          ? 'resolved'
          : !deliveryValidationTarget
            ? 'requires_selection'
            : !hasExactDeliveryCoordinates
              ? (isResolvingSelectedAddressCoordinates ? 'loading' : 'requires_selection')
              : getDeliveryFeeStatus(orderType, effectiveDeliveryZoneInfo, isValidatingDeliveryFee || isResolvingSelectedAddressCoordinates);
  const deliveryFee =
    orderType !== 'delivery'
      ? 0
      : hasDeliveryPro
        ? (deliveryFeeStatus === 'resolved' ? resolveDeliveryFee(effectiveDeliveryZoneInfo) : 0)
        : Math.max(0, manualDeliveryFee);
  const subtotalAfterDiscount = Math.max(subtotal - offerDiscountAmount - discountAmount, 0);
  const total = subtotalAfterDiscount + deliveryFee;
  const matchedOfferNames: string[] = Array.from(
    new Set(
      (offerEvaluation?.matched_offers ?? [])
        .map((offer: MatchedCatalogOffer) => offer.offer_name)
        .filter((offerName): offerName is string => typeof offerName === 'string' && offerName.trim().length > 0),
    ),
  );
  const deliveryFeeText =
    deliveryFeeStatus === 'resolved'
      ? `€${deliveryFee.toFixed(2)}`
      : deliveryFeeStatus === 'requires_selection'
        ? t('menu.cart.deliveryFeeNeedsExactAddress')
        : deliveryFeeStatus === 'out_of_zone'
          ? t('menu.cart.deliveryFeeOutOfZone')
          : deliveryFeeStatus === 'unavailable'
            ? t('menu.cart.deliveryFeeUnavailable')
            : t('menu.cart.calculatingDeliveryFee');

  const handleCheckout = async () => {
    if (cartItems.length === 0) return;

    if (orderType === 'delivery' && hasDeliveryPro && deliveryFeeStatus !== 'resolved') {
        if (!deliveryValidationTarget || !hasExactDeliveryCoordinates) {
          return;
        }

      try {
        const result = await validateDeliveryAddress(exactDeliveryCoordinates, subtotalAfterDiscount);
        setLocalDeliveryZoneInfo(result);
        if (getDeliveryFeeStatus(orderType, result, false) !== 'resolved') {
          return;
        }
      } catch (error) {
        console.error('[ProductCatalogModal] Failed to validate delivery fee before checkout:', error);
        return;
      }
    }

    setShowPaymentModal(true);
  };

  const handlePaymentComplete = (paymentData: any) => {
    setShowPaymentModal(false);
    onOrderComplete?.({
      items: cartItems.map(item => ({
        id: item.id,
        menu_item_id: item.id,
        product_id: item.id,
        product_name: item.name,
        name: item.name,
        quantity: item.cartQuantity,
        price: item.price,
        customizations: null
      })),
      total,
      customer: selectedCustomer,
      address: selectedAddress,
      orderType,
      paymentData,
      discountPercentage,
      discountAmount: discountAmount + offerDiscountAmount,
      deliveryFee,
      deliveryZoneInfo: effectiveDeliveryZoneInfo,
    });
    setCartItems([]);
    setOfferEvaluation(null);
    setDiscountPercentage(0);
    setManualDeliveryFee(0);
    setManualDeliveryFeeInput('');
    setLocalDeliveryZoneInfo(null);
  };

  if (!isOpen) return null;

  return (
    <>
      <LiquidGlassModal
        isOpen={isOpen}
        onClose={onClose}
        title={t('productCatalog.title', 'Product Catalog')}
        className="!max-w-[95vw] !w-[1400px] !h-[90vh]"
      >
        <div className="flex h-full gap-4">
          {/* Left: Product Grid */}
          <div className="flex-1 flex flex-col min-w-0">
            {/* Search and Filters */}
            <div className="flex gap-2 mb-4">
              <div className="relative flex-1">
                <Barcode className={`absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 transition-colors ${
                  scannerState.isScanning ? 'text-green-400 animate-pulse' : 'text-gray-400'
                }`} />
                <input
                  ref={barcodeInputRef}
                  type="text"
                  value={barcodeInput}
                  onChange={(e) => setBarcodeInput(e.target.value)}
                  onKeyDown={handleBarcodeScan}
                  placeholder={scannerState.isScanning
                    ? t('productCatalog.scanning', 'Scanning...')
                    : t('productCatalog.scanBarcode', 'Scan barcode or enter SKU...')}
                  className={`w-full pl-10 pr-4 py-2 rounded-lg bg-white/10 text-white border placeholder-gray-400 transition-colors ${
                    scannerState.isScanning
                      ? 'border-green-400/50 ring-1 ring-green-400/30'
                      : 'border-white/20'
                  }`}
                />
                {/* Scanner status indicator */}
                {scannerState.scanCount > 0 && (
                  <div className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-gray-400">
                    {t('productCatalog.scansCount', '{{count}} scans', { count: scannerState.scanCount })}
                  </div>
                )}
              </div>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                <input
                  type="text"
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  placeholder={t('productCatalog.search', 'Search products...')}
                  className="w-48 pl-10 pr-4 py-2 rounded-lg bg-white/10 text-white border border-white/20 placeholder-gray-400"
                />
              </div>
            </div>
            {/* Category Tabs */}
            <div className="flex gap-2 mb-4 overflow-x-auto pb-2">
              <button
                onClick={() => setCategoryFilter('all')}
                className={`px-4 py-2 rounded-lg whitespace-nowrap transition ${
                  categoryFilter === 'all'
                    ? 'bg-blue-600 text-white'
                    : 'bg-white/10 text-white hover:bg-white/20'
                }`}
              >
                {t('productCatalog.allProducts', 'All Products')}
              </button>
              {categories.map(cat => (
                <button
                  key={cat.id}
                  onClick={() => setCategoryFilter(cat.id)}
                  className={`px-4 py-2 rounded-lg whitespace-nowrap transition ${
                    categoryFilter === cat.id
                      ? 'bg-blue-600 text-white'
                      : 'bg-white/10 text-white hover:bg-white/20'
                  }`}
                >
                  {cat.name}
                </button>
              ))}
            </div>
            {/* Product Grid */}
            <div className="flex-1 overflow-y-auto scrollbar-hide">
              {isLoading ? (
                <div className="flex items-center justify-center h-full">
                  <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-white"></div>
                </div>
              ) : products.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full text-gray-400">
                  <Package className="w-16 h-16 mb-4" />
                  <p>{t('productCatalog.noProducts', 'No products found')}</p>
                </div>
              ) : (
                <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
                  {products.map(product => (
                    <button
                      key={product.id}
                      onClick={() => addToCart(product)}
                      className="p-4 rounded-xl bg-white/10 hover:bg-white/20 text-left transition group"
                    >
                      <div className="flex items-start justify-between mb-2">
                        <Package className="w-8 h-8 text-blue-400" />
                        {product.quantity <= product.lowStockThreshold && (
                          <span className="text-xs px-2 py-0.5 rounded bg-yellow-500/20 text-yellow-400">
                            {t('productCatalog.lowStock', 'Low Stock')}
                          </span>
                        )}
                      </div>
                      <h3 className="font-medium text-white truncate">{product.name}</h3>
                      <p className="text-sm text-gray-400 truncate">{product.sku}</p>
                      <div className="flex items-center justify-between mt-2">
                        <span className="text-lg font-bold text-green-400">
                          €{product.price.toFixed(2)}
                        </span>
                        <span className="text-sm text-gray-500">
                          {product.quantity} {t('productCatalog.inStock', 'in stock')}
                        </span>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
          {/* Right: Cart */}
          <div className="w-80 flex flex-col bg-white/5 rounded-xl p-4">
            <div className="flex items-center gap-2 mb-4">
              <ShoppingCart className="w-5 h-5 text-white" />
              <h3 className="text-lg font-semibold text-white">
                {t('productCatalog.cart', 'Cart')} ({cartItems.length})
              </h3>
            </div>
            {/* Customer Info */}
            {selectedCustomer && (
              <div className="p-3 mb-4 rounded-lg bg-white/10">
                <p className="text-sm text-gray-400">{t('productCatalog.customer', 'Customer')}</p>
                <p className="text-white font-medium">{selectedCustomer.name}</p>
                {selectedCustomer.phone && (
                  <p className="text-sm text-gray-400">{selectedCustomer.phone}</p>
                )}
              </div>
            )}
            {/* Cart Items */}
            <div className="flex-1 overflow-y-auto space-y-2 scrollbar-hide">
              {cartItems.length === 0 ? (
                <div className="text-center text-gray-400 py-8">
                  {t('productCatalog.emptyCart', 'Cart is empty')}
                </div>
              ) : (
                cartItems.map(item => (
                  <div key={item.id} className="p-3 rounded-lg bg-white/10">
                    <div className="flex justify-between items-start mb-2">
                      <div className="flex-1 min-w-0">
                        <span className="text-white font-medium truncate block">{item.name}</span>
                        {item.is_offer_reward && (
                          <div className="mt-1 flex items-center gap-1.5">
                            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] font-semibold text-emerald-300">
                              <Gift className="w-3 h-3" />
                              {t('menu.cart.autoOfferReward', 'Auto reward')}
                            </span>
                            {item.offer_name && (
                              <span className="text-[11px] text-gray-400 truncate">{item.offer_name}</span>
                            )}
                          </div>
                        )}
                      </div>
                      {!item.is_offer_reward && (
                        <button
                          onClick={() => removeFromCart(item.id)}
                          className="text-red-400 hover:text-red-300 ml-2"
                        >
                          <X className="w-4 h-4" />
                        </button>
                      )}
                    </div>
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => updateCartQuantity(item.id, -1)}
                          disabled={item.is_offer_reward}
                          className="w-7 h-7 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          <Minus className="w-4 h-4 text-white" />
                        </button>
                        <span className="text-white w-8 text-center">{item.cartQuantity}</span>
                        <button
                          onClick={() => updateCartQuantity(item.id, 1)}
                          disabled={item.is_offer_reward}
                          className="w-7 h-7 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          <Plus className="w-4 h-4 text-white" />
                        </button>
                      </div>
                      {item.is_offer_reward ? (
                        <span className="rounded-md bg-emerald-500/10 px-2 py-1 text-sm font-medium text-emerald-300">
                          {t('menu.cart.freeLabel', 'Free')}
                        </span>
                      ) : (
                        <span className="text-green-400 font-medium">
                          €{(item.price * item.cartQuantity).toFixed(2)}
                        </span>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
            {/* Discount */}
            {cartItems.length > 0 && maxDiscountPercentage > 0 && (
              <div className="mt-4 p-3 rounded-lg bg-white/10">
                <label className="text-sm text-gray-400 block mb-2">
                  {t('productCatalog.discount', 'Discount')} (max {maxDiscountPercentage}%)
                </label>
                <input
                  type="number"
                  min="0"
                  max={maxDiscountPercentage}
                  value={discountPercentage}
                  onChange={(e) => setDiscountPercentage(Math.min(maxDiscountPercentage, Math.max(0, Number(e.target.value))))}
                  className="w-full px-3 py-2 rounded-lg bg-white/10 text-white border border-white/20"
                />
              </div>
            )}
            {/* Totals */}
            <div className="mt-4 pt-4 border-t border-white/20">
              <div className="flex justify-between text-gray-400 mb-1">
                <span>{t('productCatalog.subtotal', 'Subtotal')}</span>
                <span>€{subtotal.toFixed(2)}</span>
              </div>
              {offerDiscountAmount > 0 && (
                <div className="flex justify-between text-emerald-400 mb-1">
                  <span>
                    {matchedOfferNames.length > 0
                      ? t('menu.cart.offerDiscountWithNames', 'Offers ({{names}})', {
                          names: matchedOfferNames.join(', '),
                        })
                      : t('menu.cart.offerDiscount', 'Offers')}
                  </span>
                  <span>-€{offerDiscountAmount.toFixed(2)}</span>
                </div>
              )}
              {discountAmount > 0 && (
                <div className="flex justify-between text-red-400 mb-1">
                  <span>{t('productCatalog.discountLabel', 'Discount')}</span>
                  <span>-€{discountAmount.toFixed(2)}</span>
                </div>
              )}
              {orderType === 'delivery' && (
                <div className="flex justify-between text-gray-400 mb-1">
                  <span>{t('menu.cart.deliveryFee')}</span>
                  {hasDeliveryPro ? (
                    <span>{deliveryFeeText}</span>
                  ) : (
                    <input
                      type="text"
                      inputMode="decimal"
                      value={manualDeliveryFeeInput}
                      onChange={(event) => {
                        const formatted = formatMoneyInputWithCents(event.target.value)
                        setManualDeliveryFeeInput(formatted)
                        setManualDeliveryFee(parseMoneyInputValue(formatted))
                      }}
                      placeholder={t('menu.cart.manualDeliveryFeePlaceholder', '0,00')}
                      className="w-24 rounded-lg border bg-white/10 px-2 py-1 text-right text-white border-white/20 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  )}
                </div>
              )}
              <div className="flex justify-between text-white text-xl font-bold mt-2">
                <span>{t('productCatalog.total', 'Total')}</span>
                <span>€{total.toFixed(2)}</span>
              </div>
            </div>
            {/* Checkout Button */}
            <button
              onClick={() => void handleCheckout()}
              disabled={
                cartItems.length === 0 ||
                isProcessingOrder ||
                (orderType === 'delivery' && hasDeliveryPro && deliveryFeeStatus !== 'resolved')
              }
              className="mt-4 w-full py-3 rounded-xl bg-green-600 hover:bg-green-700 disabled:bg-gray-600 disabled:cursor-not-allowed text-white font-semibold flex items-center justify-center gap-2 transition"
            >
              <DollarSign className="w-5 h-5" />
              {isProcessingOrder 
                ? t('productCatalog.processing', 'Processing...')
                : t('productCatalog.checkout', 'Checkout')
              }
            </button>
          </div>
        </div>
      </LiquidGlassModal>
      {/* Payment Modal */}
      <PaymentModal
        isOpen={showPaymentModal}
        onClose={() => setShowPaymentModal(false)}
        orderTotal={total}
        discountAmount={discountAmount + offerDiscountAmount}
        deliveryFee={deliveryFee}
        orderType={orderType}
        minimumOrderAmount={hasDeliveryPro ? (effectiveDeliveryZoneInfo?.zone?.minimumOrderAmount ?? 0) : 0}
        onPaymentComplete={handlePaymentComplete}
      />
    </>
  );
};

export default ProductCatalogModal;
