#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const localesDir = path.resolve(__dirname, '..', 'src', 'locales');
const baseLocale = 'en.json';

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function flattenKeys(value, prefix = '', out = new Set()) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, nested] of Object.entries(value)) {
      const next = prefix ? `${prefix}.${key}` : key;
      flattenKeys(nested, next, out);
    }
    return out;
  }

  out.add(prefix);
  return out;
}

function printList(title, values) {
  console.log(`\n${title} (${values.length})`);
  if (!values.length) {
    console.log('  - none');
    return;
  }

  for (const value of values) {
    console.log(`  - ${value}`);
  }
}

function main() {
  const files = fs
    .readdirSync(localesDir)
    .filter((file) => file.endsWith('.json'))
    .sort();

  if (!files.includes(baseLocale)) {
    throw new Error(`Missing base locale: ${baseLocale}`);
  }

  const baseKeys = flattenKeys(readJson(path.join(localesDir, baseLocale)));
  let hasFailure = false;

  console.log('POS Tauri Locale Parity Report');
  console.log('==============================');
  console.log(`Base locale: ${baseLocale}`);
  console.log(`Base keys  : ${baseKeys.size}`);

  for (const file of files) {
    if (file === baseLocale) continue;

    const localeKeys = flattenKeys(readJson(path.join(localesDir, file)));
    const missing = [...baseKeys].filter((key) => !localeKeys.has(key)).sort();
    const extra = [...localeKeys].filter((key) => !baseKeys.has(key)).sort();

    console.log(`\nLocale ${file}`);
    console.log(`  Keys   : ${localeKeys.size}`);
    console.log(`  Missing: ${missing.length}`);
    console.log(`  Extra  : ${extra.length}`);

    if (missing.length) {
      hasFailure = true;
      printList(`${file} missing keys`, missing);
    }

    if (extra.length) {
      printList(`${file} extra keys`, extra);
    }
  }

  if (hasFailure) {
    console.error('\nLocale parity check failed.');
    process.exitCode = 1;
    return;
  }

  console.log('\nLocale parity check passed.');
}

main();
