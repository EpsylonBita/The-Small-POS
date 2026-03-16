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
  Mail
} from 'lucide-react';
import { useTheme } from '../contexts/theme-context';
import { toast } from 'react-hot-toast';
import { formatCurrency } from '../utils/format';
import { getBridge } from '../../lib';

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
  const bridge = getBridge();
  const [loading, setLoading] = useState(true);
  const [settings, setSettings] = useState<LoyaltySettings | null>(null);
  const [customers, setCustomers] = useState<CustomerLoyalty[]>([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedCustomer, setSelectedCustomer] = useState<CustomerLoyalty | null>(null);

  const isDark = resolvedTheme === 'dark';
  const formatMoney = (amount: number) => formatCurrency(amount);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [settingsRes, customersRes] = await Promise.all([
        bridge.loyalty.getSettings(),
        bridge.loyalty.getCustomers(),
      ]) as [any, any];

      setSettings(settingsRes?.settings || null);
      setCustomers(customersRes?.customers || []);

      Promise.all([
        bridge.loyalty.syncSettings().catch(() => null),
        bridge.loyalty.syncCustomers().catch(() => null),
      ]).then(async () => {
        try {
          const [freshSettings, freshCustomers] = await Promise.all([
            bridge.loyalty.getSettings(),
            bridge.loyalty.getCustomers(),
          ]) as [any, any];
          if (freshSettings?.settings) setSettings(freshSettings.settings);
          if (freshCustomers?.customers) setCustomers(freshCustomers.customers);
        } catch { /* ignore */ }
      });
    } catch (error) {
      console.error('Failed to fetch loyalty data:', error);
      toast.error(t('loyalty.errors.loadFailed', 'Failed to load loyalty data'));
    } finally {
      setLoading(false);
    }
  }, [bridge.loyalty, t]);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  const getTierColor = (tier: string) => {
    switch (tier?.toLowerCase()) {
      case 'platinum': return 'text-purple-400 bg-purple-500/20 border-purple-500/30';
      case 'gold': return 'text-yellow-400 bg-yellow-500/20 border-yellow-500/30';
      case 'silver': return 'text-zinc-300 bg-zinc-400/20 border-zinc-400/30';
      default: return 'text-amber-500 bg-amber-500/20 border-amber-500/30';
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
        <RefreshCw className={`w-8 h-8 animate-spin ${isDark ? 'text-zinc-300' : 'text-gray-700'}`} />
      </div>
    );
  }

  if (!loading && !settings?.is_active) {
    return (
      <div className={`h-full flex items-center justify-center p-5 ${isDark ? 'bg-black text-zinc-100' : 'bg-gray-50 text-gray-900'}`}>
        <div className={`p-8 rounded-2xl text-center max-w-md border ${isDark ? 'bg-zinc-950 border-zinc-800' : 'bg-white border-gray-200'}`}>
          <Award className={`w-16 h-16 mx-auto mb-4 ${isDark ? 'text-zinc-500' : 'text-gray-400'}`} />
          <h2 className="text-xl font-bold mb-2">{t('loyalty.programInactive', 'Loyalty Program Inactive')}</h2>
          <p className={`text-sm ${isDark ? 'text-zinc-400' : 'text-gray-600'}`}>
            {t('loyalty.programInactiveDesc', 'The loyalty program is currently disabled. Enable it from the admin dashboard.')}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className={`h-full overflow-auto p-4 md:p-5 ${isDark ? 'bg-black text-zinc-100' : 'bg-gray-50 text-gray-900'}`}>
      {/* Header + Stats Card */}
      <div className={`rounded-2xl border mb-5 px-4 py-4 ${isDark ? 'bg-zinc-950 border-zinc-800' : 'bg-white border-gray-200'}`}>
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <div className={`p-2 rounded-xl ${isDark ? 'bg-zinc-900 border border-zinc-700' : 'bg-gray-100 border border-gray-200'}`}>
              <Award className={`w-6 h-6 ${isDark ? 'text-zinc-200' : 'text-gray-700'}`} />
            </div>
            <div>
              <h1 className="text-xl font-bold">{t('loyalty.title', 'Loyalty Program')}</h1>
              <p className={`text-sm ${isDark ? 'text-zinc-400' : 'text-gray-600'}`}>
                {settings?.points_per_euro} {t('loyalty.pointsPerEuro', 'point per €1')} • {formatMoney(settings?.redemption_rate || 0.01)} {t('loyalty.perPoint', 'per point')}
              </p>
            </div>
          </div>
          <button
            onClick={() => void fetchData()}
            className={`h-10 w-10 inline-flex items-center justify-center rounded-xl border ${isDark ? 'bg-zinc-900 border-zinc-700 hover:bg-zinc-800' : 'bg-white border-gray-300 hover:bg-gray-100'}`}
          >
            <RefreshCw className={`w-5 h-5 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className={`p-4 rounded-xl border ${isDark ? 'bg-black border-zinc-800' : 'bg-white border-gray-200'}`}
          >
            <div className="flex items-center gap-3">
              <div className={`p-2 rounded-lg ${isDark ? 'bg-zinc-800' : 'bg-gray-100'}`}>
                <Users className={`w-5 h-5 ${isDark ? 'text-zinc-200' : 'text-gray-700'}`} />
              </div>
              <div>
                <p className={`text-xs ${isDark ? 'text-zinc-400' : 'text-gray-500'}`}>{t('loyalty.members', 'Members')}</p>
                <p className="text-xl font-bold">{stats.totalMembers}</p>
              </div>
            </div>
          </motion.div>
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 }}
            className={`p-4 rounded-xl border ${isDark ? 'bg-black border-zinc-800' : 'bg-white border-gray-200'}`}
          >
            <div className="flex items-center gap-3">
              <div className={`p-2 rounded-lg ${isDark ? 'bg-zinc-800' : 'bg-gray-100'}`}>
                <Award className={`w-5 h-5 ${isDark ? 'text-zinc-200' : 'text-gray-700'}`} />
              </div>
              <div>
                <p className={`text-xs ${isDark ? 'text-zinc-400' : 'text-gray-500'}`}>{t('loyalty.totalPoints', 'Total Points')}</p>
                <p className="text-xl font-bold">{stats.totalPoints.toLocaleString()}</p>
              </div>
            </div>
          </motion.div>
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.2 }}
            className={`p-4 rounded-xl border ${isDark ? 'bg-black border-zinc-800' : 'bg-white border-gray-200'}`}
          >
            <div className="flex items-center gap-3">
              <div className={`p-2 rounded-lg ${isDark ? 'bg-zinc-800' : 'bg-gray-100'}`}>
                <TrendingUp className={`w-5 h-5 ${isDark ? 'text-zinc-200' : 'text-gray-700'}`} />
              </div>
              <div>
                <p className={`text-xs ${isDark ? 'text-zinc-400' : 'text-gray-500'}`}>{t('loyalty.avgPoints', 'Avg Points')}</p>
                <p className="text-xl font-bold">{stats.avgPoints}</p>
              </div>
            </div>
          </motion.div>
        </div>
      </div>

      {/* Search */}
      <div className={`flex items-center gap-2 px-3 py-2 rounded-xl mb-5 border ${isDark ? 'bg-zinc-950 border-zinc-800' : 'bg-white border-gray-200'}`}>
        <Search className={`w-4 h-4 ${isDark ? 'text-zinc-400' : 'text-gray-400'}`} />
        <input
          type="text"
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          placeholder={t('loyalty.searchCustomers', 'Search customers...')}
          className={`flex-1 bg-transparent outline-none text-sm ${isDark ? 'text-zinc-100 placeholder-zinc-500' : 'text-gray-900 placeholder-gray-400'}`}
        />
      </div>

      {/* Customers List */}
      {filteredCustomers.length === 0 ? (
        <div className={`p-8 rounded-xl text-center border ${isDark ? 'bg-zinc-950 border-zinc-800' : 'bg-white border-gray-200'}`}>
          <Users className={`w-12 h-12 mx-auto mb-4 ${isDark ? 'text-zinc-600' : 'text-gray-400'}`} />
          <h3 className="text-lg font-semibold mb-2">{t('loyalty.noMembers', 'No Loyalty Members')}</h3>
          <p className={`text-sm ${isDark ? 'text-zinc-400' : 'text-gray-600'}`}>
            {t('loyalty.noMembersDesc', 'Customers will appear here when they join the loyalty program.')}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {filteredCustomers.map((customer, idx) => (
            <motion.div
              key={customer.id}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: idx * 0.05 }}
              onClick={() => setSelectedCustomer(selectedCustomer?.id === customer.id ? null : customer)}
              className={`p-4 rounded-xl cursor-pointer transition-all border ${
                isDark ? 'bg-zinc-950 hover:bg-zinc-900 border-zinc-800' : 'bg-white hover:bg-gray-50 border-gray-200'
              } ${selectedCustomer?.id === customer.id ? 'ring-2 ring-purple-500' : ''}`}
            >
              <div className="flex items-start justify-between mb-3">
                <div>
                  <p className="font-semibold">{customer.customer_name || t('loyalty.unknownCustomer', 'Unknown')}</p>
                  {customer.customer_email && (
                    <p className={`text-xs flex items-center gap-1 ${isDark ? 'text-zinc-400' : 'text-gray-500'}`}>
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
                  <p className="text-lg font-bold text-purple-400">{customer.points_balance}</p>
                  <p className={`text-xs ${isDark ? 'text-zinc-500' : 'text-gray-400'}`}>{t('loyalty.balance', 'Balance')}</p>
                </div>
                <div>
                  <p className="text-lg font-bold text-green-400">{customer.total_earned}</p>
                  <p className={`text-xs ${isDark ? 'text-zinc-500' : 'text-gray-400'}`}>{t('loyalty.earned', 'Earned')}</p>
                </div>
                <div>
                  <p className="text-lg font-bold text-orange-400">{customer.total_redeemed}</p>
                  <p className={`text-xs ${isDark ? 'text-zinc-500' : 'text-gray-400'}`}>{t('loyalty.redeemed', 'Redeemed')}</p>
                </div>
              </div>

              {customer.points_balance >= (settings?.min_redemption_points || 100) && (
                <div className={`mt-3 pt-3 border-t ${isDark ? 'border-zinc-800' : 'border-gray-200'}`}>
                  <div className="flex items-center justify-between text-sm">
                    <span className="flex items-center gap-1 text-green-400">
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
