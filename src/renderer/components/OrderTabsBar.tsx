import React, { useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../contexts/theme-context';

export type TabId = 'orders' | 'delivered' | 'canceled' | 'tables' | 'rooms' | 'services';

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
    rooms?: number;
    services?: number;
  };
  /** Whether to show the Delivered tab (requires Delivery module) */
  showDeliveredTab?: boolean;
  /** Whether to show the Tables tab (requires Tables module) */
  showTablesTab?: boolean;
  /** Whether to show the Rooms hub tab (requires Rooms module) */
  showRoomsTab?: boolean;
  /** Whether to show the Services hub tab (requires Appointments/Service Catalog module) */
  showServicesTab?: boolean;
}

// EXCEPTION to the white/black/grey/yellow palette: ONLY the active/selected order tab
// shows its own neon color (orders green, delivered orange, tables blue, canceled red)
// with a matching glow. Inactive tabs stay neutral grey — gray-600 in light, a dark-safe
// zinc/grey (zinc-400) in dark. Arbitrary hex for orange/blue so the global Tailwind
// palette remap can't neutralize the active neon; green/red stay semantic classes.
const TAB_ACTIVE_TEXT: Record<string, string> = {
  green: 'text-green-500',
  orange: 'text-[#f97316]',
  blue: 'text-[#3b82f6]',
  red: 'text-red-500',
  // Hub tabs (Round 236): rooms purple (matches the reserved-room accent), services teal.
  purple: 'text-[#a855f7]',
  teal: 'text-[#14b8a6]',
};
const TAB_GLOW: Record<string, string> = {
  green: 'drop-shadow-[0_0_8px_rgba(34,197,94,0.8)]',
  orange: 'drop-shadow-[0_0_8px_rgba(249,115,22,0.8)]',
  blue: 'drop-shadow-[0_0_8px_rgba(59,130,246,0.8)]',
  red: 'drop-shadow-[0_0_8px_rgba(239,68,68,0.8)]',
  purple: 'drop-shadow-[0_0_8px_rgba(168,85,247,0.8)]',
  teal: 'drop-shadow-[0_0_8px_rgba(20,184,166,0.8)]',
};
const tabTextClass = (color: string, isActive: boolean, isDark: boolean, withGlow: boolean): string => {
  if (!isActive) {
    // Inactive tab labels/counters are quiet grey in both themes (a dark-safe zinc in dark, not
    // white); only the active tab gets its neon color/glow below.
    return isDark ? 'text-zinc-400' : 'text-gray-600';
  }
  const base = TAB_ACTIVE_TEXT[color] ?? TAB_ACTIVE_TEXT.red;
  return withGlow ? `${base} ${TAB_GLOW[color] ?? TAB_GLOW.red}` : base;
};

const OrderTabsBar: React.FC<OrderTabsBarProps> = React.memo(
  ({
    activeTab,
    onTabChange,
    orderCounts,
    showDeliveredTab = true,
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
          color: 'green', // EXCEPTION: order tabs keep distinct neon identity
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

      // Add Rooms hub tab only if Rooms module is acquired (Round 236 IA migration)
      if (showRoomsTab) {
        allTabs.push({
          id: 'rooms',
          label: t('dashboard.tabs.rooms', 'Rooms'),
          count: orderCounts.rooms || 0,
          color: 'purple',
        });
      }

      // Add Services hub tab only if Appointments/Service Catalog module is acquired
      if (showServicesTab) {
        allTabs.push({
          id: 'services',
          label: t('dashboard.tabs.services', 'Services'),
          count: orderCounts.services || 0,
          color: 'teal',
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
    }, [orderCounts, showDeliveredTab, showTablesTab, showRoomsTab, showServicesTab, t]);

    const handleTabChange = useCallback(
      (tabId: string) => {
        onTabChange(tabId as TabId);
      },
      [onTabChange]
    );

    return (
      <div
        role="tablist"
        aria-label={t('dashboard.tabs.tablistLabel', 'Order status tabs')}
        className={`flex backdrop-blur-sm rounded-xl p-1.5 sm:p-2 border overflow-x-auto scrollbar-hide touch-pan-x ${
          resolvedTheme === 'light'
            ? 'bg-[#fbf4e9]/90 border-amber-200/60 shadow-sm'
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
                ? resolvedTheme === 'light'
                  ? 'bg-[#fffdf8]/95 backdrop-blur-sm shadow-sm border border-amber-100/80'
                  : 'bg-white/20 shadow-lg'
                : resolvedTheme === 'light'
                  ? 'active:bg-[#fff7e8]/90'
                  : 'active:bg-white/20'
            }`}
          >
            <div className="flex items-center justify-center gap-1.5 sm:gap-2">
              <span
                className={`text-sm sm:text-lg font-bold transition-all duration-200 ${tabTextClass(tab.color, activeTab === tab.id, resolvedTheme === 'dark', true)}`}
              >
                {tab.label}
              </span>

              {/* Tab counter — same color as its tab label */}
              <span
                className={`text-[10px] sm:text-xs font-bold transition-all duration-200 ${tabTextClass(tab.color, activeTab === tab.id, resolvedTheme === 'dark', false)}`}
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
