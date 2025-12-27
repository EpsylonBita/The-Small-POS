import React, { useState, useEffect } from "react";
import { useTranslation } from 'react-i18next';
import { useTheme } from '../../contexts/theme-context';
import { Package, MapPin, User, Clock, CreditCard, ChevronRight, X, Printer } from 'lucide-react';
import { toast } from 'react-hot-toast';

interface OrderDetailsModalProps {
  isOpen: boolean;
  orderId: string;
  order?: any;
  onClose: () => void;
  onPrintReceipt?: () => void;
}

const OrderDetailsModal: React.FC<OrderDetailsModalProps> = ({
  isOpen,
  orderId,
  order,
  onClose,
  onPrintReceipt,
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
    }).format(amount);
  };

  const getStatusColor = (status: string) => {
    switch (status?.toLowerCase()) {
      case 'pending': return 'bg-yellow-500/20 text-yellow-600 dark:text-yellow-400 border-yellow-500/30';
      case 'processing': return 'bg-blue-500/20 text-blue-600 dark:text-blue-400 border-blue-500/30';
      case 'completed': return 'bg-green-500/20 text-green-600 dark:text-green-400 border-green-500/30';
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

  // Use real data or fallback to default values
  const displayOrder = orderData || order || {};
  const items = displayOrder.items || [];
  const customer = displayOrder.customer || {};
  const deliveryAddress = displayOrder.delivery_address || {};
  const subtotal = displayOrder.subtotal || 0;
  const tax = displayOrder.tax || 0;
  const deliveryFee = displayOrder.delivery_fee || 0;
  const total = displayOrder.total || 0;
  const status = displayOrder.status || 'pending';
  const orderType = displayOrder.order_type || 'delivery';
  const createdAt = displayOrder.created_at ? new Date(displayOrder.created_at) : new Date();

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
                  {t('modals.orderDetails.orderNumber') || 'Order'} #{orderId}
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

              {/* Order Type Banner */}
              <div className="liquid-glass-modal-card">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="p-2 bg-blue-500/20 rounded-lg text-blue-600 dark:text-blue-400">
                      <Clock className="w-5 h-5" />
                    </div>
                    <div>
                      <h3 className="font-semibold liquid-glass-modal-text">
                        {getOrderTypeLabel(orderType)}
                      </h3>
                      <p className="text-sm liquid-glass-modal-text-muted">
                        {orderType === 'delivery' && deliveryAddress?.address
                          ? deliveryAddress.address
                          : t('modals.orderDetails.processing') || 'Processing'}
                      </p>
                    </div>
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                {/* Left Column: Customer & Delivery Info */}
                <div className="md:col-span-1 space-y-6">

                  {/* Customer Card */}
                  <div className="liquid-glass-modal-card">
                    <h4 className="flex items-center gap-2 text-sm font-bold uppercase tracking-wider liquid-glass-modal-text-muted mb-4">
                      <User className="w-4 h-4" />
                      {t('modals.orderDetails.customerInformation') || 'Customer'}
                    </h4>
                    <div className="space-y-3">
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-full bg-gradient-to-br from-purple-500 to-indigo-600 flex items-center justify-center text-white font-bold text-lg shadow-lg">
                          {customer.name ? customer.name.charAt(0).toUpperCase() : '?'}
                        </div>
                        <div>
                          <div className="font-semibold liquid-glass-modal-text">
                            {customer.name || t('modals.orderDetails.guestCustomer') || 'Guest'}
                          </div>
                          <div className="text-sm liquid-glass-modal-text-muted">
                            {customer.phone || t('modals.orderDetails.noPhone') || 'No phone'}
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Delivery Address Card - Show only for delivery orders */}
                  {orderType === 'delivery' && (
                    <div className="liquid-glass-modal-card">
                      <h4 className="flex items-center gap-2 text-sm font-bold uppercase tracking-wider liquid-glass-modal-text-muted mb-4">
                        <MapPin className="w-4 h-4" />
                        {t('modals.orderDetails.address') || 'Address'}
                      </h4>
                      <div className="p-3 bg-white/5 dark:bg-black/20 rounded-lg border border-white/10 dark:border-white/5">
                        <p className="font-medium liquid-glass-modal-text">
                          {deliveryAddress.address || t('modals.orderDetails.noAddress') || 'No address'}
                        </p>
                        {deliveryAddress.address_line2 && (
                          <p className="text-sm liquid-glass-modal-text-muted">
                            {deliveryAddress.address_line2}
                          </p>
                        )}
                        {deliveryAddress.city && (
                          <p className="text-sm liquid-glass-modal-text-muted">
                            {deliveryAddress.city}
                          </p>
                        )}
                        {deliveryAddress.notes && (
                          <p className="text-xs liquid-glass-modal-text-muted mt-2 italic">
                            {t('modals.orderDetails.notes') || 'Notes'}: {deliveryAddress.notes}
                          </p>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Payment Method Card */}
                  <div className="liquid-glass-modal-card">
                    <h4 className="flex items-center gap-2 text-sm font-bold uppercase tracking-wider liquid-glass-modal-text-muted mb-4">
                      <CreditCard className="w-4 h-4" />
                      {t('modals.orderDetails.paymentMethod') || 'Payment'}
                    </h4>
                    <div className="p-3 bg-white/5 dark:bg-black/20 rounded-lg border border-white/10 dark:border-white/5">
                      <p className="font-medium liquid-glass-modal-text">
                        {displayOrder.payment_method === 'card'
                          ? t('modals.orderDetails.card') || 'Card'
                          : displayOrder.payment_method === 'cash'
                          ? t('modals.orderDetails.cash') || 'Cash'
                          : t('modals.orderDetails.pending') || 'Pending'}
                      </p>
                    </div>
                  </div>

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
                        items.map((item: any, index: number) => (
                          <div
                            key={index}
                            className="flex items-start justify-between p-3 bg-white/5 dark:bg-white/5 rounded-lg border border-white/10 hover:bg-white/10 transition-colors"
                          >
                            <div className="flex items-start gap-3 flex-1">
                              <div className="w-8 h-8 rounded-md bg-orange-500/20 text-orange-400 flex items-center justify-center font-bold text-sm border border-orange-500/20 flex-shrink-0">
                                {item.quantity || 1}x
                              </div>
                              <div className="flex-1">
                                <div className="font-medium liquid-glass-modal-text">
                                  {item.name || item.menu_item?.name || 'Item'}
                                </div>
                                {item.customizations && item.customizations.length > 0 && (
                                  <div className="text-xs liquid-glass-modal-text-muted mt-1">
                                    {item.customizations.map((c: any) => c.name || c.ingredient?.name).join(', ')}
                                  </div>
                                )}
                                {item.notes && (
                                  <div className="text-xs liquid-glass-modal-text-muted mt-1 italic">
                                    {item.notes}
                                  </div>
                                )}
                              </div>
                            </div>
                            <div className="font-semibold liquid-glass-modal-text ml-3 flex-shrink-0">
                              {formatCurrency(item.total_price || item.price || 0)}
                            </div>
                          </div>
                        ))
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
                        <div className="flex justify-between text-sm liquid-glass-modal-text-muted pb-2">
                          <span>{t('modals.orderDetails.deliveryFee') || 'Delivery Fee'}</span>
                          <span>{formatCurrency(deliveryFee)}</span>
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
