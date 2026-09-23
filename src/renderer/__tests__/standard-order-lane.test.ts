import { describe, expect, it } from 'vitest'
import { shouldShowInStandardOrderLane } from '../utils/tableOrderFlow'

/**
 * THE-441: the active orders lane statuses are pinned on both POS apps so they
 * cannot drift again. `confirmed` is a live resting state (efood and web orders
 * sit there between acceptance and ready — 657 efood transitions in 120 days
 * of production history). The Android side pins the same list and compares it
 * against this file (POSSystemMobile/__tests__/src/utils/standardOrderLane.parity.test.ts).
 */
const options = { tablesModuleAvailable: false }

describe('shouldShowInStandardOrderLane', () => {
  it.each(['pending', 'confirmed', 'preparing', 'ready'])('shows a %s order in the active lane', (status) => {
    expect(shouldShowInStandardOrderLane({ id: 'o-1', status }, options)).toBe(true)
  })

  it.each(['delivered', 'completed', 'cancelled'])('keeps a %s order out of the active lane', (status) => {
    expect(shouldShowInStandardOrderLane({ id: 'o-1', status }, options)).toBe(false)
  })
})
