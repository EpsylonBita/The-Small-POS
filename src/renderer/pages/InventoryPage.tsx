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
  Edit3
} from 'lucide-react';
import { useTheme } from '../contexts/theme-context';
import { toast } from 'react-hot-toast';
import { formatCurrency } from '../utils/format';
import { posApiGet, posApiPatch } from '../utils/api-helpers';

interface InventoryItem {
  id: string;
  name_en: string;
  name_el: string;
  category_name?: string;
  stock_quantity: number;
  min_stock_level: number;
  cost_per_unit: number;
  unit_of_measurement: string;
  is_active: boolean;
}

type StockStatus = 'all' | 'critical' | 'low' | 'good';
type IpcInvoke = (channel: string, ...args: any[]) => Promise<any>;

function getIpcInvoke(): IpcInvoke | null {
  if (typeof window === 'undefined') return null;
  const w = window as any;
  if (typeof w?.electronAPI?.invoke === 'function') {
    return w.electronAPI.invoke.bind(w.electronAPI);
  }
  if (typeof w?.electronAPI?.ipcRenderer?.invoke === 'function') {
    return w.electronAPI.ipcRenderer.invoke.bind(w.electronAPI.ipcRenderer);
  }
  if (typeof w?.electron?.ipcRenderer?.invoke === 'function') {
    return w.electron.ipcRenderer.invoke.bind(w.electron.ipcRenderer);
  }
  return null;
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
    : (typeof item?.name === 'string' && item.name.trim() ? item.name : 'Unnamed item');

  const nameEl = typeof item?.name_el === 'string' && item.name_el.trim()
    ? item.name_el
    : nameEn;

  return {
    id: String(item?.id || ''),
    name_en: nameEn,
    name_el: nameEl,
    category_name: typeof item?.category_name === 'string' ? item.category_name : undefined,
    stock_quantity: asNumber(item?.stock_quantity, 0),
    min_stock_level: asNumber(item?.min_stock_level, 0),
    cost_per_unit: asNumber(item?.cost_per_unit, 0),
    unit_of_measurement: typeof item?.unit_of_measurement === 'string' && item.unit_of_measurement.trim()
      ? item.unit_of_measurement
      : 'pcs',
    is_active: item?.is_active !== false,
  };
}

