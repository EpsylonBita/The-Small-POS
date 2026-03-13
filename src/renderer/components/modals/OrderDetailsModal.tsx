import React, { useState, useEffect } from "react";
import { useTranslation } from 'react-i18next';
import { useTheme } from '../../contexts/theme-context';
import { LiquidGlassModal } from '../ui/pos-glass-components';
import { Package, MapPin, User, Clock, CreditCard, ChevronRight, X, Printer, Truck, Phone, Building, FileText, History, Banknote, Smartphone, Bell, Layers, Car, CheckCircle, RotateCcw, Split } from 'lucide-react';
import { toast } from 'react-hot-toast';
import { getOrderStatusBadgeClasses } from '../../utils/orderStatus';
import { formatCurrency, formatDate, formatTime } from '../../utils/format';
import { normalizeOrderTypeForDisplay, resolveOrderDisplayTitle } from '../../utils/orderDisplay';
import RefundVoidModal from './RefundVoidModal';
import { SplitPaymentModal } from './SplitPaymentModal';
import type { SplitPaymentResult } from './SplitPaymentModal';
import { getBridge } from '../../../lib';

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
  const bridge = getBridge();
  const { t } = useTranslation();
  const { resolvedTheme } = useTheme();
  const [orderData, setOrderData] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [showRefundModal, setShowRefundModal] = useState(false);
  const [showSplitPaymentModal, setShowSplitPaymentModal] = useState(false);

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
      const result = await bridge.orders.getById(orderId);
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


  const getStatusColor = (status: string) => getOrderStatusBadgeClasses(status);

  const getOrderTypeLabel = (type: string) => {
    switch (type?.toLowerCase()) {
      case 'delivery': return t('orderDashboard.delivery', { defaultValue: 'Delivery' });
      case 'pickup': return t('orderDashboard.pickup', { defaultValue: 'Pickup' });
      case 'dine-in': return t('orderDashboard.dineIn', { defaultValue: 'Dine In' });
      default: return type;
    }
  };

  const getPaymentMethodLabel = (method: string) => {
    switch (method?.toLowerCase()) {
      case 'card': return t('modals.orderDetails.card', { defaultValue: 'Card' });
      case 'cash': return t('modals.orderDetails.cash', { defaultValue: 'Cash' });
      case 'digital':
      case 'digital_wallet': return t('modals.orderDetails.digital', { defaultValue: 'Digital' });
      default: return method || t('modals.orderDetails.pending', { defaultValue: 'Pending' });
    }
  };

  const getPaymentMethodIcon = (method: string): React.ReactNode => {
    switch (method?.toLowerCase()) {
      case 'card': return <CreditCard className="h-5 w-5 text-blue-400" />;
      case 'cash': return <Banknote className="h-5 w-5 text-green-400" />;
      case 'digital':
      case 'digital_wallet': return <Smartphone className="h-5 w-5 text-purple-400" />;
      default: return <Clock className="h-5 w-5 text-gray-400" />;
    }
  };

  // Use real data or fallback to default values
  const displayOrder = orderData || order || {};
  const items = displayOrder.items || displayOrder.order_items || [];
  const customer = displayOrder.customer || {};
  const orderType = normalizeOrderTypeForDisplay(
    displayOrder.order_type || displayOrder.orderType || 'delivery',
  );

  // Get customer info from various sources (snake_case from prop, camelCase from Rust backend)
  const customerName = resolveOrderDisplayTitle({
    orderType,
    customerName: customer.name || displayOrder.customer_name || displayOrder.customerName || '',
    pickupLabel: t('orders.type.pickup', { defaultValue: 'Pickup' }),
    fallbackLabel: t('modals.orderDetails.guestCustomer', { defaultValue: 'Guest' }),
  });
  const customerPhone = customer.phone || displayOrder.customer_phone || displayOrder.customerPhone || '';

  // Build delivery address object from various field patterns
  // Rust backend returns camelCase (deliveryCity), props may use snake_case (delivery_city)
  const normalizeText = (value: any): string => typeof value === 'string' ? value.trim() : '';
  const parsePackedDeliveryAddress = (value: string) => {
    const segments = value
      .split(/[\n|,]+/)
      .map((entry) => entry.trim())
      .filter(Boolean);

    const firstLine = segments[0] || '';
    let city = '';
    let postalCode = '';
    let floor = '';

    const extractPostal = (segment: string): string => {
      const compact = segment.replace(/\s+/g, '');
      const fullMatch = compact.match(/\b\d{5}\b/);
      if (fullMatch) return fullMatch[0];
      const splitMatch = segment.match(/\b(\d{3})\s*(\d{2})\b/);
      return splitMatch ? `${splitMatch[1]}${splitMatch[2]}` : '';
    };
    const extractFloor = (segment: string): string => {
      const floorMatch = segment.match(/(?:floor|όροφος|οροφος|όρ\.?)\s*:?\s*(\d+)/i);
      return floorMatch?.[1] || '';
    };
    const extractCity = (segment: string): string => {
      if (/(?:floor|όροφος|οροφος|όρ\.?)/i.test(segment)) return '';
      return segment
        .replace(/\d+/g, ' ')
        .replace(/[,:;|_-]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    };

    for (const segment of segments.slice(1)) {
      if (!postalCode) postalCode = extractPostal(segment);
      if (!floor) floor = extractFloor(segment);
      if (!city) city = extractCity(segment);
    }

    return { firstLine, city, postalCode, floor };
  };

  const rawAddress = displayOrder.delivery_address || displayOrder.deliveryAddress;
  const rawCity = displayOrder.delivery_city || displayOrder.deliveryCity || '';
  const rawPostalCode = displayOrder.delivery_postal_code || displayOrder.deliveryPostalCode || '';
  const rawFloor = displayOrder.delivery_floor || displayOrder.deliveryFloor || '';
  const rawNotes = displayOrder.delivery_notes || displayOrder.deliveryNotes || '';
  const rawRinger = displayOrder.name_on_ringer || displayOrder.nameOnRinger || '';
  const rawAddressText = normalizeText(
    typeof rawAddress === 'string'
      ? rawAddress
      : (rawAddress?.address || rawAddress?.street_address || rawAddress?.street || '')
  );
  const parsedPackedAddress = rawAddressText ? parsePackedDeliveryAddress(rawAddressText) : null;

  const hasDeliveryAddress = rawAddress || rawCity || rawPostalCode || rawFloor || rawNotes || rawRinger;

  const deliveryAddress = hasDeliveryAddress ? {
    address: normalizeText(parsedPackedAddress?.firstLine || rawAddressText || ''),
    city: normalizeText(rawCity || rawAddress?.city || parsedPackedAddress?.city || ''),
    postal_code: normalizeText(rawPostalCode || rawAddress?.postal_code || parsedPackedAddress?.postalCode || ''),
    floor: normalizeText(rawFloor || rawAddress?.floor || rawAddress?.floor_number || parsedPackedAddress?.floor || ''),
    notes: normalizeText(rawNotes || rawAddress?.notes || ''),
    name_on_ringer: normalizeText(rawRinger || rawAddress?.name_on_ringer || ''),
  } : {};

  const subtotal = displayOrder.subtotal || 0;
  const tax = displayOrder.tax || displayOrder.tax_amount || displayOrder.taxAmount || 0;
  const deliveryFee = displayOrder.delivery_fee ?? displayOrder.deliveryFee ?? 0;
  const discountAmount = displayOrder.discount_amount || displayOrder.discountAmount || 0;
  const discountPercentage = displayOrder.discount_percentage || displayOrder.discountPercentage || 0;
  const total = displayOrder.total || displayOrder.total_amount || displayOrder.totalAmount || 0;
  // Calculate original subtotal before discount (for display purposes)
  const originalSubtotal = discountAmount > 0 ? subtotal + discountAmount : subtotal;
  const status = displayOrder.status || 'pending';
  const paymentMethod = displayOrder.payment_method || displayOrder.paymentMethod || '';
  const paymentStatus = displayOrder.payment_status || displayOrder.paymentStatus || 'pending';
  const createdAt = displayOrder.created_at ? new Date(displayOrder.created_at) : new Date();

  // Driver info for delivered orders
  const driverName = displayOrder.driver_name || displayOrder.driverName || '';
  const hasDriverAssignment = !!(displayOrder.driver_id || displayOrder.driverId || driverName);
  const isDelivered = status?.toLowerCase() === 'completed' || status?.toLowerCase() === 'delivered';
  const isDeliveryOrder = orderType?.toLowerCase() === 'delivery';

  // Parse customizations/ingredients with prices
  // Edge Case Handling (Requirements 5.3, 5.5):
  // - Returns empty array when customizations is null/undefined
  // - Handles malformed JSON strings gracefully without crashing
  const parseCustomizations = (customizations: any): { name: string; price: number; isWithout?: boolean; isLittle?: boolean }[] => {
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

    // Check if item is "without" (removed ingredient)
    const isWithoutItem = (c: any): boolean => {
      return c.isWithout === true || c.is_without === true || c.without === true;
    };
    const isLittleItem = (c: any): boolean => {
      return c.isLittle === true || c.is_little === true || c.little === true;
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
          price: isWithoutItem(c) ? 0 : extractPrice(c),
          isWithout: isWithoutItem(c),
          isLittle: isLittleItem(c)
        }));
    }
    if (typeof parsedCustomizations === 'object' && parsedCustomizations !== null) {
      return Object.values(parsedCustomizations)
        .filter((c: any) => c && (c.ingredient || c.name || c.name_en))
        .map((c: any) => ({
          name: extractName(c),
          price: isWithoutItem(c) ? 0 : extractPrice(c),
          isWithout: isWithoutItem(c),
          isLittle: isLittleItem(c)
        }));
    }
    return [];
  };

  const resolveCategoryPath = (item: any): string => {
    const explicitPath =
      (typeof item?.category_path === 'string' && item.category_path.trim()) ||
      (typeof item?.categoryPath === 'string' && item.categoryPath.trim()) ||
      '';
    if (explicitPath) {
      const [primary] = explicitPath.split('>');
      const normalizedPrimary = typeof primary === 'string' ? primary.trim() : '';
      if (normalizedPrimary) return normalizedPrimary;
      return explicitPath;
    }

    const category =
      item?.categoryName ||
      item?.category_name ||
      item?.category?.name ||
      item?.menu_item?.category_name ||
      item?.menu_item?.categoryName ||
      '';
    const normalizedCategory = typeof category === 'string' ? category.trim() : '';
    if (normalizedCategory) return normalizedCategory;

    const fallbackSubcategory =
      item?.subcategory_name ||
      item?.subcategoryName ||
      item?.sub_category_name ||
      item?.subCategoryName ||
      '';
    return typeof fallbackSubcategory === 'string' ? fallbackSubcategory.trim() : '';
  };

  const resolveItemNotes = (item: any): string => {
    const notes = [
      item?.notes,
      item?.special_instructions,
      item?.specialInstructions,
      item?.instructions
    ]
      .map(value => (typeof value === 'string' ? value.trim() : ''))
      .filter(value => Boolean(value));
    const deduped = notes.filter(
      (value, index, array) =>
        array.findIndex(existing => existing.toLowerCase() === value.toLowerCase()) === index
    );
    return deduped.join(' | ');
  };

  const modalHeader = (
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
              {`${formatDate(createdAt)} ${formatTime(createdAt, { hour: '2-digit', minute: '2-digit' })}`}
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

  );

  const canRefund = paymentStatus === 'paid' || paymentStatus === 'completed';
  const canSplitPayment = paymentStatus === 'pending' || paymentStatus === 'partially_paid';

  // Compute footer grid columns based on visible buttons
  const footerButtonCount =
    (onPrintReceipt ? 1 : 0) +
    (canSplitPayment ? 1 : 0) +
    (canRefund ? 1 : 0) +
    1; // Close button is always shown
  const footerGridCols =
    footerButtonCount === 4 ? 'grid-cols-4' :
    footerButtonCount === 3 ? 'grid-cols-3' :
    'grid-cols-2';

  /** Called when split payment finishes -- reload order data to reflect updated payment status. */
  const handleSplitComplete = (_result: SplitPaymentResult) => {
    setShowSplitPaymentModal(false);
    // Reload order data to reflect updated payment status
    if (orderId && !order) {
      loadOrderData();
    }
  };

  const modalFooter = (
    <div className="flex-shrink-0 px-6 py-4 border-t liquid-glass-modal-border bg-white/5 dark:bg-black/20">
      <div className={`grid gap-3 ${footerGridCols}`}>
        {onPrintReceipt && (
          <button
            onClick={onPrintReceipt}
            className="liquid-glass-modal-button w-full gap-2"
          >
            <Printer className="w-4 h-4" />
            {t('modals.orderDetails.printReceipt') || 'Print Receipt'}
          </button>
        )}
        {canSplitPayment && (
          <button
            onClick={() => setShowSplitPaymentModal(true)}
            className="liquid-glass-modal-button w-full gap-2 bg-pink-600/10 hover:bg-pink-600/20 text-pink-400 border-pink-500/20"
          >
            <Split className="w-4 h-4" />
            {t('payment.split.title', { defaultValue: 'Split Payment' })}
          </button>
        )}
        {canRefund && (
          <button
            onClick={() => setShowRefundModal(true)}
            className="liquid-glass-modal-button w-full gap-2 bg-red-600/10 hover:bg-red-600/20 text-red-400 border-red-500/20"
          >
            <RotateCcw className="w-4 h-4" />
            {t('modals.orderDetails.voidRefund', { defaultValue: 'Void / Refund' })}
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
  );

  return (
    <>
    <LiquidGlassModal
      isOpen={isOpen}
      onClose={onClose}
      size="lg"
      className="!max-w-4xl"
      contentClassName="p-0 overflow-hidden"
      ariaLabel={t('modals.orderDetails.title', { defaultValue: 'Order Details' })}
      header={modalHeader}
      footer={modalFooter}
    >
      <div className="flex-1 overflow-y-auto overflow-x-hidden px-6 py-4 min-h-0 scrollbar-hide">
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
                  {getPaymentMethodIcon(paymentMethod)}
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
                      <div className="space-y-2">
                        <div>
                          <div className="text-xs font-semibold uppercase tracking-wide liquid-glass-modal-text-muted">
                            {t('modals.orderDetails.streetAddress', { defaultValue: 'Address' })}
                          </div>
                          <p className="font-medium liquid-glass-modal-text">
                            {deliveryAddress.address || '-'}
                          </p>
                        </div>
                        <div className="flex items-center gap-2 text-sm liquid-glass-modal-text-muted">
                          <Building className="w-3 h-3" />
                          <span>
                            {t('modals.orderDetails.city', { defaultValue: 'City' })}: {deliveryAddress.city || '-'}
                          </span>
                        </div>
                        <div className="flex items-center gap-2 text-sm liquid-glass-modal-text-muted">
                          <MapPin className="w-3 h-3" />
                          <span>
                            {t('modals.orderDetails.postalCode', { defaultValue: 'Postal' })}: {deliveryAddress.postal_code || '-'}
                          </span>
                        </div>
                        <div className="flex items-center gap-2 text-sm liquid-glass-modal-text-muted">
                          <Layers className="w-3 h-3" />
                          <span>
                            {t('modals.orderDetails.floor', { defaultValue: 'Floor' })}: {deliveryAddress.floor || '-'}
                          </span>
                        </div>
                        <div className="flex items-center gap-2 text-sm liquid-glass-modal-text-muted">
                          <Bell className="w-3 h-3" />
                          <span>
                            {t('modals.orderDetails.nameOnRinger', { defaultValue: 'Bell' })}: {deliveryAddress.name_on_ringer || '-'}
                          </span>
                        </div>
                      </div>

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
                {isDeliveryOrder && isDelivered && hasDriverAssignment && (
                  <div className="liquid-glass-modal-card">
                    <h4 className="flex items-center gap-2 text-sm font-bold uppercase tracking-wider liquid-glass-modal-text-muted mb-4">
                      <Truck className="w-4 h-4" />
                      {t('modals.orderDetails.deliveredBy', { defaultValue: 'Delivered By' })}
                    </h4>
                    <div className="p-3 bg-green-500/10 rounded-lg border border-green-500/20">
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-full bg-gradient-to-br from-green-500 to-teal-600 flex items-center justify-center text-white font-bold text-lg shadow-lg">
                          {driverName ? driverName.charAt(0).toUpperCase() : <Car className="w-5 h-5" />}
                        </div>
                        <div>
                          <div className="font-semibold liquid-glass-modal-text">
                            {driverName || t('modals.orderDetails.unknownDriver', { defaultValue: 'Unknown Driver' })}
                          </div>
                          <div className="text-xs text-green-400 flex items-center gap-1">
                            <CheckCircle className="w-3 h-3" aria-hidden="true" />
                            {t('modals.orderDetails.delivered', { defaultValue: 'Delivered' })}
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
                        const categoryPath = resolveCategoryPath(item);
                        const itemNotes = resolveItemNotes(item);
                        const withoutLabel = t('menu.itemModal.without', { defaultValue: 'Without' });
                        const littleLabel = t('menu.itemModal.little', { defaultValue: 'Little' });

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
                                  {/* Category name above item */}
                                  {categoryPath && (
                                    <div className="text-[10px] uppercase tracking-wider font-medium mb-0.5 liquid-glass-modal-text-muted">
                                      {categoryPath}
                                    </div>
                                  )}
                                  {/* Item name (subcategory) */}
                                  <div className="font-medium liquid-glass-modal-text">
                                    {item.name || item.menu_item?.name || 'Item'}
                                  </div>
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
                              <div className="ml-11 mt-2 space-y-1">
                                {/* Added ingredients */}
                                {customizations.filter(c => !c.isWithout).length > 0 && (
                                  <div className="border-l-2 border-green-500/30 pl-3 space-y-1">
                                    {customizations.filter(c => !c.isWithout).map((c, idx) => (
                                      <div key={`add-${idx}`} className="flex justify-between text-xs">
                                        <span className="flex items-center gap-1 liquid-glass-modal-text-muted">
                                          <span className="text-green-400">+</span> {c.name}{c.isLittle ? ` (${littleLabel})` : ''}
                                        </span>
                                        {c.price > 0 && (
                                          <span className="text-green-400 font-medium">+{formatCurrency(c.price)}</span>
                                        )}
                                      </div>
                                    ))}
                                  </div>
                                )}
                                {/* Without ingredients */}
                                {customizations.filter(c => c.isWithout).length > 0 && (
                                  <div className="border-l-2 border-red-500/30 pl-3 space-y-1 mt-1">
                                    <div className="text-[11px] text-red-300">{withoutLabel}</div>
                                    {customizations.filter(c => c.isWithout).map((c, idx) => (
                                      <div key={`without-${idx}`} className="flex justify-between text-xs text-red-400">
                                        <span className="line-through">- {c.name}</span>
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </div>
                            )}

                            {/* Item Notes */}
                            {itemNotes && (
                              <div className="ml-11 mt-2 text-xs liquid-glass-modal-text-muted italic flex items-center gap-1">
                                <FileText className="w-3 h-3" />
                                <span>{itemNotes}</span>
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
                      <div className="flex items-center gap-2">
                        {discountAmount > 0 && (
                          <span className="line-through text-xs text-gray-500">{formatCurrency(originalSubtotal)}</span>
                        )}
                        <span>{formatCurrency(subtotal)}</span>
                      </div>
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
                      <div className="flex justify-between text-sm text-green-400 font-medium">
                        <span>
                          {t('modals.orderDetails.discount') || 'Discount'}
                          {discountPercentage > 0 && ` (${discountPercentage}%)`}
                        </span>
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

    </LiquidGlassModal>

    {showRefundModal && (
      <RefundVoidModal
        isOpen={showRefundModal}
        onClose={() => setShowRefundModal(false)}
        orderId={orderId}
        orderTotal={total}
        onRefundComplete={() => {
          // Reload order data to reflect updated payment status
          if (orderId && !order) {
            loadOrderData();
          }
        }}
      />
    )}

    {/* Split Payment Modal for existing orders with pending/partially_paid status */}
    {showSplitPaymentModal && (
      <SplitPaymentModal
        isOpen={showSplitPaymentModal}
        onClose={() => setShowSplitPaymentModal(false)}
        orderId={orderId}
        orderTotal={total}
        items={items.map((item: any) => ({
          name: item.name || item.item_name || '',
          quantity: item.quantity || 1,
          totalPrice: (item.price || item.unit_price || 0) * (item.quantity || 1),
          price: item.price || item.unit_price || 0,
        }))}
        onSplitComplete={handleSplitComplete}
      />
    )}
    </>
  );
};

export default OrderDetailsModal;
