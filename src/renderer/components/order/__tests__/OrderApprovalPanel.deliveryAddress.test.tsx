import React from 'react'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { formatDeliveryAddress } from '../../../../../../shared/utils/delivery-address-display'

const i18n = vi.hoisted(() => ({
  value: {
    t: (key: string, options?: Record<string, unknown>) =>
      typeof options?.defaultValue === 'string' ? options.defaultValue : key,
    language: 'en',
  },
}))
const lookupByPhone = vi.hoisted(() => vi.fn())

vi.mock('../../../contexts/i18n-context', () => ({ useI18n: () => i18n.value }))
vi.mock('../../../../lib', () => ({
  emitCompatEvent: vi.fn(),
  onEvent: vi.fn(),
  offEvent: vi.fn(),
  getBridge: () => ({
    orders: { getById: vi.fn(async () => null), fetchItemsFromSupabase: vi.fn(async () => []) },
    customers: { lookupByPhone },
    payments: { printReceipt: vi.fn(async () => ({ success: true })) },
  }),
}))

import { OrderApprovalPanel } from '../OrderApprovalPanel'

const baseOrder = {
  id: 'incoming-1',
  order_number: 'ORD-incoming-1',
  status: 'pending',
  order_type: 'delivery',
  customer_phone: '6900000001',
  created_at: '2026-11-12T12:05:00Z',
  total_amount: 1,
  items: [{ menu_item_id: 'coffee', name: 'Espresso', quantity: 1, price: 1 }],
}

const oldCustomer = {
  addresses: [{ street: 'Ξενοφώντος 28', city: 'Θεσσαλονίκη', postal_code: '546 41', is_default: true }],
}
const oldAddress = 'Ξενοφώντος 28, Θεσσαλονίκη, 546 41'
const selectedAddress = 'Μυτιλήνης 4, Περιστέρι, 12132'
const snakeAddress = {
  delivery_address: 'Μυτιλήνης 4', delivery_city: 'Περιστέρι', delivery_postal_code: '12132',
}
const camelAddress = {
  deliveryAddress: 'Μυτιλήνης 4', deliveryCity: 'Περιστέρι', deliveryPostalCode: '12132',
}