const InventoryPage: React.FC = () => {
  const { t, i18n } = useTranslation();
  const { resolvedTheme } = useTheme();
  const [loading, setLoading] = useState(true);
  const [inventory, setInventory] = useState<InventoryItem[]>([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState<StockStatus>('all');
  const [selectedItem, setSelectedItem] = useState<InventoryItem | null>(null);
  const [showAdjustModal, setShowAdjustModal] = useState(false);
  const [adjustmentQty, setAdjustmentQty] = useState(0);
  const [adjustmentReason, setAdjustmentReason] = useState<'count' | 'received' | 'damaged' | 'expired' | 'theft' | 'other'>('count');
  const [adjustmentNotes, setAdjustmentNotes] = useState('');

  const isDark = resolvedTheme === 'dark';
  const isGreek = i18n.language === 'el';
  const formatMoney = (amount: number) => formatCurrency(amount);

  const fetchInventory = useCallback(async () => {
    setLoading(true);
    try {
      const invoke = getIpcInvoke();
      if (invoke) {
        const result = await invoke('api:fetch-from-admin', '/api/pos/sync/inventory_items?limit=2000');
        if (result?.success && result?.data?.success !== false) {
          const rows = Array.isArray(result?.data?.data) ? result.data.data : [];
          const normalized: InventoryItem[] = rows.map(normalizeInventoryItem);
          setInventory(normalized.filter((item: InventoryItem) => item.is_active));
          return;
        }
        throw new Error(result?.error || result?.data?.error || 'Failed to fetch inventory');
      }

      const result = await posApiGet<any>('pos/sync/inventory_items?limit=2000');
      if (!result.success || result.data?.success === false) {
        throw new Error(result.error || result.data?.error || 'Failed to fetch inventory');
      }
      const rows = Array.isArray(result.data?.data) ? result.data.data : [];
      const normalized: InventoryItem[] = rows.map(normalizeInventoryItem);
      setInventory(normalized.filter((item: InventoryItem) => item.is_active));
    } catch (error) {
      console.error('Failed to fetch inventory:', error);
      toast.error(t('inventory.errors.loadFailed', 'Failed to load inventory'));
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
    if (status === 'critical') return <XCircle className="w-5 h-5 text-red-500" />;
    if (status === 'low') return <AlertTriangle className="w-5 h-5 text-yellow-500" />;
    return <CheckCircle className="w-5 h-5 text-green-500" />;
  };

  const handleAdjustStock = async () => {
    if (!selectedItem || adjustmentQty === 0) return;

    const nextQuantity = selectedItem.stock_quantity + adjustmentQty;
    if (nextQuantity < 0) {
      toast.error(t('inventory.errors.adjustmentNegative', 'Adjustment would result in negative stock'));
      return;
    }

    try {
      const invoke = getIpcInvoke();
      if (invoke) {
        const result = await invoke(
          'api:fetch-from-admin',
          `/api/pos/sync/inventory_items/${selectedItem.id}`,
          {
            method: 'PATCH',
            body: {
              stock_quantity: nextQuantity,
            },
          }
        );

        if (!result?.success || result?.data?.success === false) {
          throw new Error(result?.error || result?.data?.error || 'Failed to adjust stock');
        }
      } else {
        const result = await posApiPatch<any>(`pos/sync/inventory_items/${selectedItem.id}`, {
          stock_quantity: nextQuantity,
        });

        if (!result.success || result.data?.success === false) {
          throw new Error(result.error || result.data?.error || 'Failed to adjust stock');
        }
      }

      toast.success(t('inventory.adjustmentSaved', 'Stock adjusted successfully'));
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
  };

  return (
    <div className={`min-h-screen p-6 ${isDark ? 'bg-gray-900 text-white' : 'bg-gray-50 text-gray-900'}`}>
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className={`p-3 rounded-xl ${isDark ? 'bg-blue-500/20' : 'bg-blue-100'}`}>
            <Package className="w-8 h-8 text-blue-500" />
          </div>
          <div>
            <h1 className="text-2xl font-bold">{t('inventory.title', 'Inventory')}</h1>
            <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
              {t('inventory.subtitle', 'Track stock levels and adjustments')}
            </p>
          </div>
        </div>
        <button
          onClick={fetchInventory}
          className={`p-3 rounded-xl transition-all ${isDark ? 'bg-gray-800 hover:bg-gray-700' : 'bg-white hover:bg-gray-100'} shadow-lg`}
        >
          <RefreshCw className={`w-5 h-5 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-6">
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className={`p-4 rounded-xl ${isDark ? 'bg-gray-800' : 'bg-white'} shadow-lg`}>
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-blue-500/20"><Boxes className="w-5 h-5 text-blue-500" /></div>
            <div>
              <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>{t('inventory.totalItems', 'Total Items')}</p>
              <p className="text-xl font-bold">{stats.total}</p>
            </div>
          </div>
        </motion.div>
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }} className={`p-4 rounded-xl ${isDark ? 'bg-gray-800' : 'bg-white'} shadow-lg`}>
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-red-500/20"><XCircle className="w-5 h-5 text-red-500" /></div>
            <div>
              <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>{t('inventory.critical', 'Critical')}</p>
              <p className="text-xl font-bold text-red-500">{stats.critical}</p>
            </div>
          </div>
        </motion.div>
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2 }} className={`p-4 rounded-xl ${isDark ? 'bg-gray-800' : 'bg-white'} shadow-lg`}>
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-yellow-500/20"><AlertTriangle className="w-5 h-5 text-yellow-500" /></div>
            <div>
              <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>{t('inventory.lowStock', 'Low Stock')}</p>
              <p className="text-xl font-bold text-yellow-500">{stats.low}</p>
            </div>
          </div>
        </motion.div>
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.3 }} className={`p-4 rounded-xl ${isDark ? 'bg-gray-800' : 'bg-white'} shadow-lg`}>
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-green-500/20"><CheckCircle className="w-5 h-5 text-green-500" /></div>
            <div>
              <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>{t('inventory.inStock', 'In Stock')}</p>
              <p className="text-xl font-bold text-green-500">{stats.good}</p>
            </div>
          </div>
        </motion.div>
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.4 }} className={`p-4 rounded-xl ${isDark ? 'bg-gray-800' : 'bg-white'} shadow-lg`}>
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-cyan-500/20"><BarChart3 className="w-5 h-5 text-cyan-500" /></div>
            <div>
              <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>{t('inventory.totalValue', 'Total Value')}</p>
              <p className="text-lg font-bold">{formatMoney(stats.totalValue)}</p>
            </div>
          </div>
        </motion.div>
      </div>

      {/* Filters */}
      <div className="flex flex-col md:flex-row gap-4 mb-6">
        <div className={`relative flex-1 ${isDark ? 'bg-gray-800' : 'bg-white'} rounded-xl shadow-lg`}>
          <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
          <input
            type="text"
            placeholder={t('inventory.searchPlaceholder', 'Search ingredients...')}
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className={`w-full pl-12 pr-4 py-3 rounded-xl ${isDark ? 'bg-gray-800 text-white' : 'bg-white text-gray-900'} focus:outline-none focus:ring-2 focus:ring-cyan-500`}
          />
        </div>
        <div className="flex gap-2">
          {(['all', 'critical', 'low', 'good'] as StockStatus[]).map((status) => (
            <button
              key={status}
              onClick={() => setStatusFilter(status)}
              className={`px-4 py-2 rounded-lg font-medium transition-all ${statusFilter === status ? 'bg-cyan-500 text-white' : isDark ? 'bg-gray-800 text-gray-400' : 'bg-white text-gray-600'} shadow-lg`}
            >
              {t(`inventory.filter.${status}`, status.charAt(0).toUpperCase() + status.slice(1))}
            </button>
          ))}
        </div>
      </div>

      {/* Inventory Table */}
      {loading ? (
        <div className={`rounded-xl ${isDark ? 'bg-gray-800' : 'bg-white'} shadow-lg p-8`}>
          <div className="animate-pulse space-y-4">
            {[1, 2, 3, 4, 5].map(i => (
              <div key={i} className="h-12 bg-gray-600 rounded" />
            ))}
          </div>
        </div>
      ) : (
        <div className={`rounded-xl overflow-hidden ${isDark ? 'bg-gray-800' : 'bg-white'} shadow-lg`}>
          <table className="w-full">
            <thead className={isDark ? 'bg-gray-700' : 'bg-gray-100'}>
              <tr>
                <th className="px-4 py-3 text-left text-sm font-medium">{t('inventory.status', 'Status')}</th>
                <th className="px-4 py-3 text-left text-sm font-medium">{t('inventory.ingredient', 'Ingredient')}</th>
                <th className="px-4 py-3 text-left text-sm font-medium">{t('inventory.category', 'Category')}</th>
                <th className="px-4 py-3 text-right text-sm font-medium">{t('inventory.stock', 'Stock')}</th>
                <th className="px-4 py-3 text-right text-sm font-medium">{t('inventory.minLevel', 'Min Level')}</th>
                <th className="px-4 py-3 text-right text-sm font-medium">{t('inventory.value', 'Value')}</th>
                <th className="px-4 py-3 text-center text-sm font-medium">{t('inventory.actions', 'Actions')}</th>
              </tr>
            </thead>
            <tbody className={`divide-y ${isDark ? 'divide-gray-700' : 'divide-gray-200'}`}>
              {filteredInventory.map((item, index) => {
                const status = getStockStatus(item);
                const name = isGreek ? item.name_el : item.name_en;
                return (
                  <motion.tr
                    key={item.id}
                    initial={{ opacity: 0, x: -20 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: index * 0.03 }}
                    className={`${isDark ? 'hover:bg-gray-750' : 'hover:bg-gray-50'} transition-colors`}
                  >
                    <td className="px-4 py-3"><StatusIcon status={status} /></td>
                    <td className="px-4 py-3 font-medium">{name}</td>
                    <td className="px-4 py-3 text-gray-400">{item.category_name || '-'}</td>
                    <td className="px-4 py-3 text-right">
                      <span className={status === 'critical' ? 'text-red-500 font-bold' : status === 'low' ? 'text-yellow-500' : ''}>
                        {item.stock_quantity} {item.unit_of_measurement}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right text-gray-400">{item.min_stock_level}</td>
                    <td className="px-4 py-3 text-right font-medium">{formatMoney(item.stock_quantity * item.cost_per_unit)}</td>
                    <td className="px-4 py-3 text-center">
                      <button
                        onClick={() => { setSelectedItem(item); setShowAdjustModal(true); }}
                        className={`p-2 rounded-lg transition-all ${isDark ? 'hover:bg-gray-700' : 'hover:bg-gray-200'}`}
                        title={t('inventory.adjustStock', 'Adjust Stock')}
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

      {/* Adjust Stock Modal */}
      {showAdjustModal && selectedItem && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setShowAdjustModal(false)}>
          <motion.div
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            className={`p-6 rounded-2xl ${isDark ? 'bg-gray-800' : 'bg-white'} shadow-2xl w-full max-w-md`}
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
                className={`w-full px-3 py-2 rounded-lg ${isDark ? 'bg-gray-700 text-white' : 'bg-gray-100 text-gray-900'}`}
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
              <button onClick={() => setAdjustmentQty(q => q - 1)} className="p-3 rounded-xl bg-red-500/20 text-red-500 hover:bg-red-500/30">
                <Minus className="w-5 h-5" />
              </button>
              <input
                type="number"
                value={adjustmentQty}
                onChange={(e) => setAdjustmentQty(Number(e.target.value))}
                className={`flex-1 text-center text-2xl font-bold py-3 rounded-xl ${isDark ? 'bg-gray-700' : 'bg-gray-100'}`}
              />
              <button onClick={() => setAdjustmentQty(q => q + 1)} className="p-3 rounded-xl bg-green-500/20 text-green-500 hover:bg-green-500/30">
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
                className={`w-full px-3 py-2 rounded-lg resize-none ${isDark ? 'bg-gray-700 text-white placeholder-gray-500' : 'bg-gray-100 text-gray-900 placeholder-gray-400'}`}
              />
            </div>
            <div className="flex gap-3">
              <button onClick={() => { setShowAdjustModal(false); setAdjustmentReason('count'); setAdjustmentNotes(''); }} className={`flex-1 py-3 rounded-xl ${isDark ? 'bg-gray-700' : 'bg-gray-200'}`}>
                {t('common.cancel', 'Cancel')}
              </button>
              <button onClick={handleAdjustStock} disabled={adjustmentQty === 0} className="flex-1 py-3 rounded-xl bg-cyan-500 text-white font-medium disabled:opacity-50 disabled:cursor-not-allowed">
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
