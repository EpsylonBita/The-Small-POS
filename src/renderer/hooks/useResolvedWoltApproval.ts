import { useEffect } from 'react'
import { foodDeliveryPlatform } from '../../../../shared/platforms/order-cancellation'

type OrderStatusRow = { id?: string; status?: string | null }

function isResolvedWoltOrder(row: OrderStatusRow | null | undefined, id: string): boolean {
  return row?.id === id && foodDeliveryPlatform(row) === 'wolt' &&
    ['confirmed', 'preparing', 'ready', 'out_for_delivery', 'delivered', 'completed', 'cancelled', 'canceled']
      .includes(String(row.status ?? '').toLowerCase())
}

/** Another terminal can decide this order while the forced approval panel is open. */
export function useResolvedWoltApproval(
  selected: OrderStatusRow | null,
  currentOrders: readonly OrderStatusRow[],
  pending: readonly OrderStatusRow[],
  readLocalOrder: (id: string) => Promise<OrderStatusRow | null>,
  closePanel: () => void,
): void {
  const id = selected?.id
  const candidate = id && foodDeliveryPlatform(selected) === 'wolt' &&
    !pending.some(row => row.id === id) && currentOrders.some(row => isResolvedWoltOrder(row, id)) ? id : null

  useEffect(() => {
    if (!candidate) return
    let current = true
    // The local DB confirms the same order. A missing row, failed read or transient
    // queue snapshot cannot dismiss a genuine incoming order.
    void readLocalOrder(candidate).then(row => {
      if (current && isResolvedWoltOrder(row, candidate)) closePanel()
    }).catch(() => undefined)
    return () => { current = false }
  }, [candidate, readLocalOrder, closePanel, currentOrders])
}
