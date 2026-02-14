import React, { useEffect, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { motion } from 'framer-motion';
import {
  Truck,
  RefreshCw,
  Search,
  Phone,
  Mail,
  MapPin,
  FileText,
  DollarSign,
  Clock,
  CheckCircle,
  AlertCircle,
  Building2,
  Package
} from 'lucide-react';
import { useTheme } from '../contexts/theme-context';
import { toast } from 'react-hot-toast';
import { formatCurrency, formatDate } from '../utils/format';
import { posApiGet } from '../utils/api-helpers';

interface Supplier {
  id: string;
  name: string;
  contact_name?: string;
  email?: string;
  phone?: string;
  address?: string;
  category?: string;
  payment_terms?: string;
  is_active: boolean;
  total_orders?: number;
  total_spent?: number;
  last_order_date?: string;
}

interface Invoice {
  id: string;
  supplier_id: string;
  invoice_number: string;
  amount: number;
  status: 'pending' | 'paid' | 'overdue';
  due_date: string;
  created_at: string;
}

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

const SuppliersPage: React.FC = () => {
  const { t } = useTranslation();
  const { resolvedTheme } = useTheme();
  const [loading, setLoading] = useState(true);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedSupplier, setSelectedSupplier] = useState<Supplier | null>(null);
  const [activeTab, setActiveTab] = useState<'suppliers' | 'invoices'>('suppliers');

  const isDark = resolvedTheme === 'dark';
  const formatMoney = (amount: number) => formatCurrency(amount);

  const fetchSuppliers = useCallback(async () => {
    setLoading(true);
    try {
      const invoke = getIpcInvoke();
      if (invoke) {
        const syncResult = await invoke('sync:fetch-suppliers');
        if (syncResult?.success) {
          setSuppliers(Array.isArray(syncResult.suppliers) ? syncResult.suppliers : []);
          setInvoices([]);
          return;
        }

        // Fallback to generic sync endpoint if the dedicated POS suppliers route fails.
        const fallbackResult = await invoke('api:fetch-from-admin', '/api/pos/sync/suppliers?limit=1000');
        if (fallbackResult?.success && fallbackResult?.data?.success !== false) {
          setSuppliers(Array.isArray(fallbackResult?.data?.data) ? fallbackResult.data.data : []);
          setInvoices([]);
          return;
        }

        throw new Error(
          syncResult?.error ||
          fallbackResult?.error ||
          fallbackResult?.data?.error ||
          'Failed to load suppliers'
        );
      }

      const result = await posApiGet<{ suppliers?: Supplier[]; invoices?: Invoice[] }>('pos/suppliers');
      if (!result.success) {
        throw new Error(result.error || 'Failed to load suppliers');
      }
      setSuppliers(result.data?.suppliers || []);
      setInvoices(result.data?.invoices || []);
    } catch (error) {
      console.error('Failed to fetch suppliers:', error);
      toast.error(t('suppliers.errors.loadFailed', 'Failed to load suppliers'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    fetchSuppliers();
  }, [fetchSuppliers]);

  const filteredSuppliers = suppliers.filter(s =>
    s.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
    s.contact_name?.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const getInvoiceStatusColor = (status: Invoice['status']) => {
    switch (status) {
      case 'paid': return 'text-green-500 bg-green-500/20';
      case 'pending': return 'text-yellow-500 bg-yellow-500/20';
      case 'overdue': return 'text-red-500 bg-red-500/20';
    }
  };

  const stats = {
    totalSuppliers: suppliers.length,
    activeSuppliers: suppliers.filter(s => s.is_active).length,
    pendingInvoices: invoices.filter(i => i.status === 'pending').length,
    overdueInvoices: invoices.filter(i => i.status === 'overdue').length,
    totalOwed: invoices.filter(i => i.status !== 'paid').reduce((sum, i) => sum + i.amount, 0)
  };

  return (
    <div className={`min-h-screen p-6 ${isDark ? 'bg-black text-white' : 'bg-gray-50 text-gray-900'}`}>
      {/* Header */}
      <div className={`flex items-center justify-between mb-6 rounded-2xl border px-4 py-4 ${isDark ? 'bg-zinc-950 border-zinc-800' : 'bg-white border-gray-200'}`}>
        <div className="flex items-center gap-3">
          <div className={`p-3 rounded-xl ${isDark ? 'bg-zinc-900 border border-zinc-700' : 'bg-gray-100 border border-gray-200'}`}>
            <Truck className={`w-8 h-8 ${isDark ? 'text-zinc-200' : 'text-gray-700'}`} />
          </div>
          <div>
            <h1 className="text-2xl font-bold">{t('suppliers.title', 'Suppliers')}</h1>
            <p className={`text-sm ${isDark ? 'text-zinc-400' : 'text-gray-600'}`}>
              {t('suppliers.subtitle', 'Manage suppliers and invoices')}
            </p>
          </div>
        </div>
        <button
          onClick={fetchSuppliers}
          className={`p-3 rounded-xl transition-all border ${isDark ? 'bg-zinc-900 border-zinc-700 hover:bg-zinc-800' : 'bg-white border-gray-300 hover:bg-gray-100'}`}
        >
          <RefreshCw className={`w-5 h-5 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-6">
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className={`p-4 rounded-xl border border-t-2 ${isDark ? 'bg-zinc-950 border-zinc-800 border-t-blue-400' : 'bg-white border-gray-200 border-t-blue-500'}`}>
          <div className="flex items-center gap-3">
            <div className={`p-2 rounded-lg ${isDark ? 'bg-blue-500/20' : 'bg-blue-100'}`}><Building2 className={`w-5 h-5 ${isDark ? 'text-blue-300' : 'text-blue-600'}`} /></div>
            <div>
              <p className={`text-sm ${isDark ? 'text-zinc-400' : 'text-gray-600'}`}>{t('suppliers.total', 'Total')}</p>
              <p className="text-xl font-bold">{stats.totalSuppliers}</p>
            </div>
          </div>
        </motion.div>
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }} className={`p-4 rounded-xl border border-t-2 ${isDark ? 'bg-zinc-950 border-zinc-800 border-t-emerald-400' : 'bg-white border-gray-200 border-t-emerald-500'}`}>
          <div className="flex items-center gap-3">
            <div className={`p-2 rounded-lg ${isDark ? 'bg-emerald-500/20' : 'bg-emerald-100'}`}><CheckCircle className={`w-5 h-5 ${isDark ? 'text-emerald-300' : 'text-emerald-600'}`} /></div>
            <div>
              <p className={`text-sm ${isDark ? 'text-zinc-400' : 'text-gray-600'}`}>{t('suppliers.active', 'Active')}</p>
              <p className={`text-xl font-bold ${isDark ? 'text-emerald-300' : 'text-emerald-600'}`}>{stats.activeSuppliers}</p>
            </div>
          </div>
        </motion.div>
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2 }} className={`p-4 rounded-xl border border-t-2 ${isDark ? 'bg-zinc-950 border-zinc-800 border-t-amber-400' : 'bg-white border-gray-200 border-t-amber-500'}`}>
          <div className="flex items-center gap-3">
            <div className={`p-2 rounded-lg ${isDark ? 'bg-amber-500/20' : 'bg-amber-100'}`}><Clock className={`w-5 h-5 ${isDark ? 'text-amber-300' : 'text-amber-600'}`} /></div>
            <div>
              <p className={`text-sm ${isDark ? 'text-zinc-400' : 'text-gray-600'}`}>{t('suppliers.pending', 'Pending')}</p>
              <p className={`text-xl font-bold ${isDark ? 'text-amber-300' : 'text-amber-600'}`}>{stats.pendingInvoices}</p>
            </div>
          </div>
        </motion.div>
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.3 }} className={`p-4 rounded-xl border border-t-2 ${isDark ? 'bg-zinc-950 border-zinc-800 border-t-red-400' : 'bg-white border-gray-200 border-t-red-500'}`}>
          <div className="flex items-center gap-3">
            <div className={`p-2 rounded-lg ${isDark ? 'bg-red-500/20' : 'bg-red-100'}`}><AlertCircle className={`w-5 h-5 ${isDark ? 'text-red-300' : 'text-red-600'}`} /></div>
            <div>
              <p className={`text-sm ${isDark ? 'text-zinc-400' : 'text-gray-600'}`}>{t('suppliers.overdue', 'Overdue')}</p>
              <p className={`text-xl font-bold ${isDark ? 'text-red-300' : 'text-red-600'}`}>{stats.overdueInvoices}</p>
            </div>
          </div>
        </motion.div>
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.4 }} className={`p-4 rounded-xl border border-t-2 ${isDark ? 'bg-zinc-950 border-zinc-800 border-t-cyan-400' : 'bg-white border-gray-200 border-t-cyan-500'}`}>
          <div className="flex items-center gap-3">
            <div className={`p-2 rounded-lg ${isDark ? 'bg-cyan-500/20' : 'bg-cyan-100'}`}><DollarSign className={`w-5 h-5 ${isDark ? 'text-cyan-300' : 'text-cyan-600'}`} /></div>
            <div>
              <p className={`text-sm ${isDark ? 'text-zinc-400' : 'text-gray-600'}`}>{t('suppliers.owed', 'Total Owed')}</p>
              <p className="text-lg font-bold">{formatMoney(stats.totalOwed)}</p>
            </div>
          </div>
        </motion.div>
      </div>

      {/* Tabs */}
      <div className="flex gap-2 mb-6">
        <button onClick={() => setActiveTab('suppliers')} className={`px-4 py-2 rounded-lg font-medium transition-all border ${activeTab === 'suppliers' ? (isDark ? 'bg-zinc-100 text-black border-zinc-200' : 'bg-black text-white border-black') : isDark ? 'bg-zinc-900 text-zinc-400 border-zinc-700' : 'bg-white text-gray-600 border-gray-300'}`}>
          <Building2 className="w-4 h-4 inline mr-2" />{t('suppliers.suppliers', 'Suppliers')}
        </button>
        <button onClick={() => setActiveTab('invoices')} className={`px-4 py-2 rounded-lg font-medium transition-all border ${activeTab === 'invoices' ? (isDark ? 'bg-zinc-100 text-black border-zinc-200' : 'bg-black text-white border-black') : isDark ? 'bg-zinc-900 text-zinc-400 border-zinc-700' : 'bg-white text-gray-600 border-gray-300'}`}>
          <FileText className="w-4 h-4 inline mr-2" />{t('suppliers.invoices.title', 'Invoices')}
        </button>
      </div>

      {/* Search */}
      <div className={`relative mb-6 rounded-xl border ${isDark ? 'bg-zinc-950 border-zinc-800' : 'bg-white border-gray-200'}`}>
        <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
        <input
          type="text"
          placeholder={t('suppliers.search', 'Search suppliers...')}
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          className={`w-full pl-12 pr-4 py-3 rounded-xl ${isDark ? 'bg-zinc-950 text-zinc-100' : 'bg-white text-gray-900'} focus:outline-none focus:ring-2 ${isDark ? 'focus:ring-zinc-600' : 'focus:ring-gray-300'}`}
        />
      </div>

      {/* Content */}
      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {[1, 2, 3].map(i => (
            <div key={i} className={`p-6 rounded-xl border animate-pulse ${isDark ? 'bg-zinc-950 border-zinc-800' : 'bg-white border-gray-200'}`}>
              <div className={`h-6 rounded w-3/4 mb-4 ${isDark ? 'bg-zinc-800' : 'bg-gray-200'}`} />
              <div className={`h-4 rounded w-1/2 mb-2 ${isDark ? 'bg-zinc-800' : 'bg-gray-200'}`} />
              <div className={`h-4 rounded w-2/3 ${isDark ? 'bg-zinc-800' : 'bg-gray-200'}`} />
            </div>
          ))}
        </div>
      ) : activeTab === 'suppliers' ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filteredSuppliers.map((supplier, index) => (
            <motion.div
              key={supplier.id}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: index * 0.05 }}
              onClick={() => setSelectedSupplier(supplier)}
              className={`p-6 rounded-xl cursor-pointer transition-all ${isDark ? 'bg-zinc-950 hover:bg-zinc-900 border border-zinc-800' : 'bg-white hover:bg-gray-50 border border-gray-200'} ${selectedSupplier?.id === supplier.id ? (isDark ? 'ring-2 ring-zinc-500' : 'ring-2 ring-gray-400') : ''}`}
            >
              <div className="flex items-start justify-between mb-4">
                <div>
                  <h3 className="font-bold text-lg">{supplier.name}</h3>
                  {supplier.contact_name && <p className={`text-sm ${isDark ? 'text-zinc-400' : 'text-gray-600'}`}>{supplier.contact_name}</p>}
                </div>
                <span className={`px-2 py-1 rounded-full text-xs font-medium border ${supplier.is_active ? (isDark ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30' : 'bg-emerald-100 text-emerald-700 border-emerald-200') : (isDark ? 'bg-zinc-900 text-zinc-400 border-zinc-700' : 'bg-gray-100 text-gray-500 border-gray-300')}`}>
                  {supplier.is_active ? t('suppliers.active', 'Active') : t('suppliers.inactive', 'Inactive')}
                </span>
              </div>
              {supplier.category && <span className={`inline-block px-2 py-1 rounded-lg text-xs ${isDark ? 'bg-zinc-900 border border-zinc-700 text-zinc-300' : 'bg-gray-100 border border-gray-200 text-gray-700'} mb-3`}>{supplier.category}</span>}
              <div className="space-y-2 text-sm">
                {supplier.phone && <div className="flex items-center gap-2"><Phone className="w-4 h-4 text-gray-400" />{supplier.phone}</div>}
                {supplier.email && <div className="flex items-center gap-2"><Mail className="w-4 h-4 text-gray-400" />{supplier.email}</div>}
              </div>
              <div className={`mt-4 pt-4 border-t ${isDark ? 'border-zinc-800' : 'border-gray-200'} flex justify-between text-sm`}>
                <span>{t('suppliers.orders', 'Orders')}: <strong>{supplier.total_orders || 0}</strong></span>
                <span>{t('suppliers.spent', 'Spent')}: <strong>{formatMoney(supplier.total_spent || 0)}</strong></span>
              </div>
            </motion.div>
          ))}
        </div>
      ) : (
        <div className={`rounded-xl overflow-hidden border ${isDark ? 'bg-zinc-950 border-zinc-800' : 'bg-white border-gray-200'}`}>
          <table className="w-full">
            <thead className={isDark ? 'bg-zinc-900' : 'bg-gray-100'}>
              <tr>
                <th className="px-4 py-3 text-left text-sm font-medium">{t('suppliers.invoice', 'Invoice')}</th>
                <th className="px-4 py-3 text-left text-sm font-medium">{t('suppliers.supplier', 'Supplier')}</th>
                <th className="px-4 py-3 text-right text-sm font-medium">{t('suppliers.amount', 'Amount')}</th>
                <th className="px-4 py-3 text-center text-sm font-medium">{t('suppliers.status', 'Status')}</th>
                <th className="px-4 py-3 text-right text-sm font-medium">{t('suppliers.dueDate', 'Due Date')}</th>
              </tr>
            </thead>
            <tbody className={`divide-y ${isDark ? 'divide-zinc-800' : 'divide-gray-200'}`}>
              {invoices.map((invoice) => {
                const supplier = suppliers.find(s => s.id === invoice.supplier_id);
                return (
                  <tr key={invoice.id} className={`${isDark ? 'hover:bg-zinc-900' : 'hover:bg-gray-50'} transition-colors`}>
                    <td className="px-4 py-3 font-medium">{invoice.invoice_number}</td>
                    <td className="px-4 py-3">{supplier?.name || '-'}</td>
                    <td className="px-4 py-3 text-right font-medium">{formatMoney(invoice.amount)}</td>
                    <td className="px-4 py-3 text-center">
                      <span className={`px-2 py-1 rounded-full text-xs font-medium ${getInvoiceStatusColor(invoice.status)}`}>
                        {t(`suppliers.status.${invoice.status}`, invoice.status)}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">{formatDate(invoice.due_date)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

export default SuppliersPage;

