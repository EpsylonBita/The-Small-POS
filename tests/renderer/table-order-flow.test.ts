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
import {
  applyTableCheckOrderLevelDiscount,
  buildUnpaidAmountByItemId,
  mergeRemoteTableCheckItemsWithLocalAdjustments,
  resolveTableCheckOrderTotal,
  resolveTableCheckItemDiscount,
  scopeTableCheckItemsToActiveAllocations,
  sumTableCheckLineTotals,
  sumTableCheckItemDiscounts,
} from '../../src/renderer/utils/tableCheckPayments'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const tableCheckManagerSourcePath = path.join(
  process.cwd(),
  'src',
  'renderer',
  'components',
  'tables',
  'TableCheckManagerModal.tsx',
)

const tableCheckOverlayPath = (locale: string) => path.join(
  process.cwd(),
  'src',
  'locales',
  'overlays',
  `${locale}.table-check.json`,
)

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

  it('uses local discounted table-check totals over stale remote session totals', () => {
    assert.equal(
      resolveTableCheckOrderTotal({
        remoteTotal: 31.5,
        localTotal: 29.4,
        hasLocalOrderItems: true,
      }),
      29.4,
    )
  })

  it('projects order-level table discounts onto check item totals', () => {
    const items = applyTableCheckOrderLevelDiscount<any>(
      [{
        id: 'breakfast',
        quantity: 1,
        unit_price: 18.5,
        unitPrice: 18.5,
        total_price: 18.5,
        totalPrice: 18.5,
      }],
      16.65,
    )

    assert.equal(items[0]?.unit_price, 16.65)
    assert.equal(items[0]?.total_price, 16.65)
    assert.equal(items[0]?.original_unit_price, 18.5)
    assert.equal(resolveTableCheckItemDiscount(items[0] || {}), 1.85)
    assert.equal(sumTableCheckLineTotals(items), 16.65)
  })

  it('keeps a discounted table account consistent across balance, unpaid items and payment default', () => {
    // Live repro: Alpine Breakfast Plate EUR 18.50 with an order-level 10% discount
    // (EUR 1.85) -> order total EUR 16.65. The line carries no per-line discount;
    // the discount lives on the order total. Rebuilding the check must NOT resurrect
    // EUR 18.50 in the balance, the unpaid item, or the payment default.
    const items = applyTableCheckOrderLevelDiscount<any>(
      [{
        id: 'alpine',
        quantity: 1,
        unit_price: 18.5,
        unitPrice: 18.5,
        total_price: 18.5,
        totalPrice: 18.5,
      }],
      16.65,
    )

    // Table account balance == discounted order total.
    assert.equal(sumTableCheckLineTotals(items), 16.65)
    // The discount is surfaced as an explicit discount, not hidden.
    assert.equal(sumTableCheckItemDiscounts(items), 1.85)

    const itemLineTotal = (item: any) => Number(item.total_price ?? item.totalPrice ?? 0)
    // Per-item unpaid (no payments yet) == discounted line, not EUR 18.50.
    const unpaid = buildUnpaidAmountByItemId(items as any, [], 0, itemLineTotal)
    assert.equal(unpaid.get('alpine'), 16.65)

    // Payment default == outstanding balance (order total - paid) == EUR 16.65.
    const outstanding = Number(Math.max(0, sumTableCheckLineTotals(items) - 0).toFixed(2))
    assert.equal(outstanding, 16.65)
  })

  it('distributes an order-level table discount proportionally across multiple lines', () => {
    // EUR 10 + EUR 20 = EUR 30 subtotal, 10% order-level discount -> EUR 27 total.
    const items = applyTableCheckOrderLevelDiscount<any>(
      [
        { id: 'a', quantity: 1, unit_price: 10, unitPrice: 10, total_price: 10, totalPrice: 10 },
        { id: 'b', quantity: 1, unit_price: 20, unitPrice: 20, total_price: 20, totalPrice: 20 },
      ],
      27,
    )

    assert.equal(items[0]?.total_price, 9)
    assert.equal(items[1]?.total_price, 18)
    assert.equal(sumTableCheckLineTotals(items), 27)
    assert.equal(sumTableCheckItemDiscounts(items), 3)

    const itemLineTotal = (item: any) => Number(item.total_price ?? item.totalPrice ?? 0)
    const unpaid = buildUnpaidAmountByItemId(items as any, [], 0, itemLineTotal)
    assert.equal(unpaid.get('a'), 9)
    assert.equal(unpaid.get('b'), 18)
  })

  it('leaves an undiscounted table check untouched (no phantom discount)', () => {
    const items = applyTableCheckOrderLevelDiscount<any>(
      [{ id: 'a', quantity: 1, unit_price: 18.5, unitPrice: 18.5, total_price: 18.5, totalPrice: 18.5 }],
      18.5,
    )
    assert.equal(sumTableCheckLineTotals(items), 18.5)
    assert.equal(sumTableCheckItemDiscounts(items), 0)
    assert.equal(items[0]?.total_price, 18.5)
  })

  it('TableCheckManagerModal distributes the order-level discount when rebuilding the check', () => {
    const source = readFileSync(tableCheckManagerSourcePath, 'utf8')
    // The single display derivation distributes the order-level discount onto items...
    assert.match(source, /applyTableCheckOrderLevelDiscount\(\s*items,\s*target\s*\)/)
    // ...and the session merge recomputes the order total from the discounted lines.
    assert.match(source, /applyTableCheckOrderLevelDiscount\(mergedOrderItems \|\| \[\], authoritativeOrderTotal\)/)
    assert.match(source, /const orderTotal = hasRemoteAllocationScope[\s\S]*?sumTableCheckLineTotals\(discountedOrderItems\)/)
  })

  it('localizes the table-check discount labels used by discounted accounts', () => {
    const expectedByLocale = {
      en: { discount: 'Discount', discountAmount: 'Discount {{amount}}' },
      el: { discount: 'Έκπτωση', discountAmount: 'Έκπτωση {{amount}}' },
      de: { discount: 'Rabatt', discountAmount: 'Rabatt {{amount}}' },
      fr: { discount: 'Remise', discountAmount: 'Remise {{amount}}' },
      it: { discount: 'Sconto', discountAmount: 'Sconto {{amount}}' },
    } as const

    for (const [locale, expected] of Object.entries(expectedByLocale)) {
      const overlay = JSON.parse(readFileSync(tableCheckOverlayPath(locale), 'utf8'))
      assert.equal(overlay.tableCheckManager.labels.discount, expected.discount)
      assert.equal(overlay.tableCheckManager.labels.discountAmount, expected.discountAmount)
    }
  })

  it('carries overpaid discounted item payments into the remaining table balance', () => {
    const unpaidByItemId = buildUnpaidAmountByItemId(
      [
        { id: 'pizza', total: 18.9 },
        { id: 'fondant', total: 10.5 },
      ],
      [{ itemIndex: 0, itemAmount: 21 }],
      21,
      item => item.total,
    )

    assert.equal(unpaidByItemId.get('pizza'), 0)
    assert.equal(unpaidByItemId.get('fondant'), 8.4)
  })

  it('surfaces table-check item discounts from price overrides', () => {
    assert.equal(
      resolveTableCheckItemDiscount({
        quantity: 1,
        original_unit_price: 21,
        unit_price: 18.9,
        total_price: 18.9,
      }),
      2.1,
    )

    assert.equal(
      sumTableCheckItemDiscounts([
        {
          quantity: 1,
          original_unit_price: 21,
          unit_price: 18.9,
          total_price: 18.9,
        },
        {
          quantity: 1,
          unit_price: 10.5,
          total_price: 10.5,
        },
      ]),
      2.1,
    )
  })

  it('keeps remote order item ids when applying local table-check adjustments', () => {
    const items = mergeRemoteTableCheckItemsWithLocalAdjustments(
      [
        {
          id: 'aaaaaaaa-aaaa-4aaa-9aaa-aaaaaaaaaaaa',
          menu_item_id: 'menu-cheese',
          name: 'Swiss Cheese Board',
          quantity: 1,
          unit_price: 24,
          total_price: 24,
        },
      ],
      [
        {
          id: 'menu-cheese',
          menu_item_id: 'menu-cheese',
          name: 'Swiss Cheese Board',
          quantity: 1,
          unit_price: 22,
          total_price: 22,
          original_unit_price: 24,
          discount: 2,
        },
      ],
    )

    assert.equal(items[0]?.id, 'aaaaaaaa-aaaa-4aaa-9aaa-aaaaaaaaaaaa')
    assert.equal(items[0]?.menu_item_id, 'menu-cheese')
    assert.equal(items[0]?.unit_price, 22)
    assert.equal(items[0]?.total_price, 22)
    assert.equal(items[0]?.original_unit_price, 24)
    assert.equal(items[0]?.discount, 2)
  })

  it('scopes split table checks to active allocation rows before applying local discounts', () => {
    const parentOrderItems = [
      {
        id: 'aaaaaaaa-aaaa-4aaa-9aaa-aaaaaaaaaaaa',
        menu_item_id: 'menu-cheese',
        name: 'Swiss Cheese Board',
        quantity: 1,
        unit_price: 22,
        total_price: 22,
      },
      {
        id: 'bbbbbbbb-bbbb-4bbb-9bbb-bbbbbbbbbbbb',
        menu_item_id: 'menu-burger',
        name: 'Gemini Burger',
        quantity: 1,
        unit_price: 24,
        total_price: 24,
      },
      {
        id: 'cccccccc-cccc-4ccc-9ccc-cccccccccccc',
        menu_item_id: 'menu-chicken',
        name: 'Roast Chicken Plate',
        quantity: 1,
        unit_price: 27,
        total_price: 27,
      },
    ]
    const localDiscountedParentItems = [
      {
        id: 'local-cheese',
        menu_item_id: 'menu-cheese',
        name: 'Swiss Cheese Board',
        quantity: 1,
        unit_price: 19.8,
        total_price: 19.8,
        original_unit_price: 22,
        discount: 2.2,
      },
      ...parentOrderItems.slice(1),
    ]

    const sourceItems = scopeTableCheckItemsToActiveAllocations(parentOrderItems, [
      { order_item_id: parentOrderItems[0].id, quantity: 1, status: 'transferred' },
      { order_item_id: parentOrderItems[1].id, quantity: 1, status: 'open' },
      { order_item_id: parentOrderItems[2].id, quantity: 1, status: 'open' },
    ])
    assert.deepEqual(sourceItems.map(item => item.name), ['Gemini Burger', 'Roast Chicken Plate'])
    assert.equal(sumTableCheckLineTotals(sourceItems), 51)

    const targetItems = mergeRemoteTableCheckItemsWithLocalAdjustments(
      scopeTableCheckItemsToActiveAllocations(parentOrderItems, [
        { order_item_id: parentOrderItems[0].id, quantity: 1, status: 'open' },
      ]),
      localDiscountedParentItems,
    )

    assert.equal(targetItems.length, 1)
    assert.equal(targetItems[0]?.id, parentOrderItems[0].id)
    assert.equal(targetItems[0]?.total_price, 19.8)
    assert.equal(resolveTableCheckItemDiscount(targetItems[0]!), 2.2)
    assert.equal(sumTableCheckLineTotals(targetItems), 19.8)
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

  it('prefers a synced remote order id when reopening a missing table session', () => {
    const payload = buildTableSessionOpenPayload({
      table: {
        id: '55555555-5555-4555-9555-555555555555',
        tableNumber: 'B01',
      },
      orderId: '11111111-1111-4111-9111-111111111111',
      orderData: {
        id: '11111111-1111-4111-9111-111111111111',
        supabase_id: '22222222-2222-4222-9222-222222222222',
      },
      guestCount: 1,
      customerName: 'Table B01',
    })

    assert.equal(payload.active_order_id, '22222222-2222-4222-9222-222222222222')
    assert.equal(payload.active_order_client_id, '11111111-1111-4111-9111-111111111111')
    assert.equal(payload.client_order_id, '11111111-1111-4111-9111-111111111111')
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

  it('builds optimistic table balance from a newly saved unpaid check', () => {
    assert.deepEqual(
      buildOptimisticOccupiedTable({
        id: 'table-55',
        status: 'available',
        tableNumber: 55,
        capacity: 4,
      }, {
        orderId: 'order-55',
        tableSessionId: 'session-55',
        guestCount: 2,
        occupiedSince: '2026-06-19T07:53:00.000Z',
        orderTotal: 55,
        paidTotal: 0,
      }),
      {
        id: 'table-55',
        status: 'occupied',
        tableNumber: 55,
        capacity: 4,
        currentOrderId: 'order-55',
        tableSessionId: 'session-55',
        guestCount: 2,
        occupiedSince: '2026-06-19T07:53:00.000Z',
        unpaidBalance: 55,
        balance: {
          order_total: 55,
          paid_total: 0,
          tip_total: 0,
          outstanding_balance: 55,
          payment_status: 'pending',
        },
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

  it('builds an immediately cleaning table projection after closing a settled check', () => {
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
      }, 'cleaning'),
      {
        id: 'table-1',
        status: 'cleaning',
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

  it('closes the check modal and releases the table to cleaning after a final payment', () => {
    const source = readFileSync(tableCheckManagerSourcePath, 'utf8')

    assert.match(source, /const closeSettledTableAfterPayment = async \(\) =>/)
    assert.match(source, /release_status:\s*'cleaning'/)
    assert.match(source, /force:\s*true/)
    assert.match(source, /emitCompatEvent\('table-session-settled'[\s\S]*releaseStatus:\s*'cleaning'/)
    assert.match(source, /onClose\(\)/)
  })

  it('queues close when the server still has a stale outstanding table balance', () => {
    const source = readFileSync(tableCheckManagerSourcePath, 'utf8')

    assert.match(source, /function isOutstandingTableSessionBalanceError\(error: unknown\): boolean/)
    assert.match(source, /cannot close a table session with an outstanding balance/)
    assert.match(source, /normalized\.includes\('outstanding_balance'\)[\s\S]*normalized\.includes\('paid_total'\)/)
    assert.match(source, /isRetryableTableServiceError\(error\)\s*\|\|\s*isOutstandingTableSessionBalanceError\(error\)/)
    assert.match(source, /await enqueueTableSessionUpdate\([\s\S]*release_status:\s*'cleaning'/)
  })

  it('repairs a missing table session from the matched local table order before item transfer', () => {
    const source = readFileSync(tableCheckManagerSourcePath, 'utf8')

    assert.match(source, /localOrderRepairId = localOrder/)
    assert.match(source, /const repairOrderReference = table\.currentOrderId \|\| localOrderRepairId/)
    assert.match(source, /if \(!sessionId && repairOrderReference\)/)
    assert.match(source, /orderId: repairOrderReference/)
  })

  it('builds local table check sessions through order-level discount projection', () => {
    const source = readFileSync(tableCheckManagerSourcePath, 'utf8')

    assert.match(source, /applyTableCheckOrderLevelDiscount/)
    assert.match(
      source,
      /const orderItems = applyTableCheckOrderLevelDiscount\(localOrderItems\(order, itemFallback\), orderTotal\)/,
    )
  })

  it('sends effective item pricing when transferring discounted table items', () => {
    const source = readFileSync(tableCheckManagerSourcePath, 'utf8')

    assert.match(source, /const buildTransferPricingPayload = \(/)
    assert.match(source, /effective_unit_price: effectiveUnitPrice/)
    assert.match(source, /effective_total_price: effectiveTotalPrice/)
    assert.match(source, /discount_amount: discountAmount/)
    assert.match(source, /\.\.\.buildTransferPricingPayload\(selectedTransferItem, requestedQuantity\)/)
    assert.match(source, /\.\.\.buildTransferPricingPayload\(entry\.item, entry\.itemQuantity\)/)
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

  it('keeps a release override while a stale refetch still reports the table occupied', () => {
    const releaseOverride = {
      status: 'cleaning',
      currentOrderId: undefined,
      tableSessionId: null,
      unpaidBalance: 0,
      balance: null,
      __released: true,
    }

    // A stale read-after-write refetch still shows the table occupied/unpaid:
    // keep the optimistic release so the settled table does not reappear.
    assert.equal(
      shouldApplyOptimisticTableOverride(
        {
          id: 'tp01',
          status: 'occupied',
          tableNumber: 'TP01',
          currentOrderId: 'order-1',
          tableSessionId: 'session-1',
          unpaidBalance: 18.5,
          balance: { order_total: 18.5, outstanding_balance: 18.5 },
        },
        releaseOverride,
      ),
      true,
    )

    // Once the server reflects the released table (cleaning), drop the override.
    assert.equal(
      shouldApplyOptimisticTableOverride(
        {
          id: 'tp01',
          status: 'cleaning',
          tableNumber: 'TP01',
          currentOrderId: null,
          tableSessionId: null,
          unpaidBalance: 0,
          balance: null,
        },
        releaseOverride,
      ),
      false,
    )

    // A server release to available also drops it.
    assert.equal(
      shouldApplyOptimisticTableOverride(
        {
          id: 'tp01',
          status: 'available',
          tableNumber: 'TP01',
          currentOrderId: null,
          tableSessionId: null,
          unpaidBalance: 0,
          balance: null,
        },
        releaseOverride,
      ),
      false,
    )
  })

  it('persists a release override in useTables so a stale refetch cannot resurrect a settled table', () => {
    const source = readFileSync(
      path.join(process.cwd(), 'src', 'renderer', 'hooks', 'useTables.ts'),
      'utf8',
    )

    // The table-session-settled handler stores a durable release override (not just
    // a one-shot setTables that the immediate refetch would clobber).
    assert.match(source, /optimisticTableOverridesRef\.current\[tableId\] = \{/)
    assert.match(source, /__released: true,/)

    // The merge applies the released projection wholesale while the override is active.
    assert.match(source, /\(override as Record<string, unknown>\)\.__released === true/)
    assert.match(source, /return buildReleasedTableAfterSettlement\(\s*table,/)
  })

  it('keeps a reserved -> available release override through a stale refetch that still reports reserved', () => {
    const releaseOverride = {
      status: 'available',
      currentOrderId: undefined,
      tableSessionId: null,
      unpaidBalance: 0,
      balance: null,
      __released: true,
    }

    // Live bug: after releasing a stale reserved table, the immediate refetch can
    // still report it reserved. Keep the optimistic release so #TP01 leaves the
    // reserved filter instead of being resurrected.
    assert.equal(
      shouldApplyOptimisticTableOverride(
        {
          id: 'tp01',
          status: 'reserved',
          tableNumber: 'TP01',
          currentOrderId: null,
          tableSessionId: null,
          unpaidBalance: 0,
          balance: null,
        },
        releaseOverride,
      ),
      true,
    )

    // The merged projection shows the table available, not reserved.
    assert.equal(
      buildReleasedTableAfterSettlement(
        { id: 'tp01', status: 'reserved', tableNumber: 'TP01' },
        'available',
      ).status,
      'available',
    )

    // A stale occupied read (the other active prior status) is also kept.
    assert.equal(
      shouldApplyOptimisticTableOverride(
        {
          id: 'tp01',
          status: 'occupied',
          tableNumber: 'TP01',
          currentOrderId: 'order-1',
          tableSessionId: 'session-1',
        },
        releaseOverride,
      ),
      true,
    )

    // Once the server reflects available, drop the override (no permanent mask).
    assert.equal(
      shouldApplyOptimisticTableOverride(
        {
          id: 'tp01',
          status: 'available',
          tableNumber: 'TP01',
          currentOrderId: null,
          tableSessionId: null,
          unpaidBalance: 0,
          balance: null,
        },
        releaseOverride,
      ),
      false,
    )
  })

  it('useTables stores a durable release override (not a delete) when a table is released', () => {
    const source = readFileSync(
      path.join(process.cwd(), 'src', 'renderer', 'hooks', 'useTables.ts'),
      'utf8',
    )

    // An explicit __release request is recognized and the client-only flag is
    // stripped from the server payload.
    assert.match(
      source,
      /const releaseRequested\s*=\s*workflow\.__release === true && \(status === 'available' \|\| status === 'cleaning'\)/,
    )
    assert.match(source, /delete workflowForServer\.__release/)
    assert.match(source, /\{ status, \.\.\.workflowForServer \}/)

    // The release branch stores a surviving __released override instead of deleting it,
    // and projects the released table optimistically.
    assert.match(
      source,
      /\} else if \(releaseRequested\) \{[\s\S]*?optimisticTableOverridesRef\.current\[tableId\] = \{[\s\S]*?__released: true,/,
    )
    assert.match(source, /releaseRequested[\s\S]*?buildReleasedTableAfterSettlement\(\s*table,/)

    // On failure the optimistic release override is dropped so it cannot mask a failed write.
    assert.match(
      source,
      /if \(releaseRequested\) \{\s*delete optimisticTableOverridesRef\.current\[tableId\];\s*\}/,
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
