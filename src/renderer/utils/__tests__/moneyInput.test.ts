import { describe, expect, it } from 'vitest';
import { centsEntryDisplay, nextCentsEntry, parseMoneyInputValue, parsePastedMoney, pastedCentsEntry } from '../moneyInput';

describe('nextCentsEntry (digit entry in cents)', () => {
  it('keeps a plain decimal string for state and the number for payloads', () => {
    expect(nextCentsEntry('100000')).toEqual({ value: '1000.00', amount: 1000 });
    expect(nextCentsEntry('3350')).toEqual({ value: '33.50', amount: 33.5 });
    expect(nextCentsEntry('0')).toEqual({ value: '0.00', amount: 0 });
  });

  it('refuses letters, signs, exponents and more than 12 digits', () => {
    for (const typed of ['12a', '-5', '1e3', '1234567890123']) {
      expect(nextCentsEntry(typed)).toBeNull();
    }
  });

  it('empties the field when nothing is left or the last digit is deleted', () => {
    expect(nextCentsEntry('')).toEqual({ value: '', amount: 0 });
    expect(nextCentsEntry(',')).toEqual({ value: '', amount: 0 });
    expect(nextCentsEntry('0,0', true)).toEqual({ value: '', amount: 0 });
    // Backspace on a non-zero amount only drops a cent digit.
    expect(nextCentsEntry('1.000,0', true)).toEqual({ value: '100.00', amount: 100 });
    // Typing a zero over a selection is a real zero, not a cleared field.
    expect(nextCentsEntry('0', false)).toEqual({ value: '0.00', amount: 0 });
  });
});

describe('centsEntryDisplay', () => {
  it.each([
    ['', ''],
    ['   ', ''],
    ['1000.00', '1.000,00'],
    ['12,50', '12,50'],
    ['1000,00', '1.000,00'],
    ['1.000,00', '1.000,00'],
    ['12.5', '12,50'],
  ])('shows stored %j as %j', (stored, shown) => {
    expect(centsEntryDisplay(stored)).toBe(shown);
  });

  it('shows numbers grouped and nothing for missing values', () => {
    expect(centsEntryDisplay(1234567.8)).toBe('1.234.567,80');
    expect(centsEntryDisplay(0)).toBe('0,00');
    expect(centsEntryDisplay(null)).toBe('');
    expect(centsEntryDisplay(undefined)).toBe('');
    expect(centsEntryDisplay(Number.NaN)).toBe('');
  });
});

describe('parseMoneyInputValue', () => {
  it.each([
    ['1000.00', 1000],
    ['12,50', 12.5],
    ['1.000,00', 1000],
    ['1.234.567,80', 1234567.8],
    ['€ 12,50', 12.5],
    ['', 0],
    ['abc', 0],
    ['-5', 0],
  ])('reads %j as %s', (stored, amount) => {
    expect(parseMoneyInputValue(stored)).toBe(amount);
  });
});

describe('pasted money (review 13/10/2026)', () => {
  it.each([
    ['12.5', 12.5],
    ['12,5', 12.5],
    ['12.50', 12.5],
    ['1.234,50', 1234.5],
    ['1,234.50', 1234.5],
    ['1.234', 1234],
    ['1.234.567', 1234567],
    ["1'234.50", 1234.5],
    ['CHF 12.50', 12.5],
    ['12,50 €', 12.5],
    [' 7 ', 7],
  ])('reads pasted %j as the decimal amount %d, not as typed cents', (text, amount) => {
    expect(parsePastedMoney(text)).toBe(amount);
  });

  it.each(['abc', '-5', '1e3', '12.3.4,5,6', '', '1234567890123'])('refuses %j', (text) => {
    expect(parsePastedMoney(text)).toBeNull();
  });

  it('gives the field the plain decimal value it stores', () => {
    expect(pastedCentsEntry('12.5')).toEqual({ value: '12.50', amount: 12.5 });
    expect(pastedCentsEntry('1.234,50')).toEqual({ value: '1234.50', amount: 1234.5 });
    expect(centsEntryDisplay(pastedCentsEntry('1.234,50')!.value)).toBe('1.234,50');
    expect(pastedCentsEntry('x')).toBeNull();
  });
});
