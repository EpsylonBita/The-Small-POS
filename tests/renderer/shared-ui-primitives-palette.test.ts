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
  // Wave ΣΤ1: the kit's solid notice tints (warn / bad / ok), never a translucent wash.
  assert.match(sources.errorAlert, /info:[\s\S]*?text-\(--pos-s-fg\)[\s\S]*?bg-\(--pos-s-surface-2\)/);
  assert.match(sources.errorAlert, /warning:[\s\S]*?bg-\(--pos-s-warn-bg\)[\s\S]*?border-\(--pos-s-warn\)/);
  assert.match(sources.errorAlert, /error:[\s\S]*?bg-\(--pos-s-bad-bg\)[\s\S]*?border-\(--pos-s-bad\)/);
  assert.match(sources.errorAlert, /active:scale-\[0\.98\]/);
  assert.match(sources.receiptScaleSlider, /className="pos-solid-btn pos-solid-btn--sm"/);
  assert.match(sources.receiptScaleSlider, /rgb\(245 158 11 \/ 0\.78\)/);
  assert.match(sources.pulseAnimation, /pulseColor = 'bg-amber-400'/);
});

test('small shared utility chrome uses smooth radius tokens', () => {
  assert.match(sources.receiptScaleSlider, /pos-solid-btn--sm/);
  assert.match(sources.skeletonLoader, /return 'rounded-2xl'/);
  // UI audit wave 6: the hover-only POSGlassTooltip is gone (touch tills); its one use,
  // the cash variance meaning, is shown inline in StaffShiftModal.
  assert.match(
    readRendererFile('components', 'modals', 'StaffShiftModal.tsx'),
    /<p data-variance-meaning [^>]*>\s*\{t\('modals\.staffShift\.varianceMeaning'/,
  );

  for (const [name, source] of [
    ['ReceiptScaleSlider', sources.receiptScaleSlider],
    ['SkeletonLoader', sources.skeletonLoader],
  ] as const) {
    assert.doesNotMatch(source, /rounded-md|rounded-lg/, `${name} must not reintroduce small-radius utility chrome`);
  }
});

test('shared payment blocker panel keeps semantic cash green but makes card/split/fix actions neutral or amber', () => {
  const source = sources.paymentBlockers;

  // Wave ΣΤ1: neutral chips, the method is the colour of the words; the panel is the kit warn notice.
  assert.match(source, /case "cash":[\s\S]*?border-\(--pos-s-border\) bg-\(--pos-s-surface-2\) text-emerald-800 dark:text-emerald-200/);
  assert.match(source, /case "card":[\s\S]*?border-\(--pos-s-border\) bg-\(--pos-s-surface\) text-\(--pos-s-fg\)/);
  assert.match(source, /case "split":[\s\S]*?border-\(--pos-s-border\) bg-\(--pos-s-surface-2\) text-amber-800 dark:text-amber-200/);
  assert.match(source, /rounded-2xl border border-\(--pos-s-warn\) bg-\(--pos-s-warn-bg\) p-4/);
  assert.match(source, /border-\(--pos-s-yellow\) bg-\(--pos-s-yellow\) text-black/);
  assert.match(source, /min-h-touch(?![\w.-])[\s\S]*rounded-2xl/);
});

// The v4 upgrader names the 44px targets min-h-touch/min-w-touch. Keep their
// exact pixel contract alongside the source-class assertions that use them.
test('Tailwind touch target tokens remain exactly 44px in both renderer theme entrypoints', () => {
  for (const relativePath of ['src/index.css', 'src/renderer/styles/globals.css']) {
    const theme = readFileSync(path.join(projectRoot, relativePath), 'utf8');
    assert.match(theme, /--min-height-touch:\s*44px;/, `${relativePath} touch height must stay 44px`);
    assert.match(theme, /--min-width-touch:\s*44px;/, `${relativePath} touch width must stay 44px`);
  }
});
