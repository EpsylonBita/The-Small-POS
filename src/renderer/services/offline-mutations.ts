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

export function offlineUpdateProductQuantity(payload: Record<string, unknown>) {
  return invokeOffline<{ product?: Record<string, unknown>; queueId: string; queued: boolean }>(
    'offline:product-update-quantity',
    payload,
    'Failed to update product quantity offline',
  )
}
