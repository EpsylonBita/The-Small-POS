import React, { useEffect, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { motion } from 'framer-motion';
import {
  Package,
  RefreshCw,
  Search,
  AlertTriangle,
  CheckCircle,
  XCircle,
  TrendingDown,
  TrendingUp,
  Boxes,
  BarChart3,
  Plus,
  Minus,
  Edit3,
  History,
  ReceiptText,
  X
} from 'lucide-react';
import { useTheme } from '../contexts/theme-context';
import { toast } from 'react-hot-toast';
import { formatCurrency, formatDate } from '../utils/format';
import { posApiGet, posApiPatch } from '../utils/api-helpers';
import { getBridge, isBrowser } from '../../lib';
import { offlineAdjustInventory } from '../services/offline-mutations';
import { getOfflineActionState } from '../services/offline-page-capabilities';

interface InventoryItem {
  id: string;
  product_id?: string;
  name_en: string;
  name_el: string;
  category_name?: string;
  stock_quantity: number;
  min_stock_level: number;
  cost_per_unit: number;
  unit_of_measurement: string;
  is_active: boolean;
}

interface InventoryHistoryInvoice {
  id: string;
  invoice_number: string | null;
  invoice_date: string | null;
  supplier_name: string | null;
}

interface InventoryPriceHistoryEntry {
  movement_id: string;
  invoice: InventoryHistoryInvoice | null;
  supplier_name: string | null;
  invoice_number: string | null;
  invoice_date: string | null;
  quantity: number;
  unit: string | null;
  cost_per_unit: number;
  previous_cost_per_unit: number | null;
  price_delta: number;
  price_delta_percent: number;
  price_change: 'initial' | 'same' | 'up' | 'down';
  total_cost: number;
  created_at: string;
}

interface InventoryMovementHistoryEntry {
  id: string;
  movement_type: string;
  quantity: number;
  unit: string | null;
  reason_code: string | null;
  reason_notes: string | null;
  cost_per_unit: number;
  total_cost: number;
  created_at: string;
  invoice: InventoryHistoryInvoice | null;
}

interface InventoryHistoryData {
  item: InventoryItem;
  price_history: InventoryPriceHistoryEntry[];
  movements: InventoryMovementHistoryEntry[];
  summary: {
    purchased_quantity: number;
    used_quantity: number;
    adjusted_quantity: number;
    latest_purchase_cost: number | null;
  };
}

type StockStatus = 'all' | 'critical' | 'low' | 'good';
type IpcInvoke = (channel: string, ...args: any[]) => Promise<any>;

function getIpcInvoke(): IpcInvoke | null {
  if (isBrowser()) return null;
  const bridge = getBridge();
  return bridge.invoke.bind(bridge);
}

function asNumber(value: unknown, fallback = 0): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}

function normalizeInventoryItem(item: any): InventoryItem {
  const nameEn = typeof item?.name_en === 'string' && item.name_en.trim()
    ? item.name_en
    : typeof item?.product_name === 'string' && item.product_name.trim()
      ? item.product_name
      : (typeof item?.name === 'string' && item.name.trim() ? item.name : 'Unnamed item');

  const nameEl = typeof item?.name_el === 'string' && item.name_el.trim()
    ? item.name_el
    : nameEn;

  return {
    id: String(item?.id || ''),
    product_id: typeof item?.product_id === 'string' ? item.product_id : undefined,
    name_en: nameEn,
    name_el: nameEl,
    category_name: typeof item?.category_name === 'string' ? item.category_name : undefined,
    stock_quantity: asNumber(item?.stock_quantity ?? item?.quantity, 0),
    min_stock_level: asNumber(item?.min_stock_level ?? item?.low_stock_threshold, 0),
    cost_per_unit: asNumber(item?.cost_per_unit, 0),
    unit_of_measurement: typeof item?.unit_of_measurement === 'string' && item.unit_of_measurement.trim()
      ? item.unit_of_measurement
      : 'pcs',
    is_active: item?.is_active !== false,
  };
}

function formatHistoryLoadError(error: unknown, t: (key: string, fallback: string) => string): string {
  const fallback = t('inventory.history.errors.loadFailed', 'Failed to load item history');
  const raw = error instanceof Error ? error.message : String(error || '');
  const message = raw.trim();
  const lower = message.toLowerCase();

  if (!message) {
    return fallback;
  }

  if (lower.includes('endpoint not found') || lower.includes('http 404') || lower.includes('page not found')) {
    return t(
      'inventory.history.errors.endpointUnavailable',
      'Inventory history API is not available on the connected admin dashboard. Restart or update the admin dashboard, then try again.'
    );
  }

  if (lower.includes('inventory item not found')) {
    return t('inventory.history.errors.itemNotFound', 'Inventory item was not found on the connected admin dashboard.');
  }

  return `${fallback}: ${message.length > 240 ? `${message.slice(0, 240).trim()}...` : message}`;
}

