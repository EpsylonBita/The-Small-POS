/**
 * Satellite display codes (M1-0042) on the desktop formatters.
 *
 * A waiter phone mints `<short_code>-<seq>` into orders.display_order_number;
 * the main register materializes it verbatim and its UI funnels through these
 * helpers. The terminal marker IS the point — the compact formatter must pass
 * the code through untouched, unlike the date-stamped local formats it
 * compacts and the internal 32-hex fallbacks it hides behind a timestamp.
 */
import { describe, expect, it } from 'vitest';
import {
  formatCompactOrderNumberForDisplay,
  getVisibleOrderNumber,
  isBusinessOrderNumber,
} from '../orderNumberUtils';

describe('satellite display codes', () => {
  it('passes M1-0042 through the compact formatter untouched', () => {
    expect(formatCompactOrderNumberForDisplay('M1-0042')).toBe('M1-0042');
    expect(formatCompactOrderNumberForDisplay('#M1-0042')).toBe('#M1-0042');
  });

  it('still compacts the local and internal formats around it', () => {
    expect(formatCompactOrderNumberForDisplay('ORD-27082026-00029')).toBe('ORD #00029');
    expect(
      formatCompactOrderNumberForDisplay(
        'ORD-20260827-dbec94b835c8f04f93f56601b7c98728',
        '2026-08-27T17:24:01.000Z',
      ),
    ).toMatch(/^ORD /);
  });

  it('prefers the persisted display number over the canonical hash', () => {
    expect(
      getVisibleOrderNumber({
        display_order_number: 'M1-0042',
        order_number: 'ORD-20260827-dbec94b835c8f04f93f56601b7c98728',
      }),
    ).toBe('M1-0042');
  });

  it('keeps merge arbitration untouched: satellite codes are not business order_numbers', () => {
    // display codes never live in order_number, so they must not start
    // winning resolveMergedOrderNumber arbitration by accident.
    expect(isBusinessOrderNumber('M1-0042')).toBe(false);
  });
});
