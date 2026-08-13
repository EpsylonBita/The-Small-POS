/**
 * Invoice scan capture — desktop i18n static audit (spec task 12.6).
 *
 * Spec: `.claude/specs/invoice-scan-capture/tasks.md` task 12.6,
 * `.claude/specs/invoice-scan-capture/design.md` design surface **D-UI**.
 * Requirements R12.1, R15.3, R16.1, R16.4.
 *
 * Three guarantees, all enforced from the source rather than from a hand-kept
 * list, so a component that grows a new string cannot quietly escape them:
 *
 * 1. **One namespace.** Every locale key the capture surfaces reach for lives
 *    under `suppliers.capture.*`. The only exceptions are a tiny, explicit
 *    allowlist of shared chrome (`common.close`, `common.cancel`) — spelled out
 *    here so adding a second namespace is a deliberate act, not a slip.
 * 2. **No hardcoded user-facing text.** No literal `aria-label` / `placeholder`
 *    / `alt` / `title` attribute, and no bare JSX text node, in any of the new
 *    capture components.
 * 3. **Every key answers in all five locales** — including the *runtime-built*
 *    families (status, reason, device, history/ingest, source kind, source
 *    status), which are the ones a locale walk over static strings would miss
 *    entirely. Those families are read from the vocabulary constants in
 *    `capture-review.ts`, so a code added there without a translation fails
 *    here rather than rendering a raw identifier at a till (R12.1).
 *
 * The plain-language rule is enforced too: the words this feature must never
 * put in front of a shopkeeper are asserted absent from every capture string in
 * every locale, and the confidence label is asserted free of numerals (R7.6).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const projectRoot = process.cwd();
const rendererRoot = path.join(projectRoot, 'src', 'renderer');
const localesDir = path.join(projectRoot, 'src', 'locales');

/** The capture surfaces built by task 12 — the files this audit governs. */
const CAPTURE_COMPONENTS = [
  path.join(rendererRoot, 'components', 'suppliers', 'CaptureScanSettingsModal.tsx'),
  path.join(rendererRoot, 'components', 'suppliers', 'CapturePagesPanel.tsx'),
  path.join(rendererRoot, 'components', 'suppliers', 'CaptureQueuePanel.tsx'),
  path.join(rendererRoot, 'components', 'CaptureNotificationManager.tsx'),
];

const CAPTURE_REVIEW_UTIL = path.join(rendererRoot, 'utils', 'capture-review.ts');
const SUPPLIERS_PAGE = path.join(rendererRoot, 'pages', 'SuppliersPage.tsx');

/**
 * Shared chrome the capture components may legitimately borrow. Deliberately
 * tiny: these are the close/cancel affordances every modal in the app shares,
 * and duplicating them under `suppliers.capture.*` would mean the same button
 * reads differently depending on which modal you opened it from.
 */
const SHARED_KEY_ALLOWLIST = ['common.close', 'common.cancel'];

/** Words this feature must never show a user (R12.1, R15.3). */
const FORBIDDEN_JARGON = [/\bOCR\b/i, /\bMFP\b/i, /\bTWAIN\b/i, /\bWIA\b/i, /raster/i];

function read(filePath: string): string {
  return readFileSync(filePath, 'utf8');
}

/**
 * Drop comments before any source scan.
 *
 * Every one of these files carries a long spec-pointer header quoting key
 * names and design vocabulary; harvesting those would audit the prose instead
 * of the code.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(?<!:)\/\/[^\n]*/g, '');
}

function flattenLeafKeys(value: unknown, prefix = '', out = new Set<string>()) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, nested] of Object.entries(value)) {
      flattenLeafKeys(nested, prefix ? `${prefix}.${key}` : key, out);
    }
    return out;
  }

  out.add(prefix);
  return out;
}

function localeFiles(): string[] {
  return readdirSync(localesDir)
    .filter((file) => file.endsWith('.json'))
    .sort();
}

function localeLeafKeys(file: string): Set<string> {
  const locale = JSON.parse(read(path.join(localesDir, file)));
  return flattenLeafKeys(locale);
}

function localeValue(file: string, dotPath: string): unknown {
  const locale = JSON.parse(read(path.join(localesDir, file)));
  return dotPath
    .split('.')
    .reduce<unknown>(
      (current, key) =>
        current && typeof current === 'object'
          ? (current as Record<string, unknown>)[key]
          : undefined,
      locale,
    );
}

