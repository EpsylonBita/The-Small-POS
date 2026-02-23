/**
 * ProductCatalogModal - POS Product Selection Modal for Retail Vertical
 * 
 * A modal version of the ProductCatalog for order flow.
 * Supports barcode scanning and cart functionality.
 */

import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { X, Package, Search, Barcode, Plus, Minus, ShoppingCart, DollarSign } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../../contexts/theme-context';
import { useModules } from '../../contexts/module-context';
import { useProductCatalog } from '../../hooks/useProductCatalog';
import { useDiscountSettings } from '../../hooks/useDiscountSettings';
import { useOnBarcodeScan, useBarcodeScannerContext } from '../../contexts/barcode-scanner-context';
import { LiquidGlassModal } from '../ui/pos-glass-components';
import { PaymentModal } from './PaymentModal';
import type { Product, ProductFilters } from '../../services/ProductCatalogService';
import type { DeliveryBoundaryValidationResponse } from '../../../shared/types/delivery-validation';
import { offEvent, onEvent } from '../../../lib';
import {
  getCachedTerminalCredentials,
  refreshTerminalCredentialCache,
} from '../../services/terminal-credentials';

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
  const { state: scannerState } = useBarcodeScannerContext();
  const isDark = resolvedTheme === 'dark';

  const [branchId, setBranchId] = useState<string | null>(null);
  const [localOrgId, setLocalOrgId] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const [barcodeInput, setBarcodeInput] = useState('');
  const [cartItems, setCartItems] = useState<CartItem[]>([]);
  const [showPaymentModal, setShowPaymentModal] = useState(false);
  const [discountPercentage, setDiscountPercentage] = useState<number>(0);
  const barcodeInputRef = useRef<HTMLInputElement>(null);

  // Debounce search term to avoid excessive API calls (300ms delay)
  const debouncedSearchTerm = useDebounce(searchTerm, 300);

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

  // Focus barcode input when modal opens
  useEffect(() => {
    if (isOpen) {
      setTimeout(() => barcodeInputRef.current?.focus(), 100);
    }
  }, [isOpen]);

  // Add to cart function (defined before barcode handlers)
  const addToCart = useCallback((product: Product) => {
    setCartItems(prev => {
      const existing = prev.find(item => item.id === product.id);
      if (existing) {
        return prev.map(item =>
          item.id === product.id
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
      .map(item => item.id === productId
        ? { ...item, cartQuantity: Math.max(0, item.cartQuantity + delta) }
        : item
      )
      .filter(item => item.cartQuantity > 0)
    );
  };

  const removeFromCart = (productId: string) => {
    setCartItems(prev => prev.filter(item => item.id !== productId));
  };

  const subtotal = cartItems.reduce((sum, item) => sum + (item.price * item.cartQuantity), 0);
  const discountAmount = subtotal * (discountPercentage / 100);
  const total = subtotal - discountAmount;

  const handleCheckout = () => {
    if (cartItems.length === 0) return;
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
      discountAmount
    });
    setCartItems([]);
    setDiscountPercentage(0);
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
            <div className="flex-1 overflow-y-auto">
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
            <div className="flex-1 overflow-y-auto space-y-2">
              {cartItems.length === 0 ? (
                <div className="text-center text-gray-400 py-8">
                  {t('productCatalog.emptyCart', 'Cart is empty')}
                </div>
              ) : (
                cartItems.map(item => (
                  <div key={item.id} className="p-3 rounded-lg bg-white/10">
                    <div className="flex justify-between items-start mb-2">
                      <span className="text-white font-medium truncate flex-1">{item.name}</span>
                      <button
                        onClick={() => removeFromCart(item.id)}
                        className="text-red-400 hover:text-red-300 ml-2"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => updateCartQuantity(item.id, -1)}
                          className="w-7 h-7 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center"
                        >
                          <Minus className="w-4 h-4 text-white" />
                        </button>
                        <span className="text-white w-8 text-center">{item.cartQuantity}</span>
                        <button
                          onClick={() => updateCartQuantity(item.id, 1)}
                          className="w-7 h-7 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center"
                        >
                          <Plus className="w-4 h-4 text-white" />
                        </button>
                      </div>
                      <span className="text-green-400 font-medium">
                        €{(item.price * item.cartQuantity).toFixed(2)}
                      </span>
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
              {discountAmount > 0 && (
                <div className="flex justify-between text-red-400 mb-1">
                  <span>{t('productCatalog.discountLabel', 'Discount')}</span>
                  <span>-€{discountAmount.toFixed(2)}</span>
                </div>
              )}
              <div className="flex justify-between text-white text-xl font-bold mt-2">
                <span>{t('productCatalog.total', 'Total')}</span>
                <span>€{total.toFixed(2)}</span>
              </div>
            </div>
            {/* Checkout Button */}
            <button
              onClick={handleCheckout}
              disabled={cartItems.length === 0 || isProcessingOrder}
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
        discountAmount={discountAmount}
        orderType={orderType}
        onPaymentComplete={handlePaymentComplete}
      />
    </>
  );
};

export default ProductCatalogModal;