const InventoryPage: React.FC = () => {
  const { t, i18n } = useTranslation();
  const { resolvedTheme } = useTheme();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [inventory, setInventory] = useState<InventoryItem[]>([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState<StockStatus>('all');
  const [selectedItem, setSelectedItem] = useState<InventoryItem | null>(null);
  const [historyItem, setHistoryItem] = useState<InventoryItem | null>(null);
  const [historyData, setHistoryData] = useState<InventoryHistoryData | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [showAdjustModal, setShowAdjustModal] = useState(false);
  const [adjustmentQty, setAdjustmentQty] = useState(0);
  const [adjustmentReason, setAdjustmentReason] = useState<'count' | 'received' | 'damaged' | 'expired' | 'theft' | 'other'>('count');
  const [adjustmentNotes, setAdjustmentNotes] = useState('');
  const [isOnline, setIsOnline] = useState(navigator.onLine);

  const isDark = resolvedTheme === 'dark';
  const isGreek = i18n.language === 'el';
  const formatMoney = (amount: number) => formatCurrency(amount);
  const formatQuantity = (amount: number) => new Intl.NumberFormat(i18n.language || undefined, {
    maximumFractionDigits: 3,
  }).format(Number.isFinite(amount) ? amount : 0);
  const formatHistoryDate = (value: string | null | undefined) =>
    value ? formatDate(value, { day: '2-digit', month: 'short', year: 'numeric' }, i18n.language) : '-';
  const adjustAction = getOfflineActionState('inventory', 'adjust', isOnline);

  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  const fetchInventory = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const invoke = getIpcInvoke();
      if (invoke) {
        const result = await invoke('api:fetch-from-admin', '/api/pos/inventory');
        if (result?.success && result?.data?.success !== false) {
          const rows = Array.isArray(result?.data?.inventory)
            ? result.data.inventory
            : Array.isArray(result?.data?.data)
              ? result.data.data
              : [];
          const normalized: InventoryItem[] = rows.map(normalizeInventoryItem);
          setInventory(normalized.filter((item: InventoryItem) => item.is_active));
          return;
        }
        throw new Error(result?.error || result?.data?.error || 'Failed to fetch inventory');
      }

      const result = await posApiGet<any>('pos/inventory');
      if (!result.success || result.data?.success === false) {
        throw new Error(result.error || result.data?.error || 'Failed to fetch inventory');
      }
      const rows = Array.isArray(result.data?.inventory)
        ? result.data.inventory
        : Array.isArray(result.data?.data)
          ? result.data.data
          : [];
      const normalized: InventoryItem[] = rows.map(normalizeInventoryItem);
      setInventory(normalized.filter((item: InventoryItem) => item.is_active));
      setError(null);
    } catch (error) {
      console.error('Failed to fetch inventory:', error);
      const message = t('inventory.errors.loadFailed', 'Failed to load inventory');
      setError(message);
      toast.error(message);
      setInventory([]);
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    fetchInventory();
  }, [fetchInventory]);

  const getStockStatus = (item: InventoryItem): 'critical' | 'low' | 'good' => {
    if (item.stock_quantity <= 0) return 'critical';
    if (item.stock_quantity <= item.min_stock_level) return 'low';
    return 'good';
  };

  const filteredInventory = inventory.filter(item => {
    const name = isGreek ? item.name_el : item.name_en;
    const matchesSearch = name.toLowerCase().includes(searchTerm.toLowerCase());
    const status = getStockStatus(item);
    const matchesStatus = statusFilter === 'all' || status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  const stats = {
    total: inventory.length,
    critical: inventory.filter(i => getStockStatus(i) === 'critical').length,
    low: inventory.filter(i => getStockStatus(i) === 'low').length,
    good: inventory.filter(i => getStockStatus(i) === 'good').length,
    totalValue: inventory.reduce((sum, i) => sum + (i.stock_quantity * i.cost_per_unit), 0)
  };

  const StatusIcon = ({ status }: { status: 'critical' | 'low' | 'good' }) => {
    if (status === 'critical') return <XCircle className={`w-5 h-5 ${isDark ? 'text-zinc-300' : 'text-red-500'}`} />;
    if (status === 'low') return <AlertTriangle className={`w-5 h-5 ${isDark ? 'text-zinc-300' : 'text-yellow-500'}`} />;
    return <CheckCircle className={`w-5 h-5 ${isDark ? 'text-zinc-300' : 'text-green-500'}`} />;
  };

  const handleAdjustStock = useCallback(async () => {
    if (adjustAction.disabled) {
      toast.error(adjustAction.message || t('common.requiresOnline', 'This action requires an online connection.'));
      return;
    }

    if (!selectedItem || adjustmentQty === 0) return;

    const nextQuantity = selectedItem.stock_quantity + adjustmentQty;
    if (nextQuantity < 0) {
      toast.error(t('inventory.errors.adjustmentNegative', 'Adjustment would result in negative stock'));
      return;
    }

    try {
      const invoke = getIpcInvoke();
      if (invoke) {
        await offlineAdjustInventory({
          product_id: selectedItem.product_id || selectedItem.id,
          adjustment: adjustmentQty,
          reason: adjustmentReason,
          notes: adjustmentNotes.trim() || null,
        });
      } else {
        const result = await posApiPatch<any>('pos/inventory', {
          product_id: selectedItem.product_id || selectedItem.id,
          adjustment: adjustmentQty,
          reason: adjustmentReason,
          notes: adjustmentNotes.trim() || undefined,
        });

        if (!result.success || result.data?.success === false) {
          throw new Error(result.error || result.data?.error || 'Failed to adjust stock');
        }
      }

      toast.success(
        isOnline
          ? t('inventory.adjustmentSaved', 'Stock adjusted successfully')
          : t('common.savedLocallyQueued', 'Saved locally and queued'),
      );
      await fetchInventory();
    } catch (error) {
      console.error('Failed to adjust stock:', error);
      toast.error(t('inventory.errors.adjustmentFailed', 'Failed to adjust stock'));
    }

    setShowAdjustModal(false);
    setSelectedItem(null);
    setAdjustmentQty(0);
    setAdjustmentReason('count');
    setAdjustmentNotes('');
  }, [adjustAction.disabled, adjustAction.message, adjustmentQty, fetchInventory, selectedItem, t]);

  const openAdjustModal = useCallback((item: InventoryItem) => {
    if (adjustAction.disabled) {
      toast.error(adjustAction.message || t('common.requiresOnline', 'This action requires an online connection.'));
      return;
    }

    setSelectedItem(item);
    setShowAdjustModal(true);
  }, [adjustAction.disabled, adjustAction.message, t]);

  const openHistoryModal = useCallback(async (item: InventoryItem) => {
    setHistoryItem(item);
    setHistoryData(null);
    setHistoryError(null);
    setHistoryLoading(true);

    try {
      const endpoint = `pos/inventory/${encodeURIComponent(item.id)}/history`;
      const invoke = getIpcInvoke();
      const result = invoke
        ? await invoke('api:fetch-from-admin', `/api/${endpoint}`)
        : await posApiGet<InventoryHistoryData & { success?: boolean; error?: string }>(endpoint);

      const success = invoke ? result?.success && result?.data?.success !== false : result.success && result.data?.success !== false;
      const data = invoke ? result?.data : result.data;

      if (!success || !data) {
        throw new Error(result?.error || data?.error || data?.details || 'Failed to load inventory history');
      }

      setHistoryData(data as InventoryHistoryData);
    } catch (error) {
      console.error('Failed to load inventory history:', error);
      setHistoryError(formatHistoryLoadError(error, t));
    } finally {
      setHistoryLoading(false);
    }
  }, [t]);

  return (
    <div className={`min-h-screen p-6 ${isDark ? 'text-white' : 'text-gray-900'}`}>
      {/* Header */}
      <div className={`flex items-center justify-between mb-6 rounded-2xl border px-4 py-4 ${isDark ? 'bg-zinc-950 border-zinc-800' : 'bg-white border-gray-200'}`}>
        <div className="flex items-center gap-3">
          <div className={`p-3 rounded-xl ${isDark ? 'bg-zinc-900 border border-zinc-700' : 'bg-gray-100 border border-gray-200'}`}>
            <Package className={`w-8 h-8 ${isDark ? 'text-zinc-200' : 'text-gray-700'}`} />
          </div>
          <div>
            <h1 className="text-2xl font-bold">{t('inventory.title', 'Inventory')}</h1>
            <p className={`text-sm ${isDark ? 'text-zinc-400' : 'text-gray-600'}`}>
              {t('inventory.subtitle', 'Track stock levels and adjustments')}
            </p>
          </div>
        </div>
        <button
          onClick={fetchInventory}
          className={`p-3 rounded-xl transition-all border ${isDark ? 'bg-zinc-900 border-zinc-700 hover:bg-zinc-800' : 'bg-white border-gray-300 hover:bg-gray-100'}`}
        >
          <RefreshCw className={`w-5 h-5 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {error && !loading && (
        <div className={`mb-6 rounded-2xl border px-4 py-4 ${isDark ? 'bg-red-950/30 border-red-900 text-red-100' : 'bg-red-50 border-red-200 text-red-700'}`}>
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-start gap-3">
              <AlertTriangle className="w-5 h-5 mt-0.5" />
              <div>
                <p className="font-semibold">{t('inventory.errors.loadFailedTitle', 'Inventory unavailable')}</p>
                <p className={`text-sm ${isDark ? 'text-red-200/80' : 'text-red-600'}`}>{error}</p>
              </div>
            </div>
            <button
              onClick={fetchInventory}
              className={`shrink-0 rounded-lg px-3 py-2 text-sm font-medium border ${isDark ? 'border-red-700 hover:bg-red-900/40' : 'border-red-300 hover:bg-red-100'}`}
            >
              {t('common.retry', 'Retry')}
            </button>
          </div>
        </div>
      )}

      {!error && (
        <>
      {/* Stats Cards */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-6">
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className={`p-4 rounded-xl border border-t-2 ${isDark ? 'bg-zinc-950 border-zinc-800 border-t-blue-400' : 'bg-white border-gray-200 border-t-blue-500'}`}>
          <div className="flex items-center gap-3">
            <div className={`p-2 rounded-lg ${isDark ? 'bg-blue-500/20' : 'bg-blue-100'}`}><Boxes className={`w-5 h-5 ${isDark ? 'text-blue-300' : 'text-blue-600'}`} /></div>
            <div>
              <p className={`text-sm ${isDark ? 'text-zinc-400' : 'text-gray-600'}`}>{t('inventory.totalItems', 'Total Items')}</p>
              <p className="text-xl font-bold">{stats.total}</p>
            </div>
          </div>
        </motion.div>
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }} className={`p-4 rounded-xl border border-t-2 ${isDark ? 'bg-zinc-950 border-zinc-800 border-t-red-400' : 'bg-white border-gray-200 border-t-red-500'}`}>
          <div className="flex items-center gap-3">
            <div className={`p-2 rounded-lg ${isDark ? 'bg-red-500/20' : 'bg-red-100'}`}><XCircle className={`w-5 h-5 ${isDark ? 'text-red-300' : 'text-red-500'}`} /></div>
            <div>
              <p className={`text-sm ${isDark ? 'text-zinc-400' : 'text-gray-600'}`}>{t('inventory.critical', 'Critical')}</p>
              <p className={`text-xl font-bold ${isDark ? 'text-red-300' : 'text-red-500'}`}>{stats.critical}</p>
            </div>
          </div>
        </motion.div>
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2 }} className={`p-4 rounded-xl border border-t-2 ${isDark ? 'bg-zinc-950 border-zinc-800 border-t-amber-400' : 'bg-white border-gray-200 border-t-amber-500'}`}>
          <div className="flex items-center gap-3">
            <div className={`p-2 rounded-lg ${isDark ? 'bg-amber-500/20' : 'bg-yellow-100'}`}><AlertTriangle className={`w-5 h-5 ${isDark ? 'text-amber-300' : 'text-yellow-500'}`} /></div>
            <div>
              <p className={`text-sm ${isDark ? 'text-zinc-400' : 'text-gray-600'}`}>{t('inventory.lowStock', 'Low Stock')}</p>
              <p className={`text-xl font-bold ${isDark ? 'text-amber-300' : 'text-yellow-500'}`}>{stats.low}</p>
            </div>
          </div>
        </motion.div>
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.3 }} className={`p-4 rounded-xl border border-t-2 ${isDark ? 'bg-zinc-950 border-zinc-800 border-t-emerald-400' : 'bg-white border-gray-200 border-t-emerald-500'}`}>
          <div className="flex items-center gap-3">
            <div className={`p-2 rounded-lg ${isDark ? 'bg-emerald-500/20' : 'bg-green-100'}`}><CheckCircle className={`w-5 h-5 ${isDark ? 'text-emerald-300' : 'text-green-500'}`} /></div>
            <div>
              <p className={`text-sm ${isDark ? 'text-zinc-400' : 'text-gray-600'}`}>{t('inventory.inStock', 'In Stock')}</p>
              <p className={`text-xl font-bold ${isDark ? 'text-emerald-300' : 'text-green-500'}`}>{stats.good}</p>
            </div>
          </div>
        </motion.div>
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.4 }} className={`p-4 rounded-xl border border-t-2 ${isDark ? 'bg-zinc-950 border-zinc-800 border-t-cyan-400' : 'bg-white border-gray-200 border-t-cyan-500'}`}>
          <div className="flex items-center gap-3">
            <div className={`p-2 rounded-lg ${isDark ? 'bg-cyan-500/20' : 'bg-cyan-100'}`}><BarChart3 className={`w-5 h-5 ${isDark ? 'text-cyan-300' : 'text-cyan-600'}`} /></div>
            <div>
              <p className={`text-sm ${isDark ? 'text-zinc-400' : 'text-gray-600'}`}>{t('inventory.totalValue', 'Total Value')}</p>
              <p className="text-lg font-bold">{formatMoney(stats.totalValue)}</p>
            </div>
          </div>
        </motion.div>
      </div>

      {/* Filters */}
      <div className="flex flex-col md:flex-row gap-4 mb-6">
        <div className={`relative flex-1 rounded-xl border ${isDark ? 'bg-zinc-950 border-zinc-800' : 'bg-white border-gray-200'}`}>
          <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
          <input
            type="text"
            placeholder={t('inventory.searchPlaceholder', 'Search ingredients...')}
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className={`w-full pl-12 pr-4 py-3 rounded-xl ${isDark ? 'bg-zinc-950 text-zinc-100' : 'bg-white text-gray-900'} focus:outline-none focus:ring-2 ${isDark ? 'focus:ring-zinc-600' : 'focus:ring-gray-300'}`}
          />
        </div>
        <div className="flex gap-2">
          {(['all', 'critical', 'low', 'good'] as StockStatus[]).map((status) => (
            <button
              key={status}
              onClick={() => setStatusFilter(status)}
              className={`px-4 py-2 rounded-lg font-medium transition-all border ${
                status === 'all'
                  ? statusFilter === status
                    ? isDark
                      ? 'bg-zinc-100 text-black border-zinc-200'
                      : 'bg-black text-white border-black'
                    : isDark
                    ? 'bg-zinc-900 text-zinc-400 border-zinc-700'
                    : 'bg-white text-gray-600 border-gray-300'
                  : status === 'critical'
                  ? statusFilter === status
                    ? 'bg-red-500 text-white border-red-500'
                    : isDark
                    ? 'bg-zinc-900 text-red-300 border-red-500/40 hover:bg-red-500/10'
                    : 'bg-white text-red-600 border-red-300 hover:bg-red-50'
                  : status === 'low'
                  ? statusFilter === status
                    ? 'bg-amber-500 text-black border-amber-500'
                    : isDark
                    ? 'bg-zinc-900 text-amber-300 border-amber-500/40 hover:bg-amber-500/10'
                    : 'bg-white text-amber-600 border-amber-300 hover:bg-amber-50'
                  : statusFilter === status
                  ? 'bg-emerald-500 text-black border-emerald-500'
                  : isDark
                  ? 'bg-zinc-900 text-emerald-300 border-emerald-500/40 hover:bg-emerald-500/10'
                  : 'bg-white text-emerald-600 border-emerald-300 hover:bg-emerald-50'
              }`}
            >
              {t(`inventory.filter.${status}`, status.charAt(0).toUpperCase() + status.slice(1))}
            </button>
          ))}
        </div>
      </div>

      {/* Inventory Table */}
      {loading ? (
        <div className={`rounded-xl border ${isDark ? 'bg-zinc-950 border-zinc-800' : 'bg-white border-gray-200'} p-8`}>
          <div className="animate-pulse space-y-4">
            {[1, 2, 3, 4, 5].map(i => (
              <div key={i} className={`h-12 rounded ${isDark ? 'bg-zinc-800' : 'bg-gray-200'}`} />
            ))}
          </div>
        </div>
      ) : (
        <div className={`rounded-xl overflow-hidden border ${isDark ? 'bg-zinc-950 border-zinc-800' : 'bg-white border-gray-200'}`}>
          <table className="w-full">
            <thead className={isDark ? 'bg-zinc-900' : 'bg-gray-100'}>
              <tr>
                <th className="px-4 py-3 text-left text-sm font-medium">{t('inventory.status', 'Status')}</th>
                <th className="px-4 py-3 text-left text-sm font-medium">{t('inventory.ingredient', 'Ingredient')}</th>
                <th className="px-4 py-3 text-left text-sm font-medium">{t('inventory.category', 'Category')}</th>
                <th className="px-4 py-3 text-right text-sm font-medium">{t('inventory.stock', 'Stock')}</th>
                <th className="px-4 py-3 text-right text-sm font-medium">{t('inventory.minLevel', 'Min Level')}</th>
                <th className="px-4 py-3 text-right text-sm font-medium">{t('inventory.value', 'Value')}</th>
                <th className="px-4 py-3 text-center text-sm font-medium">{t('inventory.tableActions', isGreek ? 'Ενέργειες' : 'Actions')}</th>
              </tr>
            </thead>
            <tbody className={`divide-y ${isDark ? 'divide-zinc-800' : 'divide-gray-200'}`}>
              {filteredInventory.map((item, index) => {
                const status = getStockStatus(item);
                const name = isGreek ? item.name_el : item.name_en;
                return (
                  <motion.tr
                    key={item.id}
                    initial={{ opacity: 0, x: -20 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: index * 0.03 }}
                    onClick={() => void openHistoryModal(item)}
                    className={`${isDark ? 'hover:bg-zinc-900' : 'hover:bg-gray-50'} cursor-pointer transition-colors`}
                    title={t('inventory.history.open', 'View price and movement history')}
                  >
                    <td className="px-4 py-3"><StatusIcon status={status} /></td>
                    <td className="px-4 py-3 font-medium">{name}</td>
                    <td className={`px-4 py-3 ${isDark ? 'text-zinc-400' : 'text-gray-400'}`}>{item.category_name || '-'}</td>
                    <td className="px-4 py-3 text-right">
                      <span className={status === 'critical' ? (isDark ? 'text-zinc-200 font-bold' : 'text-red-500 font-bold') : status === 'low' ? (isDark ? 'text-zinc-300' : 'text-yellow-500') : ''}>
                        {item.stock_quantity} {item.unit_of_measurement}
                      </span>
                    </td>
                    <td className={`px-4 py-3 text-right ${isDark ? 'text-zinc-400' : 'text-gray-400'}`}>{item.min_stock_level}</td>
                    <td className="px-4 py-3 text-right font-medium">{formatMoney(item.stock_quantity * item.cost_per_unit)}</td>
                    <td className="px-4 py-3 text-center">
                      <button
                        onClick={(event) => {
                          event.stopPropagation();
                          openAdjustModal(item);
                        }}
                        disabled={adjustAction.disabled}
                        className={`p-2 rounded-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed ${isDark ? 'hover:bg-zinc-800' : 'hover:bg-gray-200'}`}
                        title={adjustAction.message || t('inventory.adjustStock', 'Adjust Stock')}
                      >
                        <Edit3 className="w-4 h-4" />
                      </button>
                    </td>
                  </motion.tr>
                );
              })}
            </tbody>
          </table>
          {filteredInventory.length === 0 && (
            <div className="text-center py-12 text-gray-400">
              <Package className="w-12 h-12 mx-auto mb-4 opacity-50" />
              <p>{t('inventory.noItems', 'No inventory items found')}</p>
            </div>
          )}
        </div>
      )}
        </>
      )}

      {/* Item History Modal */}
      {historyItem && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onClick={() => setHistoryItem(null)}>
          <motion.div
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            className={`flex max-h-[90vh] w-full max-w-5xl flex-col rounded-2xl border shadow-2xl ${isDark ? 'bg-zinc-950 border-zinc-800 text-white' : 'bg-white border-gray-200 text-gray-950'}`}
            onClick={(e: React.MouseEvent) => e.stopPropagation()}
          >
            <div className="flex shrink-0 items-start justify-between gap-4 border-b border-inherit p-5">
              <div className="min-w-0">
                <div className={`mb-2 inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-semibold ${isDark ? 'bg-blue-500/15 text-blue-200' : 'bg-blue-50 text-blue-700'}`}>
                  <History className="h-3.5 w-3.5" />
                  {t('inventory.history.title', 'Price and movement history')}
                </div>
                <h3 className="truncate text-2xl font-bold">{isGreek ? historyItem.name_el : historyItem.name_en}</h3>
                <p className={`mt-1 truncate text-sm ${isDark ? 'text-zinc-400' : 'text-gray-500'}`}>
                  {historyItem.category_name || t('inventory.noCategory', 'No category')}
                </p>
              </div>
              <button
                onClick={() => setHistoryItem(null)}
                className={`inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border ${isDark ? 'border-zinc-700 bg-zinc-900 hover:bg-zinc-800' : 'border-gray-200 bg-white hover:bg-gray-100'}`}
                aria-label={t('common.close', 'Close')}
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto scrollbar-hide p-5">
              {historyLoading ? (
                <div className="space-y-3">
                  {[1, 2, 3].map((row) => (
                    <div key={row} className={`h-20 animate-pulse rounded-xl ${isDark ? 'bg-zinc-900' : 'bg-gray-100'}`} />
                  ))}
                </div>
              ) : historyError ? (
                <div className={`rounded-xl border p-4 ${isDark ? 'border-red-900 bg-red-950/30 text-red-100' : 'border-red-200 bg-red-50 text-red-700'}`}>
                  {historyError}
                </div>
              ) : historyData ? (
                <div className="space-y-5">
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                    {[
                      { label: t('inventory.history.currentStock', 'Current stock'), value: `${formatQuantity(historyData.item.stock_quantity)} ${historyData.item.unit_of_measurement}` },
                      { label: t('inventory.history.currentCost', 'Current cost'), value: formatMoney(historyData.item.cost_per_unit) },
                      { label: t('inventory.history.purchased', 'Purchased'), value: `${formatQuantity(historyData.summary.purchased_quantity)} ${historyData.item.unit_of_measurement}` },
                      { label: t('inventory.history.used', 'Used / removed'), value: `${formatQuantity(historyData.summary.used_quantity)} ${historyData.item.unit_of_measurement}` },
                    ].map((tile) => (
                      <div key={tile.label} className={`rounded-xl border p-3 ${isDark ? 'border-zinc-800 bg-zinc-900/70' : 'border-gray-200 bg-gray-50'}`}>
                        <p className={`text-xs ${isDark ? 'text-zinc-400' : 'text-gray-500'}`}>{tile.label}</p>
                        <p className="mt-1 truncate text-lg font-bold">{tile.value}</p>
                      </div>
                    ))}
                  </div>

                  <section>
                    <div className="mb-3 flex items-center justify-between gap-3">
                      <div>
                        <h4 className="font-bold">{t('inventory.history.priceHistory', 'Supplier price history')}</h4>
                        <p className={`text-sm ${isDark ? 'text-zinc-400' : 'text-gray-500'}`}>
                          {t('inventory.history.priceHistoryDescription', 'Each supplier invoice purchase is kept here so cost changes are visible.')}
                        </p>
                      </div>
                    </div>

                    {historyData.price_history.length === 0 ? (
                      <div className={`rounded-xl border p-6 text-center ${isDark ? 'border-zinc-800 bg-zinc-900/50 text-zinc-400' : 'border-gray-200 bg-gray-50 text-gray-500'}`}>
                        {t('inventory.history.noPriceHistory', 'No supplier purchase history yet.')}
                      </div>
                    ) : (
                      <div className={`overflow-hidden rounded-xl border ${isDark ? 'border-zinc-800' : 'border-gray-200'}`}>
                        <div className="max-h-72 overflow-y-auto scrollbar-hide">
                          <table className="w-full min-w-[760px]">
                            <thead className={isDark ? 'bg-zinc-900' : 'bg-gray-100'}>
                              <tr>
                                <th className="px-3 py-2 text-left text-xs font-semibold">{t('inventory.history.date', 'Date')}</th>
                                <th className="px-3 py-2 text-left text-xs font-semibold">{t('inventory.history.invoice', 'Invoice')}</th>
                                <th className="px-3 py-2 text-left text-xs font-semibold">{t('inventory.history.supplier', 'Supplier')}</th>
                                <th className="px-3 py-2 text-right text-xs font-semibold">{t('inventory.history.quantity', 'Qty')}</th>
                                <th className="px-3 py-2 text-right text-xs font-semibold">{t('inventory.history.unitCost', 'Unit cost')}</th>
                                <th className="px-3 py-2 text-right text-xs font-semibold">{t('inventory.history.change', 'Change')}</th>
                              </tr>
                            </thead>
                            <tbody className={`divide-y ${isDark ? 'divide-zinc-800' : 'divide-gray-200'}`}>
                              {historyData.price_history.map((entry) => {
                                const isUp = entry.price_change === 'up';
                                const isDown = entry.price_change === 'down';
                                const ChangeIcon = isUp ? TrendingUp : isDown ? TrendingDown : ReceiptText;
                                return (
                                  <tr key={entry.movement_id} className={isDark ? 'bg-zinc-950' : 'bg-white'}>
                                    <td className="px-3 py-3 text-sm">{formatHistoryDate(entry.invoice_date || entry.created_at)}</td>
                                    <td className="px-3 py-3 text-sm font-semibold">{entry.invoice_number || '-'}</td>
                                    <td className={`px-3 py-3 text-sm ${isDark ? 'text-zinc-300' : 'text-gray-700'}`}>{entry.supplier_name || '-'}</td>
                                    <td className="px-3 py-3 text-right text-sm">{formatQuantity(entry.quantity)} {entry.unit || historyData.item.unit_of_measurement}</td>
                                    <td className="px-3 py-3 text-right text-sm font-semibold">{formatMoney(entry.cost_per_unit)}</td>
                                    <td className={`px-3 py-3 text-right text-sm font-semibold ${isUp ? 'text-red-400' : isDown ? 'text-emerald-400' : isDark ? 'text-zinc-400' : 'text-gray-500'}`}>
                                      <span className="inline-flex items-center justify-end gap-1">
                                        <ChangeIcon className="h-4 w-4" />
                                        {entry.price_change === 'initial'
                                          ? t('inventory.history.priceChange.initial', 'Initial')
                                          : entry.price_change === 'same'
                                            ? t('inventory.history.priceChange.same', 'Same')
                                            : `${entry.price_delta > 0 ? '+' : ''}${formatMoney(entry.price_delta)} (${entry.price_delta_percent > 0 ? '+' : ''}${entry.price_delta_percent.toFixed(1)}%)`}
                                      </span>
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    )}
                  </section>

                  <section>
                    <h4 className="mb-3 font-bold">{t('inventory.history.movements', 'Stock movements')}</h4>
                    {historyData.movements.length === 0 ? (
                      <div className={`rounded-xl border p-6 text-center ${isDark ? 'border-zinc-800 bg-zinc-900/50 text-zinc-400' : 'border-gray-200 bg-gray-50 text-gray-500'}`}>
                        {t('inventory.history.noMovements', 'No stock movements recorded yet.')}
                      </div>
                    ) : (
                      <div className="space-y-2">
                        {historyData.movements.map((movement) => (
                          <div key={movement.id} className={`rounded-xl border p-3 ${isDark ? 'border-zinc-800 bg-zinc-900/60' : 'border-gray-200 bg-gray-50'}`}>
                            <div className="flex flex-wrap items-start justify-between gap-3">
                              <div>
                                <p className="font-semibold">{t(`inventory.history.movementTypes.${movement.movement_type}`, movement.movement_type)}</p>
                                <p className={`text-sm ${isDark ? 'text-zinc-400' : 'text-gray-500'}`}>
                                  {formatHistoryDate(movement.created_at)}
                                  {movement.invoice?.invoice_number ? ` · ${t('inventory.history.invoice', 'Invoice')} ${movement.invoice.invoice_number}` : ''}
                                </p>
                              </div>
                              <div className="text-right">
                                <p className="font-bold">{formatQuantity(movement.quantity)} {movement.unit || historyData.item.unit_of_measurement}</p>
                                <p className={`text-sm ${isDark ? 'text-zinc-400' : 'text-gray-500'}`}>{movement.cost_per_unit ? formatMoney(movement.cost_per_unit) : '-'}</p>
                              </div>
                            </div>
                            {movement.reason_notes && (
                              <p className={`mt-2 text-sm ${isDark ? 'text-zinc-400' : 'text-gray-500'}`}>{movement.reason_notes}</p>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </section>
                </div>
              ) : null}
            </div>
          </motion.div>
        </div>
      )}

      {/* Adjust Stock Modal */}
      {showAdjustModal && selectedItem && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setShowAdjustModal(false)}>
          <motion.div
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            className={`p-6 rounded-2xl border ${isDark ? 'bg-zinc-950 border-zinc-800' : 'bg-white border-gray-200'} shadow-2xl w-full max-w-md`}
            onClick={(e: React.MouseEvent) => e.stopPropagation()}
          >
            <h3 className="text-xl font-bold mb-4">{t('inventory.adjustStock', 'Adjust Stock')}</h3>
            <p className="mb-2">{isGreek ? selectedItem.name_el : selectedItem.name_en}</p>
            <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'} mb-4`}>
              {t('inventory.currentStock', 'Current')}: {selectedItem.stock_quantity} {selectedItem.unit_of_measurement}
            </p>
            <div className="mb-4">
              <label className={`text-sm font-medium mb-2 block ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
                {t('inventory.reason', 'Reason')}
              </label>
              <select
                value={adjustmentReason}
                onChange={(e) => setAdjustmentReason(e.target.value as typeof adjustmentReason)}
                disabled={adjustAction.disabled}
                className={`w-full px-3 py-2 rounded-lg border ${isDark ? 'bg-zinc-900 border-zinc-700 text-zinc-100' : 'bg-gray-100 border-gray-300 text-gray-900'}`}
              >
                <option value="count">{t('inventory.reasons.count', 'Stock Count')}</option>
                <option value="received">{t('inventory.reasons.received', 'Received Delivery')}</option>
                <option value="damaged">{t('inventory.reasons.damaged', 'Damaged')}</option>
                <option value="expired">{t('inventory.reasons.expired', 'Expired')}</option>
                <option value="theft">{t('inventory.reasons.theft', 'Theft/Loss')}</option>
                <option value="other">{t('inventory.reasons.other', 'Other')}</option>
              </select>
            </div>
            <div className="flex items-center gap-4 mb-4">
              <button disabled={adjustAction.disabled} onClick={() => setAdjustmentQty(q => q - 1)} className={`p-3 rounded-xl border disabled:opacity-50 disabled:cursor-not-allowed ${isDark ? 'bg-zinc-900 border-zinc-700 text-zinc-200 hover:bg-zinc-800' : 'bg-gray-200 border-gray-300 text-gray-700 hover:bg-gray-300'}`}>
                <Minus className="w-5 h-5" />
              </button>
              <input
                type="number"
                value={adjustmentQty}
                onChange={(e) => setAdjustmentQty(Number(e.target.value))}
                disabled={adjustAction.disabled}
                className={`flex-1 text-center text-2xl font-bold py-3 rounded-xl border ${isDark ? 'bg-zinc-900 border-zinc-700' : 'bg-gray-100 border-gray-300'}`}
              />
              <button disabled={adjustAction.disabled} onClick={() => setAdjustmentQty(q => q + 1)} className={`p-3 rounded-xl border disabled:opacity-50 disabled:cursor-not-allowed ${isDark ? 'bg-zinc-900 border-zinc-700 text-zinc-200 hover:bg-zinc-800' : 'bg-gray-200 border-gray-300 text-gray-700 hover:bg-gray-300'}`}>
                <Plus className="w-5 h-5" />
              </button>
            </div>
            <div className="mb-4">
              <label className={`text-sm font-medium mb-2 block ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
                {t('inventory.notes', 'Notes')} ({t('common.optional', 'Optional')})
              </label>
              <textarea
                value={adjustmentNotes}
                onChange={(e) => setAdjustmentNotes(e.target.value)}
                placeholder={t('inventory.notesPlaceholder', 'Add notes about this adjustment...')}
                rows={2}
                disabled={adjustAction.disabled}
                className={`w-full px-3 py-2 rounded-lg resize-none border ${isDark ? 'bg-zinc-900 border-zinc-700 text-zinc-100 placeholder-zinc-500' : 'bg-gray-100 border-gray-300 text-gray-900 placeholder-gray-400'}`}
              />
            </div>
            <div className="flex gap-3">
              <button onClick={() => { setShowAdjustModal(false); setAdjustmentReason('count'); setAdjustmentNotes(''); }} className={`flex-1 py-3 rounded-xl border ${isDark ? 'bg-zinc-900 border-zinc-700' : 'bg-gray-200 border-gray-300'}`}>
                {t('common.cancel', 'Cancel')}
              </button>
              <button onClick={() => void handleAdjustStock()} disabled={adjustmentQty === 0 || adjustAction.disabled} title={adjustAction.message || undefined} className={`flex-1 py-3 rounded-xl font-medium disabled:opacity-50 disabled:cursor-not-allowed ${
                isDark ? 'bg-zinc-100 text-black hover:bg-white' : 'bg-black text-white hover:bg-zinc-800'
              }`}>
                {t('common.save', 'Save')}
              </button>
            </div>
          </motion.div>
        </div>
      )}
    </div>
  );
};

export default InventoryPage;
