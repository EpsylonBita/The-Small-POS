import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  settings: {} as any, unsynced: [] as any[], rows: [] as any[], toastError: vi.fn(),
}))

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>()
  const translation = {
    t: (key: string, fallback?: string | Record<string, any>) => {
      const template = typeof fallback === 'string' ? fallback : fallback?.defaultValue ?? key
      return String(template).replace(/{{(\w+)}}/g, (_m: string, name: string) =>
        String(typeof fallback === 'object' ? fallback?.[name] ?? '' : ''))
    },
  }
  return { ...actual, useTranslation: () => translation }
})
vi.mock('react-hot-toast', () => ({ default: Object.assign(vi.fn(), { error: state.toastError, success: vi.fn() }) }))
vi.mock('../../../contexts/i18n-context', () => ({ useI18n: () => ({ language: 'en', t: (key: string) => key }) }))
vi.mock('../../../contexts/barcode-scanner-context', () => ({ useOnBarcodeScan: vi.fn() }))
vi.mock('../../../hooks/useLoyaltyReader', () => ({ useLoyaltyReader: () => ({ start: vi.fn(), stop: vi.fn() }) }))
vi.mock('../../../../lib', () => ({
  getBridge: () => ({
    settings: { getLocal: async () => state.settings },
    orders: { getUnsyncedRetailQuantities: async () => ({ success: true, quantities: state.unsynced }) },
  }),
  isBrowser: () => false,
}))
vi.mock('../../../services/module-snapshots', () => ({
  readModuleSnapshot: async () => ({ rows: state.rows, categories: [] }),
}))

import { MenuCart } from '../MenuCart'
import { resetRetailStockGuardCache } from '../../../services/retail-stock-guard'

const shampooLine = { id: 'line-1', name: 'Shampoo', quantity: 1, price: 8, totalPrice: 8, retail_product_id: 'shampoo', retail_variant_id: null }
const haircutLine = { id: 'line-2', name: 'Haircut', quantity: 1, price: 25, totalPrice: 25, service_id: 'haircut' }

function renderCart(props: Partial<React.ComponentProps<typeof MenuCart>> = {}) {
  const onUpdateCart = vi.fn()
  const onCheckout = vi.fn()
  const view = render(<MenuCart cartItems={[shampooLine, haircutLine] as any} onCheckout={onCheckout} onUpdateCart={onUpdateCart} orderType="pickup" {...props} />)
  return { onUpdateCart, onCheckout, ...view }
}
const plusButtons = () => screen.getAllByRole('button', { name: '+' })
const checkoutButton = () => screen.getByRole('button', { name: /menu\.cart\.completeOrder|modals\.menu\.saveChanges/ })

beforeEach(() => {
  resetRetailStockGuardCache()
  state.settings = { retail: { block_overselling: true } }
  state.unsynced = []
  state.rows = [{ id: 'shampoo', quantity: 1, variants: [] }]
})
afterEach(cleanup)

