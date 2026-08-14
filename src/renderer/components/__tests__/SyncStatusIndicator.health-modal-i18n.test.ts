import { describe, expect, it } from 'vitest'

import { localeBundles } from '../../../locales/bundles'

const POS_LOCALES = ['en', 'el', 'de', 'fr', 'it'] as const

const REQUIRED_HEALTH_MODAL_KEYS = [
  'eyebrow',
  'title',
  'close',
  'statusLabel',
  'lastChecked',
  'notCheckedYet',
  'sections.recommendedActions',
  'sections.problemExplanation',
  'sections.supportActions',
  'states.healthy.title',
  'states.healthy.message',
  'states.attention.title',
  'states.attention.message',
  'states.supportNeeded.title',
  'states.supportNeeded.message',
  'states.unavailable.title',
  'states.unavailable.message',
  'guidance.startShift',
  'guidance.contactSupportBeforeOrders',
  'guidance.canContinueOrders',
  'problems.failedPayments',
  'problems.invalidOrders',
  'problems.crashDetected',
  'problems.offline',
  'problems.printerUnavailable',
  'problems.printerNotConfigured',
  'problems.syncWaiting',
  'problems.ready',
  'problems.shiftInactive',
  'recommendations.keepOpen',
  'recommendations.doNotClearData',
  'recommendations.contactSupport',
  'recommendations.contactSupportBeforeOrders',
  'recommendations.keepTakingOrders',
  'recommendations.checkInternet',
  'recommendations.startShift',
  'recommendations.checkConnection',
  'recommendations.configurePrinter',
  'recommendations.useNormally',
  'recommendations.startShiftWhenReady',
  'services.orders',
  'services.internet',
  'services.sync',
  'services.printer',
  'services.support',
  'status.conflict',
  'status.working',
  'status.limited',
  'status.blocked',
  'status.startShift',
  'status.connected',
  'status.offline',
  'status.healthy',
  'status.waiting',
  'status.failed',
  'status.ready',
  'status.attention',
  'status.notConfigured',
  'status.notNeeded',
  'status.notSent',
  'status.failedToNotify',
  'status.processing',
  'status.unknown',
  'failure.safeError',
  'actions.refresh',
  'actions.sending',
  'actions.sendSupport',
  'actions.export',
  'actions.openAdvanced',
  'actions.openFolder',
  'actions.closeAdvanced',
  'advanced.title',
  'advanced.supportOnly',
] as const

const GREEK_COPY_KEYS = [
  'title',
  'close',
  'lastChecked',
  'sections.recommendedActions',
  'sections.problemExplanation',
  'sections.supportActions',
  'states.healthy.title',
  'states.attention.title',
  'states.supportNeeded.title',
  'states.unavailable.title',
  'services.orders',
  'services.internet',
  'services.printer',
  'services.support',
  'status.conflict',
  'status.unknown',
  'failure.safeError',
  'actions.refresh',
  'actions.sending',
  'actions.sendSupport',
  'actions.export',
  'actions.openAdvanced',
  'actions.openFolder',
  'advanced.title',
  'advanced.supportOnly',
] as const

const getValue = (source: unknown, path: string): unknown =>
  path.split('.').reduce<unknown>((current, segment) => {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined
    return (current as Record<string, unknown>)[segment]
  }, source)

const flattenStrings = (
  source: unknown,
  prefix = '',
  output: Record<string, string> = {},
): Record<string, string> => {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return output
  for (const [key, value] of Object.entries(source as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (typeof value === 'string') output[path] = value
    else flattenStrings(value, path, output)
  }
  return output
}

const interpolationTokens = (value: string): string[] =>
  [...value.matchAll(/{{\s*([^},\s]+)[^}]*}}/g)]
    .map((match) => match[1])
    .sort()

describe('SyncStatusIndicator Health Status locale contract', () => {
  it('defines every operator, fallback, and accessibility key in each POS locale', () => {
    for (const locale of POS_LOCALES) {
      const missing = REQUIRED_HEALTH_MODAL_KEYS.filter((key) => {
        const value = getValue(localeBundles[locale], `sync.healthModal.${key}`)
        return typeof value !== 'string' || value.trim().length === 0 || value.includes('[NEEDS')
      })

      expect(missing, `${locale} missing sync.healthModal keys`).toEqual([])
    }
  })

  it('keeps the last-checked interpolation token in every POS locale', () => {
    for (const locale of POS_LOCALES) {
      const value = getValue(localeBundles[locale], 'sync.healthModal.lastChecked')
      expect(typeof value, `${locale} sync.healthModal.lastChecked missing`).toBe('string')
      if (typeof value === 'string') {
        expect(value, `${locale} sync.healthModal.lastChecked token`).toContain('{{value}}')
      }
    }
  })

  it('keeps the complete Health Status namespace and interpolation tokens aligned', () => {
    const english = flattenStrings(
      getValue(localeBundles.en, 'sync.healthModal'),
    )
    const englishKeys = Object.keys(english).sort()

    for (const locale of POS_LOCALES) {
      const localized = flattenStrings(
        getValue(localeBundles[locale], 'sync.healthModal'),
      )
      expect(Object.keys(localized).sort(), `${locale} healthModal key parity`).toEqual(
        englishKeys,
      )
      for (const key of englishKeys) {
        expect(localized[key].trim(), `${locale} healthModal.${key} blank`).not.toBe('')
        expect(
          interpolationTokens(localized[key]),
          `${locale} healthModal.${key} interpolation tokens`,
        ).toEqual(interpolationTokens(english[key]))
      }
    }
  })

  it('provides genuine Greek operator copy instead of English fallbacks', () => {
    for (const key of GREEK_COPY_KEYS) {
      const english = getValue(localeBundles.en, `sync.healthModal.${key}`)
      const greek = getValue(localeBundles.el, `sync.healthModal.${key}`)

      expect(typeof greek, `el sync.healthModal.${key}`).toBe('string')
      expect(greek, `el sync.healthModal.${key} repeats English`).not.toBe(english)
      expect(greek, `el sync.healthModal.${key} contains no Greek copy`).toMatch(
        /[\u0370-\u03ff]/,
      )
    }
  })
})
