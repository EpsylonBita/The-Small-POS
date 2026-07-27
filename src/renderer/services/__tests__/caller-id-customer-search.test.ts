import { afterEach, describe, expect, it, vi } from 'vitest'

import { navigateToCallerIdCustomerSearch } from '../caller-id-customer-search'

describe('Caller ID customer search navigation', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('opens only the existing customer search with a normalized phone', () => {
    const dispatch = vi.spyOn(window, 'dispatchEvent')

    navigateToCallerIdCustomerSearch('+30 694-812-8474')

    expect(dispatch).toHaveBeenCalledTimes(1)
    const event = dispatch.mock.calls[0]?.[0] as CustomEvent
    expect(event.type).toBe('pos:navigate-view')
    expect(event.detail).toEqual({
      view: 'users',
      customerSearch: '6948128474',
    })
  })
})
