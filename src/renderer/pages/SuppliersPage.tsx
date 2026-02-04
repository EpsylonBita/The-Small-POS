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
import { useShift } from '../contexts/shift-context';
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

const SuppliersPage: React.FC = () => {
  const { t } = useTranslation();
  const { resolvedTheme } = useTheme();
  const { staff } = useShift();
  const [loading, setLoading] = useState(true);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedSupplier, setSelectedSupplier] = useState<Supplier | null>(null);
  const [activeTab, setActiveTab] = useState<'suppliers' | 'invoices'>('suppliers');

  const isDark = resolvedTheme === 'dark';
  const formatMoney = (amount: number) => formatCurrency(amount);

  const fetchSuppliers = useCallback(async () => {
    if (!staff?.organizationId || !staff?.branchId) return;
    setLoading(true);
    try {
      const result = await posApiGet<{ suppliers?: Supplier[]; invoices?: Invoice[] }>(
        `pos/suppliers?organization_id=${staff.organizationId}&branch_id=${staff.branchId}`
      );
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
  }, [staff?.organizationId, staff?.branchId, t]);

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
    <div className={`min-h-screen p-6 ${isDark ? 'bg-gray-900 text-white' : 'bg-gray-50 text-gray-900'}`}>
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className={`p-3 rounded-xl ${isDark ? 'bg-cyan-500/20' : 'bg-cyan-100'}`}>
            <Truck className="w-8 h-8 text-cyan-500" />
          </div>
          <div>
            <h1 className="text-2xl font-bold">{t('suppliers.title', 'Suppliers')}</h1>
            <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
              {t('suppliers.subtitle', 'Manage suppliers and invoices')}
            </p>
          </div>
        </div>
        <button
          onClick={fetchSuppliers}
          className={`p-3 rounded-xl transition-all ${isDark ? 'bg-gray-800 hover:bg-gray-700' : 'bg-white hover:bg-gray-100'} shadow-lg`}
        >
          <RefreshCw className={`w-5 h-5 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-6">
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className={`p-4 rounded-xl ${isDark ? 'bg-gray-800' : 'bg-white'} shadow-lg`}>
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-blue-500/20"><Building2 className="w-5 h-5 text-blue-500" /></div>
            <div>
              <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>{t('suppliers.total', 'Total')}</p>
              <p className="text-xl font-bold">{stats.totalSuppliers}</p>
            </div>
          </div>
        </motion.div>
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }} className={`p-4 rounded-xl ${isDark ? 'bg-gray-800' : 'bg-white'} shadow-lg`}>
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-green-500/20"><CheckCircle className="w-5 h-5 text-green-500" /></div>
            <div>
              <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>{t('suppliers.active', 'Active')}</p>
              <p className="text-xl font-bold text-green-500">{stats.activeSuppliers}</p>
            </div>
          </div>
        </motion.div>
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2 }} className={`p-4 rounded-xl ${isDark ? 'bg-gray-800' : 'bg-white'} shadow-lg`}>
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-yellow-500/20"><Clock className="w-5 h-5 text-yellow-500" /></div>
            <div>
              <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>{t('suppliers.pending', 'Pending')}</p>
              <p className="text-xl font-bold text-yellow-500">{stats.pendingInvoices}</p>
            </div>
          </div>
        </motion.div>
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.3 }} className={`p-4 rounded-xl ${isDark ? 'bg-gray-800' : 'bg-white'} shadow-lg`}>
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-red-500/20"><AlertCircle className="w-5 h-5 text-red-500" /></div>
            <div>
              <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>{t('suppliers.overdue', 'Overdue')}</p>
              <p className="text-xl font-bold text-red-500">{stats.overdueInvoices}</p>
            </div>
          </div>
        </motion.div>
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.4 }} className={`p-4 rounded-xl ${isDark ? 'bg-gray-800' : 'bg-white'} shadow-lg`}>
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-cyan-500/20"><DollarSign className="w-5 h-5 text-cyan-500" /></div>
            <div>
              <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>{t('suppliers.owed', 'Total Owed')}</p>
              <p className="text-lg font-bold">{formatMoney(stats.totalOwed)}</p>
            </div>
          </div>
        </motion.div>
      </div>

      {/* Tabs */}
      <div className="flex gap-2 mb-6">
        <button onClick={() => setActiveTab('suppliers')} className={`px-4 py-2 rounded-lg font-medium transition-all ${activeTab === 'suppliers' ? 'bg-cyan-500 text-white' : isDark ? 'bg-gray-800 text-gray-400' : 'bg-white text-gray-600'}`}>
          <Building2 className="w-4 h-4 inline mr-2" />{t('suppliers.suppliers', 'Suppliers')}
        </button>
        <button onClick={() => setActiveTab('invoices')} className={`px-4 py-2 rounded-lg font-medium transition-all ${activeTab === 'invoices' ? 'bg-cyan-500 text-white' : isDark ? 'bg-gray-800 text-gray-400' : 'bg-white text-gray-600'}`}>
          <FileText className="w-4 h-4 inline mr-2" />{t('suppliers.invoices', 'Invoices')}
        </button>
      </div>

      {/* Search */}
      <div className={`relative mb-6 ${isDark ? 'bg-gray-800' : 'bg-white'} rounded-xl shadow-lg`}>
        <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
        <input
          type="text"
          placeholder={t('suppliers.search', 'Search suppliers...')}
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          className={`w-full pl-12 pr-4 py-3 rounded-xl ${isDark ? 'bg-gray-800 text-white' : 'bg-white text-gray-900'} focus:outline-none focus:ring-2 focus:ring-cyan-500`}
        />
      </div>

      {/* Content */}
      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {[1, 2, 3].map(i => (
            <div key={i} className={`p-6 rounded-xl ${isDark ? 'bg-gray-800' : 'bg-white'} animate-pulse`}>
              <div className="h-6 bg-gray-600 rounded w-3/4 mb-4" />
              <div className="h-4 bg-gray-600 rounded w-1/2 mb-2" />
              <div className="h-4 bg-gray-600 rounded w-2/3" />
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
              className={`p-6 rounded-xl cursor-pointer transition-all hover:scale-[1.02] ${isDark ? 'bg-gray-800 hover:bg-gray-750' : 'bg-white hover:bg-gray-50'} shadow-lg ${selectedSupplier?.id === supplier.id ? 'ring-2 ring-cyan-500' : ''}`}
            >
              <div className="flex items-start justify-between mb-4">
                <div>
                  <h3 className="font-bold text-lg">{supplier.name}</h3>
                  {supplier.contact_name && <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>{supplier.contact_name}</p>}
                </div>
                <span className={`px-2 py-1 rounded-full text-xs font-medium ${supplier.is_active ? 'bg-green-500/20 text-green-500' : 'bg-gray-500/20 text-gray-500'}`}>
                  {supplier.is_active ? t('suppliers.active', 'Active') : t('suppliers.inactive', 'Inactive')}
                </span>
              </div>
              {supplier.category && <span className={`inline-block px-2 py-1 rounded-lg text-xs ${isDark ? 'bg-gray-700' : 'bg-gray-100'} mb-3`}>{supplier.category}</span>}
              <div className="space-y-2 text-sm">
                {supplier.phone && <div className="flex items-center gap-2"><Phone className="w-4 h-4 text-gray-400" />{supplier.phone}</div>}
                {supplier.email && <div className="flex items-center gap-2"><Mail className="w-4 h-4 text-gray-400" />{supplier.email}</div>}
              </div>
              <div className={`mt-4 pt-4 border-t ${isDark ? 'border-gray-700' : 'border-gray-200'} flex justify-between text-sm`}>
                <span>{t('suppliers.orders', 'Orders')}: <strong>{supplier.total_orders || 0}</strong></span>
                <span>{t('suppliers.spent', 'Spent')}: <strong>{formatMoney(supplier.total_spent || 0)}</strong></span>
              </div>
            </motion.div>
          ))}
        </div>
      ) : (
        <div className={`rounded-xl overflow-hidden ${isDark ? 'bg-gray-800' : 'bg-white'} shadow-lg`}>
          <table className="w-full">
            <thead className={isDark ? 'bg-gray-700' : 'bg-gray-100'}>
              <tr>
                <th className="px-4 py-3 text-left text-sm font-medium">{t('suppliers.invoice', 'Invoice')}</th>
                <th className="px-4 py-3 text-left text-sm font-medium">{t('suppliers.supplier', 'Supplier')}</th>
                <th className="px-4 py-3 text-right text-sm font-medium">{t('suppliers.amount', 'Amount')}</th>
                <th className="px-4 py-3 text-center text-sm font-medium">{t('suppliers.status', 'Status')}</th>
                <th className="px-4 py-3 text-right text-sm font-medium">{t('suppliers.dueDate', 'Due Date')}</th>
              </tr>
            </thead>
            <tbody className={`divide-y ${isDark ? 'divide-gray-700' : 'divide-gray-200'}`}>
              {invoices.map((invoice) => {
                const supplier = suppliers.find(s => s.id === invoice.supplier_id);
                return (
                  <tr key={invoice.id} className={`${isDark ? 'hover:bg-gray-750' : 'hover:bg-gray-50'} transition-colors`}>
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

