import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';

interface InterTerminalStatus {
    parentInfo: any;
    isParentReachable: boolean;
    routingMode: 'main' | 'via_parent' | 'direct_cloud' | 'unknown';
}

export const OrderSyncRouteIndicator: React.FC<{ condensed?: boolean }> = ({ condensed = false }) => {
    const { t } = useTranslation();
    const [status, setStatus] = useState<InterTerminalStatus | null>(null);

    useEffect(() => {
        const fetchStatus = async () => {
            if (window.electronAPI?.invoke) {
                try {
                    const result = await window.electronAPI.invoke('sync:get-inter-terminal-status');
                    setStatus(result);

                    // Also trigger a connection test if via_parent
                    if (result.routingMode === 'via_parent') {
                        // We don't want to spam, but initial status might be stale if no recent sync
                        // Just rely on what main process reports
                    }
                } catch (e) {
                    console.error("Failed to get inter-terminal status", e);
                }
            }
        };

        fetchStatus();
        const interval = setInterval(fetchStatus, 15000); // Poll every 15s
        return () => clearInterval(interval);
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
