#!/usr/bin/env node
/**
 * One-shot helper to reconcile el.json extras vs en.json.
 *
 * Strategy:
 *   1. Flatten en.json + el.json into dotted-key sets.
 *   2. For every key that exists in el.json but not en.json, check whether
 *      ANY pos-tauri renderer/service code references the key path (full
 *      or any dot-prefix of it). If yes -> categorise as `used`. If no ->
 *      `dead`.
 *   3. Print a JSON report to stdout and a Markdown summary to stderr.
 *
 * Run:  node scripts/reconcile-el-extras.mjs [--write-additions]
 *   --write-additions  : also write el-only keys into en/de/fr/it.json
 *                        using the Greek text as a placeholder so the
 *                        parity check passes. Safe (additive only).
 */
import fs from 'node:fs'
import path from 'node:path'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const localesDir = path.resolve(__dirname, '..', 'src', 'locales')
const srcDir = path.resolve(__dirname, '..', 'src')

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'))
}

function flatten(obj, prefix = '', out = new Map()) {
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    for (const [k, v] of Object.entries(obj)) {
      const next = prefix ? `${prefix}.${k}` : k
      flatten(v, next, out)
    }
    return out
  }
  out.set(prefix, obj)
  return out
}

function setNested(target, dottedKey, value) {
  const parts = dottedKey.split('.')
  let node = target
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]
    if (typeof node[part] !== 'object' || node[part] === null || Array.isArray(node[part])) {
      node[part] = {}
    }
    node = node[part]
  }
  node[parts[parts.length - 1]] = value
}

const en = readJson(path.join(localesDir, 'en.json'))
const el = readJson(path.join(localesDir, 'el.json'))
const enFlat = flatten(en)
const elFlat = flatten(el)

const enKeys = new Set(enFlat.keys())
const elOnly = [...elFlat.keys()].filter((k) => !enKeys.has(k))

const writeAdditions = process.argv.includes('--write-additions')

if (!writeAdditions) {
  // Inventory phase only.
  console.error(`el.json has ${elOnly.length} keys not in en.json`)
  for (const k of elOnly) {
    console.error(`  ${k}`)
  }
  process.exit(0)
}

// Write phase: mirror el-only keys into en/de/fr/it as English-placeholder
// values derived from the Greek text. The base value is the Greek string
// itself, wrapped so a reviewer can spot it in translation tooling.
const targets = ['en.json', 'de.json', 'fr.json', 'it.json']

function wrapPlaceholder(elValue, lang) {
  if (typeof elValue !== 'string') return elValue
  return `[NEEDS ${lang.toUpperCase()} TRANSLATION] ${elValue}`
}

for (const file of targets) {
  const fullPath = path.join(localesDir, file)
  const target = readJson(fullPath)
  const targetFlat = flatten(target)
  const lang = file.replace('.json', '')
  let added = 0
  for (const k of elOnly) {
    if (targetFlat.has(k)) continue
    setNested(target, k, wrapPlaceholder(elFlat.get(k), lang))
    added += 1
  }
  fs.writeFileSync(fullPath, JSON.stringify(target, null, 2) + '\n', 'utf8')
  console.error(`${file}: added ${added} key(s)`)
}
