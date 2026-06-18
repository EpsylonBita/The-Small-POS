import {
  buildTableSessionPaymentPayload,
  buildTableOrderCreateFields,
  buildOrderServiceTableMetadata,
  buildTableSessionOpenPayload,
  buildOptimisticOccupiedTable,
  buildReleasedTableAfterSettlement,
  findOpenTableOrderForTable,
  findTableOrderForTable,
  getTableNumberForTableServiceOrder,
  isTableServiceOrder,
  isUnsettledOrderPaymentStatus,
  normalizeTableNumberForMatch,
  shouldShowInStandardOrderLane,
  shouldBypassPaymentForTableOrder,
  isUuidLike,
  shouldApplyOptimisticTableOverride,
  tableHasOpenCheckReference,
  resolveTableDisplayStatus,
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

  it('builds table-session open payloads with a server-resolvable client order reference', () => {
    const payload = buildTableSessionOpenPayload({
      table: {
        id: '55555555-5555-4555-9555-555555555555',
        tableNumber: 'T05',
      },
      orderId: '11111111-1111-4111-9111-111111111111',
      orderData: {
        clientRequestId: 'client-request-table-t05',
      },
      guestCount: 4,
      customerName: 'Table T05',
    })

    assert.equal(payload.active_order_id, '11111111-1111-4111-9111-111111111111')
    assert.equal(payload.active_order_client_id, 'client-request-table-t05')
    assert.equal(payload.client_order_id, 'client-request-table-t05')
    assert.equal(payload.client_request_id, 'client-request-table-t05')
    assert.equal(payload.client_event_id, 'pos-tauri-table-session-client-request-table-t05')
  })

  it('does not put non-UUID local order references in active_order_id', () => {
    const payload = buildTableSessionOpenPayload({
      table: {
        id: '55555555-5555-4555-9555-555555555555',
        tableNumber: 5,
      },
      orderId: 'local-table-order-5',
      orderResult: {
        client_order_id: 'client-order-5',
      },
      guestCount: 2,
    })

    assert.equal(isUuidLike('local-table-order-5'), false)
    assert.equal(payload.active_order_id, null)
    assert.equal(payload.active_order_client_id, 'client-order-5')
    assert.equal(payload.client_order_id, 'client-order-5')
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

  it('matches a local table check by camelCase Supabase order id before payment', () => {
    const localOrder = {
      id: 'local-order-1',
      supabaseId: 'remote-order-1',
      orderNumber: 'ORD-LOCAL-1',
      status: 'pending',
      orderType: 'dine-in',
      paymentStatus: 'pending',
      createdAt: '2026-06-17T20:32:12.000Z',
    }

    assert.equal(
      findOpenTableOrderForTable([localOrder], {
        id: 'table-1',
        tableNumber: 'T05',
        currentOrderId: 'remote-order-1',
      }),
      localOrder,
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

  it('can recover the current settled table check for the check modal fallback', () => {
    const paidOrder = {
      id: 'order-paid',
      status: 'pending',
      orderType: 'dine-in',
      paymentStatus: 'paid',
      tableNumber: 'T1',
      createdAt: '2026-05-20T11:00:00.000Z',
    }

    const table = {
      id: 'table-1',
      tableNumber: 'T1',
      currentOrderId: 'order-paid',
    }

    assert.equal(findOpenTableOrderForTable([paidOrder], table), null)
    assert.equal(findTableOrderForTable([paidOrder], table), paidOrder)
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

  it('builds an immediately released table projection after full settlement', () => {
    assert.deepEqual(
      buildReleasedTableAfterSettlement({
        id: 'table-1',
        status: 'occupied',
        tableNumber: 'T05',
        capacity: 4,
        currentOrderId: 'order-paid',
        tableSessionId: 'session-paid',
        guestCount: 4,
        occupiedSince: '2026-06-18T10:00:00.000Z',
        unpaidBalance: 0,
        balance: {
          order_total: 22,
          paid_total: 22,
          outstanding_balance: 0,
          payment_status: 'paid',
        },
      }),
      {
        id: 'table-1',
        status: 'available',
        tableNumber: 'T05',
        capacity: 4,
        currentOrderId: undefined,
        tableSessionId: null,
        guestCount: null,
        occupiedSince: undefined,
        unpaidBalance: 0,
        balance: null,
      },
    )
  })

  it('does not treat occupied-only tables as open checks', () => {
    assert.equal(
      tableHasOpenCheckReference({
        id: 'table-b03',
        status: 'occupied',
        tableNumber: 'B03',
        currentOrderId: null,
        tableSessionId: null,
        unpaidBalance: 0,
        balance: null,
      }),
      false,
    )
  })

  it('treats tables with check references or balances as open checks', () => {
    assert.equal(
      tableHasOpenCheckReference({
        id: 'table-1',
        tableNumber: '1',
        currentOrderId: 'order-1',
      }),
      true,
    )
    assert.equal(
      tableHasOpenCheckReference({
        id: 'table-2',
        tableNumber: '2',
        tableSessionId: 'session-2',
      }),
      true,
    )
    assert.equal(
      tableHasOpenCheckReference({
        id: 'table-3',
        tableNumber: '3',
        balance: { order_total: 42, outstanding_balance: 42 },
      }),
      true,
    )
  })

  it('does not treat a fully paid table-session balance as an open check', () => {
    assert.equal(
      tableHasOpenCheckReference({
        id: 'table-paid',
        status: 'occupied',
        tableNumber: 'T05',
        currentOrderId: 'order-paid',
        tableSessionId: 'session-paid',
        unpaidBalance: 0,
        balance: {
          order_total: 22,
          paid_total: 22,
          outstanding_balance: 0,
          payment_status: 'paid',
        },
      }),
      false,
    )
    assert.equal(
      resolveTableDisplayStatus({
        id: 'table-paid',
        status: 'occupied',
        tableNumber: 'T05',
        currentOrderId: 'order-paid',
        tableSessionId: 'session-paid',
        unpaidBalance: 0,
        balance: {
          order_total: 22,
          paid_total: 22,
          outstanding_balance: 0,
          payment_status: 'paid',
        },
      }),
      'available',
    )
  })

  it('drops stale occupied optimistic overrides when the server releases a table', () => {
    assert.equal(
      shouldApplyOptimisticTableOverride(
        {
          id: 'table-1',
          status: 'available',
          tableNumber: 'T05',
          currentOrderId: null,
          tableSessionId: null,
          balance: null,
          unpaidBalance: 0,
        },
        {
          status: 'occupied',
          currentOrderId: 'order-paid',
          tableSessionId: 'session-paid',
        },
      ),
      false,
    )
    assert.equal(
      shouldApplyOptimisticTableOverride(
        {
          id: 'table-1',
          status: 'occupied',
          tableNumber: 'T05',
          currentOrderId: 'order-open',
          tableSessionId: 'session-open',
        },
        {
          status: 'occupied',
          currentOrderId: 'order-open',
          tableSessionId: 'session-open',
        },
      ),
      true,
    )
  })

  it('shows occupied-only tables as available in table cards', () => {
    assert.equal(
      resolveTableDisplayStatus({
        id: 'table-b03',
        status: 'occupied',
        tableNumber: 'B03',
        currentOrderId: null,
        tableSessionId: null,
        unpaidBalance: 0,
        balance: null,
      }),
      'available',
    )
  })

  it('keeps occupied display status when a table has an open check reference', () => {
    assert.equal(
      resolveTableDisplayStatus({
        id: 'table-1',
        status: 'occupied',
        tableNumber: '1',
        tableSessionId: 'session-1',
      }),
      'occupied',
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
