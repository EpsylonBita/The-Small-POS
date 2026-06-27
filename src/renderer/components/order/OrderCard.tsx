import React, { memo, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Split } from 'lucide-react';
import { useTheme } from '../../contexts/theme-context';
import { OrderStatusControls } from './OrderStatusControls';
import TableOrderIcon from '../icons/TableOrderIcon';
import PickupOrderIcon from '../icons/PickupOrderIcon';
import type { Order, OrderStatus } from '../../types/orders';
import toast from 'react-hot-toast';
import { PluginIcon, isExternalPlatform } from '../../utils/plugin-icons';
import { OrderRoutingBadge } from './OrderRoutingBadge';
import { getOrderStatusBadgeClasses } from '../../utils/orderStatus';
import {
  normalizeOrderCustomerName,
  normalizeOrderTypeForDisplay,
  resolveOrderDisplayTitle,
} from '../../utils/orderDisplay';
import { formatCompactOrderNumberForDisplay, getVisibleOrderNumber } from '../../utils/orderNumberUtils';
import { formatCurrency } from '../../utils/format';
import { openExternalUrl } from '../../utils/external-url';
import {
  buildGoogleMapsDirectionsUrl,
  buildSingleDeliveryRouteStop,
  type StoreMapOrigin,
} from '../../utils/delivery-routing';
import { getBridge } from '../../../lib';

interface OrderCardProps {
  order: Order | any;
  isSelected: boolean;
  onSelect: (id: string) => void;
  onDoubleClick?: (id: string) => void;
  onStatusChange?: (orderId: string, newStatus: OrderStatus) => Promise<void>;
  onDriverAssign?: (orderId: string) => void;
  onConvertToPickup?: (orderId: string) => void;
  showQuickActions?: boolean;
  orderIndex?: number; // Deprecated - order number now comes from order.order_number
  storeMapOrigin?: StoreMapOrigin | null;
}

const KIOSK_ORDER_NUMBER_PATTERN = /^#?[A-Za-z]+-[A-Za-z0-9]{1,16}-\d{8}-\d{6}-\d+$/;
const KIOSK_SHORT_ORDER_NUMBER_PATTERN = /^#?K[A-Za-z]*-\d+$/i;

function readFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function resolveOrderTotalAmount(order: unknown): number {
  const record = (order ?? {}) as Record<string, unknown>;
  const cents =
    readFiniteNumber(record.total_amount_cents) ??
    readFiniteNumber(record.totalAmountCents);
  if (cents !== null) {
    return cents / 100;
  }

  return (
    readFiniteNumber(record.total_amount) ??
    readFiniteNumber(record.totalAmount) ??
    0
  );
}

