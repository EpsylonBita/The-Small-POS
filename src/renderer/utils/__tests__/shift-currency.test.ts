import { describe, expect, it } from 'vitest';
import { shiftSummaryCurrency } from '../shift-currency';

describe('shift checkout original unit', () => {
  it('uses the original aggregate unit independently of the store country', () => {
    expect(shiftSummaryCurrency({ currency: 'CHF' }, { currency: 'EUR' })).toBe('CHF');
  });
  it.each([{}, { currency: null }, { currency: 'invalid' }])('keeps unresolved/mixed summary %j unknown', summary => {
    expect(shiftSummaryCurrency(summary, { currency: 'EUR' })).toBeNull();
  });
  it('uses the recorded shift only while no summary has loaded', () => {
    expect(shiftSummaryCurrency(null, { currency: 'CHF' })).toBe('CHF');
    expect(shiftSummaryCurrency(null, {})).toBeNull();
  });
});
