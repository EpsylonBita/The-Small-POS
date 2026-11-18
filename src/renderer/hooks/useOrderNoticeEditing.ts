import { useLayoutEffect, useRef } from 'react';
import { getBridge } from '../../lib';

/** All windows share native editing leases. Native window destruction clears
 * abandoned leases; background timer throttling must never clear an editor. */
export function useOrderNoticeEditing(orderIds: (string | null | undefined)[]): void {
  const session = useRef(crypto.randomUUID());
  const key = JSON.stringify([...new Set(orderIds.filter((id): id is string => Boolean(id)))]);
  useLayoutEffect(() => {
    const send = async (ids: string[]) => {
      try {
        await getBridge().invoke('order_notice_editing', { session: session.current, orderIds: ids });
      } catch {
        // A bridge that is not ready can throw before returning a promise.
        // This observer must never break mounting/closing an order or sale.
        console.warn('[OrderNotices] Editing observation unavailable');
      }
    };
    void send(JSON.parse(key));
    return () => { void send([]); };
  }, [key]);
}
