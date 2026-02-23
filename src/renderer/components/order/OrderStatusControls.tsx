import React, { useState, useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../../contexts/theme-context';
import { useOrderStore } from '../../hooks/useOrderStore';
import toast from 'react-hot-toast';
import type { Order, OrderStatus } from '../../types/orders';
import { isExternalPlatform, getPlatformName } from '../../utils/plugin-icons';
import { getBridge } from '../../../lib';

interface OrderStatusControlsProps {
  order: Order;
  onStatusChange: (orderId: string, newStatus: OrderStatus) => Promise<void>;
  onDriverAssign: (orderId: string) => void;
  disabled?: boolean;
}

// Helper function to derive stage from progress
function getStageFromProgress(progress: number): string {
  if (progress === 0) return 'started';
  if (progress <= 40) return 'ingredients';
  if (progress <= 80) return 'cooking';
  if (progress < 100) return 'plating';
  return 'completed';
}

export function OrderStatusControls({
  order,
  onStatusChange,
  onDriverAssign,
  disabled = false,
}: OrderStatusControlsProps) {
  const bridge = getBridge();
  const { t } = useTranslation();
  const { theme } = useTheme();
  const { updatePreparationProgress } = useOrderStore();
  const [isLoading, setIsLoading] = useState(false);
  const [isNotifyingPlatform, setIsNotifyingPlatform] = useState(false);
  const [preparationProgress, setPreparationProgress] = useState(order.preparationProgress || 0);
  const debounceTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Check if this is an external platform order
  const orderPlugin = order.plugin || order.order_plugin || order.platform || order.order_platform;
  const externalOrderId = order.external_plugin_order_id || order.external_platform_order_id;
  const isPlatformOrder = orderPlugin && externalOrderId && isExternalPlatform(orderPlugin);

  // Handle notifying platform that order is ready
  const handleNotifyPlatformReady = useCallback(async () => {
    if (!isPlatformOrder || !orderPlugin || !externalOrderId) return;

    setIsNotifyingPlatform(true);
    try {
      await bridge.orders.notifyPlatformReady(order.id);
      const platformName = getPlatformName(orderPlugin);
      toast.success(t('orders.messages.platformNotified', { platform: platformName }));
    } catch (error) {
      toast.error(t('orders.messages.platformNotifyFailed'));
    } finally {
      setIsNotifyingPlatform(false);
    }
  }, [bridge.orders, order.id, isPlatformOrder, orderPlugin, externalOrderId, t]);

  const handleStatusChange = useCallback(
    async (newStatus: OrderStatus) => {
      setIsLoading(true);
      try {
        await onStatusChange(order.id, newStatus);
        const statusKey = newStatus === 'out_for_delivery' ? 'outForDelivery' : newStatus;
        toast.success(t('orders.messages.statusUpdated', { status: t(`orders.status.${statusKey}`) }));
      } catch (error) {
        toast.error(t('orders.messages.statusUpdateFailed'));
      } finally {
        setIsLoading(false);
      }
    },
    [order.id, onStatusChange, t]
  );

  const handleProgressChange = useCallback(
    (newProgress: number) => {
      setPreparationProgress(newProgress);

      // Clear existing timer
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }

      // Debounce the update (500ms)
      debounceTimerRef.current = setTimeout(async () => {
        try {
          const stage = getStageFromProgress(newProgress);
          await updatePreparationProgress(order.id, stage, newProgress);
        } catch (error) {
          console.error('Failed to update preparation progress:', error);
        }
      }, 500);
    },
    [order.id, updatePreparationProgress]
  );

  // Cleanup debounce timer on unmount
  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, []);

  const renderButtons = () => {
    const buttonClass = (color: string) =>
      `px-4 py-2 rounded-lg font-semibold transition ${
        theme === 'dark'
          ? `bg-${color}-900 hover:bg-${color}-800 text-${color}-100`
          : `bg-${color}-500 hover:bg-${color}-600 text-white`
      } disabled:opacity-50 disabled:cursor-not-allowed`;

    const baseButtonClass = `px-4 py-2 rounded-lg font-semibold transition disabled:opacity-50 disabled:cursor-not-allowed`;

    switch (order.status) {
      case 'pending':
        return (
          <div className="flex gap-2">
            <button
              onClick={() => handleStatusChange('confirmed')}
              disabled={disabled || isLoading}
              className={`${baseButtonClass} ${
                theme === 'dark'
                  ? 'bg-green-900 hover:bg-green-800 text-green-100'
                  : 'bg-green-500 hover:bg-green-600 text-white'
              }`}
            >
              {isLoading ? t('orders.actions.processing') : t('orders.actions.approve')}
            </button>
            <button
              onClick={() => handleStatusChange('cancelled')}
              disabled={disabled || isLoading}
              className={`${baseButtonClass} ${
                theme === 'dark'
                  ? 'bg-red-900 hover:bg-red-800 text-red-100'
                  : 'bg-red-500 hover:bg-red-600 text-white'
              }`}
            >
              {t('orders.actions.decline')}
            </button>
            {/* Reactivate button shown when previously cancelled (pending visible for reactivate in cancelled tab) */}
          </div>
        );

      case 'confirmed':
        return (
          <button
            onClick={() => handleStatusChange('preparing')}
            disabled={disabled || isLoading}
            className={`${baseButtonClass} ${
              theme === 'dark'
                ? 'bg-blue-900 hover:bg-blue-800 text-blue-100'
                : 'bg-blue-500 hover:bg-blue-600 text-white'
            }`}
          >
            {isLoading ? t('orders.actions.processing') : t('orders.actions.startPreparing')}
          </button>
        );

      case 'preparing':
        return (
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <input
                type="range"
                min="0"
                max="100"
                value={preparationProgress}
                onChange={(e) => handleProgressChange(Number(e.target.value))}
                className="flex-1"
                disabled={disabled}
              />
              <span className="text-sm font-semibold">{preparationProgress}%</span>
            </div>
            <button
              onClick={() => handleStatusChange('ready')}
              disabled={disabled || isLoading}
              className={`w-full ${baseButtonClass} ${
                theme === 'dark'
                  ? 'bg-green-900 hover:bg-green-800 text-green-100'
                  : 'bg-green-500 hover:bg-green-600 text-white'
              }`}
            >
              {isLoading ? t('orders.actions.processing') : t('orders.actions.markReady')}
            </button>
            {/* Notify Platform Ready button for external platform orders */}
            {isPlatformOrder && (
              <button
                onClick={handleNotifyPlatformReady}
                disabled={disabled || isNotifyingPlatform}
                className={`w-full ${baseButtonClass} ${
                  theme === 'dark'
                    ? 'bg-purple-900 hover:bg-purple-800 text-purple-100'
                    : 'bg-purple-500 hover:bg-purple-600 text-white'
                }`}
              >
                {isNotifyingPlatform
                  ? t('orders.actions.processing')
                  : t('orders.actions.notifyPlatformReady', { platform: getPlatformName(orderPlugin || '') })}
              </button>
            )}
          </div>
        );

      case 'ready':
        if (order.order_type === 'delivery' || order.orderType === 'delivery') {
          return (
            <div className="space-y-2">
              <button
                onClick={() => onDriverAssign(order.id)}
                disabled={disabled}
                className={`w-full ${baseButtonClass} ${
                  theme === 'dark'
                    ? 'bg-blue-900 hover:bg-blue-800 text-blue-100'
                    : 'bg-blue-500 hover:bg-blue-600 text-white'
                }`}
              >
                {t('orders.actions.assignDriver')}
              </button>
              {/* Notify Platform Ready button for external platform delivery orders */}
              {isPlatformOrder && (
                <button
                  onClick={handleNotifyPlatformReady}
                  disabled={disabled || isNotifyingPlatform}
                  className={`w-full ${baseButtonClass} ${
                    theme === 'dark'
                      ? 'bg-purple-900 hover:bg-purple-800 text-purple-100'
                      : 'bg-purple-500 hover:bg-purple-600 text-white'
                  }`}
                >
                  {isNotifyingPlatform
                    ? t('orders.actions.processing')
                    : t('orders.actions.notifyPlatformReady', { platform: getPlatformName(orderPlugin || '') })}
                </button>
              )}
            </div>
          );
        } else {
          return (
            <button
              onClick={() => handleStatusChange('delivered')}
              disabled={disabled || isLoading}
              className={`w-full ${baseButtonClass} ${
                theme === 'dark'
                  ? 'bg-green-900 hover:bg-green-800 text-green-100'
                  : 'bg-green-500 hover:bg-green-600 text-white'
              }`}
            >
              {isLoading ? t('orders.actions.processing') : t('orders.actions.completeOrder')}
            </button>
          );
        }

      case 'out_for_delivery':
        return (
          <button
            onClick={() => handleStatusChange('delivered')}
            disabled={disabled || isLoading}
            className={`w-full ${baseButtonClass} ${
              theme === 'dark'
                ? 'bg-green-900 hover:bg-green-800 text-green-100'
                : 'bg-green-500 hover:bg-green-600 text-white'
            }`}
          >
            {isLoading ? t('orders.actions.processing') : t('orders.actions.markDelivered')}
          </button>
        );

      default:
        // Allow reactivation from cancelled back to pending
        if (order.status === 'cancelled') {
          return (
            <button
              onClick={() => handleStatusChange('pending')}
              disabled={disabled || isLoading}
              className={`${baseButtonClass} ${
                theme === 'dark'
                  ? 'bg-blue-900 hover:bg-blue-800 text-blue-100'
                  : 'bg-blue-500 hover:bg-blue-600 text-white'
              }`}
            >
              {isLoading ? t('orders.actions.processing') : t('orders.actions.reactivate')}
            </button>
          );
        }
        return null;
    }
  };

  return <div className="flex flex-col gap-2">{renderButtons()}</div>;
}

