import { getBridge } from '../../lib'

function readError(error: unknown, fallback: string): Error {
  if (error instanceof Error) {
    return error
  }
  if (typeof error === 'string' && error.trim()) {
    return new Error(error)
  }
  return new Error(fallback)
}

async function invokeOffline<T>(channel: string, payload: Record<string, unknown>, fallback: string): Promise<T> {
  try {
    const result = await getBridge().invoke(channel, payload)
    if (!result?.success) {
      throw new Error(result?.error || fallback)
    }
    return (result?.data ?? result) as T
  } catch (error) {
    throw readError(error, fallback)
  }
}

export function offlineAdjustInventory(payload: {
  product_id: string
  adjustment: number
  reason?: string | null
  notes?: string | null
}) {
  return invokeOffline<{ queueId: string; queued: boolean }>(
    'offline:inventory-adjust',
    payload,
    'Failed to adjust inventory offline',
  )
}

export function offlineUpsertCoupon(payload: Record<string, unknown>) {
  return invokeOffline<{ coupon: Record<string, unknown>; queueId: string; queued: boolean }>(
    'offline:coupon-upsert',
    payload,
    'Failed to save coupon offline',
  )
}

export function offlineSetCouponActive(payload: { couponId: string; isActive: boolean }) {
  return invokeOffline<{ coupon?: Record<string, unknown>; queueId: string; queued: boolean }>(
    'offline:coupon-set-active',
    payload,
    'Failed to update coupon status offline',
  )
}

export function offlineCreateReservation(payload: Record<string, unknown>) {
  return invokeOffline<{ reservation: Record<string, unknown>; queueId: string; queued: boolean }>(
    'offline:reservation-create',
    payload,
    'Failed to create reservation offline',
  )
}

export function offlineUpdateReservation(payload: Record<string, unknown>) {
  return invokeOffline<{ reservation: Record<string, unknown>; queueId: string; queued: boolean }>(
    'offline:reservation-update',
    payload,
    'Failed to update reservation offline',
  )
}

export function offlineCreateAppointment(payload: Record<string, unknown>) {
  return invokeOffline<{ appointment: Record<string, unknown>; queueId: string; queued: boolean }>(
    'offline:appointment-create',
    payload,
    'Failed to create appointment offline',
  )
}

export function offlineUpdateAppointmentStatus(payload: Record<string, unknown>) {
  return invokeOffline<{ appointment: Record<string, unknown>; queueId: string; queued: boolean }>(
    'offline:appointment-update-status',
    payload,
    'Failed to update appointment offline',
  )
}

export function offlineCreateStaffShift(payload: Record<string, unknown>) {
  return invokeOffline<{ shift: Record<string, unknown>; queueId: string; queued: boolean }>(
    'offline:staff-shift-create',
    payload,
    'Failed to create shift offline',
  )
}

export function offlineUpdateDriveThruStatus(payload: Record<string, unknown>) {
  return invokeOffline<{ order?: Record<string, unknown>; queueId: string; queued: boolean }>(
    'offline:drive-thru-update-status',
    payload,
    'Failed to update drive-through status offline',
  )
}

export function offlineUpdateRoomStatus(payload: Record<string, unknown>) {
  return invokeOffline<{ room?: Record<string, unknown>; queueId: string; queued: boolean }>(
    'offline:room-update-status',
    payload,
    'Failed to update room status offline',
  )
}

export function offlineRoomCheckin(payload: Record<string, unknown>) {
  return invokeOffline<{
    room?: Record<string, unknown>
    clientRequestId: string
    queueId: string
    queued: boolean
  }>(
    'offline:room-checkin',
    payload,
    'Failed to queue room check-in offline',
  )
}

export function offlineUpdateHousekeepingStatus(payload: Record<string, unknown>) {
  return invokeOffline<{ task?: Record<string, unknown>; queueId: string; queued: boolean }>(
    'offline:housekeeping-update-status',
    payload,
    'Failed to update housekeeping task offline',
  )
}

export function offlineAssignHousekeepingStaff(payload: Record<string, unknown>) {
  return invokeOffline<{ task?: Record<string, unknown>; queueId: string; queued: boolean }>(
    'offline:housekeeping-assign-staff',
    payload,
    'Failed to assign housekeeping staff offline',
  )
}

/**
 * Queue a goods receipt against a purchase order for offline replay
 * (procurement-loop Task 10.3). The Rust capture generates the
 * idempotency key (UUID) and `recorded_at` when the caller did not
 * supply them and stores both ON THE QUEUE ROW; replay sends the stored
 * key as the `Idempotency-Key` header so crash-retry duplicates collapse
 * server-side to one effect. [R11.2, R11.3, R11.4]
 */
export function offlineCommitPoReceipt(payload: {
  purchaseOrderId: string
  staffId: string
  lines: Array<Record<string, unknown>>
  idempotencyKey?: string
  recordedAt?: string
  kind?: 'delivery' | 'correction'
  notes?: string | null
}) {
  return invokeOffline<{
    idempotencyKey: string
    recordedAt: string
    queueId: string
    queued: boolean
  }>(
    'offline:po-receipt',
    payload,
    'Failed to queue the goods receipt offline',
  )
}

/**
 * Queue a reviewed scanned invoice for replay when the connection drops at the
 * Save moment (invoice-scan-capture Task 11.3, design surface D-Rust5).
 *
 * The replay key is NOT generated: it is the capture id the pages were staged
 * under, which is also what the server's commit claim is keyed on. Rust stores
 * it — together with `recordedAt` and `staffId` captured at Save time — ON THE
 * QUEUE ROW, and replay sends it as the `Idempotency-Key` header, so the same
 * document committed twice converges on one invoice and one stock effect.
 * [R9.5, R11.6, R11.7, R13.2]
 *
 * `draft`, `capture` and `poLinkage` are the exact blocks the online
 * `commitImport` call sends, stored and replayed untouched.
 */
export function offlineCommitSupplierImport(payload: {
  draft: Record<string, unknown>
  capture: {
    captureId: string
    sourceKind: string
    capturedAt: string
    sourceName?: string
    capturedByStaffId?: string
    committedByStaffId?: string
    storageKeys?: string[]
    originalKey?: string
  }
  poLinkage?: {
    purchaseOrderId: string
    mode: 'confirm_existing' | 'record_delivery'
    linkedInventoryItemIds?: string[]
  }
  staffId: string
  recordedAt?: string
}) {
  return invokeOffline<{
    captureId: string
    idempotencyKey: string
    recordedAt: string
    queueId: string
    queued: boolean
  }>(
    'offline:supplier-import-commit',
    payload,
    'Failed to queue the invoice offline',
  )
}

export function offlineUpdateProductQuantity(payload: Record<string, unknown>) {
  return invokeOffline<{ product?: Record<string, unknown>; queueId: string; queued: boolean }>(
    'offline:product-update-quantity',
    payload,
    'Failed to update product quantity offline',
  )
}
