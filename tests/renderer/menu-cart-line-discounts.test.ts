import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyDiscountToCartLines,
  clearDiscountFromCartLines,
  type DiscountableCartLine,
} from '../../src/renderer/utils/cart-line-discounts';

test('applyDiscountToCartLines discounts only the selected cart lines', () => {
  const items: DiscountableCartLine[] = [
    { id: 'special', name: 'Special', quantity: 2, price: 5, unitPrice: 5, totalPrice: 10 },
    { id: 'plain', name: 'Plain', quantity: 1, price: 7, unitPrice: 7, totalPrice: 7 },
  ];

  const discounted = applyDiscountToCartLines(items, ['special'], 'percentage', 20);

  assert.equal(discounted[0].unitPrice, 4);
  assert.equal(discounted[0].price, 4);
  assert.equal(discounted[0].totalPrice, 8);
  assert.equal(discounted[0].originalUnitPrice, 5);
  assert.equal(discounted[0].isPriceOverridden, true);
  assert.equal(discounted[0].discountAmount, 2);
  assert.deepEqual(discounted[1], items[1]);
});

test('applyDiscountToCartLines distributes fixed discounts proportionally', () => {
  const items: DiscountableCartLine[] = [
    { id: 'large', name: 'Large', quantity: 1, price: 10, unitPrice: 10, totalPrice: 10 },
    { id: 'small', name: 'Small', quantity: 1, price: 5, unitPrice: 5, totalPrice: 5 },
    { id: 'other', name: 'Other', quantity: 1, price: 4, unitPrice: 4, totalPrice: 4 },
  ];

  const discounted = applyDiscountToCartLines(items, ['large', 'small'], 'fixed', 3);

  assert.equal(discounted[0].discountAmount, 2);
  assert.equal(discounted[0].totalPrice, 8);
  assert.equal(discounted[1].discountAmount, 1);
  assert.equal(discounted[1].totalPrice, 4);
  assert.equal(discounted[2].totalPrice, 4);
});

test('clearDiscountFromCartLines restores the discount base price', () => {
  const items: DiscountableCartLine[] = [
    {
      id: 'special',
      name: 'Special',
      quantity: 1,
      price: 6,
      unitPrice: 6,
      totalPrice: 6,
      originalUnitPrice: 10,
      discountBaseUnitPrice: 8,
      discountAmount: 2,
      isPriceOverridden: true,
    },
  ];

  const cleared = clearDiscountFromCartLines(items, ['special']);

  assert.equal(cleared[0].unitPrice, 8);
  assert.equal(cleared[0].price, 8);
  assert.equal(cleared[0].totalPrice, 8);
  assert.equal(cleared[0].discountAmount, 0);
  assert.equal(cleared[0].isPriceOverridden, true);
});

test('applyDiscountToCartLines replaces an existing selected line discount', () => {
  const items: DiscountableCartLine[] = [
    { id: 'special', name: 'Special', quantity: 1, price: 6, unitPrice: 6, totalPrice: 6 },
  ];

  const tenPercent = applyDiscountToCartLines(items, ['special'], 'percentage', 10);
  const twentyPercent = applyDiscountToCartLines(tenPercent, ['special'], 'percentage', 20);

  assert.equal(twentyPercent[0].totalPrice, 4.8);
  assert.equal(twentyPercent[0].unitPrice, 4.8);
  assert.equal(twentyPercent[0].discountAmount, 1.2);
  assert.equal(twentyPercent[0].discountBaseUnitPrice, 6);
  assert.equal(twentyPercent[0].discountBaseTotalPrice, 6);
});
