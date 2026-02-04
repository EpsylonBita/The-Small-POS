import React, { memo, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../../contexts/theme-context';
import { OrderStatusControls } from './OrderStatusControls';
import type { Order, OrderStatus } from '../../types/orders';
import toast from 'react-hot-toast';
import { PluginIcon, isExternalPlatform } from '../../utils/plugin-icons';
import { OrderRoutingBadge } from './OrderRoutingBadge';
import { getOrderStatusBadgeClasses } from '../../utils/orderStatus';

interface OrderCardProps {
  order: Order | any;
  isSelected: boolean;
  onSelect: (id: string) => void;
  onDoubleClick?: (id: string) => void;
  onStatusChange?: (orderId: string, newStatus: OrderStatus) => Promise<void>;
  onDriverAssign?: (orderId: string) => void;
  showQuickActions?: boolean;
  orderIndex?: number; // Deprecated - order number now comes from order.order_number
}

export const OrderCard = memo<OrderCardProps>(({
  order,
  isSelected,
  onSelect,
  onDoubleClick,
  onStatusChange,
  onDriverAssign,
  showQuickActions = false,
  // orderIndex is deprecated, using order.order_number instead
}) => {
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
      return 'text-orange-500 drop-shadow-[0_0_8px_rgba(249,115,22,0.8)]';
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
    // Use the order's stable order_number or orderNumber from the database
    const orderNum = order.order_number || order.orderNumber;
    if (orderNum) {
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
          stroke="#f97316"
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
    } else {
      // Store icon for pickup (dine-in, takeaway)
      const iconColor = resolvedTheme === 'light' ? '#374151' : '#D1D5DB';
      return (
        <svg
          width={iconSize}
          height={iconSize}
          viewBox="0 0 24 24"
          fill="none"
          stroke={iconColor}
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="m2 7 4.41-4.41A2 2 0 0 1 7.83 2h8.34a2 2 0 0 1 1.42.59L22 7" />
          <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8" />
          <path d="M15 22v-4a2 2 0 0 0-2-2h-2a2 2 0 0 0-2 2v4" />
          <path d="M2 7h20" />
          <path d="M22 7v3a2 2 0 0 1-2 2v0a2.18 2.18 0 0 1-2-2v0a2.18 2.18 0 0 1-2 2v0a2.18 2.18 0 0 1-2-2v0a2.18 2.18 0 0 1-2 2v0a2.18 2.18 0 0 1-2-2v0a2.18 2.18 0 0 1-2 2v0a2 2 0 0 1-2-2V7" />
        </svg>
      );
    }
  };

  const orderCreatedAt = order.created_at || order.createdAt;
  const isRedGlow = shouldShowRedGlow(orderCreatedAt);
  const orderTypeNormalized = (order.order_type || order.orderType || '').toString();
  const customerNameNormalized = order.customer_name || order.customerName || '';
  const customerPhoneNormalized = order.customer_phone || order.customerPhone || '';
  const deliveryAddressNormalized = order.delivery_address || order.address || (order as any).deliveryAddress || '';
  const [resolvedAddress, setResolvedAddress] = useState<string>('');

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
  const totalNormalized = typeof order.totalAmount === 'number' ? order.totalAmount : (typeof order.total_amount === 'number' ? order.total_amount : 0);

  // Normalize plugin field (could be plugin/order_plugin or legacy platform)
  const orderPlugin = order.plugin || order.order_plugin || order.platform || order.order_platform || '';
  const isExternal = isExternalPlatform(orderPlugin);

  // Normalize driver info for display
  const driverIdNormalized = order.driver_id || order.driverId || (order as any).driver_id || '';
  const driverNameNormalized = order.driverName || (order as any).driver_name || '';
  const orderStatusNormalized = (order.status || '').toLowerCase();
  const isDeliveredOrCompleted = orderStatusNormalized === 'completed' || orderStatusNormalized === 'delivered';

  // Debug: log driver info when order is delivered/completed
  if (orderTypeNormalized === 'delivery' && isDeliveredOrCompleted) {
    console.log('[OrderCard] Driver info for order:', {
      orderId: order.id,
      orderStatus: order.status,
      driver_id: order.driver_id,
      driverId: order.driverId,
      driverName: order.driverName,
      isDeliveredOrCompleted,
      driverIdNormalized,
      driverNameNormalized
    });
  }

  // Don't show red glow animation for delivered/completed/cancelled orders
  const isCancelled = orderStatusNormalized === 'cancelled';
  const deliveryOlderThan40 = orderTypeNormalized === 'delivery' && isRedGlow && !isDeliveredOrCompleted && !isCancelled;

  // Fallback: resolve address via customer lookup when missing
  // Checks both customer_addresses table and legacy customers.address field
  useEffect(() => {
    const shouldFetch = orderTypeNormalized === 'delivery' && !deliveryAddressNormalized && !!customerPhoneNormalized;
    if (!shouldFetch || requestedRef.current || typeof window === 'undefined') return;
    requestedRef.current = true;
    let cancelled = false;
    (async () => {
      try {
        const api: any = (window as any).electronAPI;
        const customer = await api?.customerLookupByPhone?.(String(customerPhoneNormalized));
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
        ? 'bg-gray-50/90 border border-gray-200/60 hover:bg-gray-100/90 hover:border-gray-300/60 shadow-sm hover:shadow-lg active:bg-gray-200/90'
        : 'bg-white/10 border border-white/20 hover:bg-white/15 hover:border-white/30 shadow-lg hover:shadow-xl active:bg-white/20'
        } ${deliveryOlderThan40
          ? 'border-red-500/60 shadow-[inset_0_0_15px_rgba(239,68,68,0.6),inset_0_0_30px_rgba(239,68,68,0.4),inset_0_0_50px_rgba(239,68,68,0.25),inset_0_0_80px_rgba(239,68,68,0.15)] animate-pulse'
          : ''
        } border-l-4 ${deliveryOlderThan40 ? 'border-l-red-500' : getLeftEdgeColor(orderCreatedAt)} ${isSelected ? 'ring-2 ring-blue-400/50 scale-[1.02] shadow-lg' : ''
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
            <span className={`text-xs sm:text-sm font-medium ${getTimeColorClass(order.created_at || order.createdAt)}`}>
              {t('orders.time.minutes', { minutes: getElapsedMinutes(order.created_at || order.createdAt) })}
            </span>
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
                {isDeliveredOrCompleted && driverIdNormalized && (
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
                      {driverNameNormalized || (driverIdNormalized ? `Driver ${String(driverIdNormalized).slice(-6)}` : t('orderCard.driverAssigned', 'Driver Assigned'))}
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
                      {customerNameNormalized || t(`orders.type.${orderTypeNormalized}`) || orderTypeNormalized || t('orderCard.customer') || 'Customer'}
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

        {/* Right Section - Price & Order Type Icon */}
        <div className="flex flex-col items-center gap-1 sm:gap-2 mr-8 sm:mr-12 flex-shrink-0">
          <span className={`text-base sm:text-xl font-bold ${resolvedTheme === 'light' ? 'text-gray-900' : 'text-white/90'
            }`}>
            €{totalNormalized.toFixed(2)}
          </span>
          <OrderTypeIcon orderType={orderTypeNormalized} />
        </div>
      </div>

      {/* Map Icon - Centered on Right Edge (always for delivery) */}
      {orderTypeNormalized === 'delivery' && (() => {
        const addr = deliveryAddressNormalized || resolvedAddress;
        const hasAddress = !!addr;
        return (
          <div
            onClick={(e) => {
              e.stopPropagation();
              if (!hasAddress) {
                toast.error(t('orderCard.missingAddress') || 'Delivery address not available');
                return;
              }
              try { window.open(`https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(addr)}`, '_blank'); } catch { }
            }}
            className={`absolute right-0 top-1/2 -translate-y-1/2 p-4 flex items-center justify-center ${hasAddress ? 'cursor-pointer active:scale-95 active:bg-white/10 rounded-full transition-all' : 'cursor-not-allowed opacity-40'}`}
            title={hasAddress ? (t('orderCard.getDirections') || 'Get Directions') + ': ' + addr : (t('orderCard.missingAddress') || 'No address available')}
          >
            <svg
              width="32"
              height="32"
              viewBox="0 0 24 24"
              fill="none"
              stroke={hasAddress ? '#22c55e' : '#9ca3af'}
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
        <div className={`mt-4 pt-4 border-t ${resolvedTheme === 'light' ? 'border-gray-200' : 'border-white/10'
          }`}>
          <OrderStatusControls
            order={order}
            onStatusChange={onStatusChange}
            onDriverAssign={onDriverAssign}
            disabled={false}
          />
        </div>
      )}
    </div>
  );
});

OrderCard.displayName = 'OrderCard';
export default OrderCard; 
