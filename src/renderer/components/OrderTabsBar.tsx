import React, { useMemo, useCallback } from 'react';
import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../contexts/theme-context';

export type TabId = 'orders' | 'delivered' | 'canceled' | 'tables' | 'rooms' | 'services';

interface TabConfig {
  id: TabId;
  label: string;
  count: number;
}

interface OrderTabsBarProps {
  activeTab: TabId;
  onTabChange: (tab: TabId) => void;
  orderCounts: {
    orders: number;
    delivered: number;
    canceled: number;
    tables?: number;
    rooms?: number;
    services?: number;
  };
  /** Whether to show the Tables tab (requires Tables module) */
  showTablesTab?: boolean;
  /** Whether to show the Rooms hub tab (requires Rooms module) */
  showRoomsTab?: boolean;
  /** Whether to show the Services hub tab (requires Appointments/Service Catalog module) */
  showServicesTab?: boolean;
}

// Founder 31/10 («ναι πάμε»): the selected tab is the kit selection -- yellow with dark words -- like
// every other choice on the POS; the per-tab green/orange/blue/purple/teal/red identity is gone.
// Inactive labels stay quiet grey (a dark-safe zinc in dark).
const tabTextClass = (isActive: boolean, isDark: boolean): string => {
  if (isActive) return 'text-(--pos-s-sel-fg)';
  return isDark ? 'text-zinc-400' : 'text-gray-600';
};

const OrderTabsBar: React.FC<OrderTabsBarProps> = React.memo(
  ({
    activeTab,
    onTabChange,
    orderCounts,
    showTablesTab = false,
    showRoomsTab = false,
    showServicesTab = false,
  }) => {
    const { t } = useTranslation();
    const { resolvedTheme } = useTheme();

    const tabs = useMemo(() => {
      const allTabs: TabConfig[] = [
        {
          id: 'orders',
          label: t('dashboard.tabs.orders', 'Orders'),
          count: orderCounts.orders,
        },
      ];

      // Completion history covers every order type, regardless of acquired modules.
      allTabs.push({
        id: 'delivered',
        label: t('dashboard.tabs.delivered', 'Delivered'),
        count: orderCounts.delivered,
      });

      // Add Tables tab only if Tables module is acquired
      if (showTablesTab) {
        allTabs.push({
          id: 'tables',
          label: t('dashboard.tabs.tables', 'Tables'),
          count: orderCounts.tables || 0,
        });
      }

      // Add Rooms hub tab only if Rooms module is acquired (Round 236 IA migration)
      if (showRoomsTab) {
        allTabs.push({
          id: 'rooms',
          label: t('dashboard.tabs.rooms', 'Rooms'),
          count: orderCounts.rooms || 0,
        });
      }

      // Add Services hub tab only if Appointments/Service Catalog module is acquired
      if (showServicesTab) {
        allTabs.push({
          id: 'services',
          label: t('dashboard.tabs.services', 'Services'),
          count: orderCounts.services || 0,
        });
      }

      // Canceled tab is always shown
      allTabs.push({
        id: 'canceled',
        label: t('dashboard.tabs.canceled', 'Canceled'),
        count: orderCounts.canceled,
      });

      return allTabs;
    }, [orderCounts, showTablesTab, showRoomsTab, showServicesTab, t]);

    const handleTabChange = useCallback(
      (tabId: string) => {
        onTabChange(tabId as TabId);
      },
      [onTabChange]
    );

    return (
      // layoutScroll: the strip scrolls sideways, so the sliding indicator measures from it.
      <motion.div
        layoutScroll
        role="tablist"
        aria-label={t('dashboard.tabs.tablistLabel', 'Order status tabs')}
        className={`flex backdrop-blur-sm rounded-xl p-1.5 sm:p-2 border overflow-x-auto scrollbar-hide touch-pan-x ${
          resolvedTheme === 'light'
            ? 'bg-[#fbf4e9] border-(--pos-s-border) shadow-xs'
            : 'bg-white/10 border-white/20'
        }`}
        style={{ WebkitOverflowScrolling: 'touch' }}
      >
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={activeTab === tab.id}
            aria-label={
              activeTab === tab.id
                ? t('dashboard.tabs.selectedTab', {
                    label: tab.label,
                    value: tab.count,
                    defaultValue: '{{label}} {{value}} — Selected',
                  })
                : t('dashboard.tabs.tab', {
                    label: tab.label,
                    value: tab.count,
                    defaultValue: '{{label}} {{value}}',
                  })
            }
            onClick={() => handleTabChange(tab.id)}
            className={`flex-1 min-w-[90px] px-3 sm:px-4 py-2.5 sm:py-3 rounded-lg font-medium transition-all duration-200 relative touch-feedback active:scale-95 ${
              activeTab === tab.id
                ? ''
                : resolvedTheme === 'light'
                  ? 'active:bg-[#fff7e8]'
                  : 'active:bg-white/20'
            }`}
          >
            {/* The selected background slides to the newly selected tab (180 ms ease-out).
                Visual only: the tab changes on the same press; "reduce motion" makes it jump. */}
            {activeTab === tab.id && (
              <motion.span
                layoutId="order-tabs-indicator"
                aria-hidden="true"
                transition={{ duration: 0.18, ease: [0.2, 0.8, 0.2, 1] }}
                className="absolute inset-0 rounded-lg bg-(--pos-s-sel-bg)"
              />
            )}
            <div className="relative flex items-center justify-center gap-1.5 sm:gap-2">
              <span
                className={`text-sm sm:text-lg font-bold transition-all duration-200 ${tabTextClass(activeTab === tab.id, resolvedTheme === 'dark')}`}
              >
                {tab.label}
              </span>

              {/* A count only when there is something to count: «Τραπέζια 0» read as "no tables". */}
              {tab.count > 0 && (
                <span
                  className={`min-w-[20px] rounded-full px-1.5 text-center text-[10px] sm:text-xs font-bold transition-all duration-200 ${tabTextClass(activeTab === tab.id, resolvedTheme === 'dark')} ${
                    activeTab === tab.id ? 'bg-black/12' : resolvedTheme === 'dark' ? 'bg-white/10' : 'bg-black/[0.06]'
                  }`}
                >
                  {tab.count}
                </span>
              )}
            </div>
          </button>
        ))}
      </motion.div>
    );
  }
);

export default OrderTabsBar;
