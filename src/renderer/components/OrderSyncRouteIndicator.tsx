import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { getBridge, offEvent, onEvent } from '../../lib';

interface InterTerminalStatus {
    parentInfo: any;
    isParentReachable: boolean;
    routingMode: 'main' | 'via_parent' | 'direct_cloud' | 'unknown';
}

interface OrderSyncRouteIndicatorProps {
    condensed?: boolean;
    variant?: 'default' | 'dashboard';
    className?: string;
}

export const OrderSyncRouteIndicator: React.FC<OrderSyncRouteIndicatorProps> = ({
    condensed = false,
    variant = 'default',
    className = '',
}) => {
    const bridge = getBridge();
    const { t } = useTranslation();
    const [status, setStatus] = useState<InterTerminalStatus | null>(null);

    useEffect(() => {
        const fetchStatus = async () => {
            try {
                const result = await bridge.sync.getInterTerminalStatus();
                setStatus(result);
            } catch (e) {
                console.error("Failed to get inter-terminal status", e);
            }
        };

        const handleNetworkStatus = (network: { isOnline?: boolean }) => {
            setStatus(prev => {
                if (!prev) return prev;
                const isParentReachable = !!network?.isOnline;
                return {
                    ...prev,
                    isParentReachable,
                    routingMode: isParentReachable ? 'via_parent' : 'direct_cloud',
                };
            });
        };

        fetchStatus();
        onEvent('network:status', handleNetworkStatus);
        return () => {
            offEvent('network:status', handleNetworkStatus);
        };
    }, []);

    if (!status || status.routingMode === 'main') return null;

    if (condensed) {
        return (
            <div className="flex items-center gap-1 text-xs" title={t('sync.routing.viaParent')}>
                <span className={`w-2 h-2 rounded-full ${status.routingMode === 'via_parent' && status.parentInfo ? 'bg-blue-400' : 'bg-orange-400'}`}></span>
            </div>
        );
    }

    if (variant === 'dashboard') {
        const routeTone = status.routingMode === 'via_parent'
            ? 'border-blue-200/90 bg-blue-50/85 text-blue-700 dark:border-blue-400/30 dark:bg-blue-500/10 dark:text-blue-200'
            : status.routingMode === 'direct_cloud'
                ? 'border-amber-200/90 bg-amber-50/85 text-amber-700 dark:border-amber-400/30 dark:bg-amber-500/10 dark:text-amber-200'
                : 'border-slate-200/90 bg-slate-50/85 text-slate-700 dark:border-white/10 dark:bg-white/[0.04] dark:text-slate-200';

        return (
            <div className={`rounded-[24px] border border-slate-200/80 bg-white/92 p-4 shadow-[0_12px_28px_rgba(15,23,42,0.06)] dark:border-white/10 dark:bg-white/[0.04] dark:shadow-[0_16px_32px_rgba(2,6,23,0.22)] ${className}`.trim()}>
                <div className="flex items-start justify-between gap-4">
                    <div>
                        <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500 dark:text-slate-400">
                            {t('sync.routing.label')}
                        </div>
                        <p className="mt-2 text-sm text-slate-600 dark:text-slate-300/80">
                            {t('sync.routing.description')}
                        </p>
                    </div>
                    <span className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-semibold ${routeTone}`}>
                        <span className={`h-2 w-2 rounded-full ${status.routingMode === 'via_parent' && status.parentInfo ? 'bg-blue-500 dark:bg-blue-300' : 'bg-amber-500 dark:bg-amber-300'}`} />
                        {status.routingMode === 'via_parent'
                            ? t('sync.routing.viaParent')
                            : t('sync.routing.directCloud')}
                    </span>
                </div>

                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                    <div className="rounded-[18px] border border-slate-200/80 bg-slate-50/90 px-4 py-3 dark:border-white/10 dark:bg-black/20">
                        <div className="text-[11px] uppercase tracking-[0.2em] text-slate-500 dark:text-slate-400">
                            {t('sync.routing.status')}
                        </div>
                        <div className="mt-2 text-sm font-semibold text-slate-900 dark:text-white">
                            {status.routingMode === 'via_parent'
                                ? t('sync.routing.viaParent')
                                : t('sync.routing.directCloud')}
                        </div>
                    </div>

                    <div className="rounded-[18px] border border-slate-200/80 bg-slate-50/90 px-4 py-3 dark:border-white/10 dark:bg-black/20">
                        <div className="text-[11px] uppercase tracking-[0.2em] text-slate-500 dark:text-slate-400">
                            {t('sync.routing.parent')}
                        </div>
                        <div className="mt-2 break-all text-sm font-semibold text-slate-900 dark:text-white">
                            {status.parentInfo?.name || status.parentInfo?.host || t('sync.dashboard.notAvailable')}
                        </div>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className={`rounded-lg border border-slate-200/80 bg-white/90 p-3 mt-2 dark:border-white/10 dark:bg-white/[0.04] ${className}`.trim()}>
            <div className="flex items-center justify-between mb-1">
                <span className="text-xs text-slate-500 dark:text-slate-400">{t('sync.routing.label')}</span>
                <span className={`text-xs font-semibold ${status.routingMode === 'via_parent' ? 'text-blue-600 dark:text-blue-300' :
                        status.routingMode === 'direct_cloud' ? 'text-orange-600 dark:text-orange-300' : 'text-slate-500 dark:text-slate-400'
                    }`}>
                    {status.routingMode === 'via_parent' ? t('sync.routing.viaParent') : t('sync.routing.directCloud')}
                </span>
            </div>
            {status.parentInfo && (
                <div className="flex items-center justify-between">
                    <span className="text-xs text-slate-500 dark:text-slate-400">{t('sync.routing.parent')}</span>
                    <span className="text-xs text-slate-900 dark:text-white">{status.parentInfo.name || status.parentInfo.host}</span>
                </div>
            )}
        </div>
    );
};
