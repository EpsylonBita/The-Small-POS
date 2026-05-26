import test from 'node:test';
import assert from 'node:assert/strict';

import { deriveEditSettlementFinancials } from '../../src/renderer/utils/editSettlementFinancials';

test('deriveEditSettlementFinancials preserves an existing order discount across add/remove edits', () => {
  const discountedPaidOrder = {
    total_amount: 7.29,
    subtotal: 8.79,
    discount_amount: 1.5,
    discount_percentage: 0,
    tax_amount: 0,
    delivery_fee: 0,
    tip_amount: 0,
  };

  const originalItems = [
    { name: 'Light', quantity: 1, unit_price: 5.3, total_price: 5.3 },
    { name: 'Snickers', quantity: 2, unit_price: 1.7, total_price: 3.4 },
    { name: 'Bag', quantity: 1, unit_price: 0.09, total_price: 0.09 },
  ];
  const withAddedSpecial = [
    ...originalItems,
    { name: 'Special', quantity: 1, unit_price: 6, total_price: 6 },
  ];

  const afterAdd = deriveEditSettlementFinancials(
    discountedPaidOrder,
    withAddedSpecial,
    'pickup',
  );
  const afterRemove = deriveEditSettlementFinancials(
    discountedPaidOrder,
    originalItems,
    'pickup',
  );

  assert.equal(afterAdd.subtotal, 14.79);
  assert.equal(afterAdd.totalAmount, 13.29);
  assert.equal(afterAdd.discountAmount, 1.5);

  assert.equal(afterRemove.subtotal, 8.79);
  assert.equal(afterRemove.totalAmount, 7.29);
  assert.equal(afterRemove.discountAmount, 1.5);
});

test('deriveEditSettlementFinancials returns to the original total when no discount exists', () => {
  const paidOrderWithoutDiscount = {
    total_amount: 7.29,
    subtotal: 7.29,
    discount_amount: 0,
    discount_percentage: 0,
    tax_amount: 0,
    delivery_fee: 0,
    tip_amount: 0,
  };

  const originalItems = [
    { name: 'Original paid items', quantity: 1, unit_price: 7.29, total_price: 7.29 },
  ];
  const withAddedSpecial = [
    ...originalItems,
    { name: 'Special', quantity: 1, unit_price: 6, total_price: 6 },
  ];

  const afterAdd = deriveEditSettlementFinancials(
    paidOrderWithoutDiscount,
    withAddedSpecial,
    'pickup',
  );
  const afterRemove = deriveEditSettlementFinancials(
    paidOrderWithoutDiscount,
    originalItems,
    'pickup',
  );

  assert.equal(afterAdd.totalAmount, 13.29);
  assert.equal(afterAdd.discountAmount, 0);
  assert.equal(afterRemove.totalAmount, 7.29);
  assert.equal(afterRemove.discountAmount, 0);
});

test('deriveEditSettlementFinancials uses item-level discounted totals', () => {
  const paidOrderWithoutDiscount = {
    total_amount: 6,
    subtotal: 6,
    discount_amount: 0,
    discount_percentage: 0,
    tax_amount: 0,
    delivery_fee: 0,
    tip_amount: 0,
  };

  const discountedItems = [
    { name: 'Special', quantity: 1, unit_price: 6, total_price: 4.5 },
  ];

  const financials = deriveEditSettlementFinancials(
    paidOrderWithoutDiscount,
    discountedItems,
    'pickup',
  );

  assert.equal(financials.subtotal, 4.5);
  assert.equal(financials.totalAmount, 4.5);
  assert.equal(financials.discountAmount, 0);
});
