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
import { useTheme } from '../../../contexts/theme-context';
import { useModules } from '../../../contexts/module-context';
import { useDriveThru } from '../../../hooks/useDriveThru';
import { Car, Clock, CheckCircle, AlertCircle, Volume2, VolumeX, RefreshCw } from 'lucide-react';
import type { DriveThruOrder, DriveThruOrderStatus } from '../../../services/DriveThruService';
import { offEvent, onEvent } from '../../../../lib';
import {
  getCachedTerminalCredentials,
  refreshTerminalCredentialCache,
} from '../../../services/terminal-credentials';

const STAGES: DriveThruOrderStatus[] = ['waiting', 'preparing', 'ready', 'served'];

const stageConfig: Record<DriveThruOrderStatus, { icon: typeof Car; label: string; color: string }> = {
  waiting: { icon: Car, label: 'Order Placed', color: 'blue' },
  preparing: { icon: Clock, label: 'Preparing', color: 'yellow' },
  ready: { icon: CheckCircle, label: 'Ready', color: 'green' },
  served: { icon: CheckCircle, label: 'Picked Up', color: 'gray' },
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
      <div className={`h-full flex items-center justify-center ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
        Please select a branch to view drive-through
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col p-4">
      {/* Header Stats */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex gap-6">
          <div className={`px-4 py-2 rounded-xl ${isDark ? 'bg-gray-800' : 'bg-white shadow-sm'}`}>
            <div className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>Active Orders</div>
            <div className={`text-2xl font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>
              {stats.ordersInQueue}
            </div>
          </div>
          <div className={`px-4 py-2 rounded-xl ${isDark ? 'bg-gray-800' : 'bg-white shadow-sm'}`}>
            <div className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>Avg Wait Time</div>
            <div className={`text-2xl font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>
              {Math.round(stats.averageWaitTimeSeconds / 60)} min
            </div>
          </div>
          <div className={`px-4 py-2 rounded-xl ${isDark ? 'bg-gray-800' : 'bg-white shadow-sm'}`}>
            <div className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>Active Lanes</div>
            <div className={`text-2xl font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>
              {stats.activeLanes}/{stats.totalLanes}
            </div>
          </div>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => refetch()}
            className={`p-3 rounded-xl transition-all ${
              isDark ? 'bg-gray-800 hover:bg-gray-700' : 'bg-white hover:bg-gray-50 shadow-sm'
            }`}
          >
            <RefreshCw className={`w-5 h-5 ${isLoading ? 'animate-spin' : ''}`} />
          </button>
          <button
            onClick={() => setSoundEnabled(!soundEnabled)}
            className={`p-3 rounded-xl transition-all ${
              isDark ? 'bg-gray-800 hover:bg-gray-700' : 'bg-white hover:bg-gray-50 shadow-sm'
            }`}
            title={soundEnabled ? 'Mute notifications' : 'Enable notifications'}
          >
            {soundEnabled ? (
              <Volume2 className="w-5 h-5 text-green-500" />
            ) : (
              <VolumeX className={`w-5 h-5 ${isDark ? 'text-gray-500' : 'text-gray-400'}`} />
            )}
          </button>
        </div>
      </div>

      {/* Loading State */}
      {isLoading && orders.length === 0 && (
        <div className={`flex-1 flex items-center justify-center ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
          <RefreshCw className="w-6 h-6 animate-spin mr-2" />
          Loading drive-through data...
        </div>
      )}

      {/* Stage Columns */}
      {!isLoading && (
        <div className="flex-1 grid grid-cols-4 gap-4 overflow-hidden">
          {STAGES.filter(s => s !== 'served').map(stage => {
            const config = stageConfig[stage];
            const Icon = config.icon;
            const stageOrders = getOrdersByStatus(stage);

            return (
              <div key={stage} className="flex flex-col min-h-0">
                {/* Stage Header */}
                <div className={`flex items-center gap-2 mb-3 px-3 py-2 rounded-xl ${
                  isDark ? 'bg-gray-800' : 'bg-white shadow-sm'
                }`}>
                  <Icon className={`w-5 h-5 text-${config.color}-500`} />
                  <span className={`font-medium ${isDark ? 'text-white' : 'text-gray-900'}`}>
                    {config.label}
                  </span>
                  <span className={`ml-auto px-2 py-0.5 rounded-full text-sm ${
                    isDark ? 'bg-gray-700 text-gray-300' : 'bg-gray-100 text-gray-600'
                  }`}>
                    {stageOrders.length}
                  </span>
                </div>

                {/* Orders List */}
                <div className="flex-1 overflow-y-auto space-y-2">
                  {stageOrders.map(order => (
                    <div
                      key={order.id}
                      className={`p-3 rounded-xl transition-all ${
                        isDark
                          ? 'bg-gray-800 border border-gray-700 hover:border-gray-600'
                          : 'bg-white border border-gray-200 shadow-sm hover:shadow-md'
                      }`}
                    >
                      <div className="flex items-center justify-between mb-2">
                        <span className={`font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>
                          {order.orderNumber}
                        </span>
                        <span className={`px-2 py-1 rounded-lg text-xs font-medium ${getTimerColorClass(order.arrivedAt)}`}>
                          {getElapsedTime(order.arrivedAt)}
                        </span>
                      </div>
                      <div className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                        {order.customerName || 'Customer'}
                      </div>
                      <div className={`text-sm ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
                        {order.itemsCount} {order.itemsCount === 1 ? 'item' : 'items'}
                      </div>
                      
                      {/* Action Buttons */}
                      <div className="flex gap-2 mt-3">
                        {stage !== 'waiting' && (
                          <button
                            onClick={() => handleMovePrev(order)}
                            className={`flex-1 py-1.5 text-xs rounded-lg ${
                              isDark
                                ? 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                                : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                            }`}
                          >
                            ← Back
                          </button>
                        )}
                        <button
                          onClick={() => handleMoveNext(order)}
                          className="flex-1 py-1.5 text-xs rounded-lg bg-blue-600 text-white hover:bg-blue-700"
                        >
                          {stage === 'ready' ? 'Complete' : 'Next →'}
                        </button>
                      </div>
                    </div>
                  ))}

                  {stageOrders.length === 0 && (
                    <div className={`text-center py-8 ${isDark ? 'text-gray-600' : 'text-gray-400'}`}>
                      No orders
                    </div>
                  )}
                </div>
              </div>
            );
          })}

          {/* Completed Column */}
          <div className="flex flex-col min-h-0">
            <div className={`flex items-center gap-2 mb-3 px-3 py-2 rounded-xl ${
              isDark ? 'bg-gray-800' : 'bg-white shadow-sm'
            }`}>
              <CheckCircle className="w-5 h-5 text-gray-500" />
              <span className={`font-medium ${isDark ? 'text-white' : 'text-gray-900'}`}>
                Picked Up
              </span>
              <span className={`ml-auto px-2 py-0.5 rounded-full text-sm ${
                isDark ? 'bg-gray-700 text-gray-300' : 'bg-gray-100 text-gray-600'
              }`}>
                {stats.ordersServedToday}
              </span>
            </div>
            <div className={`flex-1 flex items-center justify-center ${isDark ? 'text-gray-600' : 'text-gray-400'}`}>
              <div className="text-center">
                <CheckCircle className="w-12 h-12 mx-auto mb-2 opacity-50" />
                <p className="text-sm">{stats.ordersServedToday} orders served today</p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Empty State */}
      {!isLoading && orders.length === 0 && (
        <div className={`flex-1 flex items-center justify-center ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
          <div className="text-center">
            <Car className="w-16 h-16 mx-auto mb-4 opacity-50" />
            <p className="text-lg font-medium mb-2">No active orders</p>
            <p className="text-sm">Orders will appear here when customers arrive</p>
          </div>
        </div>
      )}
    </div>
  );
});

DriveThruView.displayName = 'DriveThruView';
export default DriveThruView;
