import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const projectRoot = process.cwd();
const source = readFileSync(
  path.join(projectRoot, 'src', 'renderer', 'components', 'modals', 'UpgradePromptModal.tsx'),
  'utf8',
);

test('upgrade prompt uses amber glass styling without old blue-purple lock visuals', () => {
  assert.doesNotMatch(source, /hover:/);
  assert.doesNotMatch(source, /group-hover:/);
  assert.doesNotMatch(source, /\b(?:bg|text|border|from|to|ring|shadow)-(?:blue|cyan|sky|purple|violet|indigo|fuchsia|pink|orange)-/);
  assert.doesNotMatch(source, /focus:ring-blue|focus:border-blue/);
  assert.doesNotMatch(source, /rounded-lg/);
  assert.doesNotMatch(source, /ð|â/);

  assert.match(source, /border-amber-400\/35 bg-amber-400\/15 text-amber-200/);
  assert.match(source, /border-amber-500\/30 bg-amber-100 text-amber-700/);
  assert.match(source, /border-amber-400\/25 bg-gradient-to-br from-amber-400\/14 to-white\/\[0\.04\]/);
  assert.match(source, /border-amber-200 bg-gradient-to-br from-amber-50 to-white/);
  assert.match(source, /text-amber-300/);
  assert.match(source, /text-amber-700/);
  assert.match(source, /rounded-2xl/);
});

test('upgrade prompt keeps module metadata, plan, alerts, and modal close behavior wired', () => {
  assert.match(source, /getFallbackModuleMetadata\(moduleId as ModuleId\)/);
  assert.match(source, /requiredPlan = 'Professional'/);
  assert.match(source, /plan: requiredPlan/);
  assert.match(source, /alert\(t\('modules\.upgradeComingSoon'/);
  assert.match(source, /alert\(t\('modules\.learnMoreComingSoon'/);
  assert.match(source, /closeOnBackdrop=\{true\}/);
  assert.match(source, /closeOnEscape=\{true\}/);
  assert.match(source, /liquidGlassModalButton\('primary', 'lg'\)/);
  assert.match(source, /liquidGlassModalButton\('secondary', 'md'\)/);
});
