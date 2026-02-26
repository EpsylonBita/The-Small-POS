import React, { useState, useEffect } from "react";
import { useTranslation } from 'react-i18next';
import { useTheme } from '../../contexts/theme-context';
import { History, X, Package, Truck, ShoppingBag, Store, ChevronRight, RefreshCw } from 'lucide-react';
import { toast } from 'react-hot-toast';
import { formatCurrency, formatDateTime } from '../../utils/format';
import { getBridge } from '../../../lib';

interface CustomerOrder {
    id: string;
    order_number: string;
    status: string;
    order_type: string;
    total_amount: number;
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
    const { resolvedTheme } = useTheme();
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
            case 'pending': return 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30';
            case 'preparing': return 'bg-blue-500/20 text-blue-400 border-blue-500/30';
            case 'ready': return 'bg-purple-500/20 text-purple-400 border-purple-500/30';
            case 'completed':
            case 'delivered': return 'bg-green-500/20 text-green-400 border-green-500/30';
            case 'cancelled': return 'bg-red-500/20 text-red-400 border-red-500/30';
            default: return 'bg-gray-500/20 text-gray-400 border-gray-500/30';
        }
    };

    const getOrderTypeIcon = (type: string) => {
        switch (type?.toLowerCase()) {
            case 'delivery': return <Truck className="w-4 h-4" />;
            case 'pickup': return <ShoppingBag className="w-4 h-4" />;
            case 'dine-in': return <Store className="w-4 h-4" />;
            default: return <Package className="w-4 h-4" />;
        }
    };

    // Calculate totals
    const totalSpent = orders.reduce((sum, o) => sum + (o.total_amount || 0), 0);
    const totalOrders = orders.length;

    return (
        <>
            {/* Backdrop */}
            <div
                className="liquid-glass-modal-backdrop fixed inset-0 z-[1100]"
                onClick={onClose}
            />

            {/* Modal Container */}
            <div className="liquid-glass-modal-shell fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-2xl max-h-[80vh] z-[1150] flex flex-col">

                {/* Header */}
                <div className="flex-shrink-0 px-6 py-4 border-b liquid-glass-modal-border">
                    <div className="flex justify-between items-center">
                        <div className="flex items-center gap-3">
                            <div className="p-2 rounded-lg bg-blue-500/20 text-blue-400">
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
                            className="liquid-glass-modal-button p-2 min-h-0 min-w-0"
                            aria-label={t('common.actions.close')}
                        >
                            <X className="w-5 h-5" />
                        </button>
                    </div>
                </div>

                {/* Stats Bar */}
                <div className="flex-shrink-0 px-6 py-3 bg-white/5 border-b liquid-glass-modal-border">
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
                                <div className="text-lg font-bold text-green-400">{formatCurrency(totalSpent)}</div>
                            </div>
                        </div>
                        <button
                            onClick={loadCustomerOrders}
                            disabled={loading}
                            className="liquid-glass-modal-button p-2 min-h-0 min-w-0"
                        >
                            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
                        </button>
                    </div>
                </div>

                {/* Scrollable Content */}
                <div className="flex-1 overflow-y-auto px-6 py-4 min-h-0 scrollbar-hide">
                    {loading ? (
                        <div className="flex items-center justify-center py-12">
                            <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-blue-500"></div>
                        </div>
                    ) : orders.length === 0 ? (
                        <div className="text-center py-12">
                            <Package className="w-12 h-12 mx-auto mb-4 opacity-30" />
                            <p className="liquid-glass-modal-text-muted">
                                {t('modals.customerHistory.noOrders') || 'No order history found'}
                            </p>
                        </div>
                    ) : (
                        <div className="space-y-3">
                            {orders.map((order) => (
                                <div
                                    key={order.id}
                                    className="p-4 bg-white/5 rounded-lg border border-white/10 hover:bg-white/10 transition-colors cursor-pointer"
                                    onClick={() => onViewOrder?.(order.id)}
                                >
                                    <div className="flex items-center justify-between">
                                        <div className="flex items-center gap-4">
                                            {/* Order Type Icon */}
                                            <div className="p-2 rounded-lg bg-white/5 text-white/70">
                                                {getOrderTypeIcon(order.order_type)}
                                            </div>

                                            <div>
                                                {/* Order Number & Date */}
                                                <div className="flex items-center gap-2 mb-1">
                                                    <span className="font-mono font-bold liquid-glass-modal-text">
                                                        #{order.order_number}
                                                    </span>
                                                    <span className={`text-xs px-2 py-0.5 rounded-full border ${getStatusColor(order.status)}`}>
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
                                                    {formatCurrency(order.total_amount)}
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
                                </div>
                            ))}
                        </div>
                    )}
                </div>

                {/* Footer */}
                <div className="flex-shrink-0 px-6 py-4 border-t liquid-glass-modal-border">
                    <button
                        onClick={onClose}
                        className="liquid-glass-modal-button w-full bg-blue-600/20 hover:bg-blue-600/30 text-blue-400 border-blue-500/30"
                    >
                        {t('common.actions.close') || 'Close'}
                    </button>
                </div>

            </div>
        </>
    );
};

export default CustomerOrderHistoryModal;
