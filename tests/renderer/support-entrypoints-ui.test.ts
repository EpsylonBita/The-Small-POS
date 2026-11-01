import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const projectRoot = process.cwd();

const readRendererFile = (...parts: string[]) =>
  readFileSync(path.join(projectRoot, 'src', 'renderer', ...parts), 'utf8');

const panel = readRendererFile('components', 'support', 'SupportExplanationPanel.tsx');
const printerEntry = readRendererFile('components', 'support', 'PrinterSupportEntryPoint.tsx');
const healthEntry = readRendererFile('components', 'support', 'HealthSupportEntryPoint.tsx');
const combined = [panel, printerEntry, healthEntry].join('\n');

test('support explanation surfaces use solid amber/neutral styling and no hover-era cool colors', () => {
  assert.doesNotMatch(combined, /hover:/);
  assert.doesNotMatch(combined, /group-hover:/);
  assert.doesNotMatch(combined, /\b(?:bg|text|border|from|to|ring|shadow)-(?:blue|cyan|sky|purple|violet|indigo|fuchsia|pink|orange)-/);
  assert.doesNotMatch(combined, /focus:ring-blue|focus:border-blue/);
  assert.doesNotMatch(combined, /rounded-lg/);

  assert.match(panel, /liquid-glass-modal-card rounded-\[22px\]/);
  // UI audit wave 7A2: opaque severity tints in both themes (no /15 washes).
  assert.match(panel, /info:[\s\S]*?bg-amber-50 dark:bg-amber-950 text-amber-700 dark:text-amber-300/);
  assert.match(panel, /high:[\s\S]*?bg-amber-50 dark:bg-amber-950 text-amber-700 dark:text-amber-300/);
  assert.match(panel, /critical:[\s\S]*?bg-red-50 dark:bg-red-950 text-red-700 dark:text-red-300/);
  assert.doesNotMatch(panel, /\/\d{1,2}\b(?![\d.])|\/\[0?\.\d+\]/);
  // Actions: the kit buttons (yellow primary, neutral secondary), 44 px.
  assert.match(panel, /className=\{solidButton\(action\.variant === 'primary' \? 'primary' : 'secondary', 'sm'\)\}/);
});

test('printer and health support entry buttons are 44px touch controls', () => {
  // UI audit wave 7A2: the printer entry lives in Settings and is the neutral kit button.
  assert.match(printerEntry, /className=\{solidButton\('secondary', 'md'\)\}/);
  assert.doesNotMatch(printerEntry, /bg-amber|\/\d{2}\b/);
  // The Health entry is outside Settings and keeps its amber control until the app-wide wave.
  assert.match(healthEntry, /inline-flex min-h-touch items-center gap-2 rounded-2xl/);
  assert.match(healthEntry, /text-amber-800/);
  assert.match(healthEntry, /active:scale-\[0\.98\]/);
  assert.match(healthEntry, /dark:text-amber-300/);
  assert.match(printerEntry, /setOpen\(\(current\) => !current\)/);
  assert.match(printerEntry, /<SupportExplanationPanel/);
  assert.match(healthEntry, /setOpen\(\(current\) => !current\)/);
  assert.match(healthEntry, /<SupportExplanationPanel/);
});
