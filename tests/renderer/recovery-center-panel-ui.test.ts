import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const source = (filename: string) => readFileSync(path.join(process.cwd(), 'src/renderer/components/recovery', filename), 'utf8');
const loadLocale = (lng: string) => JSON.parse(readFileSync(path.join(process.cwd(), 'src/locales', lng + '.json'), 'utf8'));

test('Till health confines raw terminal and business identifiers to its support disclosure', () => {
  const staff = source('TillHealthWindow.tsx');
  const support = source('TillHealthSupport.tsx');
  assert.doesNotMatch(staff, /terminalId|organizationId|branchId|\.entityId|\.queueId/);
  assert.match(staff, /supportOpen && props\.support/);
  assert.match(support, /terminal\.terminalId, terminal\.branchId, terminal\.organizationId/);
  assert.match(support, /issue\.entityId, issue\.businessEventKey/);
});

test('Till health audit retains terminal context and distinguishes missing approver attribution', () => {
  const actions = source('useTillHealthActions.tsx');
  assert.match(actions, /terminalId: terminalContext\?\.terminalId/);
  assert.match(actions, /actorAttribution: 'unavailable'/);
  assert.match(actions, /recordActionLog\(entry\)/);
});

test('Round 340: the raw-ID terminalContextLine locale key is removed; friendly keys exist in every POS locale', () => {
  const removed = 'terminalContextLine';
  const added = ['thisTerminal', 'branchFallback', 'organizationFallback'];
  const en = loadLocale('en');

  for (const lng of ['en', 'el', 'de', 'fr', 'it', 'sq']) {
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


test('Till health uses raised controls and touch feedback', () => {
  const window = source('TillHealthWindow.tsx');
  const css = source('till-health.css');
  assert.match(window, /till-health-button pos-raised/);
  assert.match(window, /primary \? 'pos-raised--yellow'/);
  assert.match(css, /min-height: 44px/);
  assert.match(css, /min-height: 56px/);
  assert.match(css, /:focus-visible/);
  assert.doesNotMatch(window + css, /hover:|:hover|bg-(sky|orange)-\d/);
});
