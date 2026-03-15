import type { RealtimeChannel } from '@supabase/supabase-js'
import { getBridge } from '../../lib'
import { supabase } from '../../shared/supabase'

export interface AdminOrderDeletedEventPayload {
  orderId: string
  organizationId?: string | null
  branchId?: string | null
  ownerTerminalId?: string | null
  sourceTerminalId?: string | null
  deletedAt?: string | null
}

export interface TerminalRealtimeIdentity {
  terminalId: string
  organizationId: string
  branchId?: string
}

function normalizeString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }

  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function toRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

export function normalizeAdminOrderDeletedEventPayload(
  payload: unknown
): AdminOrderDeletedEventPayload | null {
  const record = toRecord(payload)
  if (!record) {
    return null
  }

  const orderId = normalizeString(record.orderId ?? record.order_id ?? record.id)
  if (!orderId) {
    return null
  }

  return {
    orderId,
    organizationId: normalizeString(record.organizationId ?? record.organization_id),
    branchId: normalizeString(record.branchId ?? record.branch_id),
    ownerTerminalId: normalizeString(record.ownerTerminalId ?? record.owner_terminal_id),
    sourceTerminalId: normalizeString(record.sourceTerminalId ?? record.source_terminal_id),
    deletedAt: normalizeString(record.deletedAt ?? record.deleted_at),
  }
}

export function shouldProcessAdminOrderDeletedEvent(
  payload: AdminOrderDeletedEventPayload,
  identity: TerminalRealtimeIdentity
): boolean {
  const terminalId = normalizeString(identity.terminalId)
  const organizationId = normalizeString(identity.organizationId)
  const branchId = normalizeString(identity.branchId)

  if (!terminalId || !organizationId || !normalizeString(payload.orderId)) {
    return false
  }

  if (payload.organizationId && payload.organizationId !== organizationId) {
    return false
  }

  if (payload.branchId && branchId && payload.branchId !== branchId) {
    return false
  }

  return payload.sourceTerminalId === terminalId || payload.ownerTerminalId === terminalId
}

export function subscribeToAdminOrderDeletedEvents(
  identity: TerminalRealtimeIdentity
): () => void {
  const terminalId = normalizeString(identity.terminalId)
  const organizationId = normalizeString(identity.organizationId)
  const branchId = normalizeString(identity.branchId)

  if (!terminalId || !organizationId) {
    return () => {}
  }

  const inFlightDeletes = new Set<string>()
  let channel: RealtimeChannel | null = null
  let disposed = false

  try {
    channel = supabase
      .channel(`orders:${organizationId}`)
      .on('broadcast', { event: 'order_deleted' }, async (event: { payload?: unknown }) => {
        const payload = normalizeAdminOrderDeletedEventPayload(event?.payload)
        if (!payload) {
          return
        }

        if (
          !shouldProcessAdminOrderDeletedEvent(payload, {
            terminalId,
            organizationId,
            branchId: branchId ?? undefined,
          })
        ) {
          return
        }

        if (inFlightDeletes.has(payload.orderId)) {
          return
        }

        inFlightDeletes.add(payload.orderId)

        try {
          const bridge = getBridge()
          const response = await bridge.orders.delete(payload.orderId)

          if (response?.success === false) {
            console.warn('[OrderDeleteRealtimeService] Local delete returned a failure response:', {
              orderId: payload.orderId,
              response,
            })
          }
        } catch (error) {
          if (!disposed) {
            console.warn('[OrderDeleteRealtimeService] Failed to delete broadcast order locally:', {
              orderId: payload.orderId,
              error,
            })
          }
        } finally {
          inFlightDeletes.delete(payload.orderId)
        }
      })
      .subscribe((status, error) => {
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          console.warn('[OrderDeleteRealtimeService] Broadcast subscription error:', {
            organizationId,
            terminalId,
            status,
            error,
          })
        }
      })
  } catch (error) {
    console.warn('[OrderDeleteRealtimeService] Failed to subscribe to delete broadcasts:', {
      organizationId,
      terminalId,
      error,
    })
  }

  return () => {
    disposed = true
    if (channel) {
      void supabase.removeChannel(channel)
    }
  }
}
