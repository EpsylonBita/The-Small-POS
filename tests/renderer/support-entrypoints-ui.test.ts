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

test('support explanation surfaces use amber/neutral glass styling and no hover-era cool colors', () => {
  assert.doesNotMatch(combined, /hover:/);
  assert.doesNotMatch(combined, /group-hover:/);
  assert.doesNotMatch(combined, /\b(?:bg|text|border|from|to|ring|shadow)-(?:blue|cyan|sky|purple|violet|indigo|fuchsia|pink|orange)-/);
  assert.doesNotMatch(combined, /focus:ring-blue|focus:border-blue/);
  assert.doesNotMatch(combined, /rounded-lg/);

  assert.match(panel, /liquid-glass-modal-card rounded-\[22px\]/);
  assert.match(panel, /info:[\s\S]*?bg-amber-500\/15 text-amber-700/);
  assert.match(panel, /high:[\s\S]*?bg-amber-500\/15 text-amber-700/);
  assert.match(panel, /critical:[\s\S]*?bg-red-500\/15 text-red-700/);
  assert.match(panel, /inline-flex min-h-\[44px\][\s\S]*?active:scale-\[0\.98\]/);
  assert.match(panel, /bg-amber-400 text-black active:bg-amber-300/);
  assert.match(panel, /bg-white\/\[0\.08\][\s\S]*?active:bg-white\/\[0\.14\]/);
});

test('printer and health support entry buttons are 44px amber touch controls', () => {
  for (const source of [printerEntry, healthEntry]) {
    assert.match(source, /inline-flex min-h-\[44px\] items-center gap-2 rounded-2xl/);
    assert.match(source, /border-amber-500\/25 bg-amber-500\/10/);
    assert.match(source, /text-amber-700/);
    assert.match(source, /active:scale-\[0\.98\]/);
    assert.match(source, /dark:text-amber-300/);
  }

  assert.match(printerEntry, /setOpen\(\(current\) => !current\)/);
  assert.match(printerEntry, /<SupportExplanationPanel/);
  assert.match(healthEntry, /setOpen\(\(current\) => !current\)/);
  assert.match(healthEntry, /<SupportExplanationPanel/);
});
