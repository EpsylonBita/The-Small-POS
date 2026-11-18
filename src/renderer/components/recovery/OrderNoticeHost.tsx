import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { listenSupportEvent } from '../../services/support/SupportRemedyRunner';
import { newlyParkedOrders, openOrderNotice, refreshOrderNotices, useOrderNotices } from '../../services/OrderSyncNoticeStore';
import OrderDetailsModal from '../modals/OrderDetailsModal';

export function OrderNoticeHost() {
  const { t } = useTranslation();
  const { notices, status } = useOrderNotices();
  const seen = useRef(new Set<string>());
  const [orderId, setOrderId] = useState<string | null>(null);
  useEffect(() => {
    const open = (event: Event) => { const id = (event as CustomEvent<{ orderId: string }>).detail?.orderId; if (id) { setOrderId(id); } };
    window.addEventListener('pos:open-order-notice', open);
    let scheduled: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => { scheduled ??= setTimeout(() => { scheduled = undefined; void refreshOrderNotices(); }, 150); };
    const stop = listenSupportEvent('order_sync_notices_changed', refresh);
    const stopSync = listenSupportEvent('sync_status', refresh);
    const timer = window.setInterval(refresh, 30_000);
    return () => { window.removeEventListener('pos:open-order-notice', open); stop(); stopSync(); window.clearInterval(timer); clearTimeout(scheduled); };
  }, []);
  useEffect(() => {
    if (status !== 'fresh') { return; }
    for (const notice of newlyParkedOrders(notices, seen.current)) {
      toast.custom(item => <button type="button" className="min-h-11 max-w-sm rounded-xl bg-white px-5 py-4 text-left text-zinc-900 shadow-lg dark:bg-zinc-800 dark:text-white focus-visible:outline-2 focus-visible:outline-yellow-400"
        onClick={() => { toast.dismiss(item.id); openOrderNotice(notice.orderId); }}>
        {t('orderSyncNotice.toast', { number: notice.orderNumber, defaultValue: 'Order {{number}} needs attention. Open it.' })}
      </button>, { id: `order-notice:${notice.orderId}:${notice.queueId}:${notice.since}`, duration: 8000 });
    }
  }, [notices, status, t]);
  return orderId ? <OrderDetailsModal isOpen orderId={orderId} onClose={() => setOrderId(null)} /> : null;
}
