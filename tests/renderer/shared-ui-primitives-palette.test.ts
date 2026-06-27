import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const projectRoot = process.cwd();

const readRendererFile = (...parts: string[]) =>
  readFileSync(path.join(projectRoot, 'src', 'renderer', ...parts), 'utf8');

const sources = {
  commonLoadingSpinner: readRendererFile('components', 'common', 'LoadingSpinner.tsx'),
  uiLoadingSpinner: readRendererFile('components', 'ui', 'LoadingSpinner.tsx'),
  errorAlert: readRendererFile('components', 'ui', 'ErrorAlert.tsx'),
  receiptScaleSlider: readRendererFile('components', 'ui', 'ReceiptScaleSlider.tsx'),
  skeletonLoader: readRendererFile('components', 'ui', 'SkeletonLoader.tsx'),
  posGlassTooltip: readRendererFile('components', 'ui', 'POSGlassTooltip.tsx'),
  pulseAnimation: readRendererFile('components', 'ui', 'PulseAnimation.tsx'),
  paymentBlockers: readRendererFile('components', 'ui', 'UnsettledPaymentBlockersPanel.tsx'),
};

const combined = Object.values(sources).join('\n');

test('shared renderer UI primitives use amber/neutral touchscreen styling instead of cool hover styling', () => {
  assert.doesNotMatch(combined, /hover:/);
  assert.doesNotMatch(combined, /disabled:hover:/);
  assert.doesNotMatch(combined, /\b(?:bg|text|border|from|to|ring|shadow)-(?:blue|cyan|sky|fuchsia|yellow)-/);
  assert.doesNotMatch(combined, /focus:ring-blue|focus:border-blue/);
  assert.doesNotMatch(combined, /rgb\(59 130 246/);
  assert.doesNotMatch(combined, /#1976d2/i);

  assert.match(sources.commonLoadingSpinner, /color = '#f59e0b'/);
  assert.match(sources.uiLoadingSpinner, /border-amber-400 border-t-transparent/);
  assert.match(sources.errorAlert, /info:[\s\S]*?text-amber-300[\s\S]*?bg-amber-500\/10/);
  assert.match(sources.errorAlert, /active:scale-\[0\.98\]/);
  assert.match(sources.receiptScaleSlider, /text-amber-300/);
  assert.match(sources.receiptScaleSlider, /rgb\(245 158 11 \/ 0\.78\)/);
  assert.match(sources.pulseAnimation, /pulseColor = 'bg-amber-400'/);
});

test('small shared utility chrome uses smooth radius tokens', () => {
  assert.match(sources.receiptScaleSlider, /min-h-7 rounded-2xl/);
  assert.match(sources.skeletonLoader, /return 'rounded-2xl'/);
  assert.match(sources.posGlassTooltip, /bg-gray-900\/90 rounded-2xl/);

  for (const [name, source] of [
    ['ReceiptScaleSlider', sources.receiptScaleSlider],
    ['SkeletonLoader', sources.skeletonLoader],
    ['POSGlassTooltip', sources.posGlassTooltip],
  ] as const) {
    assert.doesNotMatch(source, /rounded-md|rounded-lg/, `${name} must not reintroduce small-radius utility chrome`);
  }
});

test('shared payment blocker panel keeps semantic cash green but makes card/split/fix actions neutral or amber', () => {
  const source = sources.paymentBlockers;

  assert.match(source, /case "cash":[\s\S]*?border-emerald-400\/30 bg-emerald-500\/10/);
  assert.match(source, /case "card":[\s\S]*?border-zinc-300\/25 bg-white\/\[0\.06\]/);
  assert.match(source, /case "split":[\s\S]*?border-amber-400\/30 bg-amber-500\/10/);
  assert.match(source, /border border-amber-400\/25 bg-amber-500\/10/);
  assert.match(source, /bg-amber-400 text-slate-950 active:bg-amber-300/);
  assert.match(source, /min-h-\[44px\][\s\S]*rounded-2xl/);
});
