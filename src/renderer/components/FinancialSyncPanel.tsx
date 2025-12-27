import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

interface FinancialSyncItem {
    id: string;
    table_name: string;
    record_id: string;
    operation: string;
    data: string; // JSON string
    attempts: number;
    error_message: string;
    created_at: string;
}

interface FinancialSyncPanelProps {
    isOpen: boolean;
    onClose: () => void;
    onRefresh: () => void;
}

export const FinancialSyncPanel: React.FC<FinancialSyncPanelProps> = ({
    isOpen,
    onClose,
    onRefresh
}) => {
    const { t } = useTranslation();
    const [items, setItems] = useState<FinancialSyncItem[]>([]);
    const [loading, setLoading] = useState(false);
    const [processing, setProcessing] = useState<string | null>(null); // ID of item being processed

    const loadItems = async () => {
        setLoading(true);
        try {
            if (window.electronAPI && typeof (window.electronAPI as any).getFailedFinancialSyncItems === 'function') {
                const failedItems = await (window.electronAPI as any).getFailedFinancialSyncItems(50);
                console.log('Loaded failed financial items:', failedItems);
                setItems(Array.isArray(failedItems) ? failedItems : []);
            } else {
                console.warn('getFailedFinancialSyncItems is not available');
            }
        } catch (err) {
            console.error('Failed to load financial sync items', err);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        if (isOpen) {
            loadItems();
        }
    }, [isOpen]);

    const handleRetryItem = async (id: string) => {
        setProcessing(id);
        try {
            if (window.electronAPI && typeof (window.electronAPI as any).retryFinancialSyncItem === 'function') {
                await (window.electronAPI as any).retryFinancialSyncItem(id);
                await loadItems();
                onRefresh();
            } else {
                console.warn('retryFinancialSyncItem is not available');
            }
        } catch (err) {
            console.error('Failed to retry item', err);
        } finally {
            setProcessing(null);
        }
    };

    const handleRetryAll = async () => {
        setProcessing('all');
        try {
            if (window.electronAPI && typeof (window.electronAPI as any).retryAllFailedFinancialSyncs === 'function') {
                await (window.electronAPI as any).retryAllFailedFinancialSyncs();
                await loadItems();
                onRefresh();
            } else {
                console.warn('retryAllFailedFinancialSyncs is not available');
            }
        } catch (err) {
            console.error('Failed to retry all', err);
        } finally {
            setProcessing(null);
        }
    };

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 z-[2000] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
            <div className="bg-gray-900 border border-white/10 rounded-2xl shadow-2xl w-full max-w-4xl max-h-[80vh] flex flex-col">
                {/* Header */}
                <div className="p-6 border-b border-white/10 flex justify-between items-center bg-gray-800/50 rounded-t-2xl">
                    <div>
                        <h2 className="text-xl font-bold text-white">{t('sync.financial.title')}</h2>
                        <p className="text-gray-400 text-sm mt-1">{t('sync.financial.subtitle')}</p>
                    </div>
                    <button onClick={onClose} className="text-gray-400 hover:text-white transition-colors">
                        <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                        </svg>
                    </button>
                </div>

                {/* Content */}
                <div className="flex-1 overflow-auto p-6 bg-gray-900">
                    {loading ? (
                        <div className="flex justify-center items-center h-40">
                            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
                        </div>
                    ) : items.length === 0 ? (
                        <div className="text-center py-12">
                            <svg className="w-16 h-16 text-green-500 mx-auto mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                            </svg>
                            <h3 className="text-lg font-medium text-white">{t('sync.financial.allClear')}</h3>
                            <p className="text-gray-400">{t('sync.financial.noFailedItems')}</p>
                        </div>
                    ) : (
                        <div className="space-y-4">
                            <div className="flex justify-between items-center mb-4">
                                <span className="text-red-400 font-medium">{items.length} {t('sync.financial.failedItems')}</span>
                                <button
                                    onClick={handleRetryAll}
                                    disabled={!!processing}
                                    className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
                                >
                                    {processing === 'all' ? t('sync.financial.retryingAll') : t('sync.financial.retryAll')}
                                </button>
                            </div>

                            <div className="space-y-3">
                                {items.map(item => (
                                    <div key={item.id} className="bg-gray-800/40 border border-white/5 rounded-xl p-4 hover:border-white/10 transition-colors">
                                        <div className="flex justify-between items-start gap-4">
                                            <div className="flex-1 min-w-0">
                                                <div className="flex items-center gap-2 mb-1">
                                                    <span className="bg-red-500/20 text-red-400 px-2 py-0.5 rounded text-xs font-mono uppercase border border-red-500/20">{item.table_name}</span>
                                                    <span className="bg-gray-700 text-gray-300 px-2 py-0.5 rounded text-xs font-mono uppercase">{item.operation}</span>
                                                    <span className="text-gray-500 text-xs text-mono">{new Date(item.created_at).toLocaleString()}</span>
                                                </div>
                                                <div className="text-red-300 text-sm mb-2 font-mono break-all line-clamp-2">
                                                    {item.error_message}
                                                </div>
                                                <details className="text-xs text-gray-500 cursor-pointer">
                                                    <summary className="hover:text-gray-300 transition-colors">{t('sync.financial.viewPayload')}</summary>
                                                    <pre className="mt-2 p-2 bg-black/30 rounded overflow-x-auto text-gray-400 font-mono text-[10px]">
                                                        {JSON.stringify(JSON.parse(item.data), null, 2)}
                                                    </pre>
                                                </details>
                                            </div>

                                            <div className="flex flex-col items-end gap-2">
                                                <span className="text-xs text-gray-500 bg-black/20 px-2 py-1 rounded">
                                                    {t('sync.financial.attempts')}: <span className="text-white font-mono">{item.attempts}</span>
                                                </span>
                                                <button
                                                    onClick={() => handleRetryItem(item.id)}
                                                    disabled={!!processing}
                                                    className="px-3 py-1.5 bg-white/5 hover:bg-white/10 text-white rounded-lg text-xs font-medium border border-white/10 transition-colors disabled:opacity-50"
                                                >
                                                    {processing === item.id ? '...' : t('sync.financial.retry')}
                                                </button>
                                            </div>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};
