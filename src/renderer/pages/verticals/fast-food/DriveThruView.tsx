/**
 * DriveThruView - POS Drive-Through Lane Management
 * 
 * Real-time drive-through order queue management for fast-food POS.
 * Supports lane status display and order queue management.
 * 
 * Task 17.3: Create POS drive-through interface
 */

import React, { memo, useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { motion } from 'framer-motion';
import { useTheme } from '../../../contexts/theme-context';
import { useModules } from '../../../contexts/module-context';
import { useDriveThru } from '../../../hooks/useDriveThru';
import {
  Car,
  CheckCircle,
  ChevronLeft,
  ChevronRight,
  Clock,
  RefreshCw,
  Volume2,
  VolumeX,
} from 'lucide-react';
import type { DriveThruOrder, DriveThruOrderStatus } from '../../../services/DriveThruService';
import { offEvent, onEvent } from '../../../../lib';
import {
  getCachedTerminalCredentials,
  refreshTerminalCredentialCache,
} from '../../../services/terminal-credentials';
import { pageMotionContainer, pageMotionItem } from '../../../components/ui/page-motion';

const STAGES: DriveThruOrderStatus[] = ['waiting', 'preparing', 'ready', 'served'];

const stageConfig: Record<DriveThruOrderStatus, { icon: typeof Car; label: string; iconClass: string }> = {
  waiting: { icon: Car, label: 'Order Placed', iconClass: 'text-amber-500' },
  preparing: { icon: Clock, label: 'Preparing', iconClass: 'text-yellow-500' },
  ready: { icon: CheckCircle, label: 'Ready', iconClass: 'text-green-500' },
  served: { icon: CheckCircle, label: 'Picked Up', iconClass: 'text-gray-500' },
};

export const DriveThruView: React.FC = memo(() => {
  const { t } = useTranslation();
  const { resolvedTheme } = useTheme();
  const { organizationId } = useModules();
  
  const [branchId, setBranchId] = useState<string | null>(null);
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [, setTick] = useState(0);
  
  useEffect(() => {
    let disposed = false;

    const hydrateTerminalIdentity = async () => {
      const cached = getCachedTerminalCredentials();
      if (!disposed) {
        setBranchId(cached.branchId || null);
      }

      const refreshed = await refreshTerminalCredentialCache();
      if (!disposed) {
        setBranchId(refreshed.branchId || null);
      }
    };

    const handleConfigUpdate = (data: { branch_id?: string }) => {
      if (disposed) return;
      if (typeof data?.branch_id === 'string' && data.branch_id.trim()) {
        setBranchId(data.branch_id.trim());
      }
    };

    hydrateTerminalIdentity();
    onEvent('terminal-config-updated', handleConfigUpdate);

    return () => {
      disposed = true;
      offEvent('terminal-config-updated', handleConfigUpdate);
    };
  }, []);

  // Update timer on second boundaries without interval polling
  useEffect(() => {
    let disposed = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    const scheduleTick = () => {
      const msUntilNextSecond = Math.max(50, 1000 - (Date.now() % 1000));
      timeoutId = setTimeout(() => {
        if (disposed) return;
        setTick(t => t + 1);
        scheduleTick();
      }, msUntilNextSecond);
    };

    scheduleTick();

    return () => {
      disposed = true;
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    };
  }, []);

  const isDark = resolvedTheme === 'dark';
  const panelSurface = isDark
    ? 'border border-white/10 bg-zinc-900/78 text-zinc-100 shadow-[0_18px_45px_rgba(0,0,0,0.28)]'
    : 'border border-yellow-300/45 bg-white/78 text-zinc-950 shadow-[0_18px_45px_rgba(24,24,27,0.08)]';
  const subtleSurface = isDark
    ? 'border border-white/10 bg-white/[0.06]'
    : 'border border-zinc-200 bg-white/80 shadow-sm';
  const secondaryButtonSurface = isDark
    ? 'border border-white/10 bg-white/[0.08] text-zinc-200 active:bg-white/[0.12]'
    : 'border border-zinc-200 bg-zinc-100 text-zinc-700 active:bg-zinc-200';
  const primaryButtonSurface = isDark
    ? 'border border-yellow-400/45 bg-yellow-400/18 text-yellow-100 active:bg-yellow-400/26'
    : 'border border-yellow-500/50 bg-yellow-300 text-zinc-950 active:bg-yellow-400';

  const {
    orders,
    stats,
    isLoading,
    refetch,
    moveToNextStage,
    moveToPrevStage,
    getOrdersByStatus,
    getElapsedTime,
    getTimerColor,
  } = useDriveThru({
    branchId: branchId || '',
    organizationId: organizationId || '',
    enableRealtime: true,
  });

  const handleMoveNext = async (order: DriveThruOrder) => {
    await moveToNextStage(order.id, order.status);
  };

  const handleMovePrev = async (order: DriveThruOrder) => {
    await moveToPrevStage(order.id, order.status);
  };

  const getTimerColorClass = (arrivedAt: string): string => {
    const color = getTimerColor(arrivedAt);
    if (color === 'green') return 'text-green-500 bg-green-500/10';
    if (color === 'yellow') return 'text-yellow-500 bg-yellow-500/10';
    return 'text-red-500 bg-red-500/10';
  };

  if (!branchId || !organizationId) {
    return (
      <motion.div initial="hidden" animate="show" variants={pageMotionContainer} className={`h-full flex items-center justify-center ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
        {t('driveThru.selectBranch', 'Please select a branch to view drive-through')}
      </motion.div>
    );
  }

  return (
    <motion.div initial="hidden" animate="show" variants={pageMotionContainer} className="h-full flex flex-col p-4">
      {/* Header Stats */}
      <motion.div variants={pageMotionItem} className="flex items-center justify-between mb-6">
        <motion.div variants={pageMotionContainer} className="flex gap-6">
          <motion.div variants={pageMotionItem} className={`rounded-2xl px-4 py-2 ${panelSurface}`}>
            <div className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>{t('driveThru.activeOrders', 'Active Orders')}</div>
            <div className={`text-2xl font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>
              {stats.ordersInQueue}
            </div>
          </motion.div>
          <motion.div variants={pageMotionItem} className={`rounded-2xl px-4 py-2 ${panelSurface}`}>
            <div className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>{t('driveThru.avgWaitTime', 'Avg Wait Time')}</div>
            <div className={`text-2xl font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>
              {Math.round(stats.averageWaitTimeSeconds / 60)} {t('common.time.min', 'min')}
            </div>
          </motion.div>
          <motion.div variants={pageMotionItem} className={`rounded-2xl px-4 py-2 ${panelSurface}`}>
            <div className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>{t('driveThru.activeLanes', 'Active Lanes')}</div>
            <div className={`text-2xl font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>
              {stats.activeLanes}/{stats.totalLanes}
            </div>
          </motion.div>
        </motion.div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => refetch()}
            aria-label={t('common.actions.refresh', 'Refresh')}
            className={`rounded-2xl p-3 transition-transform active:scale-95 ${secondaryButtonSurface}`}
          >
            <RefreshCw className={`w-5 h-5 ${isLoading ? 'animate-spin' : ''}`} />
          </button>
          <button
            type="button"
            onClick={() => setSoundEnabled(!soundEnabled)}
            className={`rounded-2xl p-3 transition-transform active:scale-95 ${secondaryButtonSurface}`}
            aria-label={
              soundEnabled
                ? t('driveThru.muteNotifications', 'Mute notifications')
                : t('driveThru.enableNotifications', 'Enable notifications')
            }
          >
            {soundEnabled ? (
              <Volume2 className="w-5 h-5 text-green-500" />
            ) : (
              <VolumeX className={`w-5 h-5 ${isDark ? 'text-gray-500' : 'text-gray-400'}`} />
            )}
          </button>
        </div>
      </motion.div>

      {/* Loading State */}
      {isLoading && orders.length === 0 && (
        <motion.div variants={pageMotionItem} className={`flex-1 flex items-center justify-center ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
          <RefreshCw className="w-6 h-6 animate-spin mr-2" />
          {t('driveThru.loading', 'Loading drive-through data...')}
        </motion.div>
      )}

      {/* Stage Columns */}
      {!isLoading && (
        <motion.div variants={pageMotionContainer} className="flex-1 grid grid-cols-4 gap-4 overflow-hidden">
          {STAGES.filter(s => s !== 'served').map(stage => {
            const config = stageConfig[stage];
            const Icon = config.icon;
            const stageOrders = getOrdersByStatus(stage);

            return (
              <motion.div key={stage} variants={pageMotionItem} className="flex flex-col min-h-0">
                {/* Stage Header */}
                <div className={`flex items-center gap-2 mb-3 rounded-2xl px-3 py-2 ${panelSurface}`}>
                  <Icon className={`w-5 h-5 ${config.iconClass}`} />
                  <span className={`font-medium ${isDark ? 'text-white' : 'text-gray-900'}`}>
                    {t(`driveThru.stage.${stage}`, config.label)}
                  </span>
                  <span className={`ml-auto rounded-full px-2 py-0.5 text-sm ${
                    isDark ? 'bg-gray-700 text-gray-300' : 'bg-gray-100 text-gray-600'
                  }`}>
                    {stageOrders.length}
                  </span>
                </div>

                {/* Orders List */}
                <motion.div variants={pageMotionContainer} className="flex-1 overflow-y-auto scrollbar-hide space-y-2">
                  {stageOrders.map(order => (
                    <motion.div
                      variants={pageMotionItem}
                      key={order.id}
                      className={`rounded-2xl p-3 transition-transform active:scale-[0.99] ${subtleSurface}`}
                    >
                      <div className="flex items-center justify-between mb-2">
                        <span className={`font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>
                          {order.orderNumber}
                        </span>
                        <span className={`rounded-full px-2 py-1 text-xs font-medium ${getTimerColorClass(order.arrivedAt)}`}>
                          {getElapsedTime(order.arrivedAt)}
                        </span>
                      </div>
                      <div className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                        {order.customerName || t('common.customer', 'Customer')}
                      </div>
                      <div className={`text-sm ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
                        {order.itemsCount}{' '}
                        {order.itemsCount === 1
                          ? t('common.item', 'item')
                          : t('common.items', 'items')}
                      </div>
                      
                      {/* Action Buttons */}
                      <div className="flex gap-2 mt-3">
                        {stage !== 'waiting' && (
                          <button
                            type="button"
                            onClick={() => handleMovePrev(order)}
                            className={`flex flex-1 items-center justify-center gap-1 rounded-2xl py-1.5 text-xs font-semibold transition-transform active:scale-95 ${secondaryButtonSurface}`}
                          >
                            <ChevronLeft className="h-3.5 w-3.5" />
                            {t('common.actions.back', 'Back')}
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => handleMoveNext(order)}
                          className={`flex flex-1 items-center justify-center gap-1 rounded-2xl py-1.5 text-xs font-semibold transition-transform active:scale-95 ${primaryButtonSurface}`}
                        >
                          {stage === 'ready' ? t('common.actions.complete', 'Complete') : t('common.actions.next', 'Next')}
                          {stage !== 'ready' && <ChevronRight className="h-3.5 w-3.5" />}
                        </button>
                      </div>
                    </motion.div>
                  ))}

                  {stageOrders.length === 0 && (
                    <motion.div variants={pageMotionItem} className={`text-center py-8 ${isDark ? 'text-gray-600' : 'text-gray-400'}`}>
                      {t('driveThru.noOrders', 'No orders')}
                    </motion.div>
                  )}
                </motion.div>
              </motion.div>
            );
          })}

          {/* Completed Column */}
          <motion.div variants={pageMotionItem} className="flex flex-col min-h-0">
            <div className={`flex items-center gap-2 mb-3 rounded-2xl px-3 py-2 ${panelSurface}`}>
              <CheckCircle className="w-5 h-5 text-gray-500" />
              <span className={`font-medium ${isDark ? 'text-white' : 'text-gray-900'}`}>
                {t('driveThru.stage.served', 'Picked Up')}
              </span>
              <span className={`ml-auto rounded-full px-2 py-0.5 text-sm ${
                isDark ? 'bg-gray-700 text-gray-300' : 'bg-gray-100 text-gray-600'
              }`}>
                {stats.ordersServedToday}
              </span>
            </div>
            <div className={`flex-1 flex items-center justify-center ${isDark ? 'text-gray-600' : 'text-gray-400'}`}>
              <div className="text-center">
                <CheckCircle className="w-12 h-12 mx-auto mb-2 opacity-50" />
                <p className="text-sm">
                  {t('driveThru.ordersServedToday', {
                    defaultValue: '{{count}} orders served today',
                    count: stats.ordersServedToday,
                  })}
                </p>
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}

      {/* Empty State */}
      {!isLoading && orders.length === 0 && (
        <motion.div variants={pageMotionItem} className={`flex-1 flex items-center justify-center ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
          <div className="text-center">
            <Car className="w-16 h-16 mx-auto mb-4 opacity-50" />
            <p className="text-lg font-medium mb-2">{t('driveThru.noActiveOrders', 'No active orders')}</p>
            <p className="text-sm">{t('driveThru.emptyHint', 'Orders will appear here when customers arrive')}</p>
          </div>
        </motion.div>
      )}
    </motion.div>
  );
});

DriveThruView.displayName = 'DriveThruView';
export default DriveThruView;
