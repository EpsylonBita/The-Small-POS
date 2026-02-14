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
        <RefreshCw className={`w-8 h-8 animate-spin ${isDark ? 'text-zinc-300' : 'text-gray-700'}`} />
      </div>
    );
  }

  return (
    <div className={`h-full overflow-auto p-4 md:p-5 ${isDark ? 'bg-black text-zinc-100' : 'bg-gray-50 text-gray-900'}`}>
      {/* Header */}
      <div className={`rounded-2xl border mb-5 px-4 py-4 ${isDark ? 'bg-zinc-950 border-zinc-800' : 'bg-white border-gray-200'}`}>
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <div className={`p-2 rounded-xl ${isDark ? 'bg-zinc-900 border border-zinc-700' : 'bg-gray-100 border border-gray-200'}`}>
            <MapPin className={`w-6 h-6 ${isDark ? 'text-zinc-200' : 'text-gray-700'}`} />
          </div>
          <div>
            <h1 className="text-xl font-bold">{t('deliveryZones.title', 'Delivery Zones')}</h1>
            <p className={`text-sm ${isDark ? 'text-zinc-400' : 'text-gray-600'}`}>
              {t('deliveryZones.subtitle', 'View delivery areas and fees')}
            </p>
          </div>
        </div>
        <button
          onClick={fetchZones}
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
              <CheckCircle className={`w-5 h-5 ${isDark ? 'text-zinc-200' : 'text-gray-700'}`} />
            </div>
            <div>
              <p className={`text-xs ${isDark ? 'text-zinc-400' : 'text-gray-500'}`}>{t('deliveryZones.activeZones', 'Active Zones')}</p>
              <p className="text-xl font-bold">{activeZones.length}</p>
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
              <DollarSign className={`w-5 h-5 ${isDark ? 'text-zinc-200' : 'text-gray-700'}`} />
            </div>
            <div>
              <p className={`text-xs ${isDark ? 'text-zinc-400' : 'text-gray-500'}`}>{t('deliveryZones.avgFee', 'Avg Delivery Fee')}</p>
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
          className={`p-4 rounded-xl border ${isDark ? 'bg-black border-zinc-800' : 'bg-white border-gray-200'}`}
        >
          <div className="flex items-center gap-3">
            <div className={`p-2 rounded-lg ${isDark ? 'bg-zinc-800' : 'bg-gray-100'}`}>
              <Clock className={`w-5 h-5 ${isDark ? 'text-zinc-200' : 'text-gray-700'}`} />
            </div>
            <div>
              <p className={`text-xs ${isDark ? 'text-zinc-400' : 'text-gray-500'}`}>{t('deliveryZones.avgTime', 'Avg Delivery Time')}</p>
              <p className="text-xl font-bold">
                {activeZones.length > 0 ? Math.round(activeZones.reduce((sum, z) => sum + (z.estimated_time_min + z.estimated_time_max) / 2, 0) / activeZones.length) : 0} min
              </p>
            </div>
          </div>
        </motion.div>
      </div>
      </div>

      {/* Zones Grid */}
      {zones.length === 0 ? (
        <div className={`p-8 rounded-xl text-center border ${isDark ? 'bg-zinc-950 border-zinc-800' : 'bg-white border-gray-200'}`}>
          <MapPin className="w-12 h-12 mx-auto mb-4 text-gray-400" />
          <h3 className="text-lg font-semibold mb-2">{t('deliveryZones.noZones', 'No Delivery Zones')}</h3>
          <p className={`text-sm ${isDark ? 'text-zinc-400' : 'text-gray-600'}`}>
            {t('deliveryZones.noZonesDesc', 'Delivery zones are configured in the admin dashboard.')}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {zones.map((zone, idx) => (
            <motion.div
              key={zone.id}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: idx * 0.05 }}
              onClick={() => setSelectedZone(selectedZone?.id === zone.id ? null : zone)}
              className={`p-4 rounded-xl cursor-pointer transition-all border ${
                isDark ? 'bg-zinc-950 hover:bg-zinc-900 border-zinc-800' : 'bg-white hover:bg-gray-50 border-gray-200'
              } ${
                selectedZone?.id === zone.id
                  ? isDark ? 'ring-2 ring-zinc-500' : 'ring-2 ring-gray-400'
                  : ''
              } ${!zone.is_active ? 'opacity-70' : ''}`}
            >
              <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
                <div className="flex items-center gap-2">
                  <div
                    className="w-4 h-4 rounded-full"
                    style={{ backgroundColor: zone.color_code || '#6b7280' }}
                  />
                  <h3 className="font-semibold text-lg">{zone.name}</h3>
                </div>
                {zone.is_active ? (
                  <span className={`px-2.5 py-1 text-xs rounded-lg ${
                    isDark ? 'bg-zinc-900 border border-zinc-700 text-zinc-200' : 'bg-gray-100 border border-gray-300 text-gray-700'
                  }`}>
                    {t('common.active', 'Active')}
                  </span>
                ) : (
                  <span className={`px-2.5 py-1 text-xs rounded-lg ${
                    isDark ? 'bg-zinc-900 border border-zinc-700 text-zinc-400' : 'bg-gray-100 border border-gray-300 text-gray-500'
                  }`}>
                    {t('common.inactive', 'Inactive')}
                  </span>
                )}
              </div>

              <div className="mt-3 grid grid-cols-1 sm:grid-cols-3 gap-2 text-sm">
                <div className={`rounded-lg px-3 py-2 ${isDark ? 'bg-black border border-zinc-800' : 'bg-gray-50 border border-gray-200'}`}>
                  <div className="flex items-center gap-2">
                    <DollarSign className="w-4 h-4 text-gray-400" />
                    <p className={`text-xs ${isDark ? 'text-zinc-400' : 'text-gray-500'}`}>{t('deliveryZones.minOrder', 'Min Order')}</p>
                  </div>
                  <p className="font-semibold mt-1">{formatMoney(zone.min_order_amount)}</p>
                </div>
                <div className={`rounded-lg px-3 py-2 ${isDark ? 'bg-black border border-zinc-800' : 'bg-gray-50 border border-gray-200'}`}>
                  <div className="flex items-center gap-2">
                    <Truck className="w-4 h-4 text-gray-400" />
                    <p className={`text-xs ${isDark ? 'text-zinc-400' : 'text-gray-500'}`}>{t('deliveryZones.fee', 'Delivery Fee')}</p>
                  </div>
                  <p className="font-semibold mt-1">{zone.delivery_fee === 0 ? t('common.free', 'Free') : formatMoney(zone.delivery_fee)}</p>
                </div>
                <div className={`rounded-lg px-3 py-2 ${isDark ? 'bg-black border border-zinc-800' : 'bg-gray-50 border border-gray-200'}`}>
                  <div className="flex items-center gap-2">
                    <Clock className="w-4 h-4 text-gray-400" />
                    <p className={`text-xs ${isDark ? 'text-zinc-400' : 'text-gray-500'}`}>{t('deliveryZones.estimatedTime', 'Est. Time')}</p>
                  </div>
                  <p className="font-semibold mt-1">{zone.estimated_time_min}-{zone.estimated_time_max} min</p>
                </div>
              </div>

              {zone.description && (
                <div className={`mt-3 pt-3 border-t ${isDark ? 'border-zinc-800' : 'border-gray-200'}`}>
                  <div className="flex items-start gap-2">
                    <Info className="w-4 h-4 text-gray-400 mt-0.5" />
                    <p className={`text-xs ${isDark ? 'text-zinc-400' : 'text-gray-500'}`}>{zone.description}</p>
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
        className={`mt-6 p-4 rounded-xl border ${isDark ? 'bg-zinc-950 border-zinc-800' : 'bg-white border-gray-200'}`}
      >
        <div className="flex items-start gap-3">
          <Info className={`w-5 h-5 mt-0.5 ${isDark ? 'text-zinc-300' : 'text-gray-700'}`} />
          <div>
            <p className={`font-medium ${isDark ? 'text-zinc-100' : 'text-gray-900'}`}>{t('deliveryZones.infoTitle', 'Delivery Zone Information')}</p>
            <p className={`text-sm ${isDark ? 'text-zinc-400' : 'text-gray-600'}`}>
              {t('deliveryZones.infoDesc', 'Delivery zones are managed from the admin dashboard. Use this view to check zone details when processing delivery orders.')}
            </p>
          </div>
        </div>
      </motion.div>
    </div>
  );
};

export default DeliveryZonesPage;