/** Every `suppliers.capture.<family>.<leaf>` literal in a source file. */
function harvestCaptureKeys(source: string): string[] {
  const matches = stripComments(source).matchAll(
    /suppliers\.capture(?:\.[A-Za-z0-9_]+)+/g,
  );
  return [...matches]
    .map((match) => match[0])
    // `suppliers.capture` alone is the namespace constant, and a two-segment
    // hit is a family prefix, not a translatable leaf.
    .filter((key) => key.split('.').length >= 4);
}

/** Read a string list constant (`export const X = ['a', 'b'] as const;`). */
function readConstantList(source: string, name: string): string[] {
  const match = source.match(
    new RegExp(`export const ${name}\\s*=\\s*\\[([\\s\\S]*?)\\]\\s*as const`),
  );
  assert.ok(match, `capture-review.ts must export ${name}`);
  return [...match[1].matchAll(/'([^']+)'/g)].map((entry) => entry[1]);
}

// ---------------------------------------------------------------------------
// 1. One namespace
// ---------------------------------------------------------------------------

test('capture components use only suppliers.capture.* keys plus shared chrome', () => {
  for (const filePath of CAPTURE_COMPONENTS) {
    const source = stripComments(read(filePath));
    const name = path.basename(filePath);

    // Every first argument to `t(` that is a string literal.
    const keys = [...source.matchAll(/\bt\(\s*'([^']+)'/g)].map((match) => match[1]);
    assert.ok(keys.length > 0, `${name} should localize its strings through t()`);

    const stray = keys.filter(
      (key) =>
        !key.startsWith('suppliers.capture.') && !SHARED_KEY_ALLOWLIST.includes(key),
    );

    assert.deepEqual(
      stray,
      [],
      `${name} reaches outside suppliers.capture.*:\n${stray.map((key) => `  - ${key}`).join('\n')}`,
    );
  }
});

test('the capture i18n namespace constant is the one the key builders use', () => {
  const source = read(CAPTURE_REVIEW_UTIL);

  assert.match(source, /export const CAPTURE_I18N_PREFIX = 'suppliers\.capture';/);
  // Runtime families must be built from the constant, never spelled out again.
  assert.match(source, /\$\{CAPTURE_I18N_PREFIX\}\.\$\{family\}\.\$\{resolved\}/);
  assert.match(source, /\$\{CAPTURE_I18N_PREFIX\}\.sourceStatus\.\$\{status\}/);
});

// ---------------------------------------------------------------------------
// 2. No hardcoded user-facing text
// ---------------------------------------------------------------------------

test('capture components carry no hardcoded user-facing strings', () => {
  for (const filePath of CAPTURE_COMPONENTS) {
    const source = stripComments(read(filePath));
    const name = path.basename(filePath);

    const literalAttributes = [
      ...source.matchAll(/\b(aria-label|placeholder|alt|title)="([^"]*)"/g),
    ].map((match) => `${match[1]}="${match[2]}"`);

    assert.deepEqual(
      literalAttributes,
      [],
      `${name} has literal user-facing attributes:\n${literalAttributes.map((entry) => `  - ${entry}`).join('\n')}`,
    );

    // A JSX text node is word characters sitting between a closing `>` and the
    // next `<` with no expression braces in between — either on one line or
    // spread over its own line. The lookbehind drops `=>` and `->`, which are
    // arrows into a generic return type (`=> Promise<T>`), not markup.
    const textNodes = [
      ...source.matchAll(/(?<![=\-])>[ \t]*[A-Za-z][^<>{}\n]*</g),
      ...source.matchAll(/(?<![=\-])>[ \t]*\n\s*[A-Za-z][^<>{}]*?\n\s*</g),
    ].map((match) => match[0].slice(1, -1).trim());

    assert.deepEqual(
      textNodes,
      [],
      `${name} renders bare text instead of a translation:\n${textNodes.map((entry) => `  - ${entry}`).join('\n')}`,
    );
  }
});

// ---------------------------------------------------------------------------
// 3. Every key answers in all five locales
// ---------------------------------------------------------------------------