describe('MenuCart retail lines under retail.block_overselling', () => {
  it('refuses + on a retail line beyond the snapshot stock', async () => {
    const { onUpdateCart } = renderCart()
    fireEvent.click(plusButtons()[0])
    await waitFor(() => expect(state.toastError).toHaveBeenCalledWith('Only 1 pcs in stock'))
    expect(onUpdateCart).not.toHaveBeenCalled()
  })

  it('steps a retail line up while stock is left, counting unsynced sales', async () => {
    state.rows = [{ id: 'shampoo', quantity: 3, variants: [] }]
    const { onUpdateCart } = renderCart()
    fireEvent.click(plusButtons()[0])
    await waitFor(() => expect(onUpdateCart).toHaveBeenCalledTimes(1))
    expect(onUpdateCart.mock.calls[0][0][0]).toMatchObject({ id: 'line-1', quantity: 2 })
    cleanup(); resetRetailStockGuardCache()
    state.unsynced = [{ productId: 'shampoo', variantId: null, quantity: 2 }]
    const second = renderCart()
    fireEvent.click(plusButtons()[0])
    await waitFor(() => expect(state.toastError).toHaveBeenCalledWith('Only 1 pcs in stock'))
    expect(second.onUpdateCart).not.toHaveBeenCalled()
  })

  it('steps service lines at once, without any stock lookup', () => {
    const { onUpdateCart } = renderCart()
    fireEvent.click(plusButtons()[1])
    expect(onUpdateCart).toHaveBeenCalledTimes(1)
    expect(onUpdateCart.mock.calls[0][0][1]).toMatchObject({ id: 'line-2', quantity: 2 })
  })

  it('checks the retail lines once more before payment', async () => {
    state.rows = [{ id: 'shampoo', quantity: 0, variants: [] }]
    const { onCheckout } = renderCart()
    fireEvent.click(checkoutButton())
    await waitFor(() => expect(state.toastError).toHaveBeenCalledWith('Only 0 pcs in stock'))
    expect(onCheckout).not.toHaveBeenCalled()
  })

  it('never blocks with the setting off or an unknown stock', async () => {
    state.settings = {}
    state.rows = [{ id: 'shampoo', quantity: 0, variants: [] }]
    let cart = renderCart()
    fireEvent.click(checkoutButton())
    await waitFor(() => expect(cart.onCheckout).toHaveBeenCalledTimes(1))
    cleanup(); resetRetailStockGuardCache()
    state.settings = { retail: { block_overselling: true } }
    state.rows = []
    cart = renderCart()
    fireEvent.click(checkoutButton())
    await waitFor(() => expect(cart.onCheckout).toHaveBeenCalledTimes(1))
    expect(state.toastError).not.toHaveBeenCalled()
  })

  it('checks only additional units when editing a previously sold retail line', async () => {
    state.rows = [{ id: 'shampoo', quantity: 3, variants: [] }]
    state.unsynced = [{ productId: 'shampoo', variantId: null, quantity: 2 }]
    const original = { ...shampooLine, quantity: 2 }
    const cart = renderCart({ editMode: true, cartItems: [original] as any })
    // The original two units are already held by the unsynced order. One remains.
    fireEvent.click(plusButtons()[0])
    await waitFor(() => expect(cart.onUpdateCart).toHaveBeenCalledTimes(1))
    const updated = cart.onUpdateCart.mock.calls[0][0]
    expect(updated[0].quantity).toBe(3)
    cart.rerender(<MenuCart editMode cartItems={updated} onCheckout={cart.onCheckout} onUpdateCart={cart.onUpdateCart} />)
    fireEvent.click(plusButtons()[0])
    await waitFor(() => expect(state.toastError).toHaveBeenCalledWith('Only 1 pcs in stock'))
    expect(cart.onUpdateCart).toHaveBeenCalledTimes(1)
    fireEvent.click(checkoutButton())
    await waitFor(() => expect(cart.onCheckout).toHaveBeenCalledTimes(1))
  })

  it('allows an unchanged edit at zero stock but refuses an increase', async () => {
    state.rows = [{ id: 'shampoo', quantity: 0, variants: [] }]
    const cart = renderCart({ editMode: true })
    fireEvent.click(checkoutButton())
    await waitFor(() => expect(cart.onCheckout).toHaveBeenCalledTimes(1))
    fireEvent.click(plusButtons()[0])
    await waitFor(() => expect(state.toastError).toHaveBeenCalledWith('Only 0 pcs in stock'))
    expect(cart.onUpdateCart).not.toHaveBeenCalled()
  })

  it('checks food-only carts synchronously as before', () => {
    const { onCheckout } = renderCart({ cartItems: [haircutLine] as any })
    fireEvent.click(checkoutButton())
    expect(onCheckout).toHaveBeenCalledTimes(1)
  })
})
