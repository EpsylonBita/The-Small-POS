import React, { memo, useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../../../contexts/theme-context';
import { CreditCard, User, Calendar, Plus, Search, FileText, RefreshCw, AlertCircle, X } from 'lucide-react';
import { posApiGet } from '../../../utils/api-helpers';
import { useTerminalSettings } from '../../../hooks/useTerminalSettings';
import { formatCurrency } from '../../../utils/format';

interface GuestFolio {
  id: string;
  guestName: string;
  guestEmail?: string | null;
  guestPhone?: string | null;
  roomNumber: string;
  roomId: string;
  checkIn: string;
  checkOut: string | null;
  status: 'open' | 'settled' | 'pending_checkout';
  totalCharges: number;
  totalPayments: number;
  balance: number;
  notes?: string | null;
  branchId: string;
  organizationId: string;
}

interface ApiFoliosResponse {
  success: boolean;
  folios: GuestFolio[];
  error?: string;
}

export const GuestBillingView: React.FC = memo(() => {
  const { t } = useTranslation();
  const { resolvedTheme } = useTheme();
  const { getSetting } = useTerminalSettings();
  const [folios, setFolios] = useState<GuestFolio[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedFolio, setSelectedFolio] = useState<GuestFolio | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'open' | 'settled' | 'pending_checkout'>('all');

  const fetchFolios = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      // Get branch_id from terminal settings
      const branchId = getSetting<string>('terminal', 'branch_id', '');
      const params = new URLSearchParams();
      if (branchId) params.append('branch_id', branchId);

      const response = await posApiGet<ApiFoliosResponse>(
        `/pos/guest-billing?${params.toString()}`
      );

      if (response.success && response.data?.folios) {
        setFolios(response.data.folios);
      } else {
        setError(response.error || response.data?.error || 'Failed to fetch guest folios');
      }
    } catch (err: any) {
      console.error('[GuestBillingView] Fetch error:', err);
      setError(err.message || 'Failed to fetch guest folios');
    } finally {
      setLoading(false);
    }
  }, [getSetting]);

  useEffect(() => {
    fetchFolios();
  }, [fetchFolios]);

  const isDark = resolvedTheme === 'dark';
  const formatMoney = (amount: number) => formatCurrency(amount);

  const filteredFolios = folios.filter(f => {
    const matchesSearch = f.guestName.toLowerCase().includes(searchTerm.toLowerCase()) ||
                          f.roomNumber.includes(searchTerm);
    const matchesStatus = statusFilter === 'all' || f.status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  const statusConfig = {
    open: { color: 'blue', label: t('guestBilling.status.open', { defaultValue: 'Open' }) },
    settled: { color: 'green', label: t('guestBilling.status.settled', { defaultValue: 'Settled' }) },
    pending_checkout: { color: 'yellow', label: t('guestBilling.status.pendingCheckout', { defaultValue: 'Pending Checkout' }) },
  };

  const stats = {
    totalOpen: folios.filter(f => f.status === 'open').length,
    totalBalance: folios.reduce((sum, f) => sum + (f.balance || 0), 0),
    pendingCheckouts: folios.filter(f => f.status === 'pending_checkout').length,
  };

  // Loading state
  if (loading) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-center">
          <RefreshCw className={`w-8 h-8 animate-spin mx-auto mb-2 ${isDark ? 'text-gray-400' : 'text-gray-500'}`} />
          <p className={isDark ? 'text-gray-400' : 'text-gray-500'}>
            {t('common.loading', { defaultValue: 'Loading...' })}
          </p>
        </div>
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className={`text-center p-6 rounded-xl ${isDark ? 'bg-gray-800' : 'bg-white shadow-lg'}`}>
          <AlertCircle className="w-12 h-12 text-red-500 mx-auto mb-3" />
          <p className={`font-medium mb-2 ${isDark ? 'text-white' : 'text-gray-900'}`}>
            {t('guestBilling.error.title', { defaultValue: 'Failed to load guest folios' })}
          </p>
          <p className={`text-sm mb-4 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>{error}</p>
          <button
            onClick={fetchFolios}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
          >
            {t('common.retry', { defaultValue: 'Retry' })}
          </button>
        </div>
      </div>
    );
  }

  // Empty state
  if (folios.length === 0) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-center">
          <User className={`w-12 h-12 mx-auto mb-3 ${isDark ? 'text-gray-600' : 'text-gray-300'}`} />
          <p className={`font-medium mb-2 ${isDark ? 'text-white' : 'text-gray-900'}`}>
            {t('guestBilling.empty.title', { defaultValue: 'No guest folios' })}
          </p>
          <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
            {t('guestBilling.empty.description', { defaultValue: 'Guest folios will appear here when created.' })}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex gap-4 p-4">
      {/* Left Panel - Folio List */}
      <div className="flex-1 flex flex-col">
        {/* Stats */}
        <div className="flex gap-4 mb-4">
          <div className={`px-4 py-2 rounded-xl ${isDark ? 'bg-gray-800' : 'bg-white shadow-sm'}`}>
            <div className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
              {t('guestBilling.stats.openFolios', { defaultValue: 'Open Folios' })}
            </div>
            <div className={`text-xl font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>{stats.totalOpen}</div>
          </div>
          <div className={`px-4 py-2 rounded-xl ${isDark ? 'bg-gray-800' : 'bg-white shadow-sm'}`}>
            <div className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
              {t('guestBilling.stats.totalBalance', { defaultValue: 'Total Balance' })}
            </div>
            <div className={`text-xl font-bold text-blue-500`}>{formatMoney(stats.totalBalance)}</div>
          </div>
          <div className={`px-4 py-2 rounded-xl ${isDark ? 'bg-gray-800' : 'bg-white shadow-sm'}`}>
            <div className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
              {t('guestBilling.stats.pendingCheckouts', { defaultValue: 'Pending Checkouts' })}
            </div>
            <div className={`text-xl font-bold text-yellow-500`}>{stats.pendingCheckouts}</div>
          </div>
        </div>

        {/* Search & Filters */}
        <div className="flex gap-2 mb-4">
          <div className="relative flex-1">
            <Search className={`absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 ${isDark ? 'text-gray-500' : 'text-gray-400'}`} />
            <input
              type="text"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder={t('guestBilling.searchPlaceholder', { defaultValue: 'Search guest or room...' })}
              className={`w-full pl-10 pr-4 py-2 rounded-lg ${isDark ? 'bg-gray-800 text-white border-gray-700' : 'bg-white text-gray-900 border-gray-200'} border`}
            />
          </div>
          {(['all', 'open', 'pending_checkout', 'settled'] as const).map(status => (
            <button
              key={status}
              onClick={() => setStatusFilter(status)}
              className={`px-3 py-2 rounded-lg text-sm ${
                statusFilter === status
                  ? 'bg-blue-600 text-white'
                  : isDark ? 'bg-gray-800 text-gray-300' : 'bg-gray-100 text-gray-600'
              }`}
            >
              {status === 'all' ? t('common.all', { defaultValue: 'All' }) : statusConfig[status].label}
            </button>
          ))}
        </div>

        {/* Folio List */}
        <div className="flex-1 overflow-y-auto space-y-2">
          {filteredFolios.map(folio => (
            <button
              key={folio.id}
              onClick={() => setSelectedFolio(folio)}
              className={`w-full p-4 rounded-xl text-left transition-all ${
                selectedFolio?.id === folio.id ? 'ring-2 ring-blue-500' : ''
              } ${isDark ? 'bg-gray-800 hover:bg-gray-750' : 'bg-white shadow-sm hover:shadow-md'}`}
            >
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <User className={`w-4 h-4 ${isDark ? 'text-gray-400' : 'text-gray-500'}`} />
                  <span className={`font-medium ${isDark ? 'text-white' : 'text-gray-900'}`}>{folio.guestName}</span>
                </div>
                <span className={`px-2 py-1 rounded text-xs bg-${statusConfig[folio.status].color}-500/10 text-${statusConfig[folio.status].color}-500`}>
                  {statusConfig[folio.status].label}
                </span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className={isDark ? 'text-gray-400' : 'text-gray-500'}>
                  {t('guestBilling.room', { defaultValue: 'Room' })} {folio.roomNumber}
                </span>
                <span className={`font-bold ${folio.balance > 0 ? 'text-blue-500' : 'text-green-500'}`}>
                  {formatMoney(folio.balance)}
                </span>
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Right Panel - Folio Details */}
      {selectedFolio && (
        <div className={`w-96 rounded-2xl p-4 flex flex-col ${isDark ? 'bg-gray-800' : 'bg-white shadow-lg'}`}>
          <div className="flex items-center justify-between mb-4">
            <h3 className={`text-lg font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>
              {t('guestBilling.folioDetails', { defaultValue: 'Folio Details' })}
            </h3>
            <button
              onClick={() => setSelectedFolio(null)}
              className={`text-sm ${isDark ? 'text-gray-400 hover:text-white' : 'text-gray-500 hover:text-gray-700'}`}
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Guest Info */}
          <div className={`p-3 rounded-lg mb-4 ${isDark ? 'bg-gray-700' : 'bg-gray-50'}`}>
            <div className={`font-medium ${isDark ? 'text-white' : 'text-gray-900'}`}>{selectedFolio.guestName}</div>
            <div className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
              {t('guestBilling.room', { defaultValue: 'Room' })} {selectedFolio.roomNumber}
            </div>
            {selectedFolio.guestEmail && (
              <div className={`text-xs mt-1 ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
                {selectedFolio.guestEmail}
              </div>
            )}
            {selectedFolio.guestPhone && (
              <div className={`text-xs ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
                {selectedFolio.guestPhone}
              </div>
            )}
            <div className="flex items-center gap-4 mt-2 text-xs">
              <span className={`flex items-center gap-1 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                <Calendar className="w-3 h-3" />
                {selectedFolio.checkIn} - {selectedFolio.checkOut || t('guestBilling.ongoing', { defaultValue: 'Ongoing' })}
              </span>
            </div>
          </div>

          {/* Totals Summary */}
          <div className="flex-1 overflow-y-auto">
            <div className="space-y-3 mb-4">
              <div className="flex items-center justify-between">
                <span className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                  {t('guestBilling.totalCharges', { defaultValue: 'Total Charges' })}
                </span>
                <span className={isDark ? 'text-white' : 'text-gray-900'}>
                  {formatMoney(selectedFolio.totalCharges)}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                  {t('guestBilling.totalPayments', { defaultValue: 'Total Payments' })}
                </span>
                <span className="text-green-500">
                  -{formatMoney(selectedFolio.totalPayments)}
                </span>
              </div>
            </div>
            {selectedFolio.notes && (
              <div className={`p-2 rounded-lg text-sm ${isDark ? 'bg-gray-700/50' : 'bg-gray-100'}`}>
                <div className={`text-xs font-medium mb-1 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                  {t('guestBilling.notes', { defaultValue: 'Notes' })}
                </div>
                <div className={isDark ? 'text-gray-300' : 'text-gray-600'}>{selectedFolio.notes}</div>
              </div>
            )}
          </div>

          {/* Balance & Actions */}
          <div className={`pt-4 border-t ${isDark ? 'border-gray-700' : 'border-gray-200'}`}>
            <div className="flex items-center justify-between mb-4">
              <span className={`font-medium ${isDark ? 'text-white' : 'text-gray-900'}`}>
                {t('guestBilling.balance', { defaultValue: 'Balance' })}
              </span>
              <span className="text-xl font-bold text-blue-500">{formatMoney(selectedFolio.balance)}</span>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <button className="flex items-center justify-center gap-2 py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700">
                <Plus className="w-4 h-4" />
                {t('guestBilling.addCharge', { defaultValue: 'Add Charge' })}
              </button>
              <button className="flex items-center justify-center gap-2 py-2 rounded-lg bg-green-600 text-white hover:bg-green-700">
                <CreditCard className="w-4 h-4" />
                {t('guestBilling.payment', { defaultValue: 'Payment' })}
              </button>
            </div>
            <button className={`w-full mt-2 py-2 rounded-lg flex items-center justify-center gap-2 ${
              isDark ? 'bg-gray-700 text-white hover:bg-gray-600' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
            }`}>
              <FileText className="w-4 h-4" />
              {t('guestBilling.printFolio', { defaultValue: 'Print Folio' })}
            </button>
          </div>
        </div>
      )}
    </div>
  );
});

GuestBillingView.displayName = 'GuestBillingView';
export default GuestBillingView;
