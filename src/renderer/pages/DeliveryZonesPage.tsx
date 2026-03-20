import React, { useEffect, useMemo, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { motion } from 'framer-motion';
import {
  MapPin,
  RefreshCw,
  Clock,
  DollarSign,
  Truck,
  CheckCircle,
  Info,
  Activity,
  AlertTriangle,
  Flame,
} from 'lucide-react';
import { useTheme } from '../contexts/theme-context';
import { toast } from 'react-hot-toast';
import { formatCurrency } from '../utils/format';
import { posApiGet } from '../utils/api-helpers';

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

interface ZonePerformance {
  zoneId: string;
  zoneName: string;
  colorCode: string | null;
  totalValidations: number;
  successfulValidations: number;
  failedValidations: number;
  outOfZoneAttempts: number;
  successRate: number;
  totalOrders: number;
  totalRevenue: number;
  averageOrderValue: number;
  averageDeliveryTime: number;
  overrideRequests: number;
  overrideApprovals: number;
  overrideRate: number;
}

interface MapAnalyticsSummary {
  totalZones: number;
  activeZones: number;
  totalValidations: number;
  successfulValidations: number;
  failedValidations: number;
  outOfZoneAttempts: number;
  validationSuccessRate: number;
  overrideRequests: number;
  overrideApprovals: number;
  overrideApprovalRate: number;
  totalDeliveries: number;
  avgDeliveryTime: number;
  totalRevenue: number;
  avgResponseTimeMs: number;
  hotspotCount: number;
  heatmapPoints: Array<{ lat: number; lng: number; intensity: number }>;
  outOfZoneHotspots: Array<{ lat: number; lng: number; count: number }>;
  zonePerformance: ZonePerformance[];
}

const DeliveryZonesPage: React.FC = () => {
  const { t } = useTranslation();
  const { resolvedTheme } = useTheme();
  const [loading, setLoading] = useState(true);
  const [zones, setZones] = useState<DeliveryZone[]>([]);
  const [analytics, setAnalytics] = useState<MapAnalyticsSummary | null>(null);
  const [selectedZoneId, setSelectedZoneId] = useState<string | null>(null);

  const isDark = resolvedTheme === 'dark';
  const formatMoney = (amount: number) => formatCurrency(amount);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [zonesResult, analyticsResult] = await Promise.all([
        posApiGet<{ success: boolean; zones: DeliveryZone[] }>('pos/delivery-zones'),
        posApiGet<{ success: boolean; analytics: MapAnalyticsSummary }>('pos/map-analytics?time_range=30d'),
      ]);

      if (!zonesResult.success || !zonesResult.data?.zones) {
        throw new Error(zonesResult.error || 'Delivery zones API returned no data');
      }

      if (!analyticsResult.success || !analyticsResult.data?.analytics) {
        throw new Error(analyticsResult.error || 'Map analytics API returned no data');
      }

      const zonesData = zonesResult.data.zones;
      setZones(zonesData);
      setAnalytics(analyticsResult.data.analytics);
      setSelectedZoneId((current) => current || zonesData[0]?.id || null);
    } catch (error) {
      console.error('Failed to fetch delivery zone analytics:', error);
      toast.error(t('deliveryZones.errors.loadFailed', 'Failed to load delivery zones'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  const activeZones = zones.filter((zone) => zone.is_active);
  const selectedZone = zones.find((zone) => zone.id === selectedZoneId) || null;
  const zonePerformanceMap = useMemo(() => new Map(
    (analytics?.zonePerformance || []).map((zone) => [zone.zoneId, zone])
  ), [analytics?.zonePerformance]);
  const selectedZoneAnalytics = selectedZoneId ? zonePerformanceMap.get(selectedZoneId) || null : null;

  if (loading && zones.length === 0) {
    return (
      <div className="flex items-center justify-center h-full">
        <RefreshCw className={`w-8 h-8 animate-spin ${isDark ? 'text-zinc-300' : 'text-gray-700'}`} />
      </div>
    );
  }

  return (
    <div className={`h-full overflow-auto p-4 md:p-5 ${isDark ? 'bg-black text-zinc-100' : 'bg-gray-50 text-gray-900'}`}>
      <div className={`rounded-2xl border mb-5 px-4 py-4 ${isDark ? 'bg-zinc-950 border-zinc-800' : 'bg-white border-gray-200'}`}>
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <div className={`p-2 rounded-xl ${isDark ? 'bg-zinc-900 border border-zinc-700' : 'bg-gray-100 border border-gray-200'}`}>
              <MapPin className={`w-6 h-6 ${isDark ? 'text-zinc-200' : 'text-gray-700'}`} />
            </div>
            <div>
              <h1 className="text-xl font-bold">{t('deliveryZones.title', 'Delivery Zones')}</h1>
              <p className={`text-sm ${isDark ? 'text-zinc-400' : 'text-gray-600'}`}>
                {t('deliveryZones.subtitle', 'Live delivery zone performance and coverage')}
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

        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
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
            transition={{ delay: 0.05 }}
            className={`p-4 rounded-xl border ${isDark ? 'bg-black border-zinc-800' : 'bg-white border-gray-200'}`}
          >
            <div className="flex items-center gap-3">
              <div className={`p-2 rounded-lg ${isDark ? 'bg-zinc-800' : 'bg-gray-100'}`}>
                <Activity className={`w-5 h-5 ${isDark ? 'text-zinc-200' : 'text-gray-700'}`} />
              </div>
              <div>
                <p className={`text-xs ${isDark ? 'text-zinc-400' : 'text-gray-500'}`}>{t('deliveryZones.validations', 'Validations')}</p>
                <p className="text-xl font-bold">{analytics?.totalValidations || 0}</p>
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
                <Truck className={`w-5 h-5 ${isDark ? 'text-zinc-200' : 'text-gray-700'}`} />
              </div>
              <div>
                <p className={`text-xs ${isDark ? 'text-zinc-400' : 'text-gray-500'}`}>{t('deliveryZones.successRate', 'Success Rate')}</p>
                <p className="text-xl font-bold">{(analytics?.validationSuccessRate || 0).toFixed(1)}%</p>
              </div>
            </div>
          </motion.div>
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.15 }}
            className={`p-4 rounded-xl border ${isDark ? 'bg-black border-zinc-800' : 'bg-white border-gray-200'}`}
          >
            <div className="flex items-center gap-3">
              <div className={`p-2 rounded-lg ${isDark ? 'bg-zinc-800' : 'bg-gray-100'}`}>
                <Flame className={`w-5 h-5 ${isDark ? 'text-zinc-200' : 'text-gray-700'}`} />
              </div>
              <div>
                <p className={`text-xs ${isDark ? 'text-zinc-400' : 'text-gray-500'}`}>{t('deliveryZones.hotspots', 'Hotspots')}</p>
                <p className="text-xl font-bold">{analytics?.hotspotCount || 0}</p>
              </div>
            </div>
          </motion.div>
        </div>
      </div>

      {zones.length === 0 ? (
        <div className={`p-8 rounded-xl text-center border ${isDark ? 'bg-zinc-950 border-zinc-800' : 'bg-white border-gray-200'}`}>
          <MapPin className="w-12 h-12 mx-auto mb-4 text-gray-400" />
          <h3 className="text-lg font-semibold mb-2">{t('deliveryZones.noZones', 'No Delivery Zones')}</h3>
          <p className={`text-sm ${isDark ? 'text-zinc-400' : 'text-gray-600'}`}>
            {t('deliveryZones.noZonesDesc', 'Delivery zones are configured in the admin dashboard.')}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1.4fr)_minmax(320px,0.8fr)] gap-4">
          <div className="space-y-3">
            {zones.map((zone, idx) => {
              const zoneAnalytics = zonePerformanceMap.get(zone.id);

              return (
                <motion.div
                  key={zone.id}
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: idx * 0.04 }}
                  onClick={() => setSelectedZoneId(zone.id)}
                  className={`p-4 rounded-xl cursor-pointer transition-all border ${
                    isDark ? 'bg-zinc-950 hover:bg-zinc-900 border-zinc-800' : 'bg-white hover:bg-gray-50 border-gray-200'
                  } ${
                    selectedZoneId === zone.id
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
                    <span className={`px-2.5 py-1 text-xs rounded-lg ${
                      zone.is_active
                        ? isDark ? 'bg-zinc-900 border border-zinc-700 text-zinc-200' : 'bg-gray-100 border border-gray-300 text-gray-700'
                        : isDark ? 'bg-zinc-900 border border-zinc-700 text-zinc-400' : 'bg-gray-100 border border-gray-300 text-gray-500'
                    }`}>
                      {zone.is_active ? t('common.active', 'Active') : t('common.inactive', 'Inactive')}
                    </span>
                  </div>

                  <div className="mt-3 grid grid-cols-1 sm:grid-cols-3 gap-2 text-sm">
                    <div className={`rounded-lg px-3 py-2 ${isDark ? 'bg-black border border-zinc-800' : 'bg-gray-50 border border-gray-200'}`}>
                      <div className="flex items-center gap-2">
                        <DollarSign className="w-4 h-4 text-gray-400" />
                        <p className={`text-xs ${isDark ? 'text-zinc-400' : 'text-gray-500'}`}>{t('deliveryZones.fee', 'Delivery Fee')}</p>
                      </div>
                      <p className="font-semibold mt-1">{zone.delivery_fee === 0 ? t('common.free', 'Free') : formatMoney(zone.delivery_fee)}</p>
                    </div>
                    <div className={`rounded-lg px-3 py-2 ${isDark ? 'bg-black border border-zinc-800' : 'bg-gray-50 border border-gray-200'}`}>
                      <div className="flex items-center gap-2">
                        <Activity className="w-4 h-4 text-gray-400" />
                        <p className={`text-xs ${isDark ? 'text-zinc-400' : 'text-gray-500'}`}>{t('deliveryZones.validations', 'Validations')}</p>
                      </div>
                      <p className="font-semibold mt-1">{zoneAnalytics?.totalValidations || 0}</p>
                    </div>
                    <div className={`rounded-lg px-3 py-2 ${isDark ? 'bg-black border border-zinc-800' : 'bg-gray-50 border border-gray-200'}`}>
                      <div className="flex items-center gap-2">
                        <Clock className="w-4 h-4 text-gray-400" />
                        <p className={`text-xs ${isDark ? 'text-zinc-400' : 'text-gray-500'}`}>{t('deliveryZones.estimatedTime', 'Est. Time')}</p>
                      </div>
                      <p className="font-semibold mt-1">
                        {zoneAnalytics?.averageDeliveryTime || Math.round((zone.estimated_time_min + zone.estimated_time_max) / 2)} min
                      </p>
                    </div>
                  </div>

                  <div className="mt-3 grid grid-cols-1 sm:grid-cols-4 gap-2 text-sm">
                    <div className={`rounded-lg px-3 py-2 ${isDark ? 'bg-black border border-zinc-800' : 'bg-gray-50 border border-gray-200'}`}>
                      <p className={`text-xs ${isDark ? 'text-zinc-400' : 'text-gray-500'}`}>{t('deliveryZones.minOrder', 'Min Order')}</p>
                      <p className="font-semibold mt-1">{formatMoney(zone.min_order_amount)}</p>
                    </div>
                    <div className={`rounded-lg px-3 py-2 ${isDark ? 'bg-black border border-zinc-800' : 'bg-gray-50 border border-gray-200'}`}>
                      <p className={`text-xs ${isDark ? 'text-zinc-400' : 'text-gray-500'}`}>{t('deliveryZones.successRate', 'Success Rate')}</p>
                      <p className="font-semibold mt-1">{(zoneAnalytics?.successRate || 0).toFixed(1)}%</p>
                    </div>
                    <div className={`rounded-lg px-3 py-2 ${isDark ? 'bg-black border border-zinc-800' : 'bg-gray-50 border border-gray-200'}`}>
                      <p className={`text-xs ${isDark ? 'text-zinc-400' : 'text-gray-500'}`}>{t('deliveryZones.orders', 'Orders')}</p>
                      <p className="font-semibold mt-1">{zoneAnalytics?.totalOrders || 0}</p>
                    </div>
                    <div className={`rounded-lg px-3 py-2 ${isDark ? 'bg-black border border-zinc-800' : 'bg-gray-50 border border-gray-200'}`}>
                      <p className={`text-xs ${isDark ? 'text-zinc-400' : 'text-gray-500'}`}>{t('deliveryZones.revenue', 'Revenue')}</p>
                      <p className="font-semibold mt-1">{formatMoney(zoneAnalytics?.totalRevenue || 0)}</p>
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
              );
            })}
          </div>

          <motion.div
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            className={`h-fit rounded-xl border p-4 ${isDark ? 'bg-zinc-950 border-zinc-800' : 'bg-white border-gray-200'}`}
          >
            <div className="flex items-center gap-2 mb-4">
              <MapPin className={`w-5 h-5 ${isDark ? 'text-zinc-200' : 'text-gray-700'}`} />
              <h3 className="font-semibold">
                {selectedZone?.name || t('deliveryZones.zoneDetails', 'Zone Details')}
              </h3>
            </div>

            {selectedZone && selectedZoneAnalytics ? (
              <div className="space-y-3">
                <div className={`rounded-lg px-3 py-3 ${isDark ? 'bg-black border border-zinc-800' : 'bg-gray-50 border border-gray-200'}`}>
                  <p className={`text-xs ${isDark ? 'text-zinc-400' : 'text-gray-500'}`}>{t('deliveryZones.validationTotals', 'Validation Totals')}</p>
                  <p className="text-2xl font-bold mt-1">{selectedZoneAnalytics.totalValidations}</p>
                  <p className={`text-sm ${isDark ? 'text-zinc-400' : 'text-gray-600'}`}>
                    {selectedZoneAnalytics.successfulValidations} {t('deliveryZones.successful', 'successful')} • {selectedZoneAnalytics.failedValidations} {t('deliveryZones.failed', 'failed')}
                  </p>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className={`rounded-lg px-3 py-3 ${isDark ? 'bg-black border border-zinc-800' : 'bg-gray-50 border border-gray-200'}`}>
                    <p className={`text-xs ${isDark ? 'text-zinc-400' : 'text-gray-500'}`}>{t('deliveryZones.overrideRate', 'Override Rate')}</p>
                    <p className="text-xl font-bold mt-1">{selectedZoneAnalytics.overrideRate.toFixed(1)}%</p>
                    <p className={`text-xs ${isDark ? 'text-zinc-400' : 'text-gray-500'}`}>
                      {selectedZoneAnalytics.overrideApprovals}/{selectedZoneAnalytics.overrideRequests} {t('deliveryZones.approved', 'approved')}
                    </p>
                  </div>
                  <div className={`rounded-lg px-3 py-3 ${isDark ? 'bg-black border border-zinc-800' : 'bg-gray-50 border border-gray-200'}`}>
                    <p className={`text-xs ${isDark ? 'text-zinc-400' : 'text-gray-500'}`}>{t('deliveryZones.averageOrder', 'Average Order')}</p>
                    <p className="text-xl font-bold mt-1">{formatMoney(selectedZoneAnalytics.averageOrderValue)}</p>
                    <p className={`text-xs ${isDark ? 'text-zinc-400' : 'text-gray-500'}`}>
                      {selectedZoneAnalytics.totalOrders} {t('deliveryZones.orders', 'orders')}
                    </p>
                  </div>
                </div>
                <div className={`rounded-lg px-3 py-3 ${isDark ? 'bg-black border border-zinc-800' : 'bg-gray-50 border border-gray-200'}`}>
                  <div className="flex items-center justify-between">
                    <div>
                      <p className={`text-xs ${isDark ? 'text-zinc-400' : 'text-gray-500'}`}>{t('deliveryZones.deliveryPerformance', 'Delivery Performance')}</p>
                      <p className="text-xl font-bold mt-1">{selectedZoneAnalytics.averageDeliveryTime} min</p>
                    </div>
                    <div className="text-right">
                      <p className={`text-xs ${isDark ? 'text-zinc-400' : 'text-gray-500'}`}>{t('deliveryZones.revenue', 'Revenue')}</p>
                      <p className="text-lg font-bold mt-1">{formatMoney(selectedZoneAnalytics.totalRevenue)}</p>
                    </div>
                  </div>
                </div>
                <div className={`rounded-lg px-3 py-3 ${isDark ? 'bg-black border border-zinc-800' : 'bg-gray-50 border border-gray-200'}`}>
                  <div className="flex items-center gap-2 mb-2">
                    <AlertTriangle className="w-4 h-4 text-amber-500" />
                    <p className="font-medium">{t('deliveryZones.mapSignals', 'Map Signals')}</p>
                  </div>
                  <p className={`text-sm ${isDark ? 'text-zinc-400' : 'text-gray-600'}`}>
                    {analytics?.hotspotCount || 0} {t('deliveryZones.hotspotsDetected', 'hotspots detected')} • {analytics?.outOfZoneAttempts || 0} {t('deliveryZones.outOfZoneAttempts', 'out-of-zone attempts')}
                  </p>
                </div>
              </div>
            ) : (
              <div className={`rounded-lg px-3 py-4 ${isDark ? 'bg-black border border-zinc-800 text-zinc-400' : 'bg-gray-50 border border-gray-200 text-gray-600'}`}>
                {t('deliveryZones.selectZonePrompt', 'Select a zone to view validation and delivery metrics.')}
              </div>
            )}
          </motion.div>
        </div>
      )}

      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.3 }}
        className={`mt-6 p-4 rounded-xl border ${isDark ? 'bg-zinc-950 border-zinc-800' : 'bg-white border-gray-200'}`}
      >
        <div className="flex items-start gap-3">
          <Info className={`w-5 h-5 mt-0.5 ${isDark ? 'text-zinc-300' : 'text-gray-700'}`} />
          <div>
            <p className={`font-medium ${isDark ? 'text-zinc-100' : 'text-gray-900'}`}>{t('deliveryZones.infoTitle', 'Delivery Zone Analytics')}</p>
            <p className={`text-sm ${isDark ? 'text-zinc-400' : 'text-gray-600'}`}>
              {t('deliveryZones.infoDesc', 'Heat and hotspot metrics come from live delivery validation logs and branch-scoped zone analytics, not mock map points.')}
            </p>
          </div>
        </div>
      </motion.div>
    </div>
  );
};

export default DeliveryZonesPage;
