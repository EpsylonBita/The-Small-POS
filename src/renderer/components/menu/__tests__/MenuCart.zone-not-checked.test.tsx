import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

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

describe('MenuCart: delivery zone not checked', () => {
  it('lets the order through with a notice and a re-pick action (founder rule), never "out of zone"', () => {
    const onRepick = vi.fn()
    const onCheckout = vi.fn()
    renderCart({ deliveryFeeStatus: 'not_checked', onRepickDeliveryAddress: onRepick, onCheckout })

    expect(screen.getByTestId('menu-cart-zone-not-checked')).toHaveTextContent('menu.cart.deliveryZoneNotCheckedNotice')
    expect(screen.getByText('menu.cart.deliveryFeeZoneNotChecked')).toBeInTheDocument()
    expect(screen.queryByText('menu.cart.deliveryFeeOutOfZone')).toBeNull()

    expect(checkoutButton()).not.toBeDisabled()
    fireEvent.click(checkoutButton())
    expect(onCheckout).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByTestId('menu-cart-zone-repick'))
    expect(onRepick).toHaveBeenCalledTimes(1)
  })

  it('shows the notice without a button when no re-pick action is available', () => {
    renderCart({ deliveryFeeStatus: 'not_checked' })
    expect(screen.getByTestId('menu-cart-zone-not-checked')).toBeInTheDocument()
    expect(screen.queryByTestId('menu-cart-zone-repick')).toBeNull()
  })

  it('still blocks checkout while the zone check runs or when there is no address', () => {
    const view = renderCart({ deliveryFeeStatus: 'loading' })
    expect(checkoutButton()).toBeDisabled()
    view.unmount()

    renderCart({ deliveryFeeStatus: 'requires_selection' })
    expect(checkoutButton()).toBeDisabled()
    expect(screen.queryByTestId('menu-cart-zone-not-checked')).toBeNull()
  })

  it('shows no notice for a checked zone, pickup or order edits', () => {
    const view = renderCart({ deliveryFeeStatus: 'resolved' })
    expect(screen.queryByTestId('menu-cart-zone-not-checked')).toBeNull()
    view.unmount()

    renderCart({ deliveryFeeStatus: 'not_checked', editMode: true })
    expect(screen.queryByTestId('menu-cart-zone-not-checked')).toBeNull()
  })
})
