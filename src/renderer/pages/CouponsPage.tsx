import React, { useEffect, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { motion } from 'framer-motion';
import {
  Ticket,
  RefreshCw,
  Search,
  CheckCircle,
  XCircle,
  Percent,
  DollarSign,
  Calendar,
  Copy,
  Check
} from 'lucide-react';
import { useTheme } from '../contexts/theme-context';
import { useShift } from '../contexts/shift-context';
import { toast } from 'react-hot-toast';
import { posApiGet } from '../utils/api-helpers';
import { formatCurrency, formatDate } from '../utils/format';

interface Coupon {
  id: string;
  code: string;
  name?: string;
  description?: string;
  discount_type: 'percentage' | 'fixed';
  discount_value: number;
  usage_limit?: number;
  usage_count: number;
  min_order_amount?: number;
  expires_at?: string;
  is_active: boolean;
}

const CouponsPage: React.FC = () => {
  const { t } = useTranslation();
  const { resolvedTheme } = useTheme();
  const { staff } = useShift();
  const [loading, setLoading] = useState(true);
  const [coupons, setCoupons] = useState<Coupon[]>([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [showActiveOnly, setShowActiveOnly] = useState(true);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const isDark = resolvedTheme === 'dark';
  const formatMoney = (amount: number) => formatCurrency(amount);

  const fetchCoupons = useCallback(async () => {
    if (!staff?.organizationId) return;
    setLoading(true);
    try {
      const branchParam = staff?.branchId ? `&branch_id=${staff.branchId}` : '';
      const result = await posApiGet<{ coupons?: Coupon[] }>(
        `pos/coupons?organization_id=${staff.organizationId}${branchParam}`
      );
      if (!result.success) {
        throw new Error(result.error || 'Failed to load coupons');
      }
      setCoupons(result.data?.coupons || []);
    } catch (error) {
      console.error('Failed to fetch coupons:', error);
      toast.error(t('coupons.errors.loadFailed', 'Failed to load coupons'));
    } finally {
      setLoading(false);
    }
  }, [staff?.organizationId, staff?.branchId, t]);

  useEffect(() => {
    fetchCoupons();
  }, [fetchCoupons]);

  const copyCode = (code: string, id: string) => {
    navigator.clipboard.writeText(code);
    setCopiedId(id);
    toast.success(t('coupons.codeCopied', 'Code copied!'));
    setTimeout(() => setCopiedId(null), 2000);
  };

  const isExpired = (expiresAt?: string) => {
    if (!expiresAt) return false;
    return new Date(expiresAt) < new Date();
  };

  const isUsedUp = (coupon: Coupon) => {
    if (!coupon.usage_limit) return false;
    return coupon.usage_count >= coupon.usage_limit;
  };

  const filteredCoupons = coupons.filter(coupon => {
    const matchesSearch = !searchTerm || 
      coupon.code.toLowerCase().includes(searchTerm.toLowerCase()) ||
      coupon.name?.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesActive = !showActiveOnly || (coupon.is_active && !isExpired(coupon.expires_at) && !isUsedUp(coupon));
    return matchesSearch && matchesActive;
  });

  const activeCoupons = coupons.filter(c => c.is_active && !isExpired(c.expires_at) && !isUsedUp(c));

  if (loading && coupons.length === 0) {
    return (
      <div className="flex items-center justify-center h-full">
        <RefreshCw className="w-8 h-8 animate-spin text-cyan-500" />
      </div>
    );
  }

  return (
    <div className={`h-full overflow-auto p-4 ${isDark ? 'bg-gray-900' : 'bg-gray-50'}`}>
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-xl bg-cyan-500/20">
            <Ticket className="w-6 h-6 text-cyan-500" />
          </div>
          <div>
            <h1 className="text-xl font-bold">{t('coupons.title', 'Coupons')}</h1>
            <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
              {t('coupons.subtitle', 'Available discount codes')}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowActiveOnly(!showActiveOnly)}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
              showActiveOnly
                ? 'bg-cyan-500 text-white'
                : isDark ? 'bg-gray-800 text-gray-300' : 'bg-white text-gray-700'
            }`}
          >
            {t('coupons.activeOnly', 'Active Only')}
          </button>
          <button
            onClick={fetchCoupons}
            className={`p-2 rounded-lg ${isDark ? 'bg-gray-800 hover:bg-gray-700' : 'bg-white hover:bg-gray-100'}`}
          >
            <RefreshCw className={`w-5 h-5 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 gap-4 mb-6">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className={`p-4 rounded-xl ${isDark ? 'bg-gray-800/50' : 'bg-white/80'} border ${isDark ? 'border-gray-700' : 'border-gray-200'}`}
        >
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-green-500/20">
              <CheckCircle className="w-5 h-5 text-green-500" />
            </div>
            <div>
              <p className={`text-xs ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>{t('coupons.activeCoupons', 'Active Coupons')}</p>
              <p className="text-xl font-bold">{activeCoupons.length}</p>
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
            <div className="p-2 rounded-lg bg-blue-500/20">
              <Ticket className="w-5 h-5 text-blue-500" />
            </div>
            <div>
              <p className={`text-xs ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>{t('coupons.totalCoupons', 'Total Coupons')}</p>
              <p className="text-xl font-bold">{coupons.length}</p>
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
          placeholder={t('coupons.search', 'Search coupons...')}
          className="flex-1 bg-transparent outline-none text-sm"
        />
      </div>

      {/* Coupons Grid */}
      {filteredCoupons.length === 0 ? (
        <div className={`p-8 rounded-xl text-center ${isDark ? 'bg-gray-800/50' : 'bg-white/80'} border ${isDark ? 'border-gray-700' : 'border-gray-200'}`}>
          <Ticket className="w-12 h-12 mx-auto mb-4 text-gray-400" />
          <h3 className="text-lg font-semibold mb-2">{t('coupons.noCoupons', 'No Coupons Found')}</h3>
          <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
            {t('coupons.noCouponsDesc', 'Coupons are managed from the admin dashboard.')}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filteredCoupons.map((coupon, idx) => {
            const expired = isExpired(coupon.expires_at);
            const usedUp = isUsedUp(coupon);
            const isValid = coupon.is_active && !expired && !usedUp;

            return (
              <motion.div
                key={coupon.id}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: idx * 0.05 }}
                className={`p-4 rounded-xl ${isDark ? 'bg-gray-800/50' : 'bg-white/80'} border ${isDark ? 'border-gray-700' : 'border-gray-200'} ${!isValid ? 'opacity-60' : ''}`}
              >
                <div className="flex items-start justify-between mb-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-mono font-bold text-lg text-cyan-500">{coupon.code}</span>
                      <button
                        onClick={() => copyCode(coupon.code, coupon.id)}
                        className={`p-1 rounded ${isDark ? 'hover:bg-gray-700' : 'hover:bg-gray-100'}`}
                      >
                        {copiedId === coupon.id ? <Check className="w-4 h-4 text-green-500" /> : <Copy className="w-4 h-4 text-gray-400" />}
                      </button>
                    </div>
                    {coupon.name && <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>{coupon.name}</p>}
                  </div>
                  {isValid ? (
                    <span className="px-2 py-0.5 text-xs bg-green-500/20 text-green-500 rounded flex items-center gap-1">
                      <CheckCircle className="w-3 h-3" />
                      {t('common.active', 'Active')}
                    </span>
                  ) : (
                    <span className="px-2 py-0.5 text-xs bg-red-500/20 text-red-500 rounded flex items-center gap-1">
                      <XCircle className="w-3 h-3" />
                      {expired ? t('coupons.expired', 'Expired') : usedUp ? t('coupons.usedUp', 'Used Up') : t('common.inactive', 'Inactive')}
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-4 mb-3">
                  <div className="flex items-center gap-1">
                    {coupon.discount_type === 'percentage' ? <Percent className="w-4 h-4 text-cyan-500" /> : <DollarSign className="w-4 h-4 text-cyan-500" />}
                    <span className="font-bold text-lg">
                      {coupon.discount_type === 'percentage' ? `${coupon.discount_value}%` : formatMoney(coupon.discount_value)}
                    </span>
                  </div>
                </div>

                <div className="space-y-2 text-sm">
                  {coupon.min_order_amount && coupon.min_order_amount > 0 && (
                    <div className="flex justify-between">
                      <span className={isDark ? 'text-gray-400' : 'text-gray-500'}>{t('coupons.minOrder', 'Min Order')}</span>
                      <span>{formatMoney(coupon.min_order_amount)}</span>
                    </div>
                  )}
                  {coupon.usage_limit && (
                    <div className="flex justify-between">
                      <span className={isDark ? 'text-gray-400' : 'text-gray-500'}>{t('coupons.usage', 'Usage')}</span>
                      <span>{coupon.usage_count} / {coupon.usage_limit}</span>
                    </div>
                  )}
                  {coupon.expires_at && (
                    <div className="flex justify-between items-center">
                      <span className={isDark ? 'text-gray-400' : 'text-gray-500'}>{t('coupons.expires', 'Expires')}</span>
                      <span className={`flex items-center gap-1 ${expired ? 'text-red-500' : ''}`}>
                        <Calendar className="w-3 h-3" />
                        {formatDate(coupon.expires_at)}
                      </span>
                    </div>
                  )}
                </div>
              </motion.div>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default CouponsPage;

