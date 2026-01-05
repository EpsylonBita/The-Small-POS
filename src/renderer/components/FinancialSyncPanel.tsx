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
        <>
            {/* Backdrop */}
            <div
                className="fixed inset-0 z-[2000] liquid-glass-modal-backdrop"
                onClick={onClose}
            />

            {/* Modal */}
            <div className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 liquid-glass-modal-shell w-full max-w-4xl max-h-[85vh] overflow-hidden z-[2050] rounded-3xl">
                {/* Header */}
                <div className="p-6 border-b liquid-glass-modal-border rounded-t-3xl">
                    <div className="flex justify-between items-center">
                        <div className="flex items-center gap-3">
                            <svg className="w-7 h-7 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                            </svg>
                            <div>
                                <h2 className="text-2xl font-extrabold text-black dark:text-white">{t('sync.financial.title')}</h2>
                                <p className="text-sm font-medium text-slate-600 dark:text-slate-400 mt-1">{t('sync.financial.subtitle')}</p>
                            </div>
                        </div>
                        <button
                            onClick={onClose}
                            className="liquid-glass-modal-button p-2 min-h-0 min-w-0 rounded-xl"
                            aria-label={t('common.actions.close')}
                        >
                            <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                            </svg>
                        </button>
                    </div>
                </div>

                {/* Content */}
                <div className="flex-1 overflow-auto p-6 max-h-[calc(85vh-100px)]">
                    {loading ? (
                        <div className="flex justify-center items-center h-40">
                            <div className="animate-spin rounded-full h-10 w-10 border-4 border-blue-500/30 border-t-blue-500"></div>
                        </div>
                    ) : items.length === 0 ? (
                        <div className="text-center py-16">
                            <div className="w-20 h-20 mx-auto mb-6 rounded-full bg-green-500/20 flex items-center justify-center">
                                <svg className="w-10 h-10 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                                </svg>
                            </div>
                            <h3 className="text-xl font-extrabold text-black dark:text-white mb-2">{t('sync.financial.allClear')}</h3>
                            <p className="text-slate-600 dark:text-slate-400 font-medium">{t('sync.financial.noFailedItems')}</p>
                        </div>
                    ) : (
                        <div className="space-y-4">
                            {/* Failed items header */}
                            <div className="flex justify-between items-center mb-4 p-4 liquid-glass-modal-card rounded-2xl">
                                <div className="flex items-center gap-3">
                                    <div className="w-10 h-10 rounded-full bg-red-500/20 flex items-center justify-center">
                                        <svg className="w-5 h-5 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                                        </svg>
                                    </div>
                                    <span className="text-red-700 dark:text-red-300 font-bold text-lg">
                                        {items.length} {t('sync.financial.failedItems')}
                                    </span>
                                </div>
                                <button
                                    onClick={handleRetryAll}
                                    disabled={!!processing}
                                    className="px-5 py-2.5 bg-gradient-to-r from-blue-500 to-cyan-500 hover:from-blue-600 hover:to-cyan-600 text-white rounded-xl text-sm font-bold transition-all shadow-lg shadow-blue-500/25 hover:shadow-blue-500/40 hover:scale-[1.02] active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:scale-100"
                                >
                                    {processing === 'all' ? t('sync.financial.retryingAll') : t('sync.financial.retryAll')}
                                </button>
                            </div>

                            {/* Items list */}
                            <div className="space-y-3">
                                {items.map(item => (
                                    <div key={item.id} className="liquid-glass-modal-card rounded-2xl p-4 hover:border-white/20 transition-all">
                                        <div className="flex justify-between items-start gap-4">
                                            <div className="flex-1 min-w-0">
                                                <div className="flex flex-wrap items-center gap-2 mb-2">
                                                    <span className="bg-red-500/20 text-red-700 dark:text-red-300 px-3 py-1 rounded-lg text-xs font-bold uppercase border border-red-500/30">
                                                        {item.table_name}
                                                    </span>
                                                    <span className="bg-slate-500/20 text-slate-700 dark:text-slate-300 px-3 py-1 rounded-lg text-xs font-bold uppercase border border-slate-500/30">
                                                        {item.operation}
                                                    </span>
                                                    <span className="text-slate-500 dark:text-slate-400 text-xs font-medium">
                                                        {new Date(item.created_at).toLocaleString()}
                                                    </span>
                                                </div>
                                                <div className="text-red-700 dark:text-red-300 text-sm mb-3 font-medium break-all line-clamp-2">
                                                    {item.error_message}
                                                </div>
                                                <details className="text-xs cursor-pointer group">
                                                    <summary className="text-blue-600 dark:text-blue-400 hover:text-blue-500 dark:hover:text-blue-300 transition-colors font-semibold">
                                                        {t('sync.financial.viewPayload')}
                                                    </summary>
                                                    <pre className="mt-2 p-3 bg-slate-100 dark:bg-slate-800/50 rounded-xl overflow-x-auto text-slate-700 dark:text-slate-300 font-mono text-[10px] border border-slate-300/50 dark:border-slate-600/50">
                                                        {JSON.stringify(JSON.parse(item.data), null, 2)}
                                                    </pre>
                                                </details>
                                            </div>

                                            <div className="flex flex-col items-end gap-2">
                                                <span className="text-xs font-bold text-slate-600 dark:text-slate-400 bg-slate-100 dark:bg-slate-800/50 px-3 py-1.5 rounded-lg border border-slate-300/50 dark:border-slate-600/50">
                                                    {t('sync.financial.attempts')}: <span className="text-black dark:text-white font-mono">{item.attempts}</span>
                                                </span>
                                                <button
                                                    onClick={() => handleRetryItem(item.id)}
                                                    disabled={!!processing}
                                                    className="px-4 py-2 bg-white/10 hover:bg-white/20 dark:bg-white/5 dark:hover:bg-white/10 text-black dark:text-white rounded-xl text-xs font-bold border border-slate-300/50 dark:border-white/10 transition-all hover:scale-[1.02] active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed"
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
        </>
    );
};
