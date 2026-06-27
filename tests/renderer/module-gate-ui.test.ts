import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const projectRoot = process.cwd();

const readRendererFile = (...parts: string[]) =>
  readFileSync(path.join(projectRoot, 'src', 'renderer', ...parts), 'utf8');

const lockedFeature = readRendererFile('components', 'modules', 'LockedFeatureScreen.tsx');
const upsellCard = readRendererFile('components', 'modules', 'ModuleUpsellCard.tsx');
const trialPrompt = readRendererFile('components', 'modules', 'TrialModulePrompt.tsx');
const combined = [lockedFeature, upsellCard, trialPrompt].join('\n');

test('module lock and upsell surfaces use amber/neutral touch styling, not old blue hover styling', () => {
  assert.doesNotMatch(combined, /hover:/);
  assert.doesNotMatch(combined, /group-hover:/);
  assert.doesNotMatch(combined, /\b(?:bg|text|border|from|to|ring|shadow)-(?:blue|cyan|sky|purple|violet|indigo|fuchsia|pink|orange)-/);
  assert.doesNotMatch(combined, /focus:ring-blue|focus:border-blue/);
  assert.doesNotMatch(combined, /rounded-lg/);

  assert.match(lockedFeature, /from-amber-400\/25 to-white\/10/);
  assert.match(lockedFeature, /text-amber-300 relative z-10/);
  assert.match(lockedFeature, /min-h-\[44px\][\s\S]*active:scale-\[0\.98\]/);
  assert.match(upsellCard, /text-amber-300/);
  assert.match(upsellCard, /active:scale-\[0\.99\] active:bg-white\/10/);
  assert.match(trialPrompt, /min-h-\[44px\] min-w-\[44px\][\s\S]*rounded-2xl/);
  assert.match(trialPrompt, /active:scale-95 active:bg-white\/10/);
});

test('module gate behavior remains wired to analytics, checkout/admin fallback, and trial dismissal', () => {
  assert.match(lockedFeature, /fetch\('\/api\/analytics\/upsell'/);
  assert.match(lockedFeature, /fetch\('\/api\/modules\/checkout'/);
  assert.match(lockedFeature, /generateModulePurchaseUrl\(adminUrl, moduleId/);
  assert.match(lockedFeature, /await openExternalUrl\(purchaseUrl\)/);
  assert.match(lockedFeature, /onBack\?\.\(\)/);

  assert.match(upsellCard, /fetch\('\/api\/modules\/checkout'/);
  assert.match(upsellCard, /await openExternalUrl\(data\.checkout_url\)/);
  assert.match(upsellCard, /generateModulePurchaseUrl\(adminUrl, moduleId/);
  assert.match(upsellCard, /onClose\?\.\(\)/);

  assert.match(trialPrompt, /localStorage\.setItem\(\s*STORAGE_KEY/);
  assert.match(trialPrompt, /onDismiss\?\.\(\)/);
  assert.match(trialPrompt, /generateTrialUpgradeUrl\(adminUrl/);
  assert.match(trialPrompt, /void openExternalUrl\(upgradeUrl\)/);
});
