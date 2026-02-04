import React, { useEffect, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { motion } from 'framer-motion';
import {
  MapPin,
  RefreshCw,
  Clock,
  DollarSign,
  Truck,
  CheckCircle,
  XCircle,
  Info
} from 'lucide-react';
import { useTheme } from '../contexts/theme-context';
import { useShift } from '../contexts/shift-context';
import { toast } from 'react-hot-toast';
import { formatCurrency } from '../utils/format';

interface DeliveryZone {
  id: string;
  name: string;
  description?: string;
  min_order_amount: number;
  delivery_fee: number;
  estimated_time_min: number;
  estimated_time_max: number;
  is_active: boolean;
  color_code?: string;
  polygon?: unknown;
}

const DeliveryZonesPage: React.FC = () => {
  const { t } = useTranslation();
  const { resolvedTheme } = useTheme();
  const { staff } = useShift();
  const [loading, setLoading] = useState(true);
  const [zones, setZones] = useState<DeliveryZone[]>([]);
  const [selectedZone, setSelectedZone] = useState<DeliveryZone | null>(null);

  const isDark = resolvedTheme === 'dark';
  const formatMoney = (amount: number) => formatCurrency(amount);

  const fetchZones = useCallback(async () => {
    if (!staff?.branchId) return;
    setLoading(true);
    try {
      const { posApiGet } = await import('../utils/api-helpers');
      const result = await posApiGet<DeliveryZone[] | { zones: DeliveryZone[] }>(
        `pos/delivery-zones?branch_id=${staff.branchId}`
      );

      if (!result.success || !result.data) {
        throw new Error(result.error || 'Delivery zones API returned no data');
      }
      const zonesData = Array.isArray(result.data) ? result.data : (result.data.zones || []);
      setZones(zonesData);
    } catch (error) {
      console.error('Failed to fetch delivery zones:', error);
      toast.error(t('deliveryZones.errors.loadFailed', 'Failed to load delivery zones'));
    } finally {
      setLoading(false);
    }
  }, [staff?.branchId, t]);

  useEffect(() => {
    fetchZones();
  }, [fetchZones]);

  const activeZones = zones.filter(z => z.is_active);
  const inactiveZones = zones.filter(z => !z.is_active);

  if (loading && zones.length === 0) {
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
            <MapPin className="w-6 h-6 text-cyan-500" />
          </div>
          <div>
            <h1 className="text-xl font-bold">{t('deliveryZones.title', 'Delivery Zones')}</h1>
            <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
              {t('deliveryZones.subtitle', 'View delivery areas and fees')}
            </p>
          </div>
        </div>
        <button
          onClick={fetchZones}
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
            <div className="p-2 rounded-lg bg-green-500/20">
              <CheckCircle className="w-5 h-5 text-green-500" />
            </div>
            <div>
              <p className={`text-xs ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>{t('deliveryZones.activeZones', 'Active Zones')}</p>
              <p className="text-xl font-bold">{activeZones.length}</p>
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
              <DollarSign className="w-5 h-5 text-blue-500" />
            </div>
            <div>
              <p className={`text-xs ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>{t('deliveryZones.avgFee', 'Avg Delivery Fee')}</p>
              <p className="text-xl font-bold">
                {formatMoney(activeZones.length > 0 ? activeZones.reduce((sum, z) => sum + z.delivery_fee, 0) / activeZones.length : 0)}
              </p>
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
            <div className="p-2 rounded-lg bg-purple-500/20">
              <Clock className="w-5 h-5 text-purple-500" />
            </div>
            <div>
              <p className={`text-xs ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>{t('deliveryZones.avgTime', 'Avg Delivery Time')}</p>
              <p className="text-xl font-bold">
                {activeZones.length > 0 ? Math.round(activeZones.reduce((sum, z) => sum + (z.estimated_time_min + z.estimated_time_max) / 2, 0) / activeZones.length) : 0} min
              </p>
            </div>
          </div>
        </motion.div>
      </div>

      {/* Zones Grid */}
      {zones.length === 0 ? (
        <div className={`p-8 rounded-xl text-center ${isDark ? 'bg-gray-800/50' : 'bg-white/80'} border ${isDark ? 'border-gray-700' : 'border-gray-200'}`}>
          <MapPin className="w-12 h-12 mx-auto mb-4 text-gray-400" />
          <h3 className="text-lg font-semibold mb-2">{t('deliveryZones.noZones', 'No Delivery Zones')}</h3>
          <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
            {t('deliveryZones.noZonesDesc', 'Delivery zones are configured in the admin dashboard.')}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {zones.map((zone, idx) => (
            <motion.div
              key={zone.id}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: idx * 0.05 }}
              onClick={() => setSelectedZone(selectedZone?.id === zone.id ? null : zone)}
              className={`p-4 rounded-xl cursor-pointer transition-all ${isDark ? 'bg-gray-800/50 hover:bg-gray-800' : 'bg-white/80 hover:bg-white'} border ${isDark ? 'border-gray-700' : 'border-gray-200'} ${selectedZone?.id === zone.id ? 'ring-2 ring-cyan-500' : ''} ${!zone.is_active ? 'opacity-60' : ''}`}
            >
              <div className="flex items-start justify-between mb-3">
                <div className="flex items-center gap-2">
                  <div
                    className="w-4 h-4 rounded-full"
                    style={{ backgroundColor: zone.color_code || '#6b7280' }}
                  />
                  <h3 className="font-semibold">{zone.name}</h3>
                </div>
                {zone.is_active ? (
                  <span className="px-2 py-0.5 text-xs bg-green-500/20 text-green-500 rounded">
                    {t('common.active', 'Active')}
                  </span>
                ) : (
                  <span className="px-2 py-0.5 text-xs bg-red-500/20 text-red-500 rounded">
                    {t('common.inactive', 'Inactive')}
                  </span>
                )}
              </div>

              <div className="grid grid-cols-2 gap-3 text-sm">
                <div className="flex items-center gap-2">
                  <DollarSign className="w-4 h-4 text-gray-400" />
                  <div>
                    <p className={`text-xs ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>{t('deliveryZones.minOrder', 'Min Order')}</p>
                    <p className="font-medium">{formatMoney(zone.min_order_amount)}</p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Truck className="w-4 h-4 text-gray-400" />
                  <div>
                    <p className={`text-xs ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>{t('deliveryZones.fee', 'Delivery Fee')}</p>
                    <p className="font-medium">{zone.delivery_fee === 0 ? t('common.free', 'Free') : formatMoney(zone.delivery_fee)}</p>
                  </div>
                </div>
                <div className="flex items-center gap-2 col-span-2">
                  <Clock className="w-4 h-4 text-gray-400" />
                  <div>
                    <p className={`text-xs ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>{t('deliveryZones.estimatedTime', 'Est. Time')}</p>
                    <p className="font-medium">{zone.estimated_time_min}-{zone.estimated_time_max} min</p>
                  </div>
                </div>
              </div>

              {zone.description && (
                <div className={`mt-3 pt-3 border-t ${isDark ? 'border-gray-700' : 'border-gray-200'}`}>
                  <div className="flex items-start gap-2">
                    <Info className="w-4 h-4 text-gray-400 mt-0.5" />
                    <p className={`text-xs ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>{zone.description}</p>
                  </div>
                </div>
              )}
            </motion.div>
          ))}
        </div>
      )}

      {/* Info Banner */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.3 }}
        className={`mt-6 p-4 rounded-xl ${isDark ? 'bg-blue-500/10 border-blue-500/20' : 'bg-blue-50 border-blue-200'} border`}
      >
        <div className="flex items-start gap-3">
          <Info className="w-5 h-5 text-blue-500 mt-0.5" />
          <div>
            <p className="font-medium text-blue-500">{t('deliveryZones.infoTitle', 'Delivery Zone Information')}</p>
            <p className={`text-sm ${isDark ? 'text-blue-400/70' : 'text-blue-600/70'}`}>
              {t('deliveryZones.infoDesc', 'Delivery zones are managed from the admin dashboard. Use this view to check zone details when processing delivery orders.')}
            </p>
          </div>
        </div>
      </motion.div>
    </div>
  );
};

export default DeliveryZonesPage;

