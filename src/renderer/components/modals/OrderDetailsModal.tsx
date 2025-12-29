import React, { useState, useEffect } from "react";
import { useTranslation } from 'react-i18next';
import { useTheme } from '../../contexts/theme-context';
import { Package, MapPin, User, Clock, CreditCard, ChevronRight, X, Printer, Truck, Phone, Building, FileText, History } from 'lucide-react';
import { toast } from 'react-hot-toast';

interface OrderDetailsModalProps {
  isOpen: boolean;
  orderId: string;
  order?: any;
  onClose: () => void;
  onPrintReceipt?: () => void;
  onShowCustomerHistory?: (customerPhone: string) => void;
}

const OrderDetailsModal: React.FC<OrderDetailsModalProps> = ({
  isOpen,
  orderId,
  order,
  onClose,
  onPrintReceipt,
  onShowCustomerHistory,
}) => {
  const { t } = useTranslation();
  const { resolvedTheme } = useTheme();
  const [orderData, setOrderData] = useState<any>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (isOpen && orderId && !order) {
      loadOrderData();
    } else if (order) {
      setOrderData(order);
    }
  }, [isOpen, orderId, order]);

  const loadOrderData = async () => {
    try {
      setLoading(true);
      const api = (window as any).electronAPI;
      const result = await api?.getOrderById?.(orderId);
      if (result) {
        setOrderData(result);
      }
    } catch (error) {
      console.error('Error loading order:', error);
      toast.error(t('errors.loadOrderFailed') || 'Failed to load order');
    } finally {
      setLoading(false);
    }
  };

  if (!isOpen) return null;

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat('el-GR', {
      style: 'currency',
      currency: 'EUR'
    }).format(amount || 0);
  };

  const getStatusColor = (status: string) => {
    switch (status?.toLowerCase()) {
      case 'pending': return 'bg-yellow-500/20 text-yellow-600 dark:text-yellow-400 border-yellow-500/30';
      case 'processing':
      case 'preparing': return 'bg-blue-500/20 text-blue-600 dark:text-blue-400 border-blue-500/30';
      case 'ready': return 'bg-purple-500/20 text-purple-600 dark:text-purple-400 border-purple-500/30';
      case 'completed':
      case 'delivered': return 'bg-green-500/20 text-green-600 dark:text-green-400 border-green-500/30';
      case 'cancelled': return 'bg-red-500/20 text-red-600 dark:text-red-400 border-red-500/30';
      default: return 'bg-gray-500/20 text-gray-600 dark:text-gray-400 border-gray-500/30';
    }
  };

  const getOrderTypeLabel = (type: string) => {
    switch (type?.toLowerCase()) {
      case 'delivery': return t('orderDashboard.delivery') || 'Παράδοση';
      case 'pickup': return t('orderDashboard.pickup') || 'Παραλαβή';
      case 'dine-in': return t('orderDashboard.dineIn') || 'Εντός χώρου';
      default: return type;
    }
  };

  const getPaymentMethodLabel = (method: string) => {
    switch (method?.toLowerCase()) {
      case 'card': return t('modals.orderDetails.card') || 'Κάρτα';
      case 'cash': return t('modals.orderDetails.cash') || 'Μετρητά';
      case 'digital':
      case 'digital_wallet': return t('modals.orderDetails.digital') || 'Ψηφιακό';
      default: return method || t('modals.orderDetails.pending') || 'Αναμονή';
    }
  };

  const getPaymentMethodIcon = (method: string) => {
    switch (method?.toLowerCase()) {
      case 'card': return '💳';
      case 'cash': return '💵';
      case 'digital':
      case 'digital_wallet': return '📱';
      default: return '⏳';
    }
  };

  // Use real data or fallback to default values
  const displayOrder = orderData || order || {};
  const items = displayOrder.items || displayOrder.order_items || [];
  const customer = displayOrder.customer || {};

  // Get customer info from various sources
  const customerName = customer.name || displayOrder.customer_name || '';
  const customerPhone = customer.phone || displayOrder.customer_phone || '';

  // Build delivery address object from various field patterns
  // Check for any delivery address field to determine if we have address data
  const hasDeliveryAddress = displayOrder.delivery_address || 
    displayOrder.delivery_city || 
    displayOrder.delivery_postal_code || 
    displayOrder.delivery_floor ||
    displayOrder.delivery_notes ||
    displayOrder.name_on_ringer;
    
  const deliveryAddress = hasDeliveryAddress ? {
    address: typeof displayOrder.delivery_address === 'string' ? displayOrder.delivery_address : (displayOrder.delivery_address?.address || ''),
    city: displayOrder.delivery_city || displayOrder.delivery_address?.city || '',
    postal_code: displayOrder.delivery_postal_code || displayOrder.delivery_address?.postal_code || '',
    floor: displayOrder.delivery_floor || displayOrder.delivery_address?.floor || '',
    notes: displayOrder.delivery_notes || displayOrder.delivery_address?.notes || '',
    name_on_ringer: displayOrder.name_on_ringer || displayOrder.delivery_address?.name_on_ringer || '',
  } : {};

  const subtotal = displayOrder.subtotal || 0;
  const tax = displayOrder.tax || displayOrder.tax_amount || 0;
  const deliveryFee = displayOrder.delivery_fee || 0;
  const discountAmount = displayOrder.discount_amount || 0;
  const total = displayOrder.total || displayOrder.total_amount || 0;
  const status = displayOrder.status || 'pending';
  const orderType = displayOrder.order_type || displayOrder.orderType || 'delivery';
  const paymentMethod = displayOrder.payment_method || displayOrder.paymentMethod || '';
  const paymentStatus = displayOrder.payment_status || displayOrder.paymentStatus || 'pending';
  const createdAt = displayOrder.created_at ? new Date(displayOrder.created_at) : new Date();

  // Driver info for delivered orders
  const driverName = displayOrder.driver_name || displayOrder.driverName || '';
  const driverId = displayOrder.driver_id || displayOrder.driverId || '';
  const isDelivered = status?.toLowerCase() === 'completed' || status?.toLowerCase() === 'delivered';
  const isDeliveryOrder = orderType?.toLowerCase() === 'delivery';

  // Parse customizations/ingredients with prices
  // Edge Case Handling (Requirements 5.3, 5.5):
  // - Returns empty array when customizations is null/undefined
  // - Handles malformed JSON strings gracefully without crashing
  const parseCustomizations = (customizations: any): { name: string; price: number }[] => {
    // Handle null/undefined - return empty array (Requirement 5.3)
    if (customizations === null || customizations === undefined) return [];

    const parsePrice = (val: any): number => {
      if (val === null || val === undefined) return 0;
      const num = typeof val === 'string' ? parseFloat(val) : Number(val);
      return isNaN(num) ? 0 : num;
    };

    const extractPrice = (c: any): number => {
      // Check ingredient object first
      if (c.ingredient) {
        const ing = c.ingredient;
        const pickupPrice = parsePrice(ing.pickup_price);
        const deliveryPrice = parsePrice(ing.delivery_price);
        const price = parsePrice(ing.price);
        const basePrice = parsePrice(ing.base_price);

        // Return appropriate price based on order type
        if (orderType === 'delivery' && deliveryPrice > 0) return deliveryPrice;
        if (orderType === 'pickup' && pickupPrice > 0) return pickupPrice;
        if (price > 0) return price;
        if (basePrice > 0) return basePrice;
      }

      // Check direct price fields
      const directPrice = parsePrice(c.price);
      const additionalPrice = parsePrice(c.additionalPrice);
      const extraPrice = parsePrice(c.extra_price);

      if (directPrice > 0) return directPrice;
      if (additionalPrice > 0) return additionalPrice;
      if (extraPrice > 0) return extraPrice;

      return 0;
    };

    const extractName = (c: any): string => {
      if (c.ingredient?.name) return c.ingredient.name;
      if (c.ingredient?.name_en) return c.ingredient.name_en;
      if (c.ingredient?.name_el) return c.ingredient.name_el;
      if (c.name) return c.name;
      if (c.name_en) return c.name_en;
      if (c.name_el) return c.name_el;
      if (c.optionName) return c.optionName;
      if (c.label) return c.label;
      return 'Unknown';
    };

    // Handle JSON string format - parse it first (Requirement 5.5)
    let parsedCustomizations = customizations;
    if (typeof customizations === 'string') {
      const trimmed = customizations.trim();
      if (!trimmed) return [];
      try {
        parsedCustomizations = JSON.parse(trimmed);
      } catch {
        // Malformed JSON - return empty array without crashing
        return [];
      }
    }

    if (Array.isArray(parsedCustomizations)) {
      return parsedCustomizations
        .filter((c: any) => c && (c.ingredient || c.name || c.name_en))
        .map((c: any) => ({
          name: extractName(c),
          price: extractPrice(c)
        }));
    }
    if (typeof parsedCustomizations === 'object' && parsedCustomizations !== null) {
      return Object.values(parsedCustomizations)
        .filter((c: any) => c && (c.ingredient || c.name || c.name_en))
        .map((c: any) => ({
          name: extractName(c),
          price: extractPrice(c)
        }));
    }
    return [];
  };

  return (
    <>
      {/* Backdrop */}
      <div
        className="liquid-glass-modal-backdrop fixed inset-0 z-[1000]"
        onClick={onClose}
      />

      {/* Modal Container */}
      <div className="liquid-glass-modal-shell fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-4xl max-h-[90vh] z-[1050] flex flex-col">

        {/* Header */}
        <div className="flex-shrink-0 px-6 py-4 border-b liquid-glass-modal-border">
          <div className="flex justify-between items-start gap-4">
            <div className="flex-1">
              <h2 className="text-2xl font-bold liquid-glass-modal-text">
                {t('modals.orderDetails.title') || 'Order Details'}
              </h2>
              <div className="flex items-center gap-3 mt-2 flex-wrap">
                <span className="text-sm liquid-glass-modal-text-muted">
                  {t('modals.orderDetails.orderNumber') || 'Order'} #{displayOrder.order_number || orderId}
                </span>
                <span className="text-xs liquid-glass-modal-text-muted">
                  {createdAt.toLocaleDateString('el-GR')} {createdAt.toLocaleTimeString('el-GR', { hour: '2-digit', minute: '2-digit' })}
                </span>
                <span className={`text-xs px-3 py-1 rounded-full border ${getStatusColor(status)}`}>
                  {status?.toUpperCase() || 'PENDING'}
                </span>
              </div>
            </div>
            <button
              onClick={onClose}
              className="liquid-glass-modal-button p-2 min-h-0 min-w-0 shrink-0"
              aria-label={t('common.actions.close')}
            >
              <X className="w-6 h-6" />
            </button>
          </div>
        </div>

        {/* Scrollable Content */}
        <div className="flex-1 overflow-y-auto overflow-x-hidden px-6 py-4 min-h-0">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500"></div>
            </div>
          ) : (
            <div className="space-y-6">

              {/* Order Type & Payment Banner */}
              <div className="liquid-glass-modal-card">
                <div className="flex items-center justify-between flex-wrap gap-4">
                  <div className="flex items-center gap-3">
                    <div className={`p-2 rounded-lg ${isDeliveryOrder ? 'bg-orange-500/20 text-orange-400' : 'bg-blue-500/20 text-blue-400'}`}>
                      {isDeliveryOrder ? <Truck className="w-5 h-5" /> : <Clock className="w-5 h-5" />}
                    </div>
                    <div>
                      <h3 className="font-semibold liquid-glass-modal-text">
                        {getOrderTypeLabel(orderType)}
                      </h3>
                      <p className="text-sm liquid-glass-modal-text-muted">
                        {isDeliveryOrder && deliveryAddress?.address
                          ? deliveryAddress.address
                          : t('modals.orderDetails.processing') || 'Processing'}
                      </p>
                    </div>
                  </div>
                  {/* Payment Method */}
                  <div className="flex items-center gap-2 px-4 py-2 rounded-lg bg-white/5 border border-white/10">
                    <span className="text-xl">{getPaymentMethodIcon(paymentMethod)}</span>
                    <div>
                      <p className="font-medium liquid-glass-modal-text">{getPaymentMethodLabel(paymentMethod)}</p>
                      <p className="text-xs liquid-glass-modal-text-muted capitalize">{paymentStatus}</p>
                    </div>
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                {/* Left Column: Customer, Delivery & Driver Info */}
                <div className="md:col-span-1 space-y-6">

                  {/* Customer Card */}
                  <div className="liquid-glass-modal-card">
                    <div className="flex items-center justify-between mb-4">
                      <h4 className="flex items-center gap-2 text-sm font-bold uppercase tracking-wider liquid-glass-modal-text-muted">
                        <User className="w-4 h-4" />
                        {t('modals.orderDetails.customerInformation') || 'Customer'}
                      </h4>
                      {/* Customer History Button */}
                      {isDeliveryOrder && customerPhone && onShowCustomerHistory && (
                        <button
                          onClick={() => onShowCustomerHistory(customerPhone)}
                          className="flex items-center gap-1 px-2 py-1 text-xs rounded-lg bg-blue-500/20 text-blue-400 hover:bg-blue-500/30 transition-colors border border-blue-500/30"
                        >
                          <History className="w-3 h-3" />
                          {t('modals.orderDetails.history') || 'History'}
                        </button>
                      )}
                    </div>
                    <div className="space-y-3">
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-full bg-gradient-to-br from-purple-500 to-indigo-600 flex items-center justify-center text-white font-bold text-lg shadow-lg">
                          {customerName ? customerName.charAt(0).toUpperCase() : '?'}
                        </div>
                        <div>
                          <div className="font-semibold liquid-glass-modal-text">
                            {customerName || t('modals.orderDetails.guestCustomer') || 'Guest'}
                          </div>
                          {customerPhone && (
                            <div className="flex items-center gap-1 text-sm liquid-glass-modal-text-muted">
                              <Phone className="w-3 h-3" />
                              {customerPhone}
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Delivery Address Card - Show only for delivery orders */}
                  {isDeliveryOrder && (
                    <div className="liquid-glass-modal-card">
                      <h4 className="flex items-center gap-2 text-sm font-bold uppercase tracking-wider liquid-glass-modal-text-muted mb-4">
                        <MapPin className="w-4 h-4" />
                        {t('modals.orderDetails.deliveryAddress') || 'Delivery Address'}
                      </h4>
                      <div className="p-3 bg-white/5 dark:bg-black/20 rounded-lg border border-white/10 dark:border-white/5 space-y-2">
                        {/* Main Address */}
                        <p className="font-medium liquid-glass-modal-text">
                          {deliveryAddress.address || t('modals.orderDetails.noAddress') || 'No address'}
                        </p>

                        {/* City & Postal Code */}
                        {(deliveryAddress.city || deliveryAddress.postal_code) && (
                          <div className="flex items-center gap-2 text-sm liquid-glass-modal-text-muted">
                            <Building className="w-3 h-3" />
                            <span>
                              {[deliveryAddress.city, deliveryAddress.postal_code].filter(Boolean).join(', ')}
                            </span>
                          </div>
                        )}

                        {/* Floor */}
                        {deliveryAddress.floor && (
                          <div className="flex items-center gap-2 text-sm liquid-glass-modal-text-muted">
                            <span className="text-xs">🏢</span>
                            <span>{t('modals.orderDetails.floor') || 'Floor'}: {deliveryAddress.floor}</span>
                          </div>
                        )}

                        {/* Name on Ringer */}
                        {deliveryAddress.name_on_ringer && (
                          <div className="flex items-center gap-2 text-sm liquid-glass-modal-text-muted">
                            <span className="text-xs">🔔</span>
                            <span>{t('modals.orderDetails.nameOnRinger') || 'Bell'}: {deliveryAddress.name_on_ringer}</span>
                          </div>
                        )}

                        {/* Delivery Notes */}
                        {deliveryAddress.notes && (
                          <div className="mt-3 pt-3 border-t border-white/10">
                            <div className="flex items-start gap-2 text-sm">
                              <FileText className="w-3 h-3 mt-0.5 text-yellow-400" />
                              <span className="liquid-glass-modal-text-muted italic">
                                {deliveryAddress.notes}
                              </span>
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Driver Info - Show for delivered orders */}
                  {isDeliveryOrder && isDelivered && (driverName || driverId) && (
                    <div className="liquid-glass-modal-card">
                      <h4 className="flex items-center gap-2 text-sm font-bold uppercase tracking-wider liquid-glass-modal-text-muted mb-4">
                        <Truck className="w-4 h-4" />
                        {t('modals.orderDetails.deliveredBy') || 'Delivered By'}
                      </h4>
                      <div className="p-3 bg-green-500/10 rounded-lg border border-green-500/20">
                        <div className="flex items-center gap-3">
                          <div className="w-10 h-10 rounded-full bg-gradient-to-br from-green-500 to-teal-600 flex items-center justify-center text-white font-bold text-lg shadow-lg">
                            {driverName ? driverName.charAt(0).toUpperCase() : '🚗'}
                          </div>
                          <div>
                            <div className="font-semibold liquid-glass-modal-text">
                              {driverName || `Driver ${driverId?.slice(-6) || ''}`}
                            </div>
                            <div className="text-xs text-green-400">
                              ✓ {t('modals.orderDetails.delivered') || 'Delivered'}
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  )}

                </div>

                {/* Right Column: Order Items */}
                <div className="md:col-span-2">
                  <div className="liquid-glass-modal-card h-full flex flex-col">
                    <h4 className="flex items-center gap-2 text-sm font-bold uppercase tracking-wider liquid-glass-modal-text-muted mb-4">
                      <Package className="w-4 h-4" />
                      {t('modals.orderDetails.orderItems') || 'Items'}
                    </h4>

                    <div className="flex-1 overflow-y-auto pr-2 space-y-3 custom-scrollbar">
                      {items.length > 0 ? (
                        items.map((item: any, index: number) => {
                          const customizations = parseCustomizations(item.customizations);
                          // Show subcategory with fallback to item name
                          const itemSubcategory = item.subcategory?.name || item.subcategory?.name_en || item.subcategory?.name_el || item.category_name || '';

                          return (
                            <div
                              key={item.id || index}
                              className="p-4 bg-white/5 dark:bg-white/5 rounded-lg border border-white/10 hover:bg-white/10 transition-colors"
                            >
                              {/* Item Header */}
                              <div className="flex items-start justify-between mb-2">
                                <div className="flex items-start gap-3 flex-1">
                                  <div className="w-8 h-8 rounded-md bg-orange-500/20 text-orange-400 flex items-center justify-center font-bold text-sm border border-orange-500/20 flex-shrink-0">
                                    {item.quantity || 1}x
                                  </div>
                                  <div className="flex-1">
                                    <div className="font-medium liquid-glass-modal-text">
                                      {item.name || item.menu_item?.name || 'Item'}
                                    </div>
                                    {itemSubcategory && (
                                      <div className="text-xs liquid-glass-modal-text-muted">
                                        {itemSubcategory}
                                      </div>
                                    )}
                                    {/* Show subcategory ID for debugging if name is missing */}
                                    {!itemSubcategory && item.menu_item_id && (
                                      <div className="text-xs liquid-glass-modal-text-muted opacity-50">
                                        Item ID: {item.menu_item_id.slice(-8)}
                                      </div>
                                    )}
                                  </div>
                                </div>
                                <div className="text-right">
                                  <div className="font-semibold liquid-glass-modal-text">
                                    {formatCurrency(item.total_price || item.price || 0)}
                                  </div>
                                  <div className="text-xs liquid-glass-modal-text-muted">
                                    @ {formatCurrency(item.unit_price || item.price || 0)}
                                  </div>
                                </div>
                              </div>

                              {/* Customizations/Ingredients */}
                              {customizations.length > 0 && (
                                <div className="ml-11 mt-2 space-y-1 border-l-2 border-green-500/30 pl-3">
                                  {customizations.map((c, idx) => (
                                    <div key={idx} className="flex justify-between text-xs">
                                      <span className="flex items-center gap-1 liquid-glass-modal-text-muted">
                                        <span className="text-green-400">+</span> {c.name}
                                      </span>
                                      {c.price > 0 && (
                                        <span className="text-green-400 font-medium">+{formatCurrency(c.price)}</span>
                                      )}
                                    </div>
                                  ))}
                                </div>
                              )}

                              {/* Item Notes */}
                              {item.notes && (
                                <div className="ml-11 mt-2 text-xs liquid-glass-modal-text-muted italic flex items-center gap-1">
                                  <span>📝</span> {item.notes}
                                </div>
                              )}
                            </div>
                          );
                        })
                      ) : (
                        <div className="text-center py-8 liquid-glass-modal-text-muted">
                          {t('modals.orderDetails.noItems') || 'No items in order'}
                        </div>
                      )}
                    </div>

                    {/* Totals Section */}
                    <div className="mt-6 pt-6 border-t border-gray-200/50 dark:border-gray-700/50 space-y-2">
                      <div className="flex justify-between text-sm liquid-glass-modal-text-muted">
                        <span>{t('modals.orderDetails.subtotal') || 'Subtotal'}</span>
                        <span>{formatCurrency(subtotal)}</span>
                      </div>
                      {tax > 0 && (
                        <div className="flex justify-between text-sm liquid-glass-modal-text-muted">
                          <span>{t('modals.orderDetails.tax') || 'Tax'}</span>
                          <span>{formatCurrency(tax)}</span>
                        </div>
                      )}
                      {deliveryFee > 0 && (
                        <div className="flex justify-between text-sm liquid-glass-modal-text-muted">
                          <span>{t('modals.orderDetails.deliveryFee') || 'Delivery Fee'}</span>
                          <span>{formatCurrency(deliveryFee)}</span>
                        </div>
                      )}
                      {discountAmount > 0 && (
                        <div className="flex justify-between text-sm text-green-400">
                          <span>{t('modals.orderDetails.discount') || 'Discount'}</span>
                          <span>-{formatCurrency(discountAmount)}</span>
                        </div>
                      )}
                      <div className="flex justify-between items-end pt-2 border-t border-dashed border-gray-300 dark:border-gray-600">
                        <span className="font-bold text-lg liquid-glass-modal-text">
                          {t('modals.orderDetails.total') || 'Total'}
                        </span>
                        <span className="font-bold text-2xl text-blue-600 dark:text-blue-400">
                          {formatCurrency(total)}
                        </span>
                      </div>
                    </div>

                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Footer with Actions */}
        <div className="flex-shrink-0 px-6 py-4 border-t liquid-glass-modal-border bg-white/5 dark:bg-black/20">
          <div className="grid grid-cols-2 gap-3">
            {onPrintReceipt && (
              <button
                onClick={onPrintReceipt}
                className="liquid-glass-modal-button w-full gap-2"
              >
                <Printer className="w-4 h-4" />
                {t('modals.orderDetails.printReceipt') || 'Print Receipt'}
              </button>
            )}
            <button
              onClick={onClose}
              className="liquid-glass-modal-button w-full gap-2 bg-blue-600/20 hover:bg-blue-600/30 text-blue-400 border-blue-500/30"
            >
              {t('common.actions.close') || 'Close'}
            </button>
          </div>
        </div>

      </div>
    </>
  );
};

export default OrderDetailsModal;
