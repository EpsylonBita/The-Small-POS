import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { getBridge, offEvent, onEvent } from '../../lib';

interface InterTerminalStatus {
    parentInfo: any;
    isParentReachable: boolean;
    routingMode: 'main' | 'via_parent' | 'direct_cloud' | 'unknown';
}

export const OrderSyncRouteIndicator: React.FC<{ condensed?: boolean }> = ({ condensed = false }) => {
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

    return (
        <div className="bg-white/5 rounded-lg p-3 border border-white/10 mt-2">
            <div className="flex items-center justify-between mb-1">
                <span className="text-xs text-gray-400">{t('sync.routing.label', 'Order Routing')}</span>
                <span className={`text-xs font-semibold ${status.routingMode === 'via_parent' ? 'text-blue-400' :
                        status.routingMode === 'direct_cloud' ? 'text-orange-400' : 'text-gray-400'
                    }`}>
                    {status.routingMode === 'via_parent' ? t('sync.routing.viaParent', 'Via Main POS') : t('sync.routing.directCloud', 'Direct to Cloud')}
                </span>
            </div>
            {status.parentInfo && (
                <div className="flex items-center justify-between">
                    <span className="text-xs text-gray-400">{t('sync.routing.parent', 'Parent')}</span>
                    <span className="text-xs text-white">{status.parentInfo.name || status.parentInfo.host}</span>
                </div>
            )}
        </div>
    );
};
