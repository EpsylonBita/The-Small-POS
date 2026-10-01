import { describe, expect, it } from 'vitest'

import { localeBundles } from '../../../locales/bundles'
import {
  HEALTH_LOCALES,
  SHARED_HEALTH_I18N_KEYS,
  checkSharedHealthLocales,
  localeValue,
} from '../../../../../shared/pos/health/health-i18n'

/**
 * Every key the shared Health module (shared/pos/health) can make a POS render
 * exists in all six desktop locales, so the Health view never shows a raw key
 * on this terminal. POSSystemMobile runs the same check on its own bundles,
 * which keeps both apps saying the same thing.
 */
describe('shared Health i18n keys in the desktop locale bundles', () => {
  it('covers the six POS locales', () => {
    expect(Object.keys(localeBundles).sort()).toEqual([...HEALTH_LOCALES].sort())
  })

  it('has every shared key, non-blank, with the English tokens and genuine Greek', () => {
    expect(SHARED_HEALTH_I18N_KEYS.length).toBeGreaterThan(200)
    expect(checkSharedHealthLocales(localeBundles)).toEqual([])
  })

  it('keeps the counted sentences and durations countable in every locale', () => {
    for (const locale of HEALTH_LOCALES) {
      for (const key of [
        'sync.healthModal.problems.syncStuck.other',
        'sync.healthModal.problems.fiscalNotSent.other',
        'sync.healthModal.duration.minutes.other',
        'sync.healthModal.duration.hours.other',
        'sync.healthModal.duration.days.other',
      ]) {
        expect(localeValue(localeBundles[locale], key), `${locale} ${key}`).toMatch(/{{count}}/)
      }
    }
  })
})
