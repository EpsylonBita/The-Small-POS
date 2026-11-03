import { describe, expect, it } from 'vitest';
import { SUPPORT_LOCALES, validateSupportLocales } from '../../../../../../shared/pos/support/i18n-keys';
import { SUPPORT_HEALTH_ACTIONS } from '../../../services/support/SupportMatcherBridge';
import el from '../../../../locales/support/el.json';
import en from '../../../../locales/support/en.json';
import de from '../../../../locales/support/de.json';
import fr from '../../../../locales/support/fr.json';
import itLocale from '../../../../locales/support/it.json';
import sq from '../../../../locales/support/sq.json';
const bundles = { el, en, de, fr, it: itLocale, sq };
describe('Phase two translations', () => {
  it('has every shared key in all six languages and pins the Greek reference', () => { expect(validateSupportLocales(bundles)).toEqual([]); });
  it.each(SUPPORT_LOCALES)('%s has the same Greek/Android support contract without encoding damage', async locale => {
    const mobile = await import(`../../../../../../POSSystemMobile/src/locales/support/${locale}.json`);
    for (const section of ['onsite', 'physicalCheck', 'deviceApply'] as const) {
      const current = bundles[locale][section], counterpart = mobile.default[section];
      for (const [key, text] of Object.entries(current)) {
        expect(text).not.toContain('\uFFFD'); expect(text).not.toMatch(/\?{2,}/);
        expect(counterpart[key]).toBe(text);
      }
    }
  });
  it.each(SUPPORT_LOCALES)('%s translates the existing Health action text keys', async locale => {
    const bundle = await import(`../../../../locales/${locale}.json`);
    const lookup = (key: string) => key.split('.').reduce<unknown>((value, part) => value && typeof value === 'object' ? (value as Record<string, unknown>)[part] : undefined, bundle.default);
    for (const action of SUPPORT_HEALTH_ACTIONS) { expect(lookup(action.titleKey)).toEqual(expect.any(String)); expect(lookup(action.explanationKey)).toEqual(expect.any(String)); }
  });
});
