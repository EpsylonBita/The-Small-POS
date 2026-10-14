import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const projectRoot = process.cwd();
const source = readFileSync(
  path.join(projectRoot, 'src', 'renderer', 'components', 'modals', 'UpgradePromptModal.tsx'),
  'utf8',
);

// 30/09/2026: the locked-module prompt became the launch purchase entry
// (docs/architecture/launch-pricing-presentation.md). It replaced the old "Upgrade Required"
// lock card, its plan comparison and its "coming soon" alerts. Mounted behaviour is pinned by
// src/renderer/components/modals/__tests__/UpgradePromptModal.display-guidance.test.tsx.

test('upgrade prompt uses amber glass styling without old blue-purple lock visuals', () => {
  assert.doesNotMatch(source, /hover:/);
  assert.doesNotMatch(source, /group-hover:/);
  assert.doesNotMatch(source, /\b(?:bg|text|border|from|to|ring|shadow)-(?:blue|cyan|sky|purple|violet|indigo|fuchsia|pink|orange)-/);
  assert.doesNotMatch(source, /focus:ring-blue|focus:border-blue/);
  assert.doesNotMatch(source, /rounded-lg/);
  assert.doesNotMatch(source, /[ÂÃâðÎÏ�]/, 'source must not contain mojibake');
  assert.doesNotMatch(source, /\bLock\b/, 'the old lock visual stays gone');

  // The returned offer sits on one translucent amber glass card that reads on both themes.
  assert.match(source, /<section className="rounded-2xl border border-amber-400\/40 bg-amber-400\/10 p-4 space-y-3">/);
  // The billing cycle is a labelled toggle group on the shared yellow/neutral glass buttons.
  assert.match(source, /role="group" aria-label=\{t\('modules\.launchPurchase\.cycle'\)\}/);
  assert.match(source, /aria-pressed=\{cycle === value\}/);
  assert.match(source, /liquidGlassModalButton\(cycle === value \? 'primary' : 'secondary', 'sm'\)/);
  // Loading/unavailable and a failed browser open are announced, not silent.
  assert.match(source, /<p role="status">\{t\(loading \? 'modules\.launchPurchase\.loading' : 'modules\.launchPurchase\.unavailable'\)\}<\/p>/);
  assert.match(source, /<p role="alert">\{t\('modules\.launchPurchase\.openFailed'\)\}<\/p>/);
});

test('upgrade prompt keeps module metadata, the returned offer, the browser purchase and modal close behavior wired', () => {
  assert.match(source, /getFallbackModuleMetadata\(feature as ModuleId\)/);
  assert.match(source, /getDisplayPurchaseGuidance\(feature\)/);
  assert.match(source, /<DisplayPurchaseGuidance moduleId=\{feature\} \/>/);
  // KDS/Customer Display equipment guidance renders before the price card.
  assert.ok(
    source.indexOf('<DisplayPurchaseGuidance') < source.indexOf('<section className='),
    'equipment guidance must precede the offer',
  );

  // The offer is the server's launch catalogue, read with GET; there is no invented plan.
  assert.match(source, /posApiFetch<PublicLaunchCatalogDTO>\('\/api\/modules\/launch-catalog', \{ method: 'GET' \}\)/);
  assert.match(source, /launchPurchaseDisplay\(response\.data, feature\)/);
  assert.match(source, /feature === 'ai_assistant' \|\| feature === 'plugin_integrations'/);
  assert.doesNotMatch(source, /requiredPlan = 'Professional'|plan: requiredPlan/);

  // The till only opens the authenticated browser purchase; it never alerts, charges or unlocks.
  assert.match(source, /generateModulePurchaseUrl\(fresh\.adminUrl, feature, \{/);
  assert.match(source, /source: 'pos_tauri', context: 'locked_module'/);
  assert.match(source, /await openExternalUrl\(url\)/);
  assert.doesNotMatch(source, /\balert\(/);

  assert.match(source, /closeOnBackdrop closeOnEscape/);
  assert.match(source, /liquidGlassModalButton\('primary', 'lg'\)/);
  assert.match(source, /liquidGlassModalButton\('secondary', 'md'\)/);
  assert.match(source, /t\('modules\.launchPurchase\.retry'\)/);
});
