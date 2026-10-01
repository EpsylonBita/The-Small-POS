import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { localeBundles } from '../../../locales/bundles'

/**
 * Round 3 review (01/10/2026), the refund screens: the order's refund screen
 * and the edit's refund named `modals.refund.*` keys no locale had. Staff
 * saw English on a Greek, German, French, Italian or Albanian till (the
 * refund route, the cash refund, who hands cash back, the whole edit refund
 * dialog) and a raw key after a lost gift card return reply
 * (`modals.refund.gift.noCapture`, no default). Every `modals.refund.*` key
 * the renderer names is now in all six locales, with the same placeholders
 * as English, the new round 3 texts (an `other` tender, a tender required,
 * the platform's settlement) included.
 */
const SOURCE_ROOT = path.resolve(__dirname, '../../..')
const KEY_PATTERN = /['"`](modals\.refund\.[A-Za-z0-9_.]+)['"`]/g

type Bundle = Record<string, unknown>

const isObject = (value: unknown): value is Bundle =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const lookup = (bundle: Bundle, key: string): unknown => {
  let current: unknown = bundle
  for (const part of key.split('.')) {
    if (!isObject(current) || !(part in current)) return undefined
    current = current[part]
  }
  return current
}

const leafValue = (bundle: Bundle, key: string): string | undefined => {
  for (const candidate of [key, `${key}_other`, `${key}_one`]) {
    const value = lookup(bundle, candidate)
    if (typeof value === 'string') return value
  }
  return undefined
}

const sourceFiles = (dir: string): string[] => {
  const files: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (['node_modules', 'locales', '__tests__'].includes(entry.name)) continue
      files.push(...sourceFiles(full))
    } else if (/\.(tsx?|jsx?)$/.test(entry.name) && !/\.test\./.test(entry.name)) {
      files.push(full)
    }
  }
  return files
}

const usedKeys = (): string[] => {
  const keys = new Set<string>()
  for (const file of sourceFiles(SOURCE_ROOT)) {
    const source = fs.readFileSync(file, 'utf8')
    for (const match of source.matchAll(KEY_PATTERN)) {
      keys.add(match[1].replace(/\.$/, ''))
    }
  }
  // A namespace named on its own (`t('modals.refund.gift.' + x)` style
  // prefixes) is an object in every locale, never a leaf to translate.
  return [...keys]
    .filter((key) => !isObject(lookup(localeBundles.en as Bundle, key)))
    .sort()
}

const placeholders = (text: string): string[] =>
  [...text.matchAll(/{{\s*([A-Za-z0-9_]+)\s*}}/g)].map((match) => match[1]).sort()

describe('refund screen translation keys', () => {
  const keys = usedKeys()

  it('finds the refund screens keys, including the ones staff saw in English or raw', () => {
    expect(keys.length).toBeGreaterThan(60)
    for (const key of [
      'modals.refund.refundRoute',
      'modals.refund.cashRefund',
      'modals.refund.cashReturnedBy',
      'modals.refund.otherRefund',
      'modals.refund.tenderRequired',
      'modals.refund.platformSettlementLocked',
      'modals.refund.editSettlementTitle',
      'modals.refund.gift.noCapture',
    ]) {
      expect(keys).toContain(key)
    }
  })

  it('has every key in all six locales', () => {
    const missing: string[] = []
    for (const [locale, bundle] of Object.entries(localeBundles)) {
      for (const key of keys) {
        const value = leafValue(bundle as Bundle, key)
        if (!value || !value.trim()) missing.push(`${locale}: ${key}`)
      }
    }
    expect(missing).toEqual([])
  })

  it('keeps the English placeholders in every locale', () => {
    const mismatched: string[] = []
    for (const key of keys) {
      const english = leafValue(localeBundles.en as Bundle, key)
      if (!english) continue
      const expected = placeholders(english)
      for (const [locale, bundle] of Object.entries(localeBundles)) {
        const value = leafValue(bundle as Bundle, key)
        if (value && placeholders(value).join(',') !== expected.join(',')) {
          mismatched.push(`${locale}: ${key}`)
        }
      }
    }
    expect(mismatched).toEqual([])
  })
})
