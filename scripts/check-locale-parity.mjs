#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const localesDir = path.resolve(__dirname, '..', 'src', 'locales');
const supportLocalesDir = path.resolve(__dirname, '..', 'src', 'locales', 'support');
const baseLocale = 'en.json';
const requiredSupportIssueCodes = [
  'health.offline',
  'health.sync_error_active',
  'health.sync_stale',
  'health.backlog_blocked',
  'health.financial_queue_failed',
  'health.invalid_orders_present',
  'health.pending_zreport_submit',
  'printer.not_configured',
  'printer.no_default_profile',
  'printer.offline_or_error',
  'printer.transport_unresolved',
  'printer.unverified',
  'printer.recent_job_failures',
  'printer.degraded',
];
const requiredSupportCopyFields = [
  'title',
  'summary',
  'why',
  'steps',
  'whenToEscalate',
  'ctaLabels',
];
const requiredSupportFallbacks = ['health', 'printer'];

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function deepMerge(base, extension) {
  if (!isPlainObject(base) || !isPlainObject(extension)) {
    return extension;
  }

  const merged = { ...base };
  for (const [key, value] of Object.entries(extension)) {
    const currentValue = merged[key];
    merged[key] =
      isPlainObject(currentValue) && isPlainObject(value)
        ? deepMerge(currentValue, value)
        : value;
  }

  return merged;
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

function getValue(source, dotPath) {
  return dotPath.split('.').reduce((current, key) => {
    if (!isPlainObject(current)) {
      return undefined;
    }

    return current[key];
  }, source);
}

function readMergedLocale(fileName) {
  const base = readJson(path.join(localesDir, fileName));
  const supportPath = path.join(supportLocalesDir, fileName);
  if (!fs.existsSync(supportPath)) {
    return base;
  }

  return deepMerge(base, { support: readJson(supportPath) });
}

function validateSupportCopy(localeName, copyPath, value) {
  const errors = [];

  if (!isPlainObject(value)) {
    errors.push(`${localeName}: missing object at ${copyPath}`);
    return errors;
  }

  for (const field of requiredSupportCopyFields) {
    if (!(field in value)) {
      errors.push(`${localeName}: missing ${copyPath}.${field}`);
    }
  }

  if (!Array.isArray(value.steps) || value.steps.length === 0) {
    errors.push(`${localeName}: ${copyPath}.steps must be a non-empty array`);
  }

  if (!Array.isArray(value.whenToEscalate) || value.whenToEscalate.length === 0) {
    errors.push(
      `${localeName}: ${copyPath}.whenToEscalate must be a non-empty array`,
    );
  }

  if (!isPlainObject(value.ctaLabels)) {
    errors.push(`${localeName}: ${copyPath}.ctaLabels must be an object`);
  }

  return errors;
}

function validateSupportLocale(localeName, localeData) {
  const errors = [];
  const supportPath = path.join(supportLocalesDir, localeName);

  if (!fs.existsSync(supportPath)) {
    errors.push(`${localeName}: missing support locale file`);
    return errors;
  }

  for (const surface of requiredSupportFallbacks) {
    errors.push(
      ...validateSupportCopy(
        localeName,
        `support.fallbacks.${surface}`,
        getValue(localeData, `support.fallbacks.${surface}`),
      ),
    );
  }

  for (const issueCode of requiredSupportIssueCodes) {
    errors.push(
      ...validateSupportCopy(
        localeName,
        `support.issues.${issueCode}`,
        getValue(localeData, `support.issues.${issueCode}`),
      ),
    );
  }

  return errors;
}

function main() {
  const files = fs
    .readdirSync(localesDir)
    .filter((file) => file.endsWith('.json'))
    .sort();

  if (!files.includes(baseLocale)) {
    throw new Error(`Missing base locale: ${baseLocale}`);
  }

  const mergedBaseLocale = readMergedLocale(baseLocale);
  const baseKeys = flattenKeys(mergedBaseLocale);
  let hasFailure = false;
  const baseSupportErrors = validateSupportLocale(baseLocale, mergedBaseLocale);

  console.log('POS Tauri Locale Parity Report');
  console.log('==============================');
  console.log(`Base locale: ${baseLocale}`);
  console.log(`Base keys  : ${baseKeys.size}`);

  if (baseSupportErrors.length) {
    hasFailure = true;
    printList(`${baseLocale} support validation errors`, baseSupportErrors);
  }

  for (const file of files) {
    if (file === baseLocale) continue;

    const mergedLocale = readMergedLocale(file);
    const localeKeys = flattenKeys(mergedLocale);
    const missing = [...baseKeys].filter((key) => !localeKeys.has(key)).sort();
    const extra = [...localeKeys].filter((key) => !baseKeys.has(key)).sort();
    const supportErrors = validateSupportLocale(file, mergedLocale);

    console.log(`\nLocale ${file}`);
    console.log(`  Keys   : ${localeKeys.size}`);
    console.log(`  Missing: ${missing.length}`);
    console.log(`  Extra  : ${extra.length}`);
    console.log(`  Support errors: ${supportErrors.length}`);

    if (missing.length) {
      hasFailure = true;
      printList(`${file} missing keys`, missing);
    }

    if (extra.length) {
      printList(`${file} extra keys`, extra);
    }

    if (supportErrors.length) {
      hasFailure = true;
      printList(`${file} support validation errors`, supportErrors);
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
