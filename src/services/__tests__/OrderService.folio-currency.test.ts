import { beforeEach, describe, expect, it, vi } from 'vitest'
const { bridge } = vi.hoisted(() => ({ bridge: {
  orders: { create: vi.fn(), createWithInitialPayment: vi.fn(), getById: vi.fn(), saveForRetry: vi.fn() },
  shifts: { getActiveByTerminalLoose: vi.fn() },
} }))
vi.mock('../../lib', async importOriginal => ({ ...await importOriginal<typeof import('../../lib')>(), getBridge: () => bridge }))
vi.mock('../../lib/platform-detect', async importOriginal => ({ ...await importOriginal<typeof import('../../lib/platform-detect')>(), isBrowser: () => false, isTauri: () => true }))
import { OrderService } from '../OrderService'
import { setStoreCurrencyFromSettings } from '../../renderer/utils/store-currency'
const payload = () => ({ clientRequestId:'folio-checkout-1',items:[{name:'Coffee',quantity:1,price:3,is_manual:true}],totalAmount:3,total_amount:3,order_type:'dine-in',room_id:'room-1',payment_method:'room_charge',initialPayment:{method:'room_charge',amount:3,currency:'CHF'} })
beforeEach(() => {
  setStoreCurrencyFromSettings({'terminal.branch_id':'branch-1','restaurant.store_currency_branch_id':'branch-1','restaurant.store_currency_available':true,'restaurant.store_currency_source':'branch_country','restaurant.currency':'CHF'})
  bridge.orders.create.mockResolvedValue({ success:true,orderId:'local-1' })
  bridge.orders.getById.mockResolvedValue({id:'local-1',payment_status:'pending'})
})
describe('room charge checkout persistence', () => {
  it('allows native idempotency to recover an original room checkout after the current country changes', async () => {
    setStoreCurrencyFromSettings({'terminal.branch_id':'branch-1','restaurant.store_currency_branch_id':'branch-1','restaurant.store_currency_available':true,'restaurant.store_currency_source':'branch_country','restaurant.currency':'EUR'})
    bridge.orders.create.mockResolvedValueOnce({success:true,orderId:'local-1',deduplicated:true})
    bridge.orders.getById.mockResolvedValueOnce({id:'local-1',currency:'CHF',payment_status:'pending'})
    const original = await OrderService.getInstance().createOrder(payload() as any)
    expect(original).toMatchObject({id:'local-1',currency:'CHF'})
    expect(bridge.orders.create).toHaveBeenCalledWith(expect.objectContaining({currency:'CHF',ghost_metadata:{room_charge:{currency:'CHF',room_id:'room-1'}}}))
    expect(bridge.orders.saveForRetry).not.toHaveBeenCalled()
  })
  it('keeps a shift currency rejection final without creating a retry order', async () => {
    bridge.orders.create.mockResolvedValueOnce({success:false,error:'SHIFT_CURRENCY_MISMATCH'})
    await expect(OrderService.getInstance().createOrder(payload() as any)).rejects.toThrow('SHIFT_CURRENCY_MISMATCH')
    expect(bridge.orders.saveForRetry).not.toHaveBeenCalled()
  })
  it('persists a pending order and original unit without fabricating a local tender or claiming folio applied', async () => {
    const order = await OrderService.getInstance().createOrder(payload() as any)
    expect(bridge.orders.createWithInitialPayment).not.toHaveBeenCalled()
    expect(bridge.orders.create).toHaveBeenCalledWith(expect.objectContaining({currency:'CHF',ghost_metadata:{room_charge:{currency:'CHF',room_id:'room-1'}},initialPayment:undefined}))
    expect(order).toMatchObject({payment_status:'pending',roomCharge:{pending:true}})
  })
  it('retains native unknown-currency admission as final without any offline retry write', async () => {
    bridge.orders.create.mockResolvedValueOnce({success:false,error:'STORE_CURRENCY_UNAVAILABLE'})
    setStoreCurrencyFromSettings({})
    await expect(OrderService.getInstance().createOrder(payload() as any)).rejects.toThrow('STORE_CURRENCY_UNAVAILABLE')
    expect(bridge.orders.create).toHaveBeenCalledTimes(1)
    expect(bridge.orders.saveForRetry).not.toHaveBeenCalled()
  })
})
