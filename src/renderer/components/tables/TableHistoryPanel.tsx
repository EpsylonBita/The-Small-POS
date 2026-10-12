import React, { useEffect, useState } from 'react';
import { useI18n } from '../../contexts/i18n-context';
import { posApiGet } from '../../utils/api-helpers';

type HistoryOrder = { id: string; order_number?: string; created_at: string; status: string; payment_status: string; total_amount: number; currency?: string | null };
export function TableHistoryPanel({ tableId }: { tableId: string }) {
  const { t } = useI18n();
  const [rows, setRows] = useState<HistoryOrder[]>([]);
  const [offset, setOffset] = useState(0);
  const [retry, setRetry] = useState(0);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [more, setMore] = useState(false);
  useEffect(() => { setRows([]); setOffset(0); setMore(false); }, [tableId]);
  useEffect(() => {
    let cancelled = false;
    setLoading(true); setFailed(false);
    posApiGet<{ orders: HistoryOrder[]; has_more: boolean }>(`/api/pos/tables/${encodeURIComponent(tableId)}/history?limit=50&offset=${offset}`)
      .then(result => {
        if (cancelled) return;
        if (!result.success || !Array.isArray(result.data?.orders)) throw new Error('History unavailable');
        setRows(previous => [...new Map([...(offset ? previous : []), ...result.data!.orders].map(row => [row.id, row])).values()]);
        setMore(result.data.has_more === true);
      }).catch(() => { if (!cancelled) setFailed(true); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [tableId, offset, retry]);
  return <section aria-label={t('tables.historyTitle', { table: '', defaultValue: 'Table history' })} aria-busy={loading}>
    <ul className="space-y-3">
      {rows.map(row => <li key={row.id} className="rounded-lg border border-slate-200 p-3 dark:border-slate-700">
        <div className="flex justify-between gap-3"><strong>{row.order_number || row.id.slice(0, 8)}</strong><span>{row.currency ? `${row.currency} ` : ''}{Number(row.total_amount).toFixed(2)}</span></div>
        <div>{new Date(row.created_at).toLocaleString()}</div>
        <div>{t(`orders.status.${row.status === 'out_for_delivery' ? 'outForDelivery' : row.status}`, { defaultValue: row.status })} · {t(
          row.payment_status === 'paid' ? 'payment.receipt.paid' : row.payment_status === 'partially_paid'
            ? 'payment.split.partiallyPaid' : `payment.status.${row.payment_status}`, { defaultValue: row.payment_status })}</div>
      </li>)}
    </ul>
    {!rows.length && !loading && !failed && <p>{t('tables.noHistory', { defaultValue: 'No order history for this table' })}</p>}
    {loading && <p role="status">{t('common.loading', { defaultValue: 'Loading…' })}</p>}
    {failed && <div role="alert"><p>{t('tables.historyLoadFailed')}</p><button type="button" className="table-action-button" onClick={() => setRetry(value => value + 1)}>{t('common.retry', { defaultValue: 'Retry' })}</button></div>}
    {more && !loading && !failed && <button type="button" className="table-action-button" onClick={() => setOffset(value => value + 50)}>{t('tables.historyLoadMore')}</button>}
  </section>;
}
