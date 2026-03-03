import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { useTheme } from '../contexts/theme-context';
import { getBridge, offEvent, onEvent } from '../../lib';

type DisplayStatus = 'preparing' | 'ready';

interface DisplayRow {
  order_id: string;
  order_number?: string | null;
  status: string;
  updated_at?: string | null;
}

const DISPLAY_STATUSES = new Set<DisplayStatus>(['preparing', 'ready']);

function isDisplayStatus(status: string): status is DisplayStatus {
  return DISPLAY_STATUSES.has(status as DisplayStatus);
}

function getOrderIdentifier(order: DisplayRow): string {
  const orderNumber = typeof order.order_number === 'string' ? order.order_number.trim() : '';
  if (orderNumber) return orderNumber;
  return order.order_id.slice(0, 8);
}

function getOrderUpdatedAtMs(order: DisplayRow): number {
  const rawTimestamp = order.updated_at;
  if (!rawTimestamp) return 0;
  const parsed = new Date(rawTimestamp).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

const CustomerDisplayPage: React.FC = () => {
  const bridge = getBridge();
  const { resolvedTheme } = useTheme();
  const [rows, setRows] = useState<DisplayRow[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const isDark = resolvedTheme === 'dark';

  const fetchRows = useCallback(
    async (showLoading = false) => {
      if (showLoading) {
        setIsLoading(true);
      }
      try {
        const result = await bridge.adminApi.fetchFromAdmin('/api/pos/customer-display?limit=200');
        if (result?.success && result?.data?.success && Array.isArray(result.data.rows)) {
          setRows(result.data.rows as DisplayRow[]);
          return;
        }
        throw new Error(result?.data?.error || result?.error || 'Failed to fetch customer display');
      } catch (error) {
        console.error('Customer display fetch failed', error);
        if (showLoading) {
          setRows([]);
        }
      } finally {
        if (showLoading) {
          setIsLoading(false);
        }
      }
    },
    [bridge]
  );

  useEffect(() => {
    void fetchRows(true);
  }, [fetchRows]);

  useEffect(() => {
    let timeout: ReturnType<typeof setTimeout> | null = null;

    const scheduleRefresh = () => {
      if (timeout) return;
      timeout = setTimeout(() => {
        timeout = null;
        void fetchRows(false);
      }, 150);
    };

    onEvent('order-status-updated', scheduleRefresh);
    onEvent('order-created', scheduleRefresh);
    onEvent('order-updated', scheduleRefresh);
    onEvent('sync:complete', scheduleRefresh);

    return () => {
      if (timeout) {
        clearTimeout(timeout);
      }
      offEvent('order-status-updated', scheduleRefresh);
      offEvent('order-created', scheduleRefresh);
      offEvent('order-updated', scheduleRefresh);
      offEvent('sync:complete', scheduleRefresh);
    };
  }, [fetchRows]);

  useEffect(() => {
    const interval = setInterval(() => {
      void fetchRows(false);
    }, 2000);
    return () => clearInterval(interval);
  }, [fetchRows]);

  const displayOrders = useMemo(() => {
    return rows
      .filter((order) => isDisplayStatus(order.status))
      .sort((a, b) => getOrderUpdatedAtMs(b) - getOrderUpdatedAtMs(a));
  }, [rows]);

  const handleRefresh = async () => {
    setIsRefreshing(true);
    try {
      await fetchRows(false);
    } finally {
      setIsRefreshing(false);
    }
  };

  return (
    <div className={`h-full p-6 ${isDark ? 'bg-black text-white' : 'bg-gray-50 text-gray-900'}`}>
      <div className="mx-auto flex h-full max-w-5xl flex-col gap-4 rounded-2xl border border-white/10 bg-white/5 p-6">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold">Customer Display</h1>
          <button
            type="button"
            onClick={() => {
              void handleRefresh();
            }}
            disabled={isRefreshing}
            className={`inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition ${
              isDark
                ? 'bg-white/10 text-white hover:bg-white/20 disabled:opacity-50'
                : 'bg-gray-200 text-gray-900 hover:bg-gray-300 disabled:opacity-60'
            }`}
          >
            <RefreshCw className={`h-4 w-4 ${isRefreshing ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>

        {!isLoading && displayOrders.length === 0 ? (
          <div className="flex flex-1 items-center justify-center rounded-xl border border-dashed border-white/15 px-4 text-center text-lg">
            No preparing or ready orders to show.
          </div>
        ) : isLoading ? (
          <div className="flex flex-1 items-center justify-center rounded-xl border border-dashed border-white/15 px-4 text-center text-lg">
            Loading customer display...
          </div>
        ) : (
          <div className="space-y-3 overflow-auto">
            {displayOrders.map((order) => {
              const statusColor = order.status === 'ready' ? 'text-green-400' : 'text-blue-400';
              const identifier = getOrderIdentifier(order);

              return (
                <div
                  key={order.order_id}
                  className={`rounded-xl border px-4 py-3 text-xl font-semibold ${
                    isDark
                      ? 'border-white/15 bg-white/5'
                      : 'border-gray-200 bg-white'
                  }`}
                >
                  <span>Order ({identifier}) is </span>
                  <span className={statusColor}>{order.status}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};

export default CustomerDisplayPage;