export const OrderCard = memo<OrderCardProps>(({
  order,
  isSelected,
  onSelect,
  onDoubleClick,
  onStatusChange,
  onDriverAssign,
  onConvertToPickup,
  showQuickActions = false,
  storeMapOrigin = null,
  // orderIndex is deprecated, using order.order_number instead
}) => {
  const bridge = getBridge();
  const { t } = useTranslation();
  const { resolvedTheme } = useTheme();

  const getStatusBadgeColor = (status: string) => getOrderStatusBadgeClasses(status);

  const isPendingAndOld = () => {
    if (order.status !== 'pending') return false;
    const elapsedMinutes = getElapsedMinutes(order.created_at || order.createdAt);
    return elapsedMinutes > 5;
  };

  const getTimeColorClass = (createdAt: string) => {
    const now = new Date();
    const orderTime = new Date(createdAt);
    const diffMinutes = Math.floor((now.getTime() - orderTime.getTime()) / (1000 * 60));

    if (diffMinutes <= 30) {
      return 'text-green-500 drop-shadow-[0_0_8px_rgba(34,197,94,0.8)]';
    } else if (diffMinutes <= 40) {
      return 'text-amber-500 drop-shadow-[0_0_8px_rgba(245,158,11,0.8)]';
    } else {
      return 'text-red-500 drop-shadow-[0_0_8px_rgba(239,68,68,0.8)]';
    }
  };

  const getElapsedMinutes = (createdAt: string) => {
    const now = new Date();
    const orderTime = new Date(createdAt);
    return Math.floor((now.getTime() - orderTime.getTime()) / (1000 * 60));
  };

  // Format the stable order number from the order itself
  const formatOrderNumber = () => {
    const orderNum = getVisibleOrderNumber(order);
    if (orderNum) {
      const trimmedOrderNum = orderNum.trim();
      const isHashedFallbackNumber = /^#?[A-Za-z]+-\d{8}-[a-f0-9]{32}$/i.test(trimmedOrderNum);
      if (isHashedFallbackNumber) {
        const compactFallbackNumber = formatCompactOrderNumberForDisplay(
          trimmedOrderNum,
          order.created_at || order.createdAt,
        );
        return compactFallbackNumber.startsWith('#')
          ? compactFallbackNumber
          : `#${compactFallbackNumber}`;
      }

      if (
        KIOSK_ORDER_NUMBER_PATTERN.test(trimmedOrderNum) ||
        KIOSK_SHORT_ORDER_NUMBER_PATTERN.test(trimmedOrderNum)
      ) {
        return formatCompactOrderNumberForDisplay(
          trimmedOrderNum,
          order.created_at || order.createdAt,
        );
      }

      // If it's already formatted like "POS-20251212-0001", extract the last part
      if (orderNum.includes('-')) {
        const parts = orderNum.split('-');
        const lastPart = parts[parts.length - 1];
        // If the last part is numeric, format it as #XX
        if (/^\d+$/.test(lastPart)) {
          return `#${lastPart.padStart(2, '0')}`;
        }
      }
      // If it's just a number, format it
      if (/^\d+$/.test(orderNum)) {
        return `#${orderNum.padStart(2, '0')}`;
      }
      // Otherwise return as-is with # prefix
      return orderNum.startsWith('#') ? orderNum : `#${orderNum}`;
    }
    // Fallback to ID-based number if no order_number exists
    const shortId = order.id?.slice(-4) || '00';
    return `#${shortId}`;
  };

  const getLeftEdgeColor = (createdAt: string) => {
    const minutes = getElapsedMinutes(createdAt);
    if (minutes <= 30) return 'border-l-white';
    if (minutes <= 40) return 'border-l-orange-500';
    return 'border-l-red-500';
  };

  const shouldShowRedGlow = (createdAt: string) => {
    const minutes = getElapsedMinutes(createdAt);
    return minutes > 40;
  };

  // Icon component for order type
  const OrderTypeIcon = ({ orderType }: { orderType: string }) => {
    const iconSize = 24;

    if (orderType === 'delivery') {
      // Delivery truck icon in orange
      return (
        <svg
          width={iconSize}
          height={iconSize}
          viewBox="0 0 24 24"
          fill="none"
          stroke="#d97706"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2" />
          <path d="M15 18H9" />
          <path d="M19 18h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.624l-3.48-4.35A1 1 0 0 0 17.52 8H14" />
          <circle cx="17" cy="18" r="2" />
          <circle cx="7" cy="18" r="2" />
        </svg>
      );
    } else if (orderType === 'dine-in' || orderType === 'dine_in' || orderType === 'table') {
      // Table / dine-in order: same glyph as the OrderDashboard/OrderFlow chooser (TableOrderIcon)
      return (
        <TableOrderIcon
          className={`w-6 h-6 ${resolvedTheme === 'light' ? 'text-gray-700' : 'text-gray-300'}`}
          strokeWidth={1.6}
        />
      );
    } else {
      // Pickup / takeaway / default: the shared PickupOrderIcon rendered as a PLAIN bag silhouette at
      // row scale (w-6 h-6, matching the sibling delivery/table icons) with a theme-aware semantic green
      // stroke (light text-green-600 / dark text-green-400, OrderCard's resolvedTheme idiom) so it stays
      // readable on the cream/light row and the dark row. The earlier green rounded badge/holder
      // (the ~28px filled green chip wrapping a white bag, round 213) is gone -- on the live Dashboard
      // row that filled chip read as a separate boxed treatment apart from the unboxed delivery/table
      // siblings. No tap animation (no hover, no active scale), never a Store/Package/storefront glyph,
      // and never a raw ShoppingBag -- the bag always goes through the shared PickupOrderIcon wrapper.
      return (
        <PickupOrderIcon
          className={`w-6 h-6 ${resolvedTheme === 'light' ? 'text-green-600' : 'text-green-400'}`}
          strokeWidth={2}
        />
      );
    }
  };

  const PaymentMethodIcon = ({ method }: { method: string }) => {
    const iconSize = 20;

    if (method === 'cash') {
      return (
        <svg
          width={iconSize}
          height={iconSize}
          viewBox="0 0 24 24"
          fill="none"
          stroke="#16a34a"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          role="img"
          aria-label={t('modals.editPaymentMethod.methods.cash', { defaultValue: 'Cash' })}
        >
          <title>{t('modals.editPaymentMethod.methods.cash', { defaultValue: 'Cash' })}</title>
          <rect x="2" y="6" width="20" height="12" rx="2" />
          <circle cx="12" cy="12" r="2.5" />
          <path d="M6 12h.01M18 12h.01" />
        </svg>
      );
    }

    if (method === 'card') {
      return (
        <svg
          width={iconSize}
          height={iconSize}
          viewBox="0 0 24 24"
          fill="none"
          stroke="#52525b"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          role="img"
          aria-label={t('modals.editPaymentMethod.methods.card', { defaultValue: 'Card' })}
        >
          <title>{t('modals.editPaymentMethod.methods.card', { defaultValue: 'Card' })}</title>
          <rect x="2" y="5" width="20" height="14" rx="2" />
          <path d="M2 10h20" />
          <path d="M6 15h4" />
        </svg>
      );
    }

    if (method === 'split' || method === 'mixed') {
      return (
        <Split
          width={iconSize}
          height={iconSize}
          className="text-purple-400"
          strokeWidth={2}
          role="img"
          aria-label={t('payment.split.title', { defaultValue: 'Split Payment' })}
        />
      );
    }

    return null;
  };

  const orderCreatedAt = order.created_at || order.createdAt;
  const isRedGlow = shouldShowRedGlow(orderCreatedAt);
  const orderTypeNormalized = normalizeOrderTypeForDisplay(
    (order.order_type || order.orderType || '').toString(),
  );
  const rawCustomerName = order.customer_name || order.customerName || '';
  const customerNameNormalized = normalizeOrderCustomerName(rawCustomerName) || '';
  const customerPhoneNormalized = order.customer_phone || order.customerPhone || '';
  const deliveryAddressNormalized = order.delivery_address || order.address || (order as any).deliveryAddress || '';
  const paymentMethodNormalized = (order.payment_method || order.paymentMethod || '').toString().trim().toLowerCase();
  const paymentMethodPresentation =
    paymentMethodNormalized === 'split' ||
    paymentMethodNormalized === 'mixed'
      ? 'split'
      : paymentMethodNormalized;
  const [resolvedAddress, setResolvedAddress] = useState<string>('');
  const orderTypeLabel = orderTypeNormalized
    ? t(`orders.type.${orderTypeNormalized}`, { defaultValue: orderTypeNormalized })
    : '';
  const nonDeliveryTitle = resolveOrderDisplayTitle({
    orderType: orderTypeNormalized,
    customerName: rawCustomerName,
    pickupLabel: t('orders.type.pickup', { defaultValue: 'Pickup' }),
    fallbackLabel: orderTypeLabel || t('orderCard.customer', { defaultValue: 'Customer' }),
  });

  // Format address for display - only show street/road and number, not city, postal code, or floor
  const formatAddressForDisplay = (fullAddress: string): string => {
    if (!fullAddress) return '';

    // Remove floor info if present (e.g., "Floor: 0" or "Όροφος: 2")
    let addressWithoutFloor = fullAddress.replace(/,?\s*(?:Floor|Όροφος)\s*:?\s*\d+/gi, '');

    // Split by comma and take only the first part (street address)
    const parts = addressWithoutFloor.split(',').map(p => p.trim()).filter(Boolean);

    if (parts.length === 0) return fullAddress;

    // First part is typically the street address (e.g., "Iliados 10")
    return parts[0];
  };
  const requestedRef = useRef(false);
  const totalNormalized = resolveOrderTotalAmount(order);

  // Normalize plugin field (could be plugin/order_plugin or legacy platform)
  const orderPlugin = order.plugin || order.order_plugin || order.platform || order.order_platform || '';
  const isExternal = isExternalPlatform(orderPlugin);

  // Normalize driver info for display
  const driverIdNormalized = order.driver_id || order.driverId || '';
  const driverNameNormalized = order.driverName || order.driver_name || '';
  const orderStatusNormalized = (order.status || '').toLowerCase();
  const isDeliveredOrCompleted = orderStatusNormalized === 'completed' || orderStatusNormalized === 'delivered';
  const showReadyStatusPill = orderStatusNormalized === 'ready' || isDeliveredOrCompleted;
  const readyStatusKey = orderStatusNormalized === 'ready' ? 'ready' : 'completed';
  const readyStatusBadgeClass = getStatusBadgeColor('ready');
  const readyStatusLabel = t(`orders.status.${readyStatusKey}`, {
    defaultValue: readyStatusKey === 'ready' ? 'Ready' : 'Completed'
  });

  // Debug: log driver info when order is delivered/completed
  if (orderTypeNormalized === 'delivery' && isDeliveredOrCompleted) {
    console.log('[OrderCard] Driver info for order:', {
      orderId: order.id,
      orderStatus: order.status,
      driver_id: order.driver_id,
      driverId: order.driverId,
      driver_name: order.driver_name,
      driverName: order.driverName,
      isDeliveredOrCompleted,
      driverIdNormalized,
      driverNameNormalized
    });
  }

  // Don't show red glow animation for delivered/completed/cancelled orders
  const isCancelled = orderStatusNormalized === 'cancelled';
  const isCanceled = orderStatusNormalized === 'canceled';
  const isCancelledTerminal = isCancelled || isCanceled;
  // Terminal (history) rows: completed / delivered / cancelled. These must NOT show the live age-based
  // elapsed-minute urgency timer or the age-based red/amber left edge -- only a calm timestamp.
  const isTerminalOrder = isDeliveredOrCompleted || isCancelledTerminal;
  const deliveryOlderThan40 = orderTypeNormalized === 'delivery' && isRedGlow && !isDeliveredOrCompleted && !isCancelledTerminal;

  // Left edge: age-based urgency only for active orders. Terminal rows use a neutral edge, except cancelled
  // keeps a calm semantic red (status-based, never age-based).
  const leftEdgeColorClass = isTerminalOrder
    ? (isCancelledTerminal ? 'border-l-red-400/50' : 'border-l-white/30')
    : getLeftEdgeColor(orderCreatedAt);

  // Calm timestamp for terminal rows: prefer the terminal/most-recent time, falling back to created_at only if
  // nothing else exists. Same-day shows time only; older shows a short date + time. Neutral, never urgent red.
  const terminalTimestampRaw =
    (order as any).completed_at || (order as any).completedAt ||
    (order as any).delivered_at || (order as any).deliveredAt ||
    (order as any).cancelled_at || (order as any).canceled_at ||
    (order as any).updated_at || (order as any).updatedAt ||
    order.created_at || order.createdAt || null;
  const formatTerminalStamp = (raw: string | null): string | null => {
    if (!raw) return null;
    const stamped = new Date(raw);
    if (Number.isNaN(stamped.getTime())) return null;
    const time = stamped.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const now = new Date();
    const sameDay =
      stamped.getFullYear() === now.getFullYear() &&
      stamped.getMonth() === now.getMonth() &&
      stamped.getDate() === now.getDate();
    return sameDay
      ? time
      : `${stamped.toLocaleDateString([], { day: '2-digit', month: '2-digit' })} ${time}`;
  };
  const terminalStatusKey =
    orderStatusNormalized === 'delivered'
      ? 'delivered'
      : isCancelledTerminal
        ? 'cancelled'
        : 'completed';
  const terminalStatusLabel = t(`orders.status.${terminalStatusKey}`, { defaultValue: terminalStatusKey });
  const terminalTimestamp = formatTerminalStamp(terminalTimestampRaw);
  const terminalTimestampLabel = terminalTimestamp
    ? `${terminalStatusLabel} ${terminalTimestamp}`
    : terminalStatusLabel;

  // Fallback: resolve address via customer lookup when missing
  // Checks both customer_addresses table and legacy customers.address field
  useEffect(() => {
    const shouldFetch = orderTypeNormalized === 'delivery' && !deliveryAddressNormalized && !!customerPhoneNormalized;
    if (!shouldFetch || requestedRef.current || typeof window === 'undefined') return;
    requestedRef.current = true;
    let cancelled = false;
    (async () => {
      try {
        const customer = (await bridge.customers.lookupByPhone(String(customerPhoneNormalized))) as any;
        if (!customer || cancelled) return;

        // Priority 1: Check customer_addresses array (new system)
        const addr = Array.isArray(customer.addresses) && customer.addresses.length > 0
          ? (customer.addresses.find((a: any) => a.is_default) || customer.addresses[0])
          : null;

        if (addr) {
          let parts: string[] = [];
          if (addr.street || addr.street_address) parts.push(addr.street || addr.street_address);
          if (addr.city) parts.push(addr.city);
          if (addr.postal_code) parts.push(addr.postal_code);
          let full = parts.filter(Boolean).join(', ');
          if (!cancelled) setResolvedAddress(full);
          return;
        }

        // Priority 2: Check legacy customer.address field (customers table)
        if (customer.address) {
          // Handle both string addresses and structured address objects
          if (typeof customer.address === 'string') {
            // Use the string address directly
            if (!cancelled) setResolvedAddress(customer.address);
          } else if (typeof customer.address === 'object') {
            // Build from structured object
            let parts: string[] = [];
            if (customer.address.street || customer.address.street_address) {
              parts.push(customer.address.street || customer.address.street_address);
            }
            if (customer.address.city) parts.push(customer.address.city);
            if (customer.address.postal_code) parts.push(customer.address.postal_code);
            let full = parts.filter(Boolean).join(', ');
            if (!cancelled) setResolvedAddress(full);
          }
        }
      } catch { }
    })();
    return () => { cancelled = true; };
  }, [order.id, orderTypeNormalized, deliveryAddressNormalized, customerPhoneNormalized]);

  return (
    <div
      className={`relative rounded-2xl sm:rounded-full py-3 sm:py-3 px-3 sm:px-6 cursor-pointer transform transition-all duration-300 backdrop-blur-sm touch-feedback ${resolvedTheme === 'light'
        ? 'bg-[#fffaf1]/90 border border-amber-100/80 shadow-sm active:bg-[#f8ecd9]/95'
        : 'bg-white/10 border border-white/20 shadow-lg active:bg-white/20'
        } ${deliveryOlderThan40
          ? 'border-red-500/60 shadow-[inset_0_0_15px_rgba(239,68,68,0.6),inset_0_0_30px_rgba(239,68,68,0.4),inset_0_0_50px_rgba(239,68,68,0.25),inset_0_0_80px_rgba(239,68,68,0.15)] animate-pulse'
          : ''
        } border-l-4 ${deliveryOlderThan40 ? 'border-l-red-500' : leftEdgeColorClass} ${isSelected ? 'ring-2 ring-blue-400/50 scale-[1.02] shadow-lg' : ''
        }`}
      onClick={() => onSelect(order.id)}
      onDoubleClick={() => onDoubleClick?.(order.id)}
    >
        <div className="flex items-center justify-between gap-2 sm:gap-4">
        {/* Left Section - Order Number & Time */}
        <div className="flex items-center gap-2 sm:gap-4 relative flex-shrink-0">
          <div className="flex flex-col gap-0.5 sm:gap-1">
            <span className={`text-base sm:text-lg font-bold min-w-[50px] sm:min-w-[80px] ${resolvedTheme === 'light' ? 'text-gray-900' : 'text-white'}`}>
              {formatOrderNumber()}
            </span>
            {showReadyStatusPill && (
              <span className={`inline-flex w-fit items-center gap-1 px-2 py-0.5 rounded-full text-[10px] sm:text-xs font-semibold border ${readyStatusBadgeClass}`}>
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M20 6 9 17l-5-5" />
                </svg>
                {readyStatusLabel}
              </span>
            )}
            {isTerminalOrder ? (
              <span className={`text-xs sm:text-sm font-medium capitalize ${resolvedTheme === 'light' ? 'text-gray-500' : 'text-white/60'}`}>
                {terminalTimestampLabel}
              </span>
            ) : (
              <span className={`text-xs sm:text-sm font-medium ${getTimeColorClass(order.created_at || order.createdAt)}`}>
                {t('orders.time.minutes', { minutes: getElapsedMinutes(order.created_at || order.createdAt) })}
              </span>
            )}
            <OrderRoutingBadge routingPath={order.routing_path} />
          </div>
        </div>

        {/* Center Section - Customer / Address Info */}
        <div className="flex items-center gap-2 sm:gap-6 flex-1 mx-1 sm:mx-6 min-w-0">
          <div className="flex flex-col gap-0.5 sm:gap-1 min-w-0">
            {/* For delivery orders: Show address prominently (bold, bigger), then name & phone on same line below */}
            {orderTypeNormalized === 'delivery' ? (
              <>
                {/* Delivery address - bold, bigger text, centered (street only, no city/postal) */}
                  <div className="flex items-center gap-2 min-w-0">
                    {isExternal && (
                      <PluginIcon plugin={orderPlugin} size={20} className="shrink-0" showTooltip={false} />
                    )}
                    <div className={`text-base sm:text-lg font-bold truncate min-w-0 ${resolvedTheme === 'light' ? 'text-gray-800' : 'text-white/90'}`}>
                      {(deliveryAddressNormalized || resolvedAddress)
                        ? formatAddressForDisplay(deliveryAddressNormalized || resolvedAddress)
                        : (customerPhoneNormalized && !resolvedAddress
                          ? <span className="italic font-normal">{t('orderCard.loadingAddress') || 'Loading address...'}</span>
                          : <span className="italic font-normal text-gray-400">{t('orderCard.addressNotAvailable') || 'Address not available'}</span>
                        )}
                    </div>
                  </div>
                {/* Customer name & phone - same line, smaller text */}
                {(customerNameNormalized || customerPhoneNormalized) && (
                  <div className={`text-xs ${resolvedTheme === 'light' ? 'text-gray-600' : 'text-white/70'}`}>
                    {customerNameNormalized}{customerNameNormalized && customerPhoneNormalized && ' • '}{customerPhoneNormalized}
                  </div>
                )}
                {/* Driver badge for completed/delivered orders */}
                {isDeliveredOrCompleted && (driverIdNormalized || driverNameNormalized) && (
                  <div className="flex items-center gap-1 mt-1">
                    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${resolvedTheme === 'light'
                      ? 'bg-green-100 text-green-700 border border-green-200'
                      : 'bg-green-900/30 text-green-400 border border-green-700/40'
                      }`}>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2" />
                        <path d="M15 18H9" />
                        <path d="M19 18h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.624l-3.48-4.35A1 1 0 0 0 17.52 8H14" />
                        <circle cx="17" cy="18" r="2" />
                        <circle cx="7" cy="18" r="2" />
                      </svg>
                      {driverNameNormalized || t('orderCard.driverAssigned', 'Driver Assigned')}
                    </span>
                  </div>
                )}
              </>
            ) : (
              <>
                {/* For non-delivery orders: Show customer name or order type */}
                  <div className="flex items-center gap-2 min-w-0">
                    {isExternal && (
                      <PluginIcon plugin={orderPlugin} size={18} className="shrink-0" showTooltip={false} />
                    )}
                    <div className={`text-sm sm:text-base font-bold truncate min-w-0 ${resolvedTheme === 'light' ? 'text-gray-800' : 'text-white/90'}`}>
                      {nonDeliveryTitle}
                    </div>
                  </div>
                {/* Show phone number */}
                {customerPhoneNormalized && (
                  <div className={`text-xs ${resolvedTheme === 'light' ? 'text-gray-600' : 'text-white/70'}`}>
                    {customerPhoneNormalized}
                  </div>
                )}
              </>
            )}
          </div>
        </div>

        {/* Right Section - Price, Order Type, and Payment Icon */}
        <div className="flex flex-col items-center gap-1 sm:gap-2 mr-8 sm:mr-12 flex-shrink-0">
          <span className={`text-base sm:text-xl font-bold ${resolvedTheme === 'light' ? 'text-gray-900' : 'text-white/90'
            }`}>
            {formatCurrency(totalNormalized)}
          </span>
          <div className="flex items-center gap-2">
            <OrderTypeIcon orderType={orderTypeNormalized} />
            <PaymentMethodIcon method={paymentMethodPresentation} />
          </div>
          {paymentMethodPresentation === 'split' && (
            <span className="text-[10px] sm:text-xs font-semibold tracking-[0.25em] text-purple-400">
              {t('modals.payment.splitSimple', 'SPLIT')}
            </span>
          )}
        </div>
      </div>

      {/* Map Icon - Centered on Right Edge (always for delivery) */}
      {orderTypeNormalized === 'delivery' && (() => {
        const routeStop = buildSingleDeliveryRouteStop({
          ...order,
          deliveryAddress: deliveryAddressNormalized || resolvedAddress,
        });
        const hasAddress = Boolean(routeStop);
        const mapsUrl = routeStop
          ? buildGoogleMapsDirectionsUrl(storeMapOrigin, routeStop)
          : null;
        const isEnabled = Boolean(mapsUrl);
        const disabledReason = t('orderCard.missingAddress') || 'No address available';
        return (
          <div
            onClick={(e) => {
              e.stopPropagation();
              if (!hasAddress) {
                toast.error(t('orderCard.missingAddress') || 'Delivery address not available');
                return;
              }
              if (!mapsUrl) {
                toast.error(t('orderCard.missingAddress') || 'Delivery address not available');
                return;
              }
              void openExternalUrl(mapsUrl);
            }}
            className={`absolute right-0 top-1/2 -translate-y-1/2 p-4 flex items-center justify-center ${isEnabled ? 'cursor-pointer active:scale-95 active:bg-white/10 rounded-full transition-all' : 'cursor-not-allowed opacity-40'}`}
            role="button"
            aria-label={isEnabled ? (t('orderCard.getDirections') || 'Get Directions') : disabledReason}
            aria-disabled={!isEnabled}
          >
            <svg
              width="32"
              height="32"
              viewBox="0 0 24 24"
              fill="none"
              stroke={isEnabled ? '#22c55e' : '#9ca3af'}
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
              <circle cx="12" cy="10" r="3" />
            </svg>
          </div>
        );
      })()}

      {/* Quick Actions - Order Status Controls */}
      {showQuickActions && onStatusChange && onDriverAssign && (
        <div className={`mt-4 pt-4 border-t ${resolvedTheme === 'light' ? 'border-amber-100/80' : 'border-white/10'
          }`}>
          <OrderStatusControls
            order={order}
            onStatusChange={onStatusChange}
            onDriverAssign={onDriverAssign}
            onConvertToPickup={onConvertToPickup}
            disabled={false}
          />
        </div>
      )}
    </div>
  );
});

OrderCard.displayName = 'OrderCard';
export default OrderCard; 
