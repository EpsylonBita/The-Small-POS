import React, { memo } from 'react';
import type { Order } from '../../types/orders';

interface OrderRoutingBadgeProps {
    routingPath?: string;
    className?: string;
}

export const OrderRoutingBadge = memo<OrderRoutingBadgeProps>(({ routingPath, className = '' }) => {
    if (!routingPath || routingPath === 'main') return null;

    let label = '';
    let colorClasses = '';
    let Icon = null;

    switch (routingPath) {
        case 'via_parent':
            label = 'Sent via Parent';
            colorClasses = 'bg-(--pos-s-surface-2) text-blue-800 dark:text-blue-300 border-(--pos-s-border)';
            Icon = (
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
                </svg>
            );
            break;
        case 'direct_cloud':
            label = 'Direct Cloud';
            colorClasses = 'bg-(--pos-s-surface-2) text-purple-800 dark:text-purple-300 border-(--pos-s-border)';
            Icon = (
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 15a4 4 0 004 4h9a5 5 0 10-.1-9.999 5.002 5.002 0 10-9.78 2.096A4.001 4.001 0 003 15z" />
                </svg>
            );
            break;
        default:
            return null;
    }

    return (
        <div className={`flex items-center gap-1.5 px-2 py-0.5 rounded-full border text-[10px] font-medium ${colorClasses} ${className}`}>
            {Icon}
            <span className="whitespace-nowrap">{label}</span>
        </div>
    );
});

OrderRoutingBadge.displayName = 'OrderRoutingBadge';
