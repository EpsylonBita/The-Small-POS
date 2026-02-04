import React, { useEffect, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { motion } from 'framer-motion';
import {
  Award,
  RefreshCw,
  Search,
  Users,
  TrendingUp,
  Gift,
  Star,
  Phone,
  Mail
} from 'lucide-react';
import { useTheme } from '../contexts/theme-context';
import { useShift } from '../contexts/shift-context';
import { toast } from 'react-hot-toast';
import { formatCurrency } from '../utils/format';
import { posApiGet } from '../utils/api-helpers';

interface LoyaltySettings {
  points_per_euro: number;
  redemption_rate: number;
  min_redemption_points: number;
  is_active: boolean;
}

interface CustomerLoyalty {
  id: string;
  user_profile_id: string;
  points_balance: number;
  total_earned: number;
  total_redeemed: number;
  tier: string;
  customer_name?: string;
  customer_email?: string;
  customer_phone?: string;
}

const LoyaltyPage: React.FC = () => {
  const { t } = useTranslation();
  const { resolvedTheme } = useTheme();
  const { staff } = useShift();
  const [loading, setLoading] = useState(true);
  const [settings, setSettings] = useState<LoyaltySettings | null>(null);
  const [customers, setCustomers] = useState<CustomerLoyalty[]>([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedCustomer, setSelectedCustomer] = useState<CustomerLoyalty | null>(null);

  const isDark = resolvedTheme === 'dark';
  const formatMoney = (amount: number) => formatCurrency(amount);

  const fetchData = useCallback(async () => {
    if (!staff?.organizationId) return;
    setLoading(true);
    try {
      const [settingsRes, customersRes] = await Promise.all([
        posApiGet<{ settings: LoyaltySettings }>(
          `pos/loyalty/settings?organization_id=${staff.organizationId}`
        ),
        posApiGet<{ customers: CustomerLoyalty[] }>(
          `pos/loyalty/customers?organization_id=${staff.organizationId}`
        ),
      ]);

      if (!settingsRes.success || !customersRes.success) {
        throw new Error(settingsRes.error || customersRes.error || 'Failed to load loyalty data');
      }

      setSettings(settingsRes.data?.settings || null);
      setCustomers(customersRes.data?.customers || []);
    } catch (error) {
      console.error('Failed to fetch loyalty data:', error);
      toast.error(t('loyalty.errors.loadFailed', 'Failed to load loyalty data'));
    } finally {
      setLoading(false);
    }
  }, [staff?.organizationId, t]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const getTierColor = (tier: string) => {
    switch (tier?.toLowerCase()) {
      case 'platinum': return 'text-purple-500 bg-purple-500/20 border-purple-500/30';
      case 'gold': return 'text-yellow-500 bg-yellow-500/20 border-yellow-500/30';
      case 'silver': return 'text-gray-400 bg-gray-400/20 border-gray-400/30';
      default: return 'text-amber-700 bg-amber-700/20 border-amber-700/30';
    }
  };

  const getTierIcon = (tier: string) => {
    const stars = tier?.toLowerCase() === 'platinum' ? 4 : tier?.toLowerCase() === 'gold' ? 3 : tier?.toLowerCase() === 'silver' ? 2 : 1;
    return Array(stars).fill(0).map((_, i) => <Star key={i} className="w-3 h-3 fill-current" />);
  };

  const filteredCustomers = customers.filter(c =>
    !searchTerm ||
    c.customer_name?.toLowerCase().includes(searchTerm.toLowerCase()) ||
    c.customer_email?.toLowerCase().includes(searchTerm.toLowerCase()) ||
    c.customer_phone?.includes(searchTerm)
  );

  const stats = {
    totalMembers: customers.length,
    totalPoints: customers.reduce((sum, c) => sum + c.points_balance, 0),
    avgPoints: customers.length > 0 ? Math.round(customers.reduce((sum, c) => sum + c.points_balance, 0) / customers.length) : 0,
  };

  if (loading && customers.length === 0) {
    return (
      <div className="flex items-center justify-center h-full">
        <RefreshCw className="w-8 h-8 animate-spin text-cyan-500" />
      </div>
    );
  }

  if (!settings?.is_active) {
    return (
      <div className={`h-full flex items-center justify-center p-4 ${isDark ? 'bg-gray-900' : 'bg-gray-50'}`}>
        <div className={`p-8 rounded-xl text-center max-w-md ${isDark ? 'bg-gray-800/50' : 'bg-white/80'} border ${isDark ? 'border-gray-700' : 'border-gray-200'}`}>
          <Award className="w-16 h-16 mx-auto mb-4 text-gray-400" />
          <h2 className="text-xl font-bold mb-2">{t('loyalty.programInactive', 'Loyalty Program Inactive')}</h2>
          <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
            {t('loyalty.programInactiveDesc', 'The loyalty program is currently disabled. Enable it from the admin dashboard.')}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className={`h-full overflow-auto p-4 ${isDark ? 'bg-gray-900' : 'bg-gray-50'}`}>
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-xl bg-purple-500/20">
            <Award className="w-6 h-6 text-purple-500" />
          </div>
          <div>
            <h1 className="text-xl font-bold">{t('loyalty.title', 'Loyalty Program')}</h1>
            <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
              {settings?.points_per_euro} {t('loyalty.pointsPerEuro', 'point per €1')} • {formatMoney(settings?.redemption_rate || 0.01)} {t('loyalty.perPoint', 'per point')}
            </p>
          </div>
        </div>
        <button
          onClick={fetchData}
          className={`p-2 rounded-lg ${isDark ? 'bg-gray-800 hover:bg-gray-700' : 'bg-white hover:bg-gray-100'}`}
        >
          <RefreshCw className={`w-5 h-5 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className={`p-4 rounded-xl ${isDark ? 'bg-gray-800/50' : 'bg-white/80'} border ${isDark ? 'border-gray-700' : 'border-gray-200'}`}
        >
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-blue-500/20">
              <Users className="w-5 h-5 text-blue-500" />
            </div>
            <div>
              <p className={`text-xs ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>{t('loyalty.members', 'Members')}</p>
              <p className="text-xl font-bold">{stats.totalMembers}</p>
            </div>
          </div>
        </motion.div>
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
          className={`p-4 rounded-xl ${isDark ? 'bg-gray-800/50' : 'bg-white/80'} border ${isDark ? 'border-gray-700' : 'border-gray-200'}`}
        >
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-purple-500/20">
              <Award className="w-5 h-5 text-purple-500" />
            </div>
            <div>
              <p className={`text-xs ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>{t('loyalty.totalPoints', 'Total Points')}</p>
              <p className="text-xl font-bold">{stats.totalPoints.toLocaleString()}</p>
            </div>
          </div>
        </motion.div>
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2 }}
          className={`p-4 rounded-xl ${isDark ? 'bg-gray-800/50' : 'bg-white/80'} border ${isDark ? 'border-gray-700' : 'border-gray-200'}`}
        >
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-green-500/20">
              <TrendingUp className="w-5 h-5 text-green-500" />
            </div>
            <div>
              <p className={`text-xs ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>{t('loyalty.avgPoints', 'Avg Points')}</p>
              <p className="text-xl font-bold">{stats.avgPoints}</p>
            </div>
          </div>
        </motion.div>
      </div>

      {/* Search */}
      <div className={`flex items-center gap-2 px-3 py-2 rounded-lg mb-4 ${isDark ? 'bg-gray-800' : 'bg-white'} border ${isDark ? 'border-gray-700' : 'border-gray-200'}`}>
        <Search className="w-4 h-4 text-gray-400" />
        <input
          type="text"
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          placeholder={t('loyalty.searchCustomers', 'Search customers...')}
          className="flex-1 bg-transparent outline-none text-sm"
        />
      </div>

      {/* Customers Grid */}
      {filteredCustomers.length === 0 ? (
        <div className={`p-8 rounded-xl text-center ${isDark ? 'bg-gray-800/50' : 'bg-white/80'} border ${isDark ? 'border-gray-700' : 'border-gray-200'}`}>
          <Users className="w-12 h-12 mx-auto mb-4 text-gray-400" />
          <h3 className="text-lg font-semibold mb-2">{t('loyalty.noMembers', 'No Loyalty Members')}</h3>
          <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
            {t('loyalty.noMembersDesc', 'Customers will appear here when they join the loyalty program.')}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filteredCustomers.map((customer, idx) => (
            <motion.div
              key={customer.id}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: idx * 0.05 }}
              onClick={() => setSelectedCustomer(selectedCustomer?.id === customer.id ? null : customer)}
              className={`p-4 rounded-xl cursor-pointer transition-all ${isDark ? 'bg-gray-800/50 hover:bg-gray-800' : 'bg-white/80 hover:bg-white'} border ${isDark ? 'border-gray-700' : 'border-gray-200'} ${selectedCustomer?.id === customer.id ? 'ring-2 ring-purple-500' : ''}`}
            >
              <div className="flex items-start justify-between mb-3">
                <div>
                  <p className="font-semibold">{customer.customer_name || t('loyalty.unknownCustomer', 'Unknown')}</p>
                  {customer.customer_email && (
                    <p className={`text-xs flex items-center gap-1 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                      <Mail className="w-3 h-3" />
                      {customer.customer_email}
                    </p>
                  )}
                </div>
                <span className={`px-2 py-1 text-xs font-medium rounded border flex items-center gap-1 ${getTierColor(customer.tier)}`}>
                  {getTierIcon(customer.tier)}
                  {customer.tier || 'Bronze'}
                </span>
              </div>

              <div className="grid grid-cols-3 gap-2 text-center">
                <div>
                  <p className="text-lg font-bold text-purple-500">{customer.points_balance}</p>
                  <p className={`text-xs ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>{t('loyalty.balance', 'Balance')}</p>
                </div>
                <div>
                  <p className="text-lg font-bold text-green-500">{customer.total_earned}</p>
                  <p className={`text-xs ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>{t('loyalty.earned', 'Earned')}</p>
                </div>
                <div>
                  <p className="text-lg font-bold text-orange-500">{customer.total_redeemed}</p>
                  <p className={`text-xs ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>{t('loyalty.redeemed', 'Redeemed')}</p>
                </div>
              </div>

              {customer.points_balance >= (settings?.min_redemption_points || 100) && (
                <div className={`mt-3 pt-3 border-t ${isDark ? 'border-gray-700' : 'border-gray-200'}`}>
                  <div className="flex items-center justify-between text-sm">
                    <span className="flex items-center gap-1 text-green-500">
                      <Gift className="w-4 h-4" />
                      {t('loyalty.canRedeem', 'Can redeem')}
                    </span>
                    <span className="font-medium">
                      {formatMoney(customer.points_balance * (settings?.redemption_rate || 0.01))}
                    </span>
                  </div>
                </div>
              )}
            </motion.div>
          ))}
        </div>
      )}
    </div>
  );
};

export default LoyaltyPage;

