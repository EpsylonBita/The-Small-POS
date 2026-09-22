/**
 * Module audit 2026-09-16: KioskManagementPage rendered English in every locale because
 * none of the six locale files carried a `modules.kiosk` block. Pin the keys the page uses
 * against all six files so the gap cannot come back.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const LOCALES = ['en', 'el', 'de', 'fr', 'it', 'sq']

function usedKeys(): string[] {
  const source = readFileSync(join(ROOT, 'src', 'renderer', 'pages', 'KioskManagementPage.tsx'), 'utf8')
  const keys = new Set<string>()
  for (const match of source.matchAll(/t\('(modules\.kiosk\.[A-Za-z0-9_.]+)'/g)) {
    keys.add(match[1] as string)
  }
  return [...keys].sort()
}

function lookup(locale: Record<string, unknown>, key: string): unknown {
  return key.split('.').reduce<unknown>((current, segment) => {
    if (current && typeof current === 'object' && segment in (current as Record<string, unknown>)) {
      return (current as Record<string, unknown>)[segment]
    }
    return undefined
  }, locale)
}

test('every modules.kiosk key the page uses exists in all six locales', () => {
  const keys = usedKeys()
  assert.ok(keys.length >= 15, `expected the page to use the kiosk keys, found ${keys.length}`)
  for (const locale of LOCALES) {
    const data = JSON.parse(readFileSync(join(ROOT, 'src', 'locales', `${locale}.json`), 'utf8')) as Record<string, unknown>
    const missing = keys.filter((key) => typeof lookup(data, key) !== 'string')
    assert.deepEqual(missing, [], `${locale}.json is missing ${missing.join(', ')}`)
  }
})
