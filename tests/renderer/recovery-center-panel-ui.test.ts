import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// Round 340 (supervisor correction, live QA / code inspection): the sync recovery assistant
// (RecoveryCenterPanel, used by SyncRecoveryModal + SyncStatusIndicator) showed raw technical context IDs in
// its visible summary cards -- the "Terminal {{terminalId}}" context line and branch/organization labels that
// fell back to the raw branchId/organizationId UUID. Cashiers must see friendly names/labels only. The raw ids
// may still live in internal recovery logic, the persisted action log, and diagnostics export.
const projectRoot = process.cwd();
const panelPath = path.join(
  projectRoot,
  'src',
  'renderer',
  'components',
  'recovery',
  'RecoveryCenterPanel.tsx',
);
const source = readFileSync(panelPath, 'utf8');

const localesDir = path.join(projectRoot, 'src', 'locales');
const loadLocale = (lng: string): Record<string, any> =>
  JSON.parse(readFileSync(path.join(localesDir, `${lng}.json`), 'utf8'));

test('Round 340: the sync-recovery summary cards render no raw terminal/branch/organization IDs', () => {
  // Scope to the visible 3-card summary header, between the summary grid and the primary-issue block.
  const summaryStart = source.indexOf('grid gap-3 md:grid-cols-3');
  assert.notEqual(summaryStart, -1, 'the summary grid must exist');
  const summaryEnd = source.indexOf('{!primaryIssue ?', summaryStart);
  assert.notEqual(summaryEnd, -1, 'the primary-issue block must follow the summary');
  const summary = source.slice(summaryStart, summaryEnd);

  assert.doesNotMatch(summary, /terminalContext\?\.terminalId/, 'summary must not render the raw terminalId');
  assert.doesNotMatch(summary, /terminalContext\?\.branchId/, 'summary must not render the raw branchId');
  assert.doesNotMatch(summary, /terminalContext\?\.organizationId/, 'summary must not render the raw organizationId');
  assert.doesNotMatch(summary, /terminalContextLine/, 'the raw-terminalId context-line key must be gone from the summary');

  // Friendly, cashier-facing copy/labels are rendered instead.
  assert.match(summary, /recovery\.center\.thisTerminal/, 'summary uses the friendly "This register" label');
  assert.match(summary, /\{branchDisplayName\}/, 'summary renders the friendly branch display name');
  assert.match(summary, /\{organizationDisplayName\}/, 'summary renders the friendly organization display name');

  // The offending key is removed from the whole component, not just the summary.
  assert.doesNotMatch(source, /terminalContextLine/, 'terminalContextLine must be fully removed from the component');
});

test('Round 340: branch/organization display names never fall back to a raw id', () => {
  // The derived display names prefer the friendly NAME, else a localized "This branch / This business" label --
  // never the raw branchId/organizationId UUID.
  const blockStart = source.indexOf('const branchDisplayName =');
  assert.notEqual(blockStart, -1, 'branchDisplayName derivation must exist');
  const block = source.slice(blockStart, source.indexOf('const runAction'));
  assert.ok(block.length > 0, 'the display-name derivation block must exist');

  assert.doesNotMatch(block, /branchId/, 'branchDisplayName must not fall back to branchId');
  assert.doesNotMatch(block, /organizationId/, 'organizationDisplayName must not fall back to organizationId');
  assert.match(block, /terminalContext\?\.branchName\?\.trim\(\)/, 'branchDisplayName prefers the friendly branchName');
  assert.match(block, /recovery\.center\.branchFallback/, 'branchDisplayName uses the friendly fallback label');
  assert.match(block, /terminalContext\?\.organizationName\?\.trim\(\)/, 'organizationDisplayName prefers the friendly organizationName');
  assert.match(block, /recovery\.center\.organizationFallback/, 'organizationDisplayName uses the friendly fallback label');
});

test('Round 340: terminal/context IDs remain available to the internal action log (logic not broken)', () => {
  // IDs are allowed to stay in the persisted action log / diagnostics. This guards that hiding the visible IDs
  // did not strip them from the internal recovery action log or its persistence path.
  assert.match(source, /staffName: terminalContext\?\.terminalId \?\? null/, 'the action log still records the terminalId internally');
  assert.match(source, /bridge\.recovery\.recordActionLog\(/, 'the action log is still persisted via the recovery bridge');
});

test('Round 340: the raw-ID terminalContextLine locale key is removed; friendly keys exist in every POS locale', () => {
  const removed = 'terminalContextLine';
  const added = ['thisTerminal', 'branchFallback', 'organizationFallback'];
  const en = loadLocale('en');

  for (const lng of ['en', 'el', 'de', 'fr', 'it']) {
    const center = (loadLocale(lng)?.recovery?.center ?? {}) as Record<string, string>;
    assert.ok(!(removed in center), `${lng}: recovery.center.${removed} must be removed (it rendered the raw terminalId)`);
    for (const key of added) {
      assert.equal(typeof center[key], 'string', `${lng}: recovery.center.${key} must exist`);
      assert.ok(center[key].length > 0, `${lng}: recovery.center.${key} must be non-empty`);
      assert.doesNotMatch(
        center[key],
        /\{\{\s*(terminalId|branchId|organizationId)\s*\}\}/,
        `${lng}: recovery.center.${key} must not interpolate a raw id`,
      );
    }
  }

  // Greek must be a genuine translation, not the English source echoed back.
  for (const key of added) {
    assert.notEqual(
      loadLocale('el').recovery.center[key],
      en.recovery.center[key],
      `el recovery.center.${key} must be a Greek translation`,
    );
  }
});

test('Round 384: recovery center panel is touch-first and avoids old sky/orange styling', () => {
  assert.doesNotMatch(source, /hover:/);
  assert.doesNotMatch(source, /dark:hover:/);
  assert.doesNotMatch(source, /group-hover:/);
  assert.doesNotMatch(source, /\b(?:bg|text|border|from|to|ring|shadow)-(?:sky|blue|cyan|purple|violet|indigo|fuchsia|pink|orange)-/);
  assert.doesNotMatch(source, /focus:ring-blue|focus:border-blue/);

  // Error is semantic red; warning/blocker guidance is amber; informational/verification surfaces are neutral.
  assert.match(source, /error:[\s\S]*?border border-red-400\/30 bg-red-500\/10 text-red-700/);
  assert.match(source, /warning:[\s\S]*?border border-amber-400\/30 bg-amber-500\/10 text-amber-700/);
  assert.match(source, /info:[\s\S]*?border border-slate-300\/80 bg-white\/85 text-slate-700/);
  assert.match(source, /rounded-\[22px\] border border-slate-200\/80 bg-slate-50/);
  assert.match(source, /rounded-\[26px\] border border-slate-200 bg-slate-50\/90/);

  // Touch feedback replaces hover on recovery actions while preserving semantic action colors.
  assert.match(source, /active:scale-\[0\.98\]/);
  assert.match(source, /bg-emerald-600[\s\S]*?active:bg-emerald-500/);
  assert.match(source, /bg-amber-400[\s\S]*?active:bg-amber-300/);
  assert.match(source, /border-red-300\/80 bg-red-50\/90 text-red-700 active:bg-red-100/);
});