test('every static capture key exists in every POS locale', () => {
  const sources = [...CAPTURE_COMPONENTS, CAPTURE_REVIEW_UTIL, SUPPLIERS_PAGE];
  const keys = [...new Set(sources.flatMap((filePath) => harvestCaptureKeys(read(filePath))))].sort();

  assert.ok(keys.length >= 60, `expected the capture surfaces to use many keys, saw ${keys.length}`);

  for (const file of localeFiles()) {
    const available = localeLeafKeys(file);
    const missing = keys.filter((key) => !available.has(key));

    assert.deepEqual(
      missing,
      [],
      `${file} is missing capture translations:\n${missing.map((key) => `  - ${key}`).join('\n')}`,
    );
  }
});

test('every runtime-built capture family variant exists in every POS locale', () => {
  const util = read(CAPTURE_REVIEW_UTIL);

  const families: Array<{ family: string; values: string[] }> = [
    { family: 'status', values: readConstantList(util, 'CAPTURE_STATUS_KEYS') },
    { family: 'reason', values: [...readConstantList(util, 'CAPTURE_REASON_KEYS'), 'unknown'] },
    { family: 'device', values: readConstantList(util, 'CAPTURE_DEVICE_KEYS') },
    { family: 'history', values: readConstantList(util, 'CAPTURE_INGEST_KEYS') },
    { family: 'history', values: readConstantList(util, 'CAPTURE_EVENT_KEYS') },
    { family: 'sourceKind', values: readConstantList(util, 'CAPTURE_SOURCE_KIND_KEYS') },
    { family: 'sourceStatus', values: readConstantList(util, 'CAPTURE_SOURCE_STATUS_KEYS') },
  ];

  // The five device reason codes from the scanner adapter (task 9) and the
  // worker/watcher outcome codes (task 11) are the ones that reach a user only
  // through a runtime key — pinned by name so a rename cannot silently drop one.
  const deviceValues = families.find((entry) => entry.family === 'device')!.values;
  for (const code of [
    'device_offline',
    'device_busy',
    'device_removed',
    'scan_cancelled',
    'device_error',
  ]) {
    assert.ok(deviceValues.includes(code), `device family must cover ${code}`);
  }

  const reasonValues = families.find((entry) => entry.family === 'reason')!.values;
  for (const code of [
    'CAPTURE_UNREADABLE',
    'CAPTURE_TOO_LARGE',
    'CAPTURE_TOO_MANY_PAGES',
    'MODULE_REQUIRED',
  ]) {
    assert.ok(reasonValues.includes(code), `reason family must cover ${code}`);
  }

  const historyValues = families
    .filter((entry) => entry.family === 'history')
    .flatMap((entry) => entry.values);
  for (const outcome of ['skipped_duplicate', 'skipped_unsupported', 'skipped_oversize']) {
    assert.ok(historyValues.includes(outcome), `history family must cover ${outcome}`);
  }

  const statusValues = families.find((entry) => entry.family === 'status')!.values;
  assert.deepEqual(
    statusValues,
    [
      'capturing',
      'waiting',
      'uploading',
      'reading',
      'ready_review',
      'needs_attention',
      'parked',
      'committing',
      'committed',
      'discarded',
    ],
    'the queue renders exactly the ten capture lifecycle states',
  );

  const required = [
    ...new Set(
      families.flatMap(({ family, values }) =>
        values.map((value) => `suppliers.capture.${family}.${value}`),
      ),
    ),
  ].sort();

  for (const file of localeFiles()) {
    const available = localeLeafKeys(file);
    const missing = required.filter((key) => !available.has(key));

    assert.deepEqual(
      missing,
      [],
      `${file} is missing runtime capture variants:\n${missing.map((key) => `  - ${key}`).join('\n')}`,
    );
  }
});

test('shared chrome the capture components borrow exists in every POS locale', () => {
  for (const file of localeFiles()) {
    const available = localeLeafKeys(file);
    const missing = SHARED_KEY_ALLOWLIST.filter((key) => !available.has(key));
    assert.deepEqual(missing, [], `${file} is missing shared capture chrome keys`);
  }
});

// ---------------------------------------------------------------------------
// Plain language (R12.1, R15.3, R7.6)
// ---------------------------------------------------------------------------

