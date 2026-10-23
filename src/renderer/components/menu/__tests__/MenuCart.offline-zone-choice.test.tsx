import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Offline week Ω6β: offline, an address that cannot be located gets its zone
// from the cashier. The cart shows the store's zones with their fees instead
// of the "zone not checked" notice, and checkout waits for a choice.

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>()
  const translation = {
    t: (key: string, fallback?: string | { defaultValue?: string }) => (
      typeof fallback === 'string' ? fallback : fallback?.defaultValue ?? key
    ),
  }
  return { ...actual, useTranslation: () => translation }
})

vi.mock('../../../contexts/i18n-context', () => ({
  useI18n: () => ({ language: 'en', t: (key: string) => key }),
}))

vi.mock('../../../contexts/barcode-scanner-context', () => ({
  useOnBarcodeScan: vi.fn(),
}))

vi.mock('../../../hooks/useLoyaltyReader', () => ({
  useLoyaltyReader: () => ({ start: vi.fn(), stop: vi.fn() }),
}))

vi.mock('../../../../lib', () => ({
  getBridge: () => ({}),
}))

import { MenuCart } from '../MenuCart'

const cartItems = [
  { id: 'line-1', name: 'Espresso', quantity: 1, price: 6, totalPrice: 6 },
]
const options = [
  { id: 'zone-a', name: 'Zone A', deliveryFee: 1, minimumOrderAmount: 0 },
  { id: 'zone-b', name: 'Zone B', deliveryFee: 2.5, minimumOrderAmount: 0 },
]

function renderCart(props: Partial<React.ComponentProps<typeof MenuCart>> = {}) {
  return render(
    <MenuCart
      cartItems={cartItems}
      onCheckout={vi.fn()}
      onUpdateCart={vi.fn()}
      orderType="delivery"
      deliveryFee={0}
      {...props}
    />,
  )
}

const checkoutButton = () => screen.getByRole('button', { name: 'menu.cart.completeOrder' })

afterEach(cleanup)

describe('MenuCart: offline zone choice', () => {
  it('lists the zones with their fees and blocks checkout until one is chosen', () => {
    const onChoose = vi.fn()
    renderCart({
      deliveryFeeStatus: 'requires_zone_choice',
      deliveryZoneChoice: { options, loading: false, selectedZoneId: null, onChoose },
    })

    expect(screen.getByTestId('offline-zone-picker')).toHaveTextContent('menu.cart.offlineZoneChoiceTitle')
    expect(screen.getByTestId('offline-zone-picker-hint')).toHaveTextContent('menu.cart.offlineZoneChoiceHint')
    expect(screen.getByText('menu.cart.deliveryFeeChooseZone')).toBeInTheDocument()
    // The picker replaces the "zone not checked" notice; never fee 0 silently.
    expect(screen.queryByTestId('menu-cart-zone-not-checked')).toBeNull()
    expect(checkoutButton()).toBeDisabled()

    const zoneB = screen.getByTestId('offline-zone-option-zone-b')
    expect(zoneB).toHaveAttribute('role', 'radio')
    expect(zoneB).toHaveAttribute('aria-checked', 'false')
    expect(zoneB.textContent).toMatch(/Zone B/)
    fireEvent.click(zoneB)
    expect(onChoose).toHaveBeenCalledWith('zone-b')
  })

  it('after the choice: the zone fee applies, checkout is allowed and the manual label shows', () => {
    renderCart({
      deliveryFee: 2.5,
      deliveryFeeStatus: 'resolved',
      deliveryZoneChoice: { options, loading: false, selectedZoneId: 'zone-b', onChoose: vi.fn() },
    })

    expect(screen.getByTestId('offline-zone-option-zone-b')).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByTestId('offline-zone-picker-hint')).toHaveTextContent('menu.cart.zoneChosenManually')
    expect(checkoutButton()).not.toBeDisabled()
  })

  it('says so when the till has no cached zones (checkout stays blocked)', () => {
    renderCart({
      deliveryFeeStatus: 'requires_zone_choice',
      deliveryZoneChoice: { options: [], loading: false, selectedZoneId: null, onChoose: vi.fn() },
    })
    expect(screen.getByTestId('offline-zone-picker-empty')).toHaveTextContent('menu.cart.offlineZoneChoiceNoZones')
    expect(checkoutButton()).toBeDisabled()
  })

  it('online (no choice offered) keeps the "zone not checked" notice as before', () => {
    renderCart({ deliveryFeeStatus: 'not_checked', deliveryZoneChoice: null })
    expect(screen.queryByTestId('offline-zone-picker')).toBeNull()
    expect(screen.getByTestId('menu-cart-zone-not-checked')).toBeInTheDocument()
    expect(checkoutButton()).not.toBeDisabled()
  })
})
