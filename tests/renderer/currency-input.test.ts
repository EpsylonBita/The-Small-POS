import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCurrencyDigits, formatCurrencyInput } from '../../src/shared/utils/currencyInput';

test('digit entry is interpreted as cents and shown with a comma and two decimals', () => {
  for (const [input, amount, display] of [
    ['1', 0.01, '0,01'], ['10', 0.1, '0,10'], ['1050', 10.5, '10,50'],
    ['3350', 33.5, '33,50'], ['2300', 23, '23,00'], ['0003350', 33.5, '33,50'],
    ['33,50', 33.5, '33,50'], ['33.50', 33.5, '33,50'], ['', 0, '0,00'],
  ] as const) {
    assert.equal(parseCurrencyDigits(input), amount);
    assert.equal(formatCurrencyInput(amount), display);
  }
});

test('negative, exponent, invalid text and overflowing input are rejected', () => {
  for (const input of ['-100', '1e3', 'NaN', '12abc', '1234567890123']) {
    assert.equal(parseCurrencyDigits(input), null);
  }
});

test('appending digits and deleting the last digit keeps cent entry consistent', () => {
  let display = '0,00';
  for (const digit of '3350') display = formatCurrencyInput(parseCurrencyDigits(display + digit)!);
  assert.equal(display, '33,50');
  assert.equal(formatCurrencyInput(parseCurrencyDigits(display.slice(0, -1))!), '3,35');
});
