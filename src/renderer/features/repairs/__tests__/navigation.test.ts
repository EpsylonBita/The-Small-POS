import { describe, expect, it } from 'vitest'
import {
  PENDING_POST_LOGIN_INTENT_TTL_MS,
  consumeAuthorizedPendingPostLoginIntent,
  consumePendingPostLoginIntent,
  savePendingPostLoginIntent,
} from '../navigation'

class MemoryStorage implements Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> {
  private readonly values = new Map<string, string>()

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }

  removeItem(key: string): void {
    this.values.delete(key)
  }
}

describe('repair post-check-in navigation intent', () => {
  it('round-trips a repair intent and consumes it exactly once', () => {
    const storage = new MemoryStorage()
    savePendingPostLoginIntent(storage, {
      view: 'repairs',
      repairIntent: 'quick_service',
    }, 1_000)

    expect(consumePendingPostLoginIntent(storage, 1_500)).toEqual({
      view: 'repairs',
      repairIntent: 'quick_service',
    })
    expect(consumePendingPostLoginIntent(storage, 1_500)).toBeNull()
  })

  it('drops an expired intent instead of opening a stale intake flow', () => {
    const storage = new MemoryStorage()
    savePendingPostLoginIntent(storage, {
      view: 'repairs',
      repairIntent: 'new_repair',
    }, 2_000)

    expect(
      consumePendingPostLoginIntent(storage, 2_000 + PENDING_POST_LOGIN_INTENT_TTL_MS + 1),
    ).toBeNull()
  })

  it('does not attach repair-only intent values to another view', () => {
    const storage = new MemoryStorage()
    savePendingPostLoginIntent(storage, {
      view: 'orders',
      repairIntent: 'quick_service',
    }, 3_000)

    expect(consumePendingPostLoginIntent(storage, 3_100)).toEqual({ view: 'orders' })
  })

  it('drops a repair intent when entitlement is revoked during check-in', () => {
    const storage = new MemoryStorage()
    savePendingPostLoginIntent(storage, {
      view: 'repairs',
      repairIntent: 'new_repair',
    }, 4_000)

    expect(consumeAuthorizedPendingPostLoginIntent(
      storage,
      [{ module: { id: 'orders' } }],
      4_100,
    )).toBeNull()
    expect(consumePendingPostLoginIntent(storage, 4_100)).toBeNull()
  })
})
