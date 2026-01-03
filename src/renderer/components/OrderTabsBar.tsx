import React, { useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../contexts/theme-context';

export type TabId = 'orders' | 'delivered' | 'canceled' | 'tables';

interface TabConfig {
  id: TabId;
  label: string;
  count: number;
  color: string;
}

interface OrderTabsBarProps {
  activeTab: TabId;
  onTabChange: (tab: TabId) => void;
  orderCounts: {
    orders: number;
    delivered: number;
    canceled: number;
    tables?: number;
  };
  /** Whether to show the Delivered tab (requires Delivery module) */
  showDeliveredTab?: boolean;
  /** Whether to show the Tables tab (requires Tables module) */
  showTablesTab?: boolean;
}

const OrderTabsBar: React.FC<OrderTabsBarProps> = React.memo(
  ({
    activeTab,
    onTabChange,
    orderCounts,
    showDeliveredTab = true,
    showTablesTab = false,
  }) => {
    const { t } = useTranslation();
    const { resolvedTheme } = useTheme();

    const tabs = useMemo(() => {
      const allTabs: TabConfig[] = [
        {
          id: 'orders',
          label: t('dashboard.tabs.orders', 'Orders'),
          count: orderCounts.orders,
          color: 'green',
        },
      ];

      // Add Delivered tab only if Delivery module is acquired
      if (showDeliveredTab) {
        allTabs.push({
          id: 'delivered',
          label: t('dashboard.tabs.delivered', 'Delivered'),
          count: orderCounts.delivered,
          color: 'orange',
        });
      }

      // Add Tables tab only if Tables module is acquired
      if (showTablesTab) {
        allTabs.push({
          id: 'tables',
          label: t('dashboard.tabs.tables', 'Tables'),
          count: orderCounts.tables || 0,
          color: 'blue',
        });
      }

      // Canceled tab is always shown
      allTabs.push({
        id: 'canceled',
        label: t('dashboard.tabs.canceled', 'Canceled'),
        count: orderCounts.canceled,
        color: 'red',
      });

      return allTabs;
    }, [orderCounts, showDeliveredTab, showTablesTab, t]);

    const handleTabChange = useCallback(
      (tabId: string) => {
        onTabChange(tabId as TabId);
      },
      [onTabChange]
    );

    return (
      <div
        className={`flex backdrop-blur-sm rounded-xl p-1.5 sm:p-2 border overflow-x-auto scrollbar-hide touch-pan-x ${
          resolvedTheme === 'light'
            ? 'bg-gray-100/80 border-gray-200/50 shadow-sm'
            : 'bg-white/10 border-white/20'
        }`}
        style={{ WebkitOverflowScrolling: 'touch' }}
      >
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => handleTabChange(tab.id)}
            className={`flex-1 min-w-[90px] px-3 sm:px-4 py-2.5 sm:py-3 rounded-lg font-medium transition-all duration-200 relative touch-feedback active:scale-95 ${
              activeTab === tab.id
                ? resolvedTheme === 'light'
                  ? 'bg-white backdrop-blur-sm shadow-sm border border-gray-200/30'
                  : 'bg-white/20 shadow-lg'
                : resolvedTheme === 'light'
                  ? 'hover:bg-white/60 active:bg-white/80'
                  : 'hover:bg-white/10 active:bg-white/20'
            }`}
          >
            <div className="flex items-center justify-center gap-1.5 sm:gap-2">
              <span
                className={`text-sm sm:text-lg font-bold transition-all duration-200 ${
                  activeTab === tab.id
                    ? tab.color === 'green'
                      ? 'text-green-500 drop-shadow-[0_0_8px_rgba(34,197,94,0.8)]'
                      : tab.color === 'orange'
                        ? 'text-orange-500 drop-shadow-[0_0_8px_rgba(249,115,22,0.8)]'
                        : tab.color === 'blue'
                          ? 'text-blue-500 drop-shadow-[0_0_8px_rgba(59,130,246,0.8)]'
                          : 'text-red-500 drop-shadow-[0_0_8px_rgba(239,68,68,0.8)]'
                    : resolvedTheme === 'light'
                      ? 'text-gray-600 hover:text-gray-800'
                      : 'text-white/70 hover:text-white'
                }`}
              >
                {tab.label}
              </span>

              {/* Tab counter with same color as text */}
              <span
                className={`text-[10px] sm:text-xs font-bold transition-all duration-200 ${
                  activeTab === tab.id
                    ? tab.color === 'green'
                      ? 'text-green-500'
                      : tab.color === 'orange'
                        ? 'text-orange-500'
                        : tab.color === 'blue'
                          ? 'text-blue-500'
                          : 'text-red-500'
                    : resolvedTheme === 'light'
                      ? 'text-gray-600'
                      : 'text-white/70'
                }`}
              >
                {tab.count}
              </span>
            </div>
          </button>
        ))}
      </div>
    );
  }
);

export default OrderTabsBar;
