import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  clearCallerIdOrderIntents,
  enqueueCallerIdOrderIntent,
  resolveCallerIdOrderSelection,
  subscribeToCallerIdOrderIntents,
  type CallerIdOrderIntent,
} from '../caller-id-order-flow'

const intent = (customer: CallerIdOrderIntent['customer']): CallerIdOrderIntent => ({
  requestKey: 'caller-1',
  displayPhone: '+41 77 999 02 14',
  canonicalPhone: '+41779990214',
  lookupPhone: '779990214',
  customer,
  createdAt: Date.now(),
})

describe('Caller ID order handoff', () => {
  afterEach(() => clearCallerIdOrderIntents())

  it('lets pickup open the menu without requiring a saved customer', () => {
    expect(resolveCallerIdOrderSelection('pickup', intent(null)))
      .toBe('open-menu')
  })

  it('requires registration only for a customerless delivery', () => {
    expect(resolveCallerIdOrderSelection('delivery', intent(null)))
      .toBe('add-customer')
    expect(resolveCallerIdOrderSelection('delivery', intent({
      id: 'customer-1',
      name: 'Maria',
      phone: '+41779990214',
    }))).toBe('use-existing-customer')
  })

  it('buffers an offline in-memory handoff until the dashboard mounts', () => {
    const listener = vi.fn()
    enqueueCallerIdOrderIntent(intent(null))

    const unsubscribe = subscribeToCallerIdOrderIntents(listener)
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ canonicalPhone: '+41779990214' }),
    )
    unsubscribe()
  })

  it('preserves a direct workspace order action without persisting caller data', () => {
    const listener = vi.fn()
    enqueueCallerIdOrderIntent({
      ...intent(null),
      requestedOrderType: 'pickup',
    })

    const unsubscribe = subscribeToCallerIdOrderIntents(listener)
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ requestedOrderType: 'pickup' }),
    )
    unsubscribe()
  })
})
