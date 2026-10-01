import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { localeBundles } from '../../../locales/bundles'

/**
 * Round 3 item DR6 (01/10/2026): staff saw raw translation keys
 * (`orderFlow.missingContext`, `orderFlow.invalidCartItems`,
 * `orderDashboard.noPickupOrderSelected`, `orderDashboard.receiptQueued`,
 * `orderDashboard.receiptPreview`, `orderFlow.noAddressForDelivery`, ...):
 * the code asked for keys no locale had, and a `t(key) || 'English'`
 * fallback never fires because i18next answers the key itself. Every
 * `orderDashboard.*` and `orderFlow.*` key the renderer names is now in all
 * six locales, with the same placeholders as English.
 */
const SOURCE_ROOT = path.resolve(__dirname, '../../..')
const KEY_PATTERN = /['"`]((?:orderDashboard|orderFlow)\.[A-Za-z0-9_.]+)['"`]/g

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
  // A namespace named on its own (`t('orderDashboard.status.' + x)` style
  // prefixes) is an object in every locale, never a leaf to translate.
  return [...keys]
    .filter((key) => !isObject(lookup(localeBundles.en as Bundle, key)))
    .sort()
}

const placeholders = (text: string): string[] =>
  [...text.matchAll(/{{\s*([A-Za-z0-9_]+)\s*}}/g)].map((match) => match[1]).sort()

describe('order screen translation keys', () => {
  const keys = usedKeys()

  it('finds the order screens keys, including the ones staff saw raw', () => {
    expect(keys.length).toBeGreaterThan(100)
    for (const key of [
      'orderFlow.missingContext',
      'orderFlow.invalidCartItems',
      'orderFlow.noAddressForDelivery',
      'orderDashboard.noPickupOrderSelected',
      'orderDashboard.receiptQueued',
      'orderDashboard.receiptPreview',
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
