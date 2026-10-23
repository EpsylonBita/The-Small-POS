import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  removeChannel: vi.fn(),
}))

vi.mock('../../../shared/supabase-config', () => ({
  getSupabaseClient: () => ({ from: mocks.from, removeChannel: mocks.removeChannel }),
}))

vi.mock('../../../lib', () => ({
  emitCompatEvent: vi.fn(),
  getBridge: () => ({ notifications: { show: vi.fn(async () => undefined) } }),
}))

vi.mock('../../services/SubscriptionManager', () => ({
  subscriptionManager: { subscribe: vi.fn(() => () => undefined) },
}))

import { useRealTimeMenuSync } from '../useRealTimeMenuSync'

afterEach(() => {
  mocks.from.mockReset()
})

// POS audit K4: branch overrides arrive merged into the native menu rows. The
// renderer used to preload `menu_synchronization` straight from Supabase with
// an `organization_id` filter on a column that table does not have.
describe('useRealTimeMenuSync without the renderer override preload', () => {
  it('never queries menu_synchronization, with or without a branch', () => {
    renderHook(() => useRealTimeMenuSync({ branchId: 'branch-1' }))
    renderHook(() => useRealTimeMenuSync())

    expect(mocks.from).not.toHaveBeenCalled()
  })

  it('leaves menu rows as the native menu served them', () => {
    const { result } = renderHook(() => useRealTimeMenuSync({ branchId: 'branch-1' }))
    const item = { id: 'coffee', price: 2.5, is_available: true }

    expect(result.current.getEffectiveMenuItem(item)).toBe(item)
    expect(result.current.getEffectiveIngredient(item)).toBe(item)
    expect(result.current.getCurrentOverrides().size).toBe(0)
  })
})