test('capture copy uses plain words and never a confidence numeral', () => {
  for (const file of localeFiles()) {
    const capture = localeValue(file, 'suppliers.capture');
    assert.ok(capture && typeof capture === 'object', `${file} must define suppliers.capture`);

    const entries = [...flattenLeafKeys(capture)].map(
      (key) => [key, localeValue(file, `suppliers.capture.${key}`)] as const,
    );

    for (const [key, value] of entries) {
      assert.equal(typeof value, 'string', `${file}: suppliers.capture.${key} must be a string`);
      const text = value as string;

      assert.ok(text.trim().length > 0, `${file}: suppliers.capture.${key} is empty`);
      assert.ok(
        !text.includes('[NEEDS TRANSLATION]'),
        `${file}: suppliers.capture.${key} is still untranslated`,
      );

      for (const pattern of FORBIDDEN_JARGON) {
        assert.ok(
          !pattern.test(text),
          `${file}: suppliers.capture.${key} uses jargon (${pattern}): ${text}`,
        );
      }
    }

    // Confidence is a sentence, never a score — no digit may reach the tier
    // label the review rows render (R7.6).
    const doubleCheck = String(localeValue(file, 'suppliers.capture.review.doubleCheck'));
    assert.ok(
      !/\d/.test(doubleCheck),
      `${file}: the double-check label must carry no numerals, saw "${doubleCheck}"`,
    );
  }
});

// ---------------------------------------------------------------------------
// Supplier-invoice origin labels — supplier-email-ingest task 2.4
//
// The email door adds `'email'` to the shared `CaptureSourceKind` union
// (`.claude/specs/supplier-email-ingest/`, decision E1). Its design recorded as
// UNVERIFIED (F7) whether either POS client renders a source-kind label for a
// *supplier invoice's origin*, which would need that value translated here.
//
// **It does not, and these assertions are what keeps that answer true.** Every
// `sourceKind` label on this client describes the till's own capture queue or
// its configured capture sources — documents produced *at this terminal*, which
// can never carry a server-minted `'email'` kind. Nothing on the desktop reads
// `capture_metadata` or `email_metadata` back off a supplier invoice, so there
// is no origin surface to translate for. The correct change here was no change
// (R11.9, R19.6).
//
// If any of the three below fails, an origin surface has appeared: add the
// plain-language `email` label to all five `src/locales/*.json` files (and to
// `CAPTURE_SOURCE_KIND_KEYS` if the surface routes through `sourceKindKey`)
// before relaxing anything here. A raw `email` in front of a shopkeeper is
// exactly what R12.1 forbids.
// ---------------------------------------------------------------------------

/** Every renderer source file, comments stripped. */
function rendererSources(): Array<{ relativePath: string; source: string }> {
  const out: Array<{ relativePath: string; source: string }> = [];

  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
        walk(full);
      } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
        out.push({
          // Posix separators so the expected list below reads the same on
          // Windows, where this desktop client is actually built.
          relativePath: path.relative(rendererRoot, full).split(path.sep).join('/'),
          source: stripComments(read(full)),
        });
      }
    }
  };

  walk(rendererRoot);
  return out.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

test('source-kind labels are rendered only by local capture surfaces', () => {
  const labelSites = rendererSources()
    .filter(({ source }) => /sourceKindKey\(|suppliers\.capture\.sourceKind/.test(source))
    .map(({ relativePath }) => relativePath);

  assert.deepEqual(
    labelSites,
    [
      // The configured capture sources on this till (scanner, folder, file pick).
      'components/suppliers/CaptureScanSettingsModal.tsx',
      // The queue of documents scanned at this till and not yet filed.
      'components/suppliers/CaptureQueuePanel.tsx',
      // The key builder itself.
      'utils/capture-review.ts',
    ].sort(),
    'a new source-kind label site appeared — see the note above before changing this list',
  );
});

test('no desktop surface reads a supplier invoice back for its origin', () => {
  const readers = rendererSources()
    .filter(({ source }) => /capture_metadata|captureMetadata|email_metadata|emailMetadata/.test(source))
    .map(({ relativePath }) => relativePath);

  assert.deepEqual(
    readers,
    [],
    'the desktop grew a supplier-invoice origin reader — translate the email origin label first',
  );
});

test('the desktop capture vocabulary deliberately excludes the email door', () => {
  const kinds = readConstantList(read(CAPTURE_REVIEW_UTIL), 'CAPTURE_SOURCE_KIND_KEYS');

  assert.ok(
    !kinds.includes('email'),
    'CAPTURE_SOURCE_KIND_KEYS gained "email" — that family labels this till\'s own '
      + 'captures, which are never server-minted. If a supplier-invoice origin surface '
      + 'now needs it, add the label to all five locales in the same change.',
  );
});
