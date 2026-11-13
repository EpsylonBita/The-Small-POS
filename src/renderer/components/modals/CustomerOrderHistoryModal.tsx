import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import React, { useState, useEffect } from "react";
import { useTranslation } from 'react-i18next';
import { History, X, Package, Store, ChevronRight, RefreshCw } from 'lucide-react';
import { DeliveryScooterIcon, PickupHandBagIcon } from '../icons/OrderTypeGlyphs';
import { toast } from 'react-hot-toast';
import { formatCurrency, formatDateTime } from '../../utils/format';
import { getBridge } from '../../../lib';

interface CustomerOrder {
    id: string;
    order_number: string;
    status: string;
    order_type: string;
    total_amount: number;
    currency?: string | null;
    payment_method?: string;
    created_at: string;
    items_count?: number;
}

interface CustomerOrderHistoryModalProps {
    isOpen: boolean;
    customerPhone: string;
    customerName?: string;
    onClose: () => void;
    onViewOrder?: (orderId: string) => void;
}

const CustomerOrderHistoryModal: React.FC<CustomerOrderHistoryModalProps> = ({
    isOpen,
    customerPhone,
    customerName,
    onClose,
    onViewOrder,
}) => {
    const { t } = useTranslation();
  // Presentation only: preserve every existing reveal condition (founder 11/11/2026).
  const reduceMotion = useReducedMotion();
  const revealMotion = {
    initial: reduceMotion ? false as const : { opacity: 0, height: 0, y: 12, overflow: 'hidden' },
    animate: { opacity: 1, height: 'auto', y: 0, overflow: 'visible' },
    exit: reduceMotion ? { opacity: 0 } : { opacity: 0, height: 0, overflow: 'hidden', transition: { overflow: { delay: 0, duration: 0 } } },
    transition: { duration: reduceMotion ? 0 : 0.24, ease: [0.2, 0.8, 0.2, 1] as const, overflow: { delay: reduceMotion ? 0 : 0.24, duration: 0 } },
  };
    const bridge = getBridge();
    const [orders, setOrders] = useState<CustomerOrder[]>([]);
    const [loading, setLoading] = useState(false);

    useEffect(() => {
        if (isOpen && customerPhone) {
            loadCustomerOrders();
        }
    }, [isOpen, customerPhone]);

    const loadCustomerOrders = async () => {
        try {
            setLoading(true);
            const result = await bridge.orders.getByCustomerPhone(customerPhone);

            if (result?.success && result.orders) {
                setOrders(result.orders);
            } else if (Array.isArray(result)) {
                setOrders(result);
            } else {
                console.warn('[CustomerHistory] No orders found or error:', result?.error);
                setOrders([]);
            }
        } catch (error) {
            console.error('Error loading customer orders:', error);
            toast.error(t('errors.loadOrdersFailed') || 'Failed to load order history');
            setOrders([]);
        } finally {
            setLoading(false);
        }
    };

    if (!isOpen) return null;

    const formatDate = (dateStr: string) => formatDateTime(dateStr, {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });

    const getStatusColor = (status: string) => {
        switch (status?.toLowerCase()) {
            case 'pending': return 'text-yellow-800 dark:text-yellow-300';
            case 'preparing': return 'text-amber-800 dark:text-amber-200';
            case 'ready': return 'text-green-800 dark:text-green-200';
            case 'completed':
            case 'delivered': return 'text-green-800 dark:text-green-300';
            case 'cancelled': return 'text-red-800 dark:text-red-300';
            default: return 'liquid-glass-modal-text-muted';
        }
    };

    const getOrderTypeIcon = (type: string) => {
        switch (type?.toLowerCase()) {
            case 'delivery': return <DeliveryScooterIcon className="h-5 w-5" />;
            case 'pickup': return <PickupHandBagIcon className="h-5 w-5" />;
            case 'dine-in': return <Store className="w-4 h-4" />;
            default: return <Package className="w-4 h-4" />;
        }
    };

    // Calculate totals
    const totalsByCurrency = orders.reduce((totals, order) => {
        const currency = order.currency?.trim().toUpperCase() || null;
        totals.set(currency, (totals.get(currency) ?? 0) + (order.total_amount ?? 0));
        return totals;
    }, new Map<string | null, number>());
    const totalSpent = Array.from(totalsByCurrency, ([currency, amount]) => formatCurrency(amount, currency)).join(' · ') || '—';
    const totalOrders = orders.length;

    return (
        <>
            {/* Backdrop */}
            <div
                className="liquid-glass-modal-backdrop fixed inset-0 z-1100"
                onClick={onClose}
            />

            {/* Modal Container */}
            <div className="liquid-glass-modal-shell fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-2xl max-h-[80vh] z-1150 flex flex-col">

                {/* Header */}
                <div className="shrink-0 px-6 py-4">
                    <div className="flex justify-between items-center">
                        <div className="flex items-center gap-3">
                            <div className="flex h-10 w-10 items-center justify-center rounded-2xl liquid-glass-modal-text-muted">
                                <History className="w-5 h-5" />
                            </div>
                            <div>
                                <h2 className="text-xl font-bold liquid-glass-modal-text">
                                    {t('modals.customerHistory.title') || 'Order History'}
                                </h2>
                                <p className="text-sm liquid-glass-modal-text-muted">
                                    {customerName || customerPhone}
                                </p>
                            </div>
                        </div>
                        <button
                            onClick={onClose}
                            className="liquid-glass-modal-close"
                            aria-label={t('common.actions.close')}
                        >
                            <X className="h-5 w-5" aria-hidden="true" />
                        </button>
                    </div>
                </div>

                {/* Stats Bar */}
                <div className="pos-glass-form-card shrink-0 mx-6 p-3!">
                    <div className="flex items-center justify-between">
                        <div className="flex items-center gap-6">
                            <div>
                                <div className="text-xs liquid-glass-modal-text-muted uppercase">
                                    {t('modals.customerHistory.totalOrders') || 'Total Orders'}
                                </div>
                                <div className="text-lg font-bold liquid-glass-modal-text">{totalOrders}</div>
                            </div>
                            <div>
                                <div className="text-xs liquid-glass-modal-text-muted uppercase">
                                    {t('modals.customerHistory.totalSpent') || 'Total Spent'}
                                </div>
                                <div className="text-lg font-bold liquid-glass-modal-text">{totalSpent}</div>
                            </div>
                        </div>
                        <button
                            onClick={loadCustomerOrders}
                            disabled={loading}
                            className="pos-glass-field flex min-h-touch min-w-touch items-center justify-center p-2"
                        >
                            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
                        </button>
                    </div>
                </div>

                {/* Scrollable Content */}
                <div className="flex-1 overflow-y-auto px-6 py-4 min-h-0 scrollbar-hide">
                    <AnimatePresence initial={false}>
                      {loading ? (
                        <motion.div {...revealMotion} key="loading" className="flex items-center justify-center py-12">
                            <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-yellow-400"></div>
                        </motion.div>
                    ) : orders.length === 0 ? (
                        <motion.div {...revealMotion} key="empty" className="text-center py-12">
                            <Package className="w-12 h-12 mx-auto mb-4 opacity-30" />
                            <p className="liquid-glass-modal-text-muted">
                                {t('modals.customerHistory.noOrders') || 'No order history found'}
                            </p>
                        </motion.div>
                    ) : (
                        <motion.div {...revealMotion} key="orders" className="space-y-3">
                            {orders.map((order) => (
                                <button
                                    type="button"
                                    key={order.id}
                                    disabled={!onViewOrder}
                                    className={`pos-glass-tap-card min-h-touch w-full p-4 text-left focus-visible:outline-2 focus-visible:outline-yellow-400 disabled:cursor-default ${onViewOrder ? 'cursor-pointer' : ''}`}
                                    onClick={() => onViewOrder?.(order.id)}
                                >
                                    <div className="flex items-center justify-between">
                                        <div className="flex items-center gap-4">
                                            {/* Order Type Icon */}
                                            <div className="flex h-10 w-10 items-center justify-center rounded-2xl liquid-glass-modal-text-muted">
                                                {getOrderTypeIcon(order.order_type)}
                                            </div>

                                            <div>
                                                {/* Order Number & Date */}
                                                <div className="flex items-center gap-2 mb-1">
                                                    <span className="font-mono font-bold liquid-glass-modal-text">
                                                        #{order.order_number}
                                                    </span>
                                                    <span className={`text-xs px-2 py-0.5 font-semibold ${getStatusColor(order.status)}`}>
                                                        {order.status}
                                                    </span>
                                                </div>
                                                <div className="text-xs liquid-glass-modal-text-muted">
                                                    {formatDate(order.created_at)}
                                                </div>
                                            </div>
                                        </div>

                                        <div className="flex items-center gap-3">
                                            <div className="text-right">
                                                <div className="font-bold liquid-glass-modal-text">
                                                    {formatCurrency(order.total_amount, order.currency ?? null)}
                                                </div>
                                                {order.items_count && (
                                                    <div className="text-xs liquid-glass-modal-text-muted">
                                                        {order.items_count} {order.items_count === 1 ? 'item' : 'items'}
                                                    </div>
                                                )}
                                            </div>
                                            {onViewOrder && (
                                                <ChevronRight className="w-4 h-4 liquid-glass-modal-text-muted" />
                                            )}
                                        </div>
                                    </div>
                                </button>
                            ))}
                        </motion.div>
                      )}
                    </AnimatePresence>
                </div>

                {/* Footer */}
                <div className="shrink-0 px-6 pb-5 pt-2">
                    <button
                        onClick={onClose}
                        className="liquid-glass-modal-button w-full border-(--pos-s-border) bg-(--pos-s-surface-2) text-yellow-800 dark:text-yellow-200 active:bg-(--pos-s-surface-2)"
                    >
                        {t('common.actions.close') || 'Close'}
                    </button>
                </div>

            </div>
        </>
    );
};

export default CustomerOrderHistoryModal;
