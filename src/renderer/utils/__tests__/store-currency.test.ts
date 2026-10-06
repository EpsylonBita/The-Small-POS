import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../../lib/i18n', () => ({ default: { language: 'en-US' } }));
import { configuredStoreCurrency, setStoreCurrencyFromSettings } from '../store-currency';
import { formatCurrency } from '../format';
const settings = {
  terminal: { branch_id: 'branch-ch' },
  restaurant: { currency: 'CHF', store_currency_available: true, store_currency_source: 'branch_country', store_currency_branch_id: 'branch-ch' },
  organization: { currency: 'EUR', country: 'United States' },
};
afterEach(() => setStoreCurrencyFromSettings({}));
describe('Store currency authority', () => {
  it('uses Swiss store authority regardless of stale organization settings or language', () => {
    expect(configuredStoreCurrency(settings)).toBe('CHF');
    setStoreCurrencyFromSettings(settings);
    expect(formatCurrency(12.5, undefined, 'en-US')).toContain('CHF');
    expect(formatCurrency(12.5, undefined, 'el-GR')).toContain('CHF');
  });
  it('does not relabel a historical explicit currency', () => {
    setStoreCurrencyFromSettings(settings);
    expect(formatCurrency(12.5, 'USD', 'en-US')).toBe('$12.50');
  });
  it.each([
    {},
    { ...settings, terminal: { branch_id: 'another-branch' } },
    { ...settings, restaurant: { ...settings.restaurant, store_currency_available: false } },
  ])('refuses missing, stale or unavailable authority', value => {
    expect(configuredStoreCurrency(value)).toBeNull();
    setStoreCurrencyFromSettings(value);
    expect(formatCurrency(12.5, undefined, 'en-US')).toBe('12.50');
  });
});
