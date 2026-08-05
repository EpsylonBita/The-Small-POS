import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  formatCallerIdDisplayPhone,
  navigateToCallerIdCustomerSearch,
} from '../caller-id-customer-search'

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

  it('hides only the configured home-country prefix for display', () => {
    expect(formatCallerIdDisplayPhone('+306948128474', 'GR'))
      .toBe('694 812 8474')
    expect(formatCallerIdDisplayPhone('+41779990214', 'GR'))
      .toBe('+41779990214')
    expect(formatCallerIdDisplayPhone('0041779990214', 'GR'))
      .toBe('+41779990214')
    expect(formatCallerIdDisplayPhone('00306948128474', 'GR'))
      .toBe('694 812 8474')
  })

  it('fails safe to the canonical number when the installation country is unavailable', () => {
    expect(formatCallerIdDisplayPhone('+41779990214')).toBe('+41779990214')
    expect(formatCallerIdDisplayPhone('+41779990214', 'invalid'))
      .toBe('+41779990214')
  })
})
