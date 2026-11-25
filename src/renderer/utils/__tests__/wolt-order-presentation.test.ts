import { describe, expect, it } from 'vitest'
import { hasIncompleteWoltOrderDetails, woltOrderReference } from '../../../../../shared/platforms/wolt-order-presentation'
import { formatGridOrderNumber } from '../gridOrderNumber'

const order = {
  id: 'local-notice',
  order_number: 'WOLT-0000000000000-GENERATED',
  platform: 'wolt',
  external_plugin_order_id: 'provider-order-id',
  payment_status: 'pending',
  payment_method: 'online',
  total_amount: 0,
  items: [] as unknown[],
  ghost_metadata: { food_delivery: { prepaid: true, payment_method: 'online' } },
}

describe('Wolt order details and identity on the POS', () => {
  it('shows the actual external reference when Wolt omitted its customer number', () => {
    expect(formatGridOrderNumber(order)).toBe('provider-order-id')
    expect(hasIncompleteWoltOrderDetails(order)).toBe(true)
    expect(hasIncompleteWoltOrderDetails({ ...order, payment_method: 'pending' })).toBe(true)
  })

  it('uses a customer number as supplied, including its leading zeroes', () => {
    const numbered = { ...order, ghost_metadata: { food_delivery: { ...order.ghost_metadata.food_delivery, short_code: '0042' } } }
    expect(formatGridOrderNumber(numbered)).toBe('#0042')
    expect(hasIncompleteWoltOrderDetails(numbered)).toBe(false)
    expect(woltOrderReference({ ...order, display_order_number: '0011' })).toBe('#0011')
    const localReceipt = { ...order, external_plugin_order_id: null, order_number: 'ORD-24112026-00007' }
    expect(woltOrderReference(localReceipt)).toBeNull()
    expect(formatGridOrderNumber(localReceipt)).toBe('#00007')
    expect(woltOrderReference({ ...order, ghost_metadata: JSON.stringify({ food_delivery: { short_code: '#0042' } }) })).toBe('#0042')
  })

  it.each([
    { items: [{ quantity: 1 }], total_amount: 0 },
    { items: undefined },
    { total_amount: 14 },
    { payments: [{ id: 'payment' }] },
    { deliveryAddress: { street: 'Real street 1' } },
    { payment_method: 'card' },
    { payment_method: 'cash' },
    { payment_status: 'paid' },
    { plugin: 'efood', platform: 'efood' },
    { plugin: 'box', platform: 'box' },
  ])('preserves normal presentation if the evidence differs (%j)', overrides => {
    expect(hasIncompleteWoltOrderDetails({ ...order, ...overrides })).toBe(false)
  })

  it('gives hydrated items or payment rows priority over an empty header', () => {
    expect(hasIncompleteWoltOrderDetails(order, [{ name: 'Gift' }])).toBe(false)
    expect(hasIncompleteWoltOrderDetails(order, [], [{ id: 'payment' }])).toBe(false)
  })
})
