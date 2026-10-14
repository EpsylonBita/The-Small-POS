import { describe, expect, it } from 'vitest';
import { formatCurrencyInput, parseCurrencyDigits } from '../currencyInput';

// Founder rule 13/10/2026: money fields take digit entry in cents and show
// thousands grouped with '.', the decimal comma fixed (100000 -> 1.000,00).
describe('formatCurrencyInput', () => {
  it.each([
    [0, '0,00'],
    [0.01, '0,01'],
    [33.5, '33,50'],
    [999.99, '999,99'],
    [1000, '1.000,00'],
    [12345.6, '12.345,60'],
    [1234567.8, '1.234.567,80'],
    [9999999999.99, '9.999.999.999,99'],
  ])('shows %s as %s', (amount, shown) => {
    expect(formatCurrencyInput(amount)).toBe(shown);
  });

  it('never shows a negative or non-finite amount', () => {
    for (const amount of [-5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(formatCurrencyInput(amount)).toBe('0,00');
    }
  });
});

describe('parseCurrencyDigits', () => {
  it.each([
    ['', 0],
    ['1', 0.01],
    ['3350', 33.5],
    ['100000', 1000],
    ['0003350', 33.5],
    // A typed separator never switches to decimal entry: every digit is a cent digit.
    ['33,50', 33.5],
    ['1.000,00', 1000],
    ['1.000,005', 10000.05],
    ['12,5', 1.25],
    ['€ 1 000', 10],
  ])('reads %j as %s', (typed, amount) => {
    expect(parseCurrencyDigits(typed)).toBe(amount);
  });

  it('refuses letters, signs, exponents and text', () => {
    for (const typed of ['12abc', 'abc', '-100', '+5', '1e3', 'NaN', 'Infinity']) {
      expect(parseCurrencyDigits(typed)).toBeNull();
    }
  });

  it('caps entry at 12 significant digits', () => {
    expect(parseCurrencyDigits('999999999999')).toBe(9999999999.99);
    expect(parseCurrencyDigits('1234567890123')).toBeNull();
    // Leading zeros do not count against the cap.
    expect(parseCurrencyDigits('0000999999999999')).toBe(9999999999.99);
  });

  it('round-trips typing and backspace through the grouped display', () => {
    let shown = '';
    for (const digit of '100000') shown = formatCurrencyInput(parseCurrencyDigits(shown + digit)!);
    expect(shown).toBe('1.000,00');
    // Backspace drops the last cent digit and regroups: 1.000,00 -> 100,00.
    expect(formatCurrencyInput(parseCurrencyDigits(shown.slice(0, -1))!)).toBe('100,00');
    shown = formatCurrencyInput(parseCurrencyDigits('1.234.567,8')!);
    expect(shown).toBe('123.456,78');
  });
});
