import { useEffect, useSyncExternalStore } from 'react';
import { getBridge } from '../../lib';
import type { OrderSyncNotice } from '../../lib/order-sync-notices';

export interface NoticeSnapshot { notices: OrderSyncNotice[]; status: 'loading' | 'fresh' | 'stale' | 'unavailable' }
const empty: NoticeSnapshot = { notices: [], status: 'loading' };
let snapshot = empty;
let generation = 0;
let allStatus: NoticeSnapshot['status'] = 'loading';
const orderStatus = new Map<string, NoticeSnapshot['status']>();
let reading: Promise<void> = Promise.resolve();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const publish = (next: NoticeSnapshot) => { snapshot = next; listeners.forEach(listener => listener()); };
export const readOrderNoticeSnapshot = () => snapshot;
export const readOrderNoticeStatus = (orderId: string) => orderStatus.get(orderId) ?? allStatus;

/** A failed read retains the last evidence. Partial order reads never erase
 * another page's notices. A newer read wins over an older in-flight response. */
export async function refreshOrderNotices(orderIds?: string[]): Promise<void> {
  // Serialize small indexed reads so a card read cannot cancel the global
  // parking notification read (or mark another order's stale data fresh).
  const next = reading.then(() => read(orderIds));
  reading = next.catch(() => {});
  return next;
}
async function read(orderIds?: string[]): Promise<void> {
  const current = ++generation;
  try {
    const notices = await getBridge().invoke('order_sync_notices', { orderIds: orderIds ?? null }) as OrderSyncNotice[];
    if (!Array.isArray(notices)) { throw new Error('Notices unavailable'); }
    if (current !== generation) { return; }
    if (orderIds) { orderIds.forEach(id => orderStatus.set(id, 'fresh')); }
    else { allStatus = 'fresh'; orderStatus.clear(); }
    publish({ notices: orderIds ? [...snapshot.notices.filter(notice => !orderIds.includes(notice.orderId)), ...notices] : notices, status: 'fresh' });
  } catch {
    if (current === generation) {
      const status = snapshot.status === 'loading' || snapshot.status === 'unavailable' ? 'unavailable' : 'stale';
      if (orderIds) { orderIds.forEach(id => orderStatus.set(id, status)); }
      else { allStatus = status; orderStatus.clear(); }
      publish({ ...snapshot, status });
    }
  }
}
export function useOrderNotices(orderIds?: string[], refresh = true): NoticeSnapshot {
  const value = useSyncExternalStore(subscribe, readOrderNoticeSnapshot, () => empty);
  const key = JSON.stringify(orderIds);
  useEffect(() => { if (refresh) { void refreshOrderNotices(orderIds); } }, [key, refresh]);
  // The global shift list contains these orders too. A failed partial read
  // cannot leave that list claiming its evidence is fully refreshed.
  const states = orderIds ? orderIds.map(readOrderNoticeStatus) : [allStatus, ...orderStatus.values()];
  const status = (['unavailable', 'stale', 'loading', 'fresh'] as const).find(status => states.includes(status)) ?? 'fresh';
  return { ...value, status, notices: orderIds ? value.notices.filter(notice => orderIds.includes(notice.orderId)) : value.notices };
}
export function openOrderNotice(orderId: string): void {
  window.dispatchEvent(new CustomEvent('pos:open-order-notice', { detail: { orderId } }));
}
/** One announcement for each order's newly parked row(s), including a second
 * refusal of a replacement. Pending verification never produces a toast. */
export function newlyParkedOrders(notices: OrderSyncNotice[], seen: Set<string>): OrderSyncNotice[] {
  const orders = new Map<string, OrderSyncNotice>();
  for (const notice of notices) {
    const key = `${notice.orderId}:${notice.queueId}:${notice.since}`;
    if (notice.state === 'refused' && !seen.has(key)) { seen.add(key); orders.set(notice.orderId, notice); }
  }
  return [...orders.values()];
}