function panel(overrides: Record<string, unknown> = {}) {
  return <OrderApprovalPanel
    order={{ ...baseOrder, ...overrides } as any}
    onApprove={vi.fn(async () => true)}
    onDecline={vi.fn(async () => true)}
    onClose={vi.fn()}
  />
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

beforeEach(() => {
  lookupByPhone.mockReset().mockResolvedValue(oldCustomer)
})
afterEach(() => cleanup())

describe('shared delivery address formatting', () => {
  it.each([
    ['Μυτιλήνης 4', 'Περιστέρι', '12132', selectedAddress],
    [selectedAddress, 'Περιστέρι', '12132', selectedAddress],
    ['Μυτιλήνης 4, Περιστέρι', 'Περιστέρι', '12132', selectedAddress],
    ['Μυτιλήνης 4, 12132', 'Περιστέρι', '12132', selectedAddress],
    ['Μυτιλήνης 4, περιστέρι, 121 32', 'Περιστέρι', '12132', selectedAddress],
    ['Μυτιλήνης, 4, Περιστέρι, 12132', 'Περιστέρι', '12132', 'Μυτιλήνης, 4, Περιστέρι, 12132'],
    ['Περιστέρι avenue 12', 'Περιστέρι', '12132', 'Περιστέρι avenue 12, Περιστέρι, 12132'],
    ['Μυτιλήνης 4, Historical district', 'Περιστέρι', '12132', 'Μυτιλήνης 4, Historical district, Περιστέρι, 12132'],
    [selectedAddress, null, null, selectedAddress],
    [null, 'Περιστέρι', '12132', 'Περιστέρι, 12132'],
    [' ', undefined, '', ''],
  ])('formats %s with %s / %s without losing street information', (address, city, postcode, expected) => {
    expect(formatDeliveryAddress(address, city, postcode)).toBe(expected)
  })
})

describe.each(['box', 'efood'])('%s approval delivery address', (plugin) => {
  it('shows locality once when the mapper supplies a full address and separate city/postcode', async () => {
    render(panel({ plugin, ...snakeAddress, delivery_address: selectedAddress }))
    await act(async () => {})

    expect(screen.getByText(selectedAddress)).toBeInTheDocument()
    expect(screen.queryByText(/Περιστέρι, 12132, Περιστέρι/)).not.toBeInTheDocument()
    expect(lookupByPhone).not.toHaveBeenCalled()
  })

  it.each([
    ['snake case', snakeAddress],
    ['camel case', camelAddress],
    ['bridge street with server locality', {
      deliveryAddress: 'Μυτιλήνης 4', delivery_city: 'Περιστέρι', delivery_postal_code: '12132',
    }],
  ] as const)('uses the selected order address from %s fields without a customer lookup', async (_shape, fields) => {
    render(panel({ plugin, ...fields }))
    await act(async () => {})

    expect(screen.getByText(selectedAddress)).toBeInTheDocument()
    expect(screen.queryByText(/Ξενοφώντος/)).not.toBeInTheDocument()
    expect(lookupByPhone).not.toHaveBeenCalled()
  })

  it('skips blank aliases and trims each supplied order component', async () => {
    render(panel({
      plugin,
      delivery_address: '  ', deliveryAddress: ' Μυτιλήνης 4 ',
      delivery_city: '\t', deliveryCity: ' Περιστέρι ',
      delivery_postal_code: '', deliveryPostalCode: ' 12132 ',
      address: 'Unrelated legacy address',
    }))
    await act(async () => {})

    expect(screen.getByText(selectedAddress)).toBeInTheDocument()
    expect(lookupByPhone).not.toHaveBeenCalled()
  })

  it('does not invent an address from a customer profile when the provider omits it', async () => {
    render(panel({ plugin, delivery_address: ' ', deliveryAddress: '\t' }))
    await act(async () => {})

    expect(screen.queryByText('Address')).not.toBeInTheDocument()
    expect(screen.queryByText(/Ξενοφώντος/)).not.toBeInTheDocument()
    expect(lookupByPhone).not.toHaveBeenCalled()
  })
})

describe('approval delivery address provenance', () => {
  it('keeps nonblank canonical fields ahead of conflicting aliases', async () => {
    render(panel({ plugin: 'box', ...snakeAddress, deliveryAddress: 'Other street', deliveryCity: 'Other city',
      deliveryPostalCode: '99999', address: 'Legacy street' }))
    await act(async () => {})

    expect(screen.getByText(selectedAddress)).toBeInTheDocument()
    expect(lookupByPhone).not.toHaveBeenCalled()
  })

  it.each([
    { order_plugin: 'box' },
    { platform: 'efood' },
    { external_plugin_order_id: 'external-1' },
    { externalPluginOrderId: 'external-1' },
  ])('does not profile-enrich an external order identified by %j', async (identity) => {
    render(panel(identity))
    await act(async () => {})

    expect(screen.queryByText('Address')).not.toBeInTheDocument()
    expect(lookupByPhone).not.toHaveBeenCalled()
  })

  it('preserves the legacy order address field without consulting a profile', async () => {
    render(panel({ address: ' Μυτιλήνης 4 ', delivery_city: 'Περιστέρι', delivery_postal_code: '12132' }))
    await act(async () => {})

    expect(screen.getByText(selectedAddress)).toBeInTheDocument()
    expect(lookupByPhone).not.toHaveBeenCalled()
  })

  it.each(['pos', 'box', 'efood'])('keeps a partial %s order address separate from the customer default', async (plugin) => {
    render(panel({ plugin, delivery_city: 'Περιστέρι', delivery_postal_code: '12132' }))
    await act(async () => {})

    expect(screen.getByText('Περιστέρι, 12132')).toBeInTheDocument()
    expect(screen.queryByText(/Ξενοφώντος/)).not.toBeInTheDocument()
    expect(lookupByPhone).not.toHaveBeenCalled()
  })

  it('retains the complete default profile address for a legacy manual delivery with no address', async () => {
    lookupByPhone.mockResolvedValue({ addresses: [
      { street: 'Nondefault street', city: 'Other city', postal_code: '99999' },
      ...oldCustomer.addresses,
    ] })
    render(panel({ plugin: 'pos' }))
    await act(async () => {})

    expect(screen.getByText(oldAddress)).toBeInTheDocument()
    expect(lookupByPhone).toHaveBeenCalledWith(baseOrder.customer_phone)
  })

  it('treats blank manual components as absent and trims the complete profile fallback', async () => {
    lookupByPhone.mockResolvedValue({ addresses: [
      { street: ' Ξενοφώντος 28 ', city: ' Θεσσαλονίκη ', postal_code: ' 546 41 ' },
    ] })
    render(panel({ delivery_address: ' ', deliveryCity: '\t', delivery_postal_code: ' ' }))
    await act(async () => {})

    expect(screen.getByText(oldAddress)).toBeInTheDocument()
  })

  it('does not look up a delivery address for a pickup', async () => {
    render(panel({ order_type: 'pickup' }))
    await act(async () => {})

    expect(lookupByPhone).not.toHaveBeenCalled()
    expect(screen.queryByText('Address')).not.toBeInTheDocument()
  })
})

describe('approval address changes while a customer lookup is pending', () => {
  it.each([baseOrder.id, 'incoming-2'])('ignores a late lookup after order %s gains its authoritative address', async (id) => {
    const lookup = deferred<typeof oldCustomer>()
    lookupByPhone.mockReturnValue(lookup.promise)
    const view = render(panel())

    view.rerender(panel({ id, plugin: 'efood', ...snakeAddress }))
    await act(async () => { lookup.resolve(oldCustomer) })

    expect(screen.getByText(selectedAddress)).toBeInTheDocument()
    expect(screen.queryByText(/Ξενοφώντος/)).not.toBeInTheDocument()
  })

  it('uses a fresh lookup for a new manual order even when the customer phone is unchanged', async () => {
    const first = deferred<typeof oldCustomer>()
    const second = deferred<typeof oldCustomer>()
    lookupByPhone.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const view = render(panel())

    view.rerender(panel({ id: 'incoming-2' }))
    expect(lookupByPhone).toHaveBeenCalledTimes(2)
    await act(async () => { second.resolve({ addresses: [
      { street: 'Μυτιλήνης 4', city: 'Περιστέρι', postal_code: '12132', is_default: true },
    ] }) })
    await act(async () => { first.resolve(oldCustomer) })

    expect(screen.getByText(selectedAddress)).toBeInTheDocument()
    expect(screen.queryByText(/Ξενοφώντος/)).not.toBeInTheDocument()
  })

  it('ignores the earlier customer lookup when the phone changes on the same order', async () => {
    const first = deferred<typeof oldCustomer>()
    lookupByPhone.mockReturnValueOnce(first.promise).mockResolvedValueOnce({ addresses: [
      { street: 'Μυτιλήνης 4', city: 'Περιστέρι', postal_code: '12132' },
    ] })
    const view = render(panel())

    view.rerender(panel({ customer_phone: '6900000002' }))
    await act(async () => {})
    await act(async () => { first.resolve(oldCustomer) })

    expect(screen.getByText(selectedAddress)).toBeInTheDocument()
    expect(screen.queryByText(/Ξενοφώντος/)).not.toBeInTheDocument()
  })

  it('clears the previous profile address when the next order has no phone', async () => {
    const view = render(panel())
    await act(async () => {})
    expect(screen.getByText(oldAddress)).toBeInTheDocument()

    view.rerender(panel({ id: 'incoming-2', customer_phone: '' }))
    await act(async () => {})

    expect(screen.queryByText('Address')).not.toBeInTheDocument()
    expect(screen.queryByText(/Ξενοφώντος/)).not.toBeInTheDocument()
  })

  it('does not retain a manual fallback when the same order is identified as a provider order', async () => {
    const view = render(panel())
    await act(async () => {})
    expect(screen.getByText(oldAddress)).toBeInTheDocument()

    view.rerender(panel({ plugin: 'box' }))
    await act(async () => {})

    expect(screen.queryByText('Address')).not.toBeInTheDocument()
    expect(screen.queryByText(/Ξενοφώντος/)).not.toBeInTheDocument()
  })

  it('clears the previous profile address when a later lookup fails', async () => {
    const view = render(panel())
    await act(async () => {})
    expect(screen.getByText(oldAddress)).toBeInTheDocument()
    lookupByPhone.mockRejectedValueOnce(new Error('Customer unavailable'))

    view.rerender(panel({ id: 'incoming-2', customer_phone: '6900000002' }))
    await act(async () => {})

    expect(screen.queryByText('Address')).not.toBeInTheDocument()
    expect(screen.queryByText(/Ξενοφώντος/)).not.toBeInTheDocument()
  })

  it('does not carry a lookup from a closed panel into the next panel', async () => {
    const lookup = deferred<typeof oldCustomer>()
    lookupByPhone.mockReturnValueOnce(lookup.promise)
    const closedPanel = render(panel())
    closedPanel.unmount()
    render(panel({ id: 'incoming-2', plugin: 'box', ...camelAddress }))

    await act(async () => { lookup.resolve(oldCustomer) })

    expect(screen.getByText(selectedAddress)).toBeInTheDocument()
    expect(screen.queryByText(/Ξενοφώντος/)).not.toBeInTheDocument()
  })
})
