import {
  buildTableSessionPaymentPayload,
  buildTableOrderCreateFields,
  buildOrderServiceTableMetadata,
  buildOptimisticOccupiedTable,
  findOpenTableOrderForTable,
  getTableNumberForTableServiceOrder,
  isTableServiceOrder,
  isUnsettledOrderPaymentStatus,
  normalizeTableNumberForMatch,
  shouldShowInStandardOrderLane,
  shouldBypassPaymentForTableOrder,
} from '../../src/renderer/utils/tableOrderFlow'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

describe('table order flow helpers', () => {
  it('bypasses checkout payment for dine-in table orders', () => {
    assert.equal(shouldBypassPaymentForTableOrder({
      orderType: 'dine-in',
      tableNumber: '5',
      editMode: false,
      ghostMode: false,
    }), true)
  })

  it('builds durable table-service fields for order creation', () => {
    assert.deepEqual(
      buildTableOrderCreateFields({
        serviceOrderType: 'dine-in',
        pricingOrderType: 'pickup',
        table: {
          id: 'table-5',
          tableNumber: 5,
          currentOrderId: 'order-previous',
        },
        guestCount: 3,
      }),
      {
        order_type: 'dine-in',
        table_number: '5',
        table_id: 'table-5',
        table_session_id: null,
        guest_count: 3,
        payment_method: null,
        payment_status: 'pending',
      },
    )
  })

  it('builds table-session payment payloads with tips and seats', () => {
    assert.deepEqual(
      buildTableSessionPaymentPayload({
        orderId: 'order-1',
        tableSessionId: 'session-1',
        amount: 42.5,
        method: 'card',
        tipAmount: 5,
        seatNumber: 2,
        idempotencyKey: 'pay-1',
      }),
      {
        order_id: 'order-1',
        table_session_id: 'session-1',
        amount: 42.5,
        amount_cents: 4250,
        payment_method: 'card',
        tip_amount: 5,
        tip_amount_cents: 500,
        seat_number: 2,
        idempotency_key: 'pay-1',
      },
    )
  })

  it('adds integer cents to table-session item payments', () => {
    assert.deepEqual(
      buildTableSessionPaymentPayload({
        orderId: 'order-1',
        tableSessionId: 'session-1',
        amount: 11,
        method: 'cash',
        items: [{ itemIndex: 0, item_name: 'Toast', item_amount: 11 }],
      }),
      {
        order_id: 'order-1',
        table_session_id: 'session-1',
        amount: 11,
        amount_cents: 1100,
        payment_method: 'cash',
        tip_amount: 0,
        tip_amount_cents: 0,
        seat_number: null,
        idempotency_key: undefined,
        items: [{ itemIndex: 0, item_name: 'Toast', item_amount: 11, item_amount_cents: 1100 }],
      },
    )
  })

  it('keeps dine-in checks out of the standard order lane', () => {
    assert.equal(shouldShowInStandardOrderLane({
      id: 'order-1',
      status: 'pending',
      order_type: 'dine-in',
      table_id: 'table-1',
      table_number: '1',
    }), false)

    assert.equal(shouldShowInStandardOrderLane({
      id: 'order-2',
      status: 'pending',
      orderType: 'pickup',
    }), true)
  })

  it('recognizes legacy table-labeled orders as table-service checks', () => {
    assert.equal(isTableServiceOrder({
      id: 'order-legacy',
      orderType: 'pickup',
      tableNumber: 'T1',
    }), true)
  })

  it('normalizes table labels for order/table grid matching', () => {
    assert.equal(normalizeTableNumberForMatch('T1'), '1')
    assert.equal(normalizeTableNumberForMatch('#T1'), '1')
    assert.equal(normalizeTableNumberForMatch('Τραπέζι T1'), '1')
    assert.equal(normalizeTableNumberForMatch(1), '1')
  })

  it('finds a local pending table check when the table label includes T-prefixes', () => {
    const order = {
      id: 'order-1',
      status: 'pending',
      orderType: 'dine-in',
      tableNumber: 'T1',
      customerName: 'Τραπέζι T1',
      createdAt: '2026-05-20T10:00:00.000Z',
    }

    assert.equal(
      findOpenTableOrderForTable([order], {
        id: 'table-1',
        tableNumber: 'T1',
        currentOrderId: null,
      }),
      order,
    )
  })

  it('does not reopen paid table-labeled orders as active checks', () => {
    const paidOrder = {
      id: 'order-paid',
      status: 'pending',
      orderType: 'pickup',
      paymentStatus: 'paid',
      customerName: 'Τραπέζι T1',
      createdAt: '2026-05-20T11:00:00.000Z',
    }
    const pendingTableOrder = {
      id: 'order-pending',
      status: 'pending',
      orderType: 'dine-in',
      paymentStatus: 'pending',
      tableNumber: 'T1',
      createdAt: '2026-05-20T10:00:00.000Z',
    }

    assert.equal(isUnsettledOrderPaymentStatus(paidOrder), false)
    assert.equal(
      findOpenTableOrderForTable([paidOrder, pendingTableOrder], {
        id: 'table-1',
        tableNumber: 'T1',
      }),
      pendingTableOrder,
    )
  })

  it('recognizes orphaned table customer labels as table-service checks', () => {
    const orphanedOrder = {
      id: 'order-orphaned',
      status: 'pending',
      orderType: 'pickup',
      customerName: 'Τραπέζι T1',
    }

    assert.equal(isTableServiceOrder(orphanedOrder), true)
    assert.equal(shouldShowInStandardOrderLane(orphanedOrder), false)
    assert.equal(getTableNumberForTableServiceOrder(orphanedOrder), '1')
  })

  it('builds an optimistic occupied table after saving a check', () => {
    assert.deepEqual(
      buildOptimisticOccupiedTable({
        id: 'table-1',
        status: 'available',
        tableNumber: 1,
        capacity: 4,
      }, {
        orderId: 'order-1',
        tableSessionId: 'session-1',
        guestCount: 2,
        occupiedSince: '2026-05-20T10:00:00.000Z',
      }),
      {
        id: 'table-1',
        status: 'occupied',
        tableNumber: 1,
        capacity: 4,
        currentOrderId: 'order-1',
        tableSessionId: 'session-1',
        guestCount: 2,
        occupiedSince: '2026-05-20T10:00:00.000Z',
      },
    )
  })

  it('normalizes table metadata for the desktop order service payloads', () => {
    assert.deepEqual(
      buildOrderServiceTableMetadata({
        order_type: 'dine-in',
        table_id: 'table-1',
        table_number: '1',
        tableSessionId: 'session-1',
        guestCount: 4,
      }),
      {
        tableNumber: '1',
        table_number: '1',
        tableId: 'table-1',
        table_id: 'table-1',
        tableSessionId: 'session-1',
        table_session_id: 'session-1',
        guestCount: 4,
        guest_count: 4,
      },
    )
  })
})
